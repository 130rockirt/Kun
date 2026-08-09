import {
  AccountSchema,
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  ExtensionApiError,
  ExtensionHostClient,
  ExtensionToolDeclarationSchema,
  GeneratedArtifactSchema,
  HostMessageSchema,
  JobCancelRequestSchema,
  JobEventSchema,
  JobFilterSchema,
  JobListRequestSchema,
  JobResultSchema,
  JobSnapshotSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaMetadataSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickSaveTargetRequestSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartArchiveJobRequestSchema,
  MediaVisualModelStatusSchema,
  ModelProviderDeclarationSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ProviderStatusSchema,
  ThemeSchema,
  LocaleSchema,
  createExtensionContext,
  hasPermission,
  toDisposable,
  type Account,
  type Activate,
  type AgentCreateRunRequest,
  type AgentRun,
  type AgentRunEvent,
  type Deactivate,
  type Disposable,
  type ExtensionContext,
  type ExtensionIdentity,
  type ExtensionToolDeclaration,
  type HostNotification,
  type HostRequestContext,
  type HostRequestHandler,
  type HostRequestOptions,
  type HostTransport,
  type GeneratedArtifact,
  type JobEvent,
  type JobListRequest,
  type JobResult,
  type JobResultInput,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaAudioAnalysisCapabilities,
  type MediaVisualModelStatus,
  type MediaCapabilities,
  type ModelProviderDeclaration,
  type ModelProviderStreamEvent,
  type MediaMetadata,
  type MediaProbeResult,
  type NetworkResponse,
  type Permission,
  type ProviderStatus,
  type Theme,
  type Locale,
  type WorkspaceContext,
  type WorkspaceFile
} from '@kun/extension-api'
import { createHash } from 'node:crypto'


import { FakeClock, FakeHostTransport } from './fake-transport.js'
import { FakeJobService } from './fake-job-service.js'
import { notFound, unavailable } from './fake-service-helpers.js'

