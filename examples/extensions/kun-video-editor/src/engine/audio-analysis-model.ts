import { engineError } from './errors.js'
import type {
  Caption,
  SpeakerAttributionEvidence,
  SourceIdentity,
  TimelineOperation,
  TranscriptSegment,
  VideoProject
} from './schema.js'
import { applyTimelineOperations } from './timeline.js'
import { microsecondsToFrames } from './time.js'
import { containsAsciiControlCharacters } from '../text-safety.js'
import { negotiateSpeakerAdapter } from './audio-analysis-vad-speakers.js'
import {
  boundedSpeakerLabel,
  deepFreeze,
  identifier,
  validIsoTimestamp,
  validateSpeakerDiarizationAdapterStatus
} from './audio-analysis-support.js'

export type LocalAnalysisProvenance = {
  adapterId: string
  adapterVersion: string
  modelId?: string
  modelVersion?: string
  algorithm: string
  algorithmVersion: string
  sourceFingerprint: SourceIdentity
  local: true
  networkUsed: false
  createdAt: string
  cacheKey: string
  execution: 'local' | 'import'
}

export type VadFrameEvidence = {
  id: string
  startUs: number
  endUs: number
  speechProbability: number
}

export type SilenceSuggestion = {
  id: string
  assetId: string
  sourceRange: { assetId: string; startUs: number; endUs: number }
  confidence: number
  disposition: 'safe-to-suggest' | 'review-required'
  reason: 'vad-silence'
}

export type VadAnalysisRecord = {
  schemaVersion: 1
  id: string
  kind: 'vad'
  assetId: string
  provenance: LocalAnalysisProvenance
  speechThreshold: number
  suggestionConfidenceThreshold: number
  frames: VadFrameEvidence[]
  silence: SilenceSuggestion[]
  completeness: 'complete' | 'partial'
  immutable: true
}

export type SpeakerModelDescriptor = {
  adapterId: string
  adapterVersion: string
  modelId: string
  modelVersion: string
  embeddingDimensions: number
}

export type SpeakerAdapterCapability =
  | {
      outcome: 'ready'
      adapter: SpeakerModelDescriptor & { execution: 'local' }
      networkUsedForInference: false
    }
  | {
      outcome: 'unavailable'
      code: 'speaker_model_disabled' | 'speaker_model_unverified' | 'speaker_inference_broker_unavailable'
      retryable: boolean
      remediation: string
      networkUsedForInference: false
    }

export type SpeakerRegistryEntry = {
  id: string
  label: string
  embedding: number[]
  adapterId: string
  modelId: string
  sourceEvidenceIds: string[]
  createdAt: string
}

export type SpeakerIdentity = {
  id: string
  label: string
  aliases: string[]
  sourceEvidenceIds: string[]
  createdAt: string
  updatedAt: string
}

export type SpeakerDiarizationAdapterDescriptor = {
  id: string
  version: string
  execution: 'local-model' | 'import'
  format?: 'kun-speaker-json-v1'
  modelId?: string
  modelVersion?: string
}

export type SpeakerDiarizationAdapterStatus =
  | {
      descriptor: SpeakerDiarizationAdapterDescriptor
      outcome: 'ready'
      local: true
      networkUsed: false
    }
  | {
      descriptor: SpeakerDiarizationAdapterDescriptor
      outcome: 'unavailable'
      code: 'speaker_inference_broker_unavailable' | 'speaker_model_unverified'
      remediation: string
      local: true
      networkUsed: false
    }

export type ImportedDiarizationTurn = {
  id: string
  startUs: number
  endUs: number
  status: 'identified' | 'unknown' | 'overlap'
  speakerId?: string
  overlapSpeakerIds?: string[]
  confidence: number
  sourceEvidenceIds?: string[]
}

export class SpeakerIdentityRegistry {
  private readonly entries = new Map<string, SpeakerIdentity>()

  constructor(entries: readonly SpeakerIdentity[] = []) {
    for (const entry of entries) this.upsert(entry)
  }

