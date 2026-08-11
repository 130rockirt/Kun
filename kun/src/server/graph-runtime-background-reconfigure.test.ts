import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphRunV1 } from '../contracts/graph.js'
import { testGraphConfig } from '../graph/graph-test-fixtures.test-support.js'
import { GraphRuntimeComposition } from './graph-runtime-factory.js'
import { GraphRuntimeReconfigureRetry } from './graph-runtime-reconfigure-retry.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function activeRun(id: string): GraphRunV1 {
  return { id, status: 'running', lastEventSeq: 1 } as GraphRunV1
}

function createHarness() {
  let id = 0
  const list = vi.fn(async (): Promise<GraphRunV1[]> => [])
  const pause = vi.fn(async (runId: string): Promise<GraphRunV1> => activeRun(runId))
  const learningReconfigure = vi.fn(async (): Promise<void> => undefined)
  const learningStop = vi.fn(async (): Promise<void> => undefined)
  const supervisorReconfigure = vi.fn()
  const supervisorStop = vi.fn(async (): Promise<void> => undefined)
  const schedulerStop = vi.fn(async (): Promise<void> => undefined)
  const runtime = Object.create(GraphRuntimeComposition.prototype) as GraphRuntimeComposition
  const retry = new GraphRuntimeReconfigureRetry(() => {
    const queue = Reflect.get(runtime, 'queueBackgroundServiceReconfigure') as () => Promise<void>
    void queue.call(runtime)
  }, () => 1)
  Object.assign(runtime, {
    store: { list },
    control: { pause },
    learning: { reconfigure: learningReconfigure, stop: learningStop },
    supervisor: {
      reconfigure: supervisorReconfigure,
      stop: supervisorStop,
      quiesceReviews: vi.fn()
    },
    scheduler: { stop: schedulerStop },
    options: {
      config: () => testGraphConfig({ enabled: false }),
      ids: { next: (prefix: string) => `${prefix}_${++id}` }
    },
    backgroundTasks: new Set<Promise<unknown>>(),
    backgroundReconfigureRetry: retry,
    backgroundServicesStopped: false
  })
  return {
    runtime,
    list,
    pause,
    learningReconfigure,
    learningStop,
    supervisorStop,
    schedulerStop
  }
}

async function flushRetry(): Promise<void> {
  await vi.advanceTimersByTimeAsync(100)
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

describe('GraphRuntimeComposition background reconfiguration', () => {
  it('continues pausing other runs and retries after an individual pause failure', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = activeRun('run_first')
    const second = activeRun('run_second')
    harness.list.mockResolvedValue([first, second])
    let firstAttempts = 0
    harness.pause.mockImplementation(async (runId) => {
      if (runId === first.id && ++firstAttempts === 1) throw new Error('pause unavailable')
      return activeRun(runId)
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(harness.runtime.reconfigureBackgroundServices()).resolves.toBeUndefined()

    expect(harness.pause.mock.calls.map(([runId]) => runId)).toEqual([first.id, second.id])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`pause ${first.id} failed`))

    await flushRetry()

    expect(harness.list).toHaveBeenCalledTimes(2)
    expect(harness.pause.mock.calls.filter(([runId]) => runId === first.id)).toHaveLength(2)
    await harness.runtime.stop()
  })

  it('isolates list and learning failures and converges on a later retry', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.list
      .mockRejectedValueOnce(new Error('list unavailable'))
      .mockResolvedValueOnce([activeRun('run_retry')])
    harness.learningReconfigure
      .mockRejectedValueOnce(new Error('learning unavailable'))
      .mockResolvedValueOnce(undefined)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(harness.runtime.reconfigureBackgroundServices()).resolves.toBeUndefined()
    expect(harness.learningReconfigure).toHaveBeenCalledTimes(1)

    await flushRetry()

    expect(harness.list).toHaveBeenCalledTimes(2)
    expect(harness.pause).toHaveBeenCalledWith('run_retry', expect.any(Object))
    expect(harness.learningReconfigure).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('run listing failed'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('learning failed'))
    await harness.runtime.stop()
  })

  it('clears a pending retry on stop and never reconfigures after stopping', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.list.mockRejectedValue(new Error('list unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await harness.runtime.reconfigureBackgroundServices()
    expect(vi.getTimerCount()).toBe(1)

    await harness.runtime.stop()
    expect(vi.getTimerCount()).toBe(0)
    await flushRetry()
    await harness.runtime.reconfigureBackgroundServices()

    expect(harness.list).toHaveBeenCalledTimes(1)
    expect(harness.learningReconfigure).toHaveBeenCalledTimes(1)
    expect(harness.supervisorStop).toHaveBeenCalledTimes(1)
    expect(harness.schedulerStop).toHaveBeenCalledTimes(1)
    expect(harness.learningStop).toHaveBeenCalledTimes(1)
  })

  it('backs off repeated failures and caps retry growth', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.list.mockRejectedValue(new Error('list unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await harness.runtime.reconfigureBackgroundServices()
    expect(harness.list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(harness.list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(400)
    expect(harness.list).toHaveBeenCalledTimes(4)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await vi.runOnlyPendingTimersAsync()
    }
    const callsAtCap = harness.list.mock.calls.length
    await vi.advanceTimersByTimeAsync(29_999)
    expect(harness.list).toHaveBeenCalledTimes(callsAtCap)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.list).toHaveBeenCalledTimes(callsAtCap + 1)
    await harness.runtime.stop()
  })

  it('resets backoff when an explicit reconfigure supersedes a pending retry', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.list.mockRejectedValue(new Error('list unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await harness.runtime.reconfigureBackgroundServices()
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.list).toHaveBeenCalledTimes(2)

    await harness.runtime.reconfigureBackgroundServices()
    expect(harness.list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(99)
    expect(harness.list).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.list).toHaveBeenCalledTimes(4)
    await harness.runtime.stop()
  })
})
