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
import { VideoEditorToolsRender } from './video-tools-render.js'

export class VideoEditorToolsMedia extends VideoEditorToolsRender {
  protected async videoReauthorize(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'assetId', 'mediaHandleId'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const assetId = stableId(input.assetId, 'assetId')
    const mediaHandleId = opaqueHandle(input.mediaHandleId, 'mediaHandleId')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    const assetIndex = current.assets.findIndex(({ id }) => id === assetId)
    if (assetIndex < 0) throw new ToolInputError(`Asset ${assetId} does not exist.`)
    const previous = current.assets[assetIndex]!
    const metadata = await this.context.media.stat({ handleId: mediaHandleId })
    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing replacement media grant', fraction: 0.25 })
    const probe = await this.context.media.probe({ handleId: mediaHandleId })
    const replacement = {
      ...assetFromProbe(assetId, metadata, probe, {
        ...(previous.kind === 'image' || previous.kind === 'animation'
          ? { assetKind: previous.kind, stillDurationUs: previous.durationUs }
          : {}),
        fps: current.fps
      }),
      name: previous.name,
      transcriptIds: [...previous.transcriptIds],
      ...(previous.folderId ? { folderId: previous.folderId } : {}),
      ...(previous.generatedLineage ? { generatedLineage: structuredClone(previous.generatedLineage) } : {})
    }
    if (replacement.kind !== previous.kind) {
      throw new ToolInputError(
        `Replacement media kind ${replacement.kind} does not match ${previous.kind} asset ${assetId}.`
      )
    }
    const committed = await this.service().relinkMedia(projectId, expectedRevision, {
      assetId,
      replacement
    }, {
      author: 'manual',
      sourceOperation: 'media.reauthorize',
      summary: `Reauthorized ${previous.name}`
    })
    const saved = committed.project
    const savedAsset = saved.assets.find(({ id }) => id === assetId) ?? replacement
    await this.derivedService().synchronizeProject(saved)
    await this.publishProjectChange(saved, 'asset-reauthorized', committed.receipt)
    if (previous.mediaHandleId && previous.mediaHandleId !== mediaHandleId) {
      await this.context.media.release({
        resource: 'handle',
        handleId: previous.mediaHandleId
      }).catch(() => undefined)
    }
    await invocation.reportProgress({ message: 'Replacement media grant saved', fraction: 1 })
    return result({
      outcome: 'reauthorized',
      projectId,
      currentRevision: saved.currentRevision,
      receipt: committed.receipt,
      asset: assetProjection(savedAsset)
    }, `Reauthorized ${previous.name} at revision ${saved.currentRevision}`)
  }

  protected async videoTranscribe(
    input: ToolInput,
    author: RevisionAuthor = 'agent',
    invocation?: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'assetId', 'transcriptId', 'mode', 'format',
      'language', 'source', 'segments'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const assetId = stableId(input.assetId, 'assetId')
    const transcriptId = stableId(input.transcriptId, 'transcriptId')
    const mode = enumValue(input.mode, ['import', 'local-asr'] as const, 'mode')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const asset = project.assets.find(({ id }) => id === assetId)
    if (!asset) throw new ToolInputError(`Asset ${assetId} does not exist in project ${projectId}.`)

    if (mode === 'local-asr') {
      return result({
        outcome: 'unavailable',
        projectId,
        previousRevision: expectedRevision,
        currentRevision: expectedRevision,
        changedIds: [],
        summary: 'Local ASR execution is unavailable through the negotiated Extension API. Import a timed SRT, VTT, or JSON transcript; no media was uploaded and no text was invented.',
        details: { code: 'transcriber_unavailable', networkUsed: false }
      }, 'Local transcriber unavailable')
    }

    if ((input.source === undefined) === (input.segments === undefined)) {
      throw new ToolInputError('Transcript import requires exactly one of source or segments.')
    }
    const language = input.language === undefined
      ? undefined
      : boundedString(input.language, 'language', 1, 32)
    const format = input.segments === undefined
      ? enumValue(input.format, ['srt', 'vtt', 'json'] as const, 'format')
      : 'json'
    const source = input.segments === undefined
      ? boundedString(input.source, 'source', 1, 524_288)
      : JSON.stringify({
          segments: boundedArray(input.segments, 'segments', 1, 20_000).map(transcriptSegmentInput)
        })
    const transcript = importTranscript(source, { format, transcriptId, asset, language })
    const candidate = structuredClone(project)
    const existingIndex = candidate.transcripts.findIndex(({ id }) => id === transcript.id)
    if (existingIndex >= 0) candidate.transcripts[existingIndex] = transcript
    else candidate.transcripts.push(transcript)
    const candidateAsset = candidate.assets.find(({ id }) => id === assetId)!
    candidateAsset.transcriptIds = [...new Set([...candidateAsset.transcriptIds, transcript.id])].sort()
    const committed = await this.service().saveProjectWithReceipt(candidate, expectedRevision, {
      author,
      ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
      sourceOperation: 'video-transcribe',
      summary: `Imported ${transcript.provenance.toUpperCase()} transcript ${transcript.id}`
    })
    const saved = committed.project
    const changedIds = [assetId, transcript.id]
    await this.publishProjectChange(saved, 'transcript-imported', committed.receipt)
    return result({
      outcome: 'transcribed',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds,
      receipt: committed.receipt,
      summary: `Imported ${transcript.segments.length} timed transcript segments without network access.`,
      details: transcriptProjection(transcript, MAX_TRANSCRIPT_SEGMENTS)
    }, `Imported transcript at revision ${saved.currentRevision}`)
  }

