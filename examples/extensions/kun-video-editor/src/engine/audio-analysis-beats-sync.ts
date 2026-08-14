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
import type {
  AudioSyncAnalysis,
  AudioSyncPlan,
  AudioSyncPreview,
  BeatAnalysisRecord,
  BeatMarker,
  BeatObservation,
  BeatSnapTarget,
  LocalAnalysisProvenance
} from './audio-analysis-model.js'
import {
  assertFingerprint,
  boundedInteger,
  boundedString,
  confidence,
  correlationAtLag,
  deepFreeze,
  identifier,
  provenance,
  seededCandidates,
  stableDigest64,
  stableKey,
  validateFeatureSeries
} from './audio-analysis-support.js'

export function analyzeBeatEvidence(input: {
  assetId: string
  sourceFingerprint: SourceIdentity
  observations: readonly BeatObservation[]
  beatThreshold?: number
  downbeatThreshold?: number
  tempoBpm?: number
  completeness?: 'complete' | 'partial'
  adapterId?: string
  adapterVersion?: string
  modelId?: string
  now?: () => Date
}): BeatAnalysisRecord {
  identifier(input.assetId, 'assetId')
  assertFingerprint(input.sourceFingerprint)
  const beatThreshold = confidence(input.beatThreshold ?? 0.65, 'beatThreshold')
  const downbeatThreshold = confidence(input.downbeatThreshold ?? 0.75, 'downbeatThreshold')
  const seen = new Set<string>()
  let previousUs = -1
  const markers: BeatMarker[] = []
  for (const observation of input.observations) {
    identifier(observation.id, 'beat observation ID')
    if (seen.has(observation.id)) throw engineError('invalid_operation', 'Beat observation IDs must be unique')
    seen.add(observation.id)
    boundedInteger(observation.timeUs, 0, Number.MAX_SAFE_INTEGER, `time for ${observation.id}`)
    if (observation.timeUs < previousUs) throw engineError('invalid_operation', 'Beat observations must be ordered')
    previousUs = observation.timeUs
    confidence(observation.strength, `strength for ${observation.id}`)
    confidence(observation.beatProbability, `beat probability for ${observation.id}`)
    if (observation.downbeatProbability !== undefined) confidence(observation.downbeatProbability, `downbeat probability for ${observation.id}`)
    const isDownbeat = (observation.downbeatProbability ?? 0) >= downbeatThreshold
    if (!isDownbeat && observation.beatProbability < beatThreshold) continue
    markers.push({
      id: `marker:${observation.id}`,
      assetId: input.assetId,
      sourceUs: observation.timeUs,
      kind: isDownbeat ? 'downbeat' : 'beat',
      confidence: Number((isDownbeat ? observation.downbeatProbability! : observation.beatProbability).toFixed(6)),
      strength: observation.strength
    })
  }
  if (input.tempoBpm !== undefined && (!Number.isFinite(input.tempoBpm) || input.tempoBpm < 20 || input.tempoBpm > 400)) {
    throw engineError('invalid_operation', 'Tempo must be from 20 through 400 BPM')
  }
  const recordProvenance = provenance({
    assetId: input.assetId,
    sourceFingerprint: input.sourceFingerprint,
    adapterId: input.adapterId ?? 'kun.local.beat-evidence',
    adapterVersion: input.adapterVersion ?? '1.0.0',
    modelId: input.modelId,
    algorithm: 'thresholded-beat-marker',
    algorithmVersion: '1.0.0',
    parameters: [beatThreshold, downbeatThreshold, input.tempoBpm ?? 'unknown'],
    now: input.now
  })
  return deepFreeze({
    schemaVersion: 1,
    id: `analysis:beats:${recordProvenance.cacheKey}`,
    kind: 'beat-grid',
    assetId: input.assetId,
    provenance: recordProvenance,
    ...(input.tempoBpm === undefined ? {} : { tempoBpm: input.tempoBpm }),
    markers,
    completeness: input.completeness ?? 'complete',
    immutable: true
  })
}

export function beatSnapTargets(project: VideoProject, record: BeatAnalysisRecord): BeatSnapTarget[] {
  const targets: BeatSnapTarget[] = []
  for (const item of project.items.filter(({ assetId }) => assetId === record.assetId)) {
    for (const marker of record.markers) {
      if (marker.sourceUs < item.sourceStartUs || marker.sourceUs >= item.sourceEndUs) continue
      const sourceDelta = marker.sourceUs - item.sourceStartUs
      const timelineUs = Math.round(sourceDelta * item.speed.denominator / item.speed.numerator)
      targets.push({
        id: `snap:${item.id}:${marker.id}`,
        itemId: item.id,
        assetId: record.assetId,
        frame: item.timelineStartFrame + microsecondsToFrames(timelineUs, project.fps),
        kind: marker.kind,
        confidence: marker.confidence,
        sourceUs: marker.sourceUs
      })
    }
  }
  return targets.sort((left, right) => left.frame - right.frame || left.id.localeCompare(right.id)).slice(0, 10_000)
}

