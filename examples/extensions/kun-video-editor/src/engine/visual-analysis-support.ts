import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  buildFrameSamplingPlan,
  type FrameSamplingPlan,
  type VisualAdapterCapability,
  type VisualEmbeddingEvidence,
  type VisualIndexRecord,
  type VisualModelDescriptor
} from './visual-analysis.js'
import type { SourceIdentity } from './schema.js'

export const MAX_VISUAL_EMBEDDING_DIMENSIONS = 4_096
export const MAX_VISUAL_FRAME_SAMPLES = 2_000
export const MAX_VISUAL_VECTOR_VALUES = 500_000

export function unavailable(
  code: Extract<VisualAdapterCapability, { outcome: 'unavailable' }>['code'],
  retryable: boolean,
  remediation: string,
  verificationErrors: string[] = []
): Extract<VisualAdapterCapability, { outcome: 'unavailable' }> {
  return {
    outcome: 'unavailable',
    code,
    retryable,
    remediation,
    networkUsedForInference: false,
    verificationErrors: verificationErrors.slice(0, 32)
  }
}

export function validateDescriptor(value: VisualModelDescriptor): void {
  identifier(value.adapterId, 'adapterId')
  identifier(value.modelId, 'modelId')
  identifier(value.packageId, 'packageId')
  version(value.adapterVersion, 'adapterVersion')
  version(value.modelVersion, 'modelVersion')
  sha256(value.manifestSha256, 'manifestSha256')
  boundedInteger(value.embeddingDimensions, 1, MAX_VISUAL_EMBEDDING_DIMENSIONS, 'embeddingDimensions')
  if (value.files.length < 1 || value.files.length > 128) throw engineError('invalid_operation', 'Visual model manifest requires 1 through 128 files')
  const names = new Set<string>()
  for (const file of value.files) {
    if (!isSafeBasename(file.name) || names.has(file.name)) {
      throw engineError('invalid_operation', 'Visual model file names must be unique safe basenames')
    }
    names.add(file.name)
    sha256(file.sha256, `digest for ${file.name}`)
    boundedInteger(file.byteSize, 1, Number.MAX_SAFE_INTEGER, `byte size for ${file.name}`)
  }
}

export function uniformlyDistributedIndexes(total: number, sampleCount: number): number[] {
  if (sampleCount === total) return Array.from({ length: total }, (_, index) => index)
  if (sampleCount === 1) return [Math.floor((total - 1) / 2)]
  return Array.from({ length: sampleCount }, (_, index) =>
    Math.floor(index * (total - 1) / (sampleCount - 1))
  )
}

export function samplingPlanKey(plan: FrameSamplingPlan): string {
  return stableKey([
    plan.assetId,
    plan.sourceFingerprint.value,
    plan.durationUs,
    plan.intervalUs,
    plan.maxFrames,
    plan.strategy,
    ...plan.samples.flatMap((sample) => [
      sample.id,
      sample.startUs,
      sample.endUs,
      sample.representativeUs
    ])
  ])
}

export function visualIndexKey(
  plan: FrameSamplingPlan,
  adapter: VisualIndexRecord['adapter'],
  dimensions: number,
  samples: readonly VisualIndexRecord['samples'][number][]
): string {
  return stableKey([
    plan.assetId,
    plan.sourceFingerprint.value,
    adapter.id,
    adapter.version,
    adapter.modelId,
    adapter.modelVersion,
    adapter.packageId,
    adapter.manifestSha256,
    plan.durationUs,
    plan.intervalUs,
    plan.maxFrames,
    plan.strategy,
    samplingPlanKey(plan),
    dimensions,
    ...samples.flatMap((sample) => [
      sample.id,
      ...sample.vector.map((value) => Number(value.toPrecision(15))),
      sample.confidence ?? 'no-confidence'
    ])
  ])
}

export function assertFrameSamplingPlan(plan: FrameSamplingPlan): void {
  if (!isObjectRecord(plan) || plan.schemaVersion !== 1 || !Array.isArray(plan.samples)) {
    throw engineError('invalid_operation', 'Visual frame sampling plan is invalid')
  }
  const canonical = buildFrameSamplingPlan({
    assetId: plan.assetId,
    durationUs: plan.durationUs,
    sourceFingerprint: plan.sourceFingerprint,
    intervalUs: plan.intervalUs,
    maxFrames: plan.maxFrames
  })
  if (
    plan.strategy !== canonical.strategy ||
    plan.completeness !== canonical.completeness ||
    plan.omittedSampleCount !== canonical.omittedSampleCount ||
    plan.samples.length !== canonical.samples.length ||
    plan.samples.some((sample, index) => {
      const expected = canonical.samples[index]
      return !expected || sample.id !== expected.id || sample.assetId !== expected.assetId ||
        sample.startUs !== expected.startUs || sample.endUs !== expected.endUs ||
        sample.representativeUs !== expected.representativeUs
    })
  ) {
    throw engineError('invalid_operation', 'Visual frame sampling plan does not match deterministic sampling parameters')
  }
}

