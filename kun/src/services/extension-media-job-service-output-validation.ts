import { createHash } from 'node:crypto'
import {
  MediaStartFfmpegJobRequestSchema,
  type GeneratedArtifact,
  type JobReference,
  type MediaJobPriority,
  type MediaStartFfmpegJobRequest,
  type MediaProbeResult
} from '@kun/extension-api'
import type { JsonValue } from '../extensions/types.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import {
  ExtensionArtifactService,
  type CreateGeneratedArtifactInput
} from './extension-artifact-service.js'
import { ExtensionJobService, type ExtensionJobCoreExecutor } from './extension-job-service.js'
import type { ExtensionJobSnapshot } from './extension-job-types.js'
import {
  ExtensionMediaFfmpegService,
  type ExtensionFfmpegOutputTransaction,
  type ExtensionFfmpegProgress
} from './extension-media-ffmpeg-service.js'
import {
  ExtensionMediaProcessError,
  ExtensionMediaProcessService
} from './extension-media-process-service.js'
import { ExtensionMediaJobError } from './extension-media-job-service-core.js'
import { invalidOutput } from './extension-media-job-service-execution-support.js'

export function parseCheckpoint(value: JsonValue | undefined): MediaStartFfmpegJobRequest {
  const parsed = MediaStartFfmpegJobRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ExtensionMediaJobError('invalid_checkpoint', 'Media job checkpoint is invalid')
  }
  return parsed.data
}

export function validateGeneratedOutput(
  generated: {
    id: string
    mimeType: string
    byteSize?: number
    completionIdentity?: string
  },
  probe: MediaProbeResult
): { width?: number; height?: number; durationMicros?: number } {
  if (probe.handleId !== generated.id || !Number.isSafeInteger(generated.byteSize) ||
    Number(generated.byteSize) <= 0 || !generated.completionIdentity) {
    throw invalidOutput('Generated media identity is incomplete')
  }
  const durationMicros = positiveDurationMicros(probe)
  if (generated.mimeType.startsWith('video/')) {
    const video = probe.streams.find((stream) => stream.kind === 'video')
    if (!video || durationMicros === undefined) {
      throw invalidOutput('Generated video is missing a video stream or positive duration')
    }
    return {
      ...(video.width !== undefined ? { width: video.width } : {}),
      ...(video.height !== undefined ? { height: video.height } : {}),
      durationMicros
    }
  }
  if (generated.mimeType.startsWith('audio/')) {
    if (!probe.streams.some((stream) => stream.kind === 'audio') || durationMicros === undefined) {
      throw invalidOutput('Generated audio is missing an audio stream or positive duration')
    }
    return { durationMicros }
  }
  if (generated.mimeType.startsWith('image/')) {
    const image = probe.streams.find((stream) =>
      stream.kind === 'video' && stream.width !== undefined && stream.height !== undefined)
    if (!image) throw invalidOutput('Generated image is missing a bounded image stream')
    return { width: image.width, height: image.height }
  }
  if (generated.mimeType === 'application/x-subrip' || generated.mimeType === 'text/vtt') {
    const expectedFormat = generated.mimeType === 'application/x-subrip' ? 'srt' : 'webvtt'
    if (!probe.container.formatNames.includes(expectedFormat) ||
      !probe.streams.some((stream) => stream.kind === 'subtitle')) {
      throw invalidOutput('Generated subtitle is missing its expected subtitle stream')
    }
    // ffprobe commonly omits duration for standalone SRT/WebVTT. The Host has
    // already enforced a non-empty, bounded file and an actual subtitle stream.
    return durationMicros === undefined ? {} : { durationMicros }
  }
  throw invalidOutput('Generated output MIME type is not supported for artifact publication')
}

export function validateGeneratedOtioOutput(
  generated: {
    id: string
    mimeType: string
    byteSize?: number
    completionIdentity?: string
  },
  request: MediaStartFfmpegJobRequest
): { width?: number; height?: number; durationMicros?: number } {
  if (!Number.isSafeInteger(generated.byteSize) || Number(generated.byteSize) <= 0 ||
    !generated.completionIdentity) {
    throw invalidOutput('Generated OpenTimelineIO document identity is incomplete')
  }
  const candidates = Object.values(request.textOutputs ?? {}).filter((output) =>
    output.mimeType === 'application/x-otio+json' &&
    Buffer.byteLength(output.content, 'utf8') === generated.byteSize
  )
  if (candidates.length === 0) {
    throw invalidOutput('Generated OpenTimelineIO document does not match its declared bounded content')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidates[0]!.content)
  } catch {
    throw invalidOutput('Generated OpenTimelineIO document is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !['SerializableCollection.1', 'Timeline.1']
      .includes(String((parsed as Record<string, unknown>).OTIO_SCHEMA))) {
    throw invalidOutput('Generated OpenTimelineIO document root schema is invalid')
  }
  return {}
}

export function positiveDurationMicros(probe: MediaProbeResult): number | undefined {
  const values = [
    probe.container.durationMicros,
    ...probe.streams.map((stream) => stream.durationMicros)
  ].filter((value): value is number => value !== undefined && value > 0)
  return values.length === 0 ? undefined : Math.max(...values)
}