export function beatEvidenceWindow(
  record: BeatAnalysisRecord,
  offset = 0,
  limit = 100
): {
  analysisId: string
  assetId: string
  markers: BeatMarker[]
  nextOffset?: number
  total: number
  completeness: BeatAnalysisRecord['completeness']
  provenance: LocalAnalysisProvenance
} {
  offset = boundedInteger(offset, 0, 1_000_000, 'offset')
  limit = boundedInteger(limit, 1, 500, 'limit')
  const markers = record.markers.slice(offset, offset + limit)
  const nextOffset = offset + markers.length
  return {
    analysisId: record.id,
    assetId: record.assetId,
    markers,
    ...(nextOffset < record.markers.length ? { nextOffset } : {}),
    total: record.markers.length,
    completeness: record.completeness,
    provenance: structuredClone(record.provenance)
  }
}

export function analyzeAudioSynchronization(input: {
  referenceAssetId: string
  targetAssetId: string
  referenceFeatures: readonly number[]
  targetFeatures: readonly number[]
  samplePeriodUs: number
  maximumOffsetUs: number
  seed: number
  threshold?: number
  minimumSeparation?: number
  referenceFingerprint: SourceIdentity
  targetFingerprint: SourceIdentity
  adapterId?: string
  adapterVersion?: string
  now?: () => Date
}): AudioSyncAnalysis {
  identifier(input.referenceAssetId, 'referenceAssetId')
  identifier(input.targetAssetId, 'targetAssetId')
  if (input.referenceAssetId === input.targetAssetId) throw engineError('invalid_operation', 'Audio sync requires two different assets')
  assertFingerprint(input.referenceFingerprint)
  assertFingerprint(input.targetFingerprint)
  const samplePeriodUs = boundedInteger(input.samplePeriodUs, 1, 10_000_000, 'samplePeriodUs')
  const maximumOffsetUs = boundedInteger(input.maximumOffsetUs, 0, 3_600_000_000, 'maximumOffsetUs')
  const seed = boundedInteger(input.seed, 0, 0x7fffffff, 'seed')
  const threshold = confidence(input.threshold ?? 0.82, 'sync threshold')
  const minimumSeparation = confidence(input.minimumSeparation ?? 0.03, 'sync minimum separation')
  validateFeatureSeries(input.referenceFeatures, 'referenceFeatures')
  validateFeatureSeries(input.targetFeatures, 'targetFeatures')
  const maxLag = Math.floor(maximumOffsetUs / samplePeriodUs)
  const candidates = seededCandidates(maxLag, seed)
  const ranked = candidates.flatMap((lag, rank) => {
    const correlation = correlationAtLag(input.referenceFeatures, input.targetFeatures, lag)
    return correlation === undefined ? [] : [{ lag, correlation, rank }]
  }).sort((left, right) =>
    right.correlation - left.correlation || left.rank - right.rank || Math.abs(left.lag) - Math.abs(right.lag)
  )
  const best = ranked[0]
  if (!best) throw engineError('invalid_operation', 'Audio feature evidence has insufficient overlap for synchronization')
  const runnerUp = ranked.find(({ lag }) => Math.abs(lag - best.lag) > 1) ?? ranked[1]
  const bestCorrelation = Number(best.correlation.toFixed(8))
  const runnerUpCorrelation = Number((runnerUp?.correlation ?? -1).toFixed(8))
  const syncConfidence = Number(Math.max(0, Math.min(1, (best.correlation + 1) / 2)).toFixed(8))
  const separation = Number(Math.max(0, best.correlation - (runnerUp?.correlation ?? -1)).toFixed(8))
  const refusalReason = syncConfidence < threshold
    ? 'confidence-below-threshold' as const
    : separation < minimumSeparation
      ? 'ambiguous-correlation' as const
      : undefined
  const combinedFingerprint = combineAudioSourceFingerprints(
    input.referenceFingerprint,
    input.targetFingerprint
  )
  const analysisProvenance = provenance({
    assetId: `${input.referenceAssetId}:${input.targetAssetId}`,
    sourceFingerprint: combinedFingerprint,
    adapterId: input.adapterId ?? 'kun.local.audio-feature-correlation',
    adapterVersion: input.adapterVersion ?? '1.0.0',
    algorithm: 'seeded-normalized-cross-correlation',
    algorithmVersion: '1.0.0',
    parameters: [samplePeriodUs, maximumOffsetUs, seed, threshold, minimumSeparation],
    now: input.now
  })
  return deepFreeze({
    schemaVersion: 1,
    id: audioSyncAnalysisId({
      referenceAssetId: input.referenceAssetId,
      targetAssetId: input.targetAssetId,
      referenceFingerprint: input.referenceFingerprint,
      targetFingerprint: input.targetFingerprint,
      samplePeriodUs,
      maximumOffsetUs,
      seed,
      threshold,
      minimumSeparation,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion
    }),
    kind: 'audio-sync',
    referenceAssetId: input.referenceAssetId,
    targetAssetId: input.targetAssetId,
    seed,
    samplePeriodUs,
    candidateCount: ranked.length,
    proposedTargetDeltaUs: -best.lag * samplePeriodUs,
    bestCorrelation,
    runnerUpCorrelation,
    confidence: syncConfidence,
    separation,
    threshold,
    minimumSeparation,
    outcome: refusalReason ? 'uncertain' : 'ready',
    ...(refusalReason ? { refusalReason } : {}),
    provenance: analysisProvenance,
    immutable: true
  })
}

