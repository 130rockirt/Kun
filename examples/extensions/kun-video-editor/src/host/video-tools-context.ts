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
import { VideoEditorToolsProject } from './video-tools-project.js'

export class VideoEditorToolsContext extends VideoEditorToolsProject {
  protected async videoUpdateContext(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'expectedGeneration', 'sequenceId', 'playheadFrame',
      'selectedAssetIds', 'selectedItemIds', 'selectedCaptionIds', 'selectedWordIds', 'range'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const patch: ProjectSelectionPatch = {
      ...(input.sequenceId === undefined ? {} : { sequenceId: stableId(input.sequenceId, 'sequenceId') }),
      ...(input.playheadFrame === undefined ? {} : {
        playheadFrame: nonNegativeInteger(input.playheadFrame, 'playheadFrame')
      }),
      ...(input.selectedAssetIds === undefined ? {} : {
        selectedAssetIds: stableIdArray(input.selectedAssetIds, 'selectedAssetIds')
      }),
      ...(input.selectedItemIds === undefined ? {} : {
        selectedItemIds: stableIdArray(input.selectedItemIds, 'selectedItemIds')
      }),
      ...(input.selectedCaptionIds === undefined ? {} : {
        selectedCaptionIds: stableIdArray(input.selectedCaptionIds, 'selectedCaptionIds')
      }),
      ...(input.selectedWordIds === undefined ? {} : {
        selectedWordIds: stableIdArray(input.selectedWordIds, 'selectedWordIds')
      }),
      ...(input.range === undefined ? {} : { range: selectionRange(input.range) })
    }
    const updated = await this.service().updateSelection(
      projectId,
      nonNegativeInteger(input.expectedRevision, 'expectedRevision'),
      nonNegativeInteger(input.expectedGeneration, 'expectedGeneration'),
      patch
    )
    await this.publishSelectionChange(updated)
    return result({ outcome: 'context-updated', ...updated },
      `Updated video selection generation ${updated.generation}`)
  }

