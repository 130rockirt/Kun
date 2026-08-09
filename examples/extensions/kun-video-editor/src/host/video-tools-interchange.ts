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
import { VideoEditorToolsContext } from './video-tools-context.js'

export class VideoEditorToolsInterchange extends VideoEditorToolsContext {
  protected async projectPackagePreflight(
    project: VideoProject,
    input: ToolInput
  ): Promise<ToolResult> {
    const receiptsRequested = optionalBoolean(input.includeReceipts, 'includeReceipts') ?? false
    const chatRequested = optionalBoolean(input.includeChatProvenance, 'includeChatProvenance') ?? false
    const selectedIds = packageAssetIds(project, input.assetIds)
    const missingMediaPolicy = packageMissingPolicy(input.missingMediaPolicy)
    const lastReceipt = this.service().getLastReceipt(project.id)
    const prepared = await prepareProjectPackageArchiveExport({
      context: this.context,
      project,
      includeMedia: [...selectedIds].sort(),
      missingMediaPolicy,
      ...(receiptsRequested && lastReceipt ? { receipts: [lastReceipt] } : {}),
      includeChatProvenance: false
    })
    const plan = prepared.plan
    return result({
      outcome: 'project-package-preflight',
      executable: true,
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      pinnedRevision: project.currentRevision,
      missingMediaPolicy,
      packageId: plan.packageId,
      manifestDigest: plan.manifestDigest,
      selectedAssetCount: plan.selectedAssetCount,
      embeddedAssetCount: plan.embeddedAssetCount,
      uniqueMediaCount: plan.uniqueMediaCount,
      deduplicatedAssetCount: plan.deduplicatedAssetCount,
      knownInputBytes: plan.knownInputBytes,
      complete: plan.complete,
      missingAssetIds: plan.missingAssetIds.slice(0, PACKAGE_PREFLIGHT_ASSET_PREVIEW_LIMIT),
      missingAssetIdsTruncated: Math.max(
        0,
        plan.missingAssetIds.length - PACKAGE_PREFLIGHT_ASSET_PREVIEW_LIMIT
      ),
      provenance: {
        receiptsRequested,
        receiptCount: plan.manifest.provenance.receiptCount,
        chatRequested,
        chatScope: chatRequested
          ? 'available only from an authenticated Agent tool invocation'
          : 'not-requested',
        generationLineageEntries: plan.manifest.provenance.generationLineageCount,
        revisionLedgerEntries: plan.manifest.provenance.revisionCount
      },
      engine: {
        schemaVersion: 1,
        selfContainedBuilderAvailable: true,
        cancellationAndRestartModelAvailable: true,
        integrityAlgorithm: 'sha256',
        binaryReader: 'opaque-host-handle',
        outputSink: 'atomic-durable-media-archive-job'
      },
      limits: {
        mediaAssets: PROJECT_PACKAGE_LIMITS.mediaAssets,
        mediaObjectBytes: PROJECT_PACKAGE_LIMITS.mediaObjectBytes,
        totalMediaBytes: PROJECT_PACKAGE_LIMITS.totalMediaBytes,
        packageBytes: PROJECT_PACKAGE_LIMITS.packageBytes
      },
      blockedCapabilities: [],
      message: 'The package plan is ready for a user-approved ZIP target. Binary media remains path-opaque and will be streamed by the durable Host archive executor.'
    }, `Prepared an executable project-package plan with ${plan.uniqueMediaCount} unique media objects`)
  }

