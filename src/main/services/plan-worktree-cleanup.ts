import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import { pathExists, readChangedFileManifest } from './plan-worktree-git'
import {
  deleteExecutionBranchAtomically,
  validateExecutionBranchDeletion,
  validateManagedWorktreeIdentity,
  validateSourceCheckoutForIntegration
} from './plan-worktree-identity'
import {
  capturePlanWorktreeRecovery,
  recoverySnapshotStillMatches
} from './plan-worktree-recovery-patch'
import type { PlanWorktreeRunStore } from './plan-worktree-run-store'
import { PlanWorktreeAdmissionFence } from './plan-worktree-admission-fence'

export type PlanWorktreeCleanupOptions = {
  store: PlanWorktreeRunStore
  fence: PlanWorktreeAdmissionFence
  recoveryRoot?: string
  managedRoot?: string
  timestamp: () => string
  beforeDiscardRemove?: (record: PlanWorktreeRunRecord) => Promise<void>
  beforeExecutionBranchDelete?: (record: PlanWorktreeRunRecord) => Promise<void>
}

export class PlanWorktreeCleanup {
  private readonly recoveryRoot: string
  private readonly managedRoot: string

  constructor(private readonly options: PlanWorktreeCleanupOptions) {
    this.recoveryRoot = resolve(
      options.recoveryRoot ?? join(options.store.directory, 'recovery')
    )
    this.managedRoot = resolve(
      options.managedRoot ?? join(homedir(), '.kun', 'worktrees')
    )
  }

  async discard(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    let current = record
    try {
      if (!current.recoverySnapshot || !current.recoveryPatchPath) {
        const capture = await capturePlanWorktreeRecovery(
          current,
          this.recoveryRoot,
          this.options.timestamp()
        )
        current = await this.options.store.save({
          ...current,
          executionHead: capture.snapshot.head,
          recoveryPatchPath: capture.path,
          recoverySnapshot: capture.snapshot,
          updatedAt: this.options.timestamp()
        })
      }
      if (!this.options.fence.enabled && !current.cleanup.threadRebound) {
        current = await this.options.fence.move(current, current.sourceWorkspaceRoot, true)
      }
      if (!current.cleanup.worktreeRemoved) {
        if (await pathExists(current.worktreePath)) {
          if (!(await this.assertManaged(current))) return this.requireRun(current.runId)
          await this.options.beforeDiscardRemove?.(current)
          if (!(await recoverySnapshotStillMatches(current))) {
            return this.needsAttention(
              current,
              'unique_work_retained',
              'The worktree changed after its recovery patch was captured.'
            )
          }
          await runGit(current.sourceCheckoutRoot, [
            'worktree', 'remove', '--force', current.worktreePath
          ])
        }
        current = await this.saveCleanup(current, { worktreeRemoved: true })
      }
      current = await this.pruneAndDeleteBranch(current)
      if (current.status === 'needs_attention') return current
      return this.options.store.save({
        ...current,
        status: 'cleanup_pending',
        cleanup: {
          threadRebound: current.cleanup.threadRebound,
          worktreeRemoved: true,
          branchDeleted: true,
          metadataPruned: true
        },
        attentionReason: undefined,
        attentionMessage: undefined,
        updatedAt: this.options.timestamp()
      })
    } catch (error) {
      return this.cleanupFailed(current, error)
    }
  }

