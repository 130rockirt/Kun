import { describe, expect, it, vi } from 'vitest'
import {
  startMemoryPressureMonitor,
  type MemoryPressureMonitorDeps
} from './memory-pressure-monitor.js'

function makeDeps(overrides: Partial<MemoryPressureMonitorDeps> = {}): MemoryPressureMonitorDeps {
  const compact = vi.fn().mockImplementation(async (input: { threadId: string }) => ({
    threadId: input.threadId,
    replacedTokens: input.threadId === 'thread-1' ? 100 : 0,
    summary: '',
    pinnedConstraints: []
  }))
  return {
    config: {
      enabled: true,
      pollIntervalMs: 10,
      warnRssBytes: 100,
      criticalRssBytes: 200,
      maxCompactionsPerSweep: 2
    },
    threadStore: {
      list: async () => [
        { id: 'thread-1', status: 'idle', relation: 'primary', updatedAt: '2026-08-10T00:00:00.000Z' },
        { id: 'thread-2', status: 'running', relation: 'primary', updatedAt: '2026-08-10T00:00:00.000Z' }
      ]
    } as unknown as MemoryPressureMonitorDeps['threadStore'],
    turnService: {
      compact
    } as unknown as MemoryPressureMonitorDeps['turnService'],
    events: {
      record: vi.fn().mockResolvedValue(undefined)
    } as unknown as MemoryPressureMonitorDeps['events'],
    instanceId: 'instance-1',
    requestShutdown: vi.fn().mockResolvedValue(true),
    ...overrides
  }
}

describe('startMemoryPressureMonitor', () => {
  it('compacts idle thread histories when RSS crosses the warning watermark', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 150 } as never)
    const deps = makeDeps()
    const monitor = startMemoryPressureMonitor(deps)

    // Wait for the first poll tick.
    await new Promise((resolve) => setTimeout(resolve, 40))
    monitor.stop()

    expect(deps.turnService.compact).toHaveBeenCalled()
    // thread-2 is running and must be skipped.
    const compacted = (deps.turnService.compact as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].threadId)
    expect(compacted).toContain('thread-1')
    expect(compacted).not.toContain('thread-2')
    vi.restoreAllMocks()
  })

  it('requests a graceful shutdown when RSS crosses the critical watermark', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 250 } as never)
    const deps = makeDeps()
    const monitor = startMemoryPressureMonitor(deps)

    await new Promise((resolve) => setTimeout(resolve, 40))
    monitor.stop()

    expect(deps.requestShutdown).toHaveBeenCalledWith('instance-1')
    vi.restoreAllMocks()
  })

  it('stops polling after stop()', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 150 } as never)
    const deps = makeDeps()
    const monitor = startMemoryPressureMonitor(deps)
    monitor.stop()
    const callsBefore = (deps.events.record as ReturnType<typeof vi.fn>).mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect((deps.events.record as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)
    vi.restoreAllMocks()
  })
})
