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
import { VideoEditorToolsGeneration } from './video-tools-generation.js'

export { ToolInputError } from './video-tools-model.js'

export class VideoEditorTools extends VideoEditorToolsGeneration {
  async register(): Promise<void> {
    for (const declaration of VIDEO_TOOL_DECLARATIONS) {
      this.context.subscriptions.add(
        await this.context.tools.registerTool(declaration, (input, invocation) =>
          this.invoke(declaration.id, input, invocation)
        )
      )
    }
  }

  async invoke(
    toolId: string,
    input: JsonObject,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    try {
      assertNotCancelled(invocation)
      const parsed = asRecord(input, toolId)
      switch (toolId) {
        case 'video-project':
          return await this.videoProject(parsed)
        case 'video-inspect':
          return await this.videoInspect(parsed)
        case 'video-probe':
          return await this.videoProbe(parsed, invocation)
        case 'video-transcribe':
          return await this.videoTranscribe(parsed, 'agent', invocation)
        case 'video-read-script':
          return await this.videoReadScript(parsed)
        case 'video-apply-script':
          return await this.videoApplyScript(parsed, 'agent', invocation)
        case 'video-update-timeline':
          return await this.videoUpdateTimeline(parsed, 'agent', invocation)
        case 'video-analyze-visual':
          return await this.videoAnalyzeVisual(parsed, invocation)
        case 'video-analyze-audio':
          return await this.videoAnalyzeAudio(parsed, 'agent', invocation)
        case 'video-analysis-status':
          return await this.videoAnalysisStatus(parsed)
        case 'video-analysis-cancel':
          return await this.videoAnalysisCancel(parsed)
        case 'video-interchange':
          return await this.videoInterchange(parsed, invocation)
        case 'video-interchange-status':
          return await this.videoInterchange({ ...parsed, action: 'status' }, invocation)
        case 'video-interchange-cancel':
          return await this.videoInterchange({ ...parsed, action: 'cancel' }, invocation)
        case 'video-generation-catalog':
          return await this.videoGenerationCatalog()
        case 'video-generation-request':
          return await this.videoGenerationRequest(parsed)
        case 'video-generation-status':
          return await this.videoGenerationStatus(parsed)
        case 'video-generation-cancel':
          return await this.videoGenerationCancel(parsed)
        case 'video-project-package':
          return await this.videoProjectPackage(parsed, invocation)
        case 'video-project-package-status':
          return await this.videoProjectPackage({ ...parsed, action: 'status' }, invocation)
        case 'video-project-package-cancel':
          return await this.videoProjectPackage({ ...parsed, action: 'cancel' }, invocation)
        case 'video-render':
          return await this.videoRender(parsed, invocation)
        case 'video-render-status':
          return await this.videoRenderStatus(parsed)
        case 'video-render-cancel':
          return await this.videoRenderCancel(parsed)
        case 'video-undo':
          return await this.videoUndo(parsed, invocation)
        default:
          throw new ToolInputError(`Unknown video tool: ${toolId}`)
      }
    } catch (error) {
      if (error instanceof VideoEngineError) throw publicEngineError(error, toolId)
      throw error
    }
  }

  async editorRequest(value: JsonValue): Promise<JsonValue> {
    try {
      return await this.editorRequestResult(value) as unknown as JsonValue
    } catch (error) {
      if (error instanceof VideoEngineError) throw publicEngineError(error, 'editor-request')
      throw error
    }
  }

