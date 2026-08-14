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

export class VideoEditorToolsFoundation {
  protected projectService?: ProjectService
  protected derivedMediaService?: DerivedMediaService
  protected mediaIntelligenceService?: MediaIntelligenceService
  protected generationServiceInstance?: GenerationService
  protected generationControlPlaneInstance?: GenerationControlPlane

  constructor(
    protected readonly context: ExtensionContext,
    protected readonly options: { generationBroker?: GenerationExecutionBroker } = {}
  ) {}

  protected service(): ProjectService {
    const workspace = this.context.workspaceContext
    if (!workspace?.active || !workspace.trusted) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The video editor requires an active trusted workspace.',
        operation: 'video-project',
        retryable: true
      })
    }
    this.projectService ??= new ProjectService(workspace.root)
    return this.projectService
  }

  protected derivedService(): DerivedMediaService {
    this.derivedMediaService ??= new DerivedMediaService(this.context)
    return this.derivedMediaService
  }

  protected intelligenceService(): MediaIntelligenceService {
    this.mediaIntelligenceService ??= new MediaIntelligenceService(
      this.context,
      new KunLocalAudioAnalysisBroker(this.context)
    )
    return this.mediaIntelligenceService
  }

  protected generationService(): GenerationService {
    this.generationServiceInstance ??= new GenerationService(
      this.context,
      this.options.generationBroker
    )
    return this.generationServiceInstance
  }

  protected generationControlPlane(): GenerationControlPlane {
    if (!this.generationControlPlaneInstance) {
      const references: GenerationReferenceResolver = {
        resolve: async (projectId, assetIds) => {
          const project = await this.service().loadProject(projectId)
          return assetIds.map((assetId) => {
            const asset = project.assets.find(({ id }) => id === assetId)
            if (!asset) throw new ToolInputError(`Generation reference asset ${assetId} does not exist.`)
            if ((asset.availability ?? 'online') !== 'online' || !asset.mediaHandleId) {
              throw new ToolInputError(`Generation reference asset ${assetId} is not currently authorized.`)
            }
            return {
              assetId,
              mediaHandleId: asset.mediaHandleId,
              kind: asset.kind === 'audio' ? 'audio' : asset.kind === 'video' ? 'video' : 'image',
              ...(asset.sourceIdentity ? {
                sourceFingerprint: {
                  algorithm: 'sha256' as const,
                  value: asset.sourceIdentity.value
                }
              } : {})
            }
          })
        }
      }
      this.generationControlPlaneInstance = new GenerationControlPlane(this.generationService(), references)
    }
    return this.generationControlPlaneInstance
  }

  protected commandInvocation(action: string): ToolInvocationContext {
    const invocationId = `editor-request-${Date.now().toString(36)}`
    return {
      invocation: {
        invocationId,
        toolId: `editor-request:${action}`,
        input: {},
        workspaceId: this.context.workspaceContext?.id
      },
      cancellation: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} })
      },
      reportProgress: async (progress) => {
        await this.context.ui.postMessage({
          channel: 'kun-video-editor.command-progress',
          payload: {
            schemaVersion: 1,
            action,
            invocationId,
            message: progress.message ?? null,
            fraction: progress.fraction ?? null,
            data: progress.data ?? null
          }
        })
      }
    }
  }

  protected workspaceId(): string {
    const workspace = this.context.workspaceContext
    if (!workspace?.active || !workspace.trusted) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The video editor requires an active trusted workspace.',
        operation: 'video-project',
        retryable: true
      })
    }
    return workspace.id
  }

  protected async publishProjectChange(
    project: VideoProject,
    reason: string,
    receiptOrChangedIds: MutationReceipt | readonly string[]
  ): Promise<void> {
    const receipt = Array.isArray(receiptOrChangedIds)
      ? undefined
      : receiptOrChangedIds as MutationReceipt
    const changedIds = receipt
      ? [...receipt.createdIds, ...receipt.changedIds, ...receipt.removedIds].map(({ id }) => id)
      : receiptOrChangedIds as readonly string[]
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.project-changed',
      payload: {
        schemaVersion: 1,
        projectId: project.id,
        revision: project.currentRevision,
        generation: project.eventGeneration,
        sequenceId: project.activeSequenceId,
        selectionGeneration: project.selection.generation,
        reason,
        changedIds: [...changedIds].slice(0, 2_000),
        ...(receipt ? {
          receipt: receipt as unknown as JsonObject,
          attribution: receipt.attribution,
          proofInvalidated: receipt.proofInvalidated
        } : {})
      }
    })
  }

  protected async publishSelectionChange(updated: {
    projectId: string
    revision: number
    generation: number
    eventGeneration: number
    selection: VideoProject['selection']
  }): Promise<void> {
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.selection-changed',
      payload: {
        schemaVersion: 1,
        projectId: updated.projectId,
        revision: updated.revision,
        generation: updated.generation,
        eventGeneration: updated.eventGeneration,
        selection: updated.selection
      }
    })
  }

  protected async proofBindings(projectId: string): Promise<ProofArtifactBinding[]> {
    const page = await this.context.jobs.list({
      filter: { kinds: ['media.ffmpeg'], workspaceId: this.workspaceId() },
      limit: 200
    })
    const bindings: ProofArtifactBinding[] = []
    for (const snapshot of page.items) {
      if (bindings.length >= 16) break
      try {
        this.assertOwnedRenderSnapshot(snapshot)
        const record = await this.loadOrRecoverRenderRecord(snapshot)
        if (
          !record ||
          record.projectId !== projectId ||
          (record.renderKind !== 'proof-frame' && record.renderKind !== 'preview')
        ) continue
        const validation = snapshot.state === 'completed'
          ? await this.validateArtifacts(snapshot, record)
          : undefined
        bindings.push({
          id: record.jobId,
          kind: record.renderKind === 'proof-frame' ? 'proof' : 'preview',
          projectId: record.projectId,
          sequenceId: record.sequenceId,
          revision: record.pinnedRevision,
          irDigest: record.renderIrDigest,
          capabilitiesDigest: record.backendCapabilitiesDigest,
          ...(record.proofFrame === undefined ? {} : { frame: record.proofFrame }),
          status: snapshot.state === 'completed'
            ? validation?.valid ? 'ready' : 'invalid'
            : snapshot.state === 'failed' || snapshot.state === 'cancelled'
              ? 'failed'
              : snapshot.state === 'interrupted'
                ? 'interrupted'
                : 'pending'
        })
      } catch {
        // Ignore unowned or malformed jobs; they are not valid project evidence.
      }
    }
    return bindings
  }

  protected async loadRenderRecord(jobId: string): Promise<RenderRecord | undefined> {
    let value: JsonValue | undefined
    try {
      value = await this.context.storage.workspace.get<JsonValue>(renderKey(jobId))
    } catch {
      return undefined
    }
    return storedRenderRecord(value, jobId)
  }

  protected async loadProjectPackageRecord(
    jobId: string
  ): Promise<ProjectPackageExportRecord | undefined> {
    let value: JsonValue | undefined
    try {
      value = await this.context.storage.workspace.get<JsonValue>(projectPackageKey(jobId))
    } catch {
      return undefined
    }
    return storedProjectPackageRecord(value, jobId)
  }

  protected async loadOtioExportRecord(jobId: string): Promise<OtioExportRecord | undefined> {
    let value: JsonValue | undefined
    try {
      value = await this.context.storage.workspace.get<JsonValue>(otioExportKey(jobId))
    } catch {
      return undefined
    }
    return storedOtioExportRecord(value, jobId)
  }

  protected assertOwnedOtioExportSnapshot(snapshot: JobSnapshot): void {
    if (
      snapshot.ownerExtensionId !== this.context.extension.id ||
      snapshot.ownerExtensionVersion !== this.context.extension.version ||
      snapshot.workspaceId !== this.workspaceId() ||
      snapshot.kind !== 'media.ffmpeg' ||
      snapshot.initiatingOperation !== 'media.startFfmpegJob'
    ) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The durable job is not an owned OTIO export in this workspace.',
        operation: 'video-interchange-status',
        retryable: false
      })
    }
  }

  protected assertOwnedProjectPackageSnapshot(snapshot: JobSnapshot): void {
    if (
      snapshot.ownerExtensionId !== this.context.extension.id ||
      snapshot.ownerExtensionVersion !== this.context.extension.version ||
      snapshot.workspaceId !== this.workspaceId() ||
      snapshot.kind !== 'media.archive' ||
      snapshot.initiatingOperation !== 'media.startArchiveJob'
    ) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The durable job is not an owned project-package export in this workspace.',
        operation: 'video-project-package',
        retryable: false
      })
    }
  }

  protected async loadOrRecoverRenderRecord(snapshot: JobSnapshot): Promise<RenderRecord | undefined> {
    const stored = await this.loadRenderRecord(snapshot.id)
    const recovered = recoverRenderRecord(snapshot)
    if (stored && (!recovered || sameRenderTrackingRecord(stored, recovered))) return stored
    if (!recovered) return stored
    try {
      await this.context.storage.workspace.set(renderKey(snapshot.id), recovered)
    } catch {
      // Core-owned result provenance remains the source of truth when extension storage is unavailable.
    }
    return recovered
  }

  protected async currentRevision(projectId: string): Promise<number | undefined> {
    try {
      return (await this.service().loadProject(projectId)).currentRevision
    } catch {
      return undefined
    }
  }

  protected async validateArtifacts(
    snapshot: JobSnapshot,
    record: RenderRecord | undefined
  ): Promise<{ valid: boolean; artifacts: GeneratedArtifact[]; reason?: string }> {
    if (snapshot.state !== 'completed') return { valid: false, artifacts: [] }
    const artifacts = snapshot.result?.generatedArtifacts ?? []
    if (!record || artifacts.length === 0 || artifacts.length !== record.expectedArtifacts.length) {
      return {
        valid: false,
        artifacts: [],
        reason: 'The completed job did not publish a verified artifact for its pinned render request.'
      }
    }
    try {
      const unmatchedExpected = [...record.expectedArtifacts]
      for (const artifact of artifacts) {
        if (
          artifact.ownerExtensionId !== this.context.extension.id ||
          artifact.ownerExtensionVersion !== this.context.extension.version ||
          artifact.workspaceId !== this.workspaceId() ||
          artifact.availability !== 'available' ||
          artifact.provenance.jobId !== snapshot.id ||
          artifact.byteSize <= 0
        ) {
          throw new Error('artifact identity does not match the pinned render')
        }
        const provenance = artifact.provenance.metadata
        if (
          !provenance ||
          provenance.projectId !== record.projectId ||
          provenance.sequenceId !== record.sequenceId ||
          provenance.pinnedRevision !== record.pinnedRevision ||
          provenance.renderIrDigest !== record.renderIrDigest ||
          provenance.backendCapabilitiesDigest !== record.backendCapabilitiesDigest ||
          !sameRenderRange(provenance.renderRange, record.renderRange) ||
          provenance.playbackMode !== record.playbackMode ||
          provenance.renderKind !== record.renderKind ||
          (record.requestedRenderKind !== undefined && provenance.requestedRenderKind !== record.requestedRenderKind) ||
          (record.advancedSettingsDigest !== undefined && provenance.advancedSettingsDigest !== record.advancedSettingsDigest) ||
          (record.advancedCapabilitiesDigest !== undefined && provenance.advancedCapabilitiesDigest !== record.advancedCapabilitiesDigest) ||
          (record.effectSemanticsDigest !== undefined && provenance.effectSemanticsDigest !== record.effectSemanticsDigest) ||
          (record.portableEquivalent !== undefined && provenance.portableEquivalent !== record.portableEquivalent) ||
          provenance.captionMode !== record.captionMode ||
          provenance.subtitleFormat !== record.subtitleFormat ||
          provenance.canvasPreset !== record.canvasPreset ||
          (record.proofFrame !== undefined && provenance.proofFrame !== record.proofFrame)
        ) {
          throw new Error('artifact provenance does not match the pinned render settings')
        }
        const expectedIndex = unmatchedExpected.findIndex((expected) =>
          expected.mediaKind === artifact.mediaKind && expected.mimeType === artifact.mimeType
        )
        if (expectedIndex < 0) throw new Error('artifact media type was not requested by the pinned render')
        unmatchedExpected.splice(expectedIndex, 1)
        const stat = await this.context.media.stat({ handleId: artifact.mediaHandleId })
        if (
          stat.revoked ||
          stat.byteSize === undefined ||
          stat.byteSize <= 0 ||
          (stat.completionIdentity !== undefined && stat.completionIdentity !== artifact.completionIdentity)
        ) {
          throw new Error('artifact media is unavailable or replaced')
        }
        if (artifact.mediaKind === 'video') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          const videoStream = probe.streams.find(({ kind }) => kind === 'video')
          if (
            !videoStream ||
            (probe.container.durationMicros ?? 0) <= 0 ||
            !matchesRenderedVideoTarget(record.renderKind, videoStream.codecName, probe.container.formatNames)
          ) {
            throw new Error('rendered video does not match the pinned codec/container target')
          }
        }
        if (artifact.mediaKind === 'audio') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          const audioStream = probe.streams.find(({ kind }) => kind === 'audio')
          if (
            !audioStream ||
            (probe.container.durationMicros ?? 0) <= 0 ||
            (record.renderKind === 'audio-aac' && audioStream.codecName?.toLocaleLowerCase() !== 'aac')
          ) {
            throw new Error('rendered audio does not match the pinned codec target')
          }
        }
        if (artifact.mediaKind === 'subtitle') {
          const probe = await this.context.media.probe({ handleId: artifact.mediaHandleId })
          if (!probe.streams.some(({ kind }) => kind === 'subtitle')) {
            throw new Error('subtitle artifact is missing a subtitle stream')
          }
        }
      }
      if (unmatchedExpected.length > 0) throw new Error('one or more requested artifacts are missing')
      return { valid: true, artifacts }
    } catch {
      return {
        valid: false,
        artifacts: [],
        reason: 'The job reached completed state, but the output failed bounded artifact or post-probe validation.'
      }
    }
  }
  protected assertOwnedRenderSnapshot(snapshot: JobSnapshot): void {
    if (
      snapshot.ownerExtensionId !== this.context.extension.id ||
      snapshot.ownerExtensionVersion !== this.context.extension.version ||
      snapshot.workspaceId !== this.workspaceId() ||
      snapshot.kind !== 'media.ffmpeg' ||
      snapshot.initiatingOperation !== 'media.startFfmpegJob'
    ) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: 'The durable job is not an owned video render in this workspace.',
        operation: 'video-render-status',
        retryable: false
      })
    }
  }
  protected async projectViewProjection(project: VideoProject): Promise<JsonObject> {
    return projectProjection(project, await this.loadPreviewHistory(project.id))
  }
  protected async loadPreviewHistory(projectId: string): Promise<PreviewHistory> {
    const value = await this.context.storage.workspace.get<JsonValue>(`${PREVIEW_HISTORY_PREFIX}${projectId}`)
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
      return emptyPreviewHistory()
    }
    try {
      const history = structuredClone(value) as PreviewHistory
      validateHistory(history)
      if (history.entries.some((entry) => entry.projectId !== projectId)) return emptyPreviewHistory()
      return history
    } catch {
      return emptyPreviewHistory()
    }
  }
  protected async savePreviewHistory(projectId: string, history: PreviewHistory): Promise<void> {
    validateHistory(history)
    if (history.entries.some((entry) => entry.projectId !== projectId)) {
      throw new ToolInputError('Preview history cannot cross project boundaries.')
    }
    await this.context.storage.workspace.set(
      `${PREVIEW_HISTORY_PREFIX}${projectId}`,
      history as unknown as JsonValue
    )
  }
  protected async publishPreviewHistory(history: PreviewHistory): Promise<void> {
    await this.context.ui.postMessage({
      channel: 'kun-video-editor.preview-history-changed',
      payload: {
        schemaVersion: 1,
        generation: history.generation,
        activeEntryId: history.activeEntryId ?? null,
        entryCount: history.entries.length
      }
    })
  }
}
