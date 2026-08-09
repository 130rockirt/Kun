import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { JobErrorSchema, JobProgressSchema, JobResultSchema } from '@kun/extension-api'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { JsonValue } from '../extensions/types.js'
import { ExtensionJobStore } from './extension-job-store.js'
import { ExtensionJobSubscription } from './extension-job-subscription.js'
import {
  EXTENSION_JOB_SCHEMA_VERSION,
  isExtensionJobTerminal,
  type ExtensionJobCaller,
  type ExtensionJobCheckpoint,
  type ExtensionJobErrorData,
  type ExtensionJobFilter,
  type ExtensionJobOwner,
  type ExtensionJobPage,
  type ExtensionJobProgress,
  type ExtensionJobResult,
  type ExtensionJobSnapshot,
  type StoredExtensionJob
} from './extension-job-types.js'
import { installServiceOperations } from './service-operation-install.js'
import { extensionJobServiceApiOperations } from './extension-job-service-api-operations.js'
import { extensionJobServiceLifecycleFencingOperations } from './extension-job-service-lifecycle-fencing-operations.js'
import { extensionJobServiceExecutionOperations } from './extension-job-service-execution-operations.js'
import { extensionJobServiceCancellationOperations } from './extension-job-service-cancellation-operations.js'
import { extensionJobServiceAdmissionOperations } from './extension-job-service-admission-operations.js'
import type { ExtensionJobServiceOperations } from './extension-job-service-operations-contract.js'

export const DEFAULT_EXTENSION_JOB_PROGRESS_INTERVAL_MS = 250
export const DEFAULT_EXTENSION_JOB_CANCELLATION_DEADLINE_MS = 10_000
export const DEFAULT_EXTENSION_JOB_RESULT_BYTES = 256 * 1024
export const DEFAULT_EXTENSION_JOB_ERROR_BYTES = 32 * 1024
export const DEFAULT_EXTENSION_JOB_CHECKPOINT_BYTES = 256 * 1024
export const DEFAULT_EXTENSION_JOB_SUBSCRIBER_EVENTS = 128
export const DEFAULT_EXTENSION_JOB_SUBSCRIBER_BYTES = 512 * 1024

export type ExtensionJobQuotaOptions = {
  maxActiveGlobal?: number
  maxActivePerExtension?: number
  maxActivePerWorkspace?: number
  maxActivePerKind?: number
  maxQueuedPerExtension?: number
  maxStartsPerMinutePerExtension?: number
}

export type ExtensionJobServiceOptions = {
  store: ExtensionJobStore
  now?: () => Date
  createId?: () => string
  quotas?: ExtensionJobQuotaOptions
  progressIntervalMs?: number
  cancellationDeadlineMs?: number
  maxResultBytes?: number
  maxErrorBytes?: number
  maxCheckpointBytes?: number
  maxSubscriberEvents?: number
  maxSubscriberBytes?: number
  authorizeCreate?(input: ExtensionJobCreateInput): void | Promise<void>
  reauthorize?(snapshot: ExtensionJobSnapshot, workspaceRoot: string): boolean | Promise<boolean>
  onDiagnostic?(diagnostic: ExtensionJobDiagnostic): void
}

export type ExtensionJobCreateInput = {
  owner: ExtensionJobOwner
  /** Core-only root used for execution and recovery authorization. */
  workspaceRoot: string
  kind: string
  kindSchemaVersion: number
  initiatingOperation: string
  permissionsSnapshot: readonly string[]
  idempotencyKey?: string
  checkpoint?: ExtensionJobCheckpoint
}

export type ExtensionJobCreateResult = {
  snapshot: ExtensionJobSnapshot
  created: boolean
}

export type ExtensionJobCancelResult = {
  accepted: boolean
  snapshot: ExtensionJobSnapshot
}

export type ExtensionJobExecutionContext = {
  jobId: string
  attempt: number
  workspaceRoot: string
  signal: AbortSignal
  checkpoint?: ExtensionJobCheckpoint
  reportProgress(progress: Omit<ExtensionJobProgress, 'updatedAt'>): Promise<void>
  saveCheckpoint(checkpoint: ExtensionJobCheckpoint): Promise<void>
}

