import { useEffect, type ReactElement } from 'react'
import { usePlanWorktreeStore } from './plan-worktree-store'

const RECONCILE_INTERVAL_MS = 5_000
const RECOVERABLE_ADMISSION_ATTENTION_REASONS = new Set([
  'thread_attach_failed',
  'turn_admission_failed'
])

/**
 * App-wide recovery loop. It is intentionally independent of the currently
 * open plan/thread so work completed while the app was closed is discovered
 * as soon as Kun reconnects.
 */
export function PlanWorktreeGlobalRecovery({
  runtimeReady
}: {
  runtimeReady: boolean
}): ReactElement | null {
  const upsertRun = usePlanWorktreeStore((state) => state.upsertRun)

  useEffect(() => {
    if (!runtimeReady || !window.kunGui?.planWorktree) return
    let cancelled = false
    let inFlight = false
    const reconcile = async (): Promise<void> => {
      if (inFlight || cancelled) return
      inFlight = true
      try {
        const runs = await window.kunGui.planWorktree.list({ includeCompleted: false })
        for (const run of runs) {
          if (cancelled) return
          try {
            let latest = await window.kunGui.planWorktree.reconcile({ runId: run.runId })
            if (
              latest.executionThreadId && !latest.executionTurnId &&
              (latest.status === 'executing' || (
                latest.status === 'needs_attention' &&
                RECOVERABLE_ADMISSION_ATTENTION_REASONS.has(latest.attentionReason ?? '')
              ))
            ) {
              latest = await window.kunGui.planWorktree.resumeAdmission({ runId: latest.runId })
            }
            if (!cancelled) upsertRun(latest)
          } catch {
            // Old records without an immutable admission snapshot fail closed;
            // continue recovering unrelated runs on this bounded pass.
            if (!cancelled) upsertRun(run)
          }
        }
      } catch {
        // Runtime/host startup races are retried on the next bounded pass.
      } finally {
        inFlight = false
      }
    }
    void reconcile()
    const timer = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [runtimeReady, upsertRun])

  return null
}
