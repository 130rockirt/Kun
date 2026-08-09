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

export const extensionJobServiceLifecycleFencingOperations = {
async handleExtensionDisabled(this: ExtensionJobService, extensionId: string): Promise<ExtensionJobLifecycleSummary> {
    return this['fenceExtension'](extensionId, 'extension_disabled')
  },

async handleExtensionRollback(this: ExtensionJobService, extensionId: string): Promise<ExtensionJobLifecycleSummary> {
    return this['fenceExtension'](extensionId, 'extension_rollback')
  },

async handleExtensionUninstalled(this: ExtensionJobService, extensionId: string): Promise<ExtensionJobLifecycleSummary> {
    return this['fenceExtension'](extensionId, 'extension_uninstalled')
  },

async handleWorkspaceRevoked(this: ExtensionJobService,
    extensionId: string,
    workspaceId: string
  ): Promise<ExtensionJobLifecycleSummary> {
    this['workspaceFences'].set(workspaceFenceKey(extensionId, workspaceId), 'workspace_revoked')
    this['revokeSubscriptions']((subscription) =>
      subscription.ownerExtensionId === extensionId && subscription.workspaceId === workspaceId)
    return this['fenceOwnedJobs'](
      (snapshot) => snapshot.ownerExtensionId === extensionId && snapshot.workspaceId === workspaceId,
      'workspace_revoked'
    )
  },

async handleExtensionHostCrash(this: ExtensionJobService,
    extensionId: string,
    workspaceIds?: readonly string[]
  ): Promise<ExtensionJobLifecycleSummary> {
    const scopedWorkspaceIds = workspaceIds === undefined ? undefined : new Set(workspaceIds)
    this['revokeSubscriptions']((subscription) =>
      subscription.ownerExtensionId === extensionId &&
      (scopedWorkspaceIds === undefined || scopedWorkspaceIds.has(subscription.workspaceId)))
    return this['fenceOwnedJobs']((snapshot) => {
      if (snapshot.ownerExtensionId !== extensionId) return false
      if (scopedWorkspaceIds !== undefined && !scopedWorkspaceIds.has(snapshot.workspaceId)) return false
      return this['executors'].get(snapshot.kind)?.connectionBound === true
    }, 'extension_host_crash')
  },

async handleRuntimeShutdown(this: ExtensionJobService): Promise<ExtensionJobLifecycleSummary> {
    if (this['shuttingDown']) {
      return { matched: 0, cancelled: 0, interrupted: 0, alreadyTerminal: 0 }
    }
    this['shuttingDown'] = true
    this['revokeSubscriptions'](() => true)
    const summary = await this['fenceOwnedJobs'](() => true, 'runtime_shutdown')
    this['unsubscribeStore']()
    return summary
  },

clearExtensionFence(this: ExtensionJobService, extensionId: string): void {
    this['extensionFences'].delete(extensionId)
  },

clearWorkspaceFence(this: ExtensionJobService, extensionId: string, workspaceId: string): void {
    this['workspaceFences'].delete(workspaceFenceKey(extensionId, workspaceId))
  },

async fenceExtension(this: ExtensionJobService,
    extensionId: string,
    reason: string
  ): Promise<ExtensionJobLifecycleSummary> {
    this['extensionFences'].set(extensionId, reason)
    this['revokeSubscriptions']((subscription) => subscription.ownerExtensionId === extensionId)
    return this['fenceOwnedJobs'](
      (snapshot) => snapshot.ownerExtensionId === extensionId,
      reason
    )
  },

async fenceOwnedJobs(this: ExtensionJobService,
    matches: (snapshot: ExtensionJobSnapshot) => boolean,
    reason: string
  ): Promise<ExtensionJobLifecycleSummary> {
    const snapshots = (await this['store'].list()).filter(matches)
    const summary: ExtensionJobLifecycleSummary = {
      matched: snapshots.length,
      cancelled: 0,
      interrupted: 0,
      alreadyTerminal: 0
    }
    const outcomes = await Promise.all(snapshots.map(async (snapshot) => {
      if (isExtensionJobTerminal(snapshot.state)) {
        return { terminal: snapshot, alreadyTerminal: true }
      }
      return { terminal: await this['cancelInternal'](snapshot.id, reason), alreadyTerminal: false }
    }))
    for (const { terminal, alreadyTerminal } of outcomes) {
      if (alreadyTerminal) {
        summary.alreadyTerminal += 1
        continue
      }
      if (terminal.state === 'cancelled') summary.cancelled += 1
      else if (terminal.state === 'interrupted') summary.interrupted += 1
      else summary.alreadyTerminal += 1
    }
    return summary
  },

revokeSubscriptions(this: ExtensionJobService, matches: (subscription: ExtensionJobSubscription) => boolean): void {
    for (const subscription of [...this['subscriptions'].values()]) {
      if (matches(subscription)) subscription.close()
    }
  },
}