  protected async videoSelectionAttachment(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'previewEntryIds'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const history = await this.loadPreviewHistory(projectId)
    const previewEntryIds = input.previewEntryIds === undefined
      ? []
      : boundedArray(input.previewEntryIds, 'previewEntryIds', 0, 64)
        .map((entry, index) => stableId(entry, `previewEntryIds[${index}]`))
    const knownEntries = new Set(history.entries.map(({ id }) => id))
    const missing = previewEntryIds.find((id) => !knownEntries.has(id))
    if (missing) throw new ToolInputError(`Preview history entry does not exist: ${missing}`)
    const attachment = buildVideoSelectionAttachment(project, previewEntryIds)
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.selection-attached',
      payload: attachment as unknown as JsonValue
    })
    return result({
      outcome: 'selection-attached',
      attachment: attachment as unknown as JsonObject
    }, `Built revision-bound video selection context for revision ${project.currentRevision}`)
  }

  protected async videoDecomposeSequence(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'itemId'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const itemId = stableId(input.itemId, 'itemId')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const outer = project.items.find(({ id }) => id === itemId)
    if (!outer?.nestedSequenceId) throw new ToolInputError(`Timeline item is not a nested sequence: ${itemId}`)
    const nested = project.sequences.find(({ id }) => id === outer.nestedSequenceId)
    if (!nested) throw new ToolInputError(`Nested sequence does not exist: ${outer.nestedSequenceId}`)
    const parent = project.sequences.find(({ id }) => id === project.activeSequenceId)
    if (!parent) throw new ToolInputError(`Active sequence does not exist: ${project.activeSequenceId}`)
    const trackMap: Record<string, string> = {}
    for (const childTrack of nested.tracks) {
      const target = parent.tracks.find((track) => track.id === childTrack.id && track.kind === childTrack.kind) ??
        (childTrack.kind === 'video'
          ? parent.tracks.find(({ id, kind }) => id === outer.trackId && kind === 'video')
          : undefined) ??
        parent.tracks.find(({ kind }) => kind === childTrack.kind)
      if (!target) {
        throw new ToolInputError(`No ${childTrack.kind} track is available to decompose ${childTrack.id}.`)
      }
      trackMap[childTrack.id] = target.id
    }
    const plan = planDecomposeNestedSequence(project, {
      parentSequenceId: parent.id,
      itemId,
      trackMap
    })
    const committed = await this.service().applyOperationsWithReceipt(
      projectId,
      expectedRevision,
      plan.operations,
      {
        author: 'manual',
        sourceOperation: 'sequence.decompose',
        summary: `Decomposed nested sequence ${plan.nestedSequenceId}`
      }
    )
    await this.publishProjectChange(committed.project, 'sequence-decomposed', committed.receipt)
    return result({
      outcome: 'sequence-decomposed',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      receipt: committed.receipt as unknown as JsonObject,
      nestedSequenceId: plan.nestedSequenceId,
      operationCount: plan.operations.length,
      warnings: plan.warnings
    }, `Decomposed ${itemId} at revision ${committed.project.currentRevision}`)
  }

  protected async videoMediaLibraryMutation(
    input: ToolInput,
    action: 'media.folder.create' | 'media.folder.update' | 'media.folder.delete' | 'media.organize'
  ): Promise<ToolResult> {
    const commonKeys = ['projectId', 'expectedRevision'] as const
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    let candidate: VideoProject
    let summary: string
    if (action === 'media.folder.create') {
      exactKeys(input, [...commonKeys, 'folderId', 'name', 'parentId'])
      const folderId = stableId(input.folderId, 'folderId')
      candidate = createMediaFolder(project, {
        id: folderId,
        name: boundedString(input.name, 'name', 1, 160),
        ...(input.parentId === undefined ? {} : { parentId: stableId(input.parentId, 'parentId') })
      }).project
      summary = `Created media folder ${folderId}`
    } else if (action === 'media.folder.update') {
      exactKeys(input, [...commonKeys, 'folderId', 'name', 'parentId'])
      const folderId = stableId(input.folderId, 'folderId')
      if (input.name === undefined && input.parentId === undefined) {
        throw new ToolInputError('Media folder update requires name or parentId.')
      }
      candidate = updateMediaFolder(project, folderId, {
        ...(input.name === undefined ? {} : { name: boundedString(input.name, 'name', 1, 160) }),
        ...(input.parentId === undefined
          ? {}
          : { parentId: input.parentId === null ? null : stableId(input.parentId, 'parentId') })
      }).project
      summary = `Updated media folder ${folderId}`
    } else if (action === 'media.folder.delete') {
      exactKeys(input, [...commonKeys, 'folderId', 'moveContentsToFolderId'])
      const folderId = stableId(input.folderId, 'folderId')
      const moveContentsToFolderId = input.moveContentsToFolderId === undefined || input.moveContentsToFolderId === null
        ? undefined
        : stableId(input.moveContentsToFolderId, 'moveContentsToFolderId')
      candidate = deleteMediaFolder(project, folderId, moveContentsToFolderId).project
      summary = `Deleted media folder ${folderId}`
    } else {
      exactKeys(input, [...commonKeys, 'assetIds', 'folderId'])
      const assetIds = boundedArray(input.assetIds, 'assetIds', 1, 64)
        .map((entry, index) => stableId(entry, `assetIds[${index}]`))
      const folderId = input.folderId === undefined || input.folderId === null
        ? undefined
        : stableId(input.folderId, 'folderId')
      candidate = organizeMediaAssets(project, assetIds, folderId).project
      summary = `Organized ${assetIds.length} media assets`
    }
    const committed = await this.service().saveProjectWithReceipt(candidate, expectedRevision, {
      author: 'manual',
      sourceOperation: action,
      summary
    })
    await this.publishProjectChange(committed.project, 'media-library-updated', committed.receipt)
    return result({
      outcome: action,
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      receipt: committed.receipt as unknown as JsonObject,
      mediaFolders: (committed.project.mediaFolders ?? []).slice(0, MAX_MEDIA_FOLDERS),
      assets: committed.project.assets.slice(0, MAX_ASSETS).map(assetProjection),
      truncated: (committed.project.mediaFolders?.length ?? 0) > MAX_MEDIA_FOLDERS ||
        committed.project.assets.length > MAX_ASSETS
    }, `${summary} at revision ${committed.project.currentRevision}`)
  }

  protected async videoPreview(
    input: ToolInput,
    action: 'preview.list' | 'preview.add' | 'preview.select' | 'preview.compare' | 'preview.replace'
  ): Promise<ToolResult> {
    const projectId = stableId(input.projectId, 'projectId')
    const project = await this.service().loadProject(projectId)
    let history = await this.loadPreviewHistory(projectId)
    if (action === 'preview.list') {
      exactKeys(input, ['projectId'])
      return result({
        outcome: 'preview-list',
        history: history as unknown as JsonObject,
        comparison: null
      }, `Listed ${history.entries.length} bounded preview entries`)
    }

    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    assertExpectedRevision(project, expectedRevision)
    if (action === 'preview.add') {
      exactKeys(input, ['projectId', 'expectedRevision', 'entryId', 'label', 'source'])
      const source = previewSource(input.source)
      assertPreviewSource(project, source)
      const label = boundedString(input.label, 'label', 1, 160)
      const entry: PreviewHistoryEntry = {
        id: input.entryId === undefined
          ? previewEntryId(project, history, source, label)
          : stableId(input.entryId, 'entryId'),
        projectId,
        createdAt: new Date().toISOString(),
        label,
        source
      }
      history = appendPreviewHistory(history, entry)
      await this.savePreviewHistory(projectId, history)
      await this.publishPreviewHistory(history)
      return result({ outcome: 'preview-added', history: history as unknown as JsonObject },
        `Added preview ${entry.id}`)
    }
    if (action === 'preview.select') {
      exactKeys(input, ['projectId', 'expectedRevision', 'entryId'])
      history = selectPreviewHistory(history, stableId(input.entryId, 'entryId'))
      await this.savePreviewHistory(projectId, history)
      await this.publishPreviewHistory(history)
      return result({ outcome: 'preview-selected', history: history as unknown as JsonObject },
        `Selected preview ${history.activeEntryId ?? ''}`)
    }
    if (action === 'preview.compare') {
      exactKeys(input, ['projectId', 'expectedRevision', 'leftEntryId', 'rightEntryId', 'mode'])
      const comparison = comparePreviewHistory(
        history,
        stableId(input.leftEntryId, 'leftEntryId'),
        stableId(input.rightEntryId, 'rightEntryId'),
        enumValue(input.mode, ['wipe', 'side-by-side'] as const, 'mode')
      )
      return result({
        outcome: 'preview-comparison',
        history: history as unknown as JsonObject,
        comparison: comparison as unknown as JsonObject
      }, 'Compared two bounded preview sources')
    }

    exactKeys(input, ['projectId', 'expectedRevision', 'itemId', 'entryId'])
    const entryId = stableId(input.entryId, 'entryId')
    const entry = history.entries.find(({ id }) => id === entryId)
    if (!entry) throw new ToolInputError(`Preview history entry does not exist: ${entryId}`)
    if (entry.source.kind === 'timeline') {
      throw new ToolInputError('A timeline proof cannot replace a source clip; select an asset or generated preview.')
    }
    const operations = planReplaceTimelineItemFromPreview(project, {
      itemId: stableId(input.itemId, 'itemId'),
      preview: entry.source
    })
    const committed = await this.service().applyOperationsWithReceipt(projectId, expectedRevision, operations, {
      author: 'manual',
      sourceOperation: 'preview.replace',
      summary: `Replaced a timeline item from preview ${entry.id}`
    })
    await this.publishProjectChange(committed.project, 'preview-replaced', committed.receipt)
    return result({
      outcome: 'preview-replaced',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      receipt: committed.receipt as unknown as JsonObject,
      history: history as unknown as JsonObject
    }, `Replaced timeline media at revision ${committed.project.currentRevision}`)
  }





}
