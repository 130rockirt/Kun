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
  DiarizationRecord,
  LocalAnalysisProvenance,
  SpeakerAdapterCapability,
  SpeakerAttribution,
  SpeakerDiarizationAdapterStatus,
  SpeakerModelDescriptor
} from './audio-analysis-model.js'

export function attributionForRange(
  value: Pick<TranscriptSegment, 'id' | 'startUs' | 'endUs'>,
  record: DiarizationRecord
): SpeakerAttribution | undefined {
  const overlaps = record.turns.flatMap((turn) => {
    const overlap = Math.max(0, Math.min(value.endUs, turn.endUs) - Math.max(value.startUs, turn.startUs))
    return overlap > 0 ? [{ turn, overlap }] : []
  }).sort((left, right) => right.overlap - left.overlap || right.turn.confidence - left.turn.confidence)
  const best = overlaps[0]
  if (!best) return undefined
  const duration = value.endUs - value.startUs
  const confidenceValue = Number((best.turn.confidence * best.overlap / duration).toFixed(6))
  const materiallyOverlapping = overlaps.filter(({ overlap }) => overlap / duration >= 0.05)
  const identifiedSpeakerIds = new Set(materiallyOverlapping.flatMap(({ turn }) =>
    !turn.uncertain && turn.speakerId ? [turn.speakerId] : []
  ))
  const explicitOverlap = materiallyOverlapping.some(({ turn }) =>
    turn.status === 'overlap' || turn.reason === 'overlap' || (turn.overlapSpeakerIds?.length ?? 0) > 1
  )
  const containsUnknown = materiallyOverlapping.some(({ turn }) =>
    turn.status === 'unknown' || turn.reason === 'unknown-speaker'
  )
  const containsUncertain = materiallyOverlapping.some(({ turn }) => turn.uncertain)
  const bestHasIdentity = best.turn.speakerId !== undefined && best.turn.speakerLabel !== undefined
  const status: SpeakerAttributionEvidence['status'] = explicitOverlap || identifiedSpeakerIds.size > 1
    ? 'overlap'
    : containsUnknown
      ? 'unknown'
      : containsUncertain || confidenceValue < 0.5 || !bestHasIdentity
        ? 'uncertain'
        : 'identified'
  return {
    analysisId: record.id,
    ...(status === 'identified' && best.turn.speakerId
      ? { speakerId: best.turn.speakerId, speakerLabel: best.turn.speakerLabel }
      : {}),
    confidence: confidenceValue,
    uncertain: status !== 'identified',
    status,
    sourceTurnIds: overlaps.map(({ turn }) => turn.id).slice(0, 32)
  }
}

export function mergeAttributions(
  values: readonly SpeakerAttribution[],
  analysisId: string
): SpeakerAttribution | undefined {
  if (values.length === 0) return undefined
  const confident = values.filter(({ uncertain, speakerId }) => !uncertain && speakerId)
  const speakerIds = new Set(confident.map(({ speakerId }) => speakerId))
  const best = [...values].sort((left, right) => right.confidence - left.confidence)[0]!
  const explicitOverlap = values.some(({ status }) => status === 'overlap')
  const containsUnknown = values.some(({ status }) => status === 'unknown')
  const uncertain = speakerIds.size !== 1 || values.some((value) => value.uncertain)
  const status: SpeakerAttributionEvidence['status'] = explicitOverlap || speakerIds.size > 1
    ? 'overlap'
    : containsUnknown
      ? 'unknown'
      : uncertain
        ? 'uncertain'
        : 'identified'
  return {
    analysisId,
    ...(status === 'identified' && best.speakerId ? { speakerId: best.speakerId, speakerLabel: best.speakerLabel } : {}),
    confidence: best.confidence,
    uncertain: status !== 'identified',
    status,
    sourceTurnIds: [...new Set(values.flatMap(({ sourceTurnIds }) => sourceTurnIds))].slice(0, 32)
  }
}

