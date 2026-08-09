import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  MAX_VISUAL_EMBEDDING_DIMENSIONS,
  MAX_VISUAL_FRAME_SAMPLES,
  MAX_VISUAL_VECTOR_VALUES,
  assertFingerprint,
  assertFrameSamplingPlan,
  assertVisualIndex,
  boundedInteger,
  confidence,
  deepFreeze,
  dot,
  finite,
  identifier,
  inferDimensions,
  isIsoDate,
  isObjectRecord,
  isSafeBasename,
  isSha256,
  normalizedVector,
  safeDiagnosticName,
  samplingPlanKey,
  unavailable,
  uniformlyDistributedIndexes,
  validateDescriptor,
  visualIndexKey
} from './visual-analysis-support.js'
import type { SourceIdentity } from './schema.js'

export type VisualModelDescriptor = {
  adapterId: string
  adapterVersion: string
  modelId: string
  modelVersion: string
  packageId: string
  manifestSha256: string
  files: Array<{ name: string; sha256: string; byteSize: number }>
  embeddingDimensions: number
}

export type VisualModelInstallReceipt = {
  broker: 'kun-model-broker'
  /** Absent legacy receipts are treated as downloaded packages. */
  packageSource?: 'bundled' | 'downloaded'
  packageId: string
  modelId: string
  modelVersion: string
  manifestSha256: string
  files: Array<{ name: string; sha256: string; byteSize: number }>
  downloadVerified: boolean
  sourceVerified?: boolean
  installVerified: boolean
  signatureVerified: boolean
  installedAt: string
}

export type VisualAdapterCapability =
  | {
      outcome: 'ready'
      adapter: {
        id: string
        version: string
        modelId: string
        modelVersion: string
        packageId: string
        manifestSha256: string
        embeddingDimensions: number
        execution: 'local'
      }
      installation: VisualModelInstallReceipt
      networkUsedForInference: false
    }
  | {
      outcome: 'unavailable'
      code: 'visual_model_disabled' | 'visual_model_missing' | 'visual_model_unverified' | 'visual_inference_broker_unavailable'
      retryable: boolean
      remediation: string
      networkUsedForInference: false
      verificationErrors: string[]
    }

export type FrameSample = {
  id: string
  assetId: string
  startUs: number
  endUs: number
  representativeUs: number
}

export type FrameSamplingPlan = {
  schemaVersion: 1
  assetId: string
  sourceFingerprint: SourceIdentity
  durationUs: number
  intervalUs: number
  maxFrames: number
  strategy: 'uniform-interval-v1'
  samples: FrameSample[]
  completeness: 'complete' | 'bounded'
  omittedSampleCount: number
}

export type VisualEmbeddingEvidence = {
  sampleId: string
  vector: number[]
  confidence?: number
}

export type VisualIndexRecord = {
  schemaVersion: 1
  id: string
  assetId: string
  sourceFingerprint: SourceIdentity
  adapter: {
    id: string
    version: string
    modelId: string
    modelVersion: string
    packageId: string
    manifestSha256: string
    embeddingDimensions: number
    execution: 'local'
  }
  parameters: {
    durationUs: number
    intervalUs: number
    maxFrames: number
    samplingStrategy: FrameSamplingPlan['strategy']
    samplingPlanKey: string
    embeddingDimensions: number
  }
  samples: Array<FrameSample & { vector: number[]; confidence?: number }>
  completeness: 'complete' | 'partial'
  indexedSampleCount: number
  plannedSampleCount: number
  omittedSampleCount: number
  createdAt: string
  immutable: true
}

export type VisualMoment = {
  id: string
  assetId: string
  sourceRange: { assetId: string; startUs: number; endUs: number }
  evidenceKind: 'visual-embedding'
  score: number
  scoreSemantics: 'uncalibrated-cosine'
  indexId: string
  indexCompleteness: VisualIndexRecord['completeness']
  sampleId: string
  evidence: {
    representativeUs: number
    modelConfidence?: number
  }
}

