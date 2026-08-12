import { z } from 'zod'

export const PLAN_WORKTREE_RECORD_VERSION = 1 as const
export const PLAN_WORKTREE_MAX_PATH = 4096
export const PLAN_WORKTREE_MAX_TEXT = 16_384
export const PLAN_WORKTREE_MAX_ID = 160
export const PLAN_WORKTREE_MAX_REF = 240
export const PLAN_WORKTREE_MAX_EXECUTION_PROMPT = 262_144

const boundedId = z.string().trim().min(1).max(PLAN_WORKTREE_MAX_ID)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const boundedPath = z.string().trim().min(1).max(PLAN_WORKTREE_MAX_PATH)
  .refine((value) => !value.includes('\0'), 'path must not contain NUL')
const absolutePath = boundedPath.refine(
  (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value),
  'path must be absolute'
)
const relativePath = boundedPath.refine(
  (value) => !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
    && !value.split(/[\\/]/).includes('..'),
  'path must be a contained relative path'
)
const boundedText = z.string().trim().max(PLAN_WORKTREE_MAX_TEXT)
  .refine((value) => !value.includes('\0'), 'text must not contain NUL')
const goalObjective = z.string().trim().min(1).max(4000)
  .refine((value) => !value.includes('\0'), 'goal objective must not contain NUL')
const executionPrompt = z.string().min(1).max(PLAN_WORKTREE_MAX_EXECUTION_PROMPT)
  .refine((value) => !value.includes('\0'), 'execution prompt must not contain NUL')
const executionDisplayText = z.string().trim().min(1).max(16_384)
  .refine((value) => !value.includes('\0'), 'execution display text must not contain NUL')
const boundedRef = z.string().trim().min(1).max(PLAN_WORKTREE_MAX_REF)
  .regex(/^[^~^:?*\\]+$/)
  .refine(
    (value) => Array.from(value).every((character) => character.charCodeAt(0) > 0x20),
    'ref must not contain control characters or spaces'
  )
  .refine((value) => !value.includes('..') && !value.endsWith('.') && !value.endsWith('/'))
const isoDate = z.string().datetime({ offset: true })
const commitOid = z.string().regex(/^[0-9a-f]{40,64}$/i)

export const PlanWorktreeOrchestrationSchema = z.enum(['direct', 'graph'])
export type PlanWorktreeOrchestration = z.infer<typeof PlanWorktreeOrchestrationSchema>

export const PlanWorktreeRunStatusSchema = z.enum([
  'preparing',
  'executing',
  'ready_to_integrate',
  'integrating',
  'needs_attention',
  'cleanup_pending',
  'completed',
  'cancelled'
])
export type PlanWorktreeRunStatus = z.infer<typeof PlanWorktreeRunStatusSchema>

export const PlanWorktreeAttentionReasonSchema = z.enum([
  'git_unavailable',
  'not_git_repository',
  'unborn_head',
  'detached_head',
  'dirty_source_checkout',
  'source_git_operation_in_progress',
  'invalid_branch_prefix',
  'worktree_path_collision',
  'execution_branch_collision',
  'preparation_interrupted',
  'source_checkout_missing',
  'source_branch_changed',
  'source_checkout_dirty',
  'target_ref_missing',
  'target_ref_rewritten',
  'target_moved_during_integration',
  'execution_git_operation_in_progress',
  'rebase_conflict',
  'execution_incomplete',
  'execution_failed',
  'execution_interrupted',
  'pending_approval',
  'pending_user_input',
  'graph_incomplete',
  'thread_attach_failed',
  'turn_admission_failed',
  'thread_rebind_failed',
  'cleanup_failed',
  'unique_work_retained',
  'external_state_changed',
  'record_unreadable'
])
export type PlanWorktreeAttentionReason = z.infer<typeof PlanWorktreeAttentionReasonSchema>

export const PlanWorktreeChangedFileSchema = z.object({
  path: boundedPath,
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
  oldPath: boundedPath.optional()
}).strict()
export type PlanWorktreeChangedFile = z.infer<typeof PlanWorktreeChangedFileSchema>

export const PlanWorktreeChangedFileManifestSchema = z.object({
  capturedAt: isoDate,
  files: z.array(PlanWorktreeChangedFileSchema).max(20_000),
  hasUncommittedChanges: z.boolean(),
  truncated: z.boolean().optional()
}).strict()
export type PlanWorktreeChangedFileManifest = z.infer<typeof PlanWorktreeChangedFileManifestSchema>

export const PlanWorktreeCleanupProgressSchema = z.object({
  threadRebound: z.boolean(),
  worktreeRemoved: z.boolean(),
  branchDeleted: z.boolean(),
  metadataPruned: z.boolean()
}).strict()
export type PlanWorktreeCleanupProgress = z.infer<typeof PlanWorktreeCleanupProgressSchema>

