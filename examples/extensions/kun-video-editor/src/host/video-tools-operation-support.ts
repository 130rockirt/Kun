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
import {
  asRecord,
  boundedArray,
  boundedNumber,
  boundedString,
  exactKeys,
  rational
} from './video-tools-input-support.js'
export function previewEntryId(
  project: VideoProject,
  history: PreviewHistory,
  source: PreviewSource,
  label: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ projectId: project.id, generation: history.generation + 1, source, label }))
    .digest('hex')
    .slice(0, 12)
  return `preview-${project.currentRevision}-${history.generation + 1}-${digest}`
}

export function strictTimelineOperation(value: unknown): TimelineOperation {
  const operation = asRecord(value, 'operation')
  const type = boundedString(operation.type, 'operation.type', 1, 64)
  const keys: Record<string, readonly string[]> = {
    'add-item': ['type', 'item'],
    'split-item': ['type', 'itemId', 'atFrame'],
    'trim-item': ['type', 'itemId', 'startFrame', 'endFrame'],
    'delete-item': ['type', 'itemId'],
    'move-item': ['type', 'itemId', 'trackId', 'timelineStartFrame'],
    'reorder-item': ['type', 'itemId', 'beforeItemId'],
    'update-transform': ['type', 'itemId', 'transform', 'opacity'],
    'update-track-state': ['type', 'trackId', 'muted', 'locked', 'syncLocked'],
    'update-item-properties': [
      'type', 'itemId', 'volume', 'fadeInFrames', 'fadeOutFrames', 'muted', 'visible', 'locked'
    ],
    'set-link-group': ['type', 'group'],
    'delete-link-group': ['type', 'linkGroupId'],
    'create-sequence': ['type', 'sequenceId', 'name', 'activate'],
    'duplicate-sequence': ['type', 'sourceSequenceId', 'sequenceId', 'name', 'activate'],
    'rename-sequence': ['type', 'sequenceId', 'name'],
    'select-sequence': ['type', 'sequenceId'],
    'open-sequence': ['type', 'sequenceId'],
    'close-sequence': ['type', 'sequenceId', 'fallbackSequenceId'],
    'delete-sequence': ['type', 'sequenceId'],
    'set-sequence-view': ['type', 'sequenceId', 'zoom', 'scrollFrame'],
    'set-item-keyframes': ['type', 'itemId', 'keyframes'],
    'set-item-effects': ['type', 'itemId', 'effects'],
    'update-item-composition': ['type', 'itemId', 'crop', 'opacity', 'blendMode'],
    'retime-item': ['type', 'itemId', 'speed'],
    'add-caption': ['type', 'caption'],
    'update-caption': ['type', 'captionId', 'patch'],
    'delete-caption': ['type', 'captionId'],
    'set-canvas': ['type', 'preset', 'fit'],
    'set-multicam-group': ['type', 'group'],
    'delete-multicam-group': ['type', 'groupId'],
    'switch-multicam-angle': [
      'type', 'groupId', 'memberId', 'startFrame', 'endFrame',
      'coveragePolicy', 'minimumSyncConfidence'
    ],
    'apply-multicam-layout': [
      'type', 'groupId', 'layoutId', 'startFrame', 'endFrame',
      'coveragePolicy', 'minimumSyncConfidence'
    ],
    'merge-multicam-program': ['type', 'groupId']
  }
  const allowed = keys[type]
  if (!allowed) throw new ToolInputError(`Unsupported timeline operation: ${type}`)
  exactKeys(operation, allowed)
  if (type === 'add-item') strictTimelineItem(operation.item)
  if (type === 'add-caption') strictCaption(operation.caption, 'operation.caption')
  if (type === 'update-caption') strictCaptionPatch(operation.patch)
  if (type === 'update-transform') strictTransformPatch(operation.transform)
  if (type === 'set-link-group') strictLinkGroup(operation.group)
  if (type === 'set-item-keyframes') strictKeyframeTracks(operation.keyframes, 'operation.keyframes')
  if (type === 'set-item-effects') strictEffects(operation.effects, 'operation.effects')
  if (type === 'update-item-composition' && operation.crop !== undefined) {
    exactKeys(asRecord(operation.crop, 'operation.crop'), ['left', 'top', 'right', 'bottom'])
  }
  if (type === 'retime-item') rational(operation.speed, 'operation.speed')
  return TimelineOperationSchema.parse(operation)
}

export function assertAgentMulticamSyncAuthority(
  project: VideoProject,
  operations: readonly TimelineOperation[]
): void {
  for (const operation of operations) {
    if (operation.type !== 'set-multicam-group') continue
    const current = (project.multicamGroups ?? []).find(({ id }) => id === operation.group.id)
    for (const member of operation.group.members) {
      const previous = current?.members.find(({ id }) => id === member.id)
      if (previous) {
        if (JSON.stringify(previous.sync) !== JSON.stringify(member.sync)) {
          throw new ToolInputError(
            'Agent multicam updates cannot create or alter synchronization evidence; ' +
            'use verified analysis or an explicit right-sidebar user confirmation.'
          )
        }
        continue
      }
      const isReference = member.id === operation.group.referenceMemberId
      const allowed = isReference
        ? member.sync.status === 'reference' && member.sync.offsetFrames === 0 &&
          member.sync.confidence === 1 && member.sync.evidence.length === 0
        : member.sync.status === 'unknown' && member.sync.confidence === undefined &&
          member.sync.evidence.length === 0
      if (!allowed) {
        throw new ToolInputError(
          'New Agent multicam members must remain unsynchronized until attributable evidence exists.'
        )
      }
    }
  }
}

