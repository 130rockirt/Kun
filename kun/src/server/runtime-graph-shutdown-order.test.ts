import { describe, expect, it, vi } from 'vitest'
import { shutdownGraphExecutionForHost } from './runtime-factory.js'

describe('runtime Graph shutdown ordering', () => {
  it('quiesces Graph workers before parking source turns and stopping Lead queues', async () => {
    const order: string[] = []
    let releaseWorkers!: () => void
    const workersStopped = new Promise<void>((resolve) => {
      releaseWorkers = resolve
    })
    const graphRuntime = {
      quiesceExecution: vi.fn(async () => {
        order.push('workers:begin')
        await workersStopped
        order.push('workers:done')
      }),
      stop: vi.fn(async () => {
        order.push('graph:stop')
      })
    }
    const turnService = {
      suspendActiveTurnsForShutdown: vi.fn(async () => {
        order.push('turns:suspend')
        return 1
      })
    }

    const shutdown = shutdownGraphExecutionForHost({
      graphRuntime,
      turnService
    })
    await vi.waitFor(() => {
      expect(order).toEqual(['workers:begin'])
    })
    expect(turnService.suspendActiveTurnsForShutdown).not.toHaveBeenCalled()
    expect(graphRuntime.stop).not.toHaveBeenCalled()

    releaseWorkers()
    await shutdown

    expect(order).toEqual([
      'workers:begin',
      'workers:done',
      'turns:suspend',
      'graph:stop'
    ])
  })
})
