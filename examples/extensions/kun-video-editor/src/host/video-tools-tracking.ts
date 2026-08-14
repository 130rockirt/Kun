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
import { VideoEditorToolsFoundation } from './video-tools-foundation.js'

export class VideoEditorToolsTracking extends VideoEditorToolsFoundation {
  protected async cancelAfterRenderTrackingFailure(
    jobId: string
  ): Promise<{ state: JobSnapshot['state'] | 'unknown'; accepted: boolean }> {
    try {
      const cancellation = await this.context.jobs.cancel({
        jobId,
        reason: 'Render tracking persistence failed after durable job admission'
      })
      const terminal = await this.waitForTerminalJob(cancellation.snapshot)
      return { state: terminal.state, accepted: cancellation.accepted }
    } catch {
      try {
        return { state: (await this.context.jobs.get(jobId)).state, accepted: false }
      } catch {
        return { state: 'unknown', accepted: false }
      }
    }
  }

  protected async waitForTerminalJob(initial: JobSnapshot): Promise<JobSnapshot> {
    if (isTerminalJobState(initial.state)) return initial
    let subscription: Awaited<ReturnType<ExtensionContext['jobs']['subscribe']>> | undefined
    try {
      subscription = await this.context.jobs.subscribe({
        jobId: initial.id,
        afterCursor: initial.latestCursor
      })
      const activeSubscription = subscription
      if (isTerminalJobState(activeSubscription.snapshot.state)) return activeSubscription.snapshot
      return await new Promise<JobSnapshot>((resolve) => {
        let settled = false
        const finish = (snapshot: JobSnapshot): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(snapshot)
        }
        const timeout = setTimeout(() => {
          void this.context.jobs.get(initial.id).then(finish, () => finish(activeSubscription.snapshot))
        }, RENDER_TRACKING_CANCELLATION_WAIT_MS)
        activeSubscription.onEvent(() => {
          if (isTerminalJobState(activeSubscription.snapshot.state)) finish(activeSubscription.snapshot)
        })
        if (isTerminalJobState(activeSubscription.snapshot.state)) finish(activeSubscription.snapshot)
      })
    } catch {
      try {
        return await this.context.jobs.get(initial.id)
      } catch {
        return initial
      }
    } finally {
      try {
        await subscription?.dispose()
      } catch {
        // The durable snapshot remains queryable by jobId even if unsubscribe loses the Host connection.
      }
    }
  }

  protected async videoRenderStatus(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['jobId', 'projectId'])
    const jobId = boundedString(input.jobId, 'jobId', 8, 512)
    const projectId = input.projectId === undefined
      ? undefined
      : stableId(input.projectId, 'projectId')
    const snapshot = await this.context.jobs.get(jobId)
    const record = await this.scopedRenderRecord(snapshot, projectId)
    return await this.renderStatusResult(snapshot, record)
  }

  protected async videoRenderList(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [])
    const page = await this.context.jobs.list({
      filter: { kinds: ['media.ffmpeg'], workspaceId: this.workspaceId() },
      limit: 200
    })
    const records: JsonObject[] = []
    let untrackedCount = 0
    for (const snapshot of page.items) {
      try {
        this.assertOwnedRenderSnapshot(snapshot)
        const record = await this.loadOrRecoverRenderRecord(snapshot)
        if (!record) {
          untrackedCount += 1
          continue
        }
        records.push({
          jobId: record.jobId,
          projectId: record.projectId,
          sequenceId: record.sequenceId,
          pinnedRevision: record.pinnedRevision,
          renderIrDigest: record.renderIrDigest,
          backendCapabilitiesDigest: record.backendCapabilitiesDigest,
          renderKind: record.renderKind,
          requestedRenderKind: record.requestedRenderKind ?? null,
          advancedSettingsDigest: record.advancedSettingsDigest ?? null,
          advancedCapabilitiesDigest: record.advancedCapabilitiesDigest ?? null,
          effectSemanticsDigest: record.effectSemanticsDigest ?? null,
          portableEquivalent: record.portableEquivalent ?? false,
          createdAt: record.createdAt
        })
      } catch {
        untrackedCount += 1
      }
    }
    return result({
      outcome: 'listed',
      records,
      truncated: page.page.hasMore,
      untrackedCount
    }, `Listed ${records.length} tracked video renders`)
  }

  protected async videoRenderCancel(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['jobId', 'projectId', 'reason'])
    const jobId = boundedString(input.jobId, 'jobId', 8, 512)
    const projectId = input.projectId === undefined
      ? undefined
      : stableId(input.projectId, 'projectId')
    const snapshot = await this.context.jobs.get(jobId)
    const record = await this.scopedRenderRecord(snapshot, projectId)
    if (!record) {
      throw new ToolInputError(
        'The durable job has no verified video-render tracking record and cannot be cancelled by this tool.'
      )
    }
    const cancellation = await this.context.jobs.cancel({
      jobId,
      ...(input.reason === undefined
        ? {}
        : { reason: boundedString(input.reason, 'reason', 1, 512) })
    })
    return await this.renderStatusResult(cancellation.snapshot, record)
  }

  protected async renderStatusResult(
    snapshot: JobSnapshot,
    record: RenderRecord | undefined
  ): Promise<ToolResult> {
    const currentRevision = record
      ? await this.currentRevision(record.projectId)
      : undefined
    const proofStale = record !== undefined && currentRevision !== undefined
      ? currentRevision !== record.pinnedRevision
      : false
    const validation = await this.validateArtifacts(snapshot, record)
    const outcome = snapshot.state === 'completed' && !validation.valid
      ? 'invalid-output'
      : snapshot.state
    const content: JsonObject = {
      outcome,
      jobId: snapshot.id,
      state: snapshot.state,
      tracked: record !== undefined,
      ...(record ? {
        projectId: record.projectId,
        sequenceId: record.sequenceId,
        pinnedRevision: record.pinnedRevision,
        renderIrDigest: record.renderIrDigest,
        backendCapabilitiesDigest: record.backendCapabilitiesDigest,
        renderRange: record.renderRange,
        playbackMode: record.playbackMode,
        renderKind: record.renderKind,
        requestedRenderKind: record.requestedRenderKind ?? null,
        advancedSettingsDigest: record.advancedSettingsDigest ?? null,
        advancedCapabilitiesDigest: record.advancedCapabilitiesDigest ?? null,
        effectSemanticsDigest: record.effectSemanticsDigest ?? null,
        portableEquivalent: record.portableEquivalent ?? false,
        captionMode: record.captionMode,
        subtitleFormat: record.subtitleFormat,
        canvasPreset: record.canvasPreset,
        proofFrame: record.proofFrame ?? null,
        currentRevision: currentRevision ?? null,
        projectAvailable: currentRevision !== undefined
      } : {}),
      proofStale,
      technicallyValidated: validation.valid,
      visualInspection: 'not-performed',
      evidenceCurrent: validation.valid && !proofStale,
      ...(snapshot.progress ? { progress: snapshot.progress as unknown as JsonObject } : {}),
      ...(snapshot.error ? { error: snapshot.error as unknown as JsonObject } : {}),
      artifacts: validation.artifacts,
      ...(validation.reason ? { message: validation.reason } : {})
    }
    return {
      content,
      summary: renderStatusSummary(snapshot, validation.valid, proofStale),
      metadata: {
        machineValidatedOnly: validation.valid,
        visuallyInspected: false,
        proofStale,
        evidenceCurrent: validation.valid && !proofStale
      },
      ...(validation.valid && !proofStale && validation.artifacts.length > 0
        ? { generatedArtifacts: validation.artifacts }
        : {})
    }
  }

  protected async scopedRenderRecord(
    snapshot: JobSnapshot,
    expectedProjectId: string | undefined
  ): Promise<RenderRecord | undefined> {
    this.assertOwnedRenderSnapshot(snapshot)
    const record = await this.loadOrRecoverRenderRecord(snapshot)
    if (expectedProjectId !== undefined && record?.projectId !== expectedProjectId) {
      throw new ToolInputError(
        'The durable job could not be verified as a render for the requested project.'
      )
    }
    return record
  }


}