  protected async videoProjectPackage(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    const action = enumValue(input.action, ['preflight', 'export', 'status', 'cancel'] as const, 'action')
    if (action === 'status' || action === 'cancel') {
      exactKeys(input, ['action', 'projectId', 'jobId'])
      const projectId = stableId(input.projectId, 'projectId')
      const jobId = boundedString(input.jobId, 'jobId', 1, 256)
      const record = await this.loadProjectPackageRecord(jobId)
      if (!record || record.projectId !== projectId) {
        throw new ToolInputError('The durable job is not a tracked project package for this project.')
      }
      if (action === 'cancel') {
        const cancelled = await this.context.jobs.cancel({ jobId })
        return result({
          outcome: cancelled.accepted ? 'cancellation-requested' : 'not-cancelled',
          accepted: cancelled.accepted,
          job: projectPackageJobProjection(cancelled.snapshot, record)
        }, cancelled.accepted
          ? `Requested cancellation for project package ${jobId}`
          : `Project package ${jobId} is already terminal`)
      }
      const snapshot = await this.context.jobs.get(jobId)
      this.assertOwnedProjectPackageSnapshot(snapshot)
      return result({
        outcome: 'status',
        job: projectPackageJobProjection(snapshot, record)
      }, `Project package ${jobId} is ${snapshot.state}`)
    }

    exactKeys(input, [
      'action', 'projectId', 'expectedRevision', 'assetIds', 'missingMediaPolicy',
      'includeReceipts', 'includeChatProvenance', 'outputHandleId'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const selectedIds = packageAssetIds(project, input.assetIds)
    const missingMediaPolicy = packageMissingPolicy(input.missingMediaPolicy)
    const includeReceipts = optionalBoolean(input.includeReceipts, 'includeReceipts') ?? true
    const includeChatProvenance = optionalBoolean(
      input.includeChatProvenance,
      'includeChatProvenance'
    ) ?? true
    const lastReceipt = this.service().getLastReceipt(project.id)
    const prepared = await prepareProjectPackageArchiveExport({
      context: this.context,
      project,
      includeMedia: [...selectedIds].sort(),
      missingMediaPolicy,
      ...(includeReceipts && lastReceipt ? { receipts: [lastReceipt] } : {}),
      includeChatProvenance,
      invocation
    })
    const plan = prepared.plan
    if (action === 'preflight') {
      return result({
        outcome: 'preflight',
        projectId,
        pinnedRevision: expectedRevision,
        packageId: plan.packageId,
        manifestDigest: plan.manifestDigest,
        complete: plan.complete,
        selectedAssetCount: plan.selectedAssetCount,
        embeddedAssetCount: plan.embeddedAssetCount,
        uniqueMediaCount: plan.uniqueMediaCount,
        deduplicatedAssetCount: plan.deduplicatedAssetCount,
        missingAssetIds: plan.missingAssetIds,
        missingMediaPolicy,
        provenance: plan.manifest.provenance,
        executable: true
      }, `Prepared project package ${plan.packageId} at revision ${expectedRevision}`)
    }

    let ownsOutputHandle = false
    let outputHandleId: string
    if (input.outputHandleId === undefined) {
      const selected = await this.context.media.pickSaveTarget({
        suggestedName: `${safeProjectPackageName(project.name)}.kun-video.zip`,
        filters: [{
          name: 'Kun Video Project Package',
          extensions: ['zip'],
          mimeTypes: ['application/zip']
        }]
      })
      if (selected.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', projectId, pinnedRevision: expectedRevision },
          'Project package target selection was cancelled')
      }
      outputHandleId = selected.target.handleId
      ownsOutputHandle = true
    } else {
      outputHandleId = opaqueHandle(input.outputHandleId, 'outputHandleId')
    }
    let started = false
    try {
      assertNotCancelled(invocation)
      await invocation.reportProgress({ message: 'Submitting durable project package job', fraction: 0.5 })
      const job = await startProjectPackageArchiveExport({
        context: this.context,
        plan,
        outputHandleId
      })
      started = true
      const record: ProjectPackageExportRecord = {
        schemaVersion: 1,
        jobId: job.jobId,
        projectId,
        sequenceId: project.activeSequenceId,
        pinnedRevision: expectedRevision,
        packageId: plan.packageId,
        manifestDigest: plan.manifestDigest,
        complete: plan.complete,
        selectedAssetCount: plan.selectedAssetCount,
        embeddedAssetCount: plan.embeddedAssetCount,
        uniqueMediaCount: plan.uniqueMediaCount,
        deduplicatedAssetCount: plan.deduplicatedAssetCount,
        missingAssetIds: plan.missingAssetIds,
        missingMediaPolicy,
        createdAt: new Date().toISOString()
      }
      try {
        await this.context.storage.workspace.set(projectPackageKey(job.jobId), record)
      } catch {
        const confirmed = await this.loadProjectPackageRecord(job.jobId)
        if (!confirmed || confirmed.manifestDigest !== record.manifestDigest) {
          await this.context.jobs.cancel({ jobId: job.jobId }).catch(() => undefined)
          throw new ExtensionApiError({
            code: 'INTERNAL_ERROR',
            message: `Project package tracking could not be persisted for ${job.jobId}; cancellation was requested.`,
            operation: 'video-project-package',
            retryable: false,
            details: { jobId: job.jobId, cancellationAttempted: true }
          })
        }
      }
      await invocation.reportProgress({ message: 'Durable project package queued', fraction: 1 })
      return result({
        outcome: 'queued',
        job: projectPackageJobProjection({
          schemaVersion: 1,
          id: job.jobId,
          kind: job.kind,
          kindSchemaVersion: 1,
          ownerExtensionId: this.context.extension.id,
          ownerExtensionVersion: this.context.extension.version,
          workspaceId: this.workspaceId(),
          initiatingOperation: 'media.startArchiveJob',
          state: job.state,
          executionAttempt: 0,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          latestCursor: job.cursor
        }, record)
      }, `Queued atomic project package ${plan.packageId}`)
    } finally {
      if (!started && ownsOutputHandle) {
        await this.context.media.release({ resource: 'handle', handleId: outputHandleId })
          .catch(() => undefined)
      }
    }
  }

  protected async videoInterchange(
    input: ToolInput,
    invocation: ToolInvocationContext
  ): Promise<ToolResult> {
    const action = enumValue(input.action, ['export', 'status', 'cancel'] as const, 'action')
    if (action === 'status' || action === 'cancel') {
      exactKeys(input, ['action', 'projectId', 'jobId', 'reason'])
      const projectId = stableId(input.projectId, 'projectId')
      const jobId = boundedString(input.jobId, 'jobId', 8, 512)
      const record = await this.loadOtioExportRecord(jobId)
      if (!record || record.projectId !== projectId) {
        throw new ToolInputError('The durable job is not a tracked OTIO export for this project.')
      }
      const snapshot = action === 'cancel'
        ? (await this.context.jobs.cancel({
            jobId,
            ...(input.reason === undefined
              ? {}
              : { reason: boundedString(input.reason, 'reason', 1, 512) })
          })).snapshot
        : await this.context.jobs.get(jobId)
      return await this.otioExportStatusResult(snapshot, record)
    }

    exactKeys(input, ['action', 'projectId', 'expectedRevision', 'outputHandleId'])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const prepared = prepareOtioInterchangeExport(project)
    let ownsOutputHandle = false
    let outputHandleId: string
    if (input.outputHandleId === undefined) {
      const selected = await this.context.media.pickSaveTarget({
        suggestedName: `${safeInterchangeName(project.name)}-revision-${expectedRevision}.otio`,
        filters: [{
          name: 'OpenTimelineIO JSON',
          extensions: ['otio'],
          mimeTypes: [OTIO_OUTPUT_MIME_TYPE]
        }]
      })
      if (selected.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', projectId, pinnedRevision: expectedRevision },
          'OTIO export target selection was cancelled')
      }
      outputHandleId = selected.target.handleId
      ownsOutputHandle = true
    } else {
      outputHandleId = opaqueHandle(input.outputHandleId, 'outputHandleId')
    }
    let started = false
    try {
      assertNotCancelled(invocation)
      await invocation.reportProgress({ message: 'Submitting durable OTIO interchange job', fraction: 0.5 })
      const job = await startOtioInterchangeExport({
        context: this.context,
        prepared,
        outputHandleId
      })
      started = true
      const exported = prepared.exported
      const record: OtioExportRecord = {
        schemaVersion: 1,
        jobId: job.jobId,
        projectId,
        sequenceId: project.activeSequenceId,
        pinnedRevision: expectedRevision,
        adapterId: exported.adapterId,
        adapterVersion: exported.adapterVersion,
        documentDigest: exported.documentDigest,
        projectDigest: exported.projectDigest,
        documentBytes: prepared.byteLength,
        lossManifest: exported.lossManifest,
        createdAt: new Date().toISOString()
      }
      try {
        await this.context.storage.workspace.set(otioExportKey(job.jobId), record as unknown as JsonValue)
      } catch {
        const confirmed = await this.loadOtioExportRecord(job.jobId)
        if (!confirmed || confirmed.documentDigest !== record.documentDigest) {
          await this.context.jobs.cancel({ jobId: job.jobId }).catch(() => undefined)
          throw new ExtensionApiError({
            code: 'INTERNAL_ERROR',
            message: `OTIO tracking could not be persisted for ${job.jobId}; cancellation was requested.`,
            operation: 'video-interchange',
            retryable: false,
            details: { jobId: job.jobId, cancellationAttempted: true }
          })
        }
      }
      await invocation.reportProgress({ message: 'Durable OTIO interchange queued', fraction: 1 })
      return result({
        outcome: 'queued',
        job: otioExportJobProjection({
          schemaVersion: 1,
          id: job.jobId,
          kind: job.kind,
          kindSchemaVersion: 1,
          ownerExtensionId: this.context.extension.id,
          ownerExtensionVersion: this.context.extension.version,
          workspaceId: this.workspaceId(),
          initiatingOperation: 'media.startFfmpegJob',
          state: job.state,
          executionAttempt: 0,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          latestCursor: job.cursor
        }, record, expectedRevision)
      }, `Queued revision ${expectedRevision} OTIO interchange export`)
    } finally {
      if (!started && ownsOutputHandle) {
        await this.context.media.release({ resource: 'handle', handleId: outputHandleId })
          .catch(() => undefined)
      }
    }
  }

