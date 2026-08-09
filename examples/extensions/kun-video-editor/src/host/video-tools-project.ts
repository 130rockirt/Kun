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
import { VideoEditorToolsMedia } from './video-tools-media.js'

export class VideoEditorToolsProject extends VideoEditorToolsMedia {
  protected async videoUndo(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const committed = await this.service().undoAgent(
      projectId,
      expectedRevision,
      agentActorId(invocation)
    )
    await this.publishProjectChange(committed.project, 'agent-undo', committed.receipt)
    return mutationResult('undone', committed.receipt, committed.project,
      `Undid the Agent's eligible video edit at revision ${committed.project.currentRevision}`)
  }

  protected async videoProject(
    input: ToolInput,
    source: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, ['action', 'projectId', 'name', 'fps', 'canvasPreset', 'expectedRevision'])
    const action = enumValue(
      input.action,
      ['active', 'list', 'get', 'create', 'select'] as const,
      'action'
    )
    const service = this.service()
    if (action === 'active') return this.activeProject(service)
    if (action === 'list') {
      const listed = await service.listProjectsWithDiagnostics()
      const projects = listed.projects
      const bounded = projects.slice(0, MAX_PROJECTS)
      return result({
        outcome: 'listed',
        workspaceId: this.workspaceId(),
        projects: bounded,
        diagnostics: listed.diagnostics.slice(0, MAX_PROJECTS),
        truncated: projects.length > bounded.length
      }, `Listed ${bounded.length} video projects`)
    }

    const projectId = stableId(input.projectId, 'projectId')
    if (action === 'create') {
      const name = boundedString(input.name, 'name', 1, 160)
      const fps = input.fps === undefined ? undefined : rational(input.fps, 'fps')
      const canvasPreset = input.canvasPreset === undefined
        ? undefined
        : enumValue(input.canvasPreset, ['16:9', '9:16', '1:1'] as const, 'canvasPreset')
      const project = await service.createProject({ id: projectId, name, fps, canvasPreset })
      await this.selectActiveProject(project, 'created', source)
      await this.publishProjectChange(project, 'project-created', ['project'])
      return result({
        outcome: 'created',
        workspaceId: this.workspaceId(),
        project: await this.projectViewProjection(project),
        truncated: projectProjectionIsTruncated(project)
      }, `Created video project ${project.id}`)
    }

