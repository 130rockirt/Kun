import { describe, expect, it } from 'vitest'
import {
  openCodeGoCookieDatabasePaths,
  parseClaudeSubscriptionQuota,
  parseCodexSubscriptionQuota,
  parseCursorSubscriptionQuota,
  parseGrokSubscriptionQuota,
  parseGoogleCodeAssistQuota,
  resolveOpenCodeGoCookie
} from './provider-subscription-quota.js'

function grokBillingFrame(usedPercent: number, resetEpoch: number): Uint8Array {
  const float = Buffer.alloc(4)
  float.writeFloatLE(usedPercent)
  const varint: number[] = []
  let remaining = resetEpoch
  do {
    const next = remaining % 128
    remaining = Math.floor(remaining / 128)
    varint.push(next | (remaining > 0 ? 0x80 : 0))
  } while (remaining > 0)
  const payload = Buffer.concat([Buffer.from([0x0d]), float, Buffer.from([0x10, ...varint])])
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return new Uint8Array(frame)
}

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
      },
      additional_rate_limits: [{
        metered_feature: 'codex_spark',
        rate_limit: {
          primary_window: {
            used_percent: 8,
            limit_window_seconds: 604_800
          }
        }
      }]
    })).toMatchObject({
      summary: 'plus',
      metrics: [
        expect.objectContaining({ id: 'primary', usedPercent: 12 }),
        expect.objectContaining({ id: 'secondary', usedPercent: 64 }),
        expect.objectContaining({
          id: 'additional-0-primary',
          label: 'Spark - 1-week usage',
          usedPercent: 8
        })
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

  it('parses Grok gRPC-web billing frames', () => {
    expect(parseGrokSubscriptionQuota(
      grokBillingFrame(42.5, 1_900_000_000),
      new Date('2027-01-01T00:00:00Z')
    )).toEqual([{
      id: 'credits',
      label: 'Credits usage',
      unit: 'percent',
      usedPercent: 42.5,
      resetsAt: '2030-03-17T17:46:40.000Z'
    }])
  })
})

describe('resolveOpenCodeGoCookie', () => {
  it('returns an auth cookie header when a browser has one', async () => {
    await expect(resolveOpenCodeGoCookie({
      cookieDatabasePaths: ['/browsers/chrome/Cookies'],
      readCookies: async () => [
        { name: 'session', value: 'ignored' },
        { name: 'auth', value: 'session-token' },
        { name: '__Host-auth', value: 'host-token' }
      ]
    })).resolves.toBe('auth=session-token; __Host-auth=host-token')
  })

  it('tries the next cookie database when the first one fails', async () => {
    const calls: string[] = []
    await expect(resolveOpenCodeGoCookie({
      cookieDatabasePaths: ['/first/Cookies', '/second/Cookies'],
      readCookies: async (databasePath) => {
        calls.push(databasePath)
        if (databasePath === '/first/Cookies') throw new Error('locked')
        return [{ name: 'auth', value: 'second-token' }]
      }
    })).resolves.toBe('auth=second-token')
    expect(calls).toEqual(['/first/Cookies', '/second/Cookies'])
  })

  it('ignores non-auth cookies and encrypted v10 values', async () => {
    await expect(resolveOpenCodeGoCookie({
      cookieDatabasePaths: ['/browsers/chrome/Cookies'],
      readCookies: async () => [
        { name: 'session', value: 'plain' },
        { name: 'auth', value: 'v10encryptedvalue' }
      ]
    })).resolves.toBeUndefined()
  })

  it('returns undefined when every database fails', async () => {
    await expect(resolveOpenCodeGoCookie({
      cookieDatabasePaths: ['/missing/Cookies'],
      readCookies: async () => {
        throw new Error('no such table')
      }
    })).resolves.toBeUndefined()
  })

  it('resolves platform cookie database paths', () => {
    const darwin = openCodeGoCookieDatabasePaths({
      platform: 'darwin',
      environment: {},
      homeDirectory: '/Users/kun'
    })
    expect(darwin).toEqual(expect.arrayContaining([
      '/Users/kun/Library/Application Support/Google/Chrome/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Arc/User Data/Default/Network/Cookies'
    ]))
    const windows = openCodeGoCookieDatabasePaths({
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\Kun\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\Kun'
    })
    expect(windows[0]).toBe('C:\\Users\\Kun\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies')
  })
})
