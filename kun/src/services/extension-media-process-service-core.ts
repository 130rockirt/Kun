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
import { BEAT_MAX_ANALYSIS_MICROS, BEAT_PCM_SAMPLE_RATE, EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST, EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST, type ExtensionAudioAnalysisCapabilities, type ExtensionBeatGridAnalysis, ExtensionMediaProcessError, type ExtensionSilenceAnalysis, type ExtensionSyncFeatureSeries, type ExtensionVisualFrameAnalysis, type ExtensionVisualFrameSample, type MediaCapabilities, type MediaCapability, type MediaExecutableName, type MediaProbeMetadata, type MediaProcessOptions, SYNC_FEATURE_SAMPLE_RATE, VISUAL_FRAME_BYTES, VISUAL_FRAME_HEIGHT, VISUAL_FRAME_WIDTH } from './extension-media-process-service-contracts.js'
import { assertSafeAnalysisInput, audioDurationMicros, boundedDecimal, defaultMediaDiscoveryDirectories, type DiscoveredExecutable, discoverExecutable, inspectFfmpegFeatures, microsSeconds, microsSeekSeconds, runBoundedProcess, scrubbedEnvironment, sourceEvidence, visualDurationMicros } from './extension-media-process-service-process-discovery.js'
import { beatPcmByteLimit, detectBeatGridFromPcm, parseSilenceIntervals, pcmEnergyFeatures, syncPcmByteLimit, visualFeaturesFromRgb24 } from './extension-media-process-service-analysis.js'
import { boundedInteger, boundedVersion, normalizeProbeJson, requireProcessPermission } from './extension-media-process-service-probe-normalization.js'

/**
 * Host-owned native media process boundary. It never accepts an extension path
 * and exposes only normalized, bounded metadata.
 */
export class ExtensionMediaProcessService {
  private readonly now: () => Date
  private readonly probeTimeoutMs: number
  private readonly discoveryTimeoutMs: number
  private readonly maxProbeOutputBytes: number
  private readonly maxDiagnosticBytes: number
  private readonly ffmpegTimeoutMs: number
  private readonly maxFfmpegProgressBytes: number
  private readonly maxFfmpegLogBytes: number
  private readonly configuredPaths: Partial<Record<MediaExecutableName, string>>
  private readonly pathEnv: string
  private readonly discoveryDirectories: string[]
  private readonly processRunner: typeof runBoundedProcess

  constructor(private readonly options: MediaProcessOptions) {
    this.now = options.now ?? (() => new Date())
    this.probeTimeoutMs = boundedInteger(options.probeTimeoutMs, 30_000, 250, 300_000)
    this.discoveryTimeoutMs = boundedInteger(options.discoveryTimeoutMs, 5_000, 100, 30_000)
    this.maxProbeOutputBytes = boundedInteger(options.maxProbeOutputBytes, 2 * 1024 * 1024, 1024, 8 * 1024 * 1024)
    this.maxDiagnosticBytes = boundedInteger(options.maxDiagnosticBytes, 64 * 1024, 1024, 1024 * 1024)
    this.ffmpegTimeoutMs = boundedInteger(options.ffmpegTimeoutMs, 6 * 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000)
    this.maxFfmpegProgressBytes = boundedInteger(options.maxFfmpegProgressBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024)
    this.maxFfmpegLogBytes = boundedInteger(options.maxFfmpegLogBytes, 4 * 1024 * 1024, 1024, 32 * 1024 * 1024)
    this.configuredPaths = {
      ...(options.ffprobePath ? { ffprobe: options.ffprobePath } : {}),
      ...(options.ffmpegPath ? { ffmpeg: options.ffmpegPath } : {})
    }
    this.pathEnv = options.pathEnv ?? process.env.PATH ?? ''
    this.discoveryDirectories = options.discoveryDirectories ?? defaultMediaDiscoveryDirectories()
    this.processRunner = options.processRunner ?? runBoundedProcess
  }