export class FakeMediaService {
  readonly handles = new Map<string, MediaMetadata>()
  readonly probes = new Map<string, MediaProbeResult>()
  readonly textContents = new Map<string, string>()
  readonly leases = new Map<string, { handleId: string; revoked: boolean }>()
  readonly #fileSelections: MediaMetadata[][] = []
  readonly #saveSelections: Array<MediaMetadata | undefined> = []
  executablesAvailable = true
  #capabilities: MediaCapabilities
  #audioAnalysisCapabilities: MediaAudioAnalysisCapabilities
  #visualModelStatus: MediaVisualModelStatus
  #nextLease = 1
  #nextCacheTarget = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly jobs: FakeJobService,
    private readonly clock: FakeClock
  ) {
    this.#capabilities = MediaCapabilitiesSchema.parse({
      probedAt: this.clock.nowIso(),
      ffprobe: {
        name: 'ffprobe',
        available: true,
        version: 'fake ffprobe 1.0',
        features: []
      },
      ffmpeg: {
        name: 'ffmpeg',
        available: true,
        version: 'fake ffmpeg 1.0',
        features: [
          'libx264-encoder',
          'aac-encoder',
          'drawtext-filter',
          'subtitles-filter'
        ]
      }
    })
    this.#audioAnalysisCapabilities = MediaAudioAnalysisCapabilitiesSchema.parse({
      schemaVersion: 1,
      probedAt: this.clock.nowIso(),
      analyses: [
        {
          analysis: 'silence', available: true,
          algorithm: 'ffmpeg.silencedetect', algorithmVersion: '1.0.0',
          local: true, networkUsed: false
        },
        {
          analysis: 'beat-grid', available: false,
          code: 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE',
          remediation: 'No verified local beat/downbeat analyzer is configured.',
          retryable: false, local: true, networkUsed: false
        },
        {
          analysis: 'sync-features', available: true,
          algorithm: 'kun.pcm-energy-envelope', algorithmVersion: '1.0.0',
          local: true, networkUsed: false
        }
      ]
    })
    this.#visualModelStatus = MediaVisualModelStatusSchema.parse({
      schemaVersion: 1,
      state: 'missing',
      descriptor: {
        adapterId: 'kun.local.visual-features', adapterVersion: '1.0.0',
        modelId: 'kun-visual-features', modelVersion: '1.0.0',
        packageId: 'kun-bundled.visual-features-v1', manifestSha256: 'a'.repeat(64),
        files: [{ name: 'visual-features-v1.json', sha256: 'b'.repeat(64), byteSize: 582 }],
        embeddingDimensions: 24, execution: 'local',
        querySemantics: 'bounded-visual-features-v1'
      },
      installSupported: false,
      checkedAt: this.clock.nowIso(),
      remediation: 'Configure an explicit verified visual model fixture before indexing.',
      local: true,
      networkUsedForInference: false,
      rawPathsExposed: false,
      urlsAccepted: false
    })
  }

  install(): void {
    this.transport.handle('media.pickFiles', (params) => {
      MediaPickFilesRequestSchema.parse(params)
      const files = this.#fileSelections.shift()
      return files && files.length > 0 ? { outcome: 'selected', files } : { outcome: 'cancelled', files: [] }
    })
    this.transport.handle('media.pickSaveTarget', (params) => {
      MediaPickSaveTargetRequestSchema.parse(params)
      const target = this.#saveSelections.shift()
      return target ? { outcome: 'selected', target } : { outcome: 'cancelled' }
    })
    this.transport.handle('media.createCacheTarget', (params) => {
      const request = MediaCreateCacheTargetRequestSchema.parse(params)
      const handleId = `fake_cache_target_${String(this.#nextCacheTarget++).padStart(4, '0')}`
      const metadata = MediaMetadataSchema.parse({
        handleId,
        mode: 'export',
        kind: request.format === 'wav'
          ? 'audio'
          : request.format === 'png' || request.format === 'jpeg'
            ? 'image'
            : 'video',
        displayName: `${request.purpose}.${request.format === 'jpeg' ? 'jpg' : request.format}`,
        mimeType: request.format === 'png'
          ? 'image/png'
          : request.format === 'jpeg'
            ? 'image/jpeg'
            : request.format === 'mp4'
              ? 'video/mp4'
              : request.format === 'webm'
                ? 'video/webm'
                : 'audio/wav',
        revoked: false
      })
      this.handles.set(handleId, metadata)
      return { target: metadata }
    })
    this.transport.handle('media.stat', (params) => {
      const handle = this.#get(MediaProbeRequestSchema.parse(params).handleId, 'media.stat')
      return handle
    })
    this.transport.handle('media.readText', (params) => {
      const request = MediaReadTextRequestSchema.parse(params)
      const handle = this.#get(request.handleId, 'media.readText')
      if (handle.mode !== 'read') throw notFound('Media handle is not readable', 'media.readText')
      const content = this.textContents.get(handle.handleId)
      if (content === undefined) throw notFound('Fake text content was not configured', 'media.readText')
      const byteSize = new TextEncoder().encode(content).byteLength
      if (byteSize > request.maxBytes) {
        throw new ExtensionApiError({
          code: 'RESOURCE_LIMIT',
          message: `Fake text content exceeds the ${request.maxBytes}-byte read limit`,
          operation: 'media.readText',
          retryable: false,
          details: { byteSize, maxBytes: request.maxBytes }
        })
      }
      return MediaReadTextResultSchema.parse({
        handleId: handle.handleId,
        displayName: handle.displayName,
        mimeType: handle.mimeType ?? 'text/plain',
        byteSize,
        content
      })
    })
    this.transport.handle('media.release', (params) => {
      const request = MediaReleaseRequestSchema.parse(params)
      if (request.resource === 'lease') {
        const lease = this.leases.get(request.leaseId)
        if (lease) lease.revoked = true
        return { released: lease !== undefined }
      }
      const handle = this.handles.get(request.handleId)
      if (handle) this.handles.set(request.handleId, { ...handle, revoked: true })
      return { released: handle !== undefined }
    })
    this.transport.handle('media.openViewResource', (params) => {
      const request = MediaOpenViewResourceRequestSchema.parse(params)
      const handle = this.#get(request.handleId, 'media.openViewResource')
      if (handle.mode !== 'read') throw notFound('Media handle is not readable', 'media.openViewResource')
      this.handles.set(handle.handleId, {
        ...handle,
        lastAccessedAt: this.clock.nowIso()
      })
      const leaseId = `fake_media_lease_${String(this.#nextLease++).padStart(4, '0')}`
      this.leases.set(leaseId, { handleId: handle.handleId, revoked: false })
      return {
        leaseId,
        handleId: handle.handleId,
        url: `kun-media://fake/${leaseId}`,
        mimeType: handle.mimeType ?? 'application/octet-stream',
        expiresAt: new Date(this.clock.now() + 60_000).toISOString()
      }
    })
    this.transport.handle('media.getCapabilities', () => {
      if (this.executablesAvailable) return structuredClone(this.#capabilities)
      return MediaCapabilitiesSchema.parse({
        probedAt: this.clock.nowIso(),
        ffprobe: { name: 'ffprobe', available: false, features: [] },
        ffmpeg: { name: 'ffmpeg', available: false, features: [] }
      })
    })
    this.transport.handle('media.getAudioAnalysisCapabilities', () => {
      if (this.executablesAvailable) return structuredClone(this.#audioAnalysisCapabilities)
      return MediaAudioAnalysisCapabilitiesSchema.parse({
        schemaVersion: 1,
        probedAt: this.clock.nowIso(),
        analyses: ['silence', 'beat-grid', 'sync-features'].map((analysis) => ({
          analysis,
          available: false,
          code: analysis === 'beat-grid'
            ? 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE'
            : 'AUDIO_ANALYSIS_EXECUTABLE_UNAVAILABLE',
          remediation: 'Local audio analysis is unavailable in this fake Host.',
          retryable: analysis !== 'beat-grid',
          local: true,
          networkUsed: false
        }))
      })
    })
    this.transport.handle('media.getVisualModelStatus', () =>
      structuredClone(this.#visualModelStatus))
    this.transport.handle('media.installVisualModel', () =>
      structuredClone(this.#visualModelStatus))
    this.transport.handle('media.analyzeVisualFrames', (params) => {
      MediaAnalyzeVisualFramesRequestSchema.parse(params)
      return {
        outcome: 'unavailable',
        code: this.#visualModelStatus.state === 'installed'
          ? 'VISUAL_MEDIA_UNSUPPORTED'
          : 'VISUAL_MODEL_MISSING',
        remediation: 'Configure explicit measured visual frame evidence in this fake Host.',
        retryable: true,
        local: true,
        networkUsed: false
      }
    })
    this.transport.handle('media.embedVisualQuery', (params) => {
      MediaEmbedVisualQueryRequestSchema.parse(params)
      return {
        outcome: 'unavailable',
        code: this.#visualModelStatus.state === 'installed'
          ? 'VISUAL_QUERY_UNSUPPORTED'
          : 'VISUAL_MODEL_MISSING',
        remediation: 'Configure an explicit measured visual query fixture in this fake Host.',
        retryable: false,
        local: true,
        networkUsed: false
      }
    })
    this.transport.handle('media.probe', (params) => {
      if (!this.executablesAvailable) throw unavailable('media.probe')
      const request = MediaProbeRequestSchema.parse(params)
      this.#get(request.handleId, 'media.probe')
      const probe = this.probes.get(request.handleId)
      if (!probe) throw notFound('Fake probe output was not configured', 'media.probe')
      return probe
    })
    this.transport.handle('media.startFfmpegJob', (params) => {
      const request = MediaStartFfmpegJobRequestSchema.parse(params)
      const needsFfmpeg = request.arguments.length > 0 ||
        Object.keys(request.inputs).length > 0 ||
        Object.keys(request.outputs).length > 0
      if (!this.executablesAvailable && needsFfmpeg) throw unavailable('media.startFfmpegJob')
      for (const handleId of Object.values(request.inputs)) {
        const handle = this.#get(handleId, 'media.startFfmpegJob')
        if (handle.mode !== 'read') throw notFound('FFmpeg input is not readable', 'media.startFfmpegJob')
      }
      for (const handleId of Object.values(request.outputs)) {
        const handle = this.#get(handleId, 'media.startFfmpegJob')
        if (handle.mode !== 'export') throw notFound('FFmpeg output is not writable', 'media.startFfmpegJob')
      }
      for (const output of Object.values(request.textOutputs ?? {})) {
        const handle = this.#get(output.handleId, 'media.startFfmpegJob')
        if (handle.mode !== 'export') throw notFound('Text output is not writable', 'media.startFfmpegJob')
      }
      const job = this.jobs.create('media.ffmpeg', 'media.startFfmpegJob')
      return { job: { jobId: job.id, kind: job.kind, state: job.state, cursor: job.latestCursor } }
    })
    this.transport.handle('media.startAudioAnalysisJob', (params) => {
      const request = MediaStartAudioAnalysisJobRequestSchema.parse(params)
      const capability = (this.executablesAvailable
        ? this.#audioAnalysisCapabilities
        : MediaAudioAnalysisCapabilitiesSchema.parse({
            schemaVersion: 1,
            probedAt: this.clock.nowIso(),
            analyses: ['silence', 'beat-grid', 'sync-features'].map((analysis) => ({
              analysis,
              available: false,
              code: analysis === 'beat-grid'
                ? 'AUDIO_ANALYSIS_ALGORITHM_UNAVAILABLE'
                : 'AUDIO_ANALYSIS_EXECUTABLE_UNAVAILABLE',
              remediation: 'Local audio analysis is unavailable in this fake Host.',
              retryable: analysis !== 'beat-grid',
              local: true,
              networkUsed: false
            }))
          })).analyses.find(({ analysis }) => analysis === request.analysis)!
      if (!capability.available) {
        return {
          outcome: 'unavailable',
          analysis: capability.analysis,
          code: capability.code,
          remediation: capability.remediation,
          retryable: capability.retryable,
          local: true,
          networkUsed: false
        }
      }
      const handles = request.analysis === 'sync-features'
        ? [request.referenceHandleId, request.targetHandleId]
        : [request.inputHandleId]
      for (const handleId of handles) {
        const handle = this.#get(handleId, 'media.startAudioAnalysisJob')
        if (handle.mode !== 'read') {
          throw notFound('Audio-analysis input is not readable', 'media.startAudioAnalysisJob')
        }
      }
      const job = this.jobs.create('media.audio-analysis', 'media.startAudioAnalysisJob')
      return {
        outcome: 'started',
        job: { jobId: job.id, kind: job.kind, state: job.state, cursor: job.latestCursor }
      }
    })
    this.transport.handle('media.startArchiveJob', (params) => {
      const request = MediaStartArchiveJobRequestSchema.parse(params)
      const output = this.#get(request.outputHandleId, 'media.startArchiveJob')
      if (output.mode !== 'export') {
        throw notFound('Archive output is not writable', 'media.startArchiveJob')
      }
      if (output.mimeType !== 'application/zip' && output.mimeType !== 'application/octet-stream') {
        throw notFound('Archive output must be a ZIP target', 'media.startArchiveJob')
      }
      for (const entry of request.entries) {
        if (entry.kind !== 'media') continue
        const input = this.#get(entry.inputHandleId, 'media.startArchiveJob')
        if (input.mode !== 'read') {
          throw notFound('Archive input is not readable', 'media.startArchiveJob')
        }
      }
      const job = this.jobs.create('media.archive', 'media.startArchiveJob')
      return {
        outcome: 'started',
        job: { jobId: job.id, kind: job.kind, state: job.state, cursor: job.latestCursor }
      }
    })
  }

  addHandle(metadata: unknown): MediaMetadata {
    const parsed = MediaMetadataSchema.parse(metadata)
    this.handles.set(parsed.handleId, parsed)
    return structuredClone(parsed)
  }

  queueFileSelection(...files: unknown[]): MediaMetadata[] {
    const parsed = files.map((file) => this.addHandle(file))
    this.#fileSelections.push(parsed)
    return parsed
  }

  queuePickerCancellation(): void {
    this.#fileSelections.push([])
  }

  queueSaveTarget(target?: unknown): MediaMetadata | undefined {
    const parsed = target ? this.addHandle(target) : undefined
    this.#saveSelections.push(parsed)
    return parsed
  }

  setProbe(handleId: string, result: unknown): MediaProbeResult {
    this.#get(handleId, 'media.setProbe')
    const parsed = MediaProbeResultSchema.parse(result)
    if (parsed.handleId !== handleId) throw new Error('Fake probe handleId must match the configured handle')
    this.probes.set(handleId, parsed)
    return structuredClone(parsed)
  }

  setText(handleId: string, content: string): string {
    const handle = this.#get(handleId, 'media.setText')
    if (handle.mode !== 'read') throw notFound('Fake text handle must be readable', 'media.setText')
    const byteSize = new TextEncoder().encode(content).byteLength
    this.handles.set(handleId, MediaMetadataSchema.parse({ ...handle, byteSize }))
    this.textContents.set(handleId, content)
    return content
  }

  setCapabilities(value: unknown): MediaCapabilities {
    const parsed = MediaCapabilitiesSchema.parse(value)
    this.#capabilities = parsed
    return structuredClone(parsed)
  }

  setAudioAnalysisCapabilities(value: unknown): MediaAudioAnalysisCapabilities {
    const parsed = MediaAudioAnalysisCapabilitiesSchema.parse(value)
    this.#audioAnalysisCapabilities = parsed
    return structuredClone(parsed)
  }

  setVisualModelStatus(value: unknown): MediaVisualModelStatus {
    const parsed = MediaVisualModelStatusSchema.parse(value)
    this.#visualModelStatus = parsed
    return structuredClone(parsed)
  }

  #get(handleId: string, operation: string): MediaMetadata {
    const handle = this.handles.get(handleId)
    if (!handle || handle.revoked) throw notFound('Media handle was not found', operation)
    return structuredClone(handle)
  }
}
