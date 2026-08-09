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
import {
  interchangeLossManifestFrom,
  isRecord,
  safeInteger,
  signedSafeInteger
} from './controller-project-support.js'
import {
  boundedIdentifier,
  isDerivedKind,
  isDerivedStatus,
  isOpaqueHandleId
} from './controller-utility-support.js'

type ProjectPackageExportOptions = {
  missingMediaPolicy: ProjectPackageMissingMediaPolicy
  includeReceipts: boolean
  includeAgentProvenance: boolean
  mediaScope: 'all' | 'selected'
  assetIds?: string[]
}

export type OtioExportJobProjection = {
  jobId: string
  kind: 'media.ffmpeg'
  projectId: string
  sequenceId: string
  pinnedRevision: number
  adapterId: 'kun.otio-json'
  adapterVersion: '1.0.0'
  documentDigest: string
  projectDigest: string
  documentBytes: number
  lossManifest: InterchangeLossManifestProjection
}

export function otioExportJobProjectionFrom(
  value: unknown,
  invalidMessage: string
): OtioExportJobProjection {
  if (!isRecord(value)) throw new Error(invalidMessage)
  const documentBytes = safeInteger(value.documentBytes)
  if (
    value.kind !== 'media.ffmpeg' ||
    typeof value.jobId !== 'string' || !/^[A-Za-z0-9._~-]{8,256}$/u.test(value.jobId) ||
    !stableProjectionId(value.projectId) || !stableProjectionId(value.sequenceId) ||
    safeInteger(value.pinnedRevision) === undefined ||
    value.adapterId !== 'kun.otio-json' || value.adapterVersion !== '1.0.0' ||
    typeof value.documentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.documentDigest) ||
    typeof value.projectDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.projectDigest) ||
    documentBytes === undefined || documentBytes < 1 || documentBytes > 2 * 1024 * 1024
  ) throw new Error(invalidMessage)
  return {
    jobId: value.jobId,
    kind: 'media.ffmpeg',
    projectId: value.projectId,
    sequenceId: value.sequenceId,
    pinnedRevision: Number(value.pinnedRevision),
    adapterId: 'kun.otio-json',
    adapterVersion: '1.0.0',
    documentDigest: value.documentDigest,
    projectDigest: value.projectDigest,
    documentBytes,
    lossManifest: interchangeLossManifestFrom(value.lossManifest, invalidMessage)
  }
}

export function otioExportTicketFrom(
  value: unknown,
  project: ProjectProjection,
  invalidMessage: string
): OtioExportTicket {
  const projection = otioExportJobProjectionFrom(value, invalidMessage)
  if (
    projection.projectId !== project.id ||
    projection.sequenceId !== project.activeSequenceId ||
    projection.pinnedRevision !== project.currentRevision
  ) throw new Error(invalidMessage)
  const { kind: _kind, ...ticket } = projection
  return { schemaVersion: 1, ...ticket, createdAt: new Date().toISOString() }
}

export function isOtioExportTicket(value: unknown): value is OtioExportTicket {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))) return false
  try {
    otioExportJobProjectionFrom({ ...value, kind: 'media.ffmpeg' }, 'invalid')
    return true
  } catch {
    return false
  }
}

export function assertOtioExportProjection(
  value: unknown,
  ticket: OtioExportTicket,
  invalidMessage: string
): void {
  const projection = otioExportJobProjectionFrom(value, invalidMessage)
  if (
    projection.jobId !== ticket.jobId ||
    projection.projectId !== ticket.projectId ||
    projection.sequenceId !== ticket.sequenceId ||
    projection.pinnedRevision !== ticket.pinnedRevision ||
    projection.documentDigest !== ticket.documentDigest ||
    projection.projectDigest !== ticket.projectDigest ||
    projection.documentBytes !== ticket.documentBytes ||
    JSON.stringify(projection.lossManifest) !== JSON.stringify(ticket.lossManifest)
  ) throw new Error(invalidMessage)
}

export function assertOtioExportSnapshot(
  snapshot: JobSnapshot,
  ticket: OtioExportTicket,
  invalidMessage: string
): void {
  if (
    snapshot.id !== ticket.jobId ||
    snapshot.kind !== 'media.ffmpeg' ||
    snapshot.initiatingOperation !== 'media.startFfmpegJob'
  ) throw new Error(invalidMessage)
}

