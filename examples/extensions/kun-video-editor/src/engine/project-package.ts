import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  MutationReceiptSchema,
  VideoProjectSchema,
  validateProjectRoundTrip,
  type MediaAsset,
  type MutationReceipt,
  type VideoProject
} from './schema.js'
import { containsNullOrLineBreak, replaceNullOrLineBreaks } from '../text-safety.js'
import {
  assertJobState,
  assertNotCancelled,
  assertPackageMetadataSafe,
  canonicalDigest,
  handleMissing,
  invalid,
  isCancellation,
  record,
  safeLogicalName,
  safeMime,
  sanitizeMetadata,
  sanitizeProject,
  stableStringify,
  validateBuildOptions,
  validateChatProvenance,
  validateGenerationLineage,
  validateOwner
} from './project-package-support.js'

export const PROJECT_PACKAGE_SCHEMA_VERSION = 1 as const

export const PROJECT_PACKAGE_LIMITS = Object.freeze({
  mediaAssets: 512,
  mediaObjectBytes: 512 * 1024 * 1024,
  totalMediaBytes: 2 * 1024 * 1024 * 1024,
  packageBytes: 3 * 1024 * 1024 * 1024,
  receipts: 2_000,
  chatProvenance: 10_000,
  generationLineage: 2_000,
  missingMedia: 512,
  string: 1_024,
  id: 192
})

export type ProjectPackageMissingMediaPolicy = 'fail' | 'record-incomplete'

export type ProjectPackageChatProvenance = {
  threadId: string
  messageId: string
  role: 'user' | 'assistant' | 'tool'
  createdAt: string
  contentDigest: string
}

export type ProjectPackageGenerationLineage = {
  assetId: string
  jobId: string
  providerId: string
  modelId: string
  promptDigest: string
  referenceAssetIds: string[]
  parentAssetId?: string
}

export type ProjectPackageBuildOptions = {
  includeMedia: 'all' | string[]
  missingMediaPolicy: ProjectPackageMissingMediaPolicy
  receipts?: MutationReceipt[]
  chatProvenance?: ProjectPackageChatProvenance[]
  generationLineage?: ProjectPackageGenerationLineage[]
}

export type ProjectPackageMediaRequest = {
  assetId: string
  logicalName: string
  expectedIdentity?: { algorithm: 'sha256'; value: string; sizeBytes?: number }
}

export type ProjectPackageMediaResolution =
  | {
      status: 'available'
      bytes: Uint8Array
      logicalName?: string
      mime?: string
    }
  | {
      status: 'missing'
      reason: 'offline' | 'revoked' | 'changed' | 'unavailable'
    }

export type ProjectPackageMediaResolver = (
  request: ProjectPackageMediaRequest,
  signal: AbortSignal
) => Promise<ProjectPackageMediaResolution>

export type ProjectPackageMediaManifestEntry = {
  assetId: string
  logicalName: string
  kind: MediaAsset['kind']
  selection: 'embedded' | 'not-selected'
  status: 'embedded' | 'external' | 'missing'
  objectId?: string
  sha256?: string
  bytes?: number
  mime?: string
  missingReason?: 'offline' | 'revoked' | 'changed' | 'unavailable' | 'identity-mismatch'
}

export type ProjectPackageObject = {
  id: string
  sha256: string
  bytes: number
  mime: string
  dataBase64: string
}

export type SelfContainedProjectPackageBody = {
  schemaVersion: typeof PROJECT_PACKAGE_SCHEMA_VERSION
  packageId: string
  createdAt: string
  complete: boolean
  project: {
    id: string
    schemaVersion: number
    revision: number
    activeSequenceId: string
    sequenceIds: string[]
    snapshotDigest: string
    snapshot: VideoProject
  }
  mediaManifest: ProjectPackageMediaManifestEntry[]
  objects: ProjectPackageObject[]
  provenance: {
    receiptsIncluded: boolean
    chatIncluded: boolean
    receipts: MutationReceipt[]
    chat: ProjectPackageChatProvenance[]
    generationLineage: ProjectPackageGenerationLineage[]
    redactedPathValues: number
  }
  missingMedia: Array<{
    assetId: string
    reason: NonNullable<ProjectPackageMediaManifestEntry['missingReason']>
  }>
}

export type SelfContainedProjectPackage = SelfContainedProjectPackageBody & {
  integrity: {
    algorithm: 'sha256'
    value: string
  }
}

export type BuiltProjectPackage = {
  package: SelfContainedProjectPackage
  bytes: Uint8Array
  digest: string
  complete: boolean
  embeddedAssetCount: number
  uniqueObjectCount: number
  deduplicatedAssetCount: number
  missingAssetIds: string[]
}

