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
  boundedArray,
  boundedNumber,
  boundedPositiveInteger,
  boundedString,
  enumValue,
  exactKeys,
  nonNegativeInteger,
  stableId
} from './video-tools-input-support.js'
import { result } from './video-tools-projection-support.js'
export function strictSpeakerImportDocument(value: unknown): {
  identities: SpeakerIdentity[]
  turns: ImportedDiarizationTurn[]
  confidenceThreshold: number
  completeness: 'complete' | 'partial'
} {
  const document = asRecord(value, 'document')
  exactKeys(document, [
    'schemaVersion', 'adapterId', 'identities', 'turns', 'confidenceThreshold', 'completeness'
  ])
  if (document.schemaVersion !== 1) throw new ToolInputError('Speaker import document schemaVersion must be 1.')
  if (document.adapterId !== 'kun.imported-speaker-labels') {
    throw new ToolInputError('Speaker import document must use the registered kun.imported-speaker-labels adapter.')
  }
  const timestamp = new Date().toISOString()
  const identityIds = new Set<string>()
  const identities = boundedArray(document.identities, 'document.identities', 1, 256)
    .map((entry, index): SpeakerIdentity => {
      const identity = asRecord(entry, `document.identities[${index}]`)
      exactKeys(identity, ['id', 'label', 'aliases', 'sourceEvidenceIds'])
      const id = stableId(identity.id, `document.identities[${index}].id`)
      if (identityIds.has(id)) throw new ToolInputError(`Duplicate speaker identity: ${id}`)
      identityIds.add(id)
      return {
        id,
        label: boundedString(identity.label, `document.identities[${index}].label`, 1, 128),
        aliases: identity.aliases === undefined
          ? []
          : boundedArray(identity.aliases, `document.identities[${index}].aliases`, 0, 32)
            .map((alias, child) => boundedString(alias, `document.identities[${index}].aliases[${child}]`, 1, 128)),
        sourceEvidenceIds: identity.sourceEvidenceIds === undefined
          ? []
          : boundedArray(identity.sourceEvidenceIds, `document.identities[${index}].sourceEvidenceIds`, 0, 256)
            .map((idValue, child) => stableId(idValue, `document.identities[${index}].sourceEvidenceIds[${child}]`)),
        createdAt: timestamp,
        updatedAt: timestamp
      }
    })
  const turns = boundedArray(document.turns, 'document.turns', 1, 20_000)
    .map((entry, index): ImportedDiarizationTurn => {
      const turn = asRecord(entry, `document.turns[${index}]`)
      exactKeys(turn, [
        'id', 'startUs', 'endUs', 'status', 'speakerId', 'overlapSpeakerIds',
        'confidence', 'sourceEvidenceIds'
      ])
      const status = enumValue(turn.status, ['identified', 'unknown', 'overlap'] as const, `document.turns[${index}].status`)
      const overlapSpeakerIds = turn.overlapSpeakerIds === undefined
        ? undefined
        : boundedArray(turn.overlapSpeakerIds, `document.turns[${index}].overlapSpeakerIds`, 0, 8)
          .map((idValue, child) => stableId(idValue, `document.turns[${index}].overlapSpeakerIds[${child}]`))
      const sourceEvidenceIds = turn.sourceEvidenceIds === undefined
        ? undefined
        : boundedArray(turn.sourceEvidenceIds, `document.turns[${index}].sourceEvidenceIds`, 0, 32)
          .map((idValue, child) => stableId(idValue, `document.turns[${index}].sourceEvidenceIds[${child}]`))
      return {
        id: stableId(turn.id, `document.turns[${index}].id`),
        startUs: nonNegativeInteger(turn.startUs, `document.turns[${index}].startUs`),
        endUs: boundedPositiveInteger(turn.endUs, `document.turns[${index}].endUs`, 1, Number.MAX_SAFE_INTEGER),
        status,
        ...(turn.speakerId === undefined ? {} : {
          speakerId: stableId(turn.speakerId, `document.turns[${index}].speakerId`)
        }),
        ...(overlapSpeakerIds === undefined ? {} : { overlapSpeakerIds }),
        confidence: boundedNumber(turn.confidence, `document.turns[${index}].confidence`, 0, 1),
        ...(sourceEvidenceIds === undefined ? {} : { sourceEvidenceIds })
      }
    })
  return {
    identities,
    turns,
    confidenceThreshold: document.confidenceThreshold === undefined
      ? 0.7
      : boundedNumber(document.confidenceThreshold, 'document.confidenceThreshold', 0, 1),
    completeness: document.completeness === undefined
      ? 'complete'
      : enumValue(document.completeness, ['complete', 'partial'] as const, 'document.completeness')
  }
}