export type ExtensionJobRecoveryDecision = 'resume' | 'restart' | 'interrupt'

export type ExtensionJobRecoveryContext = {
  workspaceRoot: string
}

/** Core-only executor. This is intentionally not exposed through ExtensionContext. */
export type ExtensionJobCoreExecutor = {
  kind: string
  connectionBound?: boolean
  execute(
    snapshot: ExtensionJobSnapshot,
    context: ExtensionJobExecutionContext
  ): Promise<ExtensionJobResult | undefined>
  cancel?(
    snapshot: ExtensionJobSnapshot,
    context: {
      reason: string
      signal: AbortSignal
      workspaceRoot: string
      /** Present only when cancellation is reconciling an orphaned attempt. */
      checkpoint?: ExtensionJobCheckpoint
    }
  ): Promise<void>
  recover?(
    snapshot: ExtensionJobSnapshot,
    checkpoint: ExtensionJobCheckpoint | undefined,
    context: ExtensionJobRecoveryContext
  ): ExtensionJobRecoveryDecision | Promise<ExtensionJobRecoveryDecision>
  /** Reconcile core-private state belonging to an already durable terminal job. */
  recoverTerminal?(
    snapshot: ExtensionJobSnapshot,
    checkpoint: ExtensionJobCheckpoint | undefined,
    context: ExtensionJobRecoveryContext
  ): Promise<void>
  /** Finalize core-private output state after this attempt wins the terminal fence. */
  commitResult?(
    snapshot: ExtensionJobSnapshot,
    result: ExtensionJobResult,
    context: ExtensionJobRecoveryContext
  ): Promise<void>
  /** Roll back durable result metadata when this attempt loses the terminal fence. */
  discardResult?(
    snapshot: ExtensionJobSnapshot,
    result: ExtensionJobResult,
    context: ExtensionJobRecoveryContext
  ): Promise<void>
}

export type ExtensionJobDiagnostic = {
  jobId: string
  ownerExtensionId: string
  kind: string
  state: ExtensionJobSnapshot['state']
  executionAttempt: number
  action: string
  code?: string
}

export type ExtensionJobRecoverySummary = {
  queued: number
  deferred: number
  resumed: number
  cancelled: number
  interrupted: number
}

export type ExtensionJobLifecycleSummary = {
  matched: number
  cancelled: number
  interrupted: number
  alreadyTerminal: number
}

export type ActiveExecution = {
  attempt: number
  workspaceRoot: string
  controller: AbortController
  executor: ExtensionJobCoreExecutor
  promise: Promise<void>
  resultDiscardFailed: boolean
}

export type PendingProgress = {
  attempt: number
  value: ExtensionJobProgress
  timer?: NodeJS.Timeout
}

export class ExtensionJobServiceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'unauthorized'
      | 'quota_exceeded'
      | 'executor_unavailable'
      | 'invalid_transition'
      | 'payload_too_large'
      | 'lifecycle_fenced',
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, JsonValue> = {}
  ) {
    super(message)
    this.name = 'ExtensionJobServiceError'
  }
}

/**
 * Core-owned durable state machine for extension background jobs.
 *
 * Extension code can observe and cancel owned jobs through a broker, but only
 * trusted runtime composition code can register an executor or dispatch work.
 */