export type ProjectPackageJobOwner = {
  extensionId: string
  extensionVersion: string
  workspaceId: string
  projectId: string
  sequenceId: string
  revision: number
  idempotencyKey: string
  targetHandle: string
}

export type ProjectPackageJobState =
  | 'queued'
  | 'building'
  | 'staged'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'failed'

export type ProjectPackageJobRecord = ProjectPackageJobOwner & {
  jobId: string
  attempt: number
  generation: number
  state: ProjectPackageJobState
  progress: number
  packageDigest?: string
  stagingId?: string
  completedDigest?: string
  errorCode?: string
}

export type AtomicPackageTransaction = {
  stagingId: string
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>
  commit(signal: AbortSignal): Promise<void>
  rollback(reason: string): Promise<void>
}

export type AtomicPackageSink = {
  begin(request: {
    targetHandle: string
    jobId: string
    attempt: number
    idempotencyKey: string
    packageDigest: string
    bytes: number
  }): Promise<AtomicPackageTransaction>
  rollbackStaging(stagingId: string, reason: string): Promise<void>
  committedDigest?(request: {
    targetHandle: string
    jobId: string
    idempotencyKey: string
  }): Promise<string | undefined>
}

export type StagedProjectPackageExport = {
  record: ProjectPackageJobRecord
  transaction: AtomicPackageTransaction
  built: BuiltProjectPackage
}

