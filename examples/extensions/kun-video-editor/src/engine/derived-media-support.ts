import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  type DerivedMediaKind,
  type DerivedMediaOwner,
  type DerivedMediaPriority,
  type DerivedMediaRecord,
  type DerivedMediaSnapshot,
  type DerivedMediaStatus,
  type DerivedRequest
} from './derived-media.js'
import { assertSourceFingerprint, type SourceFingerprint } from './transcript-adapters.js'

export const MAX_PARAMETER_BYTES = 64 * 1024
export const MAX_ARTIFACTS = 16
export const PRIORITY_ORDER: Readonly<Record<DerivedMediaPriority, number>> = Object.freeze({
  background: 100,
  user: 200,
  interactive: 300,
  export: 400
})

export function derivedDedupeKey(request: DerivedRequest): string {
  validateRequest(request)
  return createHash('sha256').update(canonicalJson({
    kind: request.kind,
    owner: request.owner,
    sourceFingerprint: request.sourceFingerprint,
    normalizedParameters: request.normalizedParameters ?? {},
    producer: request.producer,
    dependencies: [...new Set(request.dependencies ?? [])].sort()
  })).digest('hex')
}

export function validateRequest(request: DerivedRequest): void {
  if (!DERIVED_KINDS.has(request.kind)) throw engineError('invalid_operation', 'Unsupported derived media kind')
  validateOwner(request.owner)
  assertSourceFingerprint(request.sourceFingerprint)
  boundedString(request.producer.id, 1, 128, 'producer.id')
  boundedString(request.producer.version, 1, 64, 'producer.version')
  const parameterBytes = new TextEncoder().encode(canonicalJson(request.normalizedParameters ?? {})).byteLength
  if (parameterBytes > MAX_PARAMETER_BYTES) throw engineError('invalid_operation', 'Derived parameters exceed 64 KiB')
  if ((request.dependencies?.length ?? 0) > 64) throw engineError('invalid_operation', 'Derived request has too many dependencies')
}

export function validateSnapshot(value: unknown, maxRecords: number): DerivedMediaSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > maxRecords) {
    throw engineError('invalid_project', 'Derived metadata snapshot is invalid')
  }
  const records = value.records.map((record, index) => validateRecord(record, index + 1))
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id) || keys.has(record.dedupeKey)) throw engineError('invalid_project', 'Derived metadata identities must be unique')
    ids.add(record.id)
    keys.add(record.dedupeKey)
  }
  for (const record of records) assertDependencies(records, record)
  const maximumRecordGeneration = records.reduce(
    (maximum, record) => Math.max(maximum, record.generation, record.statusGeneration),
    0
  )
  const generation = Number.isSafeInteger(value.generation) && Number(value.generation) >= 0
    ? Math.max(Number(value.generation), maximumRecordGeneration)
    : maximumRecordGeneration
  return { schemaVersion: 1, generation, records }
}

export function validateRecord(value: unknown, legacyGeneration: number): DerivedMediaRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) throw engineError('invalid_project', 'Derived record is invalid')
  const record = structuredClone(value) as unknown as DerivedMediaRecord
  record.generation = positiveGeneration(value.generation, legacyGeneration, 'derived.generation')
  record.statusGeneration = positiveGeneration(
    value.statusGeneration,
    record.generation,
    'derived.statusGeneration'
  )
  if (record.statusGeneration > record.generation) {
    throw engineError('invalid_project', 'Derived status generation cannot exceed its record generation')
  }
  boundedString(record.id, 1, 128, 'derived.id')
  if (!/^[a-f0-9]{64}$/u.test(record.dedupeKey)) throw engineError('invalid_project', 'Derived dedupe key is invalid')
  if (!DERIVED_KINDS.has(record.kind) || !ALL_STATUSES.includes(record.status)) throw engineError('invalid_project', 'Derived kind or status is invalid')
  validateOwner(record.owner)
  assertSourceFingerprint(record.sourceFingerprint)
  validateRequest({
    kind: record.kind,
    owner: record.owner,
    sourceFingerprint: record.sourceFingerprint,
    normalizedParameters: record.normalizedParameters,
    producer: record.producer,
    dependencies: record.dependencies,
    priority: record.priority,
    pinned: record.pinned
  })
  if (!Object.hasOwn(PRIORITY_ORDER, record.priority) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isSafeInteger(record.attempt) || record.attempt < 1) {
    throw engineError('invalid_project', 'Derived accounting is invalid')
  }
  record.artifactHandleIds = boundedHandles(record.artifactHandleIds)
  record.partialArtifactHandleIds = boundedHandles(record.partialArtifactHandleIds)
  for (const timestamp of [record.createdAt, record.updatedAt, record.lastAccessedAt, record.retryAfter].filter(Boolean)) {
    if (Number.isNaN(Date.parse(timestamp!))) throw engineError('invalid_project', 'Derived timestamp is invalid')
  }
  return record
}

