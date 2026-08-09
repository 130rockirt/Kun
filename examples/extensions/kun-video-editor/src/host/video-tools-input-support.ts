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
import { result } from './video-tools-projection-support.js'
export function assertExpectedRevision(project: VideoProject, expectedRevision: number): void {
  if (project.currentRevision !== expectedRevision) {
    throw new VideoEngineError('revision_conflict', 'Project revision has changed', {
      expectedRevision,
      currentRevision: project.currentRevision
    })
  }
}

export function assertNotCancelled(invocation: ToolInvocationContext): void {
  if (invocation.cancellation.isCancellationRequested) {
    throw new ExtensionApiError({
      code: 'CANCELLED',
      message: 'The video tool invocation was cancelled.',
      operation: invocation.invocation.toolId,
      retryable: false
    })
  }
}

export function asRecord(value: unknown, label: string): ToolInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError(`${label} input must be an object.`)
  }
  return value as ToolInput
}

export function exactKeys(input: ToolInput, keys: readonly string[]): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(input).find((key) => !allowed.has(key))
  if (unexpected) throw new ToolInputError(`Unexpected input field: ${unexpected}`)
}

export function boundedPublicErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message
    ? error.message
    : 'The multicam program is not ready for canonical rendering.'
  return message.slice(0, 512)
}

export function stableId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new ToolInputError(`${label} must be a bounded stable identifier.`)
  }
  return value
}

export function opaqueHandle(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new ToolInputError(`${label} must be an opaque Host-granted media handle.`)
  }
  return value
}

export function generationOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value)
  ) {
    throw new ToolInputError(`${label} must be a bounded opaque generation identifier.`)
  }
  return value
}

export function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new ToolInputError(`${label} must contain ${minimum}-${maximum} characters.`)
  }
  return value
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ToolInputError(`${label} must be a non-negative safe integer.`)
  }
  return Number(value)
}

export function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed === 0) throw new ToolInputError(`${label} must be a positive safe integer.`)
  return parsed
}

export function boundedPositiveInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = positiveInteger(value, label)
  if (parsed < minimum || parsed > maximum) {
    throw new ToolInputError(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ToolInputError(`${label} must be a boolean.`)
  return value
}

export function stableIdArray(value: unknown, label: string): string[] {
  return [...new Set(boundedArray(value, label, 0, 200)
    .map((entry, index) => stableId(entry, `${label}[${index}]`)))]
}

export function selectionRange(value: unknown): { startFrame: number; endFrame: number } | undefined {
  if (value === null) return undefined
  const range = asRecord(value, 'range')
  exactKeys(range, ['startFrame', 'endFrame'])
  const startFrame = nonNegativeInteger(range.startFrame, 'range.startFrame')
  const endFrame = nonNegativeInteger(range.endFrame, 'range.endFrame')
  if (endFrame <= startFrame) throw new ToolInputError('Selection range must be a non-empty half-open interval.')
  return { startFrame, endFrame }
}

export function agentActorId(invocation?: ToolInvocationContext): string {
  return invocation?.invocation.runId ?? invocation?.invocation.threadId ?? 'kun-agent'
}

export function assertTimedTranscriptEvidence(
  project: VideoProject,
  ranges: readonly AssetTimeRange[]
): void {
  for (const range of ranges) {
    const asset = project.assets.find(({ id }) => id === range.assetId)
    if (!asset) throw new ToolInputError(`Destructive range refers to missing asset ${range.assetId}.`)
    if (range.endUs > asset.durationUs) {
      throw new ToolInputError(`Destructive range exceeds source duration for asset ${range.assetId}.`)
    }
    const transcriptIds = new Set(asset.transcriptIds)
    const intervals = project.transcripts
      .filter(({ id, assetId }) => assetId === asset.id && transcriptIds.has(id))
      .flatMap(({ segments }) => segments.map(({ startUs, endUs }) => ({ startUs, endUs })))
      .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs)
    let cursor = range.startUs
    for (const interval of intervals) {
      if (interval.endUs <= cursor) continue
      if (interval.startUs > cursor) break
      cursor = Math.max(cursor, interval.endUs)
      if (cursor >= range.endUs) break
    }
    if (cursor < range.endUs) {
      throw new ToolInputError(
        `Destructive Agent edit for asset ${range.assetId} lacks continuous timed transcript evidence. ` +
        'Import or generate a timed transcript, refresh inspection, or request explicit user guidance.'
      )
    }
  }
}

