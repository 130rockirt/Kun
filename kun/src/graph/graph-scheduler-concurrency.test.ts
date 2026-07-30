import { afterEach, describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  cleanupSchedulerHarnesses,
  rejectWhenAborted,
  schedulerHarness,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

afterEach(cleanupSchedulerHarnesses)

describe('GraphScheduler same-run concurrency', () => {
  it('keeps two independent ready nodes active at the same time', async () => {
    const base = testGraphPlan()
    const auditA = {
      ...base.nodes[0]!,
      id: 'audit-a',
      title: 'Audit A',
      objective: 'Inspect independent concern A.'
    }
    const auditB = {
      ...base.nodes[0]!,
      id: 'audit-b',
      title: 'Audit B',
      objective: 'Inspect independent concern B.'
    }
    const plan = testGraphPlan({
      nodes: [auditA, auditB],
      edges: [],
      completionNodeIds: ['audit-a', 'audit-b'],
      budget: {
        ...base.budget,
        maxConcurrentNodes: 2
      },
      autoStart: true
    })
    let calls = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
        signal?: AbortSignal
      }) => {
        calls += 1
        const childId = `child_parallel_${calls}`
        await input.onQueued?.(childId)
        await input.onRunning?.(childId)
        return rejectWhenAborted(input.signal)
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation, {
      scheduler: {
        maxConcurrentNodes: 4,
        maxConcurrentNodesPerRun: 4
      }
    })
    harness.scheduler.start()

    const active = await waitFor(async () => {
      const attempts = harness.scheduler.diagnostics().active
      return attempts.length === 2 ? attempts : null
    })
    expect(calls).toBe(2)
    expect(active.map((attempt) => attempt.nodeId).sort()).toEqual(['audit-a', 'audit-b'])

    const cancelled = await harness.control.cancel('run_harness', {
      commandId: 'cancel_parallel',
      idempotencyKey: 'cancel_parallel'
    })
    expect(cancelled.status).toBe('cancelled')
    await harness.scheduler.stop()
  }, 15_000)
})
