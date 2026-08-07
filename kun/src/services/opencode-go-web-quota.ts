import { randomUUID } from 'node:crypto'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'

const BASE_URL = 'https://opencode.ai'
const SERVER_URL = 'https://opencode.ai/_server'
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const REQUEST_COOKIE_NAMES = new Set(['auth', '__host-auth'])
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const PERCENT_KEYS = [
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
const RESET_IN_KEYS = [
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
const RESET_AT_KEYS = [
  'resetAt',
  'resetsAt',
  'reset_at',
  'resets_at',
  'nextReset',
  'next_reset',
  'renewAt',
  'renew_at'
]
const RENEW_AT_KEYS = ['renewAt', 'renew_at']

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

type OpenCodeGoWebSnapshot = {
  hasWeeklyUsage: boolean
  hasMonthlyUsage: boolean
  rollingUsagePercent: number
  weeklyUsagePercent: number
  monthlyUsagePercent: number
  rollingResetInSec: number
  weeklyResetInSec: number
  monthlyResetInSec: number
}

type JsonRecord = Record<string, unknown>

type WindowValues = {
  percent: number
  resetInSec: number
}

async function fetchWorkspaceId(
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

async function fetchServerText(input: {
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

async function fetchPageText(
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

async function requestWithHeaders(
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

function serverRequestUrl(serverId: string, args?: string): string {
  const url = new URL(SERVER_URL)
  url.searchParams.set('id', serverId)
  if (args) url.searchParams.set('args', args)
  return url.toString()
}

export function parseWorkspaceIds(text: string): string[] {
  const matches = text.matchAll(/id\s*:\s*"(wrk_[^"]+)"/gu)
  return unique([...matches].map((match) => match[1]!).filter(Boolean))
}

export function parseWorkspaceIdsFromJson(text: string): string[] {
  try {
    const object = JSON.parse(text) as unknown
    const results: string[] = []
    collectWorkspaceIds(object, results)
    return unique(results)
  } catch {
    return []
  }
}

function collectWorkspaceIds(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('wrk_') && !out.includes(value)) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspaceIds(item, out)
    return
  }
  if (!isRecord(value)) return
  for (const item of Object.values(value)) collectWorkspaceIds(item, out)
}

function parseSubscriptionJson(text: string, now: Date): OpenCodeGoWebSnapshot | undefined {
  let object: unknown
  try {
    object = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(object)) return undefined
  const renewsAt = dateValue(valueFrom(object, RENEW_AT_KEYS))
  return parseUsageDictionary(object, now, renewsAt) ??
    parseUsageNested(object, now, 0, renewsAt) ??
    parseUsageFromCandidates(object, now)
}

function parseUsageDictionary(
  dict: JsonRecord,
  now: Date,
  inheritedRenewsAt?: Date
): OpenCodeGoWebSnapshot | undefined {
  const renewsAt = dateValue(valueFrom(dict, RENEW_AT_KEYS)) ?? inheritedRenewsAt
  const nestedUsage = optionalRecord(dict.usage)
  if (nestedUsage) {
    const nested = parseUsageDictionary(nestedUsage, now, renewsAt)
    if (nested) return nested
  }
  const rolling = firstDict(dict, [
    'rollingUsage',
    'rolling',
    'rolling_usage',
    'rollingWindow',
    'rolling_window'
  ])
  if (!rolling) return undefined
  const weekly = firstDict(dict, [
    'weeklyUsage',
    'weekly',
    'weekly_usage',
    'weeklyWindow',
    'weekly_window'
  ])
  const monthly = firstDict(dict, [
    'monthlyUsage',
    'monthly',
    'monthly_usage',
    'monthlyWindow',
    'monthly_window'
  ])
  return buildSnapshot(rolling, weekly, monthly, now)
}

function parseUsageNested(
  dict: JsonRecord,
  now: Date,
  depth: number,
  inheritedRenewsAt?: Date
): OpenCodeGoWebSnapshot | undefined {
  if (depth > 3) return undefined
  const renewsAt = dateValue(valueFrom(dict, RENEW_AT_KEYS)) ?? inheritedRenewsAt
  let rolling: JsonRecord | undefined
  let weekly: JsonRecord | undefined
  let monthly: JsonRecord | undefined
  for (const [key, value] of Object.entries(dict)) {
    const sub = optionalRecord(value)
    if (!sub) continue
    const lower = key.toLowerCase()
    if (lower.includes('rolling') || lower.includes('hour') || lower.includes('5h') || lower.includes('5-hour')) {
      rolling = sub
    } else if (lower.includes('weekly') || lower.includes('week')) {
      weekly = sub
    } else if (lower.includes('monthly') || lower.includes('month')) {
      monthly = sub
    }
  }
  if (rolling) {
    const snapshot = buildSnapshot(rolling, weekly, monthly, now)
    if (snapshot) return snapshot
  }
  for (const value of Object.values(dict)) {
    const sub = optionalRecord(value)
    if (!sub) continue
    const nested = parseUsageNested(sub, now, depth + 1, renewsAt)
    if (nested) return nested
  }
  return undefined
}

function parseSubscriptionEmbedded(text: string, now: Date): OpenCodeGoWebSnapshot | undefined {
  const rollingPercent = extractDouble(
    /rollingUsage[^}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/u,
    text
  )
  const rollingReset = extractInt(
    /rollingUsage[^}]*?resetInSec\s*:\s*([0-9]+)/u,
    text
  )
  if (rollingPercent === undefined || rollingReset === undefined) return undefined
  const weeklyPercent = extractDouble(
    /weeklyUsage[^}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/u,
    text
  )
  const weeklyReset = extractInt(
    /weeklyUsage[^}]*?resetInSec\s*:\s*([0-9]+)/u,
    text
  )
  const monthlyPercent = extractDouble(
    /monthlyUsage[^}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)/u,
    text
  )
  const monthlyReset = extractInt(
    /monthlyUsage[^}]*?resetInSec\s*:\s*([0-9]+)/u,
    text
  )
  return {
    hasWeeklyUsage: weeklyPercent !== undefined && weeklyReset !== undefined,
    hasMonthlyUsage: monthlyPercent !== undefined || monthlyReset !== undefined,
    rollingUsagePercent: clampPercentage(rollingPercent),
    weeklyUsagePercent: clampPercentage(weeklyPercent ?? 0),
    monthlyUsagePercent: clampPercentage(monthlyPercent ?? 0),
    rollingResetInSec: Math.max(0, rollingReset),
    weeklyResetInSec: Math.max(0, weeklyReset ?? 0),
    monthlyResetInSec: Math.max(0, monthlyReset ?? 0)
  }
}