  upsert(entry: SpeakerIdentity): SpeakerIdentity {
    identifier(entry.id, 'speaker identity ID')
    const label = boundedSpeakerLabel(entry.label, 'speaker identity label')
    const aliases = [...new Set(entry.aliases.map((alias) => boundedSpeakerLabel(alias, 'speaker alias')))]
      .filter((alias) => alias !== label)
      .slice(0, 32)
    const sourceEvidenceIds = [...new Set(entry.sourceEvidenceIds.map((id) => {
      identifier(id, 'speaker source evidence ID')
      return id
    }))].slice(0, 256)
    const existing = this.entries.get(entry.id)
    const normalized: SpeakerIdentity = deepFreeze({
      id: entry.id,
      label,
      aliases,
      sourceEvidenceIds,
      createdAt: existing?.createdAt ?? validIsoTimestamp(entry.createdAt, 'speaker createdAt'),
      updatedAt: validIsoTimestamp(entry.updatedAt, 'speaker updatedAt')
    })
    this.entries.set(entry.id, normalized)
    return structuredClone(normalized)
  }

  get(id: string): SpeakerIdentity | undefined {
    const entry = this.entries.get(id)
    return entry ? structuredClone(entry) : undefined
  }

  list(): SpeakerIdentity[] {
    return [...this.entries.values()]
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .map((entry) => structuredClone(entry))
  }
}

export class SpeakerDiarizationAdapterRegistry {
  private readonly entries = new Map<string, SpeakerDiarizationAdapterStatus>()

  constructor(entries: readonly SpeakerDiarizationAdapterStatus[] = []) {
    for (const entry of entries) this.register(entry)
  }

  register(entry: SpeakerDiarizationAdapterStatus): void {
    validateSpeakerDiarizationAdapterStatus(entry)
    if (this.entries.has(entry.descriptor.id)) {
      throw engineError('invalid_operation', `Speaker adapter already exists: ${entry.descriptor.id}`)
    }
    this.entries.set(entry.descriptor.id, deepFreeze(structuredClone(entry)))
  }

  list(): SpeakerDiarizationAdapterStatus[] {
    return [...this.entries.values()]
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))
      .map((entry) => structuredClone(entry))
  }

  requireReady(id: string): Extract<SpeakerDiarizationAdapterStatus, { outcome: 'ready' }> {
    const entry = this.entries.get(id)
    if (!entry) throw engineError('invalid_operation', `Speaker adapter is not registered: ${id}`)
    if (entry.outcome !== 'ready') {
      throw engineError('invalid_operation', entry.remediation ?? `Speaker adapter is unavailable: ${id}`)
    }
    return structuredClone(entry) as Extract<SpeakerDiarizationAdapterStatus, { outcome: 'ready' }>
  }
}

export function defaultSpeakerDiarizationAdapterRegistry(input: {
  localDescriptor?: SpeakerModelDescriptor
  localInstallationVerified?: boolean
  localInferenceBrokerAvailable?: boolean
} = {}): SpeakerDiarizationAdapterRegistry {
  const entries: SpeakerDiarizationAdapterStatus[] = [{
    descriptor: {
      id: 'kun.imported-speaker-labels',
      version: '1.0.0',
      execution: 'import',
      format: 'kun-speaker-json-v1'
    },
    outcome: 'ready',
    local: true,
    networkUsed: false
  }]
  if (input.localDescriptor) {
    const capability = negotiateSpeakerAdapter({
      optIn: true,
      descriptor: input.localDescriptor,
      installationVerified: input.localInstallationVerified === true,
      inferenceBrokerAvailable: input.localInferenceBrokerAvailable === true
    })
    entries.push(capability.outcome === 'ready'
      ? {
          descriptor: {
            id: capability.adapter.adapterId,
            version: capability.adapter.adapterVersion,
            execution: 'local-model',
            modelId: capability.adapter.modelId,
            modelVersion: capability.adapter.modelVersion
          },
          outcome: 'ready', local: true, networkUsed: false
        }
      : {
          descriptor: {
            id: input.localDescriptor.adapterId,
            version: input.localDescriptor.adapterVersion,
            execution: 'local-model',
            modelId: input.localDescriptor.modelId,
            modelVersion: input.localDescriptor.modelVersion
          },
          outcome: 'unavailable',
          code: capability.code === 'speaker_model_disabled'
            ? 'speaker_model_unverified'
            : capability.code,
          remediation: capability.remediation,
          local: true,
          networkUsed: false
        })
  }
  return new SpeakerDiarizationAdapterRegistry(entries)
}