export function provenance(input: {
  assetId: string
  sourceFingerprint: SourceIdentity
  adapterId: string
  adapterVersion: string
  modelId?: string
  algorithm: string
  algorithmVersion: string
  parameters: readonly (string | number)[]
  now?: () => Date
}): LocalAnalysisProvenance {
  assertFingerprint(input.sourceFingerprint)
  const cacheKey = stableKey([
    input.assetId,
    input.sourceFingerprint.value,
    input.adapterId,
    input.adapterVersion,
    input.modelId ?? '',
    input.algorithm,
    input.algorithmVersion,
    ...input.parameters
  ])
  return {
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    algorithm: input.algorithm,
    algorithmVersion: input.algorithmVersion,
    sourceFingerprint: { ...input.sourceFingerprint },
    local: true,
    networkUsed: false,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    cacheKey,
    execution: 'local'
  }
}

export function validateTimedEvidence(
  values: readonly { id: string; startUs: number; endUs: number }[],
  name: string
): void {
  if (values.length > 100_000) throw engineError('invalid_operation', `${name} evidence exceeds the bounded limit`)
  const ids = new Set<string>()
  let previousStart = -1
  for (const value of values) {
    identifier(value.id, `${name} ID`)
    if (ids.has(value.id)) throw engineError('invalid_operation', `${name} IDs must be unique`)
    ids.add(value.id)
    boundedInteger(value.startUs, 0, Number.MAX_SAFE_INTEGER, `${name} start`)
    boundedInteger(value.endUs, 1, Number.MAX_SAFE_INTEGER, `${name} end`)
    if (value.endUs <= value.startUs || value.startUs < previousStart) {
      throw engineError('invalid_operation', `${name} ranges must be non-empty and ordered`)
    }
    previousStart = value.startUs
  }
}

export function validateSpeakerDescriptor(value: SpeakerModelDescriptor): void {
  identifier(value.adapterId, 'speaker adapter ID')
  identifier(value.modelId, 'speaker model ID')
  boundedString(value.adapterVersion, 'speaker adapter version', 1, 64)
  boundedString(value.modelVersion, 'speaker model version', 1, 64)
  boundedInteger(value.embeddingDimensions, 1, 65_536, 'speaker embedding dimensions')
}

export function validateSpeakerDiarizationAdapterStatus(value: SpeakerDiarizationAdapterStatus): void {
  identifier(value.descriptor.id, 'speaker adapter ID')
  boundedString(value.descriptor.version, 'speaker adapter version', 1, 64)
  if (value.descriptor.execution === 'import') {
    if (value.descriptor.format !== 'kun-speaker-json-v1') {
      throw engineError('invalid_operation', 'Imported speaker adapter requires the bounded Kun speaker JSON format')
    }
    if (value.descriptor.modelId !== undefined || value.descriptor.modelVersion !== undefined) {
      throw engineError('invalid_operation', 'Imported speaker adapter cannot claim a model')
    }
  } else {
    if (!value.descriptor.modelId || !value.descriptor.modelVersion) {
      throw engineError('invalid_operation', 'Local speaker adapter requires model identity and version')
    }
    identifier(value.descriptor.modelId, 'speaker model ID')
    boundedString(value.descriptor.modelVersion, 'speaker model version', 1, 64)
  }
  if (value.outcome === 'unavailable' && !value.remediation.trim()) {
    throw engineError('invalid_operation', 'Unavailable speaker adapter requires remediation')
  }
}

export function persistedSpeakerAttribution(value: SpeakerAttribution): SpeakerAttributionEvidence {
  return {
    analysisId: value.analysisId,
    ...(value.status === 'identified' && value.speakerId && value.speakerLabel
      ? { speakerId: value.speakerId, speakerLabel: value.speakerLabel }
      : {}),
    confidence: value.confidence,
    status: value.status,
    sourceTurnIds: [...value.sourceTurnIds]
  }
}

