import { describe, expect, it } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type { NormalizedThread, ThreadGoal } from '../agent/types'
import type { GraphRun } from '../graph/graph-types'
import {
  planWorktreeCompletionIsSuccessful,
  projectPlanWorktreeCompletion
} from './plan-worktree-completion'

const run = {
  executionTurnId: 'turn-execute',
  orchestration: 'direct'
} as PlanWorktreeRunRecord
const thread = {
  id: 'thread-execute',
  title: 'Execution',
  updatedAt: '2026-08-12T00:00:00.000Z',
  model: 'model',
  mode: 'agent',
  latestTurnId: 'turn-execute',
  latestTurnStatus: 'completed'
} satisfies NormalizedThread
const goal = { status: 'complete' } as ThreadGoal

describe('plan worktree structured completion projection', () => {
  it('allows Direct finalization only for terminal success and a completed goal', () => {
    const snapshot = projectPlanWorktreeCompletion({
      run,
      thread,
      goal,
      blocks: [],
      busy: false,
      currentTurnId: null,
      graphRuns: []
    })
    expect(snapshot).not.toBeNull()
    expect(planWorktreeCompletionIsSuccessful(snapshot!, 'direct')).toBe(true)
  })

  it('keeps the original turn as the run anchor while projecting a completed continuation', () => {
    const continued = projectPlanWorktreeCompletion({
      run,
      thread: { ...thread, latestTurnId: 'turn-later', latestTurnStatus: 'completed' },
      goal,
      blocks: [],
      busy: false,
      currentTurnId: null,
      graphRuns: []
    })
    expect(continued).toMatchObject({
      executionTurnId: 'turn-execute',
      turnStatus: 'completed',
      hasLaterRunningTurn: false
    })
    expect(planWorktreeCompletionIsSuccessful(continued!, 'direct')).toBe(true)
  })

  it('fails closed for a running continuation, pending gate, or incomplete Graph', () => {
    const continued = projectPlanWorktreeCompletion({
      run,
      thread: { ...thread, latestTurnId: 'turn-later', latestTurnStatus: 'running' },
      goal,
      blocks: [],
      busy: true,
      currentTurnId: 'turn-later',
      graphRuns: []
    })
    expect(planWorktreeCompletionIsSuccessful(continued!, 'direct')).toBe(false)

    const pending = projectPlanWorktreeCompletion({
      run,
      thread,
      goal,
      blocks: [{
        kind: 'approval',
        id: 'approval',
        turnId: 'turn-execute',
        approvalId: 'approval-id',
        summary: 'Approve',
        status: 'pending'
      }],
      busy: false,
      currentTurnId: null,
      graphRuns: []
    })
    expect(planWorktreeCompletionIsSuccessful(pending!, 'direct')).toBe(false)

    expect(planWorktreeCompletionIsSuccessful({
      ...pending!,
      hasPendingApproval: false,
      graphStatus: 'running',
      graphHasPendingGate: true
    }, 'graph')).toBe(false)
  })

  it('allows terminal Graph cleanup preservation and the completion supervision marker', () => {
    const graphRun = {
      id: 'graph-run',
      sourceTurnId: run.executionTurnId,
      status: 'completed',
      cleanup: [{ state: 'preserved' }],
      supervision: {
        pendingActions: [{ pendingAction: 'completion' }],
        peerReviewLeases: []
      }
    } as unknown as GraphRun
    const snapshot = projectPlanWorktreeCompletion({
      run: { ...run, orchestration: 'graph', graphRunId: graphRun.id },
      thread,
      goal,
      blocks: [],
      busy: false,
      currentTurnId: null,
      graphRuns: [graphRun]
    })
    expect(snapshot).toMatchObject({
      graphStatus: 'completed',
      graphHasPendingGate: false
    })
    expect(planWorktreeCompletionIsSuccessful(snapshot!, 'graph')).toBe(true)
  })
})
