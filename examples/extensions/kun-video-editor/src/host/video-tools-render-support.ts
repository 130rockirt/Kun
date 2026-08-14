import { createHash } from 'node:crypto'
import { MAX_MEDIA_OTIO_TEXT_BYTES } from '@kun/extension-api'
import type {
  ExtensionContext,
  ExtensionErrorData,
  GeneratedArtifact,
  JsonObject,
  JsonValue,
  JobSnapshot,
  MediaCapabilities,
  MediaMetadata,
  MediaProbeResult,
  ToolInvocationContext,
  ToolResult
} from '@kun/extension-api'
import { replaceAsciiControlCharacters } from '../text-safety.js'
import {
  ProjectService,
  TimelineOperationSchema,
  VideoEngineError,
  appendPreviewHistory,
  applySpeakerAttributionPlan,
  applyTimelineOperations,
  applyTimelineScript,
  beatSnapTargets,
  boundedEffectCatalog,
  buildVideoSelectionAttachment,
  buildEditableCaptions,
  buildSpeakerAttributionPlan,
  comparePreviewHistory,
  combineAudioSourceFingerprints,
  compileMulticamProgramIr,
  compileMulticamProgramProject,
  compileRenderIr,
  createMediaFolder,
  defaultFfmpegCapabilities,
  deleteMediaFolder,
  emptyPreviewHistory,
  framesToMicroseconds,
  generateRenderPlan,
  generateTimelineMarkdown,
  flattenNestedRenderIr,
  importTranscript,
  inspectMulticamProgram,
  inspectComposedTimeline,
  inspectRawMedia,
  mediaLibraryPage,
  microsecondsToFrames,
  negotiateRenderIr,
  negotiateAdvancedEffects,
  negotiateAdvancedExport,
  organizeMediaAssets,
  planAudioSynchronization,
  exportProjectToOtio,
  importProjectFromOtio,
  serializeOtioInterchange,
  PROJECT_PACKAGE_LIMITS,
  parseTimelineScriptHeader,
  planBatchMediaImport,
  planDecomposeNestedSequence,
  planReplaceTimelineItemFromPreview,
  projectDurationFrames,
  readCompactProjectWindow,
  readMediaIntelligenceEvidence,
  resolveProjectContext,
  resolveInteractivePlayback,
  renderIrDigest,
  selectPreviewHistory,
  sequenceDurationFrames,
  updateMediaFolder,
  validateHistory,
  type AssetTimeRange,
  type AudioSyncAnalysis,
  type DiarizationRecord,
  type ImportedDiarizationTurn,
  type AdvancedEffectExecutionPlan,
  type AdvancedExportPlan,
  type AdvancedExportSettings,
  type CaptionBuildOptions,
  type FfmpegRenderStep,
  type MediaAsset,
  type MulticamGroup,
  type MutationReceipt,
  type InterchangeLossManifest,
  type PreviewHistory,
  type PreviewHistoryEntry,
  type PreviewSource,
  type ProjectSelectionPatch,
  type ProofArtifactBinding,
  type RenderBackendCapabilities,
  type RenderKind,
  type RevisionAuthor,
  type SpeakerIdentity,
  type TextRenderStep,
  type TimelineItem,
  type TimelineOperation,
  type Transcript,
  type VideoProject
} from '../engine/index.js'
import {
  planMulticamEditorAction,
  type MulticamEditorAction
} from './multicam-control.js'
import { VIDEO_TOOL_DECLARATIONS } from './tool-contracts.js'
import { DerivedMediaService } from './derived-media-service.js'
import {
  GenerationControlPlane,
  type GenerationReferenceResolver
} from './generation-control-plane.js'
import {
  GenerationService,
  type GenerationExecutionBroker,
  type GenerationMaterialization
} from './generation-service.js'
import { KunLocalAudioAnalysisBroker } from './kun-audio-analysis-broker.js'
import {
  MediaIntelligenceService,
  type AnalysisOutcome,
  type IntelligenceRecord
} from './media-intelligence-service.js'
import {
  observedAdvancedFfmpegCapabilities,
  observedRenderBackendCapabilities,
  professionalExportCapabilityProjection
} from './professional-export.js'
import {
  prepareProjectPackageArchiveExport,
  startProjectPackageArchiveExport
} from './project-package-export-service.js'
import {
  OTIO_OUTPUT_MIME_TYPE,
  prepareOtioInterchangeExport,
  startOtioInterchangeExport
} from './otio-interchange-service.js'
import {
  ACTIVE_PROJECT_KEY, INLINE_OTIO_PREVIEW_BYTES, INTERCHANGE_MAPPING_PREVIEW_LIMIT,
  MAX_ASSETS, MAX_CAPTIONS, MAX_ITEMS, MAX_LINK_GROUPS, MAX_MEDIA_FOLDERS,
  MAX_MULTICAM_GROUPS, MAX_PROJECTS, MAX_SCRIPT_BYTES, MAX_SEQUENCES,
  MAX_TRACKS, MAX_TRANSCRIPTS, MAX_TRANSCRIPT_SEGMENTS, OTIO_EXPORT_RECORD_PREFIX,
  PACKAGE_PREFLIGHT_ASSET_PREVIEW_LIMIT, PACKAGE_PREFLIGHT_DEDUPE_PREVIEW_LIMIT,
  PREVIEW_HISTORY_PREFIX, PROJECT_PACKAGE_RECORD_PREFIX, RENDER_RECORD_PREFIX,
  RENDER_TRACKING_CANCELLATION_WAIT_MS, ExtensionApiError, ToolInputError,
  type OtioExportRecord, type ProjectPackageExportRecord,
  type RenderCapabilityAssessment, type RenderRecord, type ToolInput
} from './video-tools-model.js'
import {
  asRecord,
  boundedPositiveInteger,
  enumValue,
  exactKeys,
  optionalBoolean,
  rational
} from './video-tools-input-support.js'
export function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((value % 360) + 360) % 360
  const candidates = [0, 90, 180, 270] as const
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(closest - normalized) ? candidate : closest
  )
}