export function assertVisualIndex(index: VisualIndexRecord): void {
  if (
    index.schemaVersion !== 1 || index.immutable !== true ||
    !isObjectRecord(index.adapter) || !isObjectRecord(index.parameters) ||
    !Array.isArray(index.samples)
  ) {
    throw engineError('invalid_operation', 'Visual index record shape is invalid')
  }
  identifier(index.id, 'visual index ID')
  if (!/^visual-index:[a-f0-9]{64}$/u.test(index.id)) {
    throw engineError('invalid_operation', 'Visual index ID is not content-addressed')
  }
  identifier(index.assetId, 'visual index asset ID')
  assertFingerprint(index.sourceFingerprint)
  identifier(index.adapter.id, 'visual adapter ID')
  version(index.adapter.version, 'visual adapter version')
  identifier(index.adapter.modelId, 'visual model ID')
  version(index.adapter.modelVersion, 'visual model version')
  identifier(index.adapter.packageId, 'visual model package ID')
  sha256(index.adapter.manifestSha256, 'visual model manifest digest')
  if (index.adapter.execution !== 'local') {
    throw engineError('invalid_operation', 'Visual index adapter execution must be local')
  }
  const dimensions = boundedInteger(
    index.parameters.embeddingDimensions,
    1,
    MAX_VISUAL_EMBEDDING_DIMENSIONS,
    'visual index embedding dimensions'
  )
  if (index.adapter.embeddingDimensions !== dimensions) {
    throw engineError('invalid_operation', 'Visual index adapter dimensions do not match its parameters')
  }
  const plan = buildFrameSamplingPlan({
    assetId: index.assetId,
    durationUs: index.parameters.durationUs,
    sourceFingerprint: index.sourceFingerprint,
    intervalUs: index.parameters.intervalUs,
    maxFrames: index.parameters.maxFrames
  })
  if (
    index.parameters.samplingStrategy !== plan.strategy ||
    index.parameters.samplingPlanKey !== samplingPlanKey(plan) ||
    index.plannedSampleCount !== plan.samples.length ||
    index.omittedSampleCount !== plan.omittedSampleCount
  ) {
    throw engineError('invalid_operation', 'Visual index sampling provenance does not match its deterministic plan')
  }
  if (index.samples.length < 1 || index.samples.length > MAX_VISUAL_FRAME_SAMPLES) {
    throw engineError('invalid_operation', 'Visual index sample count is out of bounds')
  }
  if (
    index.samples.length * dimensions > MAX_VISUAL_VECTOR_VALUES ||
    index.indexedSampleCount !== index.samples.length ||
    index.indexedSampleCount > index.plannedSampleCount ||
    !['complete', 'partial'].includes(index.completeness) ||
    (index.completeness === 'complete' && (
      plan.completeness !== 'complete' || index.indexedSampleCount !== index.plannedSampleCount
    )) ||
    !isIsoDate(index.createdAt)
  ) {
    throw engineError('invalid_operation', 'Visual index completeness or storage bounds are invalid')
  }
  const plannedById = new Map(plan.samples.map((sample, position) => [sample.id, { sample, position }]))
  const sampleIds = new Set<string>()
  let previousPosition = -1
  for (const sample of index.samples) {
    identifier(sample.id, 'visual sample ID')
    if (sample.assetId !== index.assetId || sampleIds.has(sample.id)) {
      throw engineError('invalid_operation', 'Visual index samples must have unique IDs bound to one asset')
    }
    sampleIds.add(sample.id)
    const planned = plannedById.get(sample.id)
    if (
      !planned || planned.position <= previousPosition ||
      sample.startUs !== planned.sample.startUs || sample.endUs !== planned.sample.endUs ||
      sample.representativeUs !== planned.sample.representativeUs
    ) {
      throw engineError('invalid_operation', 'Visual index sample is not bound to the deterministic frame plan')
    }
    previousPosition = planned.position
    if (sample.vector.length !== dimensions) {
      throw engineError('invalid_operation', 'Visual index sample dimensions are inconsistent')
    }
    normalizedVector(sample.vector, 'visual index sample')
    if (sample.confidence !== undefined) confidence(sample.confidence, 'visual sample confidence')
  }
  const expectedId = `visual-index:${visualIndexKey(plan, index.adapter, dimensions, index.samples)}`
  if (index.id !== expectedId) {
    throw engineError('invalid_operation', 'Visual index content digest does not match its immutable evidence')
  }
}

export function inferDimensions(values: readonly VisualEmbeddingEvidence[]): number {
  const dimensions = values[0]?.vector.length ?? 0
  if (dimensions < 1 || dimensions > MAX_VISUAL_EMBEDDING_DIMENSIONS) throw engineError('invalid_operation', 'Visual embeddings have invalid dimensions')
  return dimensions
}

export function normalizedVector(values: readonly number[], name: string): number[] {
  if (values.length < 1 || values.length > MAX_VISUAL_EMBEDDING_DIMENSIONS) throw engineError('invalid_operation', `${name} has invalid dimensions`)
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

export function assertFingerprint(value: SourceIdentity): void {
  if (value.algorithm !== 'sha256') throw engineError('invalid_operation', 'Visual source fingerprint must use SHA-256')
  sha256(value.value, 'source fingerprint')
}

export function stableKey(values: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export function sha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw engineError('invalid_operation', `${name} must be a lowercase SHA-256 digest`)
}

export function identifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw engineError('invalid_operation', `${name} is invalid`)
}

export function boundedString(value: string, name: string, minimum: number, maximum: number): void {
  if (value.length < minimum || value.length > maximum) throw engineError('invalid_operation', `${name} is out of bounds`)
}

export function version(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value)) {
    throw engineError('invalid_operation', `${name} must be a bounded printable version`)
  }
}

export function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw engineError('invalid_operation', `${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

export function finite(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw engineError('invalid_operation', `${name} must be from ${minimum} through ${maximum}`)
  }
  return value
}

export function confidence(value: number, name: string): void {
  finite(value, 0, 1, name)
}

export function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function isSafeBasename(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '.' && value !== '..'
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

export function safeDiagnosticName(value: string): string {
  return isSafeBasename(value) ? value : '<invalid-name>'
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
