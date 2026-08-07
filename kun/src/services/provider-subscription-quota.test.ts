import { createCipheriv, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveChromiumSafeStorageKey } from './chromium-browser-cookies.js'
import { OpenCodeGoWebQuotaError } from './opencode-go-web-quota.js'
import {
  clearOpenCodeGoCookieCache,
  getOpenCodeGoCookieFailureReason,
  OPENCODE_GO_COOKIE_ENV,
  OPENCODE_GO_KEYCHAIN_MESSAGE,
  OPENCODE_GO_SIGN_IN_MESSAGE,
  openCodeGoCookieDatabasePaths,
  parseClaudeSubscriptionQuota,
  parseCodexSubscriptionQuota,
  parseCursorSubscriptionQuota,
  parseGrokSubscriptionQuota,
  parseGoogleCodeAssistQuota,
  resolveOpenCodeGoCookie,
  resolveOpenCodeGoCookieResult,
  runSubscriptionQuotaProbe
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
  afterEach(() => {
    clearOpenCodeGoCookieCache()
  })

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

  it('resolves platform cookie database paths including Comet and Chrome Beta', () => {
    const darwin = openCodeGoCookieDatabasePaths({
      platform: 'darwin',
      environment: {},
      homeDirectory: '/Users/kun'
    })
    expect(darwin).toEqual(expect.arrayContaining([
      '/Users/kun/Library/Application Support/Google/Chrome/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Google/Chrome Beta/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Arc/User Data/Default/Network/Cookies',
      '/Users/kun/Library/Application Support/Comet/Default/Cookies',
      '/Users/kun/Library/Application Support/Dia/User Data/Default/Cookies'
    ]))
    const windows = openCodeGoCookieDatabasePaths({
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\Kun\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\Kun'
    })
    expect(windows[0]).toBe('C:\\Users\\Kun\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies')
  })

  it('decrypts Safe Storage cookies when resolving OpenCode Go auth', async () => {
    await expect(resolveOpenCodeGoCookie({
      platform: 'darwin',
      cookieDatabasePaths: ['/browsers/comet/Cookies'],
      readSafeStoragePassword: async () => 'unused-because-readCookies-wins',
      readCookies: async () => [
        { name: 'auth', value: 'comet-session' }
      ]
    })).resolves.toBe('auth=comet-session')
  })

  it('prefers a manual Cookie header and the KUN_OPENCODE_GO_COOKIE env', async () => {
    await expect(resolveOpenCodeGoCookieResult({
      environment: { [OPENCODE_GO_COOKIE_ENV]: 'auth=env-token; oc_locale=en' },
      platform: 'linux'
    })).resolves.toEqual({
      cookieHeader: 'auth=env-token',
      source: 'manual'
    })

    await expect(resolveOpenCodeGoCookieResult({
      manualCookieHeader: 'Cookie: auth=manual-token',
      environment: {},
      platform: 'linux',
      bypassCache: true
    })).resolves.toEqual({
      cookieHeader: 'auth=manual-token',
      source: 'manual'
    })
  })

  it('reuses a memory-cached cookie until the cache is cleared', async () => {
    await expect(resolveOpenCodeGoCookieResult({
      manualCookieHeader: 'auth=cached-token',
      environment: {},
      platform: 'linux'
    })).resolves.toMatchObject({ cookieHeader: 'auth=cached-token', source: 'manual' })

    await expect(resolveOpenCodeGoCookieResult({
      environment: {},
      platform: 'linux'
    })).resolves.toEqual({
      cookieHeader: 'auth=cached-token',
      source: 'cache'
    })

    clearOpenCodeGoCookieCache()
    await expect(resolveOpenCodeGoCookieResult({
      environment: {},
      platform: 'linux',
      cookieDatabasePaths: ['/missing/Cookies'],
      readCookies: async () => []
    })).resolves.toEqual({ failureReason: 'not_found' })
    expect(getOpenCodeGoCookieFailureReason()).toBe('not_found')
  })

  it('reports decrypt_failed when encrypted browser auth cannot be unlocked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kun-opencode-cookie-'))
    const databasePath = join(directory, 'Cookies')
    const key = deriveChromiumSafeStorageKey('secret')
    const encrypted = encryptV10Cookie('token', key, 'opencode.ai', 24)
    createCookieDatabase(databasePath, [
      { hostKey: 'opencode.ai', name: 'auth', value: '', encryptedHex: encrypted.toString('hex') }
    ])

    await expect(resolveOpenCodeGoCookieResult({
      platform: 'darwin',
      environment: {},
      bypassCache: true,
      cookieDatabasePaths: [databasePath],
      readSafeStoragePassword: async () => undefined
    })).resolves.toEqual({ failureReason: 'decrypt_failed' })
    expect(getOpenCodeGoCookieFailureReason()).toBe('decrypt_failed')
  })

  it('surfaces the Keychain message when decrypt fails and local history is empty', async () => {
    await expect(runSubscriptionQuotaProbe(
      'opencode-go-local',
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        kind: 'http',
        apiKey: ''
      },
      {
        fetcher: async () => new Response('unused'),
        proxyUrl: ''
      },
      {
        resolveOpenCodeGoCookie: async () => undefined,
        resolveOpenCodeGoQuota: async () => undefined
      }
    )).rejects.toThrow(OPENCODE_GO_SIGN_IN_MESSAGE)

    const directory = mkdtempSync(join(tmpdir(), 'kun-opencode-probe-'))
    const databasePath = join(directory, 'Cookies')
    const key = deriveChromiumSafeStorageKey('secret')
    createCookieDatabase(databasePath, [
      {
        hostKey: 'opencode.ai',
        name: 'auth',
        value: '',
        encryptedHex: encryptV10Cookie('token', key, 'opencode.ai', 24).toString('hex')
      }
    ])
    clearOpenCodeGoCookieCache()
    await resolveOpenCodeGoCookieResult({
      platform: 'darwin',
      environment: {},
      bypassCache: true,
      cookieDatabasePaths: [databasePath],
      readSafeStoragePassword: async () => undefined
    })

    await expect(runSubscriptionQuotaProbe(
      'opencode-go-local',
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        kind: 'http',
        apiKey: ''
      },
      {
        fetcher: async () => new Response('unused'),
        proxyUrl: ''
      },
      {
        resolveOpenCodeGoCookie: async () => undefined,
        resolveOpenCodeGoQuota: async () => undefined
      }
    )).rejects.toThrow(OPENCODE_GO_KEYCHAIN_MESSAGE)
  })

  it('clears the cookie cache and retries after invalid_credentials', async () => {
    clearOpenCodeGoCookieCache()
    await resolveOpenCodeGoCookieResult({
      manualCookieHeader: 'auth=stale-token',
      environment: {},
      platform: 'linux'
    })

    let cookieCalls = 0
    let webCalls = 0
    const result = await runSubscriptionQuotaProbe(
      'opencode-go-local',
      {
        id: 'opencode-go',
        name: 'OpenCode Go',
        kind: 'http',
        apiKey: ''
      },
      {
        fetcher: async () => new Response('unused'),
        proxyUrl: ''
      },
      {
        resolveOpenCodeGoCookie: async () => {
          cookieCalls += 1
          return cookieCalls === 1 ? 'auth=stale-token' : 'auth=fresh-token'
        },
        resolveOpenCodeGoQuota: async () => undefined,
        fetchOpenCodeGoWebQuota: async (cookieHeader) => {
          webCalls += 1
          if (cookieHeader.includes('stale-token')) {
            throw new OpenCodeGoWebQuotaError('expired', 'invalid_credentials')
          }
          return {
            metrics: [{
              id: 'five-hour',
              label: '5-hour usage',
              unit: 'percent',
              used: 10,
              limit: 100,
              remaining: 90,
              usedPercent: 10
            }],
            summary: 'OpenCode Go subscription · wrk_fresh',
            dashboardUrl: 'https://opencode.ai',
            workspaceId: 'wrk_fresh'
          }
        }
      }
    )

    expect(result).toMatchObject({
      source: 'OpenCode Go subscription usage',
      summary: 'OpenCode Go subscription · wrk_fresh'
    })
    expect(cookieCalls).toBe(2)
    expect(webCalls).toBe(2)
  })
})

function createCookieDatabase(
  databasePath: string,
  rows: Array<{ hostKey: string; name: string; value: string; encryptedHex: string }>
): void {
  const binary = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3'
  const inserts = rows.map((row) => {
    const encryptedSql = row.encryptedHex ? `X'${row.encryptedHex}'` : `X''`
    return `INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES ('${row.hostKey}', '${row.name}', '${row.value}', ${encryptedSql});`
  }).join('\n')
  execFileSync(binary, [databasePath], {
    input: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE cookies (
        host_key TEXT,
        name TEXT,
        value TEXT,
        encrypted_value BLOB
      );
      INSERT INTO meta (key, value) VALUES ('version', '24');
      ${inserts}
    `,
    encoding: 'utf8'
  })
}

function encryptV10Cookie(
  plaintext: string,
  key: Buffer,
  hostKey: string,
  databaseVersion: number
): Buffer {
  const body = databaseVersion >= 24
    ? Buffer.concat([
      createHash('sha256').update(hostKey, 'utf8').digest(),
      Buffer.from(plaintext, 'utf8')
    ])
    : Buffer.from(plaintext, 'utf8')
  const iv = Buffer.alloc(16, 0x20)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'utf8'), encrypted])
}
