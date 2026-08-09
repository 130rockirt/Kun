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
import {
  SpeakerIdentityRegistry,
  type DiarizationRecord,
  type DiarizationTurn,
  type DiarizationTurnEvidence,
  type ImportedDiarizationTurn,
  type SilenceSuggestion,
  type SpeakerAdapterCapability,
  type SpeakerAttribution,
  type SpeakerAttributionPlan,
  type SpeakerDiarizationAdapterStatus,
  type SpeakerMatch,
  type SpeakerModelDescriptor,
  type SpeakerRegistryEntry,
  type VadAnalysisRecord,
  type VadFrameEvidence
} from './audio-analysis-model.js'
import {
  assertFingerprint,
  attributionForRange,
  boundedInteger,
  confidence,
  deepFreeze,
  dot,
  identifier,
  mergeAttributions,
  normalizedVector,
  persistedSpeakerAttribution,
  provenance,
  speakerUnavailable,
  stableDigest64,
  stableKey,
  validateSpeakerDescriptor,
  validateTimedEvidence
} from './audio-analysis-support.js'

export function analyzeVadEvidence(input: {
  assetId: string
  sourceFingerprint: SourceIdentity
  frames: readonly VadFrameEvidence[]
  speechThreshold?: number
  minimumSilenceUs?: number
  suggestionConfidenceThreshold?: number
  completeness?: 'complete' | 'partial'
  adapterId?: string
  adapterVersion?: string
  now?: () => Date
}): VadAnalysisRecord {
  identifier(input.assetId, 'assetId')
  assertFingerprint(input.sourceFingerprint)
  const speechThreshold = confidence(input.speechThreshold ?? 0.5, 'speechThreshold')
  const suggestionThreshold = confidence(
    input.suggestionConfidenceThreshold ?? 0.82,
    'suggestionConfidenceThreshold'
  )
  const minimumSilenceUs = boundedInteger(input.minimumSilenceUs ?? 300_000, 1, 60_000_000, 'minimumSilenceUs')
  const frames = input.frames.map((frame) => ({ ...frame }))
  validateTimedEvidence(frames, 'VAD frame')
  frames.forEach((frame) => confidence(frame.speechProbability, `speech probability for ${frame.id}`))
  const silence: SilenceSuggestion[] = []
  let run: VadFrameEvidence[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const startUs = run[0]!.startUs
    const endUs = run.at(-1)!.endUs
    if (endUs - startUs >= minimumSilenceUs) {
      const average = run.reduce((total, frame) => total + (1 - frame.speechProbability), 0) / run.length
      const rounded = Number(average.toFixed(6))
      silence.push({
        id: `silence:${input.assetId}:${startUs}:${endUs}`,
        assetId: input.assetId,
        sourceRange: { assetId: input.assetId, startUs, endUs },
        confidence: rounded,
        disposition: rounded >= suggestionThreshold ? 'safe-to-suggest' : 'review-required',
        reason: 'vad-silence'
      })
    }
    run = []
  }
  for (const frame of frames) {
    if (frame.speechProbability < speechThreshold) run.push(frame)
    else flush()
  }
  flush()
  const vadProvenance = provenance({
    assetId: input.assetId,
    sourceFingerprint: input.sourceFingerprint,
    adapterId: input.adapterId ?? 'kun.local.vad-evidence',
    adapterVersion: input.adapterVersion ?? '1.0.0',
    algorithm: 'threshold-merge-vad',
    algorithmVersion: '1.0.0',
    parameters: [speechThreshold, minimumSilenceUs, suggestionThreshold],
    now: input.now
  })
  return deepFreeze({
    schemaVersion: 1,
    id: `analysis:vad:${vadProvenance.cacheKey}`,
    kind: 'vad',
    assetId: input.assetId,
    provenance: vadProvenance,
    speechThreshold,
    suggestionConfidenceThreshold: suggestionThreshold,
    frames,
    silence,
    completeness: input.completeness ?? 'complete',
    immutable: true
  })
}

