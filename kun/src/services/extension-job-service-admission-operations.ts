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

export const extensionJobServiceAdmissionOperations = {
assertCreationAllowed(this: ExtensionJobService, owner: ExtensionJobOwner): void {
    if (this['shuttingDown']) {
      throw new ExtensionJobServiceError('lifecycle_fenced', 'Runtime is shutting down', true)
    }
    const reason = this['extensionFences'].get(owner.extensionId) ??
      this['workspaceFences'].get(workspaceFenceKey(owner.extensionId, owner.workspaceId))
    if (reason !== undefined) {
      throw new ExtensionJobServiceError(
        'lifecycle_fenced',
        'Extension background jobs are fenced by lifecycle policy',
        true,
        { reason }
      )
    }
  },

assertMutationAllowed(this: ExtensionJobService, snapshot: ExtensionJobSnapshot): void {
    if (this['shuttingDown'] || this['isSnapshotFenced'](snapshot)) {
      throw new ExtensionJobServiceError(
        'lifecycle_fenced',
        'Extension background job mutations are fenced by lifecycle policy',
        true
      )
    }
  },

isSnapshotFenced(this: ExtensionJobService, snapshot: ExtensionJobSnapshot): boolean {
    return this['extensionFences'].has(snapshot.ownerExtensionId) ||
      this['workspaceFences'].has(workspaceFenceKey(snapshot.ownerExtensionId, snapshot.workspaceId))
  },

enforceAdmissionQuota(this: ExtensionJobService, input: ExtensionJobCreateInput, jobs: ExtensionJobSnapshot[]): void {
    const active = jobs.filter((job) => !isExtensionJobTerminal(job.state))
    const queuedForOwner = active.filter((job) =>
      job.state === 'queued' && job.ownerExtensionId === input.owner.extensionId).length
    const limits: Array<[boolean, string]> = [
      [active.length >= this['quotas'].maxActiveGlobal, 'global_active'],
      [active.filter((job) => job.ownerExtensionId === input.owner.extensionId).length >=
        this['quotas'].maxActivePerExtension, 'extension_active'],
      [active.filter((job) => job.workspaceId === input.owner.workspaceId).length >=
        this['quotas'].maxActivePerWorkspace, 'workspace_active'],
      [active.filter((job) => job.kind === input.kind).length >= this['quotas'].maxActivePerKind, 'kind_active'],
      [queuedForOwner >= this['quotas'].maxQueuedPerExtension, 'extension_queued']
    ]
    const exceeded = limits.find(([condition]) => condition)?.[1]
    if (exceeded !== undefined) {
      throw new ExtensionJobServiceError(
        'quota_exceeded',
        'Extension background job quota exceeded',
        true,
        { quota: exceeded }
      )
    }
  },

consumeStartRate(this: ExtensionJobService, extensionId: string): void {
    const now = this['now']().getTime()
    const recent = (this['startWindows'].get(extensionId) ?? []).filter((value) => now - value < 60_000)
    if (recent.length >= this['quotas'].maxStartsPerMinutePerExtension) {
      throw new ExtensionJobServiceError(
        'quota_exceeded',
        'Extension background job start rate exceeded',
        true,
        { quota: 'extension_start_rate' }
      )
    }
    recent.push(now)
    this['startWindows'].set(extensionId, recent)
  },

diagnostic(this: ExtensionJobService, snapshot: ExtensionJobSnapshot, action: string, code?: string): void {
    this['options'].onDiagnostic?.({
      jobId: snapshot.id,
      ownerExtensionId: snapshot.ownerExtensionId,
      kind: snapshot.kind,
      state: snapshot.state,
      executionAttempt: snapshot.executionAttempt,
      action,
      ...(code ? { code: normalizeJobErrorCode(code) } : {})
    })
  },

notFound(this: ExtensionJobService): ExtensionJobServiceError {
    return new ExtensionJobServiceError('not_found', 'Extension job was not found', false)
  },

serializeAdmission<T>(this: ExtensionJobService, operation: () => Promise<T>): Promise<T> {
    const result = this['admissionOperation'].then(operation, operation)
    this['admissionOperation'] = result.then(() => undefined, () => undefined)
    return result
  },
}