export type SpeakerMatch = {
  speakerId?: string
  label?: string
  confidence: number
  runnerUpConfidence?: number
  uncertain: boolean
  reason?: 'below-threshold' | 'ambiguous' | 'empty-registry' | 'unknown-speaker' | 'overlap' | 'import-low-confidence'
}

export type DiarizationTurnEvidence = {
  id: string
  startUs: number
  endUs: number
  embedding: number[]
  adapterConfidence: number
}

export type DiarizationTurn = {
  id: string
  startUs: number
  endUs: number
  speakerId?: string
  speakerLabel?: string
  confidence: number
  uncertain: boolean
  status?: SpeakerAttributionEvidence['status']
  overlapSpeakerIds?: string[]
  sourceEvidenceIds?: string[]
  reason?: SpeakerMatch['reason']
}

export type DiarizationRecord = {
  schemaVersion: 1
  id: string
  kind: 'speaker-diarization'
  assetId: string
  provenance: LocalAnalysisProvenance
  turns: DiarizationTurn[]
  uncertainTurnCount: number
  completeness: 'complete' | 'partial'
  immutable: true
}

export type SpeakerAttribution = {
  analysisId: string
  speakerId?: string
  speakerLabel?: string
  confidence: number
  uncertain: boolean
  status: SpeakerAttributionEvidence['status']
  sourceTurnIds: string[]
}

export type SpeakerAttributionPlan = {
  schemaVersion: 1
  projectId: string
  expectedRevision: number
  analysisId: string
  transcriptSegments: Array<SpeakerAttribution & { transcriptId: string; segmentId: string }>
  captions: Array<SpeakerAttribution & { captionId: string }>
  warnings: string[]
}

export type BeatObservation = {
  id: string
  timeUs: number
  strength: number
  beatProbability: number
  downbeatProbability?: number
}

export type BeatMarker = {
  id: string
  assetId: string
  sourceUs: number
  kind: 'beat' | 'downbeat'
  confidence: number
  strength: number
}

export type BeatAnalysisRecord = {
  schemaVersion: 1
  id: string
  kind: 'beat-grid'
  assetId: string
  provenance: LocalAnalysisProvenance
  tempoBpm?: number
  markers: BeatMarker[]
  completeness: 'complete' | 'partial'
  immutable: true
}

export type BeatSnapTarget = {
  id: string
  itemId: string
  assetId: string
  frame: number
  kind: 'beat' | 'downbeat'
  confidence: number
  sourceUs: number
}

export type AudioSyncAnalysis = {
  schemaVersion: 1
  id: string
  kind: 'audio-sync'
  referenceAssetId: string
  targetAssetId: string
  seed: number
  samplePeriodUs: number
  candidateCount: number
  proposedTargetDeltaUs: number
  bestCorrelation: number
  runnerUpCorrelation: number
  confidence: number
  separation: number
  threshold: number
  minimumSeparation: number
  outcome: 'ready' | 'uncertain'
  refusalReason?: 'confidence-below-threshold' | 'ambiguous-correlation'
  provenance: LocalAnalysisProvenance
  immutable: true
}

export type AudioSyncPreview = {
  referenceItemId: string
  targetItemId: string
  targetFrameBefore: number
  targetFrameAfter: number
  deltaFrames: number
  confidence: number
  outcome: AudioSyncAnalysis['outcome']
  refusalReason?: AudioSyncAnalysis['refusalReason']
}

export type AudioSyncPlan = AudioSyncPreview & {
  schemaVersion: 1
  projectId: string
  expectedRevision: number
  analysisId: string
  operation?: TimelineOperation
}
