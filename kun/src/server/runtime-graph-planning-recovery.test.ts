import { describe, expect, it, vi } from 'vitest'
import { resumeInterruptedGraphPlanning } from './runtime-factory.js'

describe('Graph planning restart recovery', () => {
  it('automatically reacquires planning, validating, and repairing drafts only', async () => {
    const drafts = [
      planningDraft('draft_planning', 'turn_planning', 'planning'),
      planningDraft('draft_validating', 'turn_validating', 'validating'),
      planningDraft('draft_repairing', 'turn_repairing', 'repairing'),
      planningDraft('draft_correction', 'turn_correction', 'needs_correction')
    ]
    const list = vi.fn(async (input: { statuses: readonly string[] }) =>
      drafts.filter((draft) => input.statuses.includes(draft.status)))
    const getTurn = vi.fn(async (_threadId: string, turnId: string) => ({
      id: turnId,
      status: 'running',
      orchestration: 'graph'
    }))
    const resumeGraphPlanningTurn = vi.fn(async () => 'resumed' as const)
    const runTurn = vi.fn<
      (threadId: string, turnId: string) => Promise<string>
    >(async () => 'suspended')

    await expect(resumeInterruptedGraphPlanning({
      graphRuntime: { drafts: { list } as never },
      turnService: { getTurn, resumeGraphPlanningTurn } as never,
      runTurn
    })).resolves.toBe(3)

    expect(list).toHaveBeenCalledWith({
      statuses: ['planning', 'validating', 'repairing']
    })
    expect(resumeGraphPlanningTurn).toHaveBeenCalledTimes(3)
    expect(runTurn.mock.calls.map(([, turnId]) => turnId)).toEqual([
      'turn_planning',
      'turn_validating',
      'turn_repairing'
    ])
  })
})

function planningDraft(
  id: string,
  sourceTurnId: string,
  status: 'planning' | 'validating' | 'repairing' | 'needs_correction'
) {
  return {
    id,
    threadId: 'thread_1',
    sourceTurnId,
    status
  }
}
