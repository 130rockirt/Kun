import type { ThreadGoal, ThreadGoalStatus } from '../agent/types'

export function maintenanceTestGoal(
  threadId: string,
  objective = 'ship goal mode',
  status: ThreadGoalStatus = 'active'
): ThreadGoal {
  return {
    threadId,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:01:00.000Z'
  }
}