export function renderFileName(
  project: VideoProject,
  kind: RenderKind,
  subtitleFormat: 'srt' | 'vtt' = 'srt'
): string {
  const suffix = kind === 'proof-frame'
    ? 'proof.png'
    : kind === 'audio-aac'
      ? 'audio.m4a'
      : kind === 'subtitles'
        ? `captions.${subtitleFormat}`
        : kind === 'prores-mov'
          ? 'video.mov'
          : kind === 'ffv1-mkv'
            ? 'video.mkv'
            : 'video.mp4'
  return `${project.id}-revision-${project.currentRevision}-${suffix}`
}

export function renderFilter(
  kind: RenderKind,
  subtitleFormat: 'srt' | 'vtt' = 'srt'
): { name: string; extensions: string[]; mimeTypes: string[] } {
  if (kind === 'proof-frame') return { name: 'PNG image', extensions: ['png'], mimeTypes: ['image/png'] }
  if (kind === 'audio-aac') return { name: 'AAC audio', extensions: ['m4a'], mimeTypes: ['audio/mp4'] }
  if (kind === 'subtitles') return subtitleFormat === 'srt'
    ? { name: 'SubRip captions', extensions: ['srt'], mimeTypes: ['application/x-subrip'] }
    : { name: 'WebVTT captions', extensions: ['vtt'], mimeTypes: ['text/vtt'] }
  if (kind === 'h265-mp4') return { name: 'H.265 video', extensions: ['mp4'], mimeTypes: ['video/mp4'] }
  if (kind === 'prores-mov') return { name: 'ProRes video', extensions: ['mov'], mimeTypes: ['video/quicktime'] }
  if (kind === 'ffv1-mkv') return { name: 'FFV1 video', extensions: ['mkv'], mimeTypes: ['video/x-matroska'] }
  return { name: 'H.264 video', extensions: ['mp4'], mimeTypes: ['video/mp4'] }
}

