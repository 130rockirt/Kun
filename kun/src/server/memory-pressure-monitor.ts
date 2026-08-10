import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'

/**
 * kun serve memory-pressure monitor.
 *
 * The feedback driving this: Kun being killed by OOM/compaction pressure is an
 * interruption the user has to manually explain afterwards. The runtime cannot
 * snapshot memory, but it can act before the kill:
 *
 * - Level 1 (warning): log + emit a `memory_pressure_warning` event and fold
 *   the largest idle thread histories via automatic compaction, releasing the
 *   biggest in-process item buffers.
 * - Level 2 (critical): emit `memory_pressure_critical` and request a graceful
 *   shutdown. `runtime.shutdown` already parks running turns (host-shutdown
 *   suspension) before closing stores, so a supervisor restart finds the work
 *   resumable instead of a hard OOM kill.
 *
 * Thresholds default to sane values and can be tuned via config
 * (`runtime.memoryPressure`) or environment variables, so operators can tune
 * without code changes.
 */

export type MemoryPressureMonitorConfig = {
  enabled?: boolean
  pollIntervalMs?: number
  warnRssBytes?: number
  criticalRssBytes?: number
  /** Max idle threads compacted per warning sweep (bounds the cost). */
  maxCompactionsPerSweep?: number
}

export type MemoryPressureMonitorDeps = {
  config?: MemoryPressureMonitorConfig
  threadStore: ThreadStore
  turnService: Pick<TurnService, 'compact'>
  events: Pick<RuntimeEventRecorder, 'record'>
  instanceId: string
  requestShutdown: (instanceId: string) => Promise<boolean>
  log?: (message: string) => void
}

export const DEFAULT_MEMORY_PRESSURE_POLL_INTERVAL_MS = 15_000
export const DEFAULT_MEMORY_PRESSURE_WARN_RSS_BYTES = 1_610_612_736 // 1.5 GiB
export const DEFAULT_MEMORY_PRESSURE_CRITICAL_RSS_BYTES = 2_684_354_560 // 2.5 GiB
export const DEFAULT_MEMORY_PRESSURE_MAX_COMPACTIONS_PER_SWEEP = 3

export type MemoryPressureMonitor = {
  stop: () => void
}

function envNumber(name: string): number | undefined {
  const value = process.env[name]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function startMemoryPressureMonitor(deps: MemoryPressureMonitorDeps): MemoryPressureMonitor {
  const config = deps.config ?? {}
  const pollIntervalMs =
    config.pollIntervalMs ??
    envNumber('KUN_MEMORY_POLL_INTERVAL_MS') ??
    DEFAULT_MEMORY_PRESSURE_POLL_INTERVAL_MS
  const warnRssBytes =
    config.warnRssBytes ??
    envNumber('KUN_MEMORY_WARN_RSS_BYTES') ??
    DEFAULT_MEMORY_PRESSURE_WARN_RSS_BYTES
  const criticalRssBytes =
    config.criticalRssBytes ??
    envNumber('KUN_MEMORY_CRITICAL_RSS_BYTES') ??
    DEFAULT_MEMORY_PRESSURE_CRITICAL_RSS_BYTES
  const maxCompactionsPerSweep =
    config.maxCompactionsPerSweep ?? DEFAULT_MEMORY_PRESSURE_MAX_COMPACTIONS_PER_SWEEP

  let stopped = false
  let currentLevel: 'ok' | 'warn' | 'critical' = 'ok'
  let sweeping = false
  let criticalExitRequested = false

  const log = deps.log ?? ((message: string) => console.warn(`[kun] ${message}`))

  const poll = (): void => {
    if (stopped) return
    try {
      const rss = process.memoryUsage().rss
      const nextLevel: 'ok' | 'warn' | 'critical' =
        rss >= criticalRssBytes ? 'critical' : rss >= warnRssBytes ? 'warn' : 'ok'
      // Edge-trigger on upward transitions only, so a steady high watermark
      // logs once instead of spamming every poll.
      if (nextLevel === currentLevel) return
      const previous = currentLevel
      currentLevel = nextLevel
      if (nextLevel === 'ok') return

      const rssMb = Math.round(rss / (1024 * 1024))
      if (nextLevel === 'critical') {
        log(`memory pressure critical: rss=${rssMb}MiB; requesting graceful shutdown`)
        void deps.events.record({
          kind: 'error',
          threadId: '',
          message: `Runtime memory pressure reached the critical threshold (${rssMb} MiB RSS). Suspending active work and exiting gracefully so it can be resumed after restart.`,
          code: 'memory_pressure_critical',
          severity: 'error'
        }).catch(() => undefined)
        if (!criticalExitRequested) {
          criticalExitRequested = true
          void deps.requestShutdown(deps.instanceId).catch(() => undefined)
        }
        return
      }

      // warn: fold idle thread histories to release in-process item buffers.
      log(`memory pressure warning: rss=${rssMb}MiB; compacting idle thread histories`)
      void deps.events.record({
        kind: 'error',
        threadId: '',
        message: `Runtime memory pressure warning (${rssMb} MiB RSS). Compacting idle thread histories to reduce memory use.`,
        code: 'memory_pressure_warning',
        severity: 'warning'
      }).catch(() => undefined)
      if (previous === 'ok') void sweepIdleThreads()
    } catch (error) {
      log(`memory pressure check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sweepIdleThreads = async (): Promise<void> => {
    if (sweeping || stopped) return
    sweeping = true
    try {
      const summaries = await deps.threadStore.list({ includeSide: false })
      const idle = summaries
        .filter((summary) => summary.status !== 'running' && summary.relation !== 'side')
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
        .slice(0, maxCompactionsPerSweep)
      let compacted = 0
      for (const summary of idle) {
        try {
          const result = await deps.turnService.compact({
            threadId: summary.id,
            request: { reason: 'memory_pressure' },
            auto: true
          })
          if (result.replacedTokens > 0) compacted += 1
        } catch {
          // One unreadable/busy thread must not stop the sweep.
        }
      }
      if (compacted > 0) {
        log(`memory pressure sweep compacted ${compacted} thread(s)`)
      }
    } catch (error) {
      log(`memory pressure sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      sweeping = false
    }
  }

  const handle = setInterval(poll, pollIntervalMs)
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    ;(handle as { unref: () => void }).unref()
  }

  return {
    stop: () => {
      stopped = true
      clearInterval(handle)
    }
  }
}
