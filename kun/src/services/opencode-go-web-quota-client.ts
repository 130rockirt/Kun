import { randomUUID } from 'node:crypto'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { parseSubscriptionEmbedded, parseSubscriptionJson, parseWorkspaceIdsFromJson } from './opencode-go-web-quota-subscription-parsing.js'
import { looksSignedOut, normalizeWorkspaceId, snapshotToMetrics, unique } from './opencode-go-web-quota-metrics.js'

export const BASE_URL = 'https://opencode.ai'

export const SERVER_URL = 'https://opencode.ai/_server'

export const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

export const REQUEST_COOKIE_NAMES = new Set(['auth', '__host-auth'])

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

export const PERCENT_KEYS = [
  'usagePercent',
  'usedPercent',
  'percentUsed',
  'percent',
  'usage_percent',
  'used_percent',
  'utilization',
  'utilizationPercent',
  'utilization_percent',
  'usage'
]

export const RESET_IN_KEYS = [
  'resetInSec',
  'resetInSeconds',
  'resetSeconds',
  'reset_sec',
  'reset_in_sec',
  'resetsInSec',
  'resetsInSeconds',
  'resetIn',
  'resetSec'
]

export const RESET_AT_KEYS = [
  'resetAt',
  'resetsAt',
  'reset_at',
  'resets_at',
  'nextReset',
  'next_reset',
  'renewAt',
  'renew_at'
]

export const RENEW_AT_KEYS = ['renewAt', 'renew_at']

export type OpenCodeGoWebFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export type OpenCodeGoWebQuotaOptions = {
  cookieHeader: string
  fetcher?: OpenCodeGoWebFetch
  timeoutMs?: number
  now?: Date
  workspaceId?: string
}

export type OpenCodeGoWebQuotaResult = {
  metrics: ProviderQuotaMetric[]
  summary: string
  dashboardUrl: string
  workspaceId: string
}

export class OpenCodeGoWebQuotaError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_credentials' | 'network' | 'api' | 'parse'
  ) {
    super(message)
    this.name = 'OpenCodeGoWebQuotaError'
  }
}

export function filterOpenCodeGoCookieHeader(
  rawHeader: string | undefined
): string | undefined {
  if (!rawHeader?.trim()) return undefined
  const normalized = rawHeader.trim().replace(/^cookie:\s*/i, '')
  const pairs = normalized
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separator = part.indexOf('=')
      if (separator <= 0) return []
      const name = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      if (!name || !value) return []
      if (!REQUEST_COOKIE_NAMES.has(name.toLowerCase())) return []
      return [`${name}=${value}`]
    })
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

export async function fetchOpenCodeGoWebQuota(
  options: OpenCodeGoWebQuotaOptions
): Promise<OpenCodeGoWebQuotaResult> {
  const cookieHeader = filterOpenCodeGoCookieHeader(options.cookieHeader)
  if (!cookieHeader) {
    throw new OpenCodeGoWebQuotaError(
      'OpenCode Go session cookie is missing or invalid.',
      'invalid_credentials'
    )
  }
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 12_000
  const now = options.now ?? new Date()
  const workspaceId = normalizeWorkspaceId(options.workspaceId) ??
    await fetchWorkspaceId(cookieHeader, fetcher, timeoutMs)
  const pageText = await fetchPageText(
    `${BASE_URL}/workspace/${workspaceId}/go`,
    cookieHeader,
    fetcher,
    timeoutMs
  )
  if (looksSignedOut(pageText)) {
    throw new OpenCodeGoWebQuotaError(
      'OpenCode Go session cookie is invalid or expired.',
      'invalid_credentials'
    )
  }
  const snapshot = parseOpenCodeGoSubscription(pageText, now)
  if (!snapshot) {
    throw new OpenCodeGoWebQuotaError(
      'OpenCode Go did not return recognized usage fields.',
      'parse'
    )
  }
  return {
    metrics: snapshotToMetrics(snapshot, now),
    summary: `OpenCode Go subscription · ${workspaceId}`,
    dashboardUrl: `${BASE_URL}/workspace/${workspaceId}/go`,
    workspaceId
  }
}

export function parseOpenCodeGoSubscription(
  text: string,
  now: Date = new Date()
): OpenCodeGoWebSnapshot | undefined {
  return parseSubscriptionJson(text, now) ?? parseSubscriptionEmbedded(text, now)
}

