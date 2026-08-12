import type { ThreadStore } from '../ports/thread-store.js'
import type { SessionStore } from '../ports/session-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'

/**
 * kun serve memory-pressure monitor.
 *
 * The feedback driving this: Kun being killed by OOM/compaction pressure is an
 * interruption the user has to manually explain afterwards. The runtime cannot
 * snapshot memory, but it can act before the kill:
 *
 * - Level 1 (warning): publish `memory_pressure_warning` to every active
 *   thread, evict rebuildable Session caches, compact a bounded number of idle
 *   histories, and cap new subagent admission at two.
 * - Level 2 (critical): publish `memory_pressure_critical`, cap new subagent
 *   admission at one, and request a graceful shutdown. `runtime.shutdown`
 *   parks running turns before closing stores, so restart recovery can resume
 *   them instead of misclassifying the stop as user cancellation.
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
  sessionStore: Pick<SessionStore, 'resetMemory'>
  turnService: Pick<TurnService, 'compact'>
  events: Pick<RuntimeEventRecorder, 'record'>
  instanceId: string
  requestShutdown: (instanceId: string) => Promise<boolean>
  setSubagentParallelLimit?: (limit?: number) => void
  log?: (message: string) => void
}

export const DEFAULT_MEMORY_PRESSURE_POLL_INTERVAL_MS = 15_000
export const DEFAULT_MEMORY_PRESSURE_WARN_RSS_BYTES = 3_221_225_472 // 3 GiB
export const DEFAULT_MEMORY_PRESSURE_CRITICAL_RSS_BYTES = 5_368_709_120 // 5 GiB
export const DEFAULT_MEMORY_PRESSURE_MAX_COMPACTIONS_PER_SWEEP = 3
export const DEFAULT_MEMORY_PRESSURE_SUBAGENT_PARALLEL_LIMIT = 2

export type MemoryPressureMonitor = {
  stop: () => void
}

type MemorySnapshot = {
  rssMiB: number
  heapTotalMiB: number
  heapUsedMiB: number
  externalMiB: number
  arrayBuffersMiB: number
}

type ActiveWork = {
  threadId: string
  turnIds: string[]
}

function toMiB(value: number): number {
  return Number.isFinite(value) ? Math.round(value / (1024 * 1024)) : 0
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage()
  return {
    rssMiB: toMiB(memory.rss),
    heapTotalMiB: toMiB(memory.heapTotal),
    heapUsedMiB: toMiB(memory.heapUsed),
    externalMiB: toMiB(memory.external),
    arrayBuffersMiB: toMiB(memory.arrayBuffers)
  }
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
      deps.setSubagentParallelLimit?.(
        nextLevel === 'ok'
          ? undefined
          : nextLevel === 'critical'
            ? 1
            : DEFAULT_MEMORY_PRESSURE_SUBAGENT_PARALLEL_LIMIT
      )
      if (nextLevel === 'ok') return

      const memory = memorySnapshot()
      if (nextLevel === 'critical') {
        if (!criticalExitRequested) {
          criticalExitRequested = true
          void handleCritical(memory)
        }
        return
      }

      if (previous === 'ok') void handleWarning(memory)
    } catch (error) {
      log(`memory pressure check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const listActiveWork = async (): Promise<{
    active: ActiveWork[]
    summaries: Awaited<ReturnType<ThreadStore['list']>>
  }> => {
    const summaries = await deps.threadStore.list({ includeSide: true })
    const activeSummaries = summaries.filter((summary) => summary.status === 'running')
    const active = await Promise.all(activeSummaries.map(async (summary) => {
      const metadata = deps.threadStore.getMetadata
        ? await deps.threadStore.getMetadata(summary.id).catch(() => null)
        : null
      return {
        threadId: summary.id,
        turnIds: metadata?.turns
          .filter((turn) => turn.status === 'queued' || turn.status === 'running')
          .map((turn) => turn.id) ?? []
      }
    }))
    return { active, summaries }
  }

  const recordPressure = async (
    level: 'warning' | 'critical',
    memory: MemorySnapshot,
    active: ActiveWork[]
  ): Promise<void> => {
    const affectedThreadIds = active.map((work) => work.threadId)
    const affectedTurnIds = active.flatMap((work) => work.turnIds)
    const details = {
      event: level === 'critical' ? 'runtime_shutdown' : 'memory_pressure',
      reason: 'memory_pressure',
      level,
      instanceId: deps.instanceId,
      ...memory,
      affectedThreadIds,
      affectedTurnIds,
      timestamp: new Date().toISOString()
    }
    log(JSON.stringify(details))
    await Promise.allSettled(active.map((work) => deps.events.record({
      kind: 'error',
      threadId: work.threadId,
      ...(work.turnIds[0] ? { turnId: work.turnIds[0] } : {}),
      itemId: `runtime_memory_pressure_${level}_${deps.instanceId}`,
      message: level === 'critical'
        ? `Agent Runtime reached ${memory.rssMiB} MiB RSS. Active work is being suspended and the Runtime will restart automatically.`
        : `Agent Runtime memory usage reached ${memory.rssMiB} MiB RSS. New subagents are temporarily limited while memory is reclaimed.`,
      code: level === 'critical' ? 'memory_pressure_critical' : 'memory_pressure_warning',
      details,
      severity: level === 'critical' ? 'error' : 'warning'
    })))
  }

  const handleCritical = async (memory: MemorySnapshot): Promise<void> => {
    try {
      const { active } = await listActiveWork()
      await recordPressure('critical', memory, active)
    } catch (error) {
      log(`memory pressure critical diagnostics failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await deps.requestShutdown(deps.instanceId).catch(() => false)
    }
  }

  const handleWarning = async (memory: MemorySnapshot): Promise<void> => {
    try {
      const { active, summaries } = await listActiveWork()
      await recordPressure('warning', memory, active)
      await deps.sessionStore.resetMemory()
      await sweepIdleThreads(summaries)
    } catch (error) {
      log(`memory pressure warning handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sweepIdleThreads = async (
    summaries: Awaited<ReturnType<ThreadStore['list']>>
  ): Promise<void> => {
    if (sweeping || stopped) return
    sweeping = true
    try {
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
      deps.setSubagentParallelLimit?.(undefined)
      clearInterval(handle)
    }
  }
}
