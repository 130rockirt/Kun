import { describe, expect, it } from 'vitest'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { loadUsageHistory } from './usage-history.js'

describe('loadUsageHistory provider attribution', () => {
  it('recovers providerId from the matching turn for indexed usage records', async () => {
    const thread = {
      id: 'thread-glm',
      model: 'glm-5.3',
      providerId: 'fallback-provider',
      updatedAt: '2026-08-22T00:00:01.000Z',
      turns: [{
        id: 'turn-glm',
        model: 'glm-5.3',
        providerId: 'zhipu-coding-plan'
      }]
    }
    const source = {
      threadService: {
        list: async () => [],
        get: async () => thread
      },
      sessionStore: {
        loadUsageRecords: async () => [{
          threadId: 'thread-glm',
          turnId: 'turn-glm',
          model: 'glm-5.3',
          completedAt: '2026-08-22T00:00:00.000Z',
          usage: {
            ...emptyUsageSnapshot(),
            promptTokens: 1_000,
            completionTokens: 100,
            totalTokens: 1_100,
            turns: 1
          }
        }],
        loadLatestUsageSnapshots: async () => [{
          threadId: 'thread-glm',
          usage: {
            ...emptyUsageSnapshot(),
            promptTokens: 1_000,
            completionTokens: 100,
            totalTokens: 1_100,
            turns: 1
          }
        }]
      },
      usageService: { forThread: () => emptyUsageSnapshot() },
      nowIso: () => '2026-08-22T00:00:02.000Z'
    }

    const records = await loadUsageHistory(source as never, { threadId: 'thread-glm' })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      threadId: 'thread-glm',
      turnId: 'turn-glm',
      model: 'glm-5.3',
      providerId: 'zhipu-coding-plan'
    })
  })
})