  protected async videoApplyScript(
    input: ToolInput,
    author: RevisionAuthor = 'agent',
    invocation?: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'timelineMarkdown', 'ranges', 'summary'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const markdown = boundedString(input.timelineMarkdown, 'timelineMarkdown', 1, 262_144)
    const ranges = boundedArray(input.ranges, 'ranges', 1, 2_000).map(assetRange)
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    if (author === 'agent') assertTimedTranscriptEvidence(project, ranges)
    const applied = applyTimelineScript(project, markdown, ranges)
    const summary = input.summary === undefined
      ? `Applied ${applied.removed.length} transcript-timed cuts`
      : boundedString(input.summary, 'summary', 1, 512)
    const committed = await this.service().saveProjectWithReceipt(applied.project, expectedRevision, {
      author,
      ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
      sourceOperation: 'video-apply-script',
      summary
    })
    const saved = committed.project
    await this.publishProjectChange(saved, 'script-applied', committed.receipt)
    return result({
      outcome: 'applied',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds: applied.changedIds,
      receipt: committed.receipt,
      summary,
      details: { removedRanges: applied.removed }
    }, `Applied timeline script at revision ${saved.currentRevision}`)
  }

  protected async videoGenerateCaptions(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'assetId', 'trackId', 'idPrefix', 'maxWords',
      'maxRenderedWidthPx', 'maxDurationFrames', 'placement', 'style', 'animation'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const trackId = input.trackId === undefined
      ? project.tracks.find(({ kind }) => kind === 'caption')?.id
      : stableId(input.trackId, 'trackId')
    if (!trackId) throw new ToolInputError('Caption generation requires an existing caption track.')
    const assetId = input.assetId === undefined ? undefined : stableId(input.assetId, 'assetId')
    const transcripts = assetId === undefined
      ? project.transcripts
      : project.transcripts.filter((transcript) => transcript.assetId === assetId)
    if (transcripts.length === 0) throw new ToolInputError('Caption generation requires a timed transcript.')
    const plan = buildEditableCaptions(project, transcripts, {
      trackId,
      ...(input.idPrefix === undefined ? {} : { idPrefix: boundedString(input.idPrefix, 'idPrefix', 1, 96) }),
      ...(input.maxWords === undefined ? {} : { maxWords: positiveInteger(input.maxWords, 'maxWords') }),
      ...(input.maxRenderedWidthPx === undefined
        ? {}
        : { maxRenderedWidthPx: positiveInteger(input.maxRenderedWidthPx, 'maxRenderedWidthPx') }),
      ...(input.maxDurationFrames === undefined
        ? {}
        : { maxDurationFrames: positiveInteger(input.maxDurationFrames, 'maxDurationFrames') }),
      ...(input.placement === undefined
        ? {}
        : { placement: enumValue(input.placement, ['top', 'center', 'bottom'] as const, 'placement') }),
      ...(input.style === undefined ? {} : { style: captionBuildStyle(input.style) }),
      ...(input.animation === undefined ? {} : { animation: captionBuildAnimation(input.animation) })
    })
    if (plan.operations.length === 0) {
      throw new ToolInputError('The selected transcript has no visible timed words on the active sequence.')
    }
    const committed = await this.service().applyOperationsWithReceipt(
      projectId,
      expectedRevision,
      plan.operations,
      {
        author: 'manual',
        sourceOperation: 'caption.generate',
        summary: `Generated ${plan.operations.length} editable transcript captions`
      }
    )
    await this.publishProjectChange(committed.project, 'captions-generated', committed.receipt)
    return result({
      outcome: 'generated',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      generatedCount: plan.operations.length,
      interpolatedWordCount: plan.interpolatedWordCount,
      warnings: plan.warnings,
      receipt: committed.receipt as unknown as JsonObject,
      captions: plan.captions.slice(0, MAX_CAPTIONS) as unknown as JsonValue,
      truncated: plan.captions.length > MAX_CAPTIONS
    }, `Generated ${plan.operations.length} editable captions at revision ${committed.project.currentRevision}`)
  }

