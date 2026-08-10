import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCompactionScheduler } from './session-compaction-scheduler.js'

describe('SessionCompactionScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces repeated schedules into one run after the debounce window', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const scheduler = new SessionCompactionScheduler({
      delayMs: 100,
      run: async (threadId, kind) => {
        runs.push(`${kind}:${threadId}`)
      }
    })
    scheduler.schedule('thr_1', 'items')
    scheduler.schedule('thr_1', 'items')
    scheduler.schedule('thr_1', 'items')
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    await scheduler.flush('thr_1')
    expect(runs).toEqual(['items:thr_1'])
    await scheduler.close()
  })

  it('does not await compaction work on schedule()', async () => {
    let started = false
    const scheduler = new SessionCompactionScheduler({
      delayMs: 50,
      run: async () => {
        started = true
      }
    })
    const before = Date.now()
    scheduler.schedule('thr_block', 'usage')
    expect(Date.now() - before).toBeLessThan(20)
    expect(started).toBe(false)
    // Drop the pending timer without waiting for a hangable in-flight run.
    await scheduler.close()
  })
})
