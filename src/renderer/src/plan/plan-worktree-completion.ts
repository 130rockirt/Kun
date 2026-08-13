import type {
  PlanWorktreeCompletionSnapshot,
  PlanWorktreeRunRecord
} from '@shared/plan-worktree'
import type { ChatBlock, NormalizedThread, ThreadGoal } from '../agent/types'
import type { GraphRun } from '../graph/graph-types'

function turnStatus(value: string | undefined): PlanWorktreeCompletionSnapshot['turnStatus'] {
  if (value === 'completed') return 'completed'
  if (value === 'failed' || value === 'error') return 'failed'
  if (value === 'interrupted' || value === 'aborted') return 'interrupted'
  if (value === 'cancelled') return 'cancelled'
  return 'running'
}

function graphCompletion(run: GraphRun | undefined): Pick<
  PlanWorktreeCompletionSnapshot,
  'graphStatus' | 'graphHasPendingGate'
> {
  if (!run) return { graphStatus: 'running', graphHasPendingGate: true }
  const graphStatus: PlanWorktreeCompletionSnapshot['graphStatus'] = run.status === 'completed'
    ? 'completed'
    : run.status === 'failed'
      ? 'failed'
      : run.status === 'cancelled'
        ? 'interrupted'
        : 'running'
  const pendingSupervision = Boolean(run.supervision?.pendingActions?.some(
    (action) => action.pendingAction !== 'completion'
  )) || Boolean(run.supervision?.peerReviewLeases?.length)
  const pendingCleanup = run.cleanup.some((item) =>
    item.state !== 'completed' && item.state !== 'preserved')
  const pendingStatus = run.status === 'awaiting_human' || run.status === 'awaiting_supervision'
  return {
    graphStatus,
    graphHasPendingGate: pendingSupervision || pendingCleanup || pendingStatus
  }
}

/**
 * Derive host completion input only from durable/structured renderer state.
 * The durable execution turn is an immutable origin. Later turns in the same
 * isolated thread are continuations of that run; the host authoritatively
 * aggregates them before integration.
 */
export function projectPlanWorktreeCompletion(input: {
  run: PlanWorktreeRunRecord
  thread: NormalizedThread | undefined
  goal: ThreadGoal | null | undefined
  blocks: ChatBlock[]
  busy: boolean
  currentTurnId: string | null
  graphRuns: GraphRun[]
}): PlanWorktreeCompletionSnapshot | null {
  const executionTurnId = input.run.executionTurnId
  if (!executionTurnId || !input.thread) return null

  const relevantBlocks = input.blocks
  const hasPendingApproval = relevantBlocks.some((block) =>
    block.kind === 'approval' && (block.status === 'pending' || block.status === 'submitting'))
  const hasPendingUserInput = relevantBlocks.some((block) =>
    block.kind === 'user_input' && block.status === 'pending' && block.live === true)
  const currentExecutionRunning = input.busy && Boolean(input.currentTurnId)
  const status = currentExecutionRunning ? 'running' : turnStatus(input.thread.latestTurnStatus)
  const graph = input.run.orchestration === 'graph'
    ? graphCompletion(input.graphRuns.find((candidate) =>
        candidate.id === input.run.graphRunId ||
        candidate.sourceTurnId === executionTurnId ||
        candidate.sourceTurnId === input.thread?.latestTurnId))
    : { graphStatus: 'not_applicable' as const, graphHasPendingGate: false }

  return {
    executionTurnId,
    turnStatus: status,
    goalStatus: input.goal?.status === 'complete'
      ? 'complete'
      : input.goal?.status === 'blocked'
        ? 'blocked'
        : input.goal
          ? 'active'
          : 'missing',
    hasLaterRunningTurn: Boolean(input.busy && input.currentTurnId !== executionTurnId),
    hasPendingApproval,
    hasPendingUserInput,
    ...graph
  }
}

export function planWorktreeCompletionIsSuccessful(
  snapshot: PlanWorktreeCompletionSnapshot,
  orchestration: PlanWorktreeRunRecord['orchestration']
): boolean {
  return snapshot.turnStatus === 'completed' &&
    snapshot.goalStatus === 'complete' &&
    !snapshot.hasLaterRunningTurn &&
    !snapshot.hasPendingApproval &&
    !snapshot.hasPendingUserInput &&
    (orchestration === 'direct' || (
      snapshot.graphStatus === 'completed' && !snapshot.graphHasPendingGate
    ))
}