export function matchesRenderedVideoTarget(
  kind: RenderKind,
  codecName: string | undefined,
  formatNames: readonly string[]
): boolean {
  const codec = codecName?.toLocaleLowerCase()
  const formats = new Set(formatNames
    .flatMap((value) => value.toLocaleLowerCase().split(','))
    .map((value) => value.trim()))
  if (kind === 'preview' || kind === 'h264-mp4') {
    return codec === 'h264' && (formats.has('mp4') || formats.has('mov'))
  }
  if (kind === 'h265-mp4') {
    return (codec === 'hevc' || codec === 'h265') && (formats.has('mp4') || formats.has('mov'))
  }
  if (kind === 'prores-mov') {
    return Boolean(codec?.startsWith('prores')) && (formats.has('mov') || formats.has('mp4'))
  }
  if (kind === 'ffv1-mkv') {
    return codec === 'ffv1' && (formats.has('matroska') || formats.has('webm'))
  }
  return false
}

export function isRequestedFinalVideoKind(
  kind: RenderKind
): kind is 'h264-mp4' | 'h265-mp4' | 'prores-mov' {
  return kind === 'h264-mp4' || kind === 'h265-mp4' || kind === 'prores-mov'
}

export function professionalRenderSettings(
  project: VideoProject,
  kind: RenderKind,
  input: ToolInput
): AdvancedExportSettings | undefined {
  const keys = [
    'width', 'height', 'frameRate', 'quality', 'acceleration',
    'allowPortableEquivalent', 'audio'
  ] as const
  const hasSettings = keys.some((key) => input[key] !== undefined)
  if (!isRequestedFinalVideoKind(kind)) {
    if (hasSettings) {
      throw new ToolInputError('Professional codec, quality, resolution, and acceleration settings require a final video render.')
    }
    return undefined
  }
  if (kind === 'h264-mp4' && !hasSettings) return undefined
  const format: AdvancedExportSettings['format'] = kind
  const timelineHasAudio = project.items.some((item) =>
    project.assets.some((asset) => asset.id === item.assetId && asset.audio !== undefined)
  )
  let audio: AdvancedExportSettings['audio']
  if (input.audio !== undefined) {
    const value = asRecord(input.audio, 'audio')
    exactKeys(value, ['codec', 'sampleRate', 'channels', 'bitrateKbps'])
    const codec = enumValue(value.codec, ['aac', 'pcm-s24', 'flac'] as const, 'audio.codec')
    const requestedSampleRate = boundedPositiveInteger(value.sampleRate, 'audio.sampleRate', 44_100, 96_000)
    if (![44_100, 48_000, 96_000].includes(requestedSampleRate)) {
      throw new ToolInputError('audio.sampleRate contains an unsupported value.')
    }
    const sampleRate = requestedSampleRate as 44_100 | 48_000 | 96_000
    audio = {
      codec,
      sampleRate,
      channels: boundedPositiveInteger(value.channels, 'audio.channels', 1, 16),
      ...(value.bitrateKbps === undefined ? {} : {
        bitrateKbps: boundedPositiveInteger(value.bitrateKbps, 'audio.bitrateKbps', 32, 1_536)
      })
    }
  } else if (timelineHasAudio) {
    audio = {
      codec: format === 'prores-mov' ? 'pcm-s24' : 'aac',
      sampleRate: 48_000,
      channels: 2,
      ...(format === 'prores-mov' ? {} : { bitrateKbps: 192 })
    }
  }
  return {
    format,
    width: input.width === undefined
      ? project.canvas.width
      : boundedPositiveInteger(input.width, 'width', 2, 16_384),
    height: input.height === undefined
      ? project.canvas.height
      : boundedPositiveInteger(input.height, 'height', 2, 16_384),
    frameRate: input.frameRate === undefined ? structuredClone(project.fps) : rational(input.frameRate, 'frameRate'),
    quality: input.quality === undefined
      ? 'high'
      : enumValue(input.quality, ['draft', 'balanced', 'high', 'master'] as const, 'quality'),
    acceleration: input.acceleration === undefined
      ? 'cpu'
      : enumValue(input.acceleration, ['cpu', 'prefer-gpu', 'require-gpu'] as const, 'acceleration'),
    allowPortableEquivalent: optionalBoolean(input.allowPortableEquivalent, 'allowPortableEquivalent') ?? false,
    ...(audio ? { audio } : {})
  }
}