export function audioSyncAnalysisId(input: {
  referenceAssetId: string
  targetAssetId: string
  referenceFingerprint: SourceIdentity
  targetFingerprint: SourceIdentity
  samplePeriodUs: number
  maximumOffsetUs: number
  seed: number
  threshold?: number
  minimumSeparation?: number
  adapterId?: string
  adapterVersion?: string
}): string {
  identifier(input.referenceAssetId, 'referenceAssetId')
  identifier(input.targetAssetId, 'targetAssetId')
  const combinedFingerprint = combineAudioSourceFingerprints(
    input.referenceFingerprint,
    input.targetFingerprint
  )
  const adapterId = input.adapterId ?? 'kun.local.audio-feature-correlation'
  const adapterVersion = input.adapterVersion ?? '1.0.0'
  identifier(adapterId, 'adapterId')
  boundedString(adapterVersion, 'adapterVersion', 1, 64)
  const samplePeriodUs = boundedInteger(input.samplePeriodUs, 1, 10_000_000, 'samplePeriodUs')
  const maximumOffsetUs = boundedInteger(input.maximumOffsetUs, 0, 3_600_000_000, 'maximumOffsetUs')
  const seed = boundedInteger(input.seed, 0, 0x7fffffff, 'seed')
  const threshold = confidence(input.threshold ?? 0.82, 'sync threshold')
  const minimumSeparation = confidence(input.minimumSeparation ?? 0.03, 'sync minimum separation')
  return `analysis:sync:${stableKey([
    `${input.referenceAssetId}:${input.targetAssetId}`,
    combinedFingerprint.value,
    adapterId,
    adapterVersion,
    '',
    'seeded-normalized-cross-correlation',
    '1.0.0',
    samplePeriodUs,
    maximumOffsetUs,
    seed,
    threshold,
    minimumSeparation
  ])}`
}

export function combineAudioSourceFingerprints(
  reference: SourceIdentity,
  target: SourceIdentity
): SourceIdentity {
  assertFingerprint(reference)
  assertFingerprint(target)
  return {
    algorithm: 'sha256',
    value: stableDigest64([reference.value, target.value])
  }
}

export function previewAudioSynchronization(
  project: VideoProject,
  referenceItemId: string,
  targetItemId: string,
  analysis: AudioSyncAnalysis
): AudioSyncPreview {
  const reference = project.items.find(({ id }) => id === referenceItemId)
  const target = project.items.find(({ id }) => id === targetItemId)
  if (!reference || !target) throw engineError('invalid_operation', 'Audio synchronization items are unavailable')
  if (reference.assetId !== analysis.referenceAssetId || target.assetId !== analysis.targetAssetId) {
    throw engineError('invalid_operation', 'Audio synchronization evidence does not match the selected items')
  }
  const deltaFrames = Math.sign(analysis.proposedTargetDeltaUs) * microsecondsToFrames(
    Math.abs(analysis.proposedTargetDeltaUs),
    project.fps
  )
  const targetFrameAfter = target.timelineStartFrame + deltaFrames
  return {
    referenceItemId,
    targetItemId,
    targetFrameBefore: target.timelineStartFrame,
    targetFrameAfter,
    deltaFrames,
    confidence: analysis.confidence,
    outcome: targetFrameAfter < 0 ? 'uncertain' : analysis.outcome,
    ...(targetFrameAfter < 0
      ? { refusalReason: 'confidence-below-threshold' }
      : analysis.refusalReason ? { refusalReason: analysis.refusalReason } : {})
  }
}

export function planAudioSynchronization(
  project: VideoProject,
  referenceItemId: string,
  targetItemId: string,
  analysis: AudioSyncAnalysis
): AudioSyncPlan {
  const preview = previewAudioSynchronization(project, referenceItemId, targetItemId, analysis)
  return {
    schemaVersion: 1,
    projectId: project.id,
    expectedRevision: project.currentRevision,
    analysisId: analysis.id,
    ...preview,
    ...(preview.outcome === 'ready'
      ? {
          operation: {
            type: 'move-item',
            itemId: targetItemId,
            trackId: project.items.find(({ id }) => id === targetItemId)!.trackId,
            timelineStartFrame: preview.targetFrameAfter
          }
        }
      : {})
  }
}

export function applyAudioSynchronizationPlan(
  project: VideoProject,
  plan: AudioSyncPlan
): ReturnType<typeof applyTimelineOperations> {
  if (plan.projectId !== project.id || plan.expectedRevision !== project.currentRevision) {
    throw engineError('revision_conflict', 'Audio synchronization plan is stale; refresh evidence before applying')
  }
  if (plan.outcome !== 'ready' || !plan.operation) {
    throw engineError('invalid_operation', 'Audio synchronization is uncertain and cannot move clips automatically')
  }
  return applyTimelineOperations(project, [plan.operation])
}
