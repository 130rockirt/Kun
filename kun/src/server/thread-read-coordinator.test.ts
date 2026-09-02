import { describe, expect, it, vi } from 'vitest'
import { ThreadReadCoordinator, ThreadReadOverloadedError } from './thread-read-coordinator.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ThreadReadCoordinator', () => {
  it('coalesces twenty identical reads into one storage operation', async () => {
    const pending = deferred<string>()
    const operation = vi.fn(() => pending.promise)
    const coordinator = new ThreadReadCoordinator()
    const reads = Array.from({ length: 20 }, () => coordinator.run('same', 'foreground', operation))

    expect(operation).toHaveBeenCalledOnce()
    pending.resolve('done')
    await expect(Promise.all(reads)).resolves.toEqual(Array(20).fill('done'))
    expect(coordinator.stats()).toMatchObject({ joined: 19, started: 1, rejected: 0 })
  })

  it('bounds queued work and reports retryable overload', async () => {
    const pending = deferred<void>()
    const coordinator = new ThreadReadCoordinator({ foreground: 1, background: 1, queued: 1 })
    const active = coordinator.run('active', 'foreground', () => pending.promise)
    const queued = coordinator.run('queued', 'foreground', async () => undefined)

    await expect(coordinator.run('overflow', 'foreground', async () => undefined))
      .rejects.toBeInstanceOf(ThreadReadOverloadedError)
    pending.resolve()
    await Promise.all([active, queued])
    expect(coordinator.stats().rejected).toBe(1)
  })

  it('does not start background work while foreground work is active', async () => {
    const foreground = deferred<void>()
    const order: string[] = []
    const coordinator = new ThreadReadCoordinator()
    const first = coordinator.run('foreground', 'foreground', async () => {
      order.push('foreground')
      await foreground.promise
    })
    const second = coordinator.run('background', 'background', async () => {
      order.push('background')
    })
    await Promise.resolve()
    expect(order).toEqual(['foreground'])
    foreground.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['foreground', 'background'])
  })
})
