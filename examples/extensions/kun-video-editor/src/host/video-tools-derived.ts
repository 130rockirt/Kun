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
import { VideoEditorToolsInterchange } from './video-tools-interchange.js'

export class VideoEditorToolsDerived extends VideoEditorToolsInterchange {
  protected async videoDerivedList(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId'])
    const projectId = stableId(input.projectId, 'projectId')
    await this.service().loadProject(projectId)
    const listed = await this.derivedService().list(projectId)
    return result({
      outcome: 'listed',
      projectId,
      records: listed.records,
      usage: listed.usage,
      recoveryDiagnostics: listed.recoveryDiagnostics
    }, `Listed ${listed.records.length} derived media records`)
  }

  protected async videoDerivedStart(input: ToolInput, retry = false): Promise<ToolResult> {
    exactKeys(input, [
      'projectId',
      'expectedRevision',
      'assetId',
      'kind',
      'outputHandleId',
      'priority',
      'parameters',
      ...(retry ? ['recordId'] : [])
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, nonNegativeInteger(input.expectedRevision, 'expectedRevision'))
    const kind = enumValue(
      input.kind,
      ['waveform', 'thumbnail', 'filmstrip', 'proxy', 'proof', 'preview'] as const,
      'kind'
    )
    const started = await this.derivedService().start({
      project,
      assetId: stableId(input.assetId, 'assetId'),
      kind,
      ...(input.outputHandleId === undefined
        ? {}
        : { outputHandleId: opaqueHandle(input.outputHandleId, 'outputHandleId') }),
      ...(input.priority === undefined ? {} : {
        priority: enumValue(
          input.priority,
          ['background', 'user', 'interactive', 'export'] as const,
          'priority'
        )
      }),
      ...(input.parameters === undefined ? {} : {
        normalizedParameters: asRecord(input.parameters, 'parameters')
      }),
      ...(retry ? { retryRecordId: stableId(input.recordId, 'recordId') } : {})
    })
    return result({
      outcome: started.outcome,
      projectId,
      currentRevision: project.currentRevision,
      record: started.record,
      jobId: started.jobId ?? null,
      message: started.message ?? null
    }, `${started.outcome === 'queued' ? 'Queued' : 'Resolved'} ${kind} derived media`)
  }

  protected async videoDerivedCancel(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'recordId'])
    const projectId = stableId(input.projectId, 'projectId')
    const record = await this.derivedService().cancel(
      projectId,
      stableId(input.recordId, 'recordId')
    )
    return result({ outcome: 'cancelled', projectId, record }, 'Cancelled derived media work')
  }

  protected async videoDerivedCleanup(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, ['projectId', 'includeReady'])
    const projectId = stableId(input.projectId, 'projectId')
    const includeReady = input.includeReady === true
    const cleaned = await this.derivedService().cleanup(projectId, includeReady)
    return result({
      outcome: 'cleaned',
      projectId,
      removedIds: cleaned.removedIds,
      usage: cleaned.usage
    }, `Removed ${cleaned.removedIds.length} derived media records`)
  }

  protected async videoInspect(input: ToolInput): Promise<ToolResult> {
    exactKeys(input, [
      'action', 'projectId', 'expectedRevision', 'expectedGeneration', 'sequenceId',
      'startFrame', 'endFrame', 'itemLimit', 'captionLimit', 'includeCaptionText',
      'includeEffects', 'includeKeyframes', 'assetId', 'transcriptId', 'segmentOffset',
      'segmentLimit', 'includeWords', 'sampleFrames', 'frame', 'folderId', 'query',
      'offset', 'limit', 'previewEntryIds', 'document', 'assetIds', 'missingMediaPolicy',
      'includeReceipts', 'includeChatProvenance', 'groupId'
    ])
    const action = enumValue(
      input.action,
      [
        'context', 'project-window', 'raw-media', 'composed-frame', 'catalog',
        'media-library', 'preview-history', 'selection-attachment', 'export-capabilities',
        'otio-export-preview', 'otio-import-preview', 'project-package-preflight', 'multicam'
      ] as const,
      'action'
    )
    if (action === 'catalog') {
      return result({ outcome: 'catalog', catalog: boundedEffectCatalog() as unknown as JsonObject },
        'Read the bounded video effects, blend, text-animation, and keyframe catalog')
    }
    if (action === 'export-capabilities') {
      try {
        const capabilities = await this.context.media.getCapabilities()
        return result({
          outcome: 'export-capabilities',
          capabilities: professionalExportCapabilityProjection(capabilities)
        }, 'Read the probed professional export and deterministic CPU fallback capabilities')
      } catch {
        return result({
          outcome: 'unavailable',
          code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
          retryable: true,
          message: 'Kun could not inspect the local FFmpeg capability inventory; no codec or GPU capability was assumed.'
        }, 'Professional export capability inspection is unavailable')
      }
    }
    if (action === 'otio-import-preview') {
      if (input.document === undefined) {
        throw new ToolInputError('otio-import-preview requires an inline OTIO JSON document.')
      }
      const imported = importProjectFromOtio(asRecord(input.document, 'document'))
      const mappings = interchangeMappingPreview(imported.timecodeMappings)
      return result({
        outcome: 'otio-import-preview',
        adapterId: imported.adapterId,
        adapterVersion: imported.adapterVersion,
        sourceDocumentDigest: imported.sourceDocumentDigest,
        fidelity: imported.fidelity,
        project: interchangeProjectSummary(imported.project),
        mediaRelinkRequired: imported.mediaRelinkRequired,
        timecodeMappings: mappings.items as unknown as JsonValue,
        timecodeMappingsTruncated: mappings.truncated,
        lossManifest: imported.lossManifest as unknown as JsonValue,
        persisted: false,
        message: 'The OTIO document was validated and normalized in memory only; no project or media grant was changed.'
      }, `Validated OTIO import preview for ${imported.project.id} without persisting it`)
    }
    const projectId = input.projectId === undefined
      ? await this.storedActiveProjectId()
      : stableId(input.projectId, 'projectId')
    if (!projectId) {
      if (action !== 'context') throw new ToolInputError(`${action} requires projectId.`)
      return result({
        outcome: 'no-active-context',
        workspaceId: this.workspaceId()
      }, 'No active video project or selection context exists in this workspace')
    }
    const project = await this.service().loadProject(projectId)
    const expectedRevision = input.expectedRevision === undefined
      ? undefined
      : nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const sequenceId = input.sequenceId === undefined
      ? undefined
      : stableId(input.sequenceId, 'sequenceId')

    if (action === 'otio-export-preview') {
      if (expectedRevision === undefined) {
        throw new ToolInputError('otio-export-preview requires expectedRevision to pin the exported project snapshot.')
      }
      assertExpectedRevision(project, expectedRevision)
      const exported = exportProjectToOtio(project)
      const bytes = serializeOtioInterchange(exported)
      const mappings = interchangeMappingPreview(exported.timecodeMappings)
      const documentInline = bytes.byteLength <= INLINE_OTIO_PREVIEW_BYTES
      return result({
        outcome: 'otio-export-preview',
        adapterId: exported.adapterId,
        adapterVersion: exported.adapterVersion,
        projectId: exported.projectId,
        projectRevision: exported.projectRevision,
        documentDigest: exported.documentDigest,
        projectDigest: exported.projectDigest,
        documentBytes: bytes.byteLength,
        documentInline,
        document: documentInline ? exported.document as unknown as JsonValue : null,
        timecodeMappings: mappings.items as unknown as JsonValue,
        timecodeMappingsTruncated: mappings.truncated,
        lossManifest: exported.lossManifest as unknown as JsonValue,
        durableExportAvailable: false,
        message: documentInline
          ? 'This bounded OTIO JSON is an inline preview. Kun has not written a durable export artifact.'
          : 'The OTIO document exceeds the bounded inline preview limit. Kun needs an atomic JSON output broker before it can write a durable artifact.'
      }, `Prepared revision ${expectedRevision} OTIO interchange preview with an explicit loss manifest`)
    }

    if (action === 'project-package-preflight') {
      if (expectedRevision === undefined) {
        throw new ToolInputError('project-package-preflight requires expectedRevision to pin the project snapshot.')
      }
      assertExpectedRevision(project, expectedRevision)
      return await this.projectPackagePreflight(project, input)
    }

    if (action === 'context') {
      const context = resolveProjectContext(project, {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(input.expectedGeneration === undefined ? {} : {
          expectedGeneration: nonNegativeInteger(input.expectedGeneration, 'expectedGeneration')
        }),
        ...(sequenceId ? { sequenceId } : {})
      })
      return result({ outcome: 'context', context },
        `Resolved ${context.status} video context at revision ${context.revision}`)
    }
    if (expectedRevision !== undefined) assertExpectedRevision(project, expectedRevision)

    if (action === 'project-window') {
      const window = readCompactProjectWindow(project, {
        ...(sequenceId ? { sequenceId } : {}),
        startFrame: nonNegativeInteger(input.startFrame, 'startFrame'),
        endFrame: nonNegativeInteger(input.endFrame, 'endFrame'),
        ...(input.itemLimit === undefined ? {} : {
          itemLimit: boundedPositiveInteger(input.itemLimit, 'itemLimit', 1, 200)
        }),
        ...(input.captionLimit === undefined ? {} : {
          captionLimit: boundedPositiveInteger(input.captionLimit, 'captionLimit', 1, 100)
        }),
        includeCaptionText: optionalBoolean(input.includeCaptionText, 'includeCaptionText') ?? false,
        includeEffects: optionalBoolean(input.includeEffects, 'includeEffects') ?? false,
        includeKeyframes: optionalBoolean(input.includeKeyframes, 'includeKeyframes') ?? false
      })
      return result({ outcome: 'project-window', window },
        `Read compact project window at revision ${window.revision}`)
    }

    if (action === 'raw-media') {
      const inspection = inspectRawMedia(project, {
        assetId: stableId(input.assetId, 'assetId'),
        ...(input.transcriptId === undefined ? {} : {
          transcriptId: stableId(input.transcriptId, 'transcriptId')
        }),
        ...(input.segmentOffset === undefined ? {} : {
          segmentOffset: nonNegativeInteger(input.segmentOffset, 'segmentOffset')
        }),
        ...(input.segmentLimit === undefined ? {} : {
          segmentLimit: boundedPositiveInteger(input.segmentLimit, 'segmentLimit', 1, 100)
        }),
        includeWords: optionalBoolean(input.includeWords, 'includeWords') ?? false,
        ...(input.sampleFrames === undefined ? {} : {
          sampleFrames: boundedArray(input.sampleFrames, 'sampleFrames', 0, 16)
            .map((value, index) => nonNegativeInteger(value, `sampleFrames[${index}]`))
        })
      })
      return result({ outcome: 'raw-media', inspection },
        `Inspected raw media evidence for ${inspection.asset.id}`)
    }

    if (action === 'media-library') {
      const page = mediaLibraryPage(project, {
        ...(input.folderId === undefined ? {} : { folderId: stableId(input.folderId, 'folderId') }),
        ...(input.query === undefined ? {} : { query: boundedString(input.query, 'query', 0, 256) }),
        ...(input.offset === undefined ? {} : { offset: nonNegativeInteger(input.offset, 'offset') }),
        ...(input.limit === undefined ? {} : {
          limit: boundedPositiveInteger(input.limit, 'limit', 1, 100)
        })
      })
      return result({
        outcome: 'media-library',
        projectId,
        revision: project.currentRevision,
        folders: (project.mediaFolders ?? []).slice(0, MAX_MEDIA_FOLDERS),
        foldersTruncated: (project.mediaFolders?.length ?? 0) > MAX_MEDIA_FOLDERS,
        page: {
          ...page,
          assets: page.assets.map(assetProjection)
        }
      }, `Read ${page.assets.length} of ${page.total} media library assets`)
    }

    if (action === 'preview-history') {
      const history = await this.loadPreviewHistory(projectId)
      return result({ outcome: 'preview-history', history: history as unknown as JsonObject },
        `Read ${history.entries.length} bounded preview entries`)
    }

    if (action === 'selection-attachment') {
      if (expectedRevision === undefined) {
        throw new ToolInputError('selection-attachment requires expectedRevision.')
      }
      const history = await this.loadPreviewHistory(projectId)
      const previewEntryIds = input.previewEntryIds === undefined
        ? []
        : boundedArray(input.previewEntryIds, 'previewEntryIds', 0, 64)
          .map((entry, index) => stableId(entry, `previewEntryIds[${index}]`))
      const knownEntries = new Set(history.entries.map(({ id }) => id))
      const missing = previewEntryIds.find((id) => !knownEntries.has(id))
      if (missing) throw new ToolInputError(`Preview history entry does not exist: ${missing}`)
      const attachment = buildVideoSelectionAttachment(project, previewEntryIds)
      return result({ outcome: 'selection-attachment', attachment: attachment as unknown as JsonObject },
        `Read revision-bound selection attachment at revision ${project.currentRevision}`)
    }

    if (action === 'multicam') {
      const groups = (project.multicamGroups ?? []).slice(0, MAX_MULTICAM_GROUPS)
      if (input.groupId === undefined) {
        return result({
          outcome: 'multicam',
          projectId,
          currentRevision: project.currentRevision,
          groups: groups.map(multicamGroupProjection),
          hiddenGroupCount: Math.max(0, (project.multicamGroups?.length ?? 0) - groups.length)
        }, `Read ${groups.length} bounded multicam groups at revision ${project.currentRevision}`)
      }
      const groupId = stableId(input.groupId, 'groupId')
      const group = groups.find(({ id }) => id === groupId) ??
        (project.multicamGroups ?? []).find(({ id }) => id === groupId)
      if (!group) throw new ToolInputError(`Multicam group does not exist: ${groupId}`)
      const program = inspectMulticamProgram(project, groupId)
      let renderReady = false
      let irDigest: string | null = null
      let renderRefusal: string | null = null
      try {
        irDigest = renderIrDigest(compileMulticamProgramIr(project, groupId))
        renderReady = true
      } catch (error) {
        renderRefusal = boundedPublicErrorMessage(error)
      }
      return result({
        outcome: 'multicam',
        projectId,
        currentRevision: project.currentRevision,
        group: multicamGroupProjection(group),
        program: program as unknown as JsonObject,
        renderReady,
        renderIrDigest: irDigest,
        renderRefusal
      }, `Inspected multicam program ${groupId} at revision ${project.currentRevision}`)
    }

    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId,
        currentRevision: project.currentRevision,
        message: 'Composed inspection requires a current bounded render capability report.'
      }, 'Composed inspection capability report is unavailable')
    }
    const inspection = inspectComposedTimeline(
      project,
      nonNegativeInteger(input.frame, 'frame'),
      ffmpegRenderBackendCapabilities(capabilities),
      await this.proofBindings(projectId),
      sequenceId ?? project.activeSequenceId
    )
    return result({ outcome: 'composed-frame', inspection },
      `Inspected composed frame ${inspection.frameLabel} at revision ${inspection.revision}`, {
        technicallyValidated: false,
        visuallyInspected: false,
        proofStatus: inspection.proofStatus
      })
  }

}