export const PlanWorktreeCleanupIntentSchema = z.enum([
  'integration_completed',
  'safe_cancel',
  'discard_cancelled'
])
export type PlanWorktreeCleanupIntent = z.infer<typeof PlanWorktreeCleanupIntentSchema>

export const PlanWorktreeAdmissionTransitionSchema = z.object({
  operationId: boundedId,
  expectedWorkspace: absolutePath,
  targetWorkspace: absolutePath,
  targetThreadRebound: z.boolean(),
  targetFrozen: z.boolean()
}).strict()
export type PlanWorktreeAdmissionTransition = z.infer<
  typeof PlanWorktreeAdmissionTransitionSchema
>

export const PlanWorktreeRecoverySnapshotSchema = z.object({
  head: commitOid,
  indexTree: commitOid,
  statusSha256: z.string().regex(/^[0-9a-f]{64}$/),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: isoDate
}).strict()
export type PlanWorktreeRecoverySnapshot = z.infer<typeof PlanWorktreeRecoverySnapshotSchema>

export const PlanWorktreeRunRecordSchema = z.object({
  version: z.literal(PLAN_WORKTREE_RECORD_VERSION),
  runId: boundedId,
  operationId: boundedId,
  planId: boundedId,
  planRelativePath: relativePath,
  planTitle: z.string().trim().min(1).max(240),
  goalObjective,
  /** Optional only for fail-closed compatibility with records written before admission recovery. */
  executionPrompt: executionPrompt.optional(),
  executionDisplayText: executionDisplayText.optional(),
  executionPromptSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  admissionClientRequestId: z.string().trim().min(1).max(256).optional(),
  /**
   * Host-only proof for the first execution turn. It is intentionally
   * optional so records written before this admission hardening remain
   * readable, but new unbound records fail closed before turn admission.
   */
  admissionCapability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).optional(),
  sourceThreadId: boundedId,
  executionThreadId: boundedId.optional(),
  executionTurnId: boundedId.optional(),
  graphRunId: boundedId.optional(),
  orchestration: PlanWorktreeOrchestrationSchema,
  sourceWorkspaceRoot: absolutePath,
  sourceCheckoutRoot: absolutePath,
  primaryRepositoryRoot: absolutePath,
  repositoryIdentity: z.string().trim().min(1).max(512),
  targetBranch: boundedRef,
  baseCommit: commitOid,
  executionBranch: boundedRef,
  worktreePath: absolutePath,
  executionWorkspace: absolutePath.optional(),
  admissionFrozen: z.boolean().optional(),
  admissionTransition: PlanWorktreeAdmissionTransitionSchema.optional(),
  status: PlanWorktreeRunStatusSchema,
  attentionReason: PlanWorktreeAttentionReasonSchema.optional(),
  attentionMessage: boundedText.optional(),
  changedFiles: PlanWorktreeChangedFileManifestSchema.optional(),
  executionHead: commitOid.optional(),
  reconciledTargetHead: commitOid.optional(),
  integratedHead: commitOid.optional(),
  completionVerifiedAt: isoDate.optional(),
  recoveryPatchPath: absolutePath.optional(),
  recoverySnapshot: PlanWorktreeRecoverySnapshotSchema.optional(),
  cleanup: PlanWorktreeCleanupProgressSchema,
  cleanupIntent: PlanWorktreeCleanupIntentSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate
}).strict()
export type PlanWorktreeRunRecord = z.infer<typeof PlanWorktreeRunRecordSchema>

export const PlanWorktreePreflightRequestSchema = z.object({
  workspaceRoot: absolutePath,
  branchPrefix: z.string().trim().max(128).optional()
}).strict()
export type PlanWorktreePreflightRequest = z.infer<typeof PlanWorktreePreflightRequestSchema>

export const PlanWorktreePreflightResultSchema = z.object({
  eligible: z.boolean(),
  attentionReason: PlanWorktreeAttentionReasonSchema.optional(),
  message: boundedText.optional(),
  sourceWorkspaceRoot: absolutePath,
  sourceCheckoutRoot: absolutePath.optional(),
  primaryRepositoryRoot: absolutePath.optional(),
  repositoryIdentity: z.string().trim().min(1).max(512).optional(),
  targetBranch: boundedRef.optional(),
  baseCommit: commitOid.optional(),
  sourceIsLinkedWorktree: z.boolean(),
  checkedAt: isoDate
}).strict()
export type PlanWorktreePreflightResult = z.infer<typeof PlanWorktreePreflightResultSchema>

