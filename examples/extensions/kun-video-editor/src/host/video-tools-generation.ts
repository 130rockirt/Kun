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
import { VideoEditorToolsAnalysis } from './video-tools-analysis.js'

export class VideoEditorToolsGeneration extends VideoEditorToolsAnalysis {
  protected async videoGenerationCatalog(): Promise<ToolResult> {
    const content = await this.generationControlPlane().catalog()
    return result(content, content.outcome === 'available'
      ? 'Read the bounded provider-neutral generation catalog'
      : 'Generation is unavailable; ordinary editing and export remain available')
  }

  protected async videoGenerationRequest(input: ToolInput): Promise<ToolResult> {
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.projectRevision, 'projectRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const content = await this.generationControlPlane().request(input)
    return result(content, content.outcome === 'queued'
      ? 'Created a durable generation placeholder before dispatching provider work'
      : content.outcome === 'confirmation-required'
        ? 'Generation requires explicit provider, upload, or bounded-cost confirmation'
        : 'Generation request returned without fabricating media')
  }

  protected async videoGenerationStatus(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['action', 'projectId', 'recordId'])
    const action = enumValue(input.action, ['list', 'status'] as const, 'action')
    const projectId = stableId(input.projectId, 'projectId')
    // Loading the project prevents a caller from using stale generation
    // metadata as an alternate project-discovery channel.
    await this.service().loadProject(projectId)
    const content = action === 'list'
      ? await this.generationControlPlane().list({ projectId })
      : await this.generationControlPlane().status({
          projectId,
          recordId: generationOpaqueId(input.recordId, 'recordId')
        })
    const records = action === 'list' && Array.isArray(content.records)
      ? content.records
      : [content]
    for (const record of records) {
      if (
        record && typeof record === 'object' && !Array.isArray(record) &&
        record.state === 'ready' &&
        typeof record.id === 'string' &&
        Array.isArray(record.outputs) && record.outputs.length > 1
      ) {
        await this.materializeGenerationRecord(projectId, record.id, {
          requireRequestRevision: true,
          autoOnlyMultiple: true
        })
      }
    }
    return result({
      outcome: action === 'list' ? 'listed' : 'status',
      ...content
    }, action === 'list'
      ? 'Read bounded owned generation placeholders and jobs'
      : 'Read one owned generation placeholder or job')
  }

  protected async videoGenerationRetry(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'recordId', 'consent'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const content = await this.generationControlPlane().retry({
      projectId,
      recordId: generationOpaqueId(input.recordId, 'recordId'),
      consent: input.consent
    })
    return result(content, content.outcome === 'queued'
      ? 'Reauthorized and retried the persisted idempotent generation request'
      : 'Generation retry returned without exposing its persisted prompt or media handles')
  }

  protected async videoGenerationCancel(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'recordId'])
    const projectId = stableId(input.projectId, 'projectId')
    await this.service().loadProject(projectId)
    const content = await this.generationControlPlane().cancel({
      projectId,
      recordId: generationOpaqueId(input.recordId, 'recordId')
    })
    return result({ outcome: 'cancelled', record: content }, 'Requested cancellation for one owned generation job')
  }

  protected async videoGenerationInsert(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'recordId', 'outputId', 'addToTimeline',
      'timelineStartFrame', 'stillDurationFrames'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const recordId = generationOpaqueId(input.recordId, 'recordId')
    const outputId = generationOpaqueId(input.outputId, 'outputId')
    const addToTimeline = input.addToTimeline === undefined
      ? true
      : optionalBoolean(input.addToTimeline, 'addToTimeline')!
    const timelineStartFrame = input.timelineStartFrame === undefined
      ? undefined
      : nonNegativeInteger(input.timelineStartFrame, 'timelineStartFrame')
    const stillDurationFrames = input.stillDurationFrames === undefined
      ? undefined
      : boundedPositiveInteger(input.stillDurationFrames, 'stillDurationFrames', 1, 1_080_000)
    const materialized = await this.materializeGenerationRecord(projectId, recordId, {
      expectedRevision,
      selectedOutputId: outputId,
      addToTimeline,
      timelineStartFrame,
      stillDurationFrames
    })
    if (!materialized.selectedAsset) {
      throw new ToolInputError('The selected generation output could not be materialized.')
    }
    return result({
      outcome: materialized.changed ? 'inserted' : 'already-in-project',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: materialized.project.currentRevision,
      ...(materialized.receipt ? { receipt: materialized.receipt } : {}),
      asset: generatedAssetSummary(materialized.selectedAsset),
      materializedVariantCount: materialized.assets.length,
      addedToTimeline: materialized.addedToTimeline
    }, materialized.changed
      ? `Materialized verified generation variants at revision ${materialized.project.currentRevision}`
      : 'The verified generation outputs are already present in the project')
  }

  /**
   * Resolves one owned ready generation record into the project atomically.
   * Automatic completion is fenced to the request revision; an explicit
   * insertion is separately fenced by the caller's current project revision.
   */
  protected async materializeGenerationRecord(
    projectId: string,
    recordId: string,
    options: {
      expectedRevision?: number
      requireRequestRevision?: boolean
      autoOnlyMultiple?: boolean
      selectedOutputId?: string
      addToTimeline?: boolean
      timelineStartFrame?: number
      stillDurationFrames?: number
    }
  ): Promise<{
    project: VideoProject
    assets: MediaAsset[]
    selectedAsset?: MediaAsset
    changed: boolean
    addedToTimeline: boolean
    receipt?: MutationReceipt
  }> {
    const current = await this.service().loadProject(projectId)
    if (options.expectedRevision !== undefined) {
      assertExpectedRevision(current, options.expectedRevision)
    }
    const materializations = await this.generationService().materializations(projectId, recordId)
    if (materializations.length === 0) {
      throw new ToolInputError('The generation record has no verified outputs.')
    }
    if (options.autoOnlyMultiple && materializations.length < 2) {
      return { project: current, assets: [], changed: false, addedToTimeline: false }
    }
    const identity = materializations[0]!
    if (materializations.some((entry) =>
      entry.recordId !== identity.recordId ||
      entry.jobId !== identity.jobId ||
      entry.projectRevision !== identity.projectRevision ||
      entry.outputPolicy !== identity.outputPolicy ||
      entry.primaryAssetId !== identity.primaryAssetId
    )) {
      throw new ToolInputError('Generation materialization identities are inconsistent.')
    }

    const assets = materializations.map((entry) => generatedAssetFromMaterialization(current, entry))
    if (new Set(assets.map(({ id }) => id)).size !== assets.length) {
      throw new ToolInputError('Generation outputs resolve to duplicate project asset identities.')
    }
    const selectedIndex = options.selectedOutputId === undefined
      ? -1
      : materializations.findIndex(({ output }) => output.id === options.selectedOutputId)
    if (options.selectedOutputId !== undefined && selectedIndex < 0) {
      throw new ToolInputError('Generation output does not belong to this record.')
    }
    const selectedAsset = selectedIndex < 0 ? undefined : assets[selectedIndex]
    const missingAssets: MediaAsset[] = []
    for (const asset of assets) {
      const existing = current.assets.find(({ id }) => id === asset.id)
      if (!existing) {
        missingAssets.push(asset)
        continue
      }
      if (!sameGeneratedMaterialization(existing, asset)) {
        throw new ToolInputError(`Generated asset identity ${asset.id} is already used by different media.`)
      }
    }

    if (
      options.requireRequestRevision &&
      missingAssets.length > 0 &&
      current.currentRevision !== identity.projectRevision
    ) {
      return {
        project: current,
        assets,
        ...(selectedAsset ? { selectedAsset } : {}),
        changed: false,
        addedToTimeline: false
      }
    }

    let candidate = missingAssets.length > 0
      ? planBatchMediaImport(current, missingAssets).project
      : structuredClone(current)
    let addedToTimeline = false
    if (selectedAsset && options.addToTimeline) {
      const materializedAsset = candidate.assets.find(({ id }) => id === selectedAsset.id)
      if (!materializedAsset) throw new ToolInputError('Materialized generation asset is missing from the project.')
      const itemId = `item-${materializedAsset.id}`
      const existingItem = candidate.items.find(({ id }) => id === itemId)
      if (existingItem && existingItem.assetId !== materializedAsset.id) {
        throw new ToolInputError(`Timeline item identity ${itemId} is already used by different media.`)
      }
      if (!existingItem) {
        const item = initialItem(candidate, materializedAsset)
        if (options.timelineStartFrame !== undefined) item.timelineStartFrame = options.timelineStartFrame
        if (materializedAsset.kind === 'image' && options.stillDurationFrames !== undefined) {
          const durationUs = Math.max(1, framesToMicroseconds(options.stillDurationFrames, candidate.fps))
          materializedAsset.durationUs = Math.max(materializedAsset.durationUs, durationUs)
          item.durationFrames = options.stillDurationFrames
          item.sourceEndUs = durationUs
        }
        candidate = applyTimelineOperations(candidate, [{ type: 'add-item', item }]).project
        addedToTimeline = true
      }
    }
    if (missingAssets.length === 0 && !addedToTimeline) {
      return {
        project: current,
        assets,
        ...(selectedAsset ? {
          selectedAsset: current.assets.find(({ id }) => id === selectedAsset.id) ?? selectedAsset
        } : {}),
        changed: false,
        addedToTimeline: false
      }
    }

    try {
      const committed = await this.service().saveProjectWithReceipt(candidate, current.currentRevision, {
        author: options.requireRequestRevision ? 'system' : 'manual',
        sourceOperation: options.requireRequestRevision ? 'generation.materialize' : 'generation.insert',
        summary: `Materialized ${assets.length} verified generation output${assets.length === 1 ? '' : 's'}`
      })
      await this.publishProjectChange(committed.project, 'generation-materialized', committed.receipt)
      return {
        project: committed.project,
        assets,
        ...(selectedAsset ? {
          selectedAsset: committed.project.assets.find(({ id }) => id === selectedAsset.id) ?? selectedAsset
        } : {}),
        changed: true,
        addedToTimeline,
        receipt: committed.receipt
      }
    } catch (error) {
      if (options.requireRequestRevision && error instanceof VideoEngineError && error.code === 'revision_conflict') {
        const latest = await this.service().loadProject(projectId)
        const complete = assets.every((asset) => {
          const existing = latest.assets.find(({ id }) => id === asset.id)
          return existing !== undefined && sameGeneratedMaterialization(existing, asset)
        })
        if (complete) {
          return {
            project: latest,
            assets,
            ...(selectedAsset ? {
              selectedAsset: latest.assets.find(({ id }) => id === selectedAsset.id) ?? selectedAsset
            } : {}),
            changed: false,
            addedToTimeline: false
          }
        }
        return {
          project: latest,
          assets,
          ...(selectedAsset ? { selectedAsset } : {}),
          changed: false,
          addedToTimeline: false
        }
      }
      throw error
    }
  }

}