export function mutationResult(
  outcome: string,
  receipt: MutationReceipt,
  project: VideoProject,
  summary: string
): ToolResult {
  return result({
    outcome,
    projectId: project.id,
    sequenceId: project.activeSequenceId,
    previousRevision: receipt.previousRevision,
    currentRevision: receipt.newRevision,
    generation: receipt.generation,
    changedIds: [...receipt.createdIds, ...receipt.changedIds, ...receipt.removedIds]
      .map(({ id }) => id),
    receipt: receipt as unknown as JsonObject
  }, summary)
}

export function rational(value: unknown, label: string): { numerator: number; denominator: number } {
  const object = asRecord(value, label)
  exactKeys(object, ['numerator', 'denominator'])
  const numerator = nonNegativeInteger(object.numerator, `${label}.numerator`)
  const denominator = nonNegativeInteger(object.denominator, `${label}.denominator`)
  if (numerator === 0 || denominator === 0) throw new ToolInputError(`${label} values must be positive.`)
  return { numerator, denominator }
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ToolInputError(`${label} contains an unsupported value.`)
  }
  return value as T[number]
}

export function boundedArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ToolInputError(`${label} must contain ${minimum}-${maximum} entries.`)
  }
  return value
}

export function assetRange(value: unknown): AssetTimeRange {
  const range = asRecord(value, 'range')
  exactKeys(range, ['assetId', 'startUs', 'endUs', 'reason'])
  const startUs = nonNegativeInteger(range.startUs, 'range.startUs')
  const endUs = nonNegativeInteger(range.endUs, 'range.endUs')
  if (endUs <= startUs) throw new ToolInputError('A transcript edit range must have positive duration.')
  return {
    assetId: stableId(range.assetId, 'range.assetId'),
    startUs,
    endUs,
    ...(range.reason === undefined
      ? {}
      : { reason: enumValue(range.reason, ['filler', 'silence', 'selection'] as const, 'range.reason') })
  }
}

export function transcriptSegmentInput(value: unknown): JsonObject {
  const segment = asRecord(value, 'segment')
  exactKeys(segment, ['id', 'startUs', 'endUs', 'text', 'words'])
  const startUs = nonNegativeInteger(segment.startUs, 'segment.startUs')
  const endUs = nonNegativeInteger(segment.endUs, 'segment.endUs')
  if (endUs <= startUs) throw new ToolInputError('Transcript segments must have positive duration.')
  const words = segment.words === undefined
    ? undefined
    : boundedArray(segment.words, 'segment.words', 0, 20_000).map((value): JsonObject => {
        const word = asRecord(value, 'word')
        exactKeys(word, ['id', 'startUs', 'endUs', 'text', 'confidence'])
        const wordStart = nonNegativeInteger(word.startUs, 'word.startUs')
        const wordEnd = nonNegativeInteger(word.endUs, 'word.endUs')
        if (wordEnd <= wordStart) throw new ToolInputError('Transcript words must have positive duration.')
        return {
          id: stableId(word.id, 'word.id'),
          startUs: wordStart,
          endUs: wordEnd,
          text: boundedString(word.text, 'word.text', 1, 1024),
          ...(word.confidence === undefined
            ? {}
            : { confidence: boundedNumber(word.confidence, 'word.confidence', 0, 1) })
        }
      })
  return {
    id: stableId(segment.id, 'segment.id'),
    startUs,
    endUs,
    text: boundedString(segment.text, 'segment.text', 1, 16_384),
    ...(words === undefined ? {} : { words })
  }
}

