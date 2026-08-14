import { createHash } from 'node:crypto'
import type { JobSnapshot, JsonObject, JsonValue } from '@kun/extension-api'
import type {
  DerivedMediaRecord,
  MediaAsset,
  SourceFingerprint,
  VideoProject
} from '../engine/index.js'
import { fingerprintAssetIdentity } from '../engine/index.js'
import type { PendingOutput, PendingStage } from './derived-media-service-model.js'

const DERIVED_OUTPUT_PREFIX = 'derived-media:output:'

export function effectiveSourceFingerprint(asset: MediaAsset): SourceFingerprint {
  const grantFingerprint = fingerprintAssetIdentity(asset)
  if (asset.sourceIdentity?.algorithm !== 'sha256') return grantFingerprint
  return {
    algorithm: 'sha256',
    value: createHash('sha256')
      .update(asset.sourceIdentity.value)
      .update('\0')
      .update(grantFingerprint.value)
      .digest('hex'),
    ...(asset.sourceIdentity.sizeBytes === undefined ? {} : { sizeBytes: asset.sourceIdentity.sizeBytes })
  }
}

export function derivedRecordProjection(record: DerivedMediaRecord): JsonObject {
  const artifactHandleId = record.status === 'partial'
    ? record.partialArtifactHandleIds[0]
    : record.status === 'ready'
      ? record.artifactHandleIds[0]
      : undefined
  return {
    schemaVersion: 1,
    id: record.id,
    generation: record.generation,
    statusGeneration: record.statusGeneration,
    kind: record.kind,
    projectId: record.owner.projectId ?? null,
    assetId: record.owner.assetId ?? null,
    status: record.status,
    priority: record.priority,
    bytes: record.bytes,
    pinned: record.pinned,
    attempt: record.attempt,
    jobId: record.jobId ?? null,
    progress: record.progress ? record.progress as unknown as JsonValue : null,
    error: record.error ? record.error as unknown as JsonValue : null,
    retryAfter: record.retryAfter ?? null,
    artifactHandleId: artifactHandleId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccessedAt: record.lastAccessedAt
  }
}

export function requiredAsset(project: VideoProject, assetId: string): MediaAsset {
  const asset = project.assets.find(({ id }) => id === assetId)
  if (!asset) throw new Error(`Asset does not exist in project ${project.id}: ${assetId}`)
  return asset
}

export function expectedDerivedArtifact(kind: DerivedMediaRecord['kind']): {
  mediaKind: 'image' | 'video'
  mimeType: 'image/png' | 'video/mp4'
} | undefined {
  if (kind === 'proxy' || kind === 'preview') {
    return { mediaKind: 'video', mimeType: 'video/mp4' }
  }
  if (kind === 'waveform' || kind === 'thumbnail' || kind === 'filmstrip' || kind === 'proof') {
    return { mediaKind: 'image', mimeType: 'image/png' }
  }
  return undefined
}

export function outputKey(recordId: string): string {
  return `${DERIVED_OUTPUT_PREFIX}${recordId}`.slice(0, 256)
}

export function ownerMatches(
  record: DerivedMediaRecord,
  expected: Partial<DerivedMediaRecord['owner']>
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    record.owner[key as keyof DerivedMediaRecord['owner']] === value
  )
}

export function opaqueHandle(value: string, path: string): string {
  if (!isOpaqueHandle(value)) {
    throw new Error(`${path} must be an opaque Host media handle.`)
  }
  return value
}

export function isOpaqueHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
}

export function isPendingStage(value: JsonValue): value is PendingStage & JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value.id === 'partial' || value.id === 'final') &&
    isOpaqueHandle(value.outputHandleId) && typeof value.partial === 'boolean' &&
    value.partial === (value.id === 'partial')
}

export function optionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export function normalizedProgress(snapshot: JobSnapshot): {
  completed: number
  total: number
  unit: string
  message?: string
} | undefined {
  const progress = snapshot.progress
  if (!progress) return undefined
  const total = progress.total ?? 100
  const completed = progress.completed ?? progress.percentage ?? 0
  if (total <= 0 || completed < 0 || completed > total) return undefined
  return {
    completed,
    total,
    unit: progress.unit ?? (progress.percentage === undefined ? 'work' : 'percent'),
    ...(progress.message ? { message: progress.message.slice(0, 512) } : {})
  }
}

