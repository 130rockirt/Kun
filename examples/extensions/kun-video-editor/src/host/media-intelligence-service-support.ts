import type {
  ExtensionContext,
  JsonObject,
  JsonValue,
  MediaAudioAnalysisCapabilities
} from '@kun/extension-api'
import {
  containsAsciiControlCharacters,
  replaceAsciiControlCharacters
} from '../text-safety.js'
import {
  SpeakerIdentityRegistry,
  SpeakerRegistry,
  VisualIndexProgressTracker,
  analyzeAudioSynchronization,
  audioSyncAnalysisId,
  analyzeBeatEvidence,
  analyzeVadEvidence,
  buildFrameSamplingPlan,
  createVisualIndexRecord,
  combineAudioSourceFingerprints,
  createDenoiseMetadataRecord,
  diarizeSpeakerEvidence,
  defaultSpeakerDiarizationAdapterRegistry,
  fingerprintAssetIdentity,
  importSpeakerDiarizationEvidence,
  isValidVisualIndexRecord,
  isValidDenoiseMetadataAdapterDescriptor,
  isValidDenoiseMetadataRecord,
  negotiateSpeakerAdapter,
  negotiateVisualAdapter,
  readMediaIntelligenceEvidence,
  searchProjectMedia,
  searchVisualMoments,
  verifyVisualModelInstallation,
  type AudioSyncAnalysis,
  type BeatAnalysisRecord,
  type BeatObservation,
  type DiarizationRecord,
  type DiarizationTurnEvidence,
  type DenoiseMetadataCapability,
  type DenoiseMetadataRecord,
  type DenoiseNoiseProfileEvidence,
  type MediaSearchPage,
  type MediaSearchRequest,
  type SourceIdentity,
  type ImportedDiarizationTurn,
  type SpeakerDiarizationAdapterStatus,
  type SpeakerIdentity,
  type SpeakerModelDescriptor,
  type VadAnalysisRecord,
  type VadFrameEvidence,
  type VideoProject,
  type VisualEmbeddingEvidence,
  type VisualIndexRecord,
  type VisualModelDescriptor,
  type VisualModelInstallReceipt,
  type VisualMomentPage
} from '../engine/index.js'
import type {
  AnalysisOutcome,
  AnalysisUnavailable,
  IntelligenceRecord,
  VisualModelBrokerStatus,
  VisualProvisioningState
} from './media-intelligence-service-model.js'

const GRANT_BINDING_PREFIX = 'media-intelligence:grant-binding:'
const SPEAKER_REGISTRY_PREFIX = 'media-intelligence:speaker-registry:'

export function cachedOutcome<T>(record: T): AnalysisOutcome<T> {
  const recordId = typeof record === 'object' && record !== null && 'id' in record
    ? String(record.id)
    : 'record'
  return {
    outcome: 'ready',
    operationId: `cached-${recordId}`.slice(0, 512),
    record,
    deduplicated: true
  }
}

export function unavailableAnalysis(code: string, remediation: string): AnalysisOutcome<never> {
  return { outcome: 'unavailable', code, remediation, networkUsed: false }
}

export function requiredAsset(project: VideoProject, assetId: string): VideoProject['assets'][number] {
  const asset = project.assets.find(({ id }) => id === assetId)
  if (!asset) throw new Error(`Media-intelligence asset does not exist: ${assetId}`)
  return asset
}

export function requiredHandle(asset: VideoProject['assets'][number]): string {
  if (!asset.mediaHandleId) throw new Error(`Asset ${asset.id} requires reauthorization before local analysis.`)
  return asset.mediaHandleId
}

export function sourceFingerprint(asset: VideoProject['assets'][number]): SourceIdentity {
  return asset.sourceIdentity?.algorithm === 'sha256'
    ? structuredClone(asset.sourceIdentity)
    : fingerprintAssetIdentity(asset)
}

export function safePart(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) throw new Error('Storage identity is invalid.')
  return value
}

export function grantBindingKey(projectId: string, recordId: string): string {
  return `${GRANT_BINDING_PREFIX}${safePart(projectId)}:${safePart(recordId)}`
}

export function speakerRegistryKey(projectId: string): string {
  return `${SPEAKER_REGISTRY_PREFIX}${safePart(projectId)}`
}

export function isIntelligenceRecord(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.schemaVersion !== 1 || value.immutable !== true || typeof value.id !== 'string') return false
  return value.id.startsWith('visual-index:')
    ? isValidVisualIndexRecord(value)
    : value.kind === 'denoise-metadata'
      ? isValidDenoiseMetadataRecord(value)
      : ['vad', 'speaker-diarization', 'beat-grid', 'audio-sync'].includes(String(value.kind))
}

export function isVisualIndexRecord(record: IntelligenceRecord): record is VisualIndexRecord {
  return record.id.startsWith('visual-index:') && isValidVisualIndexRecord(record)
}

