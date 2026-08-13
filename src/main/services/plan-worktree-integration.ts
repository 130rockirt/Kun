import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeCompletionSnapshot,
  PlanWorktreeDiscardRequest,
  PlanWorktreeFinalizeRequest,
  PlanWorktreeRunRecord,
  PlanWorktreeSafeCancelRequest
} from '../../shared/plan-worktree'
import {
  PlanWorktreeDiscardRequestSchema,
  PlanWorktreeFinalizeRequestSchema,
  PlanWorktreeRunIdRequestSchema,
  PlanWorktreeSafeCancelRequestSchema
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import {
  hasGitOperationInProgress,
  pathExists,
  readChangedFileManifest
} from './plan-worktree-git'
import {
  validateManagedWorktreeIdentity,
  validateSourceCheckoutForIntegration
} from './plan-worktree-identity'
import { PlanWorktreeLockManager, PlanWorktreeRunStore } from './plan-worktree-run-store'
import {
  evaluatePlanWorktreeCompletion
} from './plan-worktree-completion-evaluation'
import {
  PlanWorktreeIntegrationRuntime,
  type PlanWorktreeCompletionVerification
} from './plan-worktree-integration-runtime'
import {
  isolatedExecutionWorkspace,
  PlanWorktreeAdmissionFence,
  type SetPlanWorktreeAdmissionFence
} from './plan-worktree-admission-fence'
import { PlanWorktreeCleanup } from './plan-worktree-cleanup'

export { evaluatePlanWorktreeCompletion } from './plan-worktree-completion-evaluation'

export type PlanWorktreeIntegrationOptions = {
  store: PlanWorktreeRunStore
  managedRoot?: string
  recoveryRoot?: string
  now?: () => Date
  rebindThreadWorkspace?: (threadId: string, workspaceRoot: string) => Promise<void>
  setAdmissionFence?: SetPlanWorktreeAdmissionFence
  afterRuntimeFenceTransition?: () => Promise<void>
  verifyCompletion: PlanWorktreeCompletionVerification
  locks?: PlanWorktreeLockManager
  beforeSourceMerge?: (record: PlanWorktreeRunRecord) => Promise<void>
  beforeSourceFastForward?: (record: PlanWorktreeRunRecord) => Promise<void>
  beforeDiscardRemove?: (record: PlanWorktreeRunRecord) => Promise<void>
  beforeExecutionBranchDelete?: (record: PlanWorktreeRunRecord) => Promise<void>
}

export class PlanWorktreeIntegration {
  private readonly store: PlanWorktreeRunStore
  private readonly managedRoot: string
  private readonly recoveryRoot: string
  private readonly now: () => Date
  private readonly completionRuntime: PlanWorktreeIntegrationRuntime
  private readonly admissionFence: PlanWorktreeAdmissionFence
  private readonly cleanupRuntime: PlanWorktreeCleanup
  private readonly beforeSourceMerge?: PlanWorktreeIntegrationOptions['beforeSourceMerge']
  private readonly beforeSourceFastForward?: PlanWorktreeIntegrationOptions['beforeSourceFastForward']
  private readonly locks: PlanWorktreeLockManager

  constructor(options: PlanWorktreeIntegrationOptions) {
    this.store = options.store
    this.managedRoot = resolve(options.managedRoot ?? join(homedir(), '.kun', 'worktrees'))
    this.recoveryRoot = resolve(options.recoveryRoot ?? join(options.store.directory, 'recovery'))
    this.now = options.now ?? (() => new Date())
    this.completionRuntime = new PlanWorktreeIntegrationRuntime(
      options.store,
      options.verifyCompletion,
      () => this.timestamp()
    )
    this.admissionFence = new PlanWorktreeAdmissionFence(
      options.store,
      () => this.timestamp(),
      options.setAdmissionFence,
      options.rebindThreadWorkspace,
      options.afterRuntimeFenceTransition
    )
    this.cleanupRuntime = new PlanWorktreeCleanup({
      store: options.store,
      fence: this.admissionFence,
      managedRoot: this.managedRoot,
      recoveryRoot: this.recoveryRoot,
      timestamp: () => this.timestamp(),
      beforeDiscardRemove: options.beforeDiscardRemove,
      beforeExecutionBranchDelete: options.beforeExecutionBranchDelete
    })
    this.locks = options.locks ?? new PlanWorktreeLockManager()
    this.beforeSourceMerge = options.beforeSourceMerge
    this.beforeSourceFastForward = options.beforeSourceFastForward
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.locks.withLock(key, operation)
  }

  private async withRunAndRepositoryLock<T>(
    runId: string,
    operation: (record: PlanWorktreeRunRecord) => Promise<T>
  ): Promise<T> {
    return this.withLock(`run:${runId}`, async () => {
      const record = await this.requireRun(runId)
      return this.withLock(`repository:${record.repositoryIdentity}`, () => operation(record))
    })
  }

  private async withAdmissionFence(
    record: PlanWorktreeRunRecord,
    operation: (record: PlanWorktreeRunRecord) => Promise<PlanWorktreeRunRecord>
  ): Promise<PlanWorktreeRunRecord> {
    let frozen: PlanWorktreeRunRecord
    try {
      frozen = await this.admissionFence.freeze(record)
    } catch (error) {
      return this.needsAttention(
        record,
        'external_state_changed',
        `Kun could not atomically freeze plan-build admission: ${messageOf(error)}`
      )
    }
    let result: PlanWorktreeRunRecord
    try {
      result = await operation(frozen)
    } catch (error) {
      result = await this.needsAttention(frozen, 'external_state_changed', messageOf(error))
    }
    if (!frozen.executionThreadId || !this.admissionFence.enabled) {
      return this.commitCleanupTerminal(result)
    }
    try {
      const retained = await pathExists(result.worktreePath)
      const workspace = retained
        ? isolatedExecutionWorkspace(result)
        : result.sourceWorkspaceRoot
      const released = await this.admissionFence.release(result, workspace)
      return this.commitCleanupTerminal(released)
    } catch (error) {
      return this.store.save({
        ...result,
        admissionFrozen: true,
        status: result.cleanupIntent ? 'cleanup_pending' : 'needs_attention',
        attentionReason: result.cleanupIntent ? 'cleanup_failed' : 'external_state_changed',
        attentionMessage: `Plan-build admission remains frozen: ${messageOf(error)}`,
        updatedAt: this.timestamp()
      })
    }
  }

  private commitCleanupTerminal(
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeRunRecord> {
    const cleanupComplete = Object.values(record.cleanup).every(Boolean)
    if (!cleanupComplete || !record.cleanupIntent || record.admissionFrozen) {
      return Promise.resolve(record)
    }
    return this.store.save({
      ...record,
      status: record.cleanupIntent === 'integration_completed' ? 'completed' : 'cancelled',
      attentionReason: undefined,
      attentionMessage: undefined,
      updatedAt: this.timestamp()
    })
  }

  async finalize(input: PlanWorktreeFinalizeRequest): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeFinalizeRequestSchema.parse(input)
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status === 'completed' || record.status === 'cancelled') return record
      if (!record.executionThreadId) {
        return this.needsAttention(
          record,
          'thread_attach_failed',
          'The isolated execution thread is not durably attached to this run.'
        )
      }
      if (record.executionTurnId && record.executionTurnId !== request.completion.executionTurnId) {
        return this.needsAttention(
          record,
          'external_state_changed',
          'Completion refers to a different execution turn.'
        )
      }
      const verifiedCompletion = await this.completionRuntime.verifyOrAttention(
        record,
        request.completion
      )
      if (!verifiedCompletion.ok) return verifiedCompletion.record
      if (record.executionTurnId && record.executionTurnId !== verifiedCompletion.snapshot.executionTurnId) {
        return this.needsAttention(
          record,
          'external_state_changed',
          'Runtime completion refers to a different execution turn.'
        )
      }
      const evaluation = evaluatePlanWorktreeCompletion(verifiedCompletion.snapshot, record.orchestration)
      if (!evaluation.eligible) {
        if (
          !verifiedCompletion.snapshot.hasPendingApproval
          && !verifiedCompletion.snapshot.hasPendingUserInput
          && (
            verifiedCompletion.snapshot.turnStatus === 'running'
            || (verifiedCompletion.snapshot.turnStatus === 'completed'
              && verifiedCompletion.snapshot.goalStatus === 'active')
            || (record.orchestration === 'graph'
              && verifiedCompletion.snapshot.turnStatus === 'completed'
              && verifiedCompletion.snapshot.goalStatus === 'complete'
              && verifiedCompletion.snapshot.graphStatus === 'running')
          )
        ) return record
        return this.needsAttention(
          record,
          evaluation.reason ?? 'execution_incomplete',
          evaluation.message ?? 'Execution is not ready to integrate.'
        )
      }
      const ready = await this.store.save({
        ...record,
        executionTurnId: verifiedCompletion.snapshot.executionTurnId,
        status: record.integratedHead ? 'cleanup_pending' : 'ready_to_integrate',
        completionVerifiedAt: this.timestamp(),
        attentionReason: undefined,
        attentionMessage: undefined,
        updatedAt: this.timestamp()
      })
      return this.withAdmissionFence(ready, async (frozen) => {
        if (!frozen.integratedHead) return this.integrateLocked(frozen)
        const cleanupReady = await this.store.save({
          ...frozen,
          cleanupIntent: 'integration_completed',
          updatedAt: this.timestamp()
        })
        return this.cleanupRuntime.provenCleanup(cleanupReady)
      })
    })
  }

  async retryIntegration(runId: string): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status === 'completed' || record.status === 'cancelled') return record
      if (!record.completionVerifiedAt) {
        return this.needsAttention(
          record,
          'execution_incomplete',
          'Structured execution completion has not been verified.'
        )
      }
      const verification = await this.completionRuntime.reverify(record)
      if (!verification.ok) return verification.record
      return this.withAdmissionFence(record, async (frozen) => {
        if (!frozen.integratedHead && frozen.status !== 'cleanup_pending') {
          return this.integrateLocked(frozen)
        }
        const cleanupReady = await this.store.save({
          ...frozen,
          cleanupIntent: frozen.cleanupIntent ?? 'integration_completed',
          updatedAt: this.timestamp()
        })
        return this.resumeCleanupLocked(cleanupReady)
      })
    })
  }

  /** Host-authoritative reconnect recovery; transient runtime failures stay untouched. */
  async reconcileExecution(runId: string): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    const record = await this.requireRun(request.runId)
    if (record.status === 'completed' || record.status === 'cancelled') return record
    if (record.status === 'cleanup_pending' && record.integratedHead) {
      return this.cleanup(request.runId)
    }
    if (!record.executionThreadId || !record.executionTurnId) return record
    if (record.status === 'needs_attention' && ![
      'execution_incomplete', 'execution_failed', 'execution_interrupted',
      'pending_approval', 'pending_user_input', 'graph_incomplete'
    ].includes(record.attentionReason ?? '')) return record
    try {
      const snapshot = await this.completionRuntime.snapshot(record)
      return this.finalize({ runId: record.runId, completion: snapshot })
    } catch {
      // Runtime startup and reconnect are asynchronous. A later global pass
      // retries without turning temporary unavailability into durable failure.
      return record
    }
  }

  private async integrateLocked(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    let current = await this.store.save({
      ...record,
      status: 'integrating',
      attentionReason: undefined,
      attentionMessage: undefined,
      updatedAt: this.timestamp()
    })
    if (!(await this.assertManagedWorktree(current))) return this.requireRun(current.runId)
    let manifest: Awaited<ReturnType<typeof readChangedFileManifest>>
    try {
      if (await hasGitOperationInProgress(current.worktreePath)) {
        return this.needsAttention(
          current,
          'execution_git_operation_in_progress',
          'The execution worktree has an unfinished Git operation.'
        )
      }
      manifest = await readChangedFileManifest(current.worktreePath)
    } catch (error) {
      return this.needsAttention(current, 'external_state_changed', messageOf(error))
    }
    current = await this.store.save({ ...current, changedFiles: manifest, updatedAt: this.timestamp() })
    if (manifest.hasUncommittedChanges) {
      try {
        await runGit(current.worktreePath, ['add', '--all'])
        await runGit(current.worktreePath, [
          '-c', 'user.name=Kun Plan Coordinator',
          '-c', 'user.email=kun-plan@localhost',
          'commit', '-m', `chore(plan): apply ${current.planTitle}`
        ], 60_000)
      } catch (error) {
        return this.needsAttention(current, 'execution_git_operation_in_progress', messageOf(error))
      }
    }
    let executionHead = await this.revParse(current.worktreePath, 'HEAD')
    let targetHead: string
    try {
      targetHead = await this.revParse(
        current.sourceCheckoutRoot,
        `refs/heads/${current.targetBranch}`
      )
    } catch (error) {
      return this.needsAttention(current, 'target_ref_missing', messageOf(error))
    }
    if (!(await this.isAncestor(current.sourceCheckoutRoot, current.baseCommit, targetHead))) {
      return this.needsAttention(
        current,
        'target_ref_rewritten',
        'The captured base commit is no longer an ancestor of the target branch.'
      )
    }
    if (!(await this.isAncestor(current.worktreePath, targetHead, executionHead))) {
      try {
        await runGit(current.worktreePath, ['rebase', current.targetBranch], 120_000)
      } catch (error) {
        return this.needsAttention(current, 'rebase_conflict', messageOf(error))
      }
      executionHead = await this.revParse(current.worktreePath, 'HEAD')
    }
    current = await this.store.save({
      ...current,
      executionHead,
      reconciledTargetHead: targetHead,
      updatedAt: this.timestamp()
    })
    const completion = await this.completionRuntime.reverify(current)
    if (!completion.ok) return completion.record
    const sourceFailure = await validateSourceCheckoutForIntegration(current, targetHead)
    if (sourceFailure) return this.needsAttention(current, sourceFailure.reason, sourceFailure.message)
    await this.beforeSourceMerge?.(current)
    const finalSourceFailure = await validateSourceCheckoutForIntegration(current, targetHead)
    if (finalSourceFailure) {
      return this.needsAttention(current, finalSourceFailure.reason, finalSourceFailure.message)
    }
    const finalExecutionHead = await this.revParse(current.worktreePath, 'HEAD').catch(() => '')
    const finalExecutionRef = await this.revParse(
      current.sourceCheckoutRoot,
      `refs/heads/${current.executionBranch}`
    ).catch(() => '')
    if (finalExecutionHead !== executionHead || finalExecutionRef !== executionHead) {
      return this.needsAttention(
        current,
        'external_state_changed',
        'The execution branch changed after completion verification.'
      )
    }
    await this.beforeSourceFastForward?.(current)
    try {
      await runGit(current.worktreePath, [
        'push', '--porcelain',
        '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack',
        `--force-with-lease=refs/heads/${current.targetBranch}:${targetHead}`,
        current.sourceCheckoutRoot,
        `${executionHead}:refs/heads/${current.targetBranch}`
      ], 60_000)
    } catch (error) {
      return this.needsAttention(current, 'target_moved_during_integration', messageOf(error))
    }
    const integratedHead = await this.revParse(
      current.sourceCheckoutRoot,
      `refs/heads/${current.targetBranch}`
    )
    if (integratedHead !== executionHead) {
      return this.needsAttention(
        current,
        'target_moved_during_integration',
        'The target branch does not equal the verified execution head after fast-forward.'
      )
    }
    if (!(await this.isAncestor(current.sourceCheckoutRoot, executionHead, integratedHead))) {
      return this.needsAttention(
        current,
        'target_moved_during_integration',
        'The execution head is not reachable from the target branch after fast-forward.'
      )
    }
    const postUpdateFailure = await validateSourceCheckoutForIntegration(current, integratedHead)
    if (postUpdateFailure) {
      return this.needsAttention(
        { ...current, executionHead, integratedHead },
        postUpdateFailure.reason,
        postUpdateFailure.message
      )
    }
    current = await this.store.save({
      ...current,
      executionHead,
      integratedHead,
      status: 'cleanup_pending',
      cleanupIntent: 'integration_completed',
      updatedAt: this.timestamp()
    })
    return this.cleanupRuntime.provenCleanup(current)
  }

  async continueRebase(runId: string): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status !== 'needs_attention' || record.attentionReason !== 'rebase_conflict') {
        return this.needsAttention(record, 'external_state_changed', 'No retained rebase conflict can continue.')
      }
      if (!(await this.assertManagedWorktree(record))) return this.requireRun(record.runId)
      try {
        await runGit(record.worktreePath, ['-c', 'core.editor=true', 'rebase', '--continue'], 120_000)
      } catch (error) {
        return this.needsAttention(record, 'rebase_conflict', messageOf(error))
      }
      if (!record.completionVerifiedAt) return record
      const verification = await this.completionRuntime.reverify(record)
      if (!verification.ok) return verification.record
      return this.withAdmissionFence(record, (frozen) => this.integrateLocked(frozen))
    })
  }

  async abortRebase(runId: string): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status !== 'needs_attention' || ![
        'rebase_conflict', 'execution_git_operation_in_progress'
      ].includes(record.attentionReason ?? '')) {
        return this.needsAttention(record, 'external_state_changed', 'No retained rebase can be aborted.')
      }
      if (!(await this.assertManagedWorktree(record))) return this.requireRun(record.runId)
      await runGit(record.worktreePath, ['rebase', '--abort']).catch(() => undefined)
      return this.needsAttention(
        { ...record, completionVerifiedAt: undefined },
        'execution_incomplete',
        'The isolated rebase was aborted. Retry integration when ready.'
      )
    })
  }

  async cleanup(runId: string): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status === 'completed' || record.status === 'cancelled') return record
      if (record.status !== 'cleanup_pending' || (!record.cleanupIntent && !record.integratedHead)) {
        return this.needsAttention(
          record,
          'execution_incomplete',
          'Cleanup has no durable integration, cancellation, or discard intent.'
        )
      }
      return this.withAdmissionFence(record, (frozen) => this.resumeCleanupLocked(frozen))
    })
  }

  async safeCancel(input: PlanWorktreeSafeCancelRequest): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeSafeCancelRequestSchema.parse(input)
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status === 'completed' || record.status === 'cancelled') return record
      const activity = await this.completionRuntime.activity(record)
      if (activity === 'active') return this.executionStillActive(record)
      if (activity === 'unknown') {
        return this.needsAttention(
          record,
          'external_state_changed',
          'Kun runtime could not prove that the execution thread is idle.'
        )
      }
      return this.withAdmissionFence(record, async (frozen) => {
        const freshActivity = await this.completionRuntime.activity(frozen)
        if (freshActivity === 'active') return this.executionStillActive(frozen)
        if (freshActivity === 'unknown') {
          return this.needsAttention(
            frozen,
            'external_state_changed',
            'Kun runtime could not reverify that the frozen execution thread is idle.'
          )
        }
        if (!(await this.assertManagedWorktree(frozen, true))) {
          return this.requireRun(frozen.runId)
        }
        if (!(await pathExists(frozen.worktreePath))) {
          const branchExists = await this.branchExists(
            frozen.sourceCheckoutRoot,
            frozen.executionBranch
          )
        const executionHead = branchExists
            ? await this.revParse(frozen.sourceCheckoutRoot, `refs/heads/${frozen.executionBranch}`)
            : frozen.baseCommit
          if (executionHead !== frozen.baseCommit) {
          return this.needsAttention(
              { ...frozen, executionHead },
            'unique_work_retained',
            'The partially prepared execution branch contains unique commits.'
          )
        }
        const unchanged = await this.store.save({
            ...frozen,
          executionHead,
            cleanupIntent: 'safe_cancel',
          updatedAt: this.timestamp()
        })
          return this.cleanupRuntime.provenCleanup(unchanged)
      }
        const manifest = await readChangedFileManifest(frozen.worktreePath)
        const executionHead = await this.revParse(frozen.worktreePath, 'HEAD')
      const current = await this.store.save({
          ...frozen,
        changedFiles: manifest,
        executionHead,
        updatedAt: this.timestamp()
      })
      if (manifest.hasUncommittedChanges || executionHead !== record.baseCommit) {
        return this.needsAttention(
          current,
          'unique_work_retained',
          'The run has unique work and cannot be cancelled automatically.'
        )
      }
        const cleanupReady = await this.store.save({
          ...current,
          cleanupIntent: 'safe_cancel',
          status: 'cleanup_pending',
          updatedAt: this.timestamp()
        })
        return this.cleanupRuntime.provenCleanup(cleanupReady)
      })
    })
  }

  async discard(input: PlanWorktreeDiscardRequest): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeDiscardRequestSchema.parse(input)
    return this.withRunAndRepositoryLock(request.runId, async (record) => {
      if (record.status === 'completed' || record.status === 'cancelled') return record
      const activity = await this.completionRuntime.activity(record)
      if (activity === 'active') return this.executionStillActive(record)
      if (activity === 'unknown') {
        return this.needsAttention(
          record,
          'external_state_changed',
          'Kun runtime could not prove that the execution thread is idle.'
        )
      }
      return this.withAdmissionFence(record, async (frozen) => {
        const freshActivity = await this.completionRuntime.activity(frozen)
        if (freshActivity === 'active') return this.executionStillActive(frozen)
        if (freshActivity === 'unknown') {
          return this.needsAttention(
            frozen,
            'external_state_changed',
            'Kun runtime could not reverify that the frozen execution thread is idle.'
          )
        }
        if (!(await this.assertManagedWorktree(frozen, true))) {
          return this.requireRun(frozen.runId)
        }
        const recapture = frozen.cleanupIntent === 'discard_cancelled'
          && frozen.status === 'needs_attention'
          && frozen.attentionReason === 'unique_work_retained'
        const cleanupReady = await this.store.save({
          ...frozen,
          cleanupIntent: 'discard_cancelled',
          ...(recapture ? {
            recoveryPatchPath: undefined,
            recoverySnapshot: undefined
          } : {}),
          status: 'cleanup_pending',
          updatedAt: this.timestamp()
        })
        return this.cleanupRuntime.discard(cleanupReady)
      })
    })
  }

  private resumeCleanupLocked(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    switch (record.cleanupIntent) {
      case 'discard_cancelled':
        return this.cleanupRuntime.discard(record)
      case 'safe_cancel':
        return this.cleanupRuntime.provenCleanup(record)
      case 'integration_completed':
        return this.cleanupRuntime.provenCleanup(record)
      default:
        return record.integratedHead
          ? this.cleanupRuntime.provenCleanup(record)
          : this.needsAttention(
              record,
              'external_state_changed',
              'The durable cleanup intent is missing.'
            )
    }
  }

  private async assertManagedWorktree(
    record: PlanWorktreeRunRecord,
    allowMissing = false
  ): Promise<boolean> {
    if (!allowMissing && !(await pathExists(record.worktreePath))) {
      await this.needsAttention(
        record,
        'external_state_changed',
        'The recorded plan worktree no longer exists.'
      )
      return false
    }
    const identityFailure = await validateManagedWorktreeIdentity(record, this.managedRoot)
      .catch(messageOf)
    if (identityFailure) {
      await this.needsAttention(record, 'external_state_changed', identityFailure)
      return false
    }
    return true
  }

  private executionStillActive(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    return this.needsAttention(
      record,
      'execution_incomplete',
      'The execution thread is still active; continue or stop it before removing the worktree.'
    )
  }

  private async needsAttention(
    record: PlanWorktreeRunRecord,
    reason: PlanWorktreeAttentionReason,
    message: string
  ): Promise<PlanWorktreeRunRecord> {
    return this.store.save({
      ...record,
      status: 'needs_attention',
      attentionReason: reason,
      attentionMessage: message,
      updatedAt: this.timestamp()
    })
  }

  private async requireRun(runId: string): Promise<PlanWorktreeRunRecord> {
    const record = await this.store.get(runId)
    if (!record) throw new Error(`Unknown plan worktree run: ${runId}`)
    return record
  }

  private async revParse(cwd: string, ref: string): Promise<string> {
    return (await runGit(cwd, ['rev-parse', '--verify', ref])).stdout.trim()
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }

  private async branchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