function parseUsageFromCandidates(
  object: unknown,
  now: Date
): OpenCodeGoWebSnapshot | undefined {
  const candidates = collectWindowCandidates(object, now)
  if (candidates.length === 0) return undefined
  const rollingCandidates = candidates.filter((candidate) =>
    candidate.pathLower.includes('rolling') ||
    candidate.pathLower.includes('hour') ||
    candidate.pathLower.includes('5h') ||
    candidate.pathLower.includes('5-hour')
  )
  const weeklyCandidates = candidates.filter((candidate) =>
    candidate.pathLower.includes('weekly') ||
    candidate.pathLower.includes('week')
  )
  const monthlyCandidates = candidates.filter((candidate) =>
    candidate.pathLower.includes('monthly') ||
    candidate.pathLower.includes('month')
  )
  const nonRolling = new Set([...weeklyCandidates, ...monthlyCandidates].map((item) => item.id))
  const rolling = pickCandidate(
    rollingCandidates,
    candidates.filter((item) => !nonRolling.has(item.id)),
    true
  )
  if (!rolling) return undefined
  const weekly = pickCandidate(
    weeklyCandidates.filter((item) => item.id !== rolling.id),
    [],
    false
  )
  const monthly = pickCandidate(
    monthlyCandidates.filter((item) => item.id !== rolling.id && item.id !== weekly?.id),
    [],
    false
  )
  return {
    hasWeeklyUsage: weekly !== undefined,
    hasMonthlyUsage: monthly !== undefined,
    rollingUsagePercent: rolling.percent,
    weeklyUsagePercent: weekly?.percent ?? 0,
    monthlyUsagePercent: monthly?.percent ?? 0,
    rollingResetInSec: rolling.resetInSec,
    weeklyResetInSec: weekly?.resetInSec ?? 0,
    monthlyResetInSec: monthly?.resetInSec ?? 0
  }
}

type WindowCandidate = {
  id: string
  percent: number
  resetInSec: number
  pathLower: string
}

function collectWindowCandidates(object: unknown, now: Date): WindowCandidate[] {
  const out: WindowCandidate[] = []
  walkWindowCandidates(object, now, [], out)
  return out
}

function walkWindowCandidates(
  object: unknown,
  now: Date,
  path: string[],
  out: WindowCandidate[]
): void {
  if (Array.isArray(object)) {
    object.forEach((value, index) => {
      walkWindowCandidates(value, now, [...path, `[${index}]`], out)
    })
    return
  }
  if (!isRecord(object)) return
  const window = parseWindow(object, now)
  if (window) {
    out.push({
      id: randomUUID(),
      percent: window.percent,
      resetInSec: window.resetInSec,
      pathLower: path.join('.').toLowerCase()
    })
  }
  for (const [key, value] of Object.entries(object)) {
    walkWindowCandidates(value, now, [...path, key], out)
  }
}

function pickCandidate(
  preferred: WindowCandidate[],
  fallback: WindowCandidate[],
  pickShorter: boolean
): WindowCandidate | undefined {
  const source = preferred.length > 0 ? preferred : fallback
  if (source.length === 0) return undefined
  return source.reduce((best, current) => {
    if (pickShorter) {
      if (current.resetInSec === best.resetInSec) {
        return current.percent > best.percent ? current : best
      }
      return current.resetInSec < best.resetInSec ? current : best
    }
    if (current.resetInSec === best.resetInSec) {
      return current.percent > best.percent ? current : best
    }
    return current.resetInSec > best.resetInSec ? current : best
  })
}