export class ExtensionJobService {
  declare private fenceExtension: (extensionId: string, reason: string) => Promise<ExtensionJobLifecycleSummary>
  declare private fenceOwnedJobs: (matches: (snapshot: ExtensionJobSnapshot) => boolean, reason: string) => Promise<ExtensionJobLifecycleSummary>
  declare private revokeSubscriptions: (matches: (subscription: ExtensionJobSubscription) => boolean) => void
  declare private recoverOnStartup: () => Promise<ExtensionJobRecoverySummary>
  declare private isRecoveryAuthorized: (record: StoredExtensionJob) => Promise<boolean>
  declare private canDispatchRecovered: (snapshot: ExtensionJobSnapshot) => Promise<boolean>
  declare private beginExecution: (stored: StoredExtensionJob, executor: ExtensionJobCoreExecutor, recovery: boolean) => Promise<ExtensionJobSnapshot>
  declare private execute: (active: ActiveExecution, snapshot: ExtensionJobSnapshot, checkpoint: ExtensionJobCheckpoint | undefined) => Promise<void>
  declare private discardExecutionResult: (active: ActiveExecution, snapshot: ExtensionJobSnapshot, result: ExtensionJobResult) => Promise<void>
  declare private commitTerminal: (jobId: string, attempt: number, state: 'completed' | 'failed', outcome: { result?: ExtensionJobResult; error?: ExtensionJobErrorData }) => Promise<{ snapshot: ExtensionJobSnapshot; changed: boolean }>
  declare private cancelInternal: (jobId: string, reason: string) => Promise<ExtensionJobSnapshot>
  declare private performCancellation: (jobId: string, reason: string) => Promise<ExtensionJobSnapshot>
  declare private finishRunningCancellation: (snapshot: ExtensionJobSnapshot, reason: string, activeHint?: ActiveExecution) => Promise<ExtensionJobSnapshot>
  declare private persistProgress: (jobId: string, attempt: number, progress: ExtensionJobProgress) => Promise<void>
  declare private flushProgress: (jobId: string) => Promise<void>
  declare private clearProgress: (jobId: string) => void
  declare private assertCreationAllowed: (owner: ExtensionJobOwner) => void
  declare private assertMutationAllowed: (snapshot: ExtensionJobSnapshot) => void
  declare private isSnapshotFenced: (snapshot: ExtensionJobSnapshot) => boolean
  declare private enforceAdmissionQuota: (input: ExtensionJobCreateInput, jobs: ExtensionJobSnapshot[]) => void
  declare private consumeStartRate: (extensionId: string) => void
  declare private diagnostic: (snapshot: ExtensionJobSnapshot, action: string, code?: string) => void
  declare private notFound: () => ExtensionJobServiceError
  declare private serializeAdmission: <T>(operation: () => Promise<T>) => Promise<T>

  private readonly store: ExtensionJobStore
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly progressIntervalMs: number
  private readonly cancellationDeadlineMs: number
  private readonly maxResultBytes: number
  private readonly maxErrorBytes: number
  private readonly maxCheckpointBytes: number
  private readonly maxSubscriberEvents: number
  private readonly maxSubscriberBytes: number
  private readonly quotas: Required<ExtensionJobQuotaOptions>
  private readonly executors = new Map<string, ExtensionJobCoreExecutor>()
  private readonly active = new Map<string, ActiveExecution>()
  private readonly cancellations = new Map<string, Promise<ExtensionJobSnapshot>>()
  private readonly pendingProgress = new Map<string, PendingProgress>()
  private readonly lastProgressAt = new Map<string, number>()
  private readonly extensionFences = new Map<string, string>()
  private readonly workspaceFences = new Map<string, string>()
  private readonly startWindows = new Map<string, number[]>()
  private readonly subscriptions = new Map<string, ExtensionJobSubscription>()
  private readonly unsubscribeStore: () => void
  private admissionOperation: Promise<unknown> = Promise.resolve()
  private recovery?: Promise<ExtensionJobRecoverySummary>
  private shuttingDown = false