export function jobReferenceProjection(
  job: { jobId: string; kind: string; state: string; cursor: string },
  purpose: string
): JsonObject {
  return { purpose, jobId: job.jobId, kind: job.kind, state: job.state, cursor: job.cursor }
}

export function renderKey(jobId: string): string {
  return `${RENDER_RECORD_PREFIX}${jobId}`
}

export function ffmpegRenderBackendCapabilities(capabilities: MediaCapabilities): RenderBackendCapabilities {
  const profile = defaultFfmpegCapabilities()
  const features = new Set(capabilities.ffmpeg.features)
  return {
    ...profile,
    version: capabilities.ffmpeg.version ?? 'unknown',
    codecs: capabilities.ffmpeg.available
      ? [
          'png',
          ...(features.has('libx264-encoder') ? ['h264'] : []),
          ...(features.has('aac-encoder') ? ['aac'] : [])
        ]
      : [],
    filters: capabilities.ffmpeg.available
      ? profile.filters.filter((filter) =>
          filter !== 'drawtext' || features.has('drawtext-filter'))
      : [],
    // The broker currently exposes encoder/filter inventory, not an arbitrary
    // system-font catalog. Advertise only the generic family used by the
    // canonical default so custom font requests fail visibly before export.
    fonts: capabilities.ffmpeg.available && features.has('drawtext-filter') ? ['sans-serif'] : []
  }
}

export function textRenderBackendCapabilities(): RenderBackendCapabilities {
  const profile = defaultFfmpegCapabilities()
  return {
    ...profile,
    id: 'kun-text-output',
    version: '1',
    codecs: [],
    filters: [],
    effects: [],
    colorSpaces: [],
    fonts: []
  }
}

export function storedRenderRecord(value: JsonValue | undefined, jobId: string): RenderRecord | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as ToolInput
  if (
    record.schemaVersion !== 1 ||
    record.jobId !== jobId ||
    typeof record.projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(record.projectId) ||
    record.projectId === '.' ||
    record.projectId === '..' ||
    typeof record.sequenceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(record.sequenceId) ||
    !Number.isSafeInteger(record.pinnedRevision) ||
    Number(record.pinnedRevision) < 0 ||
    !isSha256Digest(record.renderIrDigest) ||
    !isSha256Digest(record.backendCapabilitiesDigest) ||
    !isRenderRange(record.renderRange) ||
    (record.playbackMode !== 'source-fast-path' && record.playbackMode !== 'composed-proof') ||
    !['proof-frame', 'preview', 'h264-mp4', 'h265-mp4', 'prores-mov', 'ffv1-mkv', 'audio-aac', 'subtitles'].includes(String(record.renderKind)) ||
    (record.requestedRenderKind !== undefined &&
      !['h264-mp4', 'h265-mp4', 'prores-mov'].includes(String(record.requestedRenderKind))) ||
    (record.advancedSettingsDigest !== undefined && !isSha256Digest(record.advancedSettingsDigest)) ||
    (record.advancedCapabilitiesDigest !== undefined && !isSha256Digest(record.advancedCapabilitiesDigest)) ||
    (record.effectSemanticsDigest !== undefined && !isSha256Digest(record.effectSemanticsDigest)) ||
    (record.portableEquivalent !== undefined && typeof record.portableEquivalent !== 'boolean') ||
    !['none', 'burned', 'sidecar', 'both'].includes(String(record.captionMode)) ||
    (record.subtitleFormat !== 'srt' && record.subtitleFormat !== 'vtt') ||
    !['16:9', '9:16', '1:1'].includes(String(record.canvasPreset)) ||
    (record.proofFrame !== undefined &&
      (!Number.isSafeInteger(record.proofFrame) || Number(record.proofFrame) < 0)) ||
    (record.renderKind === 'proof-frame') !== (record.proofFrame !== undefined) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.expectedArtifacts) ||
    record.expectedArtifacts.length < 1 ||
    record.expectedArtifacts.length > 2
  ) {
    return undefined
  }
  const candidate = record as RenderRecord
  const expected = expectedArtifactsFromRenderRecordFields(candidate)
  if (
    !expected ||
    expected.length !== candidate.expectedArtifacts.length ||
    !expected.every((artifact, index) => {
      const actual = candidate.expectedArtifacts[index]
      return actual?.mediaKind === artifact.mediaKind && actual.mimeType === artifact.mimeType
    })
  ) {
    return undefined
  }
  return candidate
}

