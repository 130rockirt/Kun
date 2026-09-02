import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelThreadRecovery,
  markThreadRecoveryCatchingUp,
  noteThreadRecoveryEvidence,
  resetThreadRecoveryCoordinator,
  runThreadRecovery,
  threadRecoveryDiagnostics
} from './thread-recovery-coordinator'

describe('thread recovery coordinator', () => {
  afterEach(() => resetThreadRecoveryCoordinator())

  it('joins concurrent triggers to one physical recovery', async () => {
    let release!: (value: boolean) => void
    const physical = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }))

    const first = runThreadRecovery('thread-1', 'watchdog', physical)
    const second = runThreadRecovery('thread-1', 'manual_retry', physical)
    await Promise.resolve()
    expect(physical).toHaveBeenCalledOnce()

    release(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(threadRecoveryDiagnostics()).toMatchObject({ started: 1, joined: 1, inflight: 0 })
  })

  it('aborts an obsolete physical recovery', async () => {
    let observedSignal!: AbortSignal
    const recovery = runThreadRecovery('thread-old', 'selection', async (signal) => {
      observedSignal = signal
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return false
    })
    await Promise.resolve()
    cancelThreadRecovery('thread-old')

    await expect(recovery).resolves.toBe(false)
    expect(observedSignal.aborted).toBe(true)
    expect(threadRecoveryDiagnostics()).toMatchObject({ cancelled: 1, inflight: 0 })
  })

  it('joins triggers while the replacement stream is catching up', async () => {
    markThreadRecoveryCatchingUp('thread-live')
    const physical = vi.fn(async () => true)

    await expect(runThreadRecovery('thread-live', 'manual_retry', physical)).resolves.toBe(true)
    expect(physical).not.toHaveBeenCalled()
    expect(threadRecoveryDiagnostics().inflight).toBe(1)
    noteThreadRecoveryEvidence('thread-live')
    expect(threadRecoveryDiagnostics().inflight).toBe(0)
  })
})