export function positiveGeneration(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw engineError('invalid_project', `${path} must be a positive safe integer`)
  }
  return Number(value)
}

export function assertDependencies(records: readonly DerivedMediaRecord[], record: DerivedMediaRecord): void {
  if (record.dependencies.includes(record.id)) throw engineError('invalid_operation', 'Derived record cannot depend on itself')
  const known = new Set(records.map(({ id }) => id))
  for (const dependency of record.dependencies) {
    if (!known.has(dependency)) throw engineError('invalid_operation', `Missing derived dependency ${dependency}`)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw engineError('invalid_operation', 'Derived dependency graph contains a cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const candidate of records) visit(candidate.id)
}

export function defaultPriority(kind: DerivedMediaKind): DerivedMediaPriority {
  if (kind === 'proof' || kind === 'preview') return 'interactive'
  if (kind === 'proxy') return 'user'
  return 'background'
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 1_000 * 2 ** Math.min(12, Math.max(0, attempt - 1)))
}

export function isEvictable(records: readonly DerivedMediaRecord[], record: DerivedMediaRecord): boolean {
  return !record.pinned && !['queued', 'running', 'partial'].includes(record.status) && !hasDependent(records, record.id)
}

export function hasDependent(records: readonly DerivedMediaRecord[], id: string): boolean {
  return records.some((record) => record.dependencies.includes(id) && record.status !== 'invalid')
}

export function requiredRecord(records: readonly DerivedMediaRecord[], id: string): DerivedMediaRecord {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw engineError('invalid_operation', `Derived record does not exist: ${id}`)
  return record
}

export function invalidTransition(record: DerivedMediaRecord, target: string): never {
  throw engineError('invalid_operation', `Derived record ${record.id} cannot move from ${record.status} to ${target}`)
}

export function ownerMatches(owner: DerivedMediaOwner, filter?: Partial<DerivedMediaOwner>): boolean {
  if (!filter) return true
  return Object.entries(filter).every(([key, value]) => owner[key as keyof DerivedMediaOwner] === value)
}

export function validateOwner(owner: DerivedMediaOwner): void {
  boundedString(owner.extensionId, 1, 256, 'owner.extensionId')
  boundedString(owner.extensionVersion, 1, 64, 'owner.extensionVersion')
  boundedString(owner.workspaceId, 1, 256, 'owner.workspaceId')
  if (owner.projectId !== undefined) boundedString(owner.projectId, 1, 128, 'owner.projectId')
  if (owner.assetId !== undefined) boundedString(owner.assetId, 1, 128, 'owner.assetId')
}

export function boundedHandles(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_ARTIFACTS) throw engineError('invalid_operation', 'Derived artifacts exceed the bounded limit')
  return [...new Set(values.map((value) => boundedString(value, 8, 512, 'artifactHandleId')))]
}

export function boundedString(value: string, minimum: number, maximum: number, path: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw engineError('invalid_operation', `${path} must contain ${minimum} through ${maximum} characters`)
  }
  return value
}

export function boundedPositive(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw engineError('invalid_operation', `${path} must be a positive integer`)
  return value
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const DERIVED_KINDS = new Set<DerivedMediaKind>([
  'waveform', 'thumbnail', 'filmstrip', 'transcript', 'analysis', 'embedding', 'proxy', 'proof', 'preview'
])
export const ALL_STATUSES: readonly DerivedMediaStatus[] = [
  'queued', 'running', 'partial', 'ready', 'failed', 'cancelled', 'interrupted', 'invalid'
]