export function normalizedStageProgress(
  snapshot: JobSnapshot,
  pending: PendingOutput | undefined
): {
  completed: number
  total: number
  unit: string
  message?: string
} | undefined {
  const progress = normalizedProgress(snapshot)
  if (!progress || !pending) return progress
  const ratio = Math.max(0, Math.min(1, progress.completed / progress.total))
  return {
    completed: Math.min(pending.stages.length, pending.stageIndex + ratio),
    total: pending.stages.length,
    unit: 'phase',
    ...(progress.message ? { message: progress.message } : {})
  }
}

export function stageParameters(
  record: DerivedMediaRecord,
  pending: PendingOutput,
  stage: PendingStage
): {
  seekUs?: number
  durationUs?: number
  width?: number
  height?: number
  filmstripIntervalUs?: number
  filmstripColumns?: number
  filmstripRows?: number
} {
  const parameters = record.normalizedParameters
  const seekUs = optionalInteger(parameters.seekUs)
  const requestedDurationUs = optionalInteger(parameters.durationUs) ?? pending.durationUs
  const requestedWidth = optionalInteger(parameters.width)
  const requestedHeight = optionalInteger(parameters.height)
  const requestedIntervalUs = optionalInteger(parameters.filmstripIntervalUs)
  const requestedColumns = optionalInteger(parameters.filmstripColumns)
  const requestedRows = optionalInteger(parameters.filmstripRows)
  if (!stage.partial) {
    const gridCells = Math.max(1, (requestedColumns ?? 5) * (requestedRows ?? 2))
    return {
      ...(seekUs === undefined ? {} : { seekUs }),
      durationUs: requestedDurationUs,
      ...(requestedWidth === undefined ? {} : { width: requestedWidth }),
      ...(requestedHeight === undefined ? {} : { height: requestedHeight }),
      ...(record.kind !== 'filmstrip'
        ? (requestedIntervalUs === undefined ? {} : { filmstripIntervalUs: requestedIntervalUs })
        : { filmstripIntervalUs: requestedIntervalUs ?? Math.max(1, Math.ceil(requestedDurationUs / gridCells)) }),
      ...(requestedColumns === undefined ? {} : { filmstripColumns: requestedColumns }),
      ...(requestedRows === undefined ? {} : { filmstripRows: requestedRows })
    }
  }
  if (record.kind === 'waveform') {
    const partialDurationUs = Math.min(60_000_000, requestedDurationUs)
    return {
      ...(seekUs === undefined ? {} : { seekUs }),
      durationUs: partialDurationUs,
      width: Math.min(512, requestedWidth ?? 1280),
      height: Math.min(96, requestedHeight ?? 240)
    }
  }
  if (record.kind === 'filmstrip') {
    const partialDurationUs = Math.min(60_000_000, requestedDurationUs)
    return {
      ...(seekUs === undefined ? {} : { seekUs }),
      durationUs: partialDurationUs,
      width: Math.min(320, requestedWidth ?? 1280),
      height: Math.min(180, requestedHeight ?? 720),
      filmstripIntervalUs: Math.max(
        requestedIntervalUs ?? 5_000_000,
        Math.max(1, Math.ceil(partialDurationUs / 3))
      ),
      filmstripColumns: Math.min(3, requestedColumns ?? 5),
      filmstripRows: 1
    }
  }
  return {
    ...(seekUs === undefined ? {} : { seekUs }),
    durationUs: Math.min(10_000_000, requestedDurationUs),
    width: Math.min(640, requestedWidth ?? 1280),
    height: Math.min(360, requestedHeight ?? 720)
  }
}

export function sameProgress(
  record: DerivedMediaRecord,
  progress: { completed: number; total: number; unit: string; message?: string }
): boolean {
  return record.progress?.completed === progress.completed &&
    record.progress.total === progress.total &&
    record.progress.unit === progress.unit &&
    record.progress.message === progress.message
}