export function otioImportPreviewFrom(value: unknown, invalidMessage: string): OtioImportPreview {
  if (!isRecord(value) || value.outcome !== 'interchange-import-preview' ||
    value.adapterId !== 'kun.otio-json' || value.adapterVersion !== '1.0.0' ||
    value.persisted !== false || value.confirmationRequired !== true ||
    typeof value.inputHandleId !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/u.test(value.inputHandleId) ||
    typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 256 ||
    (value.displayName.includes('/') || value.displayName.includes('\\') ||
      containsAsciiControlCharacters(value.displayName)) ||
    typeof value.sourceDocumentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceDocumentDigest) ||
    !stableProjectionId(value.sourceProjectId) || safeInteger(value.sourceProjectRevision) === undefined ||
    !stableProjectionId(value.suggestedProjectId) ||
    (value.fidelity !== 'kun-metadata' && value.fidelity !== 'portable-otio') ||
    !isRecord(value.project)) throw new Error(invalidMessage)
  const project = value.project
  if (
    project.id !== value.sourceProjectId ||
    typeof project.name !== 'string' || project.name.length < 1 || project.name.length > 160 ||
    safeInteger(project.revision) !== Number(value.sourceProjectRevision) ||
    !stableProjectionId(project.activeSequenceId) || !isRecord(project.counts)
  ) throw new Error(invalidMessage)
  const projectCounts = project.counts
  if (!isRecord(projectCounts)) throw new Error(invalidMessage)
  const countNames = ['assets', 'sequences', 'tracks', 'items', 'captions', 'transcripts'] as const
  const counts = Object.fromEntries(countNames.map((name) => {
    const count = safeInteger(projectCounts[name])
    if (count === undefined) throw new Error(invalidMessage)
    return [name, count]
  })) as OtioImportPreview['project']['counts']
  if (!Array.isArray(value.mediaRelinkRequired) || value.mediaRelinkRequired.length > VIEW_LIMITS.assets ||
    !value.mediaRelinkRequired.every(stableProjectionId) || !Array.isArray(value.timecodeMappings) ||
    value.timecodeMappings.length > 256 || safeInteger(value.timecodeMappingsTruncated) === undefined) {
    throw new Error(invalidMessage)
  }
  const timecodeMappings = value.timecodeMappings.map((mapping): OtioTimecodeMappingProjection => {
    if (!isRecord(mapping) || !stableProjectionId(mapping.id) || !stableProjectionId(mapping.sequenceId) ||
      safeInteger(mapping.startFrame) === undefined || safeInteger(mapping.endFrame) === undefined ||
      Number(mapping.endFrame) < Number(mapping.startFrame) ||
      typeof mapping.startTimecode !== 'string' || !/^\d{2,}:\d{2}:\d{2}:\d{2}$/u.test(mapping.startTimecode) ||
      typeof mapping.endTimecode !== 'string' || !/^\d{2,}:\d{2}:\d{2}:\d{2}$/u.test(mapping.endTimecode) ||
      !isRecord(mapping.frameRate) || safeInteger(mapping.frameRate.numerator) === undefined ||
      safeInteger(mapping.frameRate.denominator) === undefined || Number(mapping.frameRate.numerator) < 1 ||
      Number(mapping.frameRate.denominator) < 1) throw new Error(invalidMessage)
    return {
      id: mapping.id,
      sequenceId: mapping.sequenceId,
      startFrame: Number(mapping.startFrame),
      endFrame: Number(mapping.endFrame),
      startTimecode: mapping.startTimecode,
      endTimecode: mapping.endTimecode,
      frameRate: {
        numerator: Number(mapping.frameRate.numerator),
        denominator: Number(mapping.frameRate.denominator)
      }
    }
  })
  return {
    inputHandleId: value.inputHandleId,
    displayName: value.displayName,
    sourceDocumentDigest: value.sourceDocumentDigest,
    sourceProjectId: value.sourceProjectId,
    sourceProjectRevision: Number(value.sourceProjectRevision),
    suggestedProjectId: value.suggestedProjectId,
    fidelity: value.fidelity,
    project: {
      id: value.sourceProjectId,
      name: project.name,
      revision: Number(project.revision),
      activeSequenceId: project.activeSequenceId,
      counts
    },
    mediaRelinkRequired: [...value.mediaRelinkRequired],
    timecodeMappings,
    timecodeMappingsTruncated: Number(value.timecodeMappingsTruncated),
    lossManifest: interchangeLossManifestFrom(value.lossManifest, invalidMessage)
  }
}