export type OpenCodeGoWebSnapshot = {
  hasWeeklyUsage: boolean
  hasMonthlyUsage: boolean
  rollingUsagePercent: number
  weeklyUsagePercent: number
  monthlyUsagePercent: number
  rollingResetInSec: number
  weeklyResetInSec: number
  monthlyResetInSec: number
}

export type JsonRecord = Record<string, unknown>

export type WindowValues = {
  percent: number
  resetInSec: number
}

export async function fetchWorkspaceId(
  cookieHeader: string,
  fetcher: OpenCodeGoWebFetch,
  timeoutMs: number
): Promise<string> {
  const text = await fetchServerText({
    serverId: WORKSPACES_SERVER_ID,
    method: 'GET',
    cookieHeader,
    fetcher,
    timeoutMs,
    referer: BASE_URL
  })
  let ids = parseWorkspaceIds(text)
  if (ids.length === 0) ids = parseWorkspaceIdsFromJson(text)
  if (ids.length === 0) {
    const fallback = await fetchServerText({
      serverId: WORKSPACES_SERVER_ID,
      method: 'POST',
      args: '[]',
      cookieHeader,
      fetcher,
      timeoutMs,
      referer: BASE_URL
    })
    ids = parseWorkspaceIds(fallback)
    if (ids.length === 0) ids = parseWorkspaceIdsFromJson(fallback)
  }
  if (ids.length === 0) {
    throw new OpenCodeGoWebQuotaError('OpenCode Go workspace id is missing.', 'parse')
  }
  return ids[0]!
}

export async function fetchServerText(input: {
  serverId: string
  method: 'GET' | 'POST'
  args?: string
  cookieHeader: string
  fetcher: OpenCodeGoWebFetch
  timeoutMs: number
  referer: string
}): Promise<string> {
  const url = input.method === 'GET'
    ? serverRequestUrl(input.serverId, input.args)
    : SERVER_URL
  const response = await requestWithHeaders(input.fetcher, url, {
    method: input.method,
    headers: {
      Cookie: input.cookieHeader,
      'X-Server-Id': input.serverId,
      'X-Server-Instance': `server-fn:${randomUUID()}`,
      'User-Agent': USER_AGENT,
      Origin: BASE_URL,
      Referer: input.referer,
      Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
      ...(input.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
    },
    ...(input.method === 'POST' && input.args !== undefined
      ? { body: input.args }
      : {}),
    timeoutMs: input.timeoutMs
  })
  return response
}

export async function fetchPageText(
  url: string,
  cookieHeader: string,
  fetcher: OpenCodeGoWebFetch,
  timeoutMs: number
): Promise<string> {
  return requestWithHeaders(fetcher, url, {
    method: 'GET',
    headers: {
      Cookie: cookieHeader,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    timeoutMs
  })
}

export async function requestWithHeaders(
  fetcher: OpenCodeGoWebFetch,
  url: string,
  input: {
    method: 'GET' | 'POST'
    headers: Record<string, string>
    body?: string
    timeoutMs: number
  }
): Promise<string> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: AbortSignal.timeout(input.timeoutMs),
      redirect: 'manual'
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/iu.test(error.message))) {
      throw new OpenCodeGoWebQuotaError('OpenCode Go network request timed out.', 'network')
    }
    throw new OpenCodeGoWebQuotaError('OpenCode Go network request failed.', 'network')
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    if (looksSignedOut(text) || response.status === 401 || response.status === 403) {
      throw new OpenCodeGoWebQuotaError(
        'OpenCode Go session cookie is invalid or expired.',
        'invalid_credentials'
      )
    }
    throw new OpenCodeGoWebQuotaError(
      `OpenCode Go API returned HTTP ${response.status}.`,
      'api'
    )
  }
  return text
}

export function serverRequestUrl(serverId: string, args?: string): string {
  const url = new URL(SERVER_URL)
  url.searchParams.set('id', serverId)
  if (args) url.searchParams.set('args', args)
  return url.toString()
}

export function parseWorkspaceIds(text: string): string[] {
  const matches = text.matchAll(/id\s*:\s*"(wrk_[^"]+)"/gu)
  return unique([...matches].map((match) => match[1]!).filter(Boolean))
}
