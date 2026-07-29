import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  testCompletedChild,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  schedulerHarness,
  schedulerTestRoots as roots,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GraphScheduler long worker results', () => {
  it('submits long normal prose once instead of retrying host normalization', async () => {
    const source = {
      ...testGraphPlan().nodes[0]!,
      completion: {
        ...testGraphPlan().nodes[0]!.completion,
        requiredResultFields: ['summary' as const]
      },
      maxAttempts: 3
    }
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    let executions = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        executions += 1
        await input.onQueued?.('child_long_prose')
        await input.onRunning?.('child_long_prose')
        return {
          ...testCompletedChild('child_long_prose', 'unused'),
          summary: '审'.repeat(4_311),
          evidence: undefined
        }
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(plan, () => delegation)
    harness.scheduler.start()

    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })

    await harness.scheduler.stop()
    const attempt = completed.nodes.research.attempts[0]!
    expect(executions).toBe(1)
    expect(completed.nodes.research.attempts).toHaveLength(1)
    expect(attempt.status).toBe('accepted')
    expect(attempt.result?.summary).toHaveLength(4_096)
    expect(attempt.result?.evidence[0]).toHaveLength(4_096)
  }, 15_000)
})
