import type {
  MediaAudioAnalysisCapabilities
} from '@kun/extension-api'
import type {
  AudioSyncAnalysis,
  BeatAnalysisRecord,
  DenoiseMetadataCapability,
  DenoiseMetadataRecord,
  DiarizationRecord,
  MediaSearchPage,
  MediaSearchRequest,
  SpeakerDiarizationAdapterStatus,
  SpeakerIdentity,
  VadAnalysisRecord,
  VideoProject,
  VisualIndexRecord,
  VisualModelDescriptor,
  VisualModelInstallReceipt,
  VisualMomentPage,
  buildFrameSamplingPlan,
  negotiateSpeakerAdapter,
  negotiateVisualAdapter,
  VisualEmbeddingEvidence,
  VadFrameEvidence,
  DiarizationTurnEvidence,
  BeatObservation,
  DenoiseNoiseProfileEvidence,
  SourceIdentity
} from '../engine/index.js'

export type VisualModelBrokerStatus = {
  schemaVersion: 1
  state: 'missing' | 'downloading' | 'installed' | 'failed'
  descriptor: VisualModelDescriptor
  receipt?: VisualModelInstallReceipt
  installSupported: boolean
  checkedAt: string
  remediation: string
}

export type VisualProvisioningState = {
  schemaVersion: 1
  optIn: boolean
  state: 'disabled' | 'broker-unavailable' | 'missing' | 'downloading' | 'unverified' | 'inference-unavailable' | 'ready' | 'failed'
  code:
    | 'visual_model_disabled'
    | 'visual_model_broker_unavailable'
    | 'visual_model_missing'
    | 'visual_model_downloading'
    | 'visual_model_unverified'
    | 'visual_inference_broker_unavailable'
    | 'visual_model_ready'
    | 'visual_model_install_failed'
  installSupported: boolean
  packageSource?: 'bundled' | 'downloaded'
  model?: {
    adapterId: string
    adapterVersion: string
    packageId: string
    modelId: string
    modelVersion: string
    embeddingDimensions: number
    manifestSha256: string
  }
  verification: {
    brokerAttested: boolean
    downloadVerified: boolean
    sourceVerified: boolean
    installVerified: boolean
    signatureVerified: boolean
    manifestVerified: boolean
    errors: string[]
  }
  local: true
  networkUsedForInference: false
  rawPathsExposed: false
  urlsAccepted: false
  remediation: string
  checkedAt: string
}

export type MediaIntelligenceProgress = {
  schemaVersion: 1
  operationId: string
  projectId: string
  projectRevision: number
  kind: 'visual-index' | 'vad' | 'speaker' | 'beats' | 'denoise-metadata' | 'audio-sync'
  generation: number
  status: 'queued' | 'running' | 'cancelled' | 'ready' | 'failed'
  completed: number
  total: number
  message?: string
  error?: { code: string; message: string; retryable: boolean }
}

export type LocalMediaIntelligenceBroker = {
  readonly id: string
  readonly version: string
  validateMediaGrant?(mediaHandleId: string): Promise<boolean>
  capabilities?(): Promise<MediaAudioAnalysisCapabilities>
  denoiseMetadataCapability?(): Promise<DenoiseMetadataCapability>
  visualModelStatus?(): Promise<VisualModelBrokerStatus>
  requestVisualModelInstall?(request: {
    signal: AbortSignal
  }): Promise<VisualModelBrokerStatus>
  indexVisual?(request: {
    mediaHandleId: string
    samples: ReturnType<typeof buildFrameSamplingPlan>['samples']
    adapter: Extract<ReturnType<typeof negotiateVisualAdapter>, { outcome: 'ready' }>['adapter']
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<VisualEmbeddingEvidence[]>
  embedVisualQuery?(request: {
    query: string
    adapter: VisualIndexRecord['adapter']
    signal: AbortSignal
  }): Promise<number[]>
  analyzeVad?(request: {
    mediaHandleId: string
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<{
    frames: VadFrameEvidence[]
    completeness: 'complete' | 'partial'
    sourceFingerprint?: SourceIdentity
  }>
  diarize?(request: {
    mediaHandleId: string
    adapter: Extract<ReturnType<typeof negotiateSpeakerAdapter>, { outcome: 'ready' }>['adapter']
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<{ turns: DiarizationTurnEvidence[]; completeness: 'complete' | 'partial' }>
  analyzeBeats?(request: {
    mediaHandleId: string
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<{
    observations: BeatObservation[]
    tempoBpm?: number
    completeness: 'complete' | 'partial'
    sourceFingerprint?: SourceIdentity
  }>
  analyzeDenoiseMetadata?(request: {
    mediaHandleId: string
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<{
    evidence: DenoiseNoiseProfileEvidence
    sourceFingerprint: SourceIdentity
  }>
  extractSyncFeatures?(request: {
    referenceHandleId: string
    targetHandleId: string
    seed: number
    signal: AbortSignal
    report(completed: number, total: number, message?: string): Promise<void>
  }): Promise<{
    referenceFeatures: number[]
    targetFeatures: number[]
    samplePeriodUs: number
    referenceFingerprint?: SourceIdentity
    targetFingerprint?: SourceIdentity
  }>
}

export type IntelligenceRecord =
  | VisualIndexRecord
  | VadAnalysisRecord
  | DiarizationRecord
  | BeatAnalysisRecord
  | DenoiseMetadataRecord
  | AudioSyncAnalysis

export type Operation = {
  controller: AbortController
  progress: MediaIntelligenceProgress
  detachExternalCancellation?: () => void
}


export type AnalysisOutcome<T> =
  | { outcome: 'ready'; operationId: string; record: T; deduplicated: boolean }
  | { outcome: 'cancelled'; operationId: string }
  | { outcome: 'failed'; operationId: string; error: { code: string; message: string; retryable: boolean } }
  | { outcome: 'unavailable'; code: string; remediation: string; networkUsed: false }

export type OperationFailure =
  | { outcome: 'cancelled'; operationId: string }
  | { outcome: 'failed'; operationId: string; error: { code: string; message: string; retryable: boolean } }

export type AnalysisUnavailable = {
  outcome: 'unavailable'
  code: string
  remediation: string
  networkUsed: false
}
