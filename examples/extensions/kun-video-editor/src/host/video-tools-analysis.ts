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
import { VideoEditorToolsAudioAnalysis } from './video-tools-audio-analysis.js'

export class VideoEditorToolsAnalysis extends VideoEditorToolsAudioAnalysis {
  protected async videoAnalysisStatus(input: ToolInput): Promise<ToolResult> {
    const action = enumValue(input.action, ['capabilities', 'list', 'evidence', 'operation', 'visual-search'] as const, 'action')
    exactKeys(input, [
      'action', 'projectId', 'expectedRevision', 'analysisId', 'operationId', 'query',
      'minimumScore', 'offset', 'limit', 'pageSize'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    if (action === 'capabilities') {
      const [capabilities, denoiseMetadata, visual, speakerIdentities] = await Promise.all([
        this.intelligenceService().audioCapabilities(),
        this.intelligenceService().denoiseMetadataCapability(),
        this.intelligenceService().visualProvisioning(),
        this.intelligenceService().listSpeakerIdentities(projectId)
      ])
      return result({
        outcome: 'capabilities',
        projectId,
        currentRevision: project.currentRevision,
        capabilities: capabilities as unknown as JsonObject,
        denoiseMetadata: denoiseMetadata as unknown as JsonObject,
        visual: visual as unknown as JsonObject,
        speakerAdapters: this.intelligenceService().speakerAdapters() as unknown as JsonValue,
        speakerIdentities: speakerIdentities as unknown as JsonValue
      }, 'Read verified local media-analysis capabilities')
    }
    if (action === 'visual-search') {
      const outcome = await this.intelligenceService().searchVisual({
        project,
        indexId: analysisIdentifier(input.analysisId, 'analysisId'),
        query: boundedString(input.query, 'query', 1, 256),
        ...(input.minimumScore === undefined ? {} : {
          minimumScore: boundedNumber(input.minimumScore, 'minimumScore', -1, 1)
        }),
        ...(input.offset === undefined ? {} : { offset: nonNegativeInteger(input.offset, 'offset') }),
        ...(input.pageSize === undefined ? {} : {
          pageSize: boundedPositiveInteger(input.pageSize, 'pageSize', 1, 100)
        })
      })
      if (outcome.outcome !== 'ready') {
        return result({
          outcome: 'unavailable',
          projectId,
          currentRevision: project.currentRevision,
          code: outcome.code,
          remediation: outcome.remediation,
          local: true,
          networkUsed: false
        }, 'Visual moment search is unavailable; no match was fabricated')
      }
      return result({
        outcome: 'ready',
        projectId,
        currentRevision: project.currentRevision,
        page: outcome.page as unknown as JsonObject
      }, `Read ${outcome.page.results.length} bounded uncalibrated visual moment matches`)
    }
    if (action === 'list') {
      const records = await this.intelligenceService().listRecords(projectId)
      const summaries = await Promise.all(records.slice(0, 512).map(async (record) => {
        const currentGrant = await this.intelligenceService().matchesCurrentGrantBinding(project, record)
        const summary = analysisRecordSummary(record, currentGrant ? project : undefined)
        summary.currentGrant = currentGrant
        return summary
      }))
      return result({
        outcome: 'listed',
        projectId,
        currentRevision: project.currentRevision,
        records: summaries,
        recordsTruncated: records.length > 512,
        operations: this.intelligenceService().listOperations(projectId)
          .filter(({ projectRevision }) => projectRevision === expectedRevision)
      }, `Read ${records.length} immutable local analysis records`)
    }
    if (action === 'evidence') {
      const analysisId = analysisIdentifier(input.analysisId, 'analysisId')
      const record = await this.intelligenceService().getRecord(projectId, analysisId)
      if (!record) throw new ToolInputError(`Media-intelligence evidence does not exist: ${analysisId}`)
      if (!await this.intelligenceService().matchesCurrentGrantBinding(project, record)) {
        throw new VideoEngineError(
          'invalid_operation',
          'Media-intelligence evidence belongs to an older or revoked media grant; reauthorize and analyze again.'
        )
      }
      const evidence = await this.intelligenceService().readEvidence(projectId, analysisId, {
        ...(input.offset === undefined ? {} : { offset: nonNegativeInteger(input.offset, 'offset') }),
        ...(input.limit === undefined ? {} : {
          limit: boundedPositiveInteger(input.limit, 'limit', 1, 500)
        })
      })
      return result({
        outcome: 'evidence',
        projectId,
        currentRevision: project.currentRevision,
        evidence: evidence as unknown as JsonObject
      }, `Read bounded ${evidence.kind} evidence`)
    }
    const operationId = analysisIdentifier(input.operationId, 'operationId')
    const progress = this.intelligenceService().status(operationId)
    if (!progress || progress.projectId !== projectId) {
      throw new ToolInputError(`Local analysis operation does not exist in this project: ${operationId}`)
    }
    if (progress.projectRevision !== expectedRevision) {
      throw new VideoEngineError('revision_conflict', 'Local analysis operation belongs to a different project revision', {
        expectedRevision,
        currentRevision: progress.projectRevision
      })
    }
    return result({ outcome: 'operation', progress: progress as unknown as JsonObject },
      `Local analysis operation ${operationId} is ${progress.status}`)
  }

  protected async videoAnalysisCancel(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'operationId'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const operationId = analysisIdentifier(input.operationId, 'operationId')
    const progress = this.intelligenceService().status(operationId)
    if (!progress || progress.projectId !== projectId || progress.projectRevision !== expectedRevision) {
      throw new ToolInputError('Local analysis operation is missing or no longer belongs to this project revision.')
    }
    const accepted = await this.intelligenceService().cancel(operationId)
    return result({ outcome: accepted ? 'cancelled' : 'not-running', operationId, accepted },
      accepted ? 'Cancelled local audio analysis' : 'Local audio analysis was already terminal')
  }

  protected async videoVisualOptIn(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'enabled'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    if (typeof input.enabled !== 'boolean') throw new ToolInputError('enabled must be a boolean.')
    const capability = await this.intelligenceService().setVisualOptIn(input.enabled)
    return result({
      outcome: input.enabled ? 'enabled' : 'disabled',
      projectId,
      currentRevision: project.currentRevision,
      capability: capability as unknown as JsonObject
    }, input.enabled
      ? 'Enabled workspace-local visual indexing opt-in; no model download or inference was started'
      : 'Disabled workspace-local visual indexing opt-in')
  }

  protected async videoVisualInstall(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const controller = new AbortController()
    const subscription = invocation.cancellation.onCancellationRequested(() => controller.abort())
    try {
      if (invocation.cancellation.isCancellationRequested) controller.abort()
      const installed = await this.intelligenceService().requestVisualModelInstall(controller.signal)
      return result({
        outcome: installed.outcome,
        projectId,
        currentRevision: project.currentRevision,
        capability: installed.capability as unknown as JsonObject
      }, installed.outcome === 'ready'
        ? 'Host Broker verified the local visual model installation'
        : 'No approved Host model installation operation is available; no download was attempted')
    } finally {
      await subscription.dispose()
    }
  }

  protected async videoAnalyzeVisual(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'assetId', 'intervalUs', 'maxFrames', 'allowPartial'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const assetId = stableId(input.assetId, 'assetId')
    const asset = project.assets.find(({ id }) => id === assetId)
    if (!asset || !['video', 'image', 'animation'].includes(asset.kind)) {
      throw new ToolInputError('Visual indexing requires a current video, image, or supported animation asset.')
    }
    if (!asset.mediaHandleId) {
      throw new VideoEngineError('invalid_operation', 'Visual indexing requires a current Host media grant.')
    }
    if (input.allowPartial !== undefined && typeof input.allowPartial !== 'boolean') {
      throw new ToolInputError('allowPartial must be a boolean.')
    }
    const controller = new AbortController()
    const subscription = invocation.cancellation.onCancellationRequested(() => controller.abort())
    try {
      if (invocation.cancellation.isCancellationRequested) controller.abort()
      const outcome = await this.intelligenceService().startVisualIndex({
        project,
        assetId,
        ...(input.intervalUs === undefined ? {} : {
          intervalUs: boundedPositiveInteger(input.intervalUs, 'intervalUs', 100_000, 60_000_000)
        }),
        ...(input.maxFrames === undefined ? {} : {
          maxFrames: boundedPositiveInteger(input.maxFrames, 'maxFrames', 1, 2_000)
        }),
        ...(input.allowPartial === undefined ? {} : { allowPartial: input.allowPartial }),
        signal: controller.signal
      })
      const currentProject = await this.service().loadProject(projectId)
      const revisionStale = currentProject.currentRevision !== expectedRevision
      if (outcome.outcome === 'ready') {
        const evidence = readMediaIntelligenceEvidence(outcome.record, { limit: 200 })
        return result({
          outcome: 'ready',
          projectId,
          pinnedRevision: expectedRevision,
          currentRevision: currentProject.currentRevision,
          revisionStale,
          operationId: outcome.operationId,
          deduplicated: outcome.deduplicated,
          record: analysisRecordSummary(outcome.record, project),
          evidence: evidence as unknown as JsonObject
        }, revisionStale
          ? 'Visual index completed for the pinned source evidence, but the project revision changed; refresh before using it'
          : `Visual index is ready with ${outcome.record.indexedSampleCount} immutable local frame embeddings`)
      }
      if (outcome.outcome === 'unavailable') {
        return result({
          outcome: 'unavailable',
          projectId,
          pinnedRevision: expectedRevision,
          currentRevision: currentProject.currentRevision,
          revisionStale,
          capability: outcome.capability as unknown as JsonObject
        }, 'Visual indexing is unavailable; no model download, upload, or synthetic evidence occurred')
      }
      return result({
        ...outcome,
        projectId,
        pinnedRevision: expectedRevision,
        currentRevision: currentProject.currentRevision,
        revisionStale
      } as unknown as JsonObject, outcome.outcome === 'cancelled'
        ? 'Visual indexing was cancelled and no partial index was published'
        : 'Visual indexing failed without publishing an incomplete index')
    } finally {
      await subscription.dispose()
    }
  }

}
