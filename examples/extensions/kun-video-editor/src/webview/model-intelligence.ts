import type {
  GenerationCatalog,
  GenerationOutputKind,
  GenerationTask
} from '../engine/generation.js'

export type DerivedMediaKind = 'waveform' | 'thumbnail' | 'filmstrip' | 'transcript' | 'analysis' | 'embedding' | 'proxy' | 'proof' | 'preview'
export type DerivedMediaStatus = 'queued' | 'running' | 'partial' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'invalid'

export type DerivedMediaRecordProjection = {
  schemaVersion: 1
  id: string
  generation: number
  statusGeneration: number
  kind: DerivedMediaKind
  projectId?: string
  assetId?: string
  status: DerivedMediaStatus
  priority: 'background' | 'user' | 'interactive' | 'export'
  bytes: number
  pinned: boolean
  attempt: number
  jobId?: string
  progress?: { completed: number; total: number; unit: string; message?: string }
  error?: { code: string; message: string; retryable: boolean }
  retryAfter?: string
  artifactHandleId?: string
  createdAt: string
  updatedAt: string
}

export type DerivedStorageUsageProjection = {
  quotaBytes: number
  usedBytes: number
  readyBytes: number
  recordCount: number
  pinnedCount: number
  evictableCount: number
}

export type PreviewSourceProjection =
  | { kind: 'asset'; assetId: string; startUs: number; endUs: number }
  | {
      kind: 'timeline'
      sequenceId: string
      revision: number
      startFrame: number
      endFrame: number
      artifactId?: string
    }
  | { kind: 'generated'; assetId: string; jobId: string; variantIndex: number }

export type PreviewHistoryEntryProjection = {
  id: string
  projectId: string
  createdAt: string
  label: string
  source: PreviewSourceProjection
}

export type PreviewHistoryProjection = {
  schemaVersion: 1
  generation: number
  activeEntryId?: string
  entries: PreviewHistoryEntryProjection[]
}

export type PreviewComparisonProjection = {
  leftEntryId: string
  rightEntryId: string
  mode: 'wipe' | 'side-by-side'
  sameRevision: boolean
}

export type AudioAnalysisCapabilityProjection = {
  analysis: 'silence' | 'beat-grid' | 'sync-features'
  available: boolean
  algorithm?: string
  algorithmVersion?: string
  code?: string
  remediation?: string
  retryable?: boolean
  local: true
  networkUsed: false
}

export type AudioAnalysisCapabilitiesProjection = {
  schemaVersion: 1
  probedAt: string
  analyses: AudioAnalysisCapabilityProjection[]
}

export type DenoiseMetadataCapabilityProjection = {
  outcome: 'ready' | 'unavailable'
  descriptor?: {
    adapterId: string
    adapterVersion: string
    algorithm: string
    algorithmVersion: string
    modelId?: string
    modelVersion?: string
  }
  code?: string
  remediation?: string
  retryable?: boolean
  local: true
  networkUsed: false
}

export type AudioAnalysisRecordProjection = {
  schemaVersion: 1
  id: string
  kind: 'vad' | 'beat-grid' | 'denoise-metadata' | 'audio-sync' | 'speaker-diarization' | 'visual-index'
  assetId?: string
  referenceAssetId?: string
  targetAssetId?: string
  completeness?: 'complete' | 'partial'
  silenceCount?: number
  safeSuggestionCount?: number
  suggestionConfidenceThreshold?: number
  markerCount?: number
  tempoBpm?: number
  snapTargets?: Array<{
    id: string
    frame: number
    kind: 'beat' | 'downbeat'
    confidence: number
  }>
  turnCount?: number
  identifiedTurnCount?: number
  uncertainTurnCount?: number
  indexedSampleCount?: number
  plannedSampleCount?: number
  omittedSampleCount?: number
  adapterId?: string
  adapterVersion?: string
  modelId?: string
  modelVersion?: string
  packageId?: string
  manifestSha256?: string
  intervalUs?: number
  maxFrames?: number
  samplingStrategy?: 'uniform-interval-v1'
  seed?: number
  proposedTargetDeltaUs?: number
  confidence?: number
  confidenceThreshold?: number
  separation?: number
  threshold?: number
  minimumSeparation?: number
  outcome?: 'ready' | 'uncertain'
  status?: 'ready' | 'low-confidence'
  noiseProfile?: {
    analyzedDurationUs: number
    sampleWindowCount: number
    levels: {
      noiseFloorDbfs: number
      averageRmsDbfs: number
      peakDbfs: number
      estimatedSnrDb: number
    }
    spectralBandCount: number
  }
  recommendation?: {
    reductionDb: number
    confidence: number
    disposition: 'preview-suggested' | 'review-required'
    autoApplyAllowed: false
    audioMutation: 'none'
  }
  metadataOnly?: true
  refusalReason?: string
  currentGrant?: boolean
  immutable: true
}