export function negotiateSpeakerAdapter(input: {
  optIn: boolean
  descriptor: SpeakerModelDescriptor
  installationVerified: boolean
  inferenceBrokerAvailable: boolean
}): SpeakerAdapterCapability {
  validateSpeakerDescriptor(input.descriptor)
  if (!input.optIn) {
    return speakerUnavailable('speaker_model_disabled', true, 'Enable local speaker analysis for this workspace first.')
  }
  if (!input.installationVerified) {
    return speakerUnavailable(
      'speaker_model_unverified',
      true,
      'Install and verify the speaker model through an approved Host model broker.'
    )
  }
  if (!input.inferenceBrokerAvailable) {
    return speakerUnavailable(
      'speaker_inference_broker_unavailable',
      false,
      'The speaker model is verified, but this Extension API has no approved local inference broker.'
    )
  }
  return {
    outcome: 'ready',
    adapter: { ...input.descriptor, execution: 'local' },
    networkUsedForInference: false
  }
}

export class SpeakerRegistry {
  private readonly entries = new Map<string, SpeakerRegistryEntry>()

  constructor(entries: readonly SpeakerRegistryEntry[] = []) {
    for (const entry of entries) this.register(entry)
  }

  register(entry: SpeakerRegistryEntry): SpeakerRegistryEntry {
    identifier(entry.id, 'speaker ID')
    if (!entry.label.trim() || entry.label.length > 128) throw engineError('invalid_operation', 'Speaker label is invalid')
    if (this.entries.has(entry.id)) throw engineError('invalid_operation', `Speaker already exists: ${entry.id}`)
    const normalized: SpeakerRegistryEntry = {
      ...entry,
      label: entry.label.trim(),
      embedding: normalizedVector(entry.embedding, 'speaker embedding'),
      sourceEvidenceIds: [...new Set(entry.sourceEvidenceIds)].slice(0, 256)
    }
    this.entries.set(entry.id, deepFreeze(normalized))
    return structuredClone(normalized)
  }

  list(): SpeakerRegistryEntry[] {
    return [...this.entries.values()]
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .map((entry) => structuredClone(entry))
  }