  protected async editorRequestResult(value: JsonValue): Promise<ToolResult> {
    const request = asRecord(value, 'editor-request')
    exactKeys(request, ['action', 'payload'])
    const action = enumValue(request.action, [
      'project.list',
      'project.active',
      'project.get',
      'project.select',
      'project.create',
      'project.update',
      'context.update',
      'context.attach-selection',
      'project.undo',
      'project.redo',
      'sequence.decompose',
      'script.read',
      'script.apply',
      'media.list',
      'media.import',
      'media.import-batch',
      'media.reauthorize',
      'media.folder.create',
      'media.folder.update',
      'media.folder.delete',
      'media.organize',
      'transcript.import',
      'caption.generate',
      'preview.list',
      'preview.add',
      'preview.select',
      'preview.compare',
      'preview.replace',
      'export-capabilities',
      'otio-export-preview',
      'otio-import-preview',
      'interchange.export',
      'interchange.status',
      'interchange.cancel',
      'interchange.import-preview',
      'interchange.import',
      'project-package-preflight',
      'project-package.export',
      'project-package.status',
      'project-package.cancel',
      'render.list',
      'render.start',
      'render.status',
      'render.cancel',
      'derived.list',
      'derived.start',
      'derived.retry',
      'derived.cancel',
      'derived.cleanup',
      'analysis.capabilities',
      'analysis.visual-opt-in',
      'analysis.visual-install',
      'analysis.visual-index',
      'analysis.visual-search',
      'analysis.list',
      'analysis.evidence',
      'analysis.vad',
      'analysis.vad-apply',
      'analysis.speaker-import',
      'analysis.speaker-preview',
      'analysis.speaker-apply',
      'analysis.beats',
      'analysis.denoise-metadata',
      'analysis.sync-preview',
      'analysis.sync-apply',
      'analysis.status',
      'analysis.cancel',
      'generation.catalog',
      'generation.list',
      'generation.request',
      'generation.retry',
      'generation.status',
      'generation.cancel',
      'generation.insert',
      'multicam.inspect',
      'multicam.create',
      'multicam.labels',
      'multicam.sync-confirm',
      'multicam.layout-upsert',
      'multicam.delete',
      'multicam.switch',
      'multicam.layout',
      'multicam.merge'
    ] as const, 'action')
    const payload = request.payload === undefined ? {} : asRecord(request.payload, 'payload')
    const invocation = this.commandInvocation(action)
    let response: ToolResult
    switch (action) {
      case 'project.list':
        response = await this.videoProject({ ...payload, action: 'list' })
        break
      case 'project.active':
        response = await this.videoProject({ ...payload, action: 'active' }, 'manual')
        break
      case 'project.get':
        response = await this.videoProject({ ...payload, action: 'get' }, 'manual')
        break
      case 'project.select':
        response = await this.videoProject({ ...payload, action: 'select' }, 'manual')
        break
      case 'project.create':
        response = await this.videoProject({ ...payload, action: 'create' }, 'manual')
        break
      case 'project.update':
        response = await this.videoUpdateTimeline(payload, 'manual')
        break
      case 'context.update':
        response = await this.videoUpdateContext(payload)
        break
      case 'context.attach-selection':
        response = await this.videoSelectionAttachment(payload)
        break
      case 'project.undo':
      case 'project.redo':
        response = await this.videoHistory(payload, action === 'project.undo' ? 'undo' : 'redo')
        break
      case 'sequence.decompose':
        response = await this.videoDecomposeSequence(payload)
        break
      case 'script.read':
        response = await this.videoReadScript(payload)
        break
      case 'script.apply':
        response = await this.videoApplyScript(payload, 'manual')
        break
      case 'media.list':
        response = await this.videoInspect({ ...payload, action: 'media-library' })
        break
      case 'media.import':
        response = await this.videoProbe(payload, invocation, 'manual')
        break
      case 'media.import-batch':
        response = await this.videoProbeBatch(payload, invocation)
        break
      case 'media.reauthorize':
        response = await this.videoReauthorize(payload, invocation)
        break
      case 'media.folder.create':
      case 'media.folder.update':
      case 'media.folder.delete':
      case 'media.organize':
        response = await this.videoMediaLibraryMutation(payload, action)
        break
      case 'transcript.import':
        response = await this.videoTranscribe(payload, 'manual')
        break
      case 'caption.generate':
        response = await this.videoGenerateCaptions(payload)
        break
      case 'preview.list':
      case 'preview.add':
      case 'preview.select':
      case 'preview.compare':
      case 'preview.replace':
        response = await this.videoPreview(payload, action)
        break
      case 'export-capabilities':
      case 'otio-export-preview':
      case 'otio-import-preview':
      case 'project-package-preflight':
        response = await this.videoInspect({ ...payload, action })
        break
      case 'interchange.export':
        response = await this.videoInterchange({ ...payload, action: 'export' }, invocation)
        break
      case 'interchange.status':
        response = await this.videoInterchange({ ...payload, action: 'status' }, invocation)
        break
      case 'interchange.cancel':
        response = await this.videoInterchange({ ...payload, action: 'cancel' }, invocation)
        break
      case 'interchange.import-preview':
        response = await this.videoInterchangeImport(payload, false)
        break
      case 'interchange.import':
        response = await this.videoInterchangeImport(payload, true)
        break
      case 'project-package.export':
        response = await this.videoProjectPackage({ ...payload, action: 'export' }, invocation)
        break
      case 'project-package.status':
        response = await this.videoProjectPackage({ ...payload, action: 'status' }, invocation)
        break
      case 'project-package.cancel':
        response = await this.videoProjectPackage({ ...payload, action: 'cancel' }, invocation)
        break
      case 'render.list':
        response = await this.videoRenderList(payload)
        break
      case 'render.start':
        response = await this.videoRender(payload, invocation)
        break
      case 'render.status':
        response = await this.videoRenderStatus(payload)
        break
      case 'render.cancel':
        response = await this.videoRenderCancel(payload)
        break
      case 'derived.list':
        response = await this.videoDerivedList(payload)
        break
      case 'derived.start':
        response = await this.videoDerivedStart(payload)
        break
      case 'derived.retry':
        response = await this.videoDerivedStart(payload, true)
        break
      case 'derived.cancel':
        response = await this.videoDerivedCancel(payload)
        break
      case 'derived.cleanup':
        response = await this.videoDerivedCleanup(payload)
        break
      case 'analysis.capabilities':
      case 'analysis.list':
      case 'analysis.evidence':
      case 'analysis.status':
        response = await this.videoAnalysisStatus({
          ...payload,
          action: action.slice('analysis.'.length) === 'status'
            ? 'operation'
            : action.slice('analysis.'.length)
        })
        break
      case 'analysis.visual-search':
        response = await this.videoAnalysisStatus({ ...payload, action: 'visual-search' })
        break
      case 'analysis.visual-opt-in':
        response = await this.videoVisualOptIn(payload)
        break
      case 'analysis.visual-install':
        response = await this.videoVisualInstall(payload, invocation)
        break
      case 'analysis.visual-index':
        response = await this.videoAnalyzeVisual(payload, invocation)
        break
      case 'analysis.vad':
      case 'analysis.vad-apply':
      case 'analysis.denoise-metadata':
      case 'analysis.speaker-import':
      case 'analysis.speaker-preview':
      case 'analysis.speaker-apply':
      case 'analysis.beats':
      case 'analysis.sync-preview':
      case 'analysis.sync-apply':
        response = await this.videoAnalyzeAudio({
          ...payload,
          action: action.slice('analysis.'.length) === 'beats'
            ? 'beat-grid'
            : action.slice('analysis.'.length) === 'speaker-import'
              ? 'speaker-import'
              : action.slice('analysis.'.length) === 'speaker-preview'
                ? 'speaker-attribution-preview'
                : action.slice('analysis.'.length) === 'speaker-apply'
                  ? 'speaker-attribution-apply'
                  : action.slice('analysis.'.length)
        }, 'manual', invocation)
        break
      case 'analysis.cancel':
        response = await this.videoAnalysisCancel(payload)
        break
      case 'generation.catalog':
        response = await this.videoGenerationCatalog()
        break
      case 'generation.list':
      case 'generation.status':
        response = await this.videoGenerationStatus({
          ...payload,
          action: action === 'generation.list' ? 'list' : 'status'
        })
        break
      case 'generation.request':
        response = await this.videoGenerationRequest(payload)
        break
      case 'generation.retry':
        response = await this.videoGenerationRetry(payload)
        break
      case 'generation.cancel':
        response = await this.videoGenerationCancel(payload)
        break
      case 'generation.insert':
        response = await this.videoGenerationInsert(payload)
        break
      case 'multicam.inspect':
        response = await this.videoInspect({ ...payload, action: 'multicam' })
        break
      case 'multicam.create':
      case 'multicam.labels':
      case 'multicam.sync-confirm':
      case 'multicam.layout-upsert':
      case 'multicam.delete':
      case 'multicam.switch':
      case 'multicam.layout':
      case 'multicam.merge':
        response = await this.videoMulticamMutation(payload, action)
        break
    }
    return response
  }

}