  async provenCleanup(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    let current = record
    try {
      if (!this.options.fence.enabled && !current.cleanup.threadRebound) {
        current = await this.options.fence.move(current, current.sourceWorkspaceRoot, true)
      }
      if (current.cleanupIntent === 'integration_completed' && current.integratedHead) {
        const sourceFailure = await validateSourceCheckoutForIntegration(
          current,
          current.integratedHead
        )
        if (sourceFailure) {
          return this.needsAttention(current, sourceFailure.reason, sourceFailure.message)
        }
      }
      if (!current.cleanup.worktreeRemoved && await pathExists(current.worktreePath)) {
        if (!(await this.assertManaged(current))) return this.requireRun(current.runId)
        const manifest = await readChangedFileManifest(current.worktreePath)
        const executionHead = await revParse(current.worktreePath, 'HEAD')
        const targetHead = await revParse(
          current.sourceCheckoutRoot,
          `refs/heads/${current.targetBranch}`
        )
        const unchanged = !manifest.hasUncommittedChanges && executionHead === current.baseCommit
        const integrated = !manifest.hasUncommittedChanges
          && await isAncestor(current.sourceCheckoutRoot, executionHead, targetHead)
        if (!unchanged && !integrated) {
          return this.needsAttention(
            { ...current, changedFiles: manifest, executionHead },
            'unique_work_retained',
            'Automatic cleanup refused because unique work remains.'
          )
        }
      }
      if (!current.cleanup.worktreeRemoved) {
        if (await pathExists(current.worktreePath)) {
          await runGit(current.sourceCheckoutRoot, [
            'worktree', 'remove', current.worktreePath
          ], 60_000)
        }
        current = await this.saveCleanup(current, { worktreeRemoved: true })
      }
      current = await this.pruneAndDeleteBranch(current)
      if (current.status === 'needs_attention') return current
      return this.options.store.save({
        ...current,
        status: 'cleanup_pending',
        attentionReason: undefined,
        attentionMessage: undefined,
        updatedAt: this.options.timestamp()
      })
    } catch (error) {
      return this.cleanupFailed(current, error)
    }
  }

  private async pruneAndDeleteBranch(
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeRunRecord> {
    let current = record
    if (!current.cleanup.metadataPruned) {
      await runGit(current.sourceCheckoutRoot, ['worktree', 'prune'])
      current = await this.saveCleanup(current, { metadataPruned: true })
    }
    if (!current.cleanup.branchDeleted) {
      const deletionFailure = await validateExecutionBranchDeletion(current)
      if (deletionFailure) {
        return this.needsAttention(current, 'external_state_changed', deletionFailure)
      }
      await this.options.beforeExecutionBranchDelete?.(current)
      const atomicDeleteFailure = await deleteExecutionBranchAtomically(current)
      if (atomicDeleteFailure) {
        return this.needsAttention(current, 'external_state_changed', atomicDeleteFailure)
      }
      current = await this.saveCleanup(current, { branchDeleted: true })
    }
    return current
  }

  private async assertManaged(record: PlanWorktreeRunRecord): Promise<boolean> {
    const failure = await validateManagedWorktreeIdentity(record, this.managedRoot)
      .catch(messageOf)
    if (!failure) return true
    await this.needsAttention(record, 'external_state_changed', failure)
    return false
  }

  private cleanupFailed(
    record: PlanWorktreeRunRecord,
    error: unknown
  ): Promise<PlanWorktreeRunRecord> {
    const reason: PlanWorktreeAttentionReason = record.cleanup.threadRebound
      ? 'cleanup_failed'
      : 'thread_rebind_failed'
    return this.options.store.save({
      ...record,
      status: 'cleanup_pending',
      attentionReason: reason,
      attentionMessage: messageOf(error),
      updatedAt: this.options.timestamp()
    })
  }

  private saveCleanup(
    record: PlanWorktreeRunRecord,
    patch: Partial<PlanWorktreeRunRecord['cleanup']>
  ): Promise<PlanWorktreeRunRecord> {
    return this.options.store.save({
      ...record,
      status: 'cleanup_pending',
      cleanup: { ...record.cleanup, ...patch },
      updatedAt: this.options.timestamp()
    })
  }

  private needsAttention(
    record: PlanWorktreeRunRecord,
    reason: PlanWorktreeAttentionReason,
    message: string
  ): Promise<PlanWorktreeRunRecord> {
    return this.options.store.save({
      ...record,
      status: 'needs_attention',
      attentionReason: reason,
      attentionMessage: message,
      updatedAt: this.options.timestamp()
    })
  }

  private async requireRun(runId: string): Promise<PlanWorktreeRunRecord> {
    const record = await this.options.store.get(runId)
    if (!record) throw new Error(`Unknown plan worktree run: ${runId}`)
    return record
  }
}

async function revParse(cwd: string, ref: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', ref])).stdout.trim()
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
