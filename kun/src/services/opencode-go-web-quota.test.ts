import { describe, expect, it } from 'vitest'
import {
  fetchOpenCodeGoWebQuota,
  filterOpenCodeGoCookieHeader,
  parseOpenCodeGoSubscription,
  OpenCodeGoWebQuotaError
} from './opencode-go-web-quota.js'

const workspacesServerId = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const authCookie = 'auth=session-token'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const usagePageJson = {
  rollingUsage: { usagePercent: 25, resetInSec: 3600 },
  weeklyUsage: { used: 9, limit: 30, resetInSec: 604800 },
  monthlyUsage: { used: 11, limit: 60, resetsAt: '2026-08-01T00:00:00.000Z' }
}

describe('filterOpenCodeGoCookieHeader', () => {
  it('keeps only auth and __Host-auth cookies', () => {
    expect(filterOpenCodeGoCookieHeader(
      'auth=a; __Host-auth=b; session=ignored; theme=dark'
    )).toBe('auth=a; __Host-auth=b')
    expect(filterOpenCodeGoCookieHeader('AUTH=x')).toBe('AUTH=x')
    expect(filterOpenCodeGoCookieHeader('Cookie: auth=manual; session=x')).toBe('auth=manual')
    expect(filterOpenCodeGoCookieHeader('session=only')).toBeUndefined()
    expect(filterOpenCodeGoCookieHeader(undefined)).toBeUndefined()
    expect(filterOpenCodeGoCookieHeader('')).toBeUndefined()
  })
})

describe('fetchOpenCodeGoWebQuota', () => {
  it('resolves workspace id from the _server response then parses the usage page', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.includes('/_server')) {
        return jsonResponse({ workspaces: [{ id: 'wrk_abc123' }] })
      }
      return jsonResponse(usagePageJson)
    }
    const result = await fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher,
      now: new Date('2026-07-28T01:31:00.000Z')
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toContain(`id=${workspacesServerId}`)
    expect(requests[1]!.url).toBe('https://opencode.ai/workspace/wrk_abc123/go')
    for (const { headers } of requests) {
      expect(headers.get('cookie')).toBe(authCookie)
      expect(headers.get('user-agent')).toContain('Chrome')
    }
    // The internal _server request carries OpenCode server headers; the page fetch does not.
    expect(requests[0]!.headers.get('origin')).toBe('https://opencode.ai')
    expect(requests[0]!.headers.get('referer')).toBe('https://opencode.ai')
    expect(requests[0]!.headers.get('x-server-id')).toBe(workspacesServerId)
    expect(requests[0]!.headers.get('x-server-instance')).toMatch(/^server-fn:/)
    expect(requests[1]!.headers.get('origin')).toBeNull()
    expect(result.workspaceId).toBe('wrk_abc123')
    expect(result.summary).toBe('OpenCode Go subscription · wrk_abc123')
    expect(result.dashboardUrl).toBe('https://opencode.ai/workspace/wrk_abc123/go')
    expect(result.metrics).toEqual([
      expect.objectContaining({ id: 'five-hour', usedPercent: 25, resetsAt: '2026-07-28T02:31:00.000Z' }),
      expect.objectContaining({ id: 'weekly', usedPercent: 30 }),
      expect.objectContaining({ id: 'monthly', usedPercent: 18.3 })
    ])
  })

  it('honors an explicit workspace override without querying _server', async () => {
    const fetcher = async (input: string | URL) => {
      if (String(input).includes('/_server')) {
        throw new Error('should not query workspace discovery')
      }
      return jsonResponse(usagePageJson)
    }
    const result = await fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher,
      workspaceId: 'https://opencode.ai/workspace/wrk_explicit/go'
    })
    expect(result.workspaceId).toBe('wrk_explicit')
  })

  it('throws invalid_credentials for a missing auth cookie', async () => {
    const fetcher = async () => jsonResponse(usagePageJson)
    await expect(fetchOpenCodeGoWebQuota({
      cookieHeader: 'session=only',
      fetcher
    })).rejects.toMatchObject({
      name: 'OpenCodeGoWebQuotaError',
      code: 'invalid_credentials'
    })
  })

  it('throws invalid_credentials for 401 responses', async () => {
    const fetcher = async () => new Response('denied', { status: 401 })
    await expect(fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher
    })).rejects.toMatchObject({ code: 'invalid_credentials' })
  })

  it('throws network error when the fetch rejects', async () => {
    const fetcher = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher
    })).rejects.toMatchObject({ code: 'network' })
  })

  it('throws api error for other non-ok statuses', async () => {
    const fetcher = async () => new Response('boom', { status: 500 })
    await expect(fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher
    })).rejects.toMatchObject({ code: 'api' })
  })

  it('throws parse error when usage fields are missing', async () => {
    const fetcher = async (input: string | URL) => {
      if (String(input).includes('/_server')) {
        return jsonResponse({ workspaces: [{ id: 'wrk_abc123' }] })
      }
      return new Response('<html>no usage fields</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    }
    await expect(fetchOpenCodeGoWebQuota({
      cookieHeader: authCookie,
      fetcher
    })).rejects.toMatchObject({ code: 'parse' })
  })
})

describe('parseOpenCodeGoSubscription', () => {
  it('parses JSON window fields', () => {
    const snapshot = parseOpenCodeGoSubscription(JSON.stringify(usagePageJson))
    expect(snapshot).toMatchObject({
      hasWeeklyUsage: true,
      hasMonthlyUsage: true,
      rollingUsagePercent: 25,
      weeklyUsagePercent: 30,
      monthlyUsagePercent: 18.3,
      rollingResetInSec: 3600
    })
  })

  it('parses nested JSON under data/usage keys', () => {
    const snapshot = parseOpenCodeGoSubscription(JSON.stringify({
      data: { usage: { rolling: { usedPercent: 42, resetInSec: 100 }, monthly: { usedPercent: 8, resetInSec: 200 } } }
    }))
    expect(snapshot).toMatchObject({
      rollingUsagePercent: 42,
      monthlyUsagePercent: 8,
      hasWeeklyUsage: false,
      hasMonthlyUsage: true
    })
  })

  it('falls back to embedded text fields from the page', () => {
    const text = [
      'const page = {',
      '  rollingUsage: { usagePercent: 12.5, resetInSec: 7200 },',
      '  weeklyUsage: { usagePercent: 55, resetInSec: 432000 },',
      '  monthlyUsage: { usagePercent: 3, resetInSec: 86400 }',
      '}'
    ].join('\n')
    const snapshot = parseOpenCodeGoSubscription(text)
    expect(snapshot).toMatchObject({
      rollingUsagePercent: 12.5,
      rollingResetInSec: 7200,
      weeklyUsagePercent: 55,
      monthlyUsagePercent: 3
    })
  })

  it('returns undefined for unrecognized payloads', () => {
    expect(parseOpenCodeGoSubscription('hello world')).toBeUndefined()
    expect(parseOpenCodeGoSubscription(JSON.stringify({ foo: 'bar' }))).toBeUndefined()
  })
})

describe('OpenCodeGoWebQuotaError classification', () => {
  it('carries stable error codes', () => {
    const error = new OpenCodeGoWebQuotaError('bad cookie', 'invalid_credentials')
    expect(error.code).toBe('invalid_credentials')
    expect(error.name).toBe('OpenCodeGoWebQuotaError')
  })
})