  async capabilities(principal: ExtensionPrincipal): Promise<MediaCapabilities> {
    requireProcessPermission(principal)
    const [ffprobe, ffmpeg] = await Promise.all([
      this.inspectExecutable('ffprobe'),
      this.inspectExecutable('ffmpeg')
    ])
    return { probedAt: this.now().toISOString(), ffprobe, ffmpeg }
  }

  async audioAnalysisCapabilities(
    principal: ExtensionPrincipal
  ): Promise<ExtensionAudioAnalysisCapabilities> {
    requireProcessPermission(principal)
    const [ffprobe, ffmpeg] = await Promise.all([
      this.inspectExecutable('ffprobe'),
      this.inspectExecutable('ffmpeg')
    ])
    const executablePairAvailable = ffprobe.available && ffmpeg.available
    const features = new Set(ffmpeg.features ?? [])
    return {
      probedAt: this.now().toISOString(),
      executablesAvailable: executablePairAvailable,
      silence: executablePairAvailable && features.has('silencedetect-filter'),
      syncFeatures: executablePairAvailable &&
        features.has('pcm-s16-encoder') && features.has('s16le-muxer'),
      // FFmpeg is only the confined PCM decoder. Beat/downbeat evidence is
      // produced by Kun's deterministic bounded onset/autocorrelation
      // analyzer below; no optional plugin, model download, or network is used.
      beatGrid: executablePairAvailable &&
        features.has('pcm-s16-encoder') && features.has('s16le-muxer')
    }
  }

