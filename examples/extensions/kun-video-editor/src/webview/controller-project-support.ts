import {
  ExtensionApiError,
  ResultPreviewOpenPayloadSchema,
  type AgentRunEvent,
  type ExtensionHostClient,
  type GeneratedArtifact,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaMetadata,
  type MediaResourceLease
} from '@kun/extension-api'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  containsAsciiControlCharacters,
  replaceNullOrLineBreaks
} from '../text-safety.js'
import {
  INITIAL_EDITOR_STATE,
  VIEW_LIMITS,
  editorReducer,
  generatedArtifacts,
  toPersistedState,
  type CanvasFit,
  type CanvasPreset,
  type AssetProjection,
  type AudioAnalysisCapabilitiesProjection,
  type AudioAnalysisRecordProjection,
  type AudioSyncPreviewProjection,
  type DenoiseMetadataCapabilityProjection,
  type DerivedMediaKind,
  type DerivedMediaRecordProjection,
  type DerivedStorageUsageProjection,
  type EditorAction,
  type EditorNotice,
  type EditorState,
  type EditorWorkspace,
  type GenerationRecordProjection,
  type GenerationStateProjection,
  type MediaLibraryPageProjection,
  type MediaIntelligenceEvidenceProjection,
  type MediaIntelligenceProgressProjection,
  type PersistedEditorState,
  type PreviewComparisonProjection,
  type PreviewHistoryEntryProjection,
  type PreviewHistoryProjection,
  type PreviewSourceProjection,
  type ProjectChange,
  type ProjectPackageMissingMediaPolicy,
  type ProjectPackageTicket,
  type InterchangeLossManifestProjection,
  type OtioExportTicket,
  type OtioImportPreview,
  type OtioTimecodeMappingProjection,
  type MulticamGroupProjection,
  type ProjectProjection,
  type ProjectSummary,
  type RenderTicket,
  type SpeakerAdapterProjection,
  type SpeakerAttributionPlanProjection,
  type SpeakerIdentityProjection,
  type TimelineOperation,
  type VisualMomentPageProjection,
  type VisualProvisioningProjection
} from './model.js'
import type {
  GenerationCatalog,
  GenerationConsent,
  GenerationModelDescriptor,
  GenerationProviderDescriptor
} from '../engine/generation.js'
import type { GenerationPanelRequest } from './generation-panel.js'
import { formatMessage, messagesFor, type MessageKey } from './i18n.js'
import { renderCapabilityDetails } from './render-capability.js'
import type {
  MulticamCreateRequest,
  MulticamLayoutRequest,
  MulticamRenameRequest,
  MulticamSelectionRequest,
  MulticamSwitchRequest,
  MulticamSyncConfirmation
} from './multicam-panel.js'
import { isOtioExportTicket, isProjectPackageTicket, stableProjectionId } from './controller-package-support.js'

export function mediaIntelligenceEvidenceFrom(value: unknown): MediaIntelligenceEvidenceProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.recordId !== 'string' ||
    !['visual-index', 'vad', 'speaker-diarization', 'beat-grid', 'denoise-metadata', 'audio-sync'].includes(String(value.kind)) ||
    !['complete', 'partial', 'not-applicable'].includes(String(value.completeness)) ||
    safeInteger(value.offset) === undefined ||
    safeInteger(value.returned) === undefined ||
    safeInteger(value.total) === undefined ||
    !Array.isArray(value.evidence)
  ) return undefined
  const evidence = value.evidence
    .filter(isRecord)
    .slice(0, 500)
    .map((entry) => structuredClone(entry) as Record<string, string | number | boolean | string[]>)
  if (evidence.length !== value.evidence.length) return undefined
  return {
    schemaVersion: 1,
    recordId: value.recordId.slice(0, 512),
    kind: value.kind as MediaIntelligenceEvidenceProjection['kind'],
    offset: safeInteger(value.offset)!,
    returned: safeInteger(value.returned)!,
    total: safeInteger(value.total)!,
    ...(safeInteger(value.nextOffset) === undefined ? {} : { nextOffset: safeInteger(value.nextOffset)! }),
    completeness: value.completeness as MediaIntelligenceEvidenceProjection['completeness'],
    evidence
  }
}