export function recoverRenderRecord(snapshot: JobSnapshot): RenderRecord | undefined {
  if (snapshot.kind !== 'media.ffmpeg' || snapshot.initiatingOperation !== 'media.startFfmpegJob') {
    return undefined
  }
  const artifacts = snapshot.result?.generatedArtifacts ?? []
  if (artifacts.length === 0) return undefined
  const fields = renderRecordFieldsFromArtifact(artifacts[0]!, snapshot)
  if (!fields) return undefined
  for (const artifact of artifacts.slice(1)) {
    const candidate = renderRecordFieldsFromArtifact(artifact, snapshot)
    if (!candidate || !sameRenderRecordFields(fields, candidate)) return undefined
  }
  const expectedArtifacts = expectedArtifactsFromRenderRecordFields(fields)
  if (!expectedArtifacts) return undefined
  return {
    schemaVersion: 1,
    jobId: snapshot.id,
    ...fields,
    expectedArtifacts,
    createdAt: snapshot.createdAt
  }
}

export function renderRecordFieldsFromArtifact(
  artifact: GeneratedArtifact,
  snapshot: JobSnapshot
): Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'> | undefined {
  if (
    artifact.ownerExtensionId !== snapshot.ownerExtensionId ||
    artifact.ownerExtensionVersion !== snapshot.ownerExtensionVersion ||
    artifact.workspaceId !== snapshot.workspaceId ||
    artifact.provenance.jobId !== snapshot.id ||
    artifact.provenance.operation !== snapshot.initiatingOperation ||
    !['image', 'video', 'audio', 'subtitle'].includes(artifact.mediaKind)
  ) return undefined
  const metadata = artifact.provenance.metadata
  if (!metadata) return undefined
  const projectId = metadata.projectId
  const sequenceId = metadata.sequenceId
  const pinnedRevision = metadata.pinnedRevision
  const renderIrDigest = metadata.renderIrDigest
  const backendCapabilitiesDigest = metadata.backendCapabilitiesDigest
  const renderRange = metadata.renderRange
  const playbackMode = metadata.playbackMode
  const renderKind = metadata.renderKind
  const requestedRenderKind = metadata.requestedRenderKind === null
    ? undefined
    : metadata.requestedRenderKind
  const advancedSettingsDigest = metadata.advancedSettingsDigest === null
    ? undefined
    : metadata.advancedSettingsDigest
  const advancedCapabilitiesDigest = metadata.advancedCapabilitiesDigest === null
    ? undefined
    : metadata.advancedCapabilitiesDigest
  const effectSemanticsDigest = metadata.effectSemanticsDigest === null
    ? undefined
    : metadata.effectSemanticsDigest
  const portableEquivalent = metadata.portableEquivalent === null
    ? undefined
    : metadata.portableEquivalent
  const captionMode = metadata.captionMode
  const subtitleFormat = metadata.subtitleFormat
  const canvasPreset = metadata.canvasPreset
  const proofFrame = metadata.proofFrame === null ? undefined : metadata.proofFrame
  if (
    typeof projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(projectId) ||
    typeof sequenceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(sequenceId) ||
    !Number.isSafeInteger(pinnedRevision) || Number(pinnedRevision) < 0 ||
    !isSha256Digest(renderIrDigest) ||
    !isSha256Digest(backendCapabilitiesDigest) ||
    !isRenderRange(renderRange) ||
    (playbackMode !== 'source-fast-path' && playbackMode !== 'composed-proof') ||
    !['proof-frame', 'preview', 'h264-mp4', 'h265-mp4', 'prores-mov', 'ffv1-mkv', 'audio-aac', 'subtitles'].includes(String(renderKind)) ||
    (requestedRenderKind !== undefined &&
      !['h264-mp4', 'h265-mp4', 'prores-mov'].includes(String(requestedRenderKind))) ||
    (advancedSettingsDigest !== undefined && !isSha256Digest(advancedSettingsDigest)) ||
    (advancedCapabilitiesDigest !== undefined && !isSha256Digest(advancedCapabilitiesDigest)) ||
    (effectSemanticsDigest !== undefined && !isSha256Digest(effectSemanticsDigest)) ||
    (portableEquivalent !== undefined && typeof portableEquivalent !== 'boolean') ||
    !['none', 'burned', 'sidecar', 'both'].includes(String(captionMode)) ||
    (subtitleFormat !== 'srt' && subtitleFormat !== 'vtt') ||
    !['16:9', '9:16', '1:1'].includes(String(canvasPreset)) ||
    (proofFrame !== undefined && (!Number.isSafeInteger(proofFrame) || Number(proofFrame) < 0)) ||
    (renderKind === 'proof-frame') !== (proofFrame !== undefined)
  ) return undefined
  return {
    projectId,
    sequenceId,
    pinnedRevision: Number(pinnedRevision),
    renderIrDigest,
    backendCapabilitiesDigest,
    renderRange,
    playbackMode,
    renderKind: renderKind as RenderKind,
    ...(requestedRenderKind === undefined ? {} : {
      requestedRenderKind: requestedRenderKind as RenderRecord['requestedRenderKind']
    }),
    ...(advancedSettingsDigest === undefined ? {} : { advancedSettingsDigest }),
    ...(advancedCapabilitiesDigest === undefined ? {} : { advancedCapabilitiesDigest }),
    ...(effectSemanticsDigest === undefined ? {} : { effectSemanticsDigest }),
    ...(portableEquivalent === undefined ? {} : { portableEquivalent }),
    captionMode: captionMode as RenderRecord['captionMode'],
    subtitleFormat,
    canvasPreset: canvasPreset as VideoProject['canvas']['preset'],
    ...(proofFrame !== undefined ? { proofFrame: Number(proofFrame) } : {})
  }
}

