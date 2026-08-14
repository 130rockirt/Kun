import { describe, expect, it, vi } from 'vitest'
import {
  MainWindowActivationCoordinator,
  type ActivatableMainWindow
} from './main-window-activation'

describe('MainWindowActivationCoordinator', () => {
  it('retains a reveal request until startup creates a live window', () => {
    let window: ActivatableMainWindow | null = null
    const reveal = vi.fn()
    const coordinator = new MainWindowActivationCoordinator(() => window, reveal)

    coordinator.requestReveal()
    expect(coordinator.hasPendingReveal()).toBe(true)
    expect(reveal).not.toHaveBeenCalled()

    window = { isDestroyed: () => false }
    coordinator.windowAvailable()

    expect(coordinator.hasPendingReveal()).toBe(false)
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('reveals a live owner immediately', () => {
    const reveal = vi.fn()
    const coordinator = new MainWindowActivationCoordinator(
      () => ({ isDestroyed: () => false }),
      reveal
    )

    coordinator.requestReveal()

    expect(coordinator.hasPendingReveal()).toBe(false)
    expect(reveal).toHaveBeenCalledOnce()
  })
})
