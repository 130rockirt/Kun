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
import { extensionOf } from './video-tools-interchange-support.js'
import { normalizeRotation } from './video-tools-render-support.js'
export function result(content: JsonObject, summary: string, metadata?: JsonObject): ToolResult {
  return { content, summary, ...(metadata ? { metadata } : {}) }
}

export function projectProjection(project: VideoProject, previewHistory: PreviewHistory = emptyPreviewHistory()): JsonObject {
  const transcripts: JsonObject[] = []
  let remainingSegments = MAX_TRANSCRIPT_SEGMENTS
  for (const transcript of project.transcripts.slice(0, MAX_TRANSCRIPTS)) {
    const limit = Math.max(0, remainingSegments)
    const projection = transcriptProjection(transcript, limit)
    remainingSegments -= Math.min(transcript.segments.length, limit)
    transcripts.push(projection)
  }
  const sequences = project.sequences.slice(0, MAX_SEQUENCES).map((sequence) => ({
    id: sequence.id,
    name: sequence.name,
    active: sequence.id === project.activeSequenceId,
    viewState: structuredClone(sequence.viewState),
    durationFrames: sequenceDurationFrames(sequence),
    itemCount: sequence.items.length,
    captionCount: sequence.captions.length,
    nestedByCount: project.sequences.reduce(
      (count, parent) => count + parent.items.filter(({ nestedSequenceId }) => nestedSequenceId === sequence.id).length,
      0
    )
  }))
  const projectedItemIds = new Set(project.items.slice(0, MAX_ITEMS).map(({ id }) => id))
  const activeLinkGroups = project.linkGroups.filter((group) =>
    group.itemIds.every((itemId) => project.items.some(({ id }) => id === itemId))
  )
  const linkGroups = activeLinkGroups
    .filter((group) => group.itemIds.some((itemId) => projectedItemIds.has(itemId)))
    .slice(0, MAX_LINK_GROUPS)
    .map((group) => structuredClone(group))
  const activePreviewIds = previewHistory.activeEntryId ? [previewHistory.activeEntryId] : []
  const selectionAttachment = buildVideoSelectionAttachment(project, activePreviewIds)
  const multicamGroups = (project.multicamGroups ?? [])
    .slice(0, MAX_MULTICAM_GROUPS)
    .map(multicamGroupProjection)
  return {
    // This is the bounded Host/View projection schema, not the durable project
    // document schema. Keep it stable while the on-disk project moves to v2.
    schemaVersion: 1,
    id: project.id,
    name: project.name,
    fps: project.fps,
    canvas: project.canvas,
    currentRevision: project.currentRevision,
    eventGeneration: project.eventGeneration,
    activeSequenceId: project.activeSequenceId,
    sequences,
    mediaFolders: (project.mediaFolders ?? []).slice(0, MAX_MEDIA_FOLDERS),
    linkGroups,
    multicamGroups,
    selection: project.selection,
    selectionAttachment: selectionAttachment as unknown as JsonObject,
    previewHistory: previewHistory as unknown as JsonObject,
    canUndo: project.undoStack.length > 0,
    canRedo: project.redoStack.length > 0,
    updatedAt: project.updatedAt,
    durationFrames: projectDurationFrames(project),
    playback: interactivePlaybackProjection(project),
    counts: {
      assets: project.assets.length,
      tracks: project.tracks.length,
      items: project.items.length,
      captions: project.captions.length,
      transcripts: project.transcripts.length,
      revisions: project.revisions.length,
      sequences: project.sequences.length,
      mediaFolders: project.mediaFolders?.length ?? 0,
      linkGroups: activeLinkGroups.length,
      multicamGroups: project.multicamGroups?.length ?? 0
    },
    hiddenCounts: {
      sequences: Math.max(0, project.sequences.length - sequences.length),
      mediaFolders: Math.max(0, (project.mediaFolders?.length ?? 0) - MAX_MEDIA_FOLDERS),
      linkGroups: Math.max(0, activeLinkGroups.length - linkGroups.length),
      multicamGroups: Math.max(0, (project.multicamGroups?.length ?? 0) - multicamGroups.length)
    },
    assets: project.assets.slice(0, MAX_ASSETS).map(assetProjection),
    tracks: project.tracks.slice(0, MAX_TRACKS),
    items: project.items.slice(0, MAX_ITEMS),
    captions: project.captions.slice(0, MAX_CAPTIONS),
    transcripts,
    revisions: project.revisions.slice(-50).map((entry) => ({
      revision: entry.revision,
      parentRevision: entry.parentRevision,
      author: entry.author,
      sourceOperation: entry.sourceOperation,
      timestamp: entry.timestamp,
      summary: entry.summary,
      restoredFromRevision: entry.restoredFromRevision ?? null
    }))
  }
}

