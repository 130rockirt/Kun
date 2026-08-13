import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import { UsageService } from '../services/usage-service-core.js'
import { seedUsageCarryover } from './runtime-factory-storage.js'

describe('seedUsageCarryover', () => {
  it('bounds event replay fallback concurrency when usage snapshots are unavailable', async () => {
    let active = 0
    let peak = 0
    const sessionStore = {
      loadLatestUsageSnapshots: async () => { throw new Error('index unavailable') },
      iterateEventsSince: async function* () {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
      }
    } as unknown as SessionStore
    const threadStore = {
      list: async () => Array.from({ length: 20 }, (_, index) => ({ id: `thread-${index}` }))
    } as unknown as ThreadStore

    await seedUsageCarryover({
      threadStore,
      sessionStore,
      usageService: new UsageService()
    })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})
