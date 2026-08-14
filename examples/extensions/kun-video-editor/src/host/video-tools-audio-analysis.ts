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
import { agentActorId, analysisIdentifier, analysisRecordSummary, analysisToolResult, asRecord, assertAgentMulticamSyncAuthority, assertAnalysisSourcesCurrent, assertExpectedRevision, assertNotCancelled, assertPreviewSource, assertTimedTranscriptEvidence, assetFromProbe, assetProjection, assetRange, boundedArray, boundedNumber, boundedPositiveInteger, boundedPublicErrorMessage, boundedString, captionBuildAnimation, captionBuildStyle, captionColor, enumValue, exactKeys, expectedArtifactsFromRenderRecordFields, extensionApiErrorCode, extensionOf, ffmpegRenderBackendCapabilities, generatedAssetFromMaterialization, generatedAssetSummary, generationOpaqueId, hasAnalysisKind, inferredImageAssetKind, initialItem, interactionRequired, interactivePlaybackProjection, interchangeMappingPreview, interchangeProjectSummary, isRenderRange, isRequestedFinalVideoKind, isSha256Digest, isTerminalJobState, jobReferenceProjection, matchesRenderedVideoTarget, multicamGroupProjection, mutationResult, nonNegativeInteger, normalizeRotation, opaqueHandle, optionalBoolean, otioExportJobProjection, otioExportKey, packageAssetIds, packageMissingPolicy, positiveInteger, previewEntryId, previewSource, probeProjection, professionalRenderSettings, projectPackageJobProjection, projectPackageKey, projectProjection, projectProjectionIsTruncated, publicEngineError, rational, recoverRenderRecord, renderFileName, renderFilter, renderKey, renderRecordFieldsFromArtifact, renderStatusSummary, result, safeInterchangeDisplayName, safeInterchangeName, safeProjectPackageName, sameGeneratedMaterialization, sameRenderRange, sameRenderRecordFields, sameRenderTrackingRecord, selectionRange, sha256Digest, speakerAttributionPlanProjection, stableId, stableIdArray, storedInterchangeLossManifest, storedOtioExportRecord, storedProjectPackageRecord, storedRenderRecord, strictCaption, strictCaptionDetails, strictCaptionPatch, strictEffects, strictKeyframeTracks, strictLinkGroup, strictSpeakerImportDocument, strictTimelineItem, strictTimelineOperation, strictTransform, strictTransformPatch, suggestedImportProjectId, textRenderBackendCapabilities, transcriptProjection, transcriptSegmentInput, validOtioArtifacts } from './video-tools-support.js'
import { VideoEditorToolsDerived } from './video-tools-derived.js'