export function interactivePlaybackProjection(project: VideoProject): JsonObject {
  if (projectDurationFrames(project) <= 0) {
    return {
      mode: 'composed-proof',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      revision: project.currentRevision,
      irDigest: null,
      reasons: ['empty-timeline']
    }
  }
  try {
    const decision = resolveInteractivePlayback(compileRenderIr(project, { textPolicy: 'none' }))
    return {
      mode: decision.mode,
      projectId: decision.projectId,
      sequenceId: decision.sequenceId,
      revision: decision.revision,
      irDigest: decision.irDigest,
      sourceAssetId: decision.sourceId ?? null,
      reasons: decision.reasons
    }
  } catch {
    return {
      mode: 'composed-proof',
      projectId: project.id,
      sequenceId: project.activeSequenceId,
      revision: project.currentRevision,
      irDigest: null,
      reasons: ['render-ir-unavailable']
    }
  }
}

export function projectProjectionIsTruncated(project: VideoProject): boolean {
  return project.assets.length > MAX_ASSETS ||
    project.tracks.length > MAX_TRACKS ||
    project.items.length > MAX_ITEMS ||
    project.captions.length > MAX_CAPTIONS ||
    project.sequences.length > MAX_SEQUENCES ||
    (project.mediaFolders?.length ?? 0) > MAX_MEDIA_FOLDERS ||
    (project.multicamGroups?.length ?? 0) > MAX_MULTICAM_GROUPS ||
    project.linkGroups.length > MAX_LINK_GROUPS ||
    project.transcripts.length > MAX_TRANSCRIPTS ||
    project.transcripts.reduce((total, transcript) => total + transcript.segments.length, 0) > MAX_TRANSCRIPT_SEGMENTS
}

export function multicamGroupProjection(group: MulticamGroup): JsonObject {
  return {
    schemaVersion: group.schemaVersion,
    id: group.id,
    sequenceId: group.sequenceId,
    name: group.name,
    fps: structuredClone(group.fps),
    durationFrames: group.durationFrames,
    referenceMemberId: group.referenceMemberId,
    members: group.members.map((member) => ({
      id: member.id,
      assetId: member.assetId,
      memberLabel: member.memberLabel,
      angleLabel: member.angleLabel,
      sourceFps: structuredClone(member.sourceFps),
      sync: {
        status: member.sync.status,
        offsetFrames: member.sync.offsetFrames,
        ...(member.sync.confidence === undefined ? {} : { confidence: member.sync.confidence }),
        evidence: member.sync.evidence.map((evidence) => ({
          id: evidence.id,
          analysisId: evidence.analysisId,
          kind: evidence.kind,
          referenceMemberId: evidence.referenceMemberId,
          targetMemberId: evidence.targetMemberId,
          confidence: evidence.confidence,
          algorithmId: evidence.algorithmId,
          algorithmVersion: evidence.algorithmVersion
        }))
      },
      coverage: member.coverage.map((segment) => ({
        id: segment.id,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        sourceStartFrame: segment.sourceStartFrame,
        sourceEndFrame: segment.sourceEndFrame
      }))
    })),
    layouts: group.layouts.map((layout) => ({
      id: layout.id,
      label: layout.label,
      slots: layout.slots.map((slot) => ({ ...slot }))
    })),
    programFragments: group.programFragments.map((fragment) => ({
      id: fragment.id,
      startFrame: fragment.startFrame,
      endFrame: fragment.endFrame,
      selection: { ...fragment.selection }
    }))
  }
}

export function assetProjection(asset: MediaAsset): JsonObject {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mediaHandleId: asset.mediaHandleId ?? null,
    durationUs: asset.durationUs,
    container: asset.container,
    video: asset.video ?? null,
    audio: asset.audio ?? null,
    still: asset.still ?? null,
    folderId: asset.folderId ?? null,
    availability: asset.availability ?? 'online',
    sourceStatus: {
      availability: asset.availability ?? 'online',
      reason: asset.recovery?.reason ?? null,
      lastVerifiedAt: asset.recovery?.lastVerifiedAt ?? null
    },
    generatedLineage: asset.generatedLineage ? {
      providerId: asset.generatedLineage.providerId,
      modelId: asset.generatedLineage.modelId,
      jobId: asset.generatedLineage.jobId,
      promptDigest: asset.generatedLineage.promptDigest ?? null,
      referenceAssetIds: asset.generatedLineage.referenceAssetIds.slice(0, 32),
      variantOfAssetId: asset.generatedLineage.variantOfAssetId ?? null
    } : null,
    transcriptIds: asset.transcriptIds
  }
}