export function mediaIntelligenceProgressFrom(value: unknown): MediaIntelligenceProgressProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== 'string' ||
    typeof value.projectId !== 'string' ||
    safeInteger(value.projectRevision) === undefined ||
    !['visual-index', 'vad', 'speaker', 'beats', 'denoise-metadata', 'audio-sync'].includes(String(value.kind)) ||
    !['queued', 'running', 'cancelled', 'ready', 'failed'].includes(String(value.status)) ||
    safeInteger(value.generation) === undefined ||
    safeInteger(value.completed) === undefined ||
    safeInteger(value.total) === undefined ||
    Number(value.total) < 1
  ) return undefined
  const error = isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    typeof value.error.retryable === 'boolean'
    ? {
        code: value.error.code.slice(0, 128),
        message: value.error.message.slice(0, 1_024),
        retryable: value.error.retryable
      }
    : undefined
  return {
    schemaVersion: 1,
    operationId: value.operationId.slice(0, 512),
    projectId: value.projectId.slice(0, 128),
    projectRevision: safeInteger(value.projectRevision)!,
    kind: value.kind as MediaIntelligenceProgressProjection['kind'],
    generation: safeInteger(value.generation)!,
    status: value.status as MediaIntelligenceProgressProjection['status'],
    completed: safeInteger(value.completed)!,
    total: safeInteger(value.total)!,
    ...(typeof value.message === 'string' ? { message: value.message.slice(0, 512) } : {}),
    ...(error ? { error } : {})
  }
}

export function audioSyncPreviewFrom(value: unknown): AudioSyncPreviewProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.analysisId !== 'string' ||
    typeof value.referenceItemId !== 'string' ||
    typeof value.targetItemId !== 'string' ||
    safeInteger(value.targetFrameBefore) === undefined ||
    signedSafeInteger(value.targetFrameAfter) === undefined ||
    typeof value.deltaFrames !== 'number' ||
    !Number.isSafeInteger(value.deltaFrames) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    !['ready', 'uncertain'].includes(String(value.outcome))
  ) return undefined
  return {
    analysisId: value.analysisId.slice(0, 512),
    referenceItemId: value.referenceItemId.slice(0, 128),
    targetItemId: value.targetItemId.slice(0, 128),
    targetFrameBefore: safeInteger(value.targetFrameBefore)!,
    targetFrameAfter: signedSafeInteger(value.targetFrameAfter)!,
    deltaFrames: value.deltaFrames,
    confidence: Math.max(0, Math.min(1, value.confidence)),
    outcome: value.outcome as 'ready' | 'uncertain',
    ...(typeof value.refusalReason === 'string' ? { refusalReason: value.refusalReason.slice(0, 128) } : {})
  }
}

export function numericProjection(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, number> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
  }))
}

export function mediaLibraryPageFrom(
  content: Record<string, unknown>,
  request: Pick<MediaLibraryPageProjection, 'projectId' | 'revision' | 'folderId' | 'query'>,
  invalidMessage: string
): MediaLibraryPageProjection {
  const page = isRecord(content.page) ? content.page : undefined
  const revision = safeInteger(content.revision)
  const offset = page && safeInteger(page.offset)
  const limit = page && safeInteger(page.limit)
  const total = page && safeInteger(page.total)
  const hiddenBefore = page && safeInteger(page.hiddenBefore)
  const hiddenAfter = page && safeInteger(page.hiddenAfter)
  const assets = page && Array.isArray(page.assets)
    ? page.assets.map(assetProjectionFrom).filter((value): value is AssetProjection => value !== undefined)
    : []
  if (
    content.outcome !== 'media-library' ||
    content.projectId !== request.projectId ||
    revision !== request.revision ||
    !page ||
    offset === undefined ||
    limit === undefined ||
    limit < 1 ||
    limit > 100 ||
    total === undefined ||
    hiddenBefore === undefined ||
    hiddenAfter === undefined ||
    !Array.isArray(page.assets) ||
    assets.length !== page.assets.length ||
    assets.length > limit ||
    hiddenBefore + assets.length + hiddenAfter !== total
  ) throw new Error(invalidMessage)
  assertNoRawMediaLocation(content, invalidMessage)
  return {
    projectId: request.projectId,
    revision,
    ...(request.folderId ? { folderId: request.folderId } : {}),
    query: request.query,
    offset,
    limit,
    total,
    hiddenBefore,
    hiddenAfter,
    assets
  }
}