export function sameRenderRecordFields(
  left: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>,
  right: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>
): boolean {
  return left.projectId === right.projectId &&
    left.sequenceId === right.sequenceId &&
    left.pinnedRevision === right.pinnedRevision &&
    left.renderIrDigest === right.renderIrDigest &&
    left.backendCapabilitiesDigest === right.backendCapabilitiesDigest &&
    left.renderRange.startFrame === right.renderRange.startFrame &&
    left.renderRange.endFrame === right.renderRange.endFrame &&
    left.playbackMode === right.playbackMode &&
    left.renderKind === right.renderKind &&
    left.requestedRenderKind === right.requestedRenderKind &&
    left.advancedSettingsDigest === right.advancedSettingsDigest &&
    left.advancedCapabilitiesDigest === right.advancedCapabilitiesDigest &&
    left.effectSemanticsDigest === right.effectSemanticsDigest &&
    left.portableEquivalent === right.portableEquivalent &&
    left.captionMode === right.captionMode &&
    left.subtitleFormat === right.subtitleFormat &&
    left.canvasPreset === right.canvasPreset &&
    left.proofFrame === right.proofFrame
}

export function expectedArtifactsFromRenderRecordFields(
  fields: Omit<RenderRecord, 'schemaVersion' | 'jobId' | 'expectedArtifacts' | 'createdAt'>
): RenderRecord['expectedArtifacts'] | undefined {
  if (fields.renderKind === 'proof-frame') {
    if (fields.captionMode !== 'none' && fields.captionMode !== 'burned') return undefined
    return [{ mediaKind: 'image', mimeType: 'image/png' }]
  }
  if (fields.renderKind === 'preview') {
    if (fields.captionMode !== 'none' && fields.captionMode !== 'burned') return undefined
    return [{ mediaKind: 'video', mimeType: 'video/mp4' }]
  }
  if (fields.renderKind === 'audio-aac') {
    if (fields.captionMode !== 'none') return undefined
    return [{ mediaKind: 'audio', mimeType: 'audio/mp4' }]
  }
  if (fields.renderKind === 'subtitles') {
    if (fields.captionMode !== 'none') return undefined
    return [{
      mediaKind: 'subtitle',
      mimeType: fields.subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
    }]
  }
  const expected: RenderRecord['expectedArtifacts'] = []
  if (fields.captionMode === 'sidecar' || fields.captionMode === 'both') {
    expected.push({
      mediaKind: 'subtitle',
      mimeType: fields.subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt'
    })
  }
  expected.push({
    mediaKind: 'video',
    mimeType: fields.renderKind === 'prores-mov'
      ? 'video/quicktime'
      : fields.renderKind === 'ffv1-mkv'
        ? 'video/x-matroska'
        : 'video/mp4'
  })
  return expected
}