export function boundedSpeakerLabel(value: string, name: string): string {
  const normalized = value.normalize('NFKC').trim()
  if (normalized.length < 1 || normalized.length > 128 || containsAsciiControlCharacters(normalized)) {
    throw engineError('invalid_operation', `${name} is invalid`)
  }
  return normalized
}

export function validIsoTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw engineError('invalid_operation', `${name} must be an ISO timestamp`)
  }
  return value
}

export function speakerUnavailable(
  code: Extract<SpeakerAdapterCapability, { outcome: 'unavailable' }>['code'],
  retryable: boolean,
  remediation: string
): Extract<SpeakerAdapterCapability, { outcome: 'unavailable' }> {
  return { outcome: 'unavailable', code, retryable, remediation, networkUsedForInference: false }
}

export function validateFeatureSeries(values: readonly number[], name: string): void {
  if (values.length < 8 || values.length > 1_000_000) {
    throw engineError('invalid_operation', `${name} requires 8 through 1000000 local feature samples`)
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw engineError('invalid_operation', `${name} must contain finite numbers`)
  }
}

export function seededCandidates(maxLag: number, seed: number): number[] {
  const candidates = Array.from({ length: maxLag * 2 + 1 }, (_, index) => index - maxLag)
  let state = seed || 0x6d2b79f5
  const random = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[candidates[index], candidates[swap]] = [candidates[swap]!, candidates[index]!]
  }
  return candidates
}

export function correlationAtLag(
  reference: readonly number[],
  target: readonly number[],
  lag: number
): number | undefined {
  const referenceStart = Math.max(0, -lag)
  const targetStart = Math.max(0, lag)
  const length = Math.min(reference.length - referenceStart, target.length - targetStart)
  if (length < 8) return undefined
  let dotValue = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < length; index += 1) {
    const left = reference[referenceStart + index]!
    const right = target[targetStart + index]!
    dotValue += left * right
    leftMagnitude += left * left
    rightMagnitude += right * right
  }
  if (leftMagnitude <= Number.EPSILON || rightMagnitude <= Number.EPSILON) return undefined
  return dotValue / Math.sqrt(leftMagnitude * rightMagnitude)
}

export function normalizedVector(values: readonly number[], name: string): number[] {
  if (values.length < 1 || values.length > 65_536) throw engineError('invalid_operation', `${name} has invalid dimensions`)
  let magnitudeSquared = 0
  for (const value of values) {
    if (!Number.isFinite(value)) throw engineError('invalid_operation', `${name} must contain finite numbers`)
    magnitudeSquared += value * value
  }
  if (magnitudeSquared <= Number.EPSILON) throw engineError('invalid_operation', `${name} cannot be a zero vector`)
  const magnitude = Math.sqrt(magnitudeSquared)
  return values.map((value) => value / magnitude)
}

export function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((total, value, index) => total + value * right[index]!, 0)
}

export function stableKey(values: readonly (string | number)[]): string {
  let hash = 0x811c9dc5
  for (const character of values.join('\u0000')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function stableDigest64(values: readonly string[]): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5]
  return seeds.map((seed) => {
    let hash = seed >>> 0
    for (const character of values.join('\u0000')) {
      hash ^= character.codePointAt(0) ?? 0
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }).join('')
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export function assertFingerprint(value: SourceIdentity): void {
  if (value.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/u.test(value.value)) {
    throw engineError('invalid_operation', 'Analysis source fingerprint must be a lowercase SHA-256 digest')
  }
}

export function identifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw engineError('invalid_operation', `${name} is invalid`)
}

export function boundedString(value: string, name: string, minimum: number, maximum: number): void {
  if (value.length < minimum || value.length > maximum) throw engineError('invalid_operation', `${name} is out of bounds`)
}

export function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw engineError('invalid_operation', `${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

export function confidence(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw engineError('invalid_operation', `${name} must be from 0 through 1`)
  return value
}
