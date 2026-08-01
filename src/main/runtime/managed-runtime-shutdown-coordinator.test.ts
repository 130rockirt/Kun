import { describe, expect, it, vi } from 'vitest'
import { ManagedRuntimeShutdownCoordinator } from './managed-runtime-shutdown-coordinator'

describe('ManagedRuntimeShutdownCoordinator', () => {
  it('marks quit intent before awaiting one shared stop operation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stop = vi.fn(() => gate)
    const coordinator = new ManagedRuntimeShutdownCoordinator(stop)

    const first = coordinator.stopForQuit()
    const second = coordinator.stopForQuit()
    expect(coordinator.isQuitInProgress).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    expect(coordinator.isStoppedForQuit).toBe(true)
  })

  it('remains terminal when a runtime adapter fails to stop', async () => {
    const coordinator = new ManagedRuntimeShutdownCoordinator(async () => {
      throw new Error('stop failed')
    })
    await expect(coordinator.stopForQuit()).rejects.toThrow('stop failed')
    expect(coordinator.isQuitInProgress).toBe(true)
    expect(coordinator.isStoppedForQuit).toBe(true)
  })

  it('allows a non-terminal window-close stop to be invoked again later', async () => {
    const stop = vi.fn(async () => undefined)
    const coordinator = new ManagedRuntimeShutdownCoordinator(stop)
    await coordinator.stop()
    await coordinator.stop()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(coordinator.isQuitInProgress).toBe(false)
  })

  it('treats storage relocation as terminal quit intent', () => {
    const coordinator = new ManagedRuntimeShutdownCoordinator(async () => undefined)
    coordinator.setStorageRelocationQuit(true)
    expect(coordinator.isStorageRelocationQuit).toBe(true)
    expect(coordinator.isQuitInProgress).toBe(true)
  })
})