export function sameRenderTrackingRecord(left: RenderRecord, right: RenderRecord): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.createdAt === right.createdAt &&
    sameRenderRecordFields(left, right) &&
    left.expectedArtifacts.length === right.expectedArtifacts.length &&
    left.expectedArtifacts.every((expected, index) => {
      const candidate = right.expectedArtifacts[index]
      return candidate?.mediaKind === expected.mediaKind && candidate.mimeType === expected.mimeType
    })
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function isRenderRange(value: unknown): value is RenderRecord['renderRange'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const range = value as { startFrame?: unknown; endFrame?: unknown }
  return Number.isSafeInteger(range.startFrame) && Number(range.startFrame) >= 0 &&
    Number.isSafeInteger(range.endFrame) && Number(range.endFrame) > Number(range.startFrame)
}

export function sameRenderRange(value: unknown, expected: RenderRecord['renderRange']): boolean {
  return isRenderRange(value) &&
    value.startFrame === expected.startFrame &&
    value.endFrame === expected.endFrame
}

export function isTerminalJobState(state: JobSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
}

export function renderStatusSummary(snapshot: JobSnapshot, validated: boolean, stale: boolean): string {
  if (snapshot.state !== 'completed') return `Render job ${snapshot.id} is ${snapshot.state}.`
  if (!validated) return `Render job ${snapshot.id} completed but its output failed artifact validation.`
  return `Render job ${snapshot.id} completed with technical validation${stale ? '; its proof is stale for the current revision' : ''}. No visual inspection is implied.`
}

export function interactionRequired(error: unknown, continuation: string): JsonObject | undefined {
  const code = extensionApiErrorCode(error)
  if (code === undefined) return undefined
  if (!['INTERACTION_REQUIRED', 'HOST_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'].includes(code)) {
    return undefined
  }
  return {
    outcome: 'interaction-required',
    code: 'MEDIA_INTERACTION_REQUIRED',
    message: 'This operation requires a protected Kun desktop picker.',
    continuation
  }
}

export function extensionApiErrorCode(error: unknown): string | undefined {
  if (error instanceof ExtensionApiError) return error.code
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