export function assetProjectionFrom(value: unknown): AssetProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !['video', 'audio', 'image', 'animation'].includes(String(value.kind)) ||
    safeInteger(value.durationUs) === undefined ||
    typeof value.container !== 'string' ||
    !Array.isArray(value.transcriptIds) ||
    !value.transcriptIds.every((id) => typeof id === 'string')
  ) return undefined
  return {
    id: value.id,
    name: value.name,
    kind: value.kind as AssetProjection['kind'],
    ...(typeof value.mediaHandleId === 'string' ? { mediaHandleId: value.mediaHandleId } : {}),
    durationUs: Number(value.durationUs),
    container: value.container,
    ...(isRecord(value.video) ? { video: value.video as AssetProjection['video'] } : {}),
    ...(isRecord(value.audio) ? { audio: value.audio as AssetProjection['audio'] } : {}),
    ...(isRecord(value.still) ? { still: value.still as AssetProjection['still'] } : {}),
    ...(typeof value.folderId === 'string' ? { folderId: value.folderId } : {}),
    ...(isRecord(value.generatedLineage)
      ? { generatedLineage: value.generatedLineage as AssetProjection['generatedLineage'] }
      : {}),
    ...(['online', 'offline', 'revoked', 'changed'].includes(String(value.availability))
      ? { availability: value.availability as AssetProjection['availability'] }
      : {}),
    transcriptIds: value.transcriptIds as string[]
  }
}

export function projectFrom(content: Record<string, unknown>, invalidMessage: string): ProjectProjection {
  const value = isRecord(content.project) ? content.project : content
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.fps) ||
    !isRecord(value.canvas) ||
    !Number.isSafeInteger(value.currentRevision)
  ) throw new Error(invalidMessage)
  assertNoRawMediaLocation(value, invalidMessage)
  const multicamGroups = Array.isArray(value.multicamGroups)
    ? value.multicamGroups.slice(0, VIEW_LIMITS.multicamGroups)
    : []
  if (!multicamGroups.every(isMulticamGroupProjection)) throw new Error(invalidMessage)
  const projected = value as unknown as ProjectProjection
  return {
    ...projected,
    sequences: Array.isArray(value.sequences)
      ? projected.sequences
      : [{
          id: projected.activeSequenceId,
          name: projected.name,
          durationFrames: projected.durationFrames,
          itemCount: Array.isArray(value.items) ? value.items.length : 0,
          captionCount: Array.isArray(value.captions) ? value.captions.length : 0,
          viewState: { zoom: 1, scrollFrame: 0, open: true }
        }],
    mediaFolders: Array.isArray(value.mediaFolders) ? projected.mediaFolders : [],
    linkGroups: Array.isArray(value.linkGroups) ? projected.linkGroups : [],
    multicamGroups: multicamGroups as MulticamGroupProjection[]
  }
}

