/**
 * Interrupted-turn auto-resume coordinator.
 *
 * When a runtime restart or host shutdown strands an in-flight turn, the turn
 * is reconciled to `failed` and (unless the thread has an active goal, which
 * has its own resume path) nothing used to relaunch the work — the user had to
 * repeat "continue what you were doing". This coordinator owns the restart
 * resume policy for ordinary threads:
 *
 * - It relaunches a continuation turn once per process start for each thread
 *   that was interrupted by a restart/host shutdown, gated by a persisted
 *   cooldown so a crash loop cannot burn model budget by auto-resuming on
 *   every boot.
 * - Every effect (launch a turn, validate the thread, persist the resume
 *   marker) is injected so the policy stays unit-testable with a fake timer.
 *
 * The coordinator holds no domain knowledge; the caller decides which threads
 * are eligible and what the continuation turn should say.
 */

/** A cancellable scheduled callback. */
export type InterruptedTurnResumeTimer = { cancel: () => void }

export type InterruptedTurnResumeCoordinatorDeps = {
  /** Launch a fresh continuation turn for the interrupted thread. */
  launch: (threadId: string) => Promise<void>
  /**
   * Re-read the thread and return `false` when it should not be resumed (no
   * eligible interrupted turn, a goal owns the resume path, the thread was
   * already resumed, or the persisted cooldown has not elapsed). Re-validated
   * at fire time so a deferred launch never resumes a thread that changed.
   */
  canResume: (threadId: string) => Promise<boolean>
  /** Whether the thread currently has a turn running (avoids double-launch). */
  isThreadBusy: (threadId: string) => Promise<boolean>
  /** Persist that this process auto-resumed the thread (cooldown marker). */
  markResumed: (threadId: string) => Promise<void>
  /** Schedule a delayed callback. Overridable for tests. */
  setTimer?: (fn: () => void, delayMs: number) => InterruptedTurnResumeTimer
  /** Diagnostic sink; defaults to `console.warn`. */
  log?: (message: string) => void
  baseDelayMs?: number
  maxDelayMs?: number
}

export const DEFAULT_INTERRUPTED_RESUME_BASE_DELAY_MS = 2_000
export const DEFAULT_INTERRUPTED_RESUME_MAX_DELAY_MS = 60_000

function defaultSetTimer(fn: () => void, delayMs: number): InterruptedTurnResumeTimer {
  const handle = setTimeout(fn, delayMs)
  // Don't let a pending resume keep the process alive on shutdown.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    ;(handle as { unref: () => void }).unref()
  }
  return { cancel: () => clearTimeout(handle) }
}

export class InterruptedTurnResumeCoordinator {
  private readonly deps: InterruptedTurnResumeCoordinatorDeps
  private readonly setTimer: (fn: () => void, delayMs: number) => InterruptedTurnResumeTimer
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly pending = new Map<string, InterruptedTurnResumeTimer>()
  private shuttingDown = false

  constructor(deps: InterruptedTurnResumeCoordinatorDeps) {
    this.deps = deps
    this.setTimer = deps.setTimer ?? defaultSetTimer
    this.baseDelayMs = deps.baseDelayMs ?? DEFAULT_INTERRUPTED_RESUME_BASE_DELAY_MS
    this.maxDelayMs = deps.maxDelayMs ?? DEFAULT_INTERRUPTED_RESUME_MAX_DELAY_MS
  }

  /**
   * Resume a turn stranded by a runtime restart (startup path). Launches
   * immediately after re-validation; the caller has already persisted the
   * per-process resume marker, so a crash shortly after this call will not
   * auto-resume the same thread again before the cooldown elapses.
   */
  async resumeInterrupted(threadId: string): Promise<boolean> {
    if (this.shuttingDown) return false
    try {
      if (await this.deps.isThreadBusy(threadId)) return false
      if (!(await this.deps.canResume(threadId))) return false
      try {
        await this.deps.launch(threadId)
      } catch (error) {
        if (isTurnCapacityError(error)) {
          // The runtime is temporarily at capacity; retry later without
          // burning the resume marker (no model turn ran).
          this.defer(threadId)
          return false
        }
        throw error
      }
      await this.deps.markResumed(threadId)
      return true
    } catch (error) {
      this.log(`interrupted turn resume on startup failed for ${threadId}: ${String(error)}`)
      return false
    }
  }

  /**
   * Retry a launch that could not start because the runtime is temporarily at
   * its global turn capacity. Backs off; the resume marker is only persisted
   * once a launch actually succeeds, so a capacity rejection never burns the
   * thread's resume budget.
   */
  defer(threadId: string): void {
    if (this.shuttingDown) return
    const existing = this.pending.get(threadId)
    if (existing) return
    const schedule = (attempt: number): void => {
      const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempt, 4))
      this.pending.set(threadId, this.setTimer(() => {
        this.pending.delete(threadId)
        void this.fire(threadId, () => schedule(attempt + 1))
      }, delayMs))
    }
    schedule(0)
  }

  /** Cancel any pending resume; called on runtime shutdown. */
  shutdown(): void {
    this.shuttingDown = true
    for (const timer of this.pending.values()) timer.cancel()
    this.pending.clear()
  }

  private async fire(threadId: string, reschedule: () => void): Promise<void> {
    if (this.shuttingDown) return
    try {
      if (await this.deps.isThreadBusy(threadId)) return
      if (!(await this.deps.canResume(threadId))) return
      try {
        await this.deps.launch(threadId)
      } catch (error) {
        // A capacity rejection keeps the thread eligible and retries without
        // burning the marker; other failures are logged and dropped so a
        // permanently broken thread cannot retry forever.
        if (isTurnCapacityError(error)) {
          reschedule()
          return
        }
        this.log(`interrupted turn resume launch failed for ${threadId}: ${String(error)}`)
        return
      }
      await this.deps.markResumed(threadId)
    } catch (error) {
      this.log(`interrupted turn resume validation failed for ${threadId}: ${String(error)}`)
    }
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message)
    else console.warn(`[kun] ${message}`)
  }
}

/**
 * Local duck-typed capacity check so the coordinator does not import the
 * TurnService error class (the injected launch re-throws it unchanged).
 */
function isTurnCapacityError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'TurnCapacityError'
  )
}
