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
import { type ExtensionJobService, DEFAULT_EXTENSION_JOB_PROGRESS_INTERVAL_MS, DEFAULT_EXTENSION_JOB_CANCELLATION_DEADLINE_MS, DEFAULT_EXTENSION_JOB_RESULT_BYTES, DEFAULT_EXTENSION_JOB_ERROR_BYTES, DEFAULT_EXTENSION_JOB_CHECKPOINT_BYTES, DEFAULT_EXTENSION_JOB_SUBSCRIBER_EVENTS, DEFAULT_EXTENSION_JOB_SUBSCRIBER_BYTES, type ExtensionJobQuotaOptions, type ExtensionJobServiceOptions, type ExtensionJobCreateInput, type ExtensionJobCreateResult, type ExtensionJobCancelResult, type ExtensionJobExecutionContext, type ExtensionJobRecoveryDecision, type ExtensionJobRecoveryContext, type ExtensionJobCoreExecutor, type ExtensionJobDiagnostic, type ExtensionJobRecoverySummary, type ExtensionJobLifecycleSummary, type ActiveExecution, type PendingProgress, ExtensionJobServiceError, validateCreateInput, validateBoundedString, containsAsciiControl, callerOwns, matchesFilter, encodePageCursor, decodePageCursor, normalizeProgress, finiteNonNegative, finitePositive, finiteRange, normalizeResult, normalizeError, cancellationError, interruptionError, normalizeJobErrorCode, isJobErrorCategory, isPlainRecord, sanitizeJson, toJsonValue, walkStrings, sanitizeText, enforceJsonBound, jsonBytes, workspaceFenceKey, compareRecoveryPriority, runWithDeadline, positiveInteger, nonNegativeInteger } from './extension-job-service-core.js'

export const extensionJobServiceApiOperations = {
registerCoreExecutor(this: ExtensionJobService, executor: ExtensionJobCoreExecutor): () => void {
    validateBoundedString(executor.kind, 'executor.kind', 128)
    if (this['executors'].has(executor.kind)) {
      throw new ExtensionJobServiceError(
        'invalid_request',
        `Core executor is already registered for ${executor.kind}`,
        false
      )
    }
    this['executors'].set(executor.kind, executor)
    return () => {
      if (this['executors'].get(executor.kind) === executor) this['executors'].delete(executor.kind)
    }
  },

async initialize(this: ExtensionJobService): Promise<ExtensionJobRecoverySummary> {
    this['recovery'] ??= this['recoverOnStartup']()
    return this['recovery']
  },

async createJob(this: ExtensionJobService, input: ExtensionJobCreateInput): Promise<ExtensionJobCreateResult> {
    return this['serializeAdmission'](async () => {
      validateCreateInput(input, this['maxCheckpointBytes'])
      this['assertCreationAllowed'](input.owner)
      await this['options'].authorizeCreate?.(structuredClone(input))

      const idempotency = input.idempotencyKey === undefined
        ? undefined
        : { operation: input.initiatingOperation, key: input.idempotencyKey }
      if (idempotency !== undefined) {
        const existing = await this['store'].findIdempotent(input.owner, idempotency)
        if (existing !== undefined) return { snapshot: existing, created: false }
      }

      const jobs = await this['store'].list()
      this['enforceAdmissionQuota'](input, jobs)
      this['consumeStartRate'](input.owner.extensionId)
      const now = this['now']().toISOString()
      const created = await this['store'].create({
        snapshot: {
          schemaVersion: EXTENSION_JOB_SCHEMA_VERSION,
          id: this['createId'](),
          kind: input.kind,
          kindSchemaVersion: input.kindSchemaVersion,
          ownerExtensionId: input.owner.extensionId,
          ownerExtensionVersion: input.owner.extensionVersion,
          workspaceId: input.owner.workspaceId,
          initiatingOperation: input.initiatingOperation,
          state: 'queued',
          executionAttempt: 0,
          createdAt: now,
          updatedAt: now
        },
        workspaceRoot: input.workspaceRoot,
        permissionsSnapshot: input.permissionsSnapshot,
        ...(idempotency ? { idempotency } : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
      })
      this['diagnostic'](created.snapshot, 'created')
      return created
    })
  },

async createAndDispatch(this: ExtensionJobService, input: ExtensionJobCreateInput): Promise<ExtensionJobCreateResult> {
    const created = await this.createJob(input)
    if (created.created) await this.dispatch(created.snapshot.id)
    return created
  },

async dispatch(this: ExtensionJobService, jobId: string): Promise<ExtensionJobSnapshot> {
    const stored = await this['store'].getStored(jobId)
    if (stored === undefined) throw this['notFound']()
    this['assertMutationAllowed'](stored.snapshot)
    const executor = this['executors'].get(stored.snapshot.kind)
    if (executor === undefined) {
      throw new ExtensionJobServiceError(
        'executor_unavailable',
        'No core executor is available for this job kind',
        true,
        { kind: stored.snapshot.kind }
      )
    }
    return this['beginExecution'](stored, executor, false)
  },

async getOwned(this: ExtensionJobService, caller: ExtensionJobCaller, jobId: string): Promise<ExtensionJobSnapshot> {
    const snapshot = await this['store'].get(jobId)
    if (snapshot === undefined || !callerOwns(caller, snapshot)) throw this['notFound']()
    return snapshot
  },

async listOwned(this: ExtensionJobService,
    caller: ExtensionJobCaller,
    options: { filter?: ExtensionJobFilter; cursor?: string; limit?: number } = {}
  ): Promise<ExtensionJobPage> {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
    const filter = options.filter ?? {}
    const all = (await this['store'].list()).filter((snapshot) =>
      callerOwns(caller, snapshot) && matchesFilter(snapshot, filter))
    const marker = options.cursor === undefined ? undefined : decodePageCursor(options.cursor)
    const start = marker === undefined
      ? 0
      : Math.max(0, all.findIndex((snapshot) => snapshot.id === marker.id && snapshot.createdAt === marker.createdAt) + 1)
    const items = all.slice(start, start + limit)
    const hasMore = start + items.length < all.length
    return {
      items,
      page: {
        hasMore,
        ...(hasMore && items.length > 0 ? { nextCursor: encodePageCursor(items[items.length - 1]!) } : {})
      }
    }
  },

/** Runtime-owner view used by authenticated first-party management clients. */
async listAll(this: ExtensionJobService, limit = 100): Promise<ExtensionJobSnapshot[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)))
    return (await this['store'].list()).slice(0, safeLimit)
  },

