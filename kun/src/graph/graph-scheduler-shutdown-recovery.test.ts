import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  GRAPH_HOST_SHUTDOWN_ATTEMPT_FAILURE,
  effectiveRunAttemptCount
} from './graph-scheduler-policy.js'
import {
  testCompletedChild,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  cleanupSchedulerHarnesses,
  schedulerHarness,
  rejectWhenAborted,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

const schedulerWaitTimeoutMs = process.platform === 'win32' ? 30_000 : 10_000
const schedulerStopTimeoutMs = process.platform === 'win32' ? 5_000 : 500
const schedulerTestTimeoutMs = process.platform === 'win32' ? 60_000 : 15_000

afterEach(cleanupSchedulerHarnesses)

describe('GraphScheduler host shutdown recovery', () => {
  it('does not consume the only worker attempt across shutdown and restart', async () => {
    const source = {
      ...testGraphPlan().nodes[0],
      maxAttempts: 1
    }
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      budget: {
        ...testGraphPlan().budget,
        maxAttemptsPerNode: 1
      },
      autoStart: true
    })
    let executions = 0
    const delegation = {
      enabled: () => true,
      runChild: async (input: {
        signal?: AbortSignal
        onQueued?: (id: string) => Promise<void> | void
        onRunning?: (id: string) => Promise<void> | void
      }) => {
        executions += 1
        const childId = `child_shutdown_${executions}`
        await input.onQueued?.(childId)
        await input.onRunning?.(childId)
        if (executions === 1) {
          await new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => reject(input.signal?.reason),
              { once: true }
            )
          })
        }
        return testCompletedChild(childId, 'Recovered worker completed.')
      }
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      { scheduler: { maxAttemptsPerNode: 1 } }
    )
    harness.scheduler.start()
    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.nodes[source.id]?.status === 'running' ? run : null
    }, schedulerWaitTimeoutMs)

    await harness.scheduler.stop()
    const parked = (await harness.store.get('run_harness'))!
    expect(parked.nodes[source.id]).toMatchObject({
      status: 'ready',
      attempts: [expect.objectContaining({
        status: 'interrupted',
        failureClass: 'interrupted',
        normalizedFailure: GRAPH_HOST_SHUTDOWN_ATTEMPT_FAILURE
      })]
    })
    expect(effectiveRunAttemptCount(parked)).toBe(0)

    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    }, schedulerWaitTimeoutMs)
    await harness.scheduler.stop()

    expect(executions).toBe(2)
    expect(completed.nodes[source.id].attempts).toHaveLength(2)
    expect(effectiveRunAttemptCount(completed)).toBe(1)
    expect(completed.status).toBe('completed')
  }, schedulerTestTimeoutMs)

  it('catches an attempt admitted after the first shutdown snapshot', async () => {
    const source = {
      ...testGraphPlan().nodes[0],
      maxAttempts: 1
    }
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      budget: {
        ...testGraphPlan().budget,
        maxAttemptsPerNode: 1
      }
    })
    const delegation = {
      enabled: () => true,
      runChild: (input: { signal?: AbortSignal }) =>
        rejectWhenAborted(input.signal)
    } as unknown as DelegationRuntime
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      { scheduler: { maxAttemptsPerNode: 1 } }
    )
    const acquire = harness.writes.acquire.bind(harness.writes)
    let admissionReached!: () => void
    const reached = new Promise<void>((resolve) => {
      admissionReached = resolve
    })
    let releaseAdmission!: () => void
    const released = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    vi.spyOn(harness.writes, 'acquire').mockImplementation(async (input) => {
      admissionReached()
      await released
      return acquire(input)
    })

    const ticking = harness.scheduler.tick()
    await reached
    const stopping = harness.scheduler.stop()
    releaseAdmission()

    await expect(Promise.race([
      stopping,
      new Promise<'timed_out'>((resolve) =>
        setTimeout(() => resolve('timed_out'), schedulerStopTimeoutMs))
    ])).resolves.not.toBe('timed_out')
    await ticking

    const parked = (await harness.store.get('run_harness'))!
    expect(parked.nodes[source.id]).toMatchObject({
      status: 'ready',
      attempts: [expect.objectContaining({
        status: 'interrupted',
        normalizedFailure: GRAPH_HOST_SHUTDOWN_ATTEMPT_FAILURE
      })]
    })
    expect(effectiveRunAttemptCount(parked)).toBe(0)
  }, schedulerTestTimeoutMs)
})