export function speakerAttributionPlanProjection(
  plan: ReturnType<typeof buildSpeakerAttributionPlan>
): JsonObject {
  const values = [...plan.transcriptSegments, ...plan.captions]
  return {
    schemaVersion: 1,
    analysisId: plan.analysisId,
    transcriptSegmentCount: plan.transcriptSegments.length,
    captionCount: plan.captions.length,
    identifiedCount: values.filter(({ status }) => status === 'identified').length,
    uncertainCount: values.filter(({ status }) => status !== 'identified').length,
    warnings: plan.warnings.slice(0, 100)
  }
}

export function analysisRecordSummary(record: IntelligenceRecord, project?: VideoProject): JsonObject {
  if ('adapter' in record && record.id.startsWith('visual-index:')) {
    return {
      schemaVersion: 1,
      id: record.id,
      kind: 'visual-index',
      assetId: record.assetId,
      completeness: record.completeness,
      indexedSampleCount: record.indexedSampleCount,
      plannedSampleCount: record.plannedSampleCount,
      omittedSampleCount: record.omittedSampleCount,
      adapterId: record.adapter.id,
      adapterVersion: record.adapter.version,
      modelId: record.adapter.modelId,
      modelVersion: record.adapter.modelVersion,
      packageId: record.adapter.packageId,
      manifestSha256: record.adapter.manifestSha256,
      intervalUs: record.parameters.intervalUs,
      maxFrames: record.parameters.maxFrames,
      samplingStrategy: record.parameters.samplingStrategy,
      immutable: true
    }
  }
  if (hasAnalysisKind(record, 'vad')) {
    return {
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      assetId: record.assetId,
      completeness: record.completeness,
      silenceCount: record.silence.length,
      safeSuggestionCount: record.silence.filter(({ disposition }) => disposition === 'safe-to-suggest').length,
      suggestionConfidenceThreshold: record.suggestionConfidenceThreshold,
      provenance: record.provenance as unknown as JsonObject,
      immutable: true
    }
  }
  if (hasAnalysisKind(record, 'beat-grid')) {
    const allSnapTargets = project ? beatSnapTargets(project, record) : []
    const snapTargets = allSnapTargets
      .slice(0, 4_096)
      .map(({ id, frame, kind, confidence }) => ({
        id: `beat-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`,
        frame,
        kind,
        confidence
      }))
    return {
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      assetId: record.assetId,
      completeness: record.completeness,
      markerCount: record.markers.length,
      snapTargets,
      snapTargetsTruncated: allSnapTargets.length > snapTargets.length,
      ...(record.tempoBpm === undefined ? {} : { tempoBpm: record.tempoBpm }),
      provenance: record.provenance as unknown as JsonObject,
      immutable: true
    }
  }
  if (hasAnalysisKind(record, 'denoise-metadata')) {
    return {
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      assetId: record.assetId,
      completeness: record.completeness,
      status: record.status,
      confidence: record.confidence,
      confidenceThreshold: record.confidenceThreshold,
      noiseProfile: record.noiseProfile as unknown as JsonObject,
      recommendation: record.recommendation as unknown as JsonObject,
      metadataOnly: true,
      provenance: record.provenance as unknown as JsonObject,
      immutable: true
    }
  }
  if (hasAnalysisKind(record, 'speaker-diarization')) {
    return {
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      assetId: record.assetId,
      completeness: record.completeness,
      turnCount: record.turns.length,
      identifiedTurnCount: record.turns.filter(({ uncertain, speakerId }) => !uncertain && speakerId).length,
      uncertainTurnCount: record.uncertainTurnCount,
      provenance: record.provenance as unknown as JsonObject,
      immutable: true
    }
  }
  if (hasAnalysisKind(record, 'audio-sync')) {
    return {
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      referenceAssetId: record.referenceAssetId,
      targetAssetId: record.targetAssetId,
      seed: record.seed,
      proposedTargetDeltaUs: record.proposedTargetDeltaUs,
      confidence: record.confidence,
      separation: record.separation,
      threshold: record.threshold,
      minimumSeparation: record.minimumSeparation,
      outcome: record.outcome,
      ...(record.refusalReason ? { refusalReason: record.refusalReason } : {}),
      provenance: record.provenance as unknown as JsonObject,
      immutable: true
    }
  }
  return {
    schemaVersion: 1,
    id: record.id,
    kind: 'speaker-diarization',
    immutable: true
  }
}

