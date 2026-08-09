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
import { isRecord, safeInteger } from './controller-project-support.js'
import { previewComparisonFrom, previewHistoryFrom } from './controller-package-support.js'
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export function dispatchPreviewResult(
  projectId: string,
  content: Record<string, unknown>,
  dispatch: (action: EditorAction) => void
): void {
  const history = previewHistoryFrom(content.history)
  if (history) dispatch({ type: 'preview-history', projectId, value: history })
  const comparison = previewComparisonFrom(content.comparison)
  if (comparison) dispatch({ type: 'preview-comparison', projectId, value: comparison })
}

export function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,191}$/u.test(value)
}

export function boundedName(value: string, missingMessage: string): string {
  const normalized = replaceNullOrLineBreaks(value.trim(), ' ').slice(0, 160)
  if (!normalized) throw new Error(missingMessage)
  return normalized
}

export function localId(prefix: string, label: string): string {
  const slug = label.toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._~-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72) || 'item'
  return `${prefix}-${slug}-${Date.now().toString(36)}`.slice(0, 128)
}

export function derivedUsageFrom(value: unknown): DerivedStorageUsageProjection | undefined {
  if (!isRecord(value)) return undefined
  const fields = [
    'quotaBytes', 'usedBytes', 'readyBytes', 'recordCount', 'pinnedCount', 'evictableCount'
  ] as const
  if (fields.some((field) => !Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) return undefined
  return Object.fromEntries(fields.map((field) => [field, Number(value[field])])) as DerivedStorageUsageProjection
}

export function isDerivedKind(value: unknown): value is DerivedMediaKind {
  return ['waveform', 'thumbnail', 'filmstrip', 'transcript', 'analysis', 'embedding', 'proxy', 'proof', 'preview']
    .includes(String(value))
}

export function isDerivedStatus(value: unknown): value is DerivedMediaRecordProjection['status'] {
  return ['queued', 'running', 'partial', 'ready', 'failed', 'cancelled', 'interrupted', 'invalid']
    .includes(String(value))
}

export function isOpaqueHandleId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value)
}

export function derivedTarget(
  kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy',
  projectId: string,
  assetId: string,
  copy: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
): { suggestedName: string; filterName: string; extension: string; mimeType: string } {
  const image = kind !== 'proxy'
  return {
    suggestedName: `${projectId}-${assetId}-${kind}.${image ? 'png' : 'mp4'}`.slice(0, 256),
    filterName: image ? copy('chooseDerivedImage') : copy('chooseDerivedVideo'),
    extension: image ? 'png' : 'mp4',
    mimeType: image ? 'image/png' : 'video/mp4'
  }
}

export function derivedParameters(
  kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy',
  durationUs: number
): JsonObject {
  if (kind === 'waveform') return { width: 1_200, height: 240 }
  if (kind === 'thumbnail') return { width: 960, height: 540, seekUs: 0 }
  if (kind === 'filmstrip') return {
    width: 240,
    height: 135,
    filmstripIntervalUs: Math.max(1_000_000, Math.floor(durationUs / 10)),
    filmstripColumns: 5,
    filmstripRows: 2
  }
  return { width: 960, height: 540, durationUs: Math.max(1, durationUs) }
}

export function isRevisionConflict(error: unknown): boolean {
  const code = error instanceof ExtensionApiError ? error.code : isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ''
  const engineCode = error instanceof ExtensionApiError ? error.details?.engineCode : undefined
  return (
    code === 'CONFLICT' && (engineCode === 'revision_conflict' || engineCode === 'script_stale')
  ) || /REVISION_CONFLICT|revision.conflict/iu.test(String(code)) || /revision (?:conflict|has changed)/iu.test(message)
}

export function revisionFromError(error: unknown): number | undefined {
  if (!(error instanceof ExtensionApiError) || !error.details) return undefined
  return safeInteger(error.details.currentRevision)
}