export function generatedAssetFromMaterialization(
  project: VideoProject,
  materialization: GenerationMaterialization
): MediaAsset {
  const output = materialization.output
  const assetId = output.primary ? materialization.primaryAssetId : output.assetId
  const container = output.mimeType.split('/')[1]?.replace(/^x-/u, '').slice(0, 64) || 'generated'
  const defaultStillFrames = Math.max(1, Math.round(
    5 * project.fps.numerator / project.fps.denominator
  ))
  const durationUs = output.kind === 'image'
    ? Math.max(1, framesToMicroseconds(defaultStillFrames, project.fps))
    : output.durationUs
  if (durationUs === undefined) throw new ToolInputError('Verified generated media is missing its duration.')
  if ((output.kind === 'image' || output.kind === 'video') && (!output.width || !output.height)) {
    throw new ToolInputError('Verified generated visual media is missing its dimensions.')
  }
  return {
    id: assetId,
    name: output.displayName,
    kind: output.kind,
    mediaHandleId: output.outputHandleId,
    durationUs,
    container,
    ...(output.kind === 'video' ? {
      video: {
        codec: 'host-verified',
        width: output.width!,
        height: output.height!,
        frameRate: structuredClone(project.fps)
      }
    } : {}),
    ...(output.kind === 'image' ? {
      still: {
        width: output.width!,
        height: output.height!,
        format: container,
        animated: false
      }
    } : {}),
    ...(output.kind === 'audio' ? {
      audio: {
        codec: 'host-verified',
        sampleRate: output.sampleRate!,
        channels: output.channels!
      }
    } : {}),
    generatedLineage: {
      providerId: materialization.providerId,
      modelId: materialization.modelId,
      jobId: materialization.jobId,
      promptDigest: materialization.promptDigest,
      referenceAssetIds: materialization.referenceAssetIds.slice(0, 32),
      ...(!output.primary ? { variantOfAssetId: materialization.primaryAssetId } : {})
    },
    transcriptIds: [],
    availability: 'online',
    sourceIdentity: {
      algorithm: 'sha256',
      value: createHash('sha256').update(output.completionIdentity).digest('hex'),
      ...(output.byteSize === undefined ? {} : { sizeBytes: output.byteSize })
    }
  }
}

export function sameGeneratedMaterialization(existing: MediaAsset, expected: MediaAsset): boolean {
  const left = existing.generatedLineage
  const right = expected.generatedLineage
  return existing.id === expected.id &&
    existing.kind === expected.kind &&
    existing.mediaHandleId === expected.mediaHandleId &&
    existing.container === expected.container &&
    existing.sourceIdentity?.algorithm === expected.sourceIdentity?.algorithm &&
    existing.sourceIdentity?.value === expected.sourceIdentity?.value &&
    existing.sourceIdentity?.sizeBytes === expected.sourceIdentity?.sizeBytes &&
    JSON.stringify(existing.video ?? null) === JSON.stringify(expected.video ?? null) &&
    JSON.stringify(existing.audio ?? null) === JSON.stringify(expected.audio ?? null) &&
    JSON.stringify(existing.still ?? null) === JSON.stringify(expected.still ?? null) &&
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId &&
    left?.jobId === right?.jobId &&
    left?.promptDigest === right?.promptDigest &&
    left?.variantOfAssetId === right?.variantOfAssetId &&
    JSON.stringify(left?.referenceAssetIds ?? []) === JSON.stringify(right?.referenceAssetIds ?? [])
}

export function generatedAssetSummary(asset: MediaAsset): JsonObject {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    durationUs: asset.durationUs,
    availability: asset.availability ?? 'online',
    generatedLineage: asset.generatedLineage ? {
      providerId: asset.generatedLineage.providerId,
      modelId: asset.generatedLineage.modelId,
      jobId: asset.generatedLineage.jobId,
      promptDigest: asset.generatedLineage.promptDigest ?? null,
      referenceAssetIds: asset.generatedLineage.referenceAssetIds.slice(0, 32),
      variantOfAssetId: asset.generatedLineage.variantOfAssetId ?? null
    } : null
  }
}

export function transcriptProjection(transcript: Transcript, limit: number): JsonObject {
  const segments = transcript.segments.slice(0, limit)
  return {
    id: transcript.id,
    assetId: transcript.assetId,
    language: transcript.language,
    provenance: transcript.provenance,
    segmentCount: transcript.segments.length,
    segments,
    truncated: transcript.segments.length > segments.length
  }
}

export function probeProjection(probe: MediaProbeResult): JsonObject {
  return {
    schemaVersion: probe.schemaVersion,
    handleId: probe.handleId,
    container: probe.container,
    streams: probe.streams.slice(0, 32),
    truncated: probe.streams.length > 32
  }
}

