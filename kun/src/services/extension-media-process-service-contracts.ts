import { createHash } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { terminateSpawnTree } from '../adapters/tool/builtin-tool-utils.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionMediaHandleService,
  type ResolvedMediaHandle
} from './extension-media-handle-service.js'
import { runBoundedProcess } from './extension-media-process-service-process-discovery.js'

export type MediaExecutableName = 'ffprobe' | 'ffmpeg'

/**
 * Keep native media readers on local, non-delegating inputs. The format list
 * intentionally excludes playlist/manifest and virtual-input demuxers such as
 * concat, HLS, DASH, lavfi, and capture devices. It is injected by core code,
 * never accepted from an extension argument list.
 */
export const EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST = 'file'

export const EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST = [
  'aac',
  'ac3',
  'aiff',
  'alaw',
  'amr',
  'ape',
  'apng',
  'asf',
  'au',
  'av1',
  'avi',
  'avif',
  'caf',
  'dirac',
  'dts',
  'dv',
  'eac3',
  'flac',
  'flv',
  'gif',
  'h261',
  'h263',
  'h264',
  'hevc',
  'image2',
  'jpeg_pipe',
  'matroska',
  'mjpeg',
  'mjpeg_2000',
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'mp3',
  'mpeg',
  'mpegvideo',
  'mpegts',
  'ogg',
  'opus',
  'png_pipe',
  'rawvideo',
  's16be',
  's16le',
  's24be',
  's24le',
  's32be',
  's32le',
  's8',
  'srt',
  'u16be',
  'u16le',
  'u24be',
  'u24le',
  'u32be',
  'u32le',
  'u8',
  'wav',
  'webm',
  'webvtt',
  'webp_pipe',
  'yuv4mpegpipe'
].join(',')

export type MediaCapability = {
  name: MediaExecutableName
  available: boolean
  source?: 'configured' | 'path'
  version?: string
  features?: Array<
    | 'libx264-encoder'
    | 'libx265-encoder'
    | 'prores-ks-encoder'
    | 'ffv1-encoder'
    | 'aac-encoder'
    | 'flac-encoder'
    | 'pcm-s24-encoder'
    | 'pcm-s16-encoder'
    | 'drawtext-filter'
    | 'subtitles-filter'
    | 'eq-filter'
    | 'colorbalance-filter'
    | 'boxblur-filter'
    | 'unsharp-filter'
    | 'vignette-filter'
    | 'silencedetect-filter'
    | 'mp4-muxer'
    | 'mov-muxer'
    | 'matroska-muxer'
    | 's16le-muxer'
  >
}

export type MediaCapabilities = {
  probedAt: string
  ffprobe: MediaCapability
  ffmpeg: MediaCapability
}

export type MediaProbeMetadata = {
  schemaVersion: 1
  handleId: string
  container: {
    formatNames: string[]
    formatLongName?: string
    durationMicros?: number
    startTimeMicros?: number
    bitRate?: number
  }
  streams: Array<{
    index: number
    kind: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown'
    codecName?: string
    codecLongName?: string
    timeBase?: { numerator: number; denominator: number }
    frameRate?: { numerator: number; denominator: number }
    durationMicros?: number
    width?: number
    height?: number
    rotationDegrees?: number
    channelCount?: number
    sampleRate?: number
    channelLayout?: string
    language?: string
    disposition: { default: boolean; forced: boolean; attachedPicture: boolean }
  }>
}

export type ExtensionAudioAnalysisCapabilities = {
  probedAt: string
  executablesAvailable: boolean
  silence: boolean
  syncFeatures: boolean
  beatGrid: boolean
}

export type ExtensionAudioSourceEvidence = {
  handleId: string
  fingerprint: string
  fingerprintAlgorithm: 'sha256-file-identity-v1'
}

export type ExtensionSilenceAnalysis = {
  source: ExtensionAudioSourceEvidence
  intervals: Array<{
    startMicros: number
    endMicros: number
    confidence: 1
    confidenceSemantics: 'threshold-classification'
  }>
  analyzedDurationMicros: number
  truncated: boolean
}

export type ExtensionSyncFeatureSeries = {
  source: ExtensionAudioSourceEvidence
  features: number[]
  analyzedDurationMicros: number
  truncated: boolean
}

export type ExtensionBeatGridAnalysis = {
  source: ExtensionAudioSourceEvidence
  tempoBpm?: number
  markers: Array<{
    timeMicros: number
    kind: 'beat' | 'downbeat'
    confidence: number
    strength: number
  }>
  analyzedDurationMicros: number
  truncated: boolean
}

export type ExtensionVisualFrameSample = {
  sampleId: string
  startMicros: number
  endMicros: number
  representativeMicros: number
}

export type ExtensionVisualFrameAnalysis = {
  source: ExtensionAudioSourceEvidence
  embeddings: Array<{ sampleId: string; vector: number[] }>
  decodedFrameWidth: 32
  decodedFrameHeight: 32
}

export class ExtensionMediaProcessError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'executable_unavailable'
      | 'process_failed'
      | 'process_timeout'
      | 'process_cancelled'
      | 'output_limit'
      | 'invalid_probe_output'
      | 'invalid_analysis_output',
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

export type RunResult = { stdout: Buffer; stderr: Buffer; exitCode: number }

export const SYNC_FEATURE_SAMPLE_RATE = 1_000

export const BEAT_PCM_SAMPLE_RATE = 200

export const BEAT_WINDOW_MICROS = 50_000

export const BEAT_MAX_ANALYSIS_MICROS = 60 * 60 * 1_000_000

export const BEAT_MIN_BPM = 40

export const BEAT_MAX_BPM = 240

export const VISUAL_FEATURE_DIMENSIONS = 24

export const VISUAL_FRAME_WIDTH = 32

export const VISUAL_FRAME_HEIGHT = 32

export const VISUAL_FRAME_BYTES = VISUAL_FRAME_WIDTH * VISUAL_FRAME_HEIGHT * 3

export type MediaProcessOptions = {
  handleService: ExtensionMediaHandleService
  ffprobePath?: string
  ffmpegPath?: string
  pathEnv?: string
  discoveryDirectories?: string[]
  now?: () => Date
  probeTimeoutMs?: number
  discoveryTimeoutMs?: number
  maxProbeOutputBytes?: number
  maxDiagnosticBytes?: number
  ffmpegTimeoutMs?: number
  maxFfmpegProgressBytes?: number
  maxFfmpegLogBytes?: number
  // Test fixtures are JavaScript files, which Windows cannot execute directly
  // with the production shell-free process boundary.
  processRunner?: typeof runBoundedProcess
}