export function isProjectPackageTicket(value: unknown): value is ProjectPackageTicket {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.jobId === 'string' && /^[A-Za-z0-9._~-]{8,256}$/u.test(value.jobId) &&
    stableProjectionId(value.projectId) &&
    stableProjectionId(value.sequenceId) &&
    safeInteger(value.pinnedRevision) !== undefined &&
    typeof value.packageId === 'string' && /^pkg-[a-f0-9]{32}$/u.test(value.packageId) &&
    typeof value.manifestDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.manifestDigest) &&
    typeof value.complete === 'boolean' &&
    safeInteger(value.selectedAssetCount) !== undefined &&
    safeInteger(value.embeddedAssetCount) !== undefined &&
    safeInteger(value.uniqueMediaCount) !== undefined &&
    safeInteger(value.deduplicatedAssetCount) !== undefined &&
    Array.isArray(value.missingAssetIds) &&
    value.missingAssetIds.length <= VIEW_LIMITS.assets &&
    value.missingAssetIds.every(stableProjectionId) &&
    (value.missingMediaPolicy === 'fail' || value.missingMediaPolicy === 'omit') &&
    (value.mediaScope === 'all' || value.mediaScope === 'selected') &&
    typeof value.receiptsRequested === 'boolean' &&
    typeof value.agentProvenanceRequested === 'boolean' &&
    typeof value.createdAt === 'string'
}

export type ProjectPackageJobProjection = {
  jobId: string
  kind: 'media.archive'
  projectId: string
  sequenceId: string
  pinnedRevision: number
  packageId: string
  manifestDigest: string
  complete: boolean
  selectedAssetCount: number
  embeddedAssetCount: number
  uniqueMediaCount: number
  deduplicatedAssetCount: number
  missingAssetIds: string[]
  missingMediaPolicy: ProjectPackageMissingMediaPolicy
}

export function projectPackageJobProjectionFrom(
  value: unknown,
  invalidMessage: string
): ProjectPackageJobProjection {
  if (!isRecord(value)) throw new Error(invalidMessage)
  const projection: ProjectPackageJobProjection = {
    jobId: typeof value.jobId === 'string' ? value.jobId : '',
    kind: value.kind === 'media.archive' ? value.kind : 'media.archive',
    projectId: typeof value.projectId === 'string' ? value.projectId : '',
    sequenceId: typeof value.sequenceId === 'string' ? value.sequenceId : '',
    pinnedRevision: safeInteger(value.pinnedRevision) ?? -1,
    packageId: typeof value.packageId === 'string' ? value.packageId : '',
    manifestDigest: typeof value.manifestDigest === 'string' ? value.manifestDigest : '',
    complete: typeof value.complete === 'boolean' ? value.complete : false,
    selectedAssetCount: safeInteger(value.selectedAssetCount) ?? -1,
    embeddedAssetCount: safeInteger(value.embeddedAssetCount) ?? -1,
    uniqueMediaCount: safeInteger(value.uniqueMediaCount) ?? -1,
    deduplicatedAssetCount: safeInteger(value.deduplicatedAssetCount) ?? -1,
    missingAssetIds: Array.isArray(value.missingAssetIds)
      ? value.missingAssetIds.filter((assetId): assetId is string => typeof assetId === 'string')
      : [],
    missingMediaPolicy: value.missingMediaPolicy === 'omit' ? 'omit' : 'fail'
  }
  if (
    value.kind !== 'media.archive' ||
    !/^[A-Za-z0-9._~-]{8,256}$/u.test(projection.jobId) ||
    !stableProjectionId(projection.projectId) || !stableProjectionId(projection.sequenceId) ||
    projection.pinnedRevision < 0 ||
    !/^pkg-[a-f0-9]{32}$/u.test(projection.packageId) ||
    !/^[a-f0-9]{64}$/u.test(projection.manifestDigest) ||
    typeof value.complete !== 'boolean' ||
    projection.selectedAssetCount < 0 || projection.embeddedAssetCount < 0 ||
    projection.uniqueMediaCount < 0 || projection.deduplicatedAssetCount < 0 ||
    !Array.isArray(value.missingAssetIds) ||
    projection.missingAssetIds.length !== value.missingAssetIds.length ||
    projection.missingAssetIds.length > VIEW_LIMITS.assets ||
    !projection.missingAssetIds.every(stableProjectionId) ||
    (value.missingMediaPolicy !== 'fail' && value.missingMediaPolicy !== 'omit')
  ) throw new Error(invalidMessage)
  return projection
}