export const PlanWorktreePrepareRequestSchema = z.object({
  operationId: boundedId,
  planId: boundedId,
  planRelativePath: relativePath,
  planTitle: z.string().trim().min(1).max(240),
  goalObjective,
  executionPrompt,
  executionDisplayText,
  sourceThreadId: boundedId,
  sourceWorkspaceRoot: absolutePath,
  orchestration: PlanWorktreeOrchestrationSchema,
  branchPrefix: z.string().trim().max(128).optional()
}).strict()
export type PlanWorktreePrepareRequest = z.infer<typeof PlanWorktreePrepareRequestSchema>

export const PlanWorktreeAttachThreadRequestSchema = z.object({
  runId: boundedId,
  executionThreadId: boundedId,
  executionTurnId: boundedId.optional(),
  graphRunId: boundedId.optional()
}).strict()
export type PlanWorktreeAttachThreadRequest = z.infer<typeof PlanWorktreeAttachThreadRequestSchema>

export const PlanWorktreeRunIdRequestSchema = z.object({ runId: boundedId }).strict()
export type PlanWorktreeRunIdRequest = z.infer<typeof PlanWorktreeRunIdRequestSchema>

export const PlanWorktreeListRequestSchema = z.object({
  includeCompleted: z.boolean().optional(),
  repositoryIdentity: z.string().trim().min(1).max(512).optional()
}).strict()
export type PlanWorktreeListRequest = z.infer<typeof PlanWorktreeListRequestSchema>

export const PlanWorktreeSafeCancelRequestSchema = z.object({
  runId: boundedId,
  confirmedDiscard: z.literal(false).optional()
}).strict()
export type PlanWorktreeSafeCancelRequest = z.infer<typeof PlanWorktreeSafeCancelRequestSchema>

export const PlanWorktreeDiscardRequestSchema = z.object({
  runId: boundedId,
  confirmedDiscard: z.literal(true)
}).strict()
export type PlanWorktreeDiscardRequest = z.infer<typeof PlanWorktreeDiscardRequestSchema>

export const PlanWorktreeCompletionSnapshotSchema = z.object({
  executionTurnId: boundedId,
  turnStatus: z.enum(['running', 'completed', 'failed', 'interrupted', 'cancelled']),
  goalStatus: z.enum(['active', 'complete', 'blocked', 'missing']),
  hasLaterRunningTurn: z.boolean(),
  hasPendingApproval: z.boolean(),
  hasPendingUserInput: z.boolean(),
  graphStatus: z.enum(['not_applicable', 'running', 'completed', 'failed', 'interrupted']),
  graphHasPendingGate: z.boolean()
}).strict()
export type PlanWorktreeCompletionSnapshot = z.infer<typeof PlanWorktreeCompletionSnapshotSchema>

export const PlanWorktreeFinalizeRequestSchema = z.object({
  runId: boundedId,
  completion: PlanWorktreeCompletionSnapshotSchema
}).strict()
export type PlanWorktreeFinalizeRequest = z.infer<typeof PlanWorktreeFinalizeRequestSchema>

export const PlanWorktreeRunListSchema = z.array(PlanWorktreeRunRecordSchema).max(10_000)
export const PlanWorktreeRecordDiagnosticSchema = z.object({
  fileName: z.string().trim().min(1).max(512),
  message: boundedText
}).strict()
export type PlanWorktreeRecordDiagnostic = z.infer<typeof PlanWorktreeRecordDiagnosticSchema>
export const PlanWorktreeRecordDiagnosticsSchema = z.array(PlanWorktreeRecordDiagnosticSchema)
  .max(10_000)

export type PlanWorktreeApi = {
  preflight: (input: PlanWorktreePreflightRequest) => Promise<PlanWorktreePreflightResult>
  prepare: (input: PlanWorktreePrepareRequest) => Promise<PlanWorktreeRunRecord>
  attachThread: (input: PlanWorktreeAttachThreadRequest) => Promise<PlanWorktreeRunRecord>
  list: (input?: PlanWorktreeListRequest) => Promise<PlanWorktreeRunRecord[]>
  diagnostics: () => Promise<PlanWorktreeRecordDiagnostic[]>
  get: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord | null>
  reconcile: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  resumeAdmission: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  finalize: (input: PlanWorktreeFinalizeRequest) => Promise<PlanWorktreeRunRecord>
  retryIntegration: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  continueRebase: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  abortRebase: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  safeCancel: (input: PlanWorktreeSafeCancelRequest) => Promise<PlanWorktreeRunRecord>
  cleanup: (input: PlanWorktreeRunIdRequest) => Promise<PlanWorktreeRunRecord>
  discard: (input: PlanWorktreeDiscardRequest) => Promise<PlanWorktreeRunRecord>
}