  constructor(private readonly options: ExtensionJobServiceOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? (() => `job_${randomUUID()}`)
    this.progressIntervalMs = nonNegativeInteger(
      options.progressIntervalMs,
      DEFAULT_EXTENSION_JOB_PROGRESS_INTERVAL_MS,
      'progressIntervalMs'
    )
    this.cancellationDeadlineMs = positiveInteger(
      options.cancellationDeadlineMs,
      DEFAULT_EXTENSION_JOB_CANCELLATION_DEADLINE_MS,
      'cancellationDeadlineMs'
    )
    this.maxResultBytes = positiveInteger(options.maxResultBytes, DEFAULT_EXTENSION_JOB_RESULT_BYTES, 'maxResultBytes')
    this.maxErrorBytes = positiveInteger(options.maxErrorBytes, DEFAULT_EXTENSION_JOB_ERROR_BYTES, 'maxErrorBytes')
    this.maxCheckpointBytes = positiveInteger(
      options.maxCheckpointBytes,
      DEFAULT_EXTENSION_JOB_CHECKPOINT_BYTES,
      'maxCheckpointBytes'
    )
    this.maxSubscriberEvents = positiveInteger(
      options.maxSubscriberEvents,
      DEFAULT_EXTENSION_JOB_SUBSCRIBER_EVENTS,
      'maxSubscriberEvents'
    )
    this.maxSubscriberBytes = positiveInteger(
      options.maxSubscriberBytes,
      DEFAULT_EXTENSION_JOB_SUBSCRIBER_BYTES,
      'maxSubscriberBytes'
    )
    this.quotas = {
      maxActiveGlobal: positiveInteger(options.quotas?.maxActiveGlobal, 128, 'maxActiveGlobal'),
      maxActivePerExtension: positiveInteger(
        options.quotas?.maxActivePerExtension,
        16,
        'maxActivePerExtension'
      ),
      maxActivePerWorkspace: positiveInteger(
        options.quotas?.maxActivePerWorkspace,
        32,
        'maxActivePerWorkspace'
      ),
      maxActivePerKind: positiveInteger(options.quotas?.maxActivePerKind, 32, 'maxActivePerKind'),
      maxQueuedPerExtension: positiveInteger(
        options.quotas?.maxQueuedPerExtension,
        32,
        'maxQueuedPerExtension'
      ),
      maxStartsPerMinutePerExtension: positiveInteger(
        options.quotas?.maxStartsPerMinutePerExtension,
        120,
        'maxStartsPerMinutePerExtension'
      )
    }
    this.unsubscribeStore = this.store.subscribe((snapshot, event) => {
      for (const subscription of this.subscriptions.values()) {
        if (subscription.jobId === snapshot.id) subscription.offer(snapshot, event)
      }
    })
  }

  get activeCount(): number {
    return this.active.size
  }

  get subscriptionCount(): number {
    return this.subscriptions.size
  }
}

export interface ExtensionJobService extends ExtensionJobServiceOperations {}

installServiceOperations(
  ExtensionJobService.prototype,
  extensionJobServiceApiOperations,
  extensionJobServiceLifecycleFencingOperations,
  extensionJobServiceExecutionOperations,
  extensionJobServiceCancellationOperations,
  extensionJobServiceAdmissionOperations
)


export function validateCreateInput(input: ExtensionJobCreateInput, maxCheckpointBytes: number): void {
  validateBoundedString(input.owner.extensionId, 'owner.extensionId', 255)
  validateBoundedString(input.owner.extensionVersion, 'owner.extensionVersion', 64)
  validateBoundedString(input.owner.workspaceId, 'owner.workspaceId', 256)
  validateBoundedString(input.workspaceRoot, 'workspaceRoot', 4_096)
  if (!isAbsolute(input.workspaceRoot) || containsAsciiControl(input.workspaceRoot)) {
    throw new ExtensionJobServiceError('invalid_request', 'Invalid workspaceRoot', false)
  }
  try {
    if (extensionWorkspaceKey(input.workspaceRoot) !== input.owner.workspaceId) {
      throw new ExtensionJobServiceError(
        'invalid_request',
        'Job workspace identity does not match its trusted root',
        false
      )
    }
  } catch (error) {
    if (error instanceof ExtensionJobServiceError) throw error
    throw new ExtensionJobServiceError('invalid_request', 'Invalid workspaceRoot', false)
  }
  validateBoundedString(input.kind, 'kind', 128)
  validateBoundedString(input.initiatingOperation, 'initiatingOperation', 128)
  if (!Number.isSafeInteger(input.kindSchemaVersion) || input.kindSchemaVersion <= 0) {
    throw new ExtensionJobServiceError('invalid_request', 'Invalid job kind schema version', false)
  }
  if (input.permissionsSnapshot.length > 64 || !input.permissionsSnapshot.every((value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 128)) {
    throw new ExtensionJobServiceError('invalid_request', 'Invalid job permission snapshot', false)
  }
  if (input.idempotencyKey !== undefined) {
    validateBoundedString(input.idempotencyKey, 'idempotencyKey', 128)
  }
  if (input.checkpoint !== undefined) enforceJsonBound(input.checkpoint, maxCheckpointBytes, 'checkpoint')
}

export function validateBoundedString(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ExtensionJobServiceError('invalid_request', `Invalid ${field}`, false)
  }
}

