import { describe, expect, it, vi } from 'vitest'
import type { ServerRuntime } from './routes/server-runtime.js'
import { reconcileRuntimeAfterRestart } from './runtime-restart-reconciliation.js'

describe('reconcileRuntimeAfterRestart', () => {
  it('settles children first and only auto-resumes ordinary primary threads', async () => {
    const order: string[] = []
    const resumeInterruptedGoals = vi.fn(async (threadIds: readonly string[]) => threadIds.length)
    const resumeInterruptedTurns = vi.fn(async (threadIds: readonly string[]) => threadIds.length)
    const runtime = {
      delegationRuntime: {
        reconcileOrphanedChildRuns: vi.fn(async () => {
          order.push('children')
          return 2
        }),
        resumableParentThreadIds: vi.fn(async () => ['parent_resume'])
      },
      turnService: {
        reconcileOrphanedTurns: vi.fn(async () => {
          order.push('turns')
          return ['child_side', 'parent_resume', 'ordinary']
        })
      },
      threadStore: {
        get: vi.fn(async (threadId: string) => ({
          id: threadId,
          relation: threadId === 'child_side' ? 'side' : 'primary'
        }))
      },
      resumeInterruptedGoals,
      resumeInterruptedTurns
    } as unknown as ServerRuntime

    const report = await reconcileRuntimeAfterRestart(runtime)

    expect(order).toEqual(['children', 'turns'])
    expect(report.resumeCandidateIds).toEqual(['ordinary'])
    expect(resumeInterruptedGoals).toHaveBeenCalledWith(['ordinary'])
    expect(resumeInterruptedTurns).toHaveBeenCalledWith(['ordinary'])
  })

  it('does not auto-resume when child reconciliation fails', async () => {
    const resumeInterruptedTurns = vi.fn(async () => 1)
    const runtime = {
      delegationRuntime: {
        reconcileOrphanedChildRuns: vi.fn(async () => { throw new Error('store unavailable') }),
        resumableParentThreadIds: vi.fn(async () => [])
      },
      turnService: { reconcileOrphanedTurns: vi.fn(async () => ['ordinary']) },
      threadStore: { get: vi.fn(async () => ({ relation: 'primary' })) },
      resumeInterruptedTurns
    } as unknown as ServerRuntime

    const report = await reconcileRuntimeAfterRestart(runtime)

    expect(report.resumeCandidateIds).toEqual([])
    expect(resumeInterruptedTurns).not.toHaveBeenCalled()
  })
})