/** Runtime-owner cancellation; extension ownership is not required here. */
async cancelAdmin(this: ExtensionJobService, jobId: string, reason = 'runtime_owner_request'): Promise<ExtensionJobCancelResult> {
    const snapshot = await this['store'].get(jobId)
    if (snapshot === undefined) throw this['notFound']()
    if (isExtensionJobTerminal(snapshot.state)) return { accepted: false, snapshot }
    this['assertMutationAllowed'](snapshot)
    return { accepted: true, snapshot: await this['cancelInternal'](jobId, reason) }
  },

async cancel(this: ExtensionJobService,
    caller: ExtensionJobCaller,
    jobId: string,
    reason = 'owner_request'
  ): Promise<ExtensionJobCancelResult> {
    const owned = await this.getOwned(caller, jobId)
    if (isExtensionJobTerminal(owned.state)) return { accepted: false, snapshot: owned }
    this['assertMutationAllowed'](owned)
    const snapshot = await this['cancelInternal'](jobId, reason)
    return { accepted: true, snapshot }
  },

async subscribe(this: ExtensionJobService,
    caller: ExtensionJobCaller,
    jobId: string,
    cursor?: string
  ): Promise<ExtensionJobSubscription> {
    const owned = await this.getOwned(caller, jobId)
    this['assertMutationAllowed'](owned)
    const subscription = new ExtensionJobSubscription({
      jobId,
      ownerExtensionId: owned.ownerExtensionId,
      workspaceId: owned.workspaceId,
      maxQueueEvents: this['maxSubscriberEvents'],
      maxQueueBytes: this['maxSubscriberBytes'],
      onClose: (subscriptionId) => this['subscriptions'].delete(subscriptionId)
    })
    this['subscriptions'].set(subscription.subscriptionId, subscription)
    try {
      const replay = await this['store'].replay(jobId, cursor)
      if (replay === undefined || !callerOwns(caller, replay.snapshot)) throw this['notFound']()
      subscription.initialize(replay)
      return subscription
    } catch (error) {
      subscription.close()
      throw error
    }
  },