export function isMulticamGroupProjection(value: unknown): value is MulticamGroupProjection {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || typeof value.sequenceId !== 'string' ||
    typeof value.name !== 'string' || !isRecord(value.fps) ||
    !positiveSafeInteger(value.fps.numerator) || !positiveSafeInteger(value.fps.denominator) ||
    !positiveSafeInteger(value.durationFrames) || typeof value.referenceMemberId !== 'string' ||
    !Array.isArray(value.members) || !Array.isArray(value.layouts) ||
    !Array.isArray(value.programFragments)
  ) return false
  const membersValid = value.members.every((member) => {
    if (
      !isRecord(member) || typeof member.id !== 'string' || typeof member.assetId !== 'string' ||
      typeof member.memberLabel !== 'string' || typeof member.angleLabel !== 'string' ||
      !isRecord(member.sourceFps) || !positiveSafeInteger(member.sourceFps.numerator) ||
      !positiveSafeInteger(member.sourceFps.denominator) || !isRecord(member.sync) ||
      !['reference', 'verified', 'uncertain', 'unknown'].includes(String(member.sync.status)) ||
      signedSafeInteger(member.sync.offsetFrames) === undefined ||
      !Array.isArray(member.sync.evidence) || !Array.isArray(member.coverage)
    ) return false
    if (
      member.sync.confidence !== null && member.sync.confidence !== undefined &&
      (typeof member.sync.confidence !== 'number' || !Number.isFinite(member.sync.confidence) ||
        member.sync.confidence < 0 || member.sync.confidence > 1)
    ) return false
    return member.sync.evidence.every((evidence) =>
      isRecord(evidence) && typeof evidence.id === 'string' && typeof evidence.analysisId === 'string' &&
      ['audio-correlation', 'timecode', 'manual-confirmation'].includes(String(evidence.kind)) &&
      typeof evidence.referenceMemberId === 'string' && typeof evidence.targetMemberId === 'string' &&
      typeof evidence.confidence === 'number' && Number.isFinite(evidence.confidence) &&
      typeof evidence.algorithmId === 'string' && typeof evidence.algorithmVersion === 'string'
    ) && member.coverage.every((segment) =>
      isRecord(segment) && typeof segment.id === 'string' &&
      safeInteger(segment.startFrame) !== undefined && positiveSafeInteger(segment.endFrame) &&
      safeInteger(segment.sourceStartFrame) !== undefined && positiveSafeInteger(segment.sourceEndFrame)
    )
  })
  const layoutsValid = value.layouts.every((layout) =>
    isRecord(layout) && typeof layout.id === 'string' && typeof layout.label === 'string' &&
    Array.isArray(layout.slots) && layout.slots.every((slot) =>
      isRecord(slot) && typeof slot.memberId === 'string' &&
      ['x', 'y', 'width', 'height', 'opacity'].every((key) =>
        typeof slot[key] === 'number' && Number.isFinite(slot[key])
      ) && safeInteger(slot.zIndex) !== undefined && typeof slot.audioEnabled === 'boolean'
    )
  )
  const fragmentsValid = value.programFragments.every((fragment) =>
    isRecord(fragment) && typeof fragment.id === 'string' &&
    safeInteger(fragment.startFrame) !== undefined && positiveSafeInteger(fragment.endFrame) &&
    isRecord(fragment.selection) && (
      (fragment.selection.kind === 'angle' && typeof fragment.selection.memberId === 'string') ||
      (fragment.selection.kind === 'layout' && typeof fragment.selection.layoutId === 'string')
    )
  )
  return membersValid && layoutsValid && fragmentsValid
}

export function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export function assertNoRawMediaLocation(value: unknown, invalidMessage: string): void {
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 16) throw new Error(invalidMessage)
    if (Array.isArray(candidate)) {
      candidate.slice(0, 4_000).forEach((item) => visit(item, depth + 1))
      return
    }
    if (!isRecord(candidate)) return
    for (const [key, child] of Object.entries(candidate)) {
      if (/^(?:path|filePath|absolutePath|workspaceRelativePath|sourcePath|cachePath)$/iu.test(key)) {
        throw new Error(invalidMessage)
      }
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
}

export function localSelectionProjection(
  state: EditorState,
  project: ProjectProjection
): ProjectProjection['selection'] {
  return {
    sequenceId: project.activeSequenceId,
    revision: project.currentRevision,
    generation: project.selection.generation,
    playheadFrame: state.playheadFrame,
    selectedAssetIds: state.selectedAssetId ? [state.selectedAssetId] : [],
    selectedItemIds: state.selectedItemId ? [state.selectedItemId] : [],
    selectedCaptionIds: state.selectedCaptionId ? [state.selectedCaptionId] : [],
    selectedWordIds: [...project.selection.selectedWordIds],
    ...(project.selection.range ? { range: { ...project.selection.range } } : {})
  }
}

export function selectionFingerprint(selection: ProjectProjection['selection']): string {
  return JSON.stringify({
    sequenceId: selection.sequenceId,
    revision: selection.revision,
    playheadFrame: selection.playheadFrame,
    selectedAssetIds: selection.selectedAssetIds,
    selectedItemIds: selection.selectedItemIds,
    selectedCaptionIds: selection.selectedCaptionIds,
    selectedWordIds: selection.selectedWordIds,
    range: selection.range ?? null
  })
}