    const project = await service.loadProject(projectId)
    if (input.expectedRevision !== undefined) {
      assertExpectedRevision(project, nonNegativeInteger(input.expectedRevision, 'expectedRevision'))
    }
    if (action === 'select') {
      await this.selectActiveProject(project, 'selected', source)
    }
    return result({
      outcome: action === 'select' ? 'selected' : 'loaded',
      workspaceId: this.workspaceId(),
      project: await this.projectViewProjection(project),
      truncated: projectProjectionIsTruncated(project)
    }, `${action === 'select' ? 'Selected' : 'Loaded'} video project ${project.id} revision ${project.currentRevision}`)
  }

  protected async activeProject(service: ProjectService): Promise<ToolResult> {
    const value = await this.context.storage.workspace.get<JsonValue>(ACTIVE_PROJECT_KEY)
    if (value === undefined) {
      return result({
        outcome: 'no-active-project',
        workspaceId: this.workspaceId()
      }, 'No video project is active in this workspace')
    }

    const stored = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as ToolInput
      : undefined
    let projectId: string | undefined
    try {
      if (stored?.schemaVersion === 1) projectId = stableId(stored.projectId, 'active projectId')
    } catch {
      projectId = undefined
    }
    if (!projectId) {
      await this.context.storage.workspace.delete(ACTIVE_PROJECT_KEY)
      return result({
        outcome: 'stale-active-project',
        workspaceId: this.workspaceId()
      }, 'The stored active video project was invalid and has been cleared')
    }

    let project: VideoProject
    try {
      project = await service.loadProject(projectId)
    } catch (error) {
      await this.context.storage.workspace.delete(ACTIVE_PROJECT_KEY)
      return result({
        outcome: 'stale-active-project',
        workspaceId: this.workspaceId(),
        projectId,
        diagnosticCode: error instanceof VideoEngineError ? error.code : 'invalid_project'
      }, `The active video project ${projectId} is unavailable and was cleared`)
    }

    return result({
      outcome: 'active',
      workspaceId: this.workspaceId(),
      project: await this.projectViewProjection(project),
      truncated: projectProjectionIsTruncated(project)
    }, `Resolved active video project ${project.id} revision ${project.currentRevision}`)
  }

  protected async selectActiveProject(
    project: VideoProject,
    transition: 'created' | 'selected',
    source: RevisionAuthor
  ): Promise<void> {
    const previousProjectId = await this.storedActiveProjectId()
    await this.context.storage.workspace.set(ACTIVE_PROJECT_KEY, {
      schemaVersion: 1,
      projectId: project.id
    })
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.project-changed',
      payload: {
        schemaVersion: 1,
        projectId: project.id,
        activeProjectId: project.id,
        previousProjectId: previousProjectId ?? null,
        revision: project.currentRevision,
        generation: project.eventGeneration,
        sequenceId: project.activeSequenceId,
        selectionGeneration: project.selection.generation,
        reason: 'active-project-changed',
        transition,
        source,
        changedIds: ['active-project']
      }
    })
  }

  protected async storedActiveProjectId(): Promise<string | undefined> {
    const value = await this.context.storage.workspace.get<JsonValue>(ACTIVE_PROJECT_KEY)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const stored = value as ToolInput
    if (stored.schemaVersion !== 1) return undefined
    try {
      return stableId(stored.projectId, 'active projectId')
    } catch {
      return undefined
    }
  }

  protected async videoReadScript(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision'])
    const project = await this.service().loadProject(stableId(input.projectId, 'projectId'))
    if (input.expectedRevision !== undefined) {
      assertExpectedRevision(project, nonNegativeInteger(input.expectedRevision, 'expectedRevision'))
    }
    const markdown = generateTimelineMarkdown(project)
    const header = parseTimelineScriptHeader(markdown)
    const bytes = Buffer.byteLength(markdown, 'utf8')
    const bounded = bytes <= MAX_SCRIPT_BYTES
      ? markdown
      : `${Buffer.from(markdown, 'utf8').subarray(0, MAX_SCRIPT_BYTES).toString('utf8')}\n\n[projection truncated]\n`
    return result({
      outcome: 'script',
      projectId: project.id,
      currentRevision: project.currentRevision,
      digest: header.digest,
      timelineMarkdown: bounded,
      truncated: bytes > MAX_SCRIPT_BYTES,
      totalBytes: bytes
    }, `Read timeline.md for revision ${project.currentRevision}`)
  }

  protected async videoProbeBatch(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'expectedRevision', 'items', 'folderId', 'addToTimeline'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    const folderId = input.folderId === undefined ? undefined : stableId(input.folderId, 'folderId')
    const addToTimeline = optionalBoolean(input.addToTimeline, 'addToTimeline') ?? true
    const requests = boundedArray(input.items, 'items', 1, 64).map((value, index) => {
      const item = asRecord(value, `items[${index}]`)
      exactKeys(item, ['mediaHandleId', 'assetId', 'assetKind', 'stillDurationFrames'])
      return {
        mediaHandleId: opaqueHandle(item.mediaHandleId, `items[${index}].mediaHandleId`),
        ...(item.assetId === undefined ? {} : { assetId: stableId(item.assetId, `items[${index}].assetId`) }),
        ...(item.assetKind === undefined ? {} : {
          assetKind: enumValue(item.assetKind, ['image', 'animation'] as const, `items[${index}].assetKind`)
        }),
        ...(item.stillDurationFrames === undefined ? {} : {
          stillDurationFrames: boundedPositiveInteger(
            item.stillDurationFrames,
            `items[${index}].stillDurationFrames`,
            1,
            1_080_000
          )
        })
      }
    })

    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun could not inspect local ffprobe availability. No selected media was bound to the project.'
      }, 'Media capability inspection unavailable for atomic batch import')
    }
    if (!capabilities.ffprobe.available) {
      return result({
        outcome: 'unavailable',
        code: 'FFPROBE_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun cannot import the selected media because ffprobe is unavailable. No selected media was bound to the project.'
      }, 'ffprobe is unavailable for atomic batch import')
    }

    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing Host-granted media', fraction: 0.1 })
    const assets = await Promise.all(requests.map(async (request, index) => {
      const metadata = await this.context.media.stat({ handleId: request.mediaHandleId })
      const probe = await this.context.media.probe({ handleId: request.mediaHandleId })
      const assetId = request.assetId ??
        `asset-${createHash('sha256').update(metadata.handleId).digest('hex').slice(0, 16)}`
      const asset = assetFromProbe(assetId, metadata, probe, {
        ...(request.assetKind ? { assetKind: request.assetKind } : {}),
        ...(request.stillDurationFrames === undefined ? {} : {
          stillDurationFrames: request.stillDurationFrames
        }),
        fps: current.fps
      })
      if (folderId) asset.folderId = folderId
      if (current.assets.some(({ id }) => id === asset.id)) {
        throw new ToolInputError(
          `Asset ${asset.id} from items[${index}] already exists; use its existing stable identity.`
        )
      }
      return asset
    }))

    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing Host-granted media', fraction: 0.55 })
    let candidate = planBatchMediaImport(current, assets).project
    if (addToTimeline) {
      for (const asset of assets) {
        candidate = applyTimelineOperations(candidate, [{ type: 'add-item', item: initialItem(candidate, asset) }]).project
      }
    }
    const committed = await this.service().saveProjectWithReceipt(candidate, expectedRevision, {
      author: 'manual',
      sourceOperation: 'media.import-batch',
      summary: `Imported and probed ${assets.length} media assets atomically`
    })
    await this.publishProjectChange(committed.project, 'assets-imported', committed.receipt)
    await invocation.reportProgress({ message: 'Media import complete', fraction: 1 })
    return result({
      outcome: 'imported-batch',
      projectId,
      previousRevision: expectedRevision,
      currentRevision: committed.project.currentRevision,
      importedCount: assets.length,
      receipt: committed.receipt as unknown as JsonObject,
      assets: assets.map(assetProjection)
    }, `Imported ${assets.length} media assets at revision ${committed.project.currentRevision}`)
  }

  protected async videoProbe(
    input: ToolInput,
    invocation: ToolInvocationContext,
    author: RevisionAuthor = 'agent'
  ): Promise<ToolResult> {
    exactKeys(input, [
      'projectId',
      'expectedRevision',
      'mediaHandleId',
      'assetId',
      'assetKind',
      'folderId',
      'stillDurationFrames',
      'addToTimeline',
      'thumbnailOutputHandleId',
      'waveformOutputHandleId'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const current = await this.service().loadProject(projectId)
    assertExpectedRevision(current, expectedRevision)
    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun could not inspect local ffprobe availability. Install or configure the local media tools and retry; no project data was changed.'
      }, 'Media capability inspection unavailable')
    }
    if (!capabilities.ffprobe.available) {
      return result({
        outcome: 'unavailable',
        code: 'FFPROBE_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun cannot import this media because ffprobe is unavailable. Install or configure ffprobe and retry; no project data was changed.'
      }, 'ffprobe is unavailable for media import')
    }
    if (
      !capabilities.ffmpeg.available &&
      (input.thumbnailOutputHandleId !== undefined || input.waveformOutputHandleId !== undefined)
    ) {
      return result({
        outcome: 'unavailable',
        code: 'FFMPEG_UNAVAILABLE',
        projectId,
        currentRevision: expectedRevision,
        changedIds: [],
        retryable: true,
        message: 'Kun cannot generate the requested thumbnail or waveform because FFmpeg is unavailable. Retry without derived outputs, or install or configure FFmpeg; no project data was changed.'
      }, 'FFmpeg is unavailable for derived media')
    }
    let metadata: MediaMetadata
    if (input.mediaHandleId === undefined) {
      let selection
      try {
        selection = await this.context.media.pickFiles({
          multiple: false,
          maxFiles: 1,
          filters: [{
            name: 'Video, audio, and images',
            extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4a', 'mp3', 'wav', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'],
            mimeTypes: ['video/*', 'audio/*', 'image/*']
          }]
        })
      } catch (error) {
        const interaction = interactionRequired(error, 'Select media in the Kun desktop editor, then retry with the granted mediaHandleId.')
        if (interaction) return result(interaction, 'Media import requires protected interaction')
        throw error
      }
      if (selection.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Media selection was cancelled.' }, 'Media selection cancelled')
      }
      metadata = selection.files[0]!
    } else {
      const handleId = opaqueHandle(input.mediaHandleId, 'mediaHandleId')
      metadata = await this.context.media.stat({ handleId })
    }

    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Probing Host-granted media', fraction: 0.2 })
    const probe = await this.context.media.probe({ handleId: metadata.handleId })
    const assetId = input.assetId === undefined
      ? `asset-${createHash('sha256').update(metadata.handleId).digest('hex').slice(0, 16)}`
      : stableId(input.assetId, 'assetId')
    const assetKind = input.assetKind === undefined
      ? undefined
      : enumValue(input.assetKind, ['image', 'animation'] as const, 'assetKind')
    const stillDurationFrames = input.stillDurationFrames === undefined
      ? undefined
      : boundedPositiveInteger(input.stillDurationFrames, 'stillDurationFrames', 1, 1_080_000)
    const folderId = input.folderId === undefined ? undefined : stableId(input.folderId, 'folderId')
    const asset = assetFromProbe(assetId, metadata, probe, {
      ...(assetKind ? { assetKind } : {}),
      ...(stillDurationFrames === undefined ? {} : { stillDurationFrames }),
      fps: current.fps
    })
    if (folderId) asset.folderId = folderId
    if (current.assets.some(({ id }) => id === asset.id)) {
      throw new ToolInputError(`Asset ${asset.id} already exists; use its existing stable identity.`)
    }

    let candidate = planBatchMediaImport(current, [asset]).project
    if (input.addToTimeline !== false) {
      const item = initialItem(candidate, asset)
      candidate = applyTimelineOperations(candidate, [{ type: 'add-item', item }]).project
    }
    const committed = await this.service().saveProjectWithReceipt(candidate, expectedRevision, {
      author,
      ...(author === 'agent' ? { actorId: agentActorId(invocation) } : {}),
      sourceOperation: 'video-probe',
      summary: `Imported and probed ${asset.name}`
    })
    const saved = committed.project
    await this.publishProjectChange(saved, 'asset-imported', committed.receipt)
    await invocation.reportProgress({ message: 'Persisted probed asset metadata', fraction: 0.65 })

    const jobs: JsonObject[] = []
    if (input.thumbnailOutputHandleId !== undefined) {
      const outputHandle = opaqueHandle(input.thumbnailOutputHandleId, 'thumbnailOutputHandleId')
      const started = await this.context.media.startFfmpegJob({
        arguments: [
          '-nostdin', '-i', '{{input:source}}', '-frames:v', '1', '-vf', 'scale=640:-2',
          '-f', 'image2', '{{output:thumbnail}}'
        ],
        inputs: { source: metadata.handleId },
        outputs: { thumbnail: outputHandle },
        idempotencyKey: `${invocation.invocation.invocationId}:thumbnail`,
        metadata: { projectId, revision: saved.currentRevision, assetId, derivedKind: 'thumbnail' }
      })
      jobs.push(jobReferenceProjection(started.job, 'thumbnail'))
    }
    if (input.waveformOutputHandleId !== undefined) {
      const outputHandle = opaqueHandle(input.waveformOutputHandleId, 'waveformOutputHandleId')
      const started = await this.context.media.startFfmpegJob({
        arguments: [
          '-nostdin', '-i', '{{input:source}}', '-filter_complex',
          'showwavespic=s=1200x240:colors=white', '-frames:v', '1', '-f', 'image2',
          '{{output:waveform}}'
        ],
        inputs: { source: metadata.handleId },
        outputs: { waveform: outputHandle },
        idempotencyKey: `${invocation.invocation.invocationId}:waveform`,
        metadata: { projectId, revision: saved.currentRevision, assetId, derivedKind: 'waveform' }
      })
      jobs.push(jobReferenceProjection(started.job, 'waveform'))
    }
    await invocation.reportProgress({ message: 'Media import complete', fraction: 1 })
    return result({
      outcome: 'imported',
      projectId,
      currentRevision: saved.currentRevision,
      receipt: committed.receipt,
      asset: assetProjection(asset),
      metadata: probeProjection(probe),
      jobs
    }, `Imported ${asset.name} at revision ${saved.currentRevision}`)
  }

}