  async probe(
    principal: ExtensionPrincipal,
    handleId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<MediaProbeMetadata> {
    // Check media.process before handle resolution or executable discovery so
    // unauthorized callers cannot use the API as a capability oracle.
    requireProcessPermission(principal)
    const input = await this.options.handleService.resolve(principal, handleId, 'read')
    if (input.absolutePath.includes('%')) {
      throw new ExtensionMediaProcessError(
        'invalid_probe_output',
        'Media input name uses unsupported pattern syntax'
      )
    }
    const executable = await this.requireExecutable('ffprobe')
    const result = await this.processRunner(executable.path, [
      '-v', 'error',
      '-hide_banner',
      '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
      '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      input.absolutePath
    ], {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.probeTimeoutMs,
      maxStdoutBytes: this.maxProbeOutputBytes,
      maxStderrBytes: this.maxDiagnosticBytes,
      signal: options.signal
    })
    if (result.exitCode !== 0) {
      throw new ExtensionMediaProcessError('process_failed', 'Media probe failed')
    }
    return normalizeProbeJson(result.stdout, input)
  }

  /**
   * Core-only fixed silence detector. The public request controls numeric
   * bounds only; executable arguments and the resolved path stay inside Kun.
   */
  async analyzeSilenceForCore(
    principal: ExtensionPrincipal,
    handleId: string,
    input: {
      noiseThresholdDb: number
      minimumSilenceMicros: number
      maxIntervals: number
      signal?: AbortSignal
    }
  ): Promise<ExtensionSilenceAnalysis> {
    requireProcessPermission(principal)
    const source = await this.options.handleService.resolve(principal, handleId, 'read')
    assertSafeAnalysisInput(source)
    const probe = await this.probe(principal, handleId, { signal: input.signal })
    const durationMicros = audioDurationMicros(probe)
    if (!probe.streams.some(({ kind }) => kind === 'audio') || durationMicros === undefined) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Local silence analysis requires an audio stream with a positive duration'
      )
    }
    const executable = await this.requireExecutable('ffmpeg')
    const result = await this.processRunner(executable.path, [
      '-v', 'info',
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
      '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
      '-i', source.absolutePath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-af', `silencedetect=noise=${boundedDecimal(input.noiseThresholdDb)}dB:d=${microsSeconds(input.minimumSilenceMicros)}`,
      '-f', 'null',
      '-'
    ], {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.ffmpegTimeoutMs,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: this.maxFfmpegLogBytes,
      signal: input.signal
    })
    if (result.exitCode !== 0) {
      throw new ExtensionMediaProcessError('process_failed', 'Local silence analysis failed')
    }
    const parsed = parseSilenceIntervals(
      result.stderr.toString('utf8'),
      durationMicros,
      input.minimumSilenceMicros,
      input.maxIntervals
    )
    return {
      source: sourceEvidence(source),
      intervals: parsed.intervals,
      analyzedDurationMicros: durationMicros,
      truncated: parsed.truncated
    }
  }

  /**
   * Extract a bounded, mean-centred mono energy envelope suitable as input to
   * a separately seeded correlation planner. This method does not decide a
   * sync offset and never moves media.
   */
  async extractSyncFeaturesForCore(
    principal: ExtensionPrincipal,
    handleId: string,
    input: {
      samplePeriodMicros: number
      maximumDurationMicros: number
      maxFeaturePoints: number
      signal?: AbortSignal
    }
  ): Promise<ExtensionSyncFeatureSeries> {
    requireProcessPermission(principal)
    const source = await this.options.handleService.resolve(principal, handleId, 'read')
    assertSafeAnalysisInput(source)
    const probe = await this.probe(principal, handleId, { signal: input.signal })
    const durationMicros = audioDurationMicros(probe)
    if (!probe.streams.some(({ kind }) => kind === 'audio') || durationMicros === undefined) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Local synchronization features require an audio stream with a positive duration'
      )
    }
    const boundedDurationMicros = Math.min(
      input.maximumDurationMicros,
      input.samplePeriodMicros * input.maxFeaturePoints
    )
    const executable = await this.requireExecutable('ffmpeg')
    const result = await this.processRunner(executable.path, [
      '-v', 'error',
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
      '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
      '-i', source.absolutePath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-ac', '1',
      '-ar', String(SYNC_FEATURE_SAMPLE_RATE),
      '-t', microsSeconds(boundedDurationMicros),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ], {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.ffmpegTimeoutMs,
      maxStdoutBytes: syncPcmByteLimit(boundedDurationMicros),
      maxStderrBytes: this.maxDiagnosticBytes,
      signal: input.signal
    })
    if (result.exitCode !== 0) {
      throw new ExtensionMediaProcessError(
        'process_failed',
        'Local synchronization feature extraction failed'
      )
    }
    const extracted = pcmEnergyFeatures(
      result.stdout,
      input.samplePeriodMicros,
      input.maxFeaturePoints
    )
    if (extracted.features.length < 8) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Audio has insufficient bounded evidence for synchronization'
      )
    }
    return {
      source: sourceEvidence(source),
      features: extracted.features,
      analyzedDurationMicros: extracted.analyzedDurationMicros,
      truncated: durationMicros > extracted.analyzedDurationMicros ||
        durationMicros > input.maximumDurationMicros
    }
  }

  /**
   * Decode a bounded mono PCM envelope and derive conservative beat/downbeat
   * evidence inside Kun. FFmpeg never chooses the algorithm and extensions
   * cannot supply paths, filters, executable arguments, thresholds, or tempo.
   * Ambiguous material returns an empty grid instead of fabricated markers.
   */
  async analyzeBeatGridForCore(
    principal: ExtensionPrincipal,
    handleId: string,
    input: {
      maxMarkers: number
      signal?: AbortSignal
    }
  ): Promise<ExtensionBeatGridAnalysis> {
    requireProcessPermission(principal)
    const source = await this.options.handleService.resolve(principal, handleId, 'read')
    assertSafeAnalysisInput(source)
    const probe = await this.probe(principal, handleId, { signal: input.signal })
    const durationMicros = audioDurationMicros(probe)
    if (!probe.streams.some(({ kind }) => kind === 'audio') || durationMicros === undefined) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Local beat analysis requires an audio stream with a positive duration'
      )
    }
    const maximumDurationMicros = Math.min(durationMicros, BEAT_MAX_ANALYSIS_MICROS)
    const executable = await this.requireExecutable('ffmpeg')
    const result = await this.processRunner(executable.path, [
      '-v', 'error',
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
      '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
      '-i', source.absolutePath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-ac', '1',
      '-ar', String(BEAT_PCM_SAMPLE_RATE),
      '-t', microsSeconds(maximumDurationMicros),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ], {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.ffmpegTimeoutMs,
      maxStdoutBytes: beatPcmByteLimit(maximumDurationMicros),
      maxStderrBytes: this.maxDiagnosticBytes,
      signal: input.signal
    })
    if (result.exitCode !== 0) {
      throw new ExtensionMediaProcessError('process_failed', 'Local beat analysis failed')
    }
    const detected = detectBeatGridFromPcm(result.stdout, input.maxMarkers)
    return {
      source: sourceEvidence(source),
      ...(detected.tempoBpm === undefined ? {} : { tempoBpm: detected.tempoBpm }),
      markers: detected.markers,
      analyzedDurationMicros: detected.analyzedDurationMicros,
      truncated: detected.truncated || durationMicros > detected.analyzedDurationMicros
    }
  }

  /**
   * Decode real, Host-authorized visual frames with one fixed, path-opaque
   * FFmpeg profile and reduce the pixels to a bounded deterministic feature
   * vector. No frame bytes or local locations leave Kun.
   */
  async analyzeVisualFramesForCore(
    principal: ExtensionPrincipal,
    handleId: string,
    samples: readonly ExtensionVisualFrameSample[],
    options: { signal?: AbortSignal } = {}
  ): Promise<ExtensionVisualFrameAnalysis> {
    requireProcessPermission(principal)
    if (samples.length < 1 || samples.length > 16) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Local visual analysis requires 1 through 16 bounded frame samples'
      )
    }
    const sampleIds = new Set<string>()
    for (const sample of samples) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(sample.sampleId) ||
        sampleIds.has(sample.sampleId) ||
        !Number.isSafeInteger(sample.startMicros) || sample.startMicros < 0 ||
        !Number.isSafeInteger(sample.endMicros) || sample.endMicros <= sample.startMicros ||
        !Number.isSafeInteger(sample.representativeMicros) ||
        sample.representativeMicros < sample.startMicros ||
        sample.representativeMicros >= sample.endMicros
      ) {
        throw new ExtensionMediaProcessError(
          'invalid_analysis_output',
          'Local visual frame sampling request is invalid'
        )
      }
      sampleIds.add(sample.sampleId)
    }
    const source = await this.options.handleService.resolve(principal, handleId, 'read')
    assertSafeAnalysisInput(source)
    const probe = await this.probe(principal, handleId, { signal: options.signal })
    if (!probe.streams.some(({ kind }) => kind === 'video')) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'Local visual analysis requires a decodable visual stream'
      )
    }
    const durationMicros = visualDurationMicros(probe)
    if (
      durationMicros !== undefined &&
      samples.some(({ representativeMicros }) => representativeMicros >= durationMicros)
    ) {
      throw new ExtensionMediaProcessError(
        'invalid_analysis_output',
        'A requested visual sample is outside the authorized media duration'
      )
    }
    const executable = await this.requireExecutable('ffmpeg')
    const embeddings: ExtensionVisualFrameAnalysis['embeddings'] = []
    for (const sample of samples) {
      options.signal?.throwIfAborted()
      const result = await this.processRunner(executable.path, [
        '-v', 'error',
        '-hide_banner',
        '-nostdin',
        '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
        '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
        '-ss', microsSeekSeconds(sample.representativeMicros),
        '-i', source.absolutePath,
        '-map', '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-frames:v', '1',
        '-vf', 'scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:black,format=rgb24',
        '-pix_fmt', 'rgb24',
        '-f', 'rawvideo',
        'pipe:1'
      ], {
        env: scrubbedEnvironment(this.pathEnv),
        timeoutMs: Math.min(this.ffmpegTimeoutMs, 60_000),
        maxStdoutBytes: VISUAL_FRAME_BYTES,
        maxStderrBytes: this.maxDiagnosticBytes,
        signal: options.signal
      })
      if (result.exitCode !== 0 || result.stdout.byteLength !== VISUAL_FRAME_BYTES) {
        throw new ExtensionMediaProcessError(
          'invalid_analysis_output',
          'Local visual frame decoding produced no valid bounded frame'
        )
      }
      embeddings.push({
        sampleId: sample.sampleId,
        vector: visualFeaturesFromRgb24(result.stdout, VISUAL_FRAME_WIDTH, VISUAL_FRAME_HEIGHT)
      })
    }
    options.signal?.throwIfAborted()
    // Re-resolve after every frame was consumed so a source replacement during
    // decoding cannot be published under the identity captured before decode.
    await this.options.handleService.resolve(principal, handleId, 'read')
    return {
      source: sourceEvidence(source),
      embeddings,
      decodedFrameWidth: VISUAL_FRAME_WIDTH,
      decodedFrameHeight: VISUAL_FRAME_HEIGHT
    }
  }

  /** Core-only execution primitive. Extension arguments must first pass the
   * handle-placeholder validator in ExtensionMediaFfmpegService. */
  async runFfmpegForCore(
    principal: ExtensionPrincipal,
    args: string[],
    options: { signal?: AbortSignal; onProgressChunk?: (chunk: Buffer) => void } = {}
  ): Promise<{ exitCode: number }> {
    requireProcessPermission(principal)
    const executable = await this.requireExecutable('ffmpeg')
    const result = await this.processRunner(executable.path, args, {
      env: scrubbedEnvironment(this.pathEnv),
      timeoutMs: this.ffmpegTimeoutMs,
      maxStdoutBytes: this.maxFfmpegProgressBytes,
      maxStderrBytes: this.maxFfmpegLogBytes,
      signal: options.signal,
      onStdoutChunk: options.onProgressChunk
    })
    return { exitCode: result.exitCode }
  }

  private async inspectExecutable(name: MediaExecutableName): Promise<MediaCapability> {
    const executable = await discoverExecutable(
      name,
      this.configuredPaths[name],
      this.pathEnv,
      this.discoveryDirectories
    )
    if (!executable) return { name, available: false }
    try {
      const result = await this.processRunner(executable.path, ['-version'], {
        env: scrubbedEnvironment(this.pathEnv),
        timeoutMs: this.discoveryTimeoutMs,
        maxStdoutBytes: this.maxDiagnosticBytes,
        maxStderrBytes: this.maxDiagnosticBytes
      })
      if (result.exitCode !== 0) return { name, available: false }
      const firstLine = result.stdout.toString('utf8').split(/\r?\n/u, 1)[0]?.trim() ?? ''
      const version = boundedVersion(firstLine, name)
      const features = name === 'ffmpeg'
          ? await inspectFfmpegFeatures(
            this.processRunner,
            executable.path,
            scrubbedEnvironment(this.pathEnv),
            this.discoveryTimeoutMs,
            this.maxDiagnosticBytes
          )
        : []
      return {
        name,
        available: true,
        source: executable.source,
        ...(version ? { version } : {}),
        ...(features.length > 0 ? { features } : {})
      }
    } catch {
      return { name, available: false }
    }
  }

  private async requireExecutable(name: MediaExecutableName): Promise<DiscoveredExecutable> {
    const executable = await discoverExecutable(
      name,
      this.configuredPaths[name],
      this.pathEnv,
      this.discoveryDirectories
    )
    if (!executable) {
      throw new ExtensionMediaProcessError(
        'executable_unavailable',
        `${name} is not available on this host`,
        true
      )
    }
    return executable
  }
}