export function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

export function callerOwns(caller: ExtensionJobCaller, snapshot: ExtensionJobSnapshot): boolean {
  return caller.extensionId === snapshot.ownerExtensionId && caller.workspaceIds.includes(snapshot.workspaceId)
}

export function matchesFilter(snapshot: ExtensionJobSnapshot, filter: ExtensionJobFilter): boolean {
  return (filter.states === undefined || filter.states.includes(snapshot.state)) &&
    (filter.kinds === undefined || filter.kinds.includes(snapshot.kind)) &&
    (filter.workspaceId === undefined || filter.workspaceId === snapshot.workspaceId) &&
    (filter.createdAfter === undefined || snapshot.createdAt > filter.createdAfter) &&
    (filter.createdBefore === undefined || snapshot.createdAt < filter.createdBefore)
}

export function encodePageCursor(snapshot: ExtensionJobSnapshot): string {
  return Buffer.from(JSON.stringify({ id: snapshot.id, createdAt: snapshot.createdAt }), 'utf8')
    .toString('base64url')
}

export function decodePageCursor(cursor: string): { id: string; createdAt: string } | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: unknown
      createdAt?: unknown
    }
    return typeof value.id === 'string' && typeof value.createdAt === 'string'
      ? { id: value.id, createdAt: value.createdAt }
      : undefined
  } catch {
    return undefined
  }
}

export function normalizeProgress(
  input: Omit<ExtensionJobProgress, 'updatedAt'>,
  previous: ExtensionJobProgress | undefined,
  now: Date
): ExtensionJobProgress {
  const phase = input.phase === undefined ? previous?.phase : sanitizeText(input.phase, 128)
  const samePhase = phase === previous?.phase
  const total = finitePositive(input.total, 'progress.total')
  let completed = finiteNonNegative(input.completed, 'progress.completed')
  let percentage = finiteRange(input.percentage, 0, 100, 'progress.percentage')
  if (samePhase && previous?.completed !== undefined && completed !== undefined) {
    completed = Math.max(previous.completed, completed)
  }
  if (completed !== undefined && total !== undefined && completed > total) {
    throw new ExtensionJobServiceError(
      'invalid_request',
      'Invalid progress.completed: value exceeds total',
      false
    )
  }
  if (completed !== undefined && total !== undefined && total > 0 && percentage === undefined) {
    percentage = Math.min(100, completed / total * 100)
  }
  if (samePhase && previous?.percentage !== undefined && percentage !== undefined) {
    percentage = Math.max(previous.percentage, percentage)
  }
  return JobProgressSchema.parse({
    ...(phase ? { phase } : {}),
    ...(completed !== undefined ? { completed } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(input.unit ? { unit: sanitizeText(input.unit, 64) } : {}),
    ...(percentage !== undefined ? { percentage } : {}),
    ...(input.message ? { message: sanitizeText(input.message, 1_024) } : {}),
    updatedAt: now.toISOString()
  })
}

export function finiteNonNegative(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) {
    throw new ExtensionJobServiceError('invalid_request', `Invalid ${field}`, false)
  }
  return value
}

export function finitePositive(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    throw new ExtensionJobServiceError('invalid_request', `Invalid ${field}`, false)
  }
  return value
}

export function finiteRange(
  value: number | undefined,
  min: number,
  max: number,
  field: string
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ExtensionJobServiceError('invalid_request', `Invalid ${field}`, false)
  }
  return value
}

export function normalizeResult(result: ExtensionJobResult, maxBytes: number): ExtensionJobResult {
  let normalized: ExtensionJobResult
  try {
    normalized = JobResultSchema.parse(structuredClone(result))
  } catch {
    throw new ExtensionJobServiceError('invalid_request', 'Invalid extension job result', false)
  }
  enforceJsonBound(normalized, maxBytes, 'result')
  return normalized
}