export type VisualMomentPage = {
  schemaVersion: 1
  offset: number
  results: VisualMoment[]
  nextOffset?: number
  totalMatches: number
  completeness: VisualIndexRecord['completeness']
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

export type VisualIndexProgress = {
  generation: number
  status: 'queued' | 'running' | 'cancelled' | 'ready' | 'failed'
  completed: number
  total: number
  unit: 'frames'
  message?: string
  error?: { code: string; message: string; retryable: boolean }
}

export function verifyVisualModelInstallation(
  descriptor: VisualModelDescriptor,
  receipt: VisualModelInstallReceipt
): { valid: boolean; errors: string[] } {
  validateDescriptor(descriptor)
  const errors: string[] = []
  const receiptNames = new Set<string>()
  if (receipt.files.length < 1 || receipt.files.length > 128) {
    errors.push('Installation receipt must contain 1 through 128 files.')
  }
  for (const file of receipt.files.slice(0, 128)) {
    if (!isSafeBasename(file.name) || receiptNames.has(file.name)) {
      errors.push('Installation receipt file names must be unique safe basenames.')
    }
    receiptNames.add(file.name)
    if (!isSha256(file.sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1) {
      errors.push(`Installed model file failed manifest validation: ${safeDiagnosticName(file.name)}`)
    }
  }
  if (receipt.broker !== 'kun-model-broker') errors.push('Installation was not attested by the Kun model broker.')
  if (receipt.packageId !== descriptor.packageId) errors.push('Installed package ID does not match the adapter descriptor.')
  if (receipt.modelId !== descriptor.modelId || receipt.modelVersion !== descriptor.modelVersion) {
    errors.push('Installed model identity does not match the adapter descriptor.')
  }
  if (receipt.manifestSha256 !== descriptor.manifestSha256) errors.push('Installed manifest digest does not match.')
  const packageSource = receipt.packageSource ?? 'downloaded'
  if (!['bundled', 'downloaded'].includes(packageSource)) {
    errors.push('Model package source is invalid.')
  } else if (packageSource === 'downloaded' && !receipt.downloadVerified) {
    errors.push('Model download has not been verified.')
  } else if (packageSource === 'bundled' && receipt.downloadVerified) {
    errors.push('Bundled model package falsely claims a verified download.')
  }
  if (packageSource === 'bundled' && receipt.sourceVerified !== true) {
    errors.push('Bundled model package source has not been verified.')
  }
  if (!receipt.installVerified) errors.push('Model installation has not been verified.')
  if (!receipt.signatureVerified) errors.push('Model package signature has not been verified.')
  if (!isIsoDate(receipt.installedAt)) errors.push('Installation receipt timestamp is invalid.')
  const installed = new Map(receipt.files.map((file) => [file.name, file]))
  for (const expected of descriptor.files) {
    const actual = installed.get(expected.name)
    if (!actual) errors.push(`Required model file is missing: ${expected.name}`)
    else if (actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) {
      errors.push(`Required model file failed digest or size verification: ${expected.name}`)
    }
  }
  if (receipt.files.some((file) => !descriptor.files.some(({ name }) => name === file.name))) {
    errors.push('Installation receipt contains files outside the declared model manifest.')
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 32) }
}

export function negotiateVisualAdapter(input: {
  optIn: boolean
  descriptor: VisualModelDescriptor
  receipt?: VisualModelInstallReceipt
  inferenceBrokerAvailable: boolean
}): VisualAdapterCapability {
  validateDescriptor(input.descriptor)
  if (!input.optIn) {
    return unavailable(
      'visual_model_disabled',
      true,
      'Enable local visual indexing for this workspace before installing or running a model.'
    )
  }
  if (!input.receipt) {
    return unavailable(
      'visual_model_missing',
      true,
      'Install the declared local visual model through a Host model broker that returns a verified receipt.'
    )
  }
  const verification = verifyVisualModelInstallation(input.descriptor, input.receipt)
  if (!verification.valid) {
    return unavailable(
      'visual_model_unverified',
      true,
      'Repair or reinstall the model through the Host model broker; unverified model files will not execute.',
      verification.errors
    )
  }
  if (!input.inferenceBrokerAvailable) {
    return unavailable(
      'visual_inference_broker_unavailable',
      false,
      'The model is verified, but this Extension API has no approved local visual-inference broker. Filename and transcript search remain available.'
    )
  }
  return {
    outcome: 'ready',
    adapter: {
      id: input.descriptor.adapterId,
      version: input.descriptor.adapterVersion,
      modelId: input.descriptor.modelId,
      modelVersion: input.descriptor.modelVersion,
      packageId: input.descriptor.packageId,
      manifestSha256: input.descriptor.manifestSha256,
      embeddingDimensions: input.descriptor.embeddingDimensions,
      execution: 'local'
    },
    installation: deepFreeze(structuredClone(input.receipt)),
    networkUsedForInference: false
  }
}

export function buildFrameSamplingPlan(input: {
  assetId: string
  durationUs: number
  sourceFingerprint: SourceIdentity
  intervalUs?: number
  maxFrames?: number
}): FrameSamplingPlan {
  identifier(input.assetId, 'assetId')
  const durationUs = boundedInteger(input.durationUs, 1, Number.MAX_SAFE_INTEGER, 'durationUs')
  const intervalUs = boundedInteger(input.intervalUs ?? 2_000_000, 100_000, 60_000_000, 'intervalUs')
  const maxFrames = boundedInteger(input.maxFrames ?? 240, 1, MAX_VISUAL_FRAME_SAMPLES, 'maxFrames')
  assertFingerprint(input.sourceFingerprint)
  const total = Math.max(1, Math.ceil(durationUs / intervalUs))
  const sampleCount = Math.min(total, maxFrames)
  const samples: FrameSample[] = []
  const sampleIndexes = uniformlyDistributedIndexes(total, sampleCount)
  for (const sampleIndex of sampleIndexes) {
    const startUs = Math.min(durationUs - 1, sampleIndex * intervalUs)
    const endUs = Math.min(durationUs, startUs + intervalUs)
    samples.push({
      id: `frame:${input.assetId}:${sampleIndex}`,
      assetId: input.assetId,
      startUs,
      endUs,
      representativeUs: startUs + Math.floor((endUs - startUs) / 2)
    })
  }
  return deepFreeze({
    schemaVersion: 1,
    assetId: input.assetId,
    sourceFingerprint: { ...input.sourceFingerprint },
    durationUs,
    intervalUs,
    maxFrames,
    strategy: 'uniform-interval-v1',
    samples,
    completeness: total <= maxFrames ? 'complete' : 'bounded',
    omittedSampleCount: Math.max(0, total - sampleCount)
  })
}

/**
 * Finalizes evidence returned by an approved adapter. This function never
 * synthesizes vectors; every indexed sample must have adapter evidence.
 */
export function createVisualIndexRecord(input: {
  capability: Extract<VisualAdapterCapability, { outcome: 'ready' }>
  plan: FrameSamplingPlan
  embeddings: readonly VisualEmbeddingEvidence[]
  allowPartial?: boolean
  now?: () => Date
}): VisualIndexRecord {
  assertFrameSamplingPlan(input.plan)
  const dimensions = inferDimensions(input.embeddings)
  if (dimensions !== input.capability.adapter.embeddingDimensions) {
    throw engineError('invalid_operation', 'Visual evidence dimensions do not match the verified model descriptor')
  }
  if (input.plan.samples.length * dimensions > MAX_VISUAL_VECTOR_VALUES) {
    throw engineError(
      'invalid_operation',
      `Visual index exceeds the ${MAX_VISUAL_VECTOR_VALUES} value storage budget; increase intervalUs or reduce maxFrames`
    )
  }
  const byId = new Map(input.embeddings.map((entry) => [entry.sampleId, entry]))
  if (byId.size !== input.embeddings.length) throw engineError('invalid_operation', 'Visual evidence sample IDs must be unique')
  if (!input.allowPartial && byId.size !== input.plan.samples.length) {
    throw engineError('invalid_operation', 'A complete visual index requires evidence for every planned sample')
  }
  const samples = input.plan.samples.flatMap((sample) => {
    const evidence = byId.get(sample.id)
    if (!evidence) return []
    if (evidence.vector.length !== dimensions) throw engineError('invalid_operation', 'Visual embedding dimensions are inconsistent')
    const vector = normalizedVector(evidence.vector, 'visual embedding')
    if (evidence.confidence !== undefined) confidence(evidence.confidence, 'visual confidence')
    return [{
      ...sample,
      vector,
      ...(evidence.confidence === undefined ? {} : { confidence: evidence.confidence })
    }]
  })
  if (samples.length === 0) throw engineError('invalid_operation', 'Visual index requires at least one measured embedding')
  for (const evidence of input.embeddings) {
    if (!input.plan.samples.some(({ id }) => id === evidence.sampleId)) {
      throw engineError('invalid_operation', `Visual evidence references an unplanned sample: ${evidence.sampleId}`)
    }
  }
  const key = visualIndexKey(input.plan, input.capability.adapter, dimensions, samples)
  return deepFreeze({
    schemaVersion: 1,
    id: `visual-index:${key}`,
    assetId: input.plan.assetId,
    sourceFingerprint: { ...input.plan.sourceFingerprint },
    adapter: { ...input.capability.adapter },
    parameters: {
      durationUs: input.plan.durationUs,
      intervalUs: input.plan.intervalUs,
      maxFrames: input.plan.maxFrames,
      samplingStrategy: input.plan.strategy,
      samplingPlanKey: samplingPlanKey(input.plan),
      embeddingDimensions: dimensions
    },
    samples,
    completeness: input.plan.completeness === 'complete' && samples.length === input.plan.samples.length
      ? 'complete'
      : 'partial',
    indexedSampleCount: samples.length,
    plannedSampleCount: input.plan.samples.length,
    omittedSampleCount: input.plan.omittedSampleCount,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    immutable: true
  })
}

export function searchVisualMoments(input: {
  index: VisualIndexRecord
  queryVector: readonly number[]
  minimumScore?: number
  offset?: number
  pageSize?: number
}): VisualMomentPage {
  assertVisualIndex(input.index)
  const query = normalizedVector(input.queryVector, 'visual query')
  if (query.length !== input.index.parameters.embeddingDimensions) {
    throw engineError('invalid_operation', 'Visual query dimensions do not match the immutable index')
  }
  const minimumScore = finite(input.minimumScore ?? -1, -1, 1, 'minimumScore')
  const offset = boundedInteger(input.offset ?? 0, 0, 1_000_000, 'offset')
  const pageSize = boundedInteger(input.pageSize ?? 20, 1, 100, 'pageSize')
  const matches = input.index.samples
    .map((sample): VisualMoment => ({
      id: `moment:${input.index.id}:${sample.id}`.slice(0, 512),
      assetId: input.index.assetId,
      sourceRange: { assetId: input.index.assetId, startUs: sample.startUs, endUs: sample.endUs },
      evidenceKind: 'visual-embedding',
      score: Number(dot(query, normalizedVector(sample.vector, 'visual index sample')).toFixed(8)),
      scoreSemantics: 'uncalibrated-cosine',
      indexId: input.index.id,
      indexCompleteness: input.index.completeness,
      sampleId: sample.id,
      evidence: {
        representativeUs: sample.representativeUs,
        ...(sample.confidence === undefined ? {} : { modelConfidence: sample.confidence })
      }
    }))
    .filter(({ score }) => score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.sourceRange.startUs - right.sourceRange.startUs)
  const results = matches.slice(offset, offset + pageSize)
  const nextOffset = offset + results.length
  return {
    schemaVersion: 1,
    offset,
    results,
    ...(nextOffset < matches.length ? { nextOffset } : {}),
    totalMatches: matches.length,
    completeness: input.index.completeness,
    ranking: {
      semantics: 'uncalibrated-cosine',
      calibratedConfidence: false,
      local: true,
      networkUsed: false,
      adapterId: input.index.adapter.id,
      adapterVersion: input.index.adapter.version,
      modelId: input.index.adapter.modelId,
      modelVersion: input.index.adapter.modelVersion,
      packageId: input.index.adapter.packageId,
      manifestSha256: input.index.adapter.manifestSha256
    }
  }
}

export function isValidVisualIndexRecord(value: unknown): value is VisualIndexRecord {
  if (!isObjectRecord(value)) return false
  try {
    assertVisualIndex(value as VisualIndexRecord)
    return true
  } catch {
    return false
  }
}

export class VisualIndexProgressTracker {
  private value: VisualIndexProgress

  constructor(total: number) {
    this.value = {
      generation: 1,
      status: 'queued',
      completed: 0,
      total: boundedInteger(total, 1, 10_000, 'total'),
      unit: 'frames'
    }
  }

  snapshot(): VisualIndexProgress {
    return structuredClone(this.value)
  }

  start(message?: string): VisualIndexProgress {
    this.assertActive()
    this.value = this.next({ status: 'running', ...(message ? { message } : {}) })
    return this.snapshot()
  }

  report(completed: number, message?: string): VisualIndexProgress {
    this.assertActive()
    const bounded = boundedInteger(completed, this.value.completed, this.value.total, 'completed')
    this.value = this.next({ status: 'running', completed: bounded, ...(message ? { message } : {}) })
    return this.snapshot()
  }

  cancel(): VisualIndexProgress {
    this.assertActive()
    this.value = this.next({ status: 'cancelled', message: 'Visual indexing was cancelled; no incomplete index was published.' })
    return this.snapshot()
  }

  complete(): VisualIndexProgress {
    this.assertActive()
    this.value = this.next({ status: 'ready', completed: this.value.total })
    return this.snapshot()
  }

  fail(code: string, message: string, retryable = true): VisualIndexProgress {
    this.assertActive()
    identifier(code, 'error code')
    this.value = this.next({ status: 'failed', error: { code, message: message.slice(0, 1_024), retryable } })
    return this.snapshot()
  }

  private next(patch: Partial<VisualIndexProgress>): VisualIndexProgress {
    return { ...this.value, ...patch, generation: this.value.generation + 1 }
  }

  private assertActive(): void {
    if (['cancelled', 'ready', 'failed'].includes(this.value.status)) {
      throw engineError('invalid_operation', `Visual index progress is already terminal: ${this.value.status}`)
    }
  }
}