export function assetFromProbe(
  assetId: string,
  metadata: MediaMetadata,
  probe: MediaProbeResult,
  options: {
    assetKind?: 'image' | 'animation'
    stillDurationFrames?: number
    stillDurationUs?: number
    fps?: VideoProject['fps']
  } = {}
): MediaAsset {
  const video = probe.streams.find(({ kind }) => kind === 'video')
  const audio = probe.streams.find(({ kind }) => kind === 'audio')
  if (!video && !audio) throw new ToolInputError('The selected media has no supported audio or video stream.')
  const probedDurationUs = probe.container.durationMicros ?? Math.max(
    0,
    ...probe.streams.map(({ durationMicros }) => durationMicros ?? 0)
  )
  const imageLike = metadata.kind === 'image'
  if (options.assetKind && !imageLike) {
    throw new ToolInputError('assetKind image/animation is only valid for a Host-granted image resource.')
  }
  if (imageLike) {
    if (!video?.width || !video.height) {
      throw new ToolInputError('The image probe did not provide bounded dimensions.')
    }
    const kind = options.assetKind ?? inferredImageAssetKind(metadata, probe)
    const fallbackDurationUs = options.stillDurationUs ?? framesToMicroseconds(
      options.stillDurationFrames ?? 150,
      options.fps ?? { numerator: 30, denominator: 1 }
    )
    const durationUs = kind === 'animation' && probedDurationUs > 0 ? probedDurationUs : fallbackDurationUs
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
      throw new ToolInputError('The image duration must be a positive bounded value.')
    }
    const format = (probe.container.formatNames[0] ?? extensionOf(metadata.displayName) ?? 'image').slice(0, 64)
    return {
      id: assetId,
      name: metadata.displayName,
      kind,
      mediaHandleId: metadata.handleId,
      durationUs,
      container: probe.container.formatNames.join(',').slice(0, 64) || format,
      still: {
        width: video.width,
        height: video.height,
        format,
        animated: kind === 'animation',
        ...(kind === 'animation' ? {
          frameRate: video.frameRate ?? options.fps ?? { numerator: 30, denominator: 1 },
          loop: true
        } : {})
      },
      transcriptIds: []
    }
  }
  const durationUs = probedDurationUs
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new ToolInputError('The selected media has no positive bounded duration.')
  }
  if (video && (!video.codecName || !video.width || !video.height || !video.frameRate)) {
    throw new ToolInputError('The video probe did not provide codec, dimensions, and rational frame rate.')
  }
  if (audio && (!audio.codecName || !audio.sampleRate || !audio.channelCount)) {
    throw new ToolInputError('The audio probe did not provide codec, sample rate, and channel count.')
  }
  const rotation = video?.rotationDegrees === undefined
    ? undefined
    : normalizeRotation(video.rotationDegrees)
  return {
    id: assetId,
    name: metadata.displayName,
    kind: video ? 'video' : 'audio',
    mediaHandleId: metadata.handleId,
    durationUs,
    container: probe.container.formatNames.join(',').slice(0, 64) || 'unknown',
    ...(video ? {
      video: {
        codec: video.codecName!,
        width: video.width!,
        height: video.height!,
        frameRate: video.frameRate!,
        ...(rotation === undefined ? {} : { rotation })
      }
    } : {}),
    ...(audio ? {
      audio: {
        codec: audio.codecName!,
        sampleRate: audio.sampleRate!,
        channels: audio.channelCount!
      }
    } : {}),
    transcriptIds: []
  }
}

export function initialItem(project: VideoProject, asset: MediaAsset): TimelineItem {
  const kind = asset.kind === 'audio' ? 'audio' : 'video'
  const track = project.tracks.find((candidate) => candidate.kind === kind)
  if (!track) throw new ToolInputError(`The active sequence has no ${kind} track for ${asset.id}.`)
  const trackId = track.id
  const end = project.items
    .filter((item) => item.trackId === trackId)
    .reduce((maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames), 0)
  return {
    id: `item-${asset.id}`,
    assetId: asset.id,
    trackId,
    timelineStartFrame: end,
    durationFrames: Math.max(1, microsecondsToFrames(asset.durationUs, project.fps)),
    sourceStartUs: 0,
    sourceEndUs: asset.durationUs,
    speed: { numerator: 1, denominator: 1 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0
  }
}

export function inferredImageAssetKind(metadata: MediaMetadata, probe: MediaProbeResult): 'image' | 'animation' {
  const formats = probe.container.formatNames.map((value) => value.toLocaleLowerCase())
  const extension = extensionOf(metadata.displayName)
  return formats.some((value) => value === 'gif' || value === 'apng') || extension === 'gif' || extension === 'apng'
    ? 'animation'
    : 'image'
}