export function assertAnalysisSourcesCurrent(
  project: VideoProject,
  record: Extract<IntelligenceRecord, {
    kind: 'vad' | 'speaker-diarization' | 'beat-grid' | 'denoise-metadata' | 'audio-sync'
  }>
): void {
  if (record.kind !== 'audio-sync') {
    const asset = project.assets.find(({ id }) => id === record.assetId)
    if (!asset) throw new ToolInputError(`Analysis source asset no longer exists: ${record.assetId}`)
    if (
      asset.sourceIdentity?.algorithm === 'sha256' &&
      asset.sourceIdentity.value !== record.provenance.sourceFingerprint.value
    ) {
      throw new VideoEngineError(
        'invalid_operation',
        'Cached analysis evidence belongs to an older source identity; run the analysis again.'
      )
    }
    return
  }
  const reference = project.assets.find(({ id }) => id === record.referenceAssetId)
  const target = project.assets.find(({ id }) => id === record.targetAssetId)
  if (!reference || !target) {
    throw new ToolInputError('Audio synchronization source assets no longer exist.')
  }
  if (
    reference.sourceIdentity?.algorithm !== 'sha256' ||
    target.sourceIdentity?.algorithm !== 'sha256'
  ) return
  const combined = combineAudioSourceFingerprints(reference.sourceIdentity, target.sourceIdentity)
  if (combined.value !== record.provenance.sourceFingerprint.value) {
    throw new VideoEngineError(
      'invalid_operation',
      'Cached synchronization evidence belongs to older source identities; preview synchronization again.'
    )
  }
}

export function hasAnalysisKind<K extends 'vad' | 'speaker-diarization' | 'beat-grid' | 'denoise-metadata' | 'audio-sync'>(
  record: IntelligenceRecord,
  kind: K
): record is Extract<IntelligenceRecord, { kind: K }> {
  return !record.id.startsWith('visual-index:') &&
    'kind' in record &&
    record.kind === kind
}

export function analysisToolResult<T extends IntelligenceRecord>(
  project: VideoProject,
  outcome: AnalysisOutcome<T>,
  label: string
): ToolResult {
  if (outcome.outcome === 'ready') {
    const evidence = readMediaIntelligenceEvidence(outcome.record, { limit: 200 })
    return result({
      outcome: 'ready',
      projectId: project.id,
      currentRevision: project.currentRevision,
      operationId: outcome.operationId,
      deduplicated: outcome.deduplicated,
      record: analysisRecordSummary(outcome.record, project),
      evidence: evidence as unknown as JsonObject
    }, `${label} evidence is ready${outcome.deduplicated ? ' from the immutable local cache' : ''}`)
  }
  if (outcome.outcome === 'unavailable') {
    return result({
      outcome: 'unavailable',
      projectId: project.id,
      currentRevision: project.currentRevision,
      code: outcome.code,
      remediation: outcome.remediation,
      local: true,
      networkUsed: false
    }, `${label} analysis is unavailable; no evidence was fabricated`)
  }
  if (outcome.outcome === 'cancelled') {
    return result({
      outcome: 'cancelled',
      projectId: project.id,
      currentRevision: project.currentRevision,
      operationId: outcome.operationId
    }, `${label} analysis was cancelled`)
  }
  return result({
    outcome: 'failed',
    projectId: project.id,
    currentRevision: project.currentRevision,
    operationId: outcome.operationId,
    error: outcome.error as unknown as JsonObject
  }, `${label} analysis failed`)
}

export function publicEngineError(error: VideoEngineError, operation: string): ExtensionApiError {
  const conflict = error.code === 'revision_conflict' || error.code === 'script_stale'
  const safeDetails: JsonObject = { engineCode: error.code }
  for (const key of [
    'expectedRevision',
    'currentRevision',
    'scriptRevision',
    'expectedGeneration',
    'currentGeneration'
  ] as const) {
    const value = error.details[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) safeDetails[key] = value
  }
  return new ExtensionApiError({
    code: conflict ? 'CONFLICT' : error.code === 'project_not_found' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
    message: error.message,
    operation,
    retryable: conflict,
    details: safeDetails
  })
}