export function withoutVisualCreatedAt(record: VisualIndexRecord): Omit<VisualIndexRecord, 'createdAt'> {
  const { createdAt: _createdAt, ...evidence } = record
  return evidence
}

export function withoutDenoiseCreatedAt(record: DenoiseMetadataRecord): DenoiseMetadataRecord {
  const clone = structuredClone(record)
  clone.provenance.createdAt = ''
  return clone
}

export function isVadRecord(record: IntelligenceRecord): record is VadAnalysisRecord {
  return !isVisualIndexRecord(record) && record.kind === 'vad'
}

export function isDiarizationRecord(record: IntelligenceRecord): record is DiarizationRecord {
  return !isVisualIndexRecord(record) && record.kind === 'speaker-diarization'
}

export function isBeatRecord(record: IntelligenceRecord): record is BeatAnalysisRecord {
  return !isVisualIndexRecord(record) && record.kind === 'beat-grid'
}

export function isDenoiseRecord(record: IntelligenceRecord): record is DenoiseMetadataRecord {
  return !isVisualIndexRecord(record) && record.kind === 'denoise-metadata' &&
    isValidDenoiseMetadataRecord(record)
}

export function isAudioSyncRecord(record: IntelligenceRecord): record is AudioSyncAnalysis {
  return !isVisualIndexRecord(record) && record.kind === 'audio-sync'
}

export function abortError(): Error {
  const error = new Error('Local analysis cancelled')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function yieldToCancellation(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function restoreStorageValue(
  context: ExtensionContext,
  key: string,
  value: JsonValue | undefined
): Promise<void> {
  if (value === undefined) await context.storage.workspace.delete(key)
  else await context.storage.workspace.set(key, value)
}

export function isUnavailableError(error: unknown): error is Error & {
  code: string
  remediation: string
  retryable: boolean
  networkUsed: false
} {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & Partial<{
    code: unknown
    remediation: unknown
    retryable: unknown
    networkUsed: unknown
  }>
  return typeof candidate.code === 'string' &&
    typeof candidate.remediation === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    candidate.networkUsed === false
}

export function unavailableError(code: string, remediation: string, retryable: boolean): Error & {
  code: string
  remediation: string
  retryable: boolean
  networkUsed: false
} {
  return Object.assign(new Error(remediation), { code, remediation, retryable, networkUsed: false as const })
}

export function boundedConfidence(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be from 0 through 1`)
  }
  return value
}

export function visualProvisioningProjection(
  value: Omit<VisualProvisioningState, 'schemaVersion' | 'local' | 'networkUsedForInference' | 'rawPathsExposed' | 'urlsAccepted'>
): VisualProvisioningState {
  return {
    schemaVersion: 1,
    ...value,
    local: true,
    networkUsedForInference: false,
    rawPathsExposed: false,
    urlsAccepted: false
  }
}

export function visualModelProjection(
  descriptor: VisualModelDescriptor
): NonNullable<VisualProvisioningState['model']> {
  // Negotiation below performs the authoritative descriptor validation. This
  // projection intentionally omits file names, URLs, and any runtime location.
  return {
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    packageId: descriptor.packageId,
    modelId: descriptor.modelId,
    modelVersion: descriptor.modelVersion,
    embeddingDimensions: descriptor.embeddingDimensions,
    manifestSha256: descriptor.manifestSha256
  }
}

export function verifyVisualReceiptProjection(
  descriptor: VisualModelDescriptor,
  receipt: VisualModelInstallReceipt
): VisualProvisioningState['verification'] {
  const result = verifyVisualModelInstallation(descriptor, receipt)
  return {
    brokerAttested: receipt.broker === 'kun-model-broker',
    downloadVerified: receipt.downloadVerified === true,
    sourceVerified: (receipt.packageSource ?? 'downloaded') === 'bundled'
      ? receipt.sourceVerified === true
      : receipt.downloadVerified === true,
    installVerified: receipt.installVerified === true,
    signatureVerified: receipt.signatureVerified === true,
    manifestVerified: result.valid,
    errors: result.errors.map((error) => boundedRemediation(error)).slice(0, 32)
  }
}

export function boundedRemediation(value: string): string {
  const printable = replaceAsciiControlCharacters(value.normalize('NFKC'), ' ')
    .replace(/\b(?:file|https?):\/\/\S+/giu, '[redacted-location]')
    .replace(/\/(?:Users|private|tmp|home)\/[^\s,;]+/gu, '[redacted-path]')
    .replace(/\s+/gu, ' ')
    .trim()
  return (printable || 'Check the approved Host model runtime and retry.').slice(0, 1_024)
}

export function safeCheckedAt(value: string, fallback: string): string {
  if (!Number.isFinite(Date.parse(value))) return fallback
  const normalized = new Date(value).toISOString()
  return normalized === value ? value : fallback
}