export type SpeakerAdapterProjection = {
  descriptor: {
    id: string
    version: string
    execution: 'local-model' | 'import'
    format?: 'kun-speaker-json-v1'
    modelId?: string
    modelVersion?: string
  }
  outcome: 'ready' | 'unavailable'
  code?: string
  remediation?: string
  local: true
  networkUsed: false
}

export type SpeakerIdentityProjection = {
  id: string
  label: string
  aliases: string[]
  sourceEvidenceIds: string[]
  createdAt: string
  updatedAt: string
}

export type SpeakerAttributionPlanProjection = {
  analysisId: string
  transcriptSegmentCount: number
  captionCount: number
  identifiedCount: number
  uncertainCount: number
  warnings: string[]
}

export type VisualProvisioningProjection = {
  schemaVersion: 1
  optIn: boolean
  state: 'disabled' | 'broker-unavailable' | 'missing' | 'downloading' | 'unverified' | 'inference-unavailable' | 'ready' | 'failed'
  code: string
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

export type VisualMomentPageProjection = {
  schemaVersion: 1
  indexId: string
  offset: number
  results: Array<{
    id: string
    assetId: string
    sourceRange: { assetId: string; startUs: number; endUs: number }
    score: number
    sampleId: string
    representativeUs: number
    modelConfidence?: number
  }>
  nextOffset?: number
  totalMatches: number
  completeness: 'complete' | 'partial'
  ranking: {
    semantics: 'uncalibrated-cosine'
    calibratedConfidence: false
    local: true
    networkUsed: false
    adapterId: string
    adapterVersion: string
    modelId: string
    modelVersion: string
    packageId: string
    manifestSha256: string
  }
}

export type MediaIntelligenceEvidenceProjection = {
  schemaVersion: 1
  recordId: string
  kind: 'visual-index' | 'vad' | 'speaker-diarization' | 'beat-grid' | 'denoise-metadata' | 'audio-sync'
  offset: number
  returned: number
  total: number
  nextOffset?: number
  completeness: 'complete' | 'partial' | 'not-applicable'
  evidence: Array<Record<string, string | number | boolean | string[]>>
}

export type AudioSyncPreviewProjection = {
  referenceItemId: string
  targetItemId: string
  targetFrameBefore: number
  targetFrameAfter: number
  deltaFrames: number
  confidence: number
  outcome: 'ready' | 'uncertain'
  refusalReason?: string
  analysisId: string
}

export type MediaIntelligenceProgressProjection = {
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

export type GenerationRecordProjection = {
  schemaVersion: 1
  id: string
  generation: number
  projectId: string
  projectRevision: number
  providerId: string
  modelId: string
  task: GenerationTask
  promptDigest: string
  referenceAssetIds: string[]
  variantsRequested: number
  quote: {
    quoteId: string
    currency: string
    minimumMinor: number
    maximumMinor: number
    estimateOnly: boolean
  }
  placeholder: {
    assetId: string
    displayName: string
    kind: GenerationOutputKind
    state: 'pending' | 'resolved' | 'failed' | 'cancelled' | 'interrupted'
  }
  state: 'placeholder' | 'queued' | 'running' | 'cancelling' | 'ready' | 'failed' | 'cancelled' | 'interrupted'
  attempt: number
  progress?: { completed: number; total: number; unit: string; message?: string }
  outputs: Array<{
    id: string
    assetId: string
    displayName: string
    kind: GenerationOutputKind
    mimeType: string
    byteSize?: number
    width?: number
    height?: number
    durationUs?: number
    sampleRate?: number
    channels?: number
    primary: boolean
    createdAt: string
  }>
  error?: { code: string; message: string; retryable: boolean }
  createdAt: string
  updatedAt: string
}

export type GenerationStateProjection = {
  catalog: GenerationCatalog
  outcome: 'available' | 'unavailable'
  unavailableMessage?: string
  records: GenerationRecordProjection[]
  recoveryDiagnostics: string[]
}