  protected async videoInterchangeImport(
    input: ToolInput,
    persist: boolean
  ): Promise<ToolResult> {
    exactKeys(input, persist
      ? [
          'inputHandleId', 'expectedDocumentDigest', 'expectedSourceProjectId',
          'expectedSourceRevision', 'targetProjectId'
        ]
      : ['inputHandleId'])
    const inputHandleId = opaqueHandle(input.inputHandleId, 'inputHandleId')
    const selected = await this.context.media.readText({
      handleId: inputHandleId,
      maxBytes: MAX_MEDIA_OTIO_TEXT_BYTES
    })
    if (![
      OTIO_OUTPUT_MIME_TYPE,
      'application/json',
      'application/octet-stream'
    ].includes(selected.mimeType)) {
      throw new ToolInputError('Selected interchange document is not OTIO JSON.')
    }
    const imported = importProjectFromOtio(selected.content)
    const mappings = interchangeMappingPreview(imported.timecodeMappings)
    if (!persist) {
      const existingProjectIds = new Set(
        (await this.service().listProjects()).map(({ id }) => id)
      )
      return result({
        outcome: 'interchange-import-preview',
        inputHandleId,
        displayName: safeInterchangeDisplayName(selected.displayName),
        adapterId: imported.adapterId,
        adapterVersion: imported.adapterVersion,
        sourceDocumentDigest: imported.sourceDocumentDigest,
        sourceProjectId: imported.project.id,
        sourceProjectRevision: imported.project.currentRevision,
        suggestedProjectId: suggestedImportProjectId(imported.project.id, existingProjectIds),
        fidelity: imported.fidelity,
        project: interchangeProjectSummary(imported.project),
        mediaRelinkRequired: imported.mediaRelinkRequired,
        timecodeMappings: mappings.items as unknown as JsonValue,
        timecodeMappingsTruncated: mappings.truncated,
        lossManifest: imported.lossManifest as unknown as JsonValue,
        persisted: false,
        confirmationRequired: true
      }, `Previewed OTIO import ${imported.sourceDocumentDigest.slice(0, 12)} without persisting it`)
    }
    const expectedDocumentDigest = sha256Digest(input.expectedDocumentDigest, 'expectedDocumentDigest')
    const expectedSourceProjectId = stableId(input.expectedSourceProjectId, 'expectedSourceProjectId')
    const expectedSourceRevision = nonNegativeInteger(
      input.expectedSourceRevision,
      'expectedSourceRevision'
    )
    const targetProjectId = stableId(input.targetProjectId, 'targetProjectId')
    if (
      imported.sourceDocumentDigest !== expectedDocumentDigest ||
      imported.project.id !== expectedSourceProjectId ||
      imported.project.currentRevision !== expectedSourceRevision
    ) {
      throw new ToolInputError(
        'The OTIO document changed after preview; preview it again before importing.'
      )
    }
    const project = await this.service().importProject({
      project: imported.project,
      targetProjectId,
      expectedSourceProjectId,
      expectedSourceRevision,
      sourceDocumentDigest: expectedDocumentDigest
    })
    await this.selectActiveProject(project, 'selected', 'manual')
    await this.publishProjectChange(project, 'interchange-imported', ['project', ...project.sequences.map(({ id }) => id)])
    return result({
      outcome: 'interchange-imported',
      sourceDocumentDigest: expectedDocumentDigest,
      sourceProjectId: expectedSourceProjectId,
      sourceProjectRevision: expectedSourceRevision,
      project: await this.projectViewProjection(project),
      mediaRelinkRequired: imported.mediaRelinkRequired,
      lossManifest: imported.lossManifest as unknown as JsonValue,
      persisted: true,
      overwritten: false
    }, `Imported OTIO as new project ${targetProjectId}; existing projects were not overwritten`)
  }

  protected async otioExportStatusResult(
    snapshot: JobSnapshot,
    record: OtioExportRecord
  ): Promise<ToolResult> {
    this.assertOwnedOtioExportSnapshot(snapshot)
    const currentRevision = await this.currentRevision(record.projectId)
    const artifacts = validOtioArtifacts(snapshot, record)
    const valid = snapshot.state === 'completed' && artifacts.length === 1
    const content: JsonObject = {
      outcome: snapshot.state === 'completed' && !valid ? 'invalid-output' : snapshot.state,
      job: otioExportJobProjection(snapshot, record, currentRevision),
      technicallyValidated: valid,
      visualInspection: 'not-applicable',
      artifacts
    }
    return {
      content,
      summary: snapshot.state === 'completed'
        ? valid
          ? `OTIO export ${snapshot.id} completed with a validated document artifact`
          : `OTIO export ${snapshot.id} completed but its document artifact is invalid`
        : `OTIO export ${snapshot.id} is ${snapshot.state}`,
      metadata: { machineValidatedOnly: valid, visuallyInspected: false },
      ...(valid ? { generatedArtifacts: artifacts } : {})
    }
  }

}