export async function buildSelfContainedProjectPackage(
  project: VideoProject,
  options: ProjectPackageBuildOptions,
  resolveMedia: ProjectPackageMediaResolver,
  signal: AbortSignal = new AbortController().signal
): Promise<BuiltProjectPackage> {
  assertNotCancelled(signal)
  const validated = validateProjectRoundTrip(project)
  validateBuildOptions(validated, options)
  const sanitized = sanitizeProject(validated)
  const selected = options.includeMedia === 'all'
    ? new Set(validated.assets.map(({ id }) => id))
    : new Set(options.includeMedia)
  const objectsByDigest = new Map<string, ProjectPackageObject>()
  const mediaManifest: ProjectPackageMediaManifestEntry[] = []
  const missingMedia: SelfContainedProjectPackageBody['missingMedia'] = []
  let totalMediaBytes = 0
  for (const asset of validated.assets.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    assertNotCancelled(signal)
    const logicalName = safeLogicalName(asset.name, asset.id)
    if (!selected.has(asset.id)) {
      mediaManifest.push({
        assetId: asset.id,
        logicalName,
        kind: asset.kind,
        selection: 'not-selected',
        status: 'external'
      })
      continue
    }
    const resolution = await resolveMedia({
      assetId: asset.id,
      logicalName,
      ...(asset.sourceIdentity ? {
        expectedIdentity: {
          algorithm: 'sha256',
          value: asset.sourceIdentity.value,
          ...(asset.sourceIdentity.sizeBytes === undefined ? {} : { sizeBytes: asset.sourceIdentity.sizeBytes })
        }
      } : {})
    }, signal)
    assertNotCancelled(signal)
    if (resolution.status === 'missing') {
      handleMissing(asset, logicalName, resolution.reason, options.missingMediaPolicy, mediaManifest, missingMedia)
      continue
    }
    const bytes = Buffer.from(resolution.bytes)
    if (bytes.byteLength <= 0 || bytes.byteLength > PROJECT_PACKAGE_LIMITS.mediaObjectBytes) {
      invalid(`Media ${asset.id} has an empty or oversized package payload`)
    }
    totalMediaBytes += bytes.byteLength
    if (totalMediaBytes > PROJECT_PACKAGE_LIMITS.totalMediaBytes) invalid('Selected media exceeds the project-package byte limit')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (
      asset.sourceIdentity?.algorithm === 'sha256' &&
      asset.sourceIdentity.value.toLowerCase() !== sha256
    ) {
      handleMissing(asset, logicalName, 'identity-mismatch', options.missingMediaPolicy, mediaManifest, missingMedia)
      continue
    }
    const objectId = `sha256-${sha256}`
    const mime = safeMime(resolution.mime, asset.kind)
    if (!objectsByDigest.has(sha256)) {
      objectsByDigest.set(sha256, {
        id: objectId,
        sha256,
        bytes: bytes.byteLength,
        mime,
        dataBase64: bytes.toString('base64')
      })
    }
    mediaManifest.push({
      assetId: asset.id,
      logicalName: safeLogicalName(resolution.logicalName ?? logicalName, asset.id),
      kind: asset.kind,
      selection: 'embedded',
      status: 'embedded',
      objectId,
      sha256,
      bytes: bytes.byteLength,
      mime
    })
  }
  const parsedReceipts = (options.receipts ?? [])
    .map((receipt) => MutationReceiptSchema.parse(receipt))
  const sanitizedReceipts = sanitizeMetadata(parsedReceipts)
  const receipts = (sanitizedReceipts.value as MutationReceipt[])
    .sort((left, right) => left.newRevision - right.newRevision || left.transactionId.localeCompare(right.transactionId))
  const chat = (options.chatProvenance ?? [])
    .map(validateChatProvenance)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId))
  const lineage = (options.generationLineage ?? [])
    .map(validateGenerationLineage)
    .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.jobId.localeCompare(right.jobId))
  const sanitizedProject = sanitizeMetadata(sanitized)
  const projectSnapshot = validateProjectRoundTrip(VideoProjectSchema.parse(sanitizedProject.value))
  const snapshotDigest = canonicalDigest(projectSnapshot)
  const objects = [...objectsByDigest.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
  const complete = missingMedia.length === 0
  const bodyWithoutId = {
    schemaVersion: PROJECT_PACKAGE_SCHEMA_VERSION,
    createdAt: validated.updatedAt,
    complete,
    project: {
      id: validated.id,
      schemaVersion: validated.schemaVersion,
      revision: validated.currentRevision,
      activeSequenceId: validated.activeSequenceId,
      sequenceIds: validated.sequences.map(({ id }) => id).sort(),
      snapshotDigest,
      snapshot: projectSnapshot
    },
    mediaManifest,
    objects,
    provenance: {
      receiptsIncluded: options.receipts !== undefined,
      chatIncluded: options.chatProvenance !== undefined,
      receipts,
      chat,
      generationLineage: lineage,
      redactedPathValues: sanitizedReceipts.redacted + sanitizedProject.redacted
    },
    missingMedia
  }
  const packageId = `pkg-${canonicalDigest(bodyWithoutId).slice(0, 32)}`
  const body: SelfContainedProjectPackageBody = { ...bodyWithoutId, packageId }
  assertPackageMetadataSafe(body)
  const integrityValue = canonicalDigest(body)
  const packageValue: SelfContainedProjectPackage = {
    ...body,
    integrity: { algorithm: 'sha256', value: integrityValue }
  }
  const bytes = Buffer.from(`${stableStringify(packageValue)}\n`, 'utf8')
  if (bytes.byteLength > PROJECT_PACKAGE_LIMITS.packageBytes) invalid('Project package exceeds its byte limit')
  return {
    package: packageValue,
    bytes,
    digest: integrityValue,
    complete,
    embeddedAssetCount: mediaManifest.filter(({ status }) => status === 'embedded').length,
    uniqueObjectCount: objects.length,
    deduplicatedAssetCount: mediaManifest.filter(({ status }) => status === 'embedded').length - objects.length,
    missingAssetIds: missingMedia.map(({ assetId }) => assetId)
  }
}

export function parseSelfContainedProjectPackage(value: Uint8Array | string | unknown): SelfContainedProjectPackage {
  const parsed = value instanceof Uint8Array || typeof value === 'string'
    ? JSON.parse(Buffer.from(value).toString('utf8')) as unknown
    : structuredClone(value)
  const packageValue = record(parsed, 'project package') as SelfContainedProjectPackage
  if (packageValue.schemaVersion !== PROJECT_PACKAGE_SCHEMA_VERSION) invalid('Unsupported project-package schema version')
  const integrity = record(packageValue.integrity, 'project package integrity')
  if (integrity.algorithm !== 'sha256' || typeof integrity.value !== 'string') invalid('Project-package integrity is invalid')
  const { integrity: _integrity, ...body } = packageValue
  if (canonicalDigest(body) !== integrity.value) invalid('Project-package integrity check failed')
  if (packageValue.project.snapshotDigest !== canonicalDigest(packageValue.project.snapshot)) {
    invalid('Project-package snapshot digest check failed')
  }
  validateProjectRoundTrip(VideoProjectSchema.parse(packageValue.project.snapshot))
  if (!Array.isArray(packageValue.objects) || !Array.isArray(packageValue.mediaManifest)) invalid('Project-package manifests are invalid')
  const objectIds = new Set<string>()
  for (const objectValue of packageValue.objects) {
    const bytes = Buffer.from(objectValue.dataBase64, 'base64')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== objectValue.sha256 || bytes.byteLength !== objectValue.bytes || objectValue.id !== `sha256-${sha256}`) {
      invalid(`Project-package media object ${objectValue.id} failed integrity validation`)
    }
    if (objectIds.has(objectValue.id)) invalid(`Duplicate project-package media object ${objectValue.id}`)
    objectIds.add(objectValue.id)
  }
  for (const entry of packageValue.mediaManifest) {
    if (entry.status === 'embedded' && (!entry.objectId || !objectIds.has(entry.objectId))) {
      invalid(`Project-package media ${entry.assetId} refers to a missing object`)
    }
  }
  assertPackageMetadataSafe(body as SelfContainedProjectPackageBody)
  return packageValue
}