  match(embedding: readonly number[], options: { threshold?: number; minimumMargin?: number } = {}): SpeakerMatch {
    const query = normalizedVector(embedding, 'speaker query')
    const threshold = confidence(options.threshold ?? 0.78, 'speaker threshold')
    const minimumMargin = confidence(options.minimumMargin ?? 0.05, 'speaker minimum margin')
    const ranked = [...this.entries.values()].map((entry) => {
      if (entry.embedding.length !== query.length) {
        throw engineError('invalid_operation', 'Speaker registry and query dimensions differ')
      }
      return { entry, score: dot(query, entry.embedding) }
    }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
    const best = ranked[0]
    if (!best) return { confidence: 0, uncertain: true, reason: 'empty-registry' }
    const runnerUp = ranked[1]?.score
    const rounded = Number(best.score.toFixed(6))
    if (best.score < threshold) {
      return { confidence: rounded, ...(runnerUp === undefined ? {} : { runnerUpConfidence: runnerUp }), uncertain: true, reason: 'below-threshold' }
    }
    if (runnerUp !== undefined && best.score - runnerUp < minimumMargin) {
      return { confidence: rounded, runnerUpConfidence: Number(runnerUp.toFixed(6)), uncertain: true, reason: 'ambiguous' }
    }
    return {
      speakerId: best.entry.id,
      label: best.entry.label,
      confidence: rounded,
      ...(runnerUp === undefined ? {} : { runnerUpConfidence: Number(runnerUp.toFixed(6)) }),
      uncertain: false
    }
  }
}

export function diarizeSpeakerEvidence(input: {
  assetId: string
  sourceFingerprint: SourceIdentity
  capability: Extract<SpeakerAdapterCapability, { outcome: 'ready' }>
  registry: SpeakerRegistry
  turns: readonly DiarizationTurnEvidence[]
  threshold?: number
  minimumMargin?: number
  completeness?: 'complete' | 'partial'
  now?: () => Date
}): DiarizationRecord {
  identifier(input.assetId, 'assetId')
  assertFingerprint(input.sourceFingerprint)
  validateTimedEvidence(input.turns, 'diarization turn')
  const turns = input.turns.map((turn): DiarizationTurn => {
    confidence(turn.adapterConfidence, `adapter confidence for ${turn.id}`)
    const match = input.registry.match(turn.embedding, {
      threshold: input.threshold,
      minimumMargin: input.minimumMargin
    })
    const combined = Number(Math.min(turn.adapterConfidence, match.confidence).toFixed(6))
    const uncertain = match.uncertain || combined < (input.threshold ?? 0.78)
    return {
      id: turn.id,
      startUs: turn.startUs,
      endUs: turn.endUs,
      ...(!uncertain && match.speakerId ? { speakerId: match.speakerId, speakerLabel: match.label } : {}),
      confidence: combined,
      uncertain,
      status: uncertain ? 'uncertain' : 'identified',
      ...(uncertain ? { reason: match.reason ?? 'below-threshold' } : {})
    }
  })
  const recordProvenance = provenance({
    assetId: input.assetId,
    sourceFingerprint: input.sourceFingerprint,
    adapterId: input.capability.adapter.adapterId,
    adapterVersion: input.capability.adapter.adapterVersion,
    modelId: `${input.capability.adapter.modelId}@${input.capability.adapter.modelVersion}`,
    algorithm: 'speaker-registry-cosine-match',
    algorithmVersion: '1.0.0',
    parameters: [input.threshold ?? 0.78, input.minimumMargin ?? 0.05],
    now: input.now
  })
  return deepFreeze({
    schemaVersion: 1,
    id: `analysis:speaker:${recordProvenance.cacheKey}`,
    kind: 'speaker-diarization',
    assetId: input.assetId,
    provenance: recordProvenance,
    turns,
    uncertainTurnCount: turns.filter(({ uncertain }) => uncertain).length,
    completeness: input.completeness ?? 'complete',
    immutable: true
  })
}

/**
 * Normalizes explicitly imported, time-bounded speaker evidence. This adapter
 * performs no inference and accepts no path or media bytes. Speaker labels are
 * resolved only through the supplied identity registry, preventing a turn from
 * smuggling an unregistered identity into project attribution.
 */
export function importSpeakerDiarizationEvidence(input: {
  assetId: string
  sourceFingerprint: SourceIdentity
  adapter: Extract<SpeakerDiarizationAdapterStatus, { outcome: 'ready' }>
  identities: SpeakerIdentityRegistry
  turns: readonly ImportedDiarizationTurn[]
  confidenceThreshold?: number
  completeness?: 'complete' | 'partial'
  now?: () => Date
}): DiarizationRecord {
  identifier(input.assetId, 'assetId')
  assertFingerprint(input.sourceFingerprint)
  if (input.adapter.descriptor.execution !== 'import') {
    throw engineError('invalid_operation', 'Imported speaker evidence requires an import adapter')
  }
  const threshold = confidence(input.confidenceThreshold ?? 0.7, 'speaker import confidence threshold')
  validateTimedEvidence(input.turns, 'imported diarization turn')
  const turns = input.turns.map((turn): DiarizationTurn => {
    const score = confidence(turn.confidence, `speaker confidence for ${turn.id}`)
    const sourceEvidenceIds = [...new Set(turn.sourceEvidenceIds ?? [])].map((id) => {
      identifier(id, `speaker source evidence ID for ${turn.id}`)
      return id
    }).slice(0, 32)
    if (turn.status === 'identified') {
      if (!turn.speakerId || turn.overlapSpeakerIds !== undefined) {
        throw engineError('invalid_operation', `Identified speaker turn ${turn.id} requires exactly one speaker identity`)
      }
      const identity = input.identities.get(turn.speakerId)
      if (!identity) throw engineError('invalid_operation', `Speaker identity is not registered: ${turn.speakerId}`)
      const uncertain = score < threshold
      return {
        id: turn.id,
        startUs: turn.startUs,
        endUs: turn.endUs,
        ...(!uncertain ? { speakerId: identity.id, speakerLabel: identity.label } : {}),
        confidence: score,
        uncertain,
        status: uncertain ? 'uncertain' : 'identified',
        ...(sourceEvidenceIds.length > 0 ? { sourceEvidenceIds } : {}),
        ...(uncertain ? { reason: 'import-low-confidence' } : {})
      }
    }
    if (turn.speakerId !== undefined) {
      throw engineError('invalid_operation', `${turn.status} speaker turn ${turn.id} cannot assert one speaker identity`)
    }
    if (turn.status === 'overlap') {
      const overlapSpeakerIds = [...new Set(turn.overlapSpeakerIds ?? [])]
      if (overlapSpeakerIds.length < 2 || overlapSpeakerIds.length > 8) {
        throw engineError('invalid_operation', `Overlapping speaker turn ${turn.id} requires 2 through 8 registered identities`)
      }
      for (const id of overlapSpeakerIds) {
        identifier(id, `overlap speaker ID for ${turn.id}`)
        if (!input.identities.get(id)) throw engineError('invalid_operation', `Speaker identity is not registered: ${id}`)
      }
      return {
        id: turn.id,
        startUs: turn.startUs,
        endUs: turn.endUs,
        confidence: score,
        uncertain: true,
        status: 'overlap',
        overlapSpeakerIds,
        ...(sourceEvidenceIds.length > 0 ? { sourceEvidenceIds } : {}),
        reason: 'overlap'
      }
    }
    if ((turn.overlapSpeakerIds?.length ?? 0) > 0) {
      throw engineError('invalid_operation', `Unknown speaker turn ${turn.id} cannot assert overlapping identities`)
    }
    return {
      id: turn.id,
      startUs: turn.startUs,
      endUs: turn.endUs,
      confidence: score,
      uncertain: true,
      status: 'unknown',
      ...(sourceEvidenceIds.length > 0 ? { sourceEvidenceIds } : {}),
      reason: 'unknown-speaker'
    }
  })
  const evidenceDigest = stableDigest64([
    JSON.stringify(input.identities.list()),
    JSON.stringify(input.turns)
  ])
  const adapter = input.adapter.descriptor
  const cacheKey = stableKey([
    input.assetId,
    input.sourceFingerprint.value,
    adapter.id,
    adapter.version,
    evidenceDigest,
    threshold
  ])
  return deepFreeze({
    schemaVersion: 1,
    id: `analysis:speaker:${cacheKey}`,
    kind: 'speaker-diarization',
    assetId: input.assetId,
    provenance: {
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      algorithm: 'imported-speaker-turn-normalization',
      algorithmVersion: '1.0.0',
      sourceFingerprint: structuredClone(input.sourceFingerprint),
      local: true,
      networkUsed: false,
      execution: 'import',
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      cacheKey
    },
    turns,
    uncertainTurnCount: turns.filter(({ uncertain }) => uncertain).length,
    completeness: input.completeness ?? 'complete',
    immutable: true
  })
}

export function buildSpeakerAttributionPlan(
  project: VideoProject,
  record: DiarizationRecord
): SpeakerAttributionPlan {
  const transcripts = project.transcripts.filter(({ assetId }) => assetId === record.assetId)
  const transcriptSegments: SpeakerAttributionPlan['transcriptSegments'] = []
  type IndexedSegment = { attribution?: SpeakerAttribution }
  const byTranscriptSegment = new Map<string, IndexedSegment[]>()
  const byUnqualifiedSegment = new Map<string, IndexedSegment[]>()
  const warnings: string[] = []
  for (const transcript of transcripts) {
    for (const segment of transcript.segments) {
      const attribution = attributionForRange(segment, record)
      const indexed = attribution ? { attribution } : {}
      const scopedKey = `${transcript.id}\u0000${segment.id}`
      byTranscriptSegment.set(scopedKey, [...(byTranscriptSegment.get(scopedKey) ?? []), indexed])
      byUnqualifiedSegment.set(segment.id, [...(byUnqualifiedSegment.get(segment.id) ?? []), indexed])
      if (!attribution) continue
      const value = { transcriptId: transcript.id, segmentId: segment.id, ...attribution }
      transcriptSegments.push(value)
      if (attribution.uncertain) warnings.push(`Speaker attribution for segment ${segment.id} requires review.`)
    }
  }
  const captions = project.captions.flatMap((caption) => {
    const candidates = [...new Set(caption.sourceSegmentIds ?? [])].flatMap((id) => {
      if (caption.sourceTranscriptId) {
        const matches = byTranscriptSegment.get(`${caption.sourceTranscriptId}\u0000${id}`) ?? []
        if (matches.length > 1) {
          warnings.push(`Caption ${caption.id} references duplicate segment ${id} in transcript ${caption.sourceTranscriptId}.`)
          return []
        }
        const match = matches[0]?.attribution
        return match ? [match] : []
      }
      const matches = byUnqualifiedSegment.get(id) ?? []
      if (matches.length > 1) {
        warnings.push(`Caption ${caption.id} references ambiguous segment ${id}; sourceTranscriptId is required.`)
        return []
      }
      const match = matches[0]?.attribution
      return match ? [match] : []
    })
    const resolved = mergeAttributions(candidates, record.id)
    return resolved ? [{ captionId: caption.id, ...resolved }] : []
  })
  return {
    schemaVersion: 1,
    projectId: project.id,
    expectedRevision: project.currentRevision,
    analysisId: record.id,
    transcriptSegments,
    captions,
    warnings: warnings.slice(0, 100)
  }
}

export function applySpeakerAttributionPlan(
  project: VideoProject,
  plan: SpeakerAttributionPlan
): {
  project: VideoProject
  attributedTranscriptSegmentCount: number
  attributedCaptionCount: number
  identifiedCount: number
  uncertainCount: number
} {
  if (plan.projectId !== project.id || plan.expectedRevision !== project.currentRevision) {
    throw engineError('revision_conflict', 'Speaker attribution plan is stale; refresh diarization evidence before applying')
  }
  if ([...plan.transcriptSegments, ...plan.captions].some(({ analysisId }) => analysisId !== plan.analysisId)) {
    throw engineError('invalid_operation', 'Speaker attribution plan mixes unrelated evidence records')
  }
  const next = structuredClone(project)
  const segmentTargets = new Map(plan.transcriptSegments.map((entry) => [`${entry.transcriptId}\u0000${entry.segmentId}`, entry]))
  const captionTargets = new Map(plan.captions.map((entry) => [entry.captionId, entry]))
  let attributedTranscriptSegmentCount = 0
  let attributedCaptionCount = 0
  let identifiedCount = 0
  let uncertainCount = 0
  for (const transcript of next.transcripts) {
    for (const segment of transcript.segments) {
      const entry = segmentTargets.get(`${transcript.id}\u0000${segment.id}`)
      if (!entry) continue
      segment.speakerAttribution = persistedSpeakerAttribution(entry)
      attributedTranscriptSegmentCount += 1
      if (entry.status === 'identified') identifiedCount += 1
      else uncertainCount += 1
      segmentTargets.delete(`${transcript.id}\u0000${segment.id}`)
    }
  }
  const applyCaption = (caption: Caption): void => {
    const entry = captionTargets.get(caption.id)
    if (!entry) return
    caption.speakerAttribution = persistedSpeakerAttribution(entry)
    captionTargets.delete(caption.id)
    attributedCaptionCount += 1
    if (entry.status === 'identified') identifiedCount += 1
    else uncertainCount += 1
  }
  next.captions.forEach(applyCaption)
  for (const sequence of next.sequences) {
    for (const caption of sequence.captions) {
      const source = next.captions.find(({ id }) => id === caption.id)
      if (source?.speakerAttribution) caption.speakerAttribution = structuredClone(source.speakerAttribution)
    }
  }
  if (segmentTargets.size > 0 || captionTargets.size > 0) {
    throw engineError('revision_conflict', 'Speaker attribution targets changed; refresh the project before applying')
  }
  return { project: next, attributedTranscriptSegmentCount, attributedCaptionCount, identifiedCount, uncertainCount }
}