export function normalizeError(error: unknown, maxBytes: number): ExtensionJobErrorData {
  const source = error as {
    code?: unknown
    message?: unknown
    retryable?: unknown
    category?: unknown
    details?: unknown
  }
  const category = isJobErrorCategory(source?.category) ? source.category : undefined
  const details = isPlainRecord(source?.details)
    ? sanitizeJson(source.details) as Record<string, JsonValue>
    : undefined
  const normalized = JobErrorSchema.parse({
    code: normalizeJobErrorCode(typeof source?.code === 'string' ? source.code : 'EXECUTOR_FAILED'),
    message: sanitizeText(
      typeof source?.message === 'string' ? source.message : 'Extension background job failed',
      2_048
    ),
    retryable: source?.retryable === true,
    ...(category ? { category } : {}),
    ...(details ? { details } : {})
  })
  if (jsonBytes(normalized) <= maxBytes) return normalized
  return {
    code: normalized.code,
    message: sanitizeText(normalized.message, Math.max(64, Math.floor(maxBytes / 2))),
    retryable: normalized.retryable,
    details: { truncated: true }
  }
}

export function cancellationError(reason: string): ExtensionJobErrorData {
  return {
    code: 'CANCELLED',
    message: `Extension background job cancelled: ${sanitizeText(reason, 256)}`,
    retryable: true,
    category: 'cancelled'
  }
}

export function interruptionError(code: string, message: string): ExtensionJobErrorData {
  return {
    code: normalizeJobErrorCode(code),
    message: sanitizeText(message, 1_024),
    retryable: true,
    category: 'internal'
  }
}

export function normalizeJobErrorCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+/, '').slice(0, 128)
  if (/^[A-Z][A-Z0-9_]*$/.test(normalized)) return normalized
  return 'EXECUTOR_FAILED'
}

export function isJobErrorCategory(value: unknown): value is NonNullable<ExtensionJobErrorData['category']> {
  return value === 'permission' || value === 'scope' || value === 'quota' ||
    value === 'unavailable' || value === 'cancelled' || value === 'invalid' || value === 'internal'
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sanitizeJson(value: unknown): unknown {
  return walkStrings(redactSecrets(toJsonValue(value)), (text) => sanitizeText(text, 2_048))
}

export function toJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    return JSON.parse(serialized) as JsonValue
  } catch {
    return null
  }
}

export function walkStrings(value: JsonValue, transform: (value: string) => string): JsonValue {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => walkStrings(item, transform))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walkStrings(child, transform)]))
  }
  return value
}

export function sanitizeText(value: string, maxLength: number): string {
  return redactSecretText(value)
    .replace(/kun-media:\/\/[^\s]+/gi, 'kun-media://<redacted>')
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/tmp\/)[^\s,;]+/g, '<redacted-path>')
    .slice(0, maxLength)
}

export function enforceJsonBound(value: unknown, maxBytes: number, field: string): void {
  if (jsonBytes(value) > maxBytes) {
    throw new ExtensionJobServiceError(
      'payload_too_large',
      `Extension job ${field} exceeds its byte limit`,
      false,
      { field, maxBytes }
    )
  }
}

export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function workspaceFenceKey(extensionId: string, workspaceId: string): string {
  return `${extensionId}\0${workspaceId}`
}

export function compareRecoveryPriority(left: StoredExtensionJob, right: StoredExtensionJob): number {
  const priority = (record: StoredExtensionJob) => record.snapshot.cancelRequestedAt !== undefined
    ? 0
    : record.snapshot.state === 'running' ? 1 : 2
  return priority(left) - priority(right) ||
    left.snapshot.createdAt.localeCompare(right.snapshot.createdAt) ||
    left.snapshot.id.localeCompare(right.snapshot.id)
}

export async function runWithDeadline(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${name} must be positive`)
  return normalized
}

export function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`${name} must be non-negative`)
  return normalized
}
