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

export const extensionJobServiceCancellationOperations = {
async cancelInternal(this: ExtensionJobService, jobId: string, reason: string): Promise<ExtensionJobSnapshot> {
    const existingTask = this['cancellations'].get(jobId)
    if (existingTask !== undefined) return existingTask
    const task = this['performCancellation'](jobId, reason).finally(() => {
      if (this['cancellations'].get(jobId) === task) this['cancellations'].delete(jobId)
    })
    this['cancellations'].set(jobId, task)
    return task
  },

async performCancellation(this: ExtensionJobService, jobId: string, reason: string): Promise<ExtensionJobSnapshot> {
    // Keep a reference even if the active map's finally-handler wins the race
    // while the durable cancellation intent is being written.
    const active = this['active'].get(jobId)
    const now = this['now']().toISOString()
    const commit = await this['store'].mutate(jobId, (record) => {
      if (isExtensionJobTerminal(record.snapshot.state)) return undefined
      if (record.snapshot.cancelRequestedAt !== undefined) return undefined
      const queued = record.snapshot.state === 'queued'
      const snapshot: ExtensionJobSnapshot = {
        ...record.snapshot,
        cancelRequestedAt: now,
        updatedAt: now,
        ...(queued ? {
          state: 'cancelled' as const,
          terminalAt: now,
          error: cancellationError(reason)
        } : {})
      }
      return {
        snapshot,
        cancellationReason: sanitizeText(reason, 256),
        event: queued
          ? { type: 'cancelled', error: cancellationError(reason) }
          : { type: 'cancellation-requested' }
      }
    })
    if (commit === undefined) throw this['notFound']()
    if (!commit.changed) {
      const current = commit.snapshot
      if (!isExtensionJobTerminal(current.state) && current.cancelRequestedAt !== undefined) {
        return this['finishRunningCancellation'](current, reason, active)
      }
      return current
    }
    if (commit.snapshot.state === 'cancelled') {
      this['clearProgress'](jobId)
      this['diagnostic'](commit.snapshot, 'cancelled', 'cancelled')
      return commit.snapshot
    }
    return this['finishRunningCancellation'](commit.snapshot, reason, active)
  },

async finishRunningCancellation(this: ExtensionJobService,
    snapshot: ExtensionJobSnapshot,
    reason: string,
    activeHint?: ActiveExecution
  ): Promise<ExtensionJobSnapshot> {
    const active = activeHint?.attempt === snapshot.executionAttempt
      ? activeHint
      : this['active'].get(snapshot.id)
    const stored = active === undefined ? await this['store'].getStored(snapshot.id) : undefined
    const workspaceRoot = active?.workspaceRoot ?? stored?.workspaceRoot
    if (workspaceRoot === undefined) throw this['notFound']()
    active?.controller.abort(new Error('Extension job cancelled'))
    const executor = active?.executor ?? this['executors'].get(snapshot.kind)
    const cleanupTasks: Promise<void>[] = []
    if (active !== undefined) cleanupTasks.push(active.promise)
    const cleanupController = new AbortController()
    let cleanupTimer: NodeJS.Timeout | undefined
    if (executor?.cancel !== undefined) {
      cleanupTimer = setTimeout(() => cleanupController.abort(
        new Error('Cancellation cleanup deadline exceeded')),
        this['cancellationDeadlineMs'])
      cleanupTimer.unref?.()
      cleanupTasks.push(Promise.resolve().then(() => executor.cancel!(snapshot, {
        reason: sanitizeText(reason, 256),
        signal: cleanupController.signal,
        workspaceRoot,
        ...(stored?.checkpoint ? { checkpoint: structuredClone(stored.checkpoint) } : {})
      })))
    }
    let cleanupFailed = cleanupTasks.length === 0
    const cleanupOperation = Promise.all(cleanupTasks.map(async (task) => {
      try {
        await task
      } catch {
        cleanupFailed = true
      }
    })).then(() => {
      if (active?.resultDiscardFailed) cleanupFailed = true
    })
    let cleanupComplete = false
    try {
      cleanupComplete = cleanupTasks.length > 0 &&
        await runWithDeadline(cleanupOperation, this['cancellationDeadlineMs']) &&
        !cleanupFailed
    } finally {
      if (!cleanupComplete && !cleanupController.signal.aborted) {
        cleanupController.abort(new Error('Cancellation cleanup deadline exceeded'))
      }
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
    }
    await this['flushProgress'](snapshot.id)
    const now = this['now']().toISOString()
    const state = cleanupComplete ? 'cancelled' as const : 'interrupted' as const
    const error = cleanupComplete
      ? cancellationError(reason)
      : interruptionError('cancellation_cleanup_incomplete', 'Cancellation cleanup did not finish safely')
    const commit = await this['store'].mutate(snapshot.id, (record) => {
      if (isExtensionJobTerminal(record.snapshot.state)) return undefined
      const next: ExtensionJobSnapshot = {
        ...record.snapshot,
        state,
        updatedAt: now,
        terminalAt: now,
        error
      }
      delete next.result
      return { snapshot: next, event: { type: state, error } }
    })
    this['clearProgress'](snapshot.id)
    const terminal = commit?.snapshot ?? await this['store'].get(snapshot.id)
    if (terminal === undefined) throw this['notFound']()
    this['diagnostic'](terminal, state, error.code)
    return terminal
  },

async persistProgress(this: ExtensionJobService,
    jobId: string,
    attempt: number,
    progress: ExtensionJobProgress
  ): Promise<void> {
    const commit = await this['store'].mutate(jobId, (record) => {
      if (
        record.snapshot.state !== 'running' ||
        record.snapshot.executionAttempt !== attempt ||
        record.snapshot.cancelRequestedAt !== undefined ||
        this['isSnapshotFenced'](record.snapshot)
      ) return undefined
      return {
        snapshot: { ...record.snapshot, updatedAt: progress.updatedAt, progress },
        event: { type: 'progress', progress }
      }
    })
    if (commit?.changed) this['lastProgressAt'].set(jobId, this['now']().getTime())
  },

async flushProgress(this: ExtensionJobService, jobId: string): Promise<void> {
    const pending = this['pendingProgress'].get(jobId)
    if (pending === undefined) return
    this['pendingProgress'].delete(jobId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    await this['persistProgress'](jobId, pending.attempt, pending.value)
  },

clearProgress(this: ExtensionJobService, jobId: string): void {
    const pending = this['pendingProgress'].get(jobId)
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    this['pendingProgress'].delete(jobId)
    this['lastProgressAt'].delete(jobId)
  },
}