export function selectionUpdateFrom(value: unknown): {
  projectId: string
  revision: number
  generation: number
  eventGeneration: number
  selection: ProjectProjection['selection']
} | undefined {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    safeInteger(value.revision) === undefined ||
    safeInteger(value.generation) === undefined ||
    safeInteger(value.eventGeneration) === undefined ||
    !isRecord(value.selection)
  ) return undefined
  const selection = value.selection
  const sequenceId = typeof selection.sequenceId === 'string' ? selection.sequenceId : undefined
  const revision = safeInteger(selection.revision)
  const generation = safeInteger(selection.generation)
  const playheadFrame = safeInteger(selection.playheadFrame)
  if (!sequenceId || revision === undefined || generation === undefined || playheadFrame === undefined) {
    return undefined
  }
  const ids = (candidate: unknown): string[] | undefined => Array.isArray(candidate) &&
    candidate.length <= 200 && candidate.every((item) => typeof item === 'string')
    ? candidate as string[]
    : undefined
  const selectedAssetIds = ids(selection.selectedAssetIds)
  const selectedItemIds = ids(selection.selectedItemIds)
  const selectedCaptionIds = ids(selection.selectedCaptionIds)
  const selectedWordIds = ids(selection.selectedWordIds)
  if (!selectedAssetIds || !selectedItemIds || !selectedCaptionIds || !selectedWordIds) return undefined
  let range: ProjectProjection['selection']['range']
  if (selection.range !== undefined) {
    if (!isRecord(selection.range)) return undefined
    const startFrame = safeInteger(selection.range.startFrame)
    const endFrame = safeInteger(selection.range.endFrame)
    if (startFrame === undefined || endFrame === undefined || endFrame <= startFrame) return undefined
    range = { startFrame, endFrame }
  }
  return {
    projectId: value.projectId,
    revision: Number(value.revision),
    generation: Number(value.generation),
    eventGeneration: Number(value.eventGeneration),
    selection: {
      sequenceId,
      revision,
      generation,
      playheadFrame,
      selectedAssetIds,
      selectedItemIds,
      selectedCaptionIds,
      selectedWordIds,
      ...(range ? { range } : {})
    }
  }
}

export function persistedState(value: JsonValue | undefined): PersistedEditorState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  return {
    schemaVersion: 1,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.selectedItemId === 'string' ? { selectedItemId: value.selectedItemId } : {}),
    playheadFrame: safeInteger(value.playheadFrame) ?? 0,
    ...(typeof value.activeRunId === 'string' ? { activeRunId: value.activeRunId } : {}),
    activeWorkspace: isEditorWorkspace(value.activeWorkspace) ? value.activeWorkspace : 'script',
    renderTickets: Array.isArray(value.renderTickets)
      ? value.renderTickets.filter(isRenderTicket).slice(-VIEW_LIMITS.jobs)
      : [],
    projectPackageTickets: Array.isArray(value.projectPackageTickets)
      ? value.projectPackageTickets.filter(isProjectPackageTicket).slice(-VIEW_LIMITS.jobs)
      : [],
    otioExportTickets: Array.isArray(value.otioExportTickets)
      ? value.otioExportTickets.filter(isOtioExportTicket).slice(-VIEW_LIMITS.jobs)
      : [],
    transcriptWindowStart: safeInteger(value.transcriptWindowStart) ?? 0
  }
}

export function projectChange(value: JsonValue, fallbackReason: string): ProjectChange | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.projectId !== 'string') return undefined
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    revision: safeInteger(value.revision) ?? 0,
    ...(safeInteger(value.generation) === undefined ? {} : { generation: Number(value.generation) }),
    ...(typeof value.sequenceId === 'string' ? { sequenceId: value.sequenceId } : {}),
    ...(safeInteger(value.selectionGeneration) === undefined
      ? {}
      : { selectionGeneration: Number(value.selectionGeneration) }),
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : fallbackReason,
    changedIds: Array.isArray(value.changedIds)
      ? value.changedIds.filter((item): item is string => typeof item === 'string').slice(0, 2_000)
      : [],
    ...(isRecord(value.receipt) ? { receipt: value.receipt } : {}),
    ...(typeof value.proofInvalidated === 'boolean' ? { proofInvalidated: value.proofInvalidated } : {})
  }
}