unsubscribe(this: ExtensionJobService, caller: ExtensionJobCaller, subscriptionId: string): boolean {
    const subscription = this['subscriptions'].get(subscriptionId)
    if (
      subscription === undefined ||
      subscription.ownerExtensionId !== caller.extensionId ||
      !caller.workspaceIds.includes(subscription.workspaceId)
    ) return false
    subscription.close()
    return true
  },

async reportProgress(this: ExtensionJobService,
    jobId: string,
    attempt: number,
    input: Omit<ExtensionJobProgress, 'updatedAt'>
  ): Promise<void> {
    const snapshot = await this['store'].get(jobId)
    if (
      snapshot === undefined ||
      snapshot.state !== 'running' ||
      snapshot.executionAttempt !== attempt ||
      snapshot.cancelRequestedAt !== undefined
    ) return
    const value = normalizeProgress(input, snapshot.progress, this['now']())
    const last = this['lastProgressAt'].get(jobId)
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this['now']().getTime() - last
    if (this['progressIntervalMs'] === 0 || elapsed >= this['progressIntervalMs']) {
      await this['persistProgress'](jobId, attempt, value)
      return
    }
    const existing = this['pendingProgress'].get(jobId)
    if (existing?.timer !== undefined) clearTimeout(existing.timer)
    const pending: PendingProgress = { attempt, value }
    pending.timer = setTimeout(() => {
      if (this['pendingProgress'].get(jobId) !== pending) return
      this['pendingProgress'].delete(jobId)
      void this['persistProgress'](jobId, attempt, pending.value).catch(() => undefined)
    }, Math.max(1, this['progressIntervalMs'] - elapsed))
    pending.timer.unref?.()
    this['pendingProgress'].set(jobId, pending)
  },

async saveCheckpoint(this: ExtensionJobService,
    jobId: string,
    attempt: number,
    checkpoint: ExtensionJobCheckpoint
  ): Promise<void> {
    enforceJsonBound(checkpoint, this['maxCheckpointBytes'], 'checkpoint')
    await this['store'].mutate(jobId, (record) => {
      if (
        record.snapshot.state !== 'running' ||
        record.snapshot.executionAttempt !== attempt ||
        record.snapshot.cancelRequestedAt !== undefined ||
        this['isSnapshotFenced'](record.snapshot)
      ) return undefined
      return { checkpoint }
    })
  },

async complete(this: ExtensionJobService,
    jobId: string,
    attempt: number,
    result: ExtensionJobResult = { schemaVersion: 1, generatedArtifacts: [] }
  ): Promise<ExtensionJobSnapshot> {
    const bounded = normalizeResult(result, this['maxResultBytes'])
    return (await this['commitTerminal'](jobId, attempt, 'completed', { result: bounded })).snapshot
  },

async fail(this: ExtensionJobService, jobId: string, attempt: number, error: unknown): Promise<ExtensionJobSnapshot> {
    return (await this['commitTerminal'](jobId, attempt, 'failed', {
      error: normalizeError(error, this['maxErrorBytes'])
    })).snapshot
  },

async interrupt(this: ExtensionJobService,
    jobId: string,
    error: ExtensionJobErrorData
  ): Promise<ExtensionJobSnapshot> {
    await this['flushProgress'](jobId)
    const bounded = normalizeError(error, this['maxErrorBytes'])
    const now = this['now']().toISOString()
    const commit = await this['store'].mutate(jobId, (record) => {
      if (isExtensionJobTerminal(record.snapshot.state)) return undefined
      const snapshot: ExtensionJobSnapshot = {
        ...record.snapshot,
        state: 'interrupted',
        updatedAt: now,
        terminalAt: now,
        error: bounded
      }
      delete snapshot.result
      return { snapshot, event: { type: 'interrupted', error: bounded } }
    })
    if (commit === undefined) throw this['notFound']()
    this['clearProgress'](jobId)
    this['diagnostic'](commit.snapshot, 'terminal', bounded.code)
    return commit.snapshot
  },

async waitForIdle(this: ExtensionJobService, jobId: string): Promise<void> {
    await this['active'].get(jobId)?.promise
    await this['cancellations'].get(jobId)
  },
}
