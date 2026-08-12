import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type { NormalizedThread } from '../agent/types'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import type { PlanWorktreePlanState } from './plan-worktree-store'

export type PlanWorktreeComposerAccess = {
  writable: boolean
  reason?: string
  run?: PlanWorktreeRunRecord
}

export function planWorktreeRunForThread(
  thread: NormalizedThread | undefined,
  plans: Record<string, PlanWorktreePlanState>,
  activeThreadId?: string | null
): PlanWorktreeRunRecord | undefined {
  const runId = thread?.planBuildRunId?.trim()
  if (runId) {
    return Object.values(plans).find((entry) => entry.run?.runId === runId)?.run
  }
  const executionThreadId = activeThreadId?.trim() || thread?.id
  if (!executionThreadId) return undefined
  return Object.values(plans).find((entry) =>
    entry.run?.executionThreadId === executionThreadId)?.run
}

export async function hydratePlanWorktreeComposerRun(
  thread: NormalizedThread | undefined,
  plans: Record<string, PlanWorktreePlanState>,
  getRun: (runId: string) => Promise<PlanWorktreeRunRecord | null>,
  upsertRun: (run: PlanWorktreeRunRecord) => void,
  activeThreadId?: string | null
): Promise<boolean> {
  const runId = thread?.planBuildRunId?.trim()
  if (!runId || planWorktreeRunForThread(thread, plans, activeThreadId)) return false
  const run = await getRun(runId)
  if (!run || run.runId !== runId) return false
  upsertRun(run)
  return true
}

const CONTINUABLE_ATTENTION_REASONS = new Set<PlanWorktreeRunRecord['attentionReason']>([
  'execution_incomplete',
  'execution_failed',
  'execution_interrupted',
  'pending_approval',
  'pending_user_input',
  'graph_incomplete'
])

function executionWorkspaceMatches(
  thread: NormalizedThread,
  run: PlanWorktreeRunRecord
): boolean {
  const threadWorkspace = normalizeWorkspaceRoot(thread.workspace ?? '')
  const executionWorkspace = normalizeWorkspaceRoot(run.executionWorkspace ?? run.worktreePath)
  return Boolean(threadWorkspace && executionWorkspace && threadWorkspace === executionWorkspace)
}

export function planWorktreeComposerAccess(
  thread: NormalizedThread | undefined,
  plans: Record<string, PlanWorktreePlanState>,
  activeThreadId?: string | null
): PlanWorktreeComposerAccess {
  const runId = thread?.planBuildRunId?.trim()
  const run = planWorktreeRunForThread(thread, plans, activeThreadId)
  if (!run) {
    if (!runId) return { writable: true }
    return {
      writable: false,
      reason: 'This isolated plan task is waiting for its durable execution state to recover.'
    }
  }

  const executionThreadId = activeThreadId?.trim() || thread?.id
  if (!executionThreadId || run.executionThreadId !== executionThreadId) {
    return {
      writable: false,
      reason: 'This isolated plan task is waiting for its durable execution state to recover.'
    }
  }

  if (
    (run.status === 'completed' || run.status === 'cancelled') &&
    run.cleanup.threadRebound
  ) {
    return { writable: true, run }
  }

  const stillBound = (thread
    ? executionWorkspaceMatches(thread, run)
    : true) && !run.cleanup.worktreeRemoved
  if (
    run.status === 'executing' &&
    Boolean(run.executionTurnId) &&
    stillBound &&
    !run.admissionFrozen
  ) {
    return { writable: true, run }
  }

  if (
    run.status === 'needs_attention' &&
    Boolean(run.executionTurnId) &&
    CONTINUABLE_ATTENTION_REASONS.has(run.attentionReason) &&
    stillBound &&
    !run.admissionFrozen
  ) {
    return { writable: true, run }
  }

  const reason = run.executionThreadId && !run.executionTurnId
    ? 'This isolated plan task must resume its durable execution turn before accepting messages.'
    : run.status === 'ready_to_integrate' || run.status === 'integrating'
      ? 'This isolated plan task is read-only while its changes are being integrated.'
      : run.status === 'cleanup_pending' || run.cleanup.worktreeRemoved
        ? 'This isolated plan task is read-only while its worktree is being cleaned up.'
        : 'This isolated plan task is read-only in its current lifecycle state.'
  return { writable: false, reason, run }
}
