import { describe, expect, it } from 'vitest'
import {
  parseClaudeSubscriptionQuota,
  parseCodexSubscriptionQuota,
  parseCursorSubscriptionQuota,
  parseGoogleCodeAssistQuota
} from './provider-subscription-quota.js'

describe('subscription provider quota parsers', () => {
  it('parses Claude and Codex utilization windows', () => {
    expect(parseClaudeSubscriptionQuota({
      five_hour: { utilization: 18, resets_at: '2026-07-28T05:00:00.000Z' },
      seven_day: { utilization: 45, resets_at: '2026-08-03T00:00:00.000Z' }
    })).toEqual([
      expect.objectContaining({ id: 'five-hour', usedPercent: 18 }),
      expect.objectContaining({ id: 'seven-day', usedPercent: 45 })
    ])

    expect(parseCodexSubscriptionQuota({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 12,
          reset_at: 1_775_000_000
        },
        secondary_window: {
          used_percent: 64,
          reset_after_seconds: 3_600
        }
      }
    })).toMatchObject({
      summary: 'plus',
      metrics: [
        expect.objectContaining({ id: 'primary', usedPercent: 12 }),
        expect.objectContaining({ id: 'secondary', usedPercent: 64 })
      ]
    })
  })

  it('parses Cursor included usage and Google model buckets', () => {
    expect(parseCursorSubscriptionQuota({
      membershipType: 'pro',
      billingCycleEnd: '2026-08-01T00:00:00.000Z',
      individualUsage: {
        plan: {
          used: 12,
          limit: 20,
          totalPercentUsed: 60,
          autoPercentUsed: 25
        }
      }
    })).toMatchObject({
      summary: 'pro',
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: 'included-plan', usedPercent: 60 }),
        expect.objectContaining({ id: 'auto-composer', usedPercent: 25 })
      ])
    })

    expect(parseGoogleCodeAssistQuota({
      buckets: [{
        modelId: 'gemini-2.5-pro',
        remainingFraction: 0.72,
        resetTime: '2026-07-28T02:00:00.000Z'
      }]
    })[0]).toMatchObject({
      label: 'gemini-2.5-pro',
      usedPercent: 28
    })
  })
})