export function projectPackageTicketFrom(
  value: unknown,
  project: ProjectProjection,
  options: ProjectPackageExportOptions,
  invalidMessage: string
): ProjectPackageTicket {
  const projection = projectPackageJobProjectionFrom(value, invalidMessage)
  if (
    projection.projectId !== project.id ||
    projection.sequenceId !== project.activeSequenceId ||
    projection.pinnedRevision !== project.currentRevision ||
    projection.missingMediaPolicy !== options.missingMediaPolicy
  ) throw new Error(invalidMessage)
  const { kind: _kind, ...ticketProjection } = projection
  return {
    schemaVersion: 1,
    ...ticketProjection,
    mediaScope: options.mediaScope,
    receiptsRequested: options.includeReceipts,
    agentProvenanceRequested: options.includeAgentProvenance,
    createdAt: new Date().toISOString()
  }
}

export function assertProjectPackageProjection(
  value: unknown,
  ticket: ProjectPackageTicket,
  invalidMessage: string
): void {
  const projection = projectPackageJobProjectionFrom(value, invalidMessage)
  const staticFieldsMatch = projection.jobId === ticket.jobId &&
    projection.projectId === ticket.projectId &&
    projection.sequenceId === ticket.sequenceId &&
    projection.pinnedRevision === ticket.pinnedRevision &&
    projection.packageId === ticket.packageId &&
    projection.manifestDigest === ticket.manifestDigest &&
    projection.complete === ticket.complete &&
    projection.selectedAssetCount === ticket.selectedAssetCount &&
    projection.embeddedAssetCount === ticket.embeddedAssetCount &&
    projection.uniqueMediaCount === ticket.uniqueMediaCount &&
    projection.deduplicatedAssetCount === ticket.deduplicatedAssetCount &&
    projection.missingMediaPolicy === ticket.missingMediaPolicy &&
    projection.missingAssetIds.length === ticket.missingAssetIds.length &&
    projection.missingAssetIds.every((id, index) => id === ticket.missingAssetIds[index])
  if (!staticFieldsMatch) throw new Error(invalidMessage)
}

export function assertProjectPackageSnapshot(
  snapshot: JobSnapshot,
  ticket: ProjectPackageTicket,
  invalidMessage: string
): void {
  if (
    snapshot.id !== ticket.jobId ||
    snapshot.kind !== 'media.archive' ||
    snapshot.initiatingOperation !== 'media.startArchiveJob'
  ) throw new Error(invalidMessage)
}

export function stableProjectionId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) &&
    value !== '.' && value !== '..'
}

