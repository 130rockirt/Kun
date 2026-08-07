import type { PowerSaveBlockerLike } from './schedule-runtime-helpers'

/**
 * Shared power-save blocker with reference counting.
 *
 * ScheduleRuntime holds one reference while an enabled scheduled task exists
 * and `keepAwake` is on; DaemonRuntime holds one while at least one daemon is
 * running. Both runtimes receive the same instance (wired in index.ts) so the
 * Electron power save blocker is never started twice nor stopped by the wrong
 * owner. `reset()` force-releases everything during runtime teardown.
 */
export class PowerSaveController {
  private refCount = 0
  private blockerId: number | null = null

  constructor(private readonly blocker: PowerSaveBlockerLike) {}

  acquire(): void {
    this.refCount += 1
    if (this.refCount > 1) return
    try {
      this.blockerId = this.blocker.start('prevent-app-suspension')
    } catch {
      this.refCount = 0
      this.blockerId = null
    }
  }

  release(): void {
    if (this.refCount <= 0) return
    this.refCount -= 1
    if (this.refCount === 0) this.stopBlocker()
  }

  isActive(): boolean {
    if (this.refCount <= 0 || this.blockerId == null) return false
    try {
      return this.blocker.isStarted(this.blockerId)
    } catch {
      return false
    }
  }

  /** Force-release every reference (runtime teardown). */
  reset(): void {
    this.refCount = 0
    this.stopBlocker()
  }

  private stopBlocker(): void {
    const id = this.blockerId
    this.blockerId = null
    if (id == null) return
    try {
      if (this.blocker.isStarted(id)) this.blocker.stop(id)
    } catch {
      /* best-effort */
    }
  }
}

export function createPowerSaveController(blocker: PowerSaveBlockerLike): PowerSaveController {
  return new PowerSaveController(blocker)
}
