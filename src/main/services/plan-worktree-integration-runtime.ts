import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeCompletionSnapshot,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import {
  evaluatePlanWorktreeCompletion,
  planWorktreeCompletionProbe
} from './plan-worktree-completion-evaluation'
import type { PlanWorktreeRunStore } from './plan-worktree-run-store'

export type PlanWorktreeCompletionVerification = (
  record: PlanWorktreeRunRecord,
  claimed: PlanWorktreeCompletionSnapshot
) => Promise<PlanWorktreeCompletionSnapshot>

export type PlanWorktreeCompletionResult =
  | { ok: true; snapshot: PlanWorktreeCompletionSnapshot }
  | { ok: false; record: PlanWorktreeRunRecord }

export class PlanWorktreeIntegrationRuntime {
  constructor(
    private readonly store: PlanWorktreeRunStore,
    private readonly verify: PlanWorktreeCompletionVerification,
    private readonly timestamp: () => string
  ) {}

  async verifyOrAttention(
    record: PlanWorktreeRunRecord,
    claimed: PlanWorktreeCompletionSnapshot
  ): Promise<PlanWorktreeCompletionResult> {
    try {
      return { ok: true, snapshot: await this.verify(record, claimed) }
    } catch (error) {
      const reason = typeof error === 'object' && error !== null && 'reason' in error
        ? (error as { reason?: PlanWorktreeAttentionReason }).reason
        : undefined
      return {
        ok: false,
        record: await this.needsAttention(
          { ...record, completionVerifiedAt: undefined },
          reason ?? 'external_state_changed',
          messageOf(error)
        )
      }
    }
  }

  async reverify(record: PlanWorktreeRunRecord): Promise<PlanWorktreeCompletionResult> {
    if (!record.executionTurnId) {
      return {
        ok: false,
        record: await this.needsAttention(
          { ...record, completionVerifiedAt: undefined },
          'execution_incomplete',
          'The execution turn has not been durably attached.'
        )
      }
    }
    const result = await this.verifyOrAttention(
      record,
      planWorktreeCompletionProbe(record.executionTurnId)
    )
    if (!result.ok) return result
    const evaluation = evaluatePlanWorktreeCompletion(result.snapshot, record.orchestration)
    if (evaluation.eligible) return result
    const unfinished = result.snapshot.turnStatus === 'running'
      || result.snapshot.goalStatus === 'active'
      || (record.orchestration === 'graph' && result.snapshot.graphStatus === 'running')
    const reset = { ...record, completionVerifiedAt: undefined }
    return {
      ok: false,
      record: unfinished
        ? await this.store.save({
            ...reset,
            status: 'executing',
            attentionReason: undefined,
            attentionMessage: undefined,
            updatedAt: this.timestamp()
          })
        : await this.needsAttention(
            reset,
            evaluation.reason ?? 'execution_incomplete',
            evaluation.message ?? 'Execution is no longer ready to integrate.'
          )
    }
  }

  async activity(record: PlanWorktreeRunRecord): Promise<'idle' | 'active' | 'unknown'> {
    if (!record.executionThreadId || !record.executionTurnId) return 'idle'
    try {
      const snapshot = await this.verify(
        record,
        planWorktreeCompletionProbe(record.executionTurnId)
      )
      return snapshot.turnStatus === 'running' || snapshot.hasLaterRunningTurn
        || snapshot.hasPendingApproval || snapshot.hasPendingUserInput
        || snapshot.goalStatus === 'active'
        || (record.orchestration === 'graph' && snapshot.graphStatus === 'running')
        ? 'active'
        : 'idle'
    } catch {
      return 'unknown'
    }
  }

  snapshot(record: PlanWorktreeRunRecord): Promise<PlanWorktreeCompletionSnapshot> {
    if (!record.executionTurnId) {
      return Promise.reject(new Error('The execution turn has not been durably attached.'))
    }
    return this.verify(record, planWorktreeCompletionProbe(record.executionTurnId))
  }

  private needsAttention(
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
