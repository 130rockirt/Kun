import { describe, expect, it, vi } from 'vitest'
import { GraphRuntimeReconfigureRetry } from './graph-runtime-reconfigure-retry.js'

describe('GraphRuntimeReconfigureRetry', () => {
  it('adds bounded jitter to the exponential retry delay', async () => {
    vi.useFakeTimers()
    const operation = vi.fn()
    const retry = new GraphRuntimeReconfigureRetry(operation, () => 0)

    retry.schedule()
    await vi.advanceTimersByTimeAsync(49)
    expect(operation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(operation).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})