export function createProjectPackageJob(owner: ProjectPackageJobOwner): ProjectPackageJobRecord {
  validateOwner(owner)
  const jobId = `package-${canonicalDigest(owner).slice(0, 32)}`
  return { ...structuredClone(owner), jobId, attempt: 1, generation: 0, state: 'queued', progress: 0 }
}

export async function stageProjectPackageExport(
  record: ProjectPackageJobRecord,
  built: BuiltProjectPackage,
  sink: AtomicPackageSink,
  signal: AbortSignal
): Promise<StagedProjectPackageExport> {
  assertJobState(record, ['queued', 'interrupted'])
  assertNotCancelled(signal)
  const transaction = await sink.begin({
    targetHandle: record.targetHandle,
    jobId: record.jobId,
    attempt: record.attempt,
    idempotencyKey: record.idempotencyKey,
    packageDigest: built.digest,
    bytes: built.bytes.byteLength
  })
  try {
    await transaction.write(built.bytes, signal)
    assertNotCancelled(signal)
  } catch (error) {
    await transaction.rollback(isCancellation(error, signal) ? 'cancelled' : 'stage-failed')
    throw error
  }
  return {
    record: {
      ...record,
      generation: record.generation + 1,
      state: 'staged',
      progress: 0.9,
      packageDigest: built.digest,
      stagingId: transaction.stagingId,
      errorCode: undefined
    },
    transaction,
    built
  }
}

export async function commitStagedProjectPackageExport(
  staged: StagedProjectPackageExport,
  signal: AbortSignal
): Promise<ProjectPackageJobRecord> {
  assertJobState(staged.record, ['staged'])
  try {
    assertNotCancelled(signal)
    await staged.transaction.commit(signal)
    assertNotCancelled(signal)
    return {
      ...staged.record,
      generation: staged.record.generation + 1,
      state: 'completed',
      progress: 1,
      completedDigest: staged.built.digest,
      stagingId: undefined,
      errorCode: undefined
    }
  } catch (error) {
    const cancelled = isCancellation(error, signal)
    await staged.transaction.rollback(cancelled ? 'cancelled' : 'commit-failed')
    return {
      ...staged.record,
      generation: staged.record.generation + 1,
      state: cancelled ? 'cancelled' : 'failed',
      progress: 0,
      stagingId: undefined,
      errorCode: cancelled ? 'cancelled' : 'commit-failed'
    }
  }
}

export async function reconcileInterruptedProjectPackageJob(
  record: ProjectPackageJobRecord,
  sink: AtomicPackageSink
): Promise<ProjectPackageJobRecord> {
  if (record.state === 'completed' || record.state === 'cancelled' || record.state === 'failed') return structuredClone(record)
  const committedDigest = await sink.committedDigest?.({
    targetHandle: record.targetHandle,
    jobId: record.jobId,
    idempotencyKey: record.idempotencyKey
  })
  if (committedDigest && record.packageDigest === committedDigest) {
    return {
      ...record,
      generation: record.generation + 1,
      state: 'completed',
      progress: 1,
      completedDigest: committedDigest,
      stagingId: undefined,
      errorCode: undefined
    }
  }
  if (record.stagingId) await sink.rollbackStaging(record.stagingId, 'process-restart')
  return {
    ...record,
    generation: record.generation + 1,
    state: 'interrupted',
    progress: 0,
    stagingId: undefined,
    errorCode: 'process-interrupted-by-restart'
  }
}

export function retryInterruptedProjectPackageJob(record: ProjectPackageJobRecord): ProjectPackageJobRecord {
  assertJobState(record, ['interrupted', 'failed', 'cancelled'])
  return {
    ...record,
    attempt: record.attempt + 1,
    generation: record.generation + 1,
    state: 'queued',
    progress: 0,
    packageDigest: undefined,
    stagingId: undefined,
    completedDigest: undefined,
    errorCode: undefined
  }
}