export function strictTimelineItem(value: unknown): void {
  const item = asRecord(value, 'operation.item')
  exactKeys(item, [
    'id', 'assetId', 'trackId', 'timelineStartFrame', 'durationFrames', 'sourceStartUs',
    'sourceEndUs', 'speed', 'transform', 'opacity', 'fadeInFrames', 'fadeOutFrames',
    'linkGroupId', 'nestedSequenceId', 'crop', 'blendMode', 'volume', 'muted', 'visible', 'locked',
    'effects', 'keyframes'
  ])
  rational(item.speed, 'operation.item.speed')
  strictTransform(item.transform, 'operation.item.transform')
  if (item.crop !== undefined) {
    exactKeys(asRecord(item.crop, 'operation.item.crop'), ['left', 'top', 'right', 'bottom'])
  }
  if (item.effects !== undefined) strictEffects(item.effects, 'operation.item.effects')
  if (item.keyframes !== undefined) strictKeyframeTracks(item.keyframes, 'operation.item.keyframes')
}

export function strictEffects(value: unknown, label: string): void {
  boundedArray(value, label, 0, 32).forEach((entry, index) => {
    const effect = asRecord(entry, `${label}[${index}]`)
    exactKeys(effect, ['id', 'type', 'enabled', 'parameters'])
    const parameters = asRecord(effect.parameters, `${label}[${index}].parameters`)
    if (Object.keys(parameters).length > 64) {
      throw new ToolInputError(`${label}[${index}].parameters exceeds its limit.`)
    }
  })
}

export function strictKeyframeTracks(value: unknown, label: string): void {
  boundedArray(value, label, 0, 32).forEach((entry, index) => {
    const track = asRecord(entry, `${label}[${index}]`)
    exactKeys(track, ['id', 'property', 'interpolation', 'points'])
    boundedArray(track.points, `${label}[${index}].points`, 1, 2_048)
      .forEach((point, child) => {
        exactKeys(asRecord(point, `${label}[${index}].points[${child}]`), ['id', 'frame', 'value'])
      })
  })
}

export function strictLinkGroup(value: unknown): void {
  const group = asRecord(value, 'operation.group')
  exactKeys(group, ['id', 'kind', 'itemIds', 'locked'])
  boundedArray(group.itemIds, 'operation.group.itemIds', 2, 32)
}

export function strictTransform(value: unknown, label: string): void {
  const transform = asRecord(value, label)
  exactKeys(transform, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
}

export function strictTransformPatch(value: unknown): void {
  const transform = asRecord(value, 'operation.transform')
  exactKeys(transform, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
}

export function strictCaption(value: unknown, label: string): void {
  const caption = asRecord(value, label)
  exactKeys(caption, [
    'id', 'trackId', 'startFrame', 'endFrame', 'text', 'placement', 'style',
    'sourceTranscriptId', 'sourceSegmentIds', 'words', 'animation'
  ])
  strictCaptionDetails(caption, label)
}

export function strictCaptionPatch(value: unknown): void {
  const patch = asRecord(value, 'operation.patch')
  exactKeys(patch, [
    'trackId', 'startFrame', 'endFrame', 'text', 'placement', 'style',
    'sourceTranscriptId', 'sourceSegmentIds', 'words', 'animation'
  ])
  strictCaptionDetails(patch, 'operation.patch')
}

export function strictCaptionDetails(caption: ToolInput, label: string): void {
  if (caption.style !== undefined) {
    exactKeys(
      asRecord(caption.style, `${label}.style`),
      ['fontSize', 'color', 'background', 'fontFamily', 'fontWeight', 'maxWidthRatio']
    )
  }
  if (caption.sourceSegmentIds !== undefined) {
    boundedArray(caption.sourceSegmentIds, `${label}.sourceSegmentIds`, 0, 256)
  }
  if (caption.words !== undefined) {
    boundedArray(caption.words, `${label}.words`, 0, 512).forEach((value, index) => {
      exactKeys(
        asRecord(value, `${label}.words[${index}]`),
        ['id', 'text', 'startFrame', 'endFrame', 'sourceWordId']
      )
    })
  }
  if (caption.animation !== undefined) {
    exactKeys(asRecord(caption.animation, `${label}.animation`), ['kind', 'durationFrames'])
  }
}

export function analysisIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,511}$/u.test(value)
  ) {
    throw new ToolInputError(`${label} must be a bounded local analysis identifier.`)
  }
  return value
}