export function captionBuildStyle(value: unknown): NonNullable<CaptionBuildOptions['style']> {
  const style = asRecord(value, 'style')
  exactKeys(style, ['fontSize', 'color', 'background', 'fontFamily', 'fontWeight', 'maxWidthRatio'])
  return {
    ...(style.fontSize === undefined ? {} : { fontSize: boundedNumber(style.fontSize, 'style.fontSize', 8, 256) }),
    ...(style.color === undefined ? {} : { color: captionColor(style.color, 'style.color') }),
    ...(style.background === undefined ? {} : { background: captionColor(style.background, 'style.background') }),
    ...(style.fontFamily === undefined
      ? {}
      : { fontFamily: boundedString(style.fontFamily, 'style.fontFamily', 1, 128) }),
    ...(style.fontWeight === undefined
      ? {}
      : { fontWeight: boundedNumber(style.fontWeight, 'style.fontWeight', 100, 900) }),
    ...(style.maxWidthRatio === undefined
      ? {}
      : { maxWidthRatio: boundedNumber(style.maxWidthRatio, 'style.maxWidthRatio', 0.1, 1) })
  }
}

export function captionBuildAnimation(value: unknown): NonNullable<CaptionBuildOptions['animation']> {
  const animation = asRecord(value, 'animation')
  exactKeys(animation, ['kind', 'durationFrames'])
  return {
    kind: enumValue(animation.kind, ['none', 'fade', 'word-highlight'] as const, 'animation.kind'),
    ...(animation.durationFrames === undefined
      ? {}
      : { durationFrames: nonNegativeInteger(animation.durationFrames, 'animation.durationFrames') })
  }
}

export function captionColor(value: unknown, label: string): string {
  const color = boundedString(value, label, 7, 7)
  if (!/^#[0-9A-Fa-f]{6}$/u.test(color)) throw new ToolInputError(`${label} must be a six-digit hexadecimal color.`)
  return color
}

export function previewSource(value: unknown): PreviewSource {
  const source = asRecord(value, 'source')
  const kind = enumValue(source.kind, ['asset', 'timeline', 'generated'] as const, 'source.kind')
  if (kind === 'asset') {
    exactKeys(source, ['kind', 'assetId', 'startUs', 'endUs'])
    const startUs = nonNegativeInteger(source.startUs, 'source.startUs')
    const endUs = positiveInteger(source.endUs, 'source.endUs')
    if (endUs <= startUs) throw new ToolInputError('Preview source range must be non-empty.')
    return { kind, assetId: stableId(source.assetId, 'source.assetId'), startUs, endUs }
  }
  if (kind === 'timeline') {
    exactKeys(source, ['kind', 'sequenceId', 'revision', 'startFrame', 'endFrame', 'artifactId'])
    const startFrame = nonNegativeInteger(source.startFrame, 'source.startFrame')
    const endFrame = positiveInteger(source.endFrame, 'source.endFrame')
    if (endFrame <= startFrame) throw new ToolInputError('Preview timeline range must be non-empty.')
    return {
      kind,
      sequenceId: stableId(source.sequenceId, 'source.sequenceId'),
      revision: nonNegativeInteger(source.revision, 'source.revision'),
      startFrame,
      endFrame,
      ...(source.artifactId === undefined ? {} : { artifactId: stableId(source.artifactId, 'source.artifactId') })
    }
  }
  exactKeys(source, ['kind', 'assetId', 'jobId', 'variantIndex'])
  return {
    kind,
    assetId: stableId(source.assetId, 'source.assetId'),
    jobId: stableId(source.jobId, 'source.jobId'),
    variantIndex: nonNegativeInteger(source.variantIndex, 'source.variantIndex')
  }
}

export function assertPreviewSource(project: VideoProject, source: PreviewSource): void {
  if (source.kind === 'timeline') {
    const sequence = project.sequences.find(({ id }) => id === source.sequenceId)
    if (!sequence) throw new ToolInputError(`Preview sequence does not exist: ${source.sequenceId}`)
    if (source.revision > project.currentRevision) {
      throw new ToolInputError('Preview source revision cannot be newer than the project.')
    }
    if (source.endFrame > sequenceDurationFrames(sequence)) {
      throw new ToolInputError('Preview timeline range exceeds the sequence duration.')
    }
    return
  }
  const asset = project.assets.find(({ id }) => id === source.assetId)
  if (!asset) throw new ToolInputError(`Preview asset does not exist: ${source.assetId}`)
  if (source.kind === 'asset' && source.endUs > asset.durationUs) {
    throw new ToolInputError('Preview source range exceeds the asset duration.')
  }
  if (source.kind === 'generated' && asset.generatedLineage?.jobId !== source.jobId) {
    throw new ToolInputError('Generated preview lineage does not match the selected asset.')
  }
}

export function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return value
}
