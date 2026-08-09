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
import { VideoEditorToolsTracking } from './video-tools-tracking.js'

export class VideoEditorToolsRender extends VideoEditorToolsTracking {
  protected async videoRender(input: ToolInput, invocation: ToolInvocationContext): Promise<ToolResult> {
    exactKeys(input, [
      'projectId', 'expectedRevision', 'kind', 'outputHandleId', 'proofFrame',
      'captionMode', 'subtitleOutputHandleId', 'subtitleFormat', 'idempotencyKey',
      'width', 'height', 'frameRate', 'quality', 'acceleration',
      'allowPortableEquivalent', 'audio', 'multicamGroupId', 'startFrame', 'endFrame'
    ])
    const projectId = stableId(input.projectId, 'projectId')
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const kind = enumValue(
      input.kind,
      ['proof-frame', 'preview', 'h264-mp4', 'h265-mp4', 'prores-mov', 'audio-aac', 'subtitles'] as const,
      'kind'
    )
    const subtitleFormat = input.subtitleFormat === undefined
      ? 'srt'
      : enumValue(input.subtitleFormat, ['srt', 'vtt'] as const, 'subtitleFormat')
    const captionMode = input.captionMode === undefined
      ? 'none'
      : enumValue(input.captionMode, ['none', 'burned', 'sidecar', 'both'] as const, 'captionMode')
    if (kind === 'subtitles' && captionMode !== 'none') {
      throw new ToolInputError('Standalone subtitle export does not accept a media caption mode.')
    }
    if ((captionMode === 'sidecar' || captionMode === 'both') && !isRequestedFinalVideoKind(kind)) {
      throw new ToolInputError('Caption sidecars are supported only for a final video export.')
    }
    if (captionMode === 'burned' && kind === 'audio-aac') {
      throw new ToolInputError('Burned captions require a proof, preview, or final video render.')
    }
    // Reject path-shaped or otherwise invalid caller input before project
    // compilation/capability probing so validation order cannot be used to
    // bypass the opaque-handle boundary on an empty project.
    const suppliedOutputHandleId = input.outputHandleId === undefined
      ? undefined
      : opaqueHandle(input.outputHandleId, 'outputHandleId')
    const suppliedSubtitleOutputHandleId = input.subtitleOutputHandleId === undefined
      ? undefined
      : opaqueHandle(input.subtitleOutputHandleId, 'subtitleOutputHandleId')
    const project = await this.service().loadProject(projectId)
    assertExpectedRevision(project, expectedRevision)
    const multicamGroupId = input.multicamGroupId === undefined
      ? undefined
      : stableId(input.multicamGroupId, 'multicamGroupId')
    const renderProject = multicamGroupId
      ? compileMulticamProgramProject(project, multicamGroupId)
      : project
    const hasStartFrame = input.startFrame !== undefined
    const hasEndFrame = input.endFrame !== undefined
    if (hasStartFrame !== hasEndFrame) {
      throw new ToolInputError('A render range requires both startFrame and endFrame.')
    }
    if (hasStartFrame && !multicamGroupId) {
      throw new ToolInputError('A bounded render range is currently available only for a multicam program.')
    }
    const renderRange = hasStartFrame
      ? {
          startFrame: nonNegativeInteger(input.startFrame, 'startFrame'),
          endFrame: positiveInteger(input.endFrame, 'endFrame')
        }
      : undefined
    if (renderRange && renderRange.endFrame <= renderRange.startFrame) {
      throw new ToolInputError('endFrame must be greater than startFrame.')
    }
    if (kind !== 'proof-frame' && input.proofFrame !== undefined) {
      throw new ToolInputError('proofFrame is supported only for proof-frame renders.')
    }
    const proofFrame = kind === 'proof-frame'
      ? input.proofFrame === undefined
        ? 0
        : nonNegativeInteger(input.proofFrame, 'proofFrame')
      : undefined
    const advancedSettings = professionalRenderSettings(renderProject, kind, input)
    const capabilityAssessment = await this.renderCapabilityAssessment(
      renderProject,
      kind,
      captionMode,
      proofFrame,
      renderRange,
      advancedSettings
    )
    if ('failure' in capabilityAssessment) return capabilityAssessment.failure
    const selectedRenderKind = capabilityAssessment.selectedRenderKind

    let outputHandleId: string
    let ownsOutputHandle = false
    if (suppliedOutputHandleId === undefined) {
      let selection
      try {
        selection = await this.context.media.pickSaveTarget({
          suggestedName: renderFileName(project, selectedRenderKind, subtitleFormat),
          filters: [renderFilter(selectedRenderKind, subtitleFormat)]
        })
      } catch (error) {
        const interaction = interactionRequired(error, 'Choose an export target in the Kun desktop editor, then retry with its outputHandleId.')
        if (interaction) return result(interaction, 'Render requires protected interaction')
        throw error
      }
      if (selection.outcome === 'cancelled') {
        return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Export target selection was cancelled.' }, 'Export selection cancelled')
      }
      outputHandleId = selection.target.handleId
      ownsOutputHandle = true
    } else {
      outputHandleId = suppliedOutputHandleId
    }

    let subtitleOutputHandleId: string | undefined
    let ownsSubtitleOutputHandle = false
    let renderStarted = false
    try {
    if (captionMode === 'sidecar' || captionMode === 'both') {
      if (suppliedSubtitleOutputHandleId === undefined) {
        let selection
        try {
          selection = await this.context.media.pickSaveTarget({
            suggestedName: `${project.id}-revision-${project.currentRevision}.${subtitleFormat}`,
            filters: [{
              name: subtitleFormat === 'srt' ? 'SubRip captions' : 'WebVTT captions',
              extensions: [subtitleFormat],
              mimeTypes: [subtitleFormat === 'srt' ? 'application/x-subrip' : 'text/vtt']
            }]
          })
        } catch (error) {
          const interaction = interactionRequired(error, 'Choose a protected subtitle export target, then retry with its subtitleOutputHandleId.')
          if (interaction) return result(interaction, 'Caption sidecar export requires protected interaction')
          throw error
        }
        if (selection.outcome === 'cancelled') {
          return result({ outcome: 'cancelled', code: 'MEDIA_CANCELLED', message: 'Subtitle export target selection was cancelled.' }, 'Subtitle export selection cancelled')
        }
        subtitleOutputHandleId = selection.target.handleId
        ownsSubtitleOutputHandle = true
      } else {
        subtitleOutputHandleId = suppliedSubtitleOutputHandleId
      }
    } else if (
      input.subtitleOutputHandleId !== undefined ||
      (kind !== 'subtitles' && input.subtitleFormat !== undefined)
    ) {
      throw new ToolInputError('Subtitle output fields require captionMode sidecar or both.')
    }
    const plan = generateRenderPlan(renderProject, {
      kind: selectedRenderKind,
      expectedRevision,
      outputHandleId,
      proofFrame,
      ...(renderRange ?? {}),
      captionMode,
      subtitleFormat,
      backendCapabilities: capabilityAssessment.backendCapabilities,
      ...(capabilityAssessment.advancedEffects
        ? { advancedEffects: capabilityAssessment.advancedEffects }
        : {}),
      ...(capabilityAssessment.advancedExport
        ? { advancedExport: capabilityAssessment.advancedExport }
        : {}),
      ...(subtitleOutputHandleId ? { subtitleOutputHandleId } : {})
    })
    const textSteps = plan.steps.filter(
      (renderStep): renderStep is TextRenderStep => renderStep.kind === 'write-text'
    )
    const ffmpegSteps = plan.steps.filter(
      (step): step is FfmpegRenderStep => step.kind === 'ffmpeg'
    )
    const standaloneSubtitles = selectedRenderKind === 'subtitles'
    if (
      textSteps.length > 1 ||
      (standaloneSubtitles
        ? textSteps.length !== 1 || ffmpegSteps.length !== 0
        : ffmpegSteps.length !== 1)
    ) {
      throw new ToolInputError(
        'This render plan exceeds the supported single-media/single-sidecar export transaction.'
      )
    }
    if (textSteps[0] && new TextEncoder().encode(textSteps[0].content).byteLength > 192 * 1024) {
      throw new ToolInputError(
        'The generated subtitle sidecar exceeds the 192 KiB durable-job limit; shorten or split the caption export.'
      )
    }
    const inputs: Record<string, string> = {}
    const step = ffmpegSteps[0]
    if (step) {
      for (const [name, reference] of Object.entries(step.inputs)) {
        if (reference.kind !== 'media-handle') {
          throw new ToolInputError(`Render input ${name} is not backed by a durable media handle.`)
        }
        inputs[name] = opaqueHandle(reference.reference, `render input ${name}`)
      }
    }
    assertNotCancelled(invocation)
    await invocation.reportProgress({ message: 'Submitting durable media job', fraction: 0.5 })
    const started = await this.context.media.startFfmpegJob({
      arguments: step?.args ?? [],
      inputs,
      outputs: step?.outputs ?? {},
      ...(textSteps.length === 1 ? {
        textOutputs: {
          [textSteps[0]!.id]: {
            handleId: opaqueHandle(textSteps[0]!.output, 'subtitle output'),
            mimeType: textSteps[0]!.mime,
            content: textSteps[0]!.content
          }
        }
      } : {}),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: boundedString(input.idempotencyKey, 'idempotencyKey', 1, 256) }),
      metadata: {
        projectId,
        multicamGroupId: multicamGroupId ?? null,
        pinnedRevision: expectedRevision,
        renderKind: selectedRenderKind,
        ...(isRequestedFinalVideoKind(kind) ? { requestedRenderKind: kind } : {}),
        ...(capabilityAssessment.advancedExport ? {
          advancedSettingsDigest: capabilityAssessment.advancedExport.settingsDigest,
          advancedCapabilitiesDigest: capabilityAssessment.advancedExport.capabilitiesDigest,
          portableEquivalent: capabilityAssessment.advancedExport.capabilityEvidence.portableEquivalent
        } : capabilityAssessment.advancedEffects ? {
          advancedCapabilitiesDigest: capabilityAssessment.advancedEffects.capabilitiesDigest
        } : {}),
        ...(capabilityAssessment.advancedEffects ? {
          effectSemanticsDigest: capabilityAssessment.advancedEffects.renderSemanticsDigest
        } : {}),
        captionMode,
        subtitleFormat,
        canvasPreset: project.canvas.preset,
        proofFrame: proofFrame ?? null,
        sequenceId: plan.sequenceId,
        renderIrDigest: plan.renderIrDigest,
        backendCapabilitiesDigest: plan.backendCapabilitiesDigest,
        renderRange: plan.renderIr.range,
        playbackMode: plan.playback.mode,
        technicalValidation: 'pending',
        visualInspection: 'not-performed'
      }
    })
    renderStarted = true
    const record: RenderRecord = {
      schemaVersion: 1,
      jobId: started.job.jobId,
      projectId,
      sequenceId: plan.sequenceId,
      pinnedRevision: expectedRevision,
      renderIrDigest: plan.renderIrDigest,
      backendCapabilitiesDigest: plan.backendCapabilitiesDigest,
      renderRange: structuredClone(plan.renderIr.range),
      playbackMode: plan.playback.mode,
      renderKind: selectedRenderKind,
      ...(isRequestedFinalVideoKind(kind) ? { requestedRenderKind: kind } : {}),
      ...(capabilityAssessment.advancedExport ? {
        advancedSettingsDigest: capabilityAssessment.advancedExport.settingsDigest,
        advancedCapabilitiesDigest: capabilityAssessment.advancedExport.capabilitiesDigest,
        portableEquivalent: capabilityAssessment.advancedExport.capabilityEvidence.portableEquivalent
      } : capabilityAssessment.advancedEffects ? {
        advancedCapabilitiesDigest: capabilityAssessment.advancedEffects.capabilitiesDigest
      } : {}),
      ...(capabilityAssessment.advancedEffects ? {
        effectSemanticsDigest: capabilityAssessment.advancedEffects.renderSemanticsDigest
      } : {}),
      captionMode,
      subtitleFormat,
      canvasPreset: project.canvas.preset,
      ...(proofFrame !== undefined ? { proofFrame } : {}),
      expectedArtifacts: plan.artifacts.map((artifact) => ({
        mediaKind: artifact.kind,
        mimeType: artifact.mime
      })),
      createdAt: new Date().toISOString()
    }
    try {
      await this.context.storage.workspace.set(renderKey(started.job.jobId), record)
    } catch {
      const confirmed = await this.loadRenderRecord(started.job.jobId)
      if (!confirmed || !sameRenderTrackingRecord(confirmed, record)) {
        const cancellation = await this.cancelAfterRenderTrackingFailure(started.job.jobId)
        throw new ExtensionApiError({
          code: 'INTERNAL_ERROR',
          message: `Durable render tracking could not be persisted after job ${started.job.jobId} started. ` +
            `Cancellation was attempted and the durable job is ${cancellation.state}; ` +
            'use video-render-status with this jobId before retrying.',
          operation: 'video-render',
          retryable: false,
          details: {
            jobId: started.job.jobId,
            state: cancellation.state,
            cancellationAttempted: true,
            cancellationAccepted: cancellation.accepted,
            trackingPersisted: false
          }
        })
      }
    }
    await invocation.reportProgress({ message: 'Durable media job queued', fraction: 1 })
    return result({
      outcome: 'queued',
      jobId: started.job.jobId,
      state: started.job.state,
      projectId,
      multicamGroupId: multicamGroupId ?? null,
      pinnedRevision: expectedRevision,
      renderKind: selectedRenderKind,
      requestedRenderKind: isRequestedFinalVideoKind(kind) ? kind : null,
      advancedSettingsDigest: capabilityAssessment.advancedExport?.settingsDigest ?? null,
      advancedCapabilitiesDigest: capabilityAssessment.advancedExport?.capabilitiesDigest ??
        capabilityAssessment.advancedEffects?.capabilitiesDigest ?? null,
      effectSemanticsDigest: capabilityAssessment.advancedEffects?.renderSemanticsDigest ?? null,
      portableEquivalent: capabilityAssessment.advancedExport?.capabilityEvidence.portableEquivalent ?? false,
      sequenceId: plan.sequenceId,
      renderIrDigest: plan.renderIrDigest,
      backendCapabilitiesDigest: plan.backendCapabilitiesDigest,
      renderRange: plan.renderIr.range,
      playbackMode: plan.playback.mode,
      proofStale: false,
      technicallyValidated: false,
      visualInspection: 'not-performed',
      artifacts: []
    }, `Queued ${selectedRenderKind} render for revision ${expectedRevision}`)
    } finally {
      if (!renderStarted) {
        const ownedHandles = [
          ...(ownsOutputHandle ? [outputHandleId] : []),
          ...(ownsSubtitleOutputHandle && subtitleOutputHandleId ? [subtitleOutputHandleId] : [])
        ]
        await Promise.all(ownedHandles.map((handleId) =>
          this.context.media.release({ resource: 'handle', handleId }).catch(() => undefined)
        ))
      }
    }
  }

  protected async renderCapabilityAssessment(
    project: VideoProject,
    kind: RenderKind,
    captionMode: RenderRecord['captionMode'],
    proofFrame: number | undefined,
    renderRange: { startFrame: number; endFrame: number } | undefined,
    advancedSettings: AdvancedExportSettings | undefined
  ): Promise<RenderCapabilityAssessment> {
    // Standalone subtitle exports are durable bounded text writes. They do not
    // execute or validate media and must remain available without FFmpeg.
    if (kind === 'subtitles') {
      return {
        backendCapabilities: textRenderBackendCapabilities(),
        selectedRenderKind: 'subtitles'
      }
    }

    let capabilities: MediaCapabilities
    try {
      capabilities = await this.context.media.getCapabilities()
    } catch {
      return { failure: result({
        outcome: 'unavailable',
        code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
        projectId: project.id,
        currentRevision: project.currentRevision,
        changedIds: [],
        retryable: true,
        renderKind: kind,
        captionMode,
        missingCapabilities: ['capability-inspection'],
        message: `Kun could not inspect local FFmpeg and ffprobe capabilities for the ${kind} render. ` +
          'Install or configure both media executables and retry. No output target was selected and no render job was started.'
      }, 'Media capability inspection unavailable; no render was started') }
    }

    const missing: Array<{
      code: string
      id: string
      label: string
      guidance: string
    }> = []
    if (!capabilities.ffprobe.available) {
      missing.push({
        code: 'FFPROBE_UNAVAILABLE',
        id: 'ffprobe',
        label: 'ffprobe executable',
        guidance: 'Install or configure ffprobe so Kun can validate generated media.'
      })
    }
    if (!capabilities.ffmpeg.available) {
      missing.push({
        code: 'FFMPEG_UNAVAILABLE',
        id: 'ffmpeg',
        label: 'FFmpeg executable',
        guidance: 'Install or configure FFmpeg for media rendering.'
      })
    }

    const features = new Set<string>(capabilities.ffmpeg.features)
    if (
      capabilities.ffmpeg.available &&
      (kind === 'preview' || (kind === 'h264-mp4' && advancedSettings === undefined)) &&
      !features.has('libx264-encoder')
    ) {
      missing.push({
        code: 'LIBX264_ENCODER_UNAVAILABLE',
        id: 'libx264-encoder',
        label: 'libx264 encoder',
        guidance: 'Use an FFmpeg build that includes the libx264 encoder.'
      })
    }
    const timelineHasAudio = project.items.some((item) =>
      project.assets.some((asset) => asset.id === item.assetId && asset.audio !== undefined)
    )
    if (
      capabilities.ffmpeg.available &&
      (kind === 'audio-aac' ||
        ((kind === 'preview' || (kind === 'h264-mp4' && advancedSettings === undefined)) && timelineHasAudio)) &&
      !features.has('aac-encoder')
    ) {
      missing.push({
        code: 'AAC_ENCODER_UNAVAILABLE',
        id: 'aac-encoder',
        label: 'AAC encoder',
        guidance: 'Use an FFmpeg build that includes the AAC encoder.'
      })
    }
    if (
      capabilities.ffmpeg.available &&
      (captionMode === 'burned' || captionMode === 'both') &&
      !features.has('drawtext-filter')
    ) {
      missing.push({
        code: 'DRAWTEXT_FILTER_UNAVAILABLE',
        id: 'drawtext-filter',
        label: 'drawtext filter',
        guidance: "Retry with captionMode 'none' or 'sidecar', or use an FFmpeg build that includes drawtext."
      })
    }

    const hasEnabledEffects = project.items.some((item) => item.effects?.some(({ enabled }) => enabled))
    const useAdvancedNegotiation = advancedSettings !== undefined || hasEnabledEffects
    const advancedCapabilities = useAdvancedNegotiation
      ? observedAdvancedFfmpegCapabilities(capabilities)
      : undefined
    const renderIr = flattenNestedRenderIr(project, compileRenderIr(project, {
      textPolicy: captionMode,
      ...(proofFrame === undefined
        ? renderRange ? { range: renderRange } : {}
        : { range: { startFrame: proofFrame, endFrame: proofFrame + 1 } })
    }))
    let selectedRenderKind = kind
    let advancedEffects: AdvancedEffectExecutionPlan | undefined
    let advancedExport: AdvancedExportPlan | undefined
    if (advancedCapabilities) {
      advancedEffects = negotiateAdvancedEffects(renderIr, advancedCapabilities, {
        target: kind === 'proof-frame' || kind === 'preview' ? 'preview' : 'export',
        acceleration: advancedSettings?.acceleration ?? 'cpu'
      })
      for (const issue of advancedEffects.issues) {
        missing.push({
          code: 'ADVANCED_EFFECT_UNSUPPORTED',
          id: issue.capability,
          label: `${issue.nodeId}: ${issue.capability}`,
          guidance: issue.guidance
        })
      }
    }
    if (advancedSettings && advancedCapabilities) {
      advancedExport = negotiateAdvancedExport(renderIr, advancedSettings, advancedCapabilities)
      for (const issue of advancedExport.issues) {
        missing.push({
          code: 'ADVANCED_EXPORT_UNSUPPORTED',
          id: issue.capability,
          label: `${issue.nodeId}: ${issue.capability}`,
          guidance: issue.guidance
        })
      }
      if (advancedExport.selected) selectedRenderKind = advancedExport.selected.format
    }
    const backendCapabilities = advancedCapabilities
      ? observedRenderBackendCapabilities(capabilities, advancedCapabilities)
      : ffmpegRenderBackendCapabilities(capabilities)
    const capabilityReport = negotiateRenderIr(renderIr, backendCapabilities, selectedRenderKind)
    for (const unsupported of capabilityReport.unsupported) {
      if (missing.some(({ id }) => id === unsupported.capability)) continue
      missing.push({
        code: 'RENDER_IR_NODE_UNSUPPORTED',
        id: unsupported.capability,
        label: `${unsupported.nodeId}: ${unsupported.capability}`,
        guidance: unsupported.guidance
      })
    }

    if (missing.length > 0) {
      const labels = missing.map(({ label }) => label)
      const guidance = missing.map(({ guidance: item }) => item)
      return { failure: result({
        outcome: 'unavailable',
        code: missing[0]!.code,
        projectId: project.id,
        currentRevision: project.currentRevision,
        changedIds: [],
        retryable: true,
        renderKind: selectedRenderKind,
        requestedRenderKind: kind,
        captionMode,
        missingCapabilities: missing.map(({ id }) => id),
        unsupportedNodes: capabilityReport.unsupported.map((unsupported) => ({
          nodeId: unsupported.nodeId,
          nodeType: unsupported.nodeType,
          capability: unsupported.capability,
          message: unsupported.message,
          guidance: unsupported.guidance
        })),
        advancedIssues: [
          ...(advancedEffects?.issues ?? []),
          ...(advancedExport?.issues ?? [])
        ].slice(0, 64) as unknown as JsonValue,
        capabilityEvidence: advancedExport?.capabilityEvidence as unknown as JsonValue ?? null,
        backendCapabilitiesDigest: capabilityReport.capabilitiesDigest,
        message: `Cannot start the ${selectedRenderKind} render; missing media capability: ${labels.join(', ')}. ` +
          `${guidance.join(' ')} No output target was selected and no render job was started.`
      }, `Render unavailable: missing ${labels.join(', ')}`) }
    }
    return {
      backendCapabilities,
      selectedRenderKind,
      ...(advancedEffects ? { advancedEffects } : {}),
      ...(advancedExport ? { advancedExport } : {})
    }
  }

}