export class VideoEditorToolsAudioAnalysis extends VideoEditorToolsDerived {
  protected async videoAnalyzeAudio(
    input: ToolInput,
    author: RevisionAuthor = 'agent',
    invocation?: ToolInvocationContext
  ): Promise<ToolResult> {
    const action = enumValue(
      input.action,
      [
        'vad', 'vad-apply', 'speaker', 'speaker-import', 'speaker-attribution-preview',
        'speaker-attribution-apply', 'beat-grid', 'denoise-metadata', 'sync-preview', 'sync-apply'
      ] as const,
      'action'
    )
    exactKeys(input, [
      'action', 'projectId', 'expectedRevision', 'assetId', 'referenceAssetId', 'targetAssetId',
      'referenceItemId', 'targetItemId', 'analysisId', 'seed', 'maximumOffsetUs', 'threshold',
      'minimumSeparation', 'confidenceThreshold', 'document'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)

    if (action === 'speaker') {
      const adapters = this.intelligenceService().speakerAdapters()
      const local = adapters.find(({ descriptor }) => descriptor.execution === 'local-model')
      if (!local || local.outcome !== 'ready') {
        return result({
          outcome: 'unavailable',
          projectId,
          currentRevision: project.currentRevision,
          code: local?.code ?? 'speaker_inference_broker_unavailable',
          remediation: local?.remediation ?? 'This Kun build has no approved local speaker inference broker.',
          adapters: adapters as unknown as JsonValue,
          importAvailable: adapters.some(({ descriptor, outcome }) =>
            descriptor.execution === 'import' && outcome === 'ready'),
          local: true,
          networkUsed: false
        }, 'Local speaker diarization is unavailable; no speaker identity or turn was fabricated')
      }
      return result({
        outcome: 'unavailable',
        projectId,
        currentRevision: project.currentRevision,
        code: 'speaker_registry_enrollment_required',
        remediation: 'A verified local speaker model is present, but this project has no brokered enrollment workflow. Import reviewed speaker evidence instead.',
        adapters: adapters as unknown as JsonValue,
        local: true,
        networkUsed: false
      }, 'Speaker inference requires reviewed identity enrollment; no identity was guessed')
    }

    if (action === 'speaker-import') {
      if (author !== 'manual') {
        throw new ToolInputError('Speaker evidence import requires an explicit right-sidebar user action.')
      }
      const imported = strictSpeakerImportDocument(input.document)
      const cancellation = new AbortController()
      const cancellationSubscription = invocation?.cancellation.onCancellationRequested(() => cancellation.abort())
      try {
        if (invocation?.cancellation.isCancellationRequested) cancellation.abort()
        const outcome = await this.intelligenceService().importSpeakerEvidence({
          project,
          assetId: stableId(input.assetId, 'assetId'),
          identities: imported.identities,
          turns: imported.turns,
          confidenceThreshold: imported.confidenceThreshold,
          completeness: imported.completeness,
          signal: cancellation.signal
        })
        if (outcome.outcome !== 'ready') return analysisToolResult(project, outcome, 'speaker diarization import')
        const evidence = readMediaIntelligenceEvidence(outcome.record, { limit: 200 })
        return result({
          outcome: 'ready',
          projectId,
          currentRevision: project.currentRevision,
          operationId: outcome.operationId,
          deduplicated: outcome.deduplicated,
          record: analysisRecordSummary(outcome.record, project),
          evidence: evidence as unknown as JsonObject,
          identities: await this.intelligenceService().listSpeakerIdentities(projectId) as unknown as JsonValue
        }, `Imported ${outcome.record.turns.length} reviewed speaker turns without reading a path or running inference`)
      } finally {
        await cancellationSubscription?.dispose()
      }
    }

    if (action === 'speaker-attribution-preview' || action === 'speaker-attribution-apply') {
      const record = await this.requiredAnalysisRecord(project, input.analysisId, 'speaker-diarization')
      const plan = buildSpeakerAttributionPlan(project, record)
      const projection = speakerAttributionPlanProjection(plan)
      if (action === 'speaker-attribution-preview') {
        return result({
          outcome: 'preview',
          projectId,
          currentRevision: project.currentRevision,
          plan: projection,
          transcriptSegments: plan.transcriptSegments.slice(0, 200) as unknown as JsonValue,
          captions: plan.captions.slice(0, 100) as unknown as JsonValue,
          truncated: plan.transcriptSegments.length > 200 || plan.captions.length > 100
        }, `Previewed ${plan.transcriptSegments.length} transcript and ${plan.captions.length} caption speaker attributions`)
      }
      if (plan.transcriptSegments.length === 0 && plan.captions.length === 0) {
        return result({
          outcome: 'refused',
          code: 'SPEAKER_ATTRIBUTION_NO_OVERLAP',
          projectId,
          currentRevision: project.currentRevision,
          analysisId: record.id
        }, 'No transcript or caption range overlaps this speaker evidence; no project change was made')
      }
      const applied = applySpeakerAttributionPlan(project, plan)
      const committed = await this.service().saveProjectWithReceipt(applied.project, expectedRevision, {
        author,
        ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
        sourceOperation: 'audio-analysis.speaker-attribution-apply',
        summary: `Applied reviewed speaker attribution ${record.id}`
      })
      await this.publishProjectChange(committed.project, 'speaker-attribution-applied', committed.receipt)
      return result({
        outcome: 'applied',
        projectId,
        previousRevision: expectedRevision,
        currentRevision: committed.project.currentRevision,
        analysisId: record.id,
        plan: projection,
        applied: {
          transcriptSegments: applied.attributedTranscriptSegmentCount,
          captions: applied.attributedCaptionCount,
          identified: applied.identifiedCount,
          uncertain: applied.uncertainCount
        },
        receipt: committed.receipt as unknown as JsonObject
      }, `Applied speaker attribution; ${applied.uncertainCount} unknown, overlapping, or uncertain targets remain explicitly unlabelled`)
    }

    if (action === 'vad-apply') {
      const record = await this.requiredAnalysisRecord(project, input.analysisId, 'vad')
      const ranges = record.silence
        .filter(({ disposition, confidence }) =>
          disposition === 'safe-to-suggest' && confidence >= record.suggestionConfidenceThreshold
        )
        .map(({ sourceRange }) => ({ ...sourceRange, reason: 'silence' as const }))
      if (ranges.length === 0) {
        return result({
          outcome: 'refused',
          code: 'VAD_CONFIDENCE_BELOW_THRESHOLD',
          projectId,
          currentRevision: project.currentRevision,
          analysisId: record.id,
          threshold: record.suggestionConfidenceThreshold,
          message: 'No silence suggestion reached the declared confidence threshold; no timeline change was made.'
        }, 'Refused low-confidence silence removal')
      }
      const preview = applyTimelineScript(project, generateTimelineMarkdown(project), ranges)
      const committed = await this.service().saveProjectWithReceipt(preview.project, expectedRevision, {
        author,
        ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
        sourceOperation: 'audio-analysis.vad-apply',
        summary: `Removed ${ranges.length} confidence-qualified silence ranges`
      })
      await this.publishProjectChange(committed.project, 'vad-silence-applied', committed.receipt)
      return result({
        outcome: 'applied',
        projectId,
        previousRevision: expectedRevision,
        currentRevision: committed.project.currentRevision,
        analysisId: record.id,
        appliedRangeCount: ranges.length,
        threshold: record.suggestionConfidenceThreshold,
        receipt: committed.receipt as unknown as JsonObject
      }, `Applied ${ranges.length} confidence-qualified silence ranges transactionally`)
    }

    if (action === 'sync-apply') {
      const record = await this.requiredAnalysisRecord(project, input.analysisId, 'audio-sync')
      const referenceItemId = stableId(input.referenceItemId, 'referenceItemId')
      const targetItemId = stableId(input.targetItemId, 'targetItemId')
      const plan = planAudioSynchronization(project, referenceItemId, targetItemId, record)
      if (plan.outcome !== 'ready' || !plan.operation) {
        return result({
          outcome: 'refused',
          code: 'AUDIO_SYNC_UNCERTAIN',
          projectId,
          currentRevision: project.currentRevision,
          analysisId: record.id,
          preview: plan as unknown as JsonObject,
          message: 'Audio synchronization confidence or separation is insufficient; no clip was moved.'
        }, 'Refused uncertain audio synchronization without changing the timeline')
      }
      const committed = await this.service().applyOperationsWithReceipt(
        projectId,
        expectedRevision,
        [plan.operation],
        {
          author,
          ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
          sourceOperation: 'audio-analysis.sync-apply',
          summary: `Applied confidence-qualified audio synchronization ${record.id}`
        }
      )
      await this.publishProjectChange(committed.project, 'audio-sync-applied', committed.receipt)
      return result({
        outcome: 'applied',
        projectId,
        previousRevision: expectedRevision,
        currentRevision: committed.project.currentRevision,
        analysisId: record.id,
        preview: plan as unknown as JsonObject,
        receipt: committed.receipt as unknown as JsonObject
      }, `Moved the target clip by ${plan.deltaFrames} frames using confidence-qualified sync evidence`)
    }

    const cancellation = new AbortController()
    const cancellationSubscription = invocation?.cancellation.onCancellationRequested(() => cancellation.abort())
    try {
      if (invocation?.cancellation.isCancellationRequested) cancellation.abort()
      if (action === 'vad') {
        const outcome = await this.intelligenceService().analyzeVad({
          project,
          assetId: stableId(input.assetId, 'assetId'),
          signal: cancellation.signal
        })
        return analysisToolResult(project, outcome, 'VAD/silence')
      }
      if (action === 'beat-grid') {
        const outcome = await this.intelligenceService().analyzeBeats({
          project,
          assetId: stableId(input.assetId, 'assetId'),
          signal: cancellation.signal
        })
        return analysisToolResult(project, outcome, 'beat/downbeat')
      }
      if (action === 'denoise-metadata') {
        const outcome = await this.intelligenceService().analyzeDenoiseMetadata({
          project,
          assetId: stableId(input.assetId, 'assetId'),
          ...(input.confidenceThreshold === undefined ? {} : {
            confidenceThreshold: boundedNumber(input.confidenceThreshold, 'confidenceThreshold', 0, 1)
          }),
          signal: cancellation.signal
        })
        return analysisToolResult(project, outcome, 'denoise metadata')
      }
      const referenceAssetId = stableId(input.referenceAssetId, 'referenceAssetId')
      const targetAssetId = stableId(input.targetAssetId, 'targetAssetId')
      const referenceItemId = stableId(input.referenceItemId, 'referenceItemId')
      const targetItemId = stableId(input.targetItemId, 'targetItemId')
      const outcome = await this.intelligenceService().analyzeSync({
        project,
        referenceAssetId,
        targetAssetId,
        seed: nonNegativeInteger(input.seed, 'seed'),
        maximumOffsetUs: input.maximumOffsetUs === undefined
          ? 10_000_000
          : nonNegativeInteger(input.maximumOffsetUs, 'maximumOffsetUs'),
        ...(input.threshold === undefined ? {} : {
          threshold: boundedNumber(input.threshold, 'threshold', 0, 1)
        }),
        ...(input.minimumSeparation === undefined ? {} : {
          minimumSeparation: boundedNumber(input.minimumSeparation, 'minimumSeparation', 0, 1)
        }),
        signal: cancellation.signal
      })
      if (outcome.outcome !== 'ready') return analysisToolResult(project, outcome, 'audio synchronization')
      const preview = planAudioSynchronization(project, referenceItemId, targetItemId, outcome.record)
      return result({
        outcome: preview.outcome === 'ready' ? 'ready' : 'uncertain',
        projectId,
        currentRevision: project.currentRevision,
        operationId: outcome.operationId,
        deduplicated: outcome.deduplicated,
        record: analysisRecordSummary(outcome.record, project),
        preview: preview as unknown as JsonObject,
        evidence: readMediaIntelligenceEvidence(outcome.record, { limit: 1 }) as unknown as JsonObject
      }, preview.outcome === 'ready'
        ? `Previewed a ${preview.deltaFrames}-frame audio synchronization move; apply requires a separate revision-fenced transaction`
        : 'Audio synchronization is uncertain; no clip was moved')
    } finally {
      await cancellationSubscription?.dispose()
    }
  }

  protected async requiredAnalysisRecord<K extends 'vad' | 'speaker-diarization' | 'beat-grid' | 'denoise-metadata' | 'audio-sync'>(
    project: VideoProject,
    value: unknown,
    kind: K
  ): Promise<Extract<IntelligenceRecord, { kind: K }>> {
    const analysisId = analysisIdentifier(value, 'analysisId')
    const record = await this.intelligenceService().getRecord(project.id, analysisId)
    if (!record || !hasAnalysisKind(record, kind)) {
      throw new ToolInputError(`Expected ${kind} analysis evidence: ${analysisId}`)
    }
    assertAnalysisSourcesCurrent(project, record)
    if (!await this.intelligenceService().matchesCurrentGrantBinding(project, record)) {
      throw new VideoEngineError(
        'invalid_operation',
        'Cached analysis evidence belongs to an older or revoked media grant; run the analysis again.'
      )
    }
    return record as Extract<IntelligenceRecord, { kind: K }>
  }

}