export function safeProvenanceMetadata(
  value: MediaStartFfmpegJobRequest['metadata']
): GeneratedArtifact['provenance']['metadata'] | undefined {
  if (!value) return undefined
  const metadata: NonNullable<GeneratedArtifact['provenance']['metadata']> = {}
  if (typeof value.projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.projectId)) {
    metadata.projectId = value.projectId
  }
  if (Number.isSafeInteger(value.pinnedRevision) && Number(value.pinnedRevision) >= 0) {
    metadata.pinnedRevision = Number(value.pinnedRevision)
  }
  if (typeof value.sequenceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.sequenceId)) {
    metadata.sequenceId = value.sequenceId
  }
  if (value.interchangeAdapterId === 'kun.otio-json') {
    metadata.interchangeAdapterId = value.interchangeAdapterId
  }
  if (typeof value.interchangeAdapterVersion === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.interchangeAdapterVersion)) {
    metadata.interchangeAdapterVersion = value.interchangeAdapterVersion
  }
  for (const key of ['documentDigest', 'projectDigest'] as const) {
    const digest = value[key]
    if (typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) metadata[key] = digest
  }
  if (Number.isSafeInteger(value.lossCount) && Number(value.lossCount) >= 0 && Number(value.lossCount) <= 128) {
    metadata.lossCount = Number(value.lossCount)
  }
  if (typeof value.portableLossless === 'boolean') metadata.portableLossless = value.portableLossless
  if (typeof value.kunRoundTripLossless === 'boolean') metadata.kunRoundTripLossless = value.kunRoundTripLossless
  if (value.renderKind === 'proof-frame' || value.renderKind === 'preview' ||
    value.renderKind === 'h264-mp4' || value.renderKind === 'h265-mp4' ||
    value.renderKind === 'prores-mov' || value.renderKind === 'ffv1-mkv' ||
    value.renderKind === 'audio-aac' ||
    value.renderKind === 'subtitles') {
    metadata.renderKind = value.renderKind
  }
  if (value.requestedRenderKind === 'h264-mp4' || value.requestedRenderKind === 'h265-mp4' ||
    value.requestedRenderKind === 'prores-mov') {
    metadata.requestedRenderKind = value.requestedRenderKind
  }
  for (const key of [
    'renderIrDigest',
    'backendCapabilitiesDigest',
    'advancedSettingsDigest',
    'advancedCapabilitiesDigest',
    'effectSemanticsDigest'
  ] as const) {
    const digest = value[key]
    if (typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) metadata[key] = digest
  }
  if (typeof value.portableEquivalent === 'boolean') {
    metadata.portableEquivalent = value.portableEquivalent
  }
  const renderRange = value.renderRange
  if (
    renderRange && typeof renderRange === 'object' && !Array.isArray(renderRange) &&
    Number.isSafeInteger(renderRange.startFrame) && Number(renderRange.startFrame) >= 0 &&
    Number.isSafeInteger(renderRange.endFrame) &&
    Number(renderRange.endFrame) > Number(renderRange.startFrame)
  ) {
    metadata.renderRange = {
      startFrame: Number(renderRange.startFrame),
      endFrame: Number(renderRange.endFrame)
    }
  }
  if (value.playbackMode === 'source-fast-path' || value.playbackMode === 'composed-proof') {
    metadata.playbackMode = value.playbackMode
  }
  if (value.canvasPreset === '16:9' || value.canvasPreset === '9:16' ||
    value.canvasPreset === '1:1') {
    metadata.canvasPreset = value.canvasPreset
  }
  if (Number.isSafeInteger(value.proofFrame) && Number(value.proofFrame) >= 0) {
    metadata.proofFrame = Number(value.proofFrame)
  }
  if (value.captionMode === 'none' || value.captionMode === 'burned' ||
    value.captionMode === 'sidecar' || value.captionMode === 'both') {
    metadata.captionMode = value.captionMode
  }
  if (value.subtitleFormat === 'srt' || value.subtitleFormat === 'vtt') {
    metadata.subtitleFormat = value.subtitleFormat
  }
  if (typeof value.derivedId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.derivedId)) {
    metadata.derivedId = value.derivedId
  }
  if (typeof value.assetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.assetId)) {
    metadata.assetId = value.assetId
  }
  if (typeof value.dedupeKey === 'string' && /^[a-f0-9]{64}$/u.test(value.dedupeKey)) {
    metadata.dedupeKey = value.dedupeKey
  }
  if (
    value.derivedKind === 'waveform' || value.derivedKind === 'thumbnail' ||
    value.derivedKind === 'filmstrip' || value.derivedKind === 'proxy' ||
    value.derivedKind === 'proof' || value.derivedKind === 'preview'
  ) {
    metadata.derivedKind = value.derivedKind
  }
  if (typeof value.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(value.sourceFingerprint)) {
    metadata.sourceFingerprint = value.sourceFingerprint
  }
  if (typeof value.producerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value.producerId)) {
    metadata.producerId = value.producerId
  }
  if (typeof value.producerVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(value.producerVersion)) {
    metadata.producerVersion = value.producerVersion
  }
  if (
    value.priority === 'background' || value.priority === 'user' ||
    value.priority === 'interactive' || value.priority === 'export'
  ) metadata.priority = value.priority
  if (typeof value.derivedPhase === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value.derivedPhase)) {
    metadata.derivedPhase = value.derivedPhase
  }
  if (Number.isSafeInteger(value.derivedPhaseIndex) && Number(value.derivedPhaseIndex) >= 0 && Number(value.derivedPhaseIndex) <= 16) {
    metadata.derivedPhaseIndex = Number(value.derivedPhaseIndex)
  }
  if (Number.isSafeInteger(value.derivedPhaseCount) && Number(value.derivedPhaseCount) >= 1 && Number(value.derivedPhaseCount) <= 16) {
    metadata.derivedPhaseCount = Number(value.derivedPhaseCount)
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}