export function derivedRecordFrom(value: unknown): DerivedMediaRecordProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !Number.isSafeInteger(value.statusGeneration) ||
    Number(value.statusGeneration) < 1 ||
    Number(value.statusGeneration) > Number(value.generation) ||
    !isDerivedKind(value.kind) ||
    !isDerivedStatus(value.status) ||
    !['background', 'user', 'interactive', 'export'].includes(String(value.priority)) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    typeof value.pinned !== 'boolean' ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) return undefined
  const progress = isRecord(value.progress) &&
    typeof value.progress.completed === 'number' &&
    Number.isFinite(value.progress.completed) &&
    typeof value.progress.total === 'number' &&
    Number.isFinite(value.progress.total) &&
    value.progress.total > 0 &&
    typeof value.progress.unit === 'string'
    ? {
        completed: value.progress.completed,
        total: value.progress.total,
        unit: value.progress.unit.slice(0, 64),
        ...(typeof value.progress.message === 'string' ? { message: value.progress.message.slice(0, 512) } : {})
      }
    : undefined
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
    id: value.id,
    generation: Number(value.generation),
    statusGeneration: Number(value.statusGeneration),
    kind: value.kind,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    status: value.status,
    priority: value.priority as DerivedMediaRecordProjection['priority'],
    bytes: Number(value.bytes),
    pinned: value.pinned,
    attempt: Number(value.attempt),
    ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
    ...(progress ? { progress } : {}),
    ...(error ? { error } : {}),
    ...(typeof value.retryAfter === 'string' ? { retryAfter: value.retryAfter } : {}),
    ...(isOpaqueHandleId(value.artifactHandleId) ? { artifactHandleId: value.artifactHandleId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

export function previewHistoryFrom(value: unknown): PreviewHistoryProjection | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || safeInteger(value.generation) === undefined ||
    !Array.isArray(value.entries) || value.entries.length > VIEW_LIMITS.previewHistory
  ) return undefined
  const entries = value.entries
    .map(previewEntryFrom)
    .filter((entry): entry is PreviewHistoryEntryProjection => entry !== undefined)
  if (entries.length !== value.entries.length) return undefined
  const ids = new Set(entries.map(({ id }) => id))
  const activeEntryId = typeof value.activeEntryId === 'string' && ids.has(value.activeEntryId)
    ? value.activeEntryId
    : undefined
  return {
    schemaVersion: 1,
    generation: Number(value.generation),
    ...(activeEntryId ? { activeEntryId } : {}),
    entries
  }
}

export function previewEntryFrom(value: unknown): PreviewHistoryEntryProjection | undefined {
  if (
    !isRecord(value) || !boundedIdentifier(value.id) || !boundedIdentifier(value.projectId) ||
    typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 160 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.source)
  ) return undefined
  const source = previewSourceFrom(value.source)
  if (!source) return undefined
  return {
    id: value.id,
    projectId: value.projectId,
    createdAt: value.createdAt,
    label: value.label,
    source
  }
}

export function previewSourceFrom(value: Record<string, unknown>): PreviewSourceProjection | undefined {
  if (value.kind === 'asset') {
    const startUs = safeInteger(value.startUs)
    const endUs = safeInteger(value.endUs)
    return boundedIdentifier(value.assetId) && startUs !== undefined && endUs !== undefined && endUs > startUs
      ? { kind: 'asset', assetId: value.assetId, startUs, endUs }
      : undefined
  }
  if (value.kind === 'timeline') {
    const revision = safeInteger(value.revision)
    const startFrame = safeInteger(value.startFrame)
    const endFrame = safeInteger(value.endFrame)
    if (
      !boundedIdentifier(value.sequenceId) || revision === undefined || startFrame === undefined ||
      endFrame === undefined || endFrame <= startFrame ||
      (value.artifactId !== undefined && !boundedIdentifier(value.artifactId))
    ) return undefined
    return {
      kind: 'timeline',
      sequenceId: value.sequenceId,
      revision,
      startFrame,
      endFrame,
      ...(typeof value.artifactId === 'string' ? { artifactId: value.artifactId } : {})
    }
  }
  if (value.kind === 'generated') {
    const variantIndex = safeInteger(value.variantIndex)
    return boundedIdentifier(value.assetId) && boundedIdentifier(value.jobId) && variantIndex !== undefined
      ? { kind: 'generated', assetId: value.assetId, jobId: value.jobId, variantIndex }
      : undefined
  }
  return undefined
}

export function previewComparisonFrom(value: unknown): PreviewComparisonProjection | undefined {
  if (!isRecord(value) || !['wipe', 'side-by-side'].includes(String(value.mode))) return undefined
  const leftEntryId = typeof value.leftEntryId === 'string'
    ? value.leftEntryId
    : isRecord(value.left) && typeof value.left.id === 'string' ? value.left.id : undefined
  const rightEntryId = typeof value.rightEntryId === 'string'
    ? value.rightEntryId
    : isRecord(value.right) && typeof value.right.id === 'string' ? value.right.id : undefined
  if (!boundedIdentifier(leftEntryId) || !boundedIdentifier(rightEntryId) || leftEntryId === rightEntryId) return undefined
  return {
    leftEntryId,
    rightEntryId,
    mode: value.mode as PreviewComparisonProjection['mode'],
    sameRevision: value.sameRevision === true
  }
}