export function requiredProject(state: EditorState, missingMessage: string): ProjectProjection {
  if (!state.project) throw new Error(missingMessage)
  return state.project
}

export function requiredProjectPackageTicket(
  state: EditorState,
  jobId: string,
  missingMessage: string
): ProjectPackageTicket {
  const project = requiredProject(state, missingMessage)
  const ticket = state.projectPackageTickets.find((candidate) =>
    candidate.jobId === jobId && candidate.projectId === project.id
  )
  if (!ticket) throw new Error(missingMessage)
  return ticket
}

export function requiredOtioExportTicket(
  state: EditorState,
  jobId: string,
  missingMessage: string
): OtioExportTicket {
  const project = requiredProject(state, missingMessage)
  const ticket = state.otioExportTickets.find((candidate) =>
    candidate.jobId === jobId && candidate.projectId === project.id
  )
  if (!ticket) throw new Error(missingMessage)
  return ticket
}

export function assetFromState(state: EditorState, assetId: string | undefined): AssetProjection | undefined {
  if (!assetId) return undefined
  return state.project?.assets.find(({ id }) => id === assetId) ??
    state.mediaLibrary?.assets.find(({ id }) => id === assetId)
}

export function asRecord(value: unknown, invalidMessage: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(invalidMessage)
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function signedSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined
}

export function isProjectSummary(value: unknown): value is ProjectSummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    Number.isSafeInteger(value.currentRevision) && typeof value.updatedAt === 'string' &&
    Number.isSafeInteger(value.durationFrames)
}

export function isRenderKind(value: unknown): value is RenderTicket['renderKind'] {
  return ['proof-frame', 'preview', 'h264-mp4', 'audio-aac', 'subtitles'].includes(String(value))
}

export function isRenderTicket(value: unknown): value is RenderTicket {
  return isRecord(value) && typeof value.jobId === 'string' && typeof value.projectId === 'string' &&
    Number.isSafeInteger(value.pinnedRevision) && isRenderKind(value.renderKind) && typeof value.createdAt === 'string'
}

export function isEditorWorkspace(value: unknown): value is EditorWorkspace {
  return ['script', 'clips', 'timeline', 'properties', 'output'].includes(String(value))
}

export function interchangeLossManifestFrom(
  value: unknown,
  invalidMessage: string
): InterchangeLossManifestProjection {
  if (!isRecord(value) || value.adapterId !== 'kun.otio-json' || value.adapterVersion !== '1.0.0' ||
    typeof value.portableLossless !== 'boolean' || typeof value.kunRoundTripLossless !== 'boolean' ||
    safeInteger(value.truncated) === undefined || !Array.isArray(value.entries) || value.entries.length > 128) {
    throw new Error(invalidMessage)
  }
  const entries = value.entries.map((entry): InterchangeLossManifestProjection['entries'][number] => {
    if (!isRecord(entry) ||
      typeof entry.code !== 'string' || entry.code.length < 1 || entry.code.length > 128 ||
      (entry.severity !== 'info' && entry.severity !== 'warning') ||
      typeof entry.feature !== 'string' || entry.feature.length < 1 || entry.feature.length > 128 ||
      !stableProjectionId(entry.nodeId) ||
      (entry.preservation !== 'otio-standard' && entry.preservation !== 'kun-metadata') ||
      typeof entry.message !== 'string' || entry.message.length < 1 || entry.message.length > 1_024) {
      throw new Error(invalidMessage)
    }
    return {
      code: entry.code,
      severity: entry.severity,
      feature: entry.feature,
      nodeId: entry.nodeId,
      preservation: entry.preservation,
      message: entry.message
    }
  })
  return {
    adapterId: 'kun.otio-json',
    adapterVersion: '1.0.0',
    portableLossless: value.portableLossless,
    kunRoundTripLossless: value.kunRoundTripLossless,
    entries,
    truncated: Number(value.truncated)
  }
}