export function isRevokedMediaError(error: unknown): boolean {
  const code = error instanceof ExtensionApiError ? error.code : isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ''
  return /MEDIA_(?:HANDLE_)?REVOKED|MEDIA_NOT_FOUND/iu.test(String(code)) || /media (?:handle )?(?:was )?(?:revoked|replaced|not found)/iu.test(message)
}

export function isOpaqueHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /error invoking remote method|extension operation failed/iu.test(message)
}

export function agentEventChangesProject(event: AgentRunEvent): boolean {
  if (event.type !== 'message' && event.type !== 'progress') return false
  return JSON.stringify(event).includes('currentRevision') || JSON.stringify(event).includes('project-changed')
}

export function transcriptFormat(
  displayName: string,
  mimeType: string,
  unsupportedMessage: string
): 'srt' | 'vtt' | 'json' {
  const normalized = displayName.toLowerCase()
  if (normalized.endsWith('.srt') || mimeType === 'application/x-subrip') return 'srt'
  if (normalized.endsWith('.vtt') || mimeType === 'text/vtt') return 'vtt'
  if (normalized.endsWith('.json') || mimeType === 'application/json') return 'json'
  throw new Error(unsupportedMessage)
}

export function visualAssetKind(
  displayName: string,
  mediaKind: MediaMetadata['kind']
): 'image' | 'animation' | undefined {
  if (mediaKind !== 'image') return undefined
  const extension = displayName.toLocaleLowerCase().split('.').at(-1)
  return extension === 'gif' || extension === 'apng' ? 'animation' : 'image'
}

export function transcriptSegmentCount(content: Record<string, unknown>): number {
  const details = isRecord(content.details) ? content.details : undefined
  return details && Number.isSafeInteger(details.segmentCount)
    ? Number(details.segmentCount)
    : Array.isArray(details?.segments)
      ? details.segments.length
      : 0
}

export function assertRenderCapabilities(
  state: EditorState,
  kind: RenderTicket['renderKind'],
  captionMode: 'none' | 'burned' | 'sidecar' | 'both',
  copy: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
): void {
  const capabilities = state.mediaCapabilities
  if ((kind === 'subtitles' || captionMode !== 'none') && !state.project?.captions.length) {
    throw new Error(copy('captionsRequiredForExport'))
  }
  if (!capabilities?.ffprobe.available) throw new Error(copy('ffprobeUnavailable'))
  if (kind !== 'subtitles' && !capabilities.ffmpeg.available) throw new Error(copy('ffmpegUnavailable'))
  const features = new Set(capabilities.ffmpeg.features)
  if ((kind === 'preview' || kind === 'h264-mp4') && !features.has('libx264-encoder')) {
    throw new Error(copy('h264EncoderUnavailable'))
  }
  if ((kind === 'audio-aac' || kind === 'h264-mp4') && !features.has('aac-encoder')) {
    throw new Error(copy('aacEncoderUnavailable'))
  }
  if ((captionMode === 'burned' || captionMode === 'both') && !features.has('drawtext-filter')) {
    throw new Error(copy('burnedCaptionsUnavailable'))
  }
}

export function renderCapabilityMessageKey(code: unknown): MessageKey {
  switch (code) {
    case 'FFPROBE_UNAVAILABLE': return 'ffprobeUnavailable'
    case 'FFMPEG_UNAVAILABLE': return 'ffmpegUnavailable'
    case 'LIBX264_ENCODER_UNAVAILABLE': return 'h264EncoderUnavailable'
    case 'AAC_ENCODER_UNAVAILABLE': return 'aacEncoderUnavailable'
    case 'DRAWTEXT_FILTER_UNAVAILABLE': return 'burnedCaptionsUnavailable'
    default: return 'mediaCapabilitiesUnavailable'
  }
}

export function artifactsForJobs(jobs: readonly JobSnapshot[]): GeneratedArtifact[] {
  const byId = new Map<string, GeneratedArtifact>()
  for (const job of jobs) for (const artifact of generatedArtifacts(job)) byId.set(artifact.artifactId, artifact)
  return [...byId.values()].slice(-64)
}