function buildSnapshot(
  rolling: JsonRecord,
  weekly: JsonRecord | undefined,
  monthly: JsonRecord | undefined,
  now: Date
): OpenCodeGoWebSnapshot | undefined {
  const rollingWindow = parseWindow(rolling, now)
  if (!rollingWindow) return undefined
  const weeklyWindow = weekly ? parseWindow(weekly, now) : undefined
  if (weekly && !weeklyWindow) return undefined
  const monthlyWindow = monthly ? parseWindow(monthly, now) : undefined
  return {
    hasWeeklyUsage: weeklyWindow !== undefined,
    hasMonthlyUsage: monthlyWindow !== undefined,
    rollingUsagePercent: rollingWindow.percent,
    weeklyUsagePercent: weeklyWindow?.percent ?? 0,
    monthlyUsagePercent: monthlyWindow?.percent ?? 0,
    rollingResetInSec: rollingWindow.resetInSec,
    weeklyResetInSec: weeklyWindow?.resetInSec ?? 0,
    monthlyResetInSec: monthlyWindow?.resetInSec ?? 0
  }
}

function parseWindow(dict: JsonRecord, now: Date): WindowValues | undefined {
  let percent = firstNumber(dict, PERCENT_KEYS)
  const percentIsDirect = percent !== undefined
  if (percent === undefined) {
    const used = firstNumber(dict, ['used', 'usage', 'consumed', 'count', 'usedTokens'])
    const limit = firstNumber(dict, ['limit', 'total', 'quota', 'max', 'cap', 'tokenLimit'])
    if (used !== undefined && limit !== undefined && limit > 0) {
      // Match CodexBar's local reader: computed used/limit percents round to one decimal.
      percent = Math.round((used / limit) * 1_000) / 10
    }
  }
  if (percent === undefined) return undefined
  let resolved = percent
  if (percentIsDirect && resolved <= 1 && resolved >= 0) resolved *= 100
  resolved = clampPercentage(resolved)
  let resetInSec = firstInt(dict, RESET_IN_KEYS)
  if (resetInSec === undefined) {
    for (const key of RESET_AT_KEYS) {
      const resetAt = dateValue(dict[key])
      if (!resetAt) continue
      resetInSec = Math.max(0, Math.floor((resetAt.getTime() - now.getTime()) / 1_000))
      break
    }
  }
  return {
    percent: resolved,
    resetInSec: Math.max(0, resetInSec ?? 0)
  }
}

function snapshotToMetrics(
  snapshot: OpenCodeGoWebSnapshot,
  now: Date
): ProviderQuotaMetric[] {
  const metrics: ProviderQuotaMetric[] = [
    percentMetric(
      'five-hour',
      '5-hour usage',
      snapshot.rollingUsagePercent,
      snapshot.rollingResetInSec,
      now
    )
  ]
  if (snapshot.hasWeeklyUsage) {
    metrics.push(percentMetric(
      'weekly',
      'Weekly usage',
      snapshot.weeklyUsagePercent,
      snapshot.weeklyResetInSec,
      now
    ))
  }
  if (snapshot.hasMonthlyUsage) {
    metrics.push(percentMetric(
      'monthly',
      'Monthly usage',
      snapshot.monthlyUsagePercent,
      snapshot.monthlyResetInSec,
      now
    ))
  }
  return metrics
}

function percentMetric(
  id: string,
  label: string,
  usedPercent: number,
  resetInSec: number,
  now: Date
): ProviderQuotaMetric {
  return {
    id,
    label,
    unit: 'percent',
    usedPercent: clampPercentage(usedPercent),
    ...(resetInSec > 0
      ? { resetsAt: new Date(now.getTime() + resetInSec * 1_000).toISOString() }
      : {})
  }
}

export function normalizeWorkspaceId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('wrk_') && trimmed.length > 4) return trimmed
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.split('/').filter(Boolean)
    const index = parts.indexOf('workspace')
    if (index >= 0 && parts[index + 1]?.startsWith('wrk_')) return parts[index + 1]
  } catch {
    // Fall through to regex match.
  }
  const match = trimmed.match(/wrk_[A-Za-z0-9]+/u)
  return match?.[0]
}

function looksSignedOut(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('auth/authorize') ||
    lower.includes('not associated with an account') ||
    lower.includes('actor of type "public"')
}

function firstDict(dict: JsonRecord, keys: string[]): JsonRecord | undefined {
  for (const key of keys) {
    const value = optionalRecord(dict[key])
    if (value) return value
  }
  return undefined
}

function firstNumber(dict: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(dict[key])
    if (value !== undefined) return value
  }
  return undefined
}

function firstInt(dict: JsonRecord, keys: string[]): number | undefined {
  const value = firstNumber(dict, keys)
  return value === undefined ? undefined : Math.trunc(value)
}

function valueFrom(dict: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key]
  }
  return undefined
}

function extractDouble(pattern: RegExp, text: string): number | undefined {
  const match = text.match(pattern)
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function extractInt(pattern: RegExp, text: string): number | undefined {
  const value = extractDouble(pattern, text)
  return value === undefined ? undefined : Math.trunc(value)
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value < 100_000_000_000 ? value * 1_000 : value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
