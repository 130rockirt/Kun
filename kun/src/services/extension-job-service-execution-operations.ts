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

export const extensionJobServiceExecutionOperations = {
async recoverOnStartup(this: ExtensionJobService): Promise<ExtensionJobRecoverySummary> {
    await this['store'].load()
    const summary: ExtensionJobRecoverySummary = {
      queued: 0,
      deferred: 0,
      resumed: 0,
      cancelled: 0,
      interrupted: 0
    }
    const records = (await this['store'].listStored()).sort(compareRecoveryPriority)
    for (const record of records) {
      const snapshot = record.snapshot
      if (isExtensionJobTerminal(snapshot.state)) {
        const executor = this['executors'].get(snapshot.kind)
        if (executor?.recoverTerminal !== undefined) {
          try {
            await executor.recoverTerminal(snapshot, record.checkpoint, {
              workspaceRoot: record.workspaceRoot
            })
          } catch {
            this['diagnostic'](snapshot, 'result-finalization-incomplete')
          }
        }
        continue
      }
      if (snapshot.cancelRequestedAt !== undefined) {
        const terminal = await this['cancelInternal'](
          snapshot.id,
          record.cancellationReason ?? 'recovered_cancel_intent'
        )
        if (terminal.state === 'cancelled') summary.cancelled += 1
        else summary.interrupted += 1
        continue
      }
      if (await this['isRecoveryAuthorized'](record) === false) {
        await this.interrupt(snapshot.id, interruptionError(
          'JOB_RECOVERY_UNAUTHORIZED',
          'Job owner or workspace is no longer authorized during recovery'
        ))
        summary.interrupted += 1
        continue
      }
      const executor = this['executors'].get(snapshot.kind)
      if (executor === undefined) {
        await this.interrupt(snapshot.id, interruptionError(
          'JOB_RECOVERY_EXECUTOR_UNAVAILABLE',
          'The core executor required to recover this job is unavailable'
        ))
        summary.interrupted += 1
        continue
      }
      if (snapshot.state === 'queued') {
        if (await this['canDispatchRecovered'](snapshot) === false) {
          summary.deferred += 1
          continue
        }
        await this['beginExecution'](record, executor, true)
        summary.queued += 1
        continue
      }
      let decision: ExtensionJobRecoveryDecision = 'interrupt'
      try {
        decision = await executor.recover?.(snapshot, record.checkpoint, {
          workspaceRoot: record.workspaceRoot
        }) ?? 'interrupt'
      } catch {
        decision = 'interrupt'
      }
      if (decision === 'resume' || decision === 'restart') {
        await this['beginExecution'](record, executor, true)
        summary.resumed += 1
      } else {
        await this.interrupt(snapshot.id, interruptionError(
          'JOB_RECOVERY_UNSAFE',
          'The previous execution outcome is unknown and cannot be replayed safely'
        ))
        summary.interrupted += 1
      }
    }
    return summary
  },

async isRecoveryAuthorized(this: ExtensionJobService, record: StoredExtensionJob): Promise<boolean> {
    const snapshot = record.snapshot
    if (this['extensionFences'].has(snapshot.ownerExtensionId)) return false
    if (this['workspaceFences'].has(workspaceFenceKey(snapshot.ownerExtensionId, snapshot.workspaceId))) {
      return false
    }
    try {
      return await this['options'].reauthorize?.(
        structuredClone(snapshot),
        record.workspaceRoot
      ) ?? true
    } catch {
      return false
    }
  },

async canDispatchRecovered(this: ExtensionJobService, snapshot: ExtensionJobSnapshot): Promise<boolean> {
    const running = (await this['store'].list()).filter((job) =>
      job.state === 'running' && this['active'].has(job.id))
    return running.length < this['quotas'].maxActiveGlobal &&
      running.filter((job) => job.ownerExtensionId === snapshot.ownerExtensionId).length <
        this['quotas'].maxActivePerExtension &&
      running.filter((job) => job.workspaceId === snapshot.workspaceId).length <
        this['quotas'].maxActivePerWorkspace &&
      running.filter((job) => job.kind === snapshot.kind).length < this['quotas'].maxActivePerKind
  },

async beginExecution(this: ExtensionJobService,
    stored: StoredExtensionJob,
    executor: ExtensionJobCoreExecutor,
    recovery: boolean
  ): Promise<ExtensionJobSnapshot> {
    if (this['active'].has(stored.snapshot.id)) return this['active'].get(stored.snapshot.id) === undefined
      ? stored.snapshot
      : (await this['store'].get(stored.snapshot.id)) ?? stored.snapshot
    const now = this['now']().toISOString()
    const commit = await this['store'].mutate(stored.snapshot.id, (record) => {
      if (record.snapshot.cancelRequestedAt !== undefined || isExtensionJobTerminal(record.snapshot.state)) {
        return undefined
      }
      if (
        (!recovery && record.snapshot.state !== 'queued') ||
        (recovery && record.snapshot.state !== 'queued' && record.snapshot.state !== 'running')
      ) {
        return undefined
      }
      const snapshot: ExtensionJobSnapshot = {
        ...record.snapshot,
        state: 'running',
        executionAttempt: record.snapshot.executionAttempt + 1,
        startedAt: record.snapshot.startedAt ?? now,
        updatedAt: now
      }
      return {
        snapshot,
        event: { type: recovery ? 'recovery' : 'state' }
      }
    })
    if (commit === undefined) throw this['notFound']()
    if (!commit.changed) return commit.snapshot
    const controller = new AbortController()
    const jobId = commit.snapshot.id
    const active: ActiveExecution = {
      attempt: commit.snapshot.executionAttempt,
      workspaceRoot: stored.workspaceRoot,
      controller,
      executor,
      promise: Promise.resolve(),
      resultDiscardFailed: false
    }
    active.promise = this['execute'](active, commit.snapshot, stored.checkpoint).finally(() => {
      if (this['active'].get(jobId) === active) this['active'].delete(jobId)
    })
    this['active'].set(jobId, active)
    this['diagnostic'](commit.snapshot, recovery ? 'recovered' : 'started')
    return commit.snapshot
  },

async execute(this: ExtensionJobService,
    active: ActiveExecution,
    snapshot: ExtensionJobSnapshot,
    checkpoint: ExtensionJobCheckpoint | undefined
  ): Promise<void> {
    try {
      const result = await active.executor.execute(snapshot, {
        jobId: snapshot.id,
        attempt: active.attempt,
        workspaceRoot: active.workspaceRoot,
        signal: active.controller.signal,
        checkpoint: checkpoint === undefined ? undefined : structuredClone(checkpoint),
        reportProgress: (progress) => this.reportProgress(snapshot.id, active.attempt, progress),
        saveCheckpoint: (next) => this.saveCheckpoint(snapshot.id, active.attempt, next)
      })
      const bounded = normalizeResult(
        result ?? { schemaVersion: 1, generatedArtifacts: [] },
        this['maxResultBytes']
      )
      let completion: { snapshot: ExtensionJobSnapshot; changed: boolean }
      try {
        completion = await this['commitTerminal'](
          snapshot.id,
          active.attempt,
          'completed',
          { result: bounded }
        )
      } catch (error) {
        await this['discardExecutionResult'](active, snapshot, bounded)
        throw error
      }
      if (completion.changed) {
        if (active.executor.commitResult !== undefined) {
          try {
            await active.executor.commitResult(snapshot, bounded, {
              workspaceRoot: active.workspaceRoot
            })
          } catch {
            // The durable completed result and validated target remain valid.
            // A core finalizer may deliberately retain recovery material when
            // its best-effort cleanup cannot finish.
            this['diagnostic'](completion.snapshot, 'result-finalization-incomplete')
          }
        }
      } else if (completion.snapshot.state !== 'completed') {
        await this['discardExecutionResult'](active, snapshot, bounded)
      }
    } catch (error) {
      const current = await this['store'].get(snapshot.id)
      if (current?.cancelRequestedAt !== undefined || isExtensionJobTerminal(current?.state ?? 'interrupted')) return
      await this.fail(snapshot.id, active.attempt, error)
    }
  },

async discardExecutionResult(this: ExtensionJobService,
    active: ActiveExecution,
    snapshot: ExtensionJobSnapshot,
    result: ExtensionJobResult
  ): Promise<void> {
    if (active.executor.discardResult === undefined) {
      if (result.generatedArtifacts.length > 0) active.resultDiscardFailed = true
      return
    }
    try {
      await active.executor.discardResult(snapshot, result, {
        workspaceRoot: active.workspaceRoot
      })
    } catch {
      active.resultDiscardFailed = true
    }
  },

async commitTerminal(this: ExtensionJobService,
    jobId: string,
    attempt: number,
    state: 'completed' | 'failed',
    outcome: { result?: ExtensionJobResult; error?: ExtensionJobErrorData }
  ): Promise<{ snapshot: ExtensionJobSnapshot; changed: boolean }> {
    await this['flushProgress'](jobId)
    const now = this['now']().toISOString()
    const commit = await this['store'].mutate(jobId, (record) => {
      if (
        record.snapshot.state !== 'running' ||
        record.snapshot.executionAttempt !== attempt ||
        record.snapshot.cancelRequestedAt !== undefined ||
        (state === 'completed' && this['isSnapshotFenced'](record.snapshot))
      ) return undefined
      const snapshot: ExtensionJobSnapshot = {
        ...record.snapshot,
        state,
        updatedAt: now,
        terminalAt: now,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {})
      }
      if (state === 'completed') delete snapshot.error
      else delete snapshot.result
      return {
        snapshot,
        event: { type: state, ...outcome }
      }
    })
    if (commit === undefined) throw this['notFound']()
    if (!commit.changed) {
      const current = commit.snapshot
      if (
        !isExtensionJobTerminal(current.state) &&
        current.cancelRequestedAt === undefined &&
        current.executionAttempt === attempt &&
        current.state !== 'running'
      ) {
        throw new ExtensionJobServiceError(
          'invalid_transition',
          `Cannot transition extension job from ${current.state} to ${state}`,
          false
        )
      }
      return { snapshot: current, changed: false }
    }
    this['clearProgress'](jobId)
    this['diagnostic'](commit.snapshot, 'terminal', outcome.error?.code)
    return { snapshot: commit.snapshot, changed: true }
  },
}
