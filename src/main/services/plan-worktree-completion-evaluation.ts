import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeCompletionSnapshot,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'

export type PlanWorktreeCompletionEvaluation = {
  eligible: boolean
  reason?: PlanWorktreeAttentionReason
  message?: string
}

export function evaluatePlanWorktreeCompletion(
  snapshot: PlanWorktreeCompletionSnapshot,
  orchestration: PlanWorktreeRunRecord['orchestration']
): PlanWorktreeCompletionEvaluation {
  if (snapshot.hasPendingApproval) {
    return { eligible: false, reason: 'pending_approval', message: 'Execution is waiting for approval.' }
  }
  if (snapshot.hasPendingUserInput) {
    return { eligible: false, reason: 'pending_user_input', message: 'Execution is waiting for user input.' }
  }
  if (snapshot.hasLaterRunningTurn || snapshot.turnStatus === 'running') {
    return { eligible: false, reason: 'execution_incomplete', message: 'Execution is still running.' }
  }
  if (snapshot.turnStatus === 'interrupted' || snapshot.turnStatus === 'cancelled') {
    return { eligible: false, reason: 'execution_interrupted', message: 'Execution was interrupted.' }
  }
  if (snapshot.turnStatus !== 'completed') {
    return { eligible: false, reason: 'execution_failed', message: 'Execution did not complete successfully.' }
  }
  if (snapshot.goalStatus !== 'complete') {
    return { eligible: false, reason: 'execution_incomplete', message: 'The implementation goal is not complete.' }
  }
  if (orchestration === 'graph' || snapshot.graphStatus !== 'not_applicable') {
    if (snapshot.graphHasPendingGate || snapshot.graphStatus === 'running') {
      return { eligible: false, reason: 'graph_incomplete', message: 'Graph still has pending work or gates.' }
    }
    if (snapshot.graphStatus !== 'completed') {
      return { eligible: false, reason: 'execution_failed', message: 'Graph did not complete successfully.' }
    }
  }
  return { eligible: true }
}

export function planWorktreeCompletionProbe(
  executionTurnId: string
): PlanWorktreeCompletionSnapshot {
  return {
    executionTurnId,
    turnStatus: 'running',
    goalStatus: 'active',
    hasLaterRunningTurn: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    graphStatus: 'not_applicable',
    graphHasPendingGate: false
  }
}
