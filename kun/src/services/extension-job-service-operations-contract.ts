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
import type { DEFAULT_EXTENSION_JOB_PROGRESS_INTERVAL_MS, DEFAULT_EXTENSION_JOB_CANCELLATION_DEADLINE_MS, DEFAULT_EXTENSION_JOB_RESULT_BYTES, DEFAULT_EXTENSION_JOB_ERROR_BYTES, DEFAULT_EXTENSION_JOB_CHECKPOINT_BYTES, DEFAULT_EXTENSION_JOB_SUBSCRIBER_EVENTS, DEFAULT_EXTENSION_JOB_SUBSCRIBER_BYTES, ExtensionJobQuotaOptions, ExtensionJobServiceOptions, ExtensionJobCreateInput, ExtensionJobCreateResult, ExtensionJobCancelResult, ExtensionJobExecutionContext, ExtensionJobRecoveryDecision, ExtensionJobRecoveryContext, ExtensionJobCoreExecutor, ExtensionJobDiagnostic, ExtensionJobRecoverySummary, ExtensionJobLifecycleSummary, ActiveExecution, PendingProgress, ExtensionJobServiceError, validateCreateInput, validateBoundedString, containsAsciiControl, callerOwns, matchesFilter, encodePageCursor, decodePageCursor, normalizeProgress, finiteNonNegative, finitePositive, finiteRange, normalizeResult, normalizeError, cancellationError, interruptionError, normalizeJobErrorCode, isJobErrorCategory, isPlainRecord, sanitizeJson, toJsonValue, walkStrings, sanitizeText, enforceJsonBound, jsonBytes, workspaceFenceKey, compareRecoveryPriority, runWithDeadline, positiveInteger, nonNegativeInteger } from './extension-job-service-core.js'

export interface ExtensionJobServiceOperations {
  registerCoreExecutor(executor: ExtensionJobCoreExecutor): () => void;
  initialize(): Promise<ExtensionJobRecoverySummary>;
  createJob(input: ExtensionJobCreateInput): Promise<ExtensionJobCreateResult>;
  createAndDispatch(input: ExtensionJobCreateInput): Promise<ExtensionJobCreateResult>;
  dispatch(jobId: string): Promise<ExtensionJobSnapshot>;
  getOwned(caller: ExtensionJobCaller, jobId: string): Promise<ExtensionJobSnapshot>;
  listOwned(
    caller: ExtensionJobCaller,
    options?: { filter?: ExtensionJobFilter; cursor?: string; limit?: number }
  ): Promise<ExtensionJobPage>;
  listAll(limit?: number): Promise<ExtensionJobSnapshot[]>;
  cancelAdmin(jobId: string, reason?: string): Promise<ExtensionJobCancelResult>;
  cancel(
    caller: ExtensionJobCaller,
    jobId: string,
    reason?: string
  ): Promise<ExtensionJobCancelResult>;
  subscribe(
    caller: ExtensionJobCaller,
    jobId: string,
    cursor?: string
  ): Promise<ExtensionJobSubscription>;
  unsubscribe(caller: ExtensionJobCaller, subscriptionId: string): boolean;
  reportProgress(
    jobId: string,
    attempt: number,
    input: Omit<ExtensionJobProgress, 'updatedAt'>
  ): Promise<void>;
  saveCheckpoint(
    jobId: string,
    attempt: number,
    checkpoint: ExtensionJobCheckpoint
  ): Promise<void>;
  complete(
    jobId: string,
    attempt: number,
    result?: ExtensionJobResult
  ): Promise<ExtensionJobSnapshot>;
  fail(jobId: string, attempt: number, error: unknown): Promise<ExtensionJobSnapshot>;
  interrupt(
    jobId: string,
    error: ExtensionJobErrorData
  ): Promise<ExtensionJobSnapshot>;
  waitForIdle(jobId: string): Promise<void>;
  handleExtensionDisabled(extensionId: string): Promise<ExtensionJobLifecycleSummary>;
  handleExtensionRollback(extensionId: string): Promise<ExtensionJobLifecycleSummary>;
  handleExtensionUninstalled(extensionId: string): Promise<ExtensionJobLifecycleSummary>;
  handleWorkspaceRevoked(
    extensionId: string,
    workspaceId: string
  ): Promise<ExtensionJobLifecycleSummary>;
  handleExtensionHostCrash(
    extensionId: string,
    workspaceIds?: readonly string[]
  ): Promise<ExtensionJobLifecycleSummary>;
  handleRuntimeShutdown(): Promise<ExtensionJobLifecycleSummary>;
  clearExtensionFence(extensionId: string): void;
  clearWorkspaceFence(extensionId: string, workspaceId: string): void;
}