  protected async videoUpdateTimeline(
    input: ToolInput,
    author: RevisionAuthor = 'agent',
    invocation?: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'operations', 'summary'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const operations = boundedArray(input.operations, 'operations', 1, 200)
      .map(strictTimelineOperation)
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    if (author === 'agent') assertAgentMulticamSyncAuthority(current, operations)
    const preview = applyTimelineOperations(current, operations)
    const summary = input.summary === undefined
      ? `Applied ${operations.length} structured timeline operations`
      : boundedString(input.summary, 'summary', 1, 512)
    const committed = await this.service().applyOperationsWithReceipt(projectId, expectedRevision, operations, {
      author,
      ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
      sourceOperation: 'video-update-timeline',
      summary
    })
    const saved = committed.project
    await this.publishProjectChange(saved, 'timeline-updated', committed.receipt)
    return result({
      outcome: 'updated',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: saved.currentRevision,
      changedIds: preview.changedIds,
      receipt: committed.receipt,
      summary,
      details: { operationCount: operations.length }
    }, `Updated timeline at revision ${saved.currentRevision}`)
  }

  protected async videoMulticamMutation(
    input: ToolInput,
    action: MulticamEditorAction
  ): Promise<ToolResult> {
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    const planned = planMulticamEditorAction(current, action, input)
    const preview = applyTimelineOperations(current, planned.operations)
    const committed = await this.service().applyOperationsWithReceipt(
      projectId,
      expectedRevision,
      planned.operations,
      {
        author: 'manual',
        sourceOperation: action,
        summary: planned.summary
      }
    )
    await this.publishProjectChange(committed.project, planned.reason, committed.receipt)
    return result({
      outcome: action.slice('multicam.'.length),
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      changedIds: preview.changedIds,
      receipt: committed.receipt,
      multicamGroups: (committed.project.multicamGroups ?? [])
        .slice(0, MAX_MULTICAM_GROUPS)
        .map(multicamGroupProjection)
    }, `${planned.summary} at revision ${committed.project.currentRevision}`)
  }

  protected async videoHistory(input: ToolInput, action: 'undo' | 'redo'): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const committed = action === 'undo'
      ? await this.service().undoWithReceipt(projectId, expectedRevision, 'manual')
      : await this.service().redoWithReceipt(projectId, expectedRevision, 'manual')
    const project = committed.project
    await this.publishProjectChange(project, `project-${action}`, committed.receipt)
    return result({
      outcome: action === 'undo' ? 'undone' : 'redone',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: project.currentRevision,
      changedIds: ['history'],
      receipt: committed.receipt,
      summary: `${action === 'undo' ? 'Undid' : 'Redid'} the previous project revision.`,
      details: { project: await this.projectViewProjection(project) }
    }, `${action === 'undo' ? 'Undid' : 'Redid'} project at revision ${project.currentRevision}`)
  }

}
