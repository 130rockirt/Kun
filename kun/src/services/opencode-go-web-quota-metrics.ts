import { randomUUID } from 'node:crypto'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { type JsonRecord, type OpenCodeGoWebSnapshot, PERCENT_KEYS, RESET_AT_KEYS, RESET_IN_KEYS, type WindowValues } from './opencode-go-web-quota-client.js'

export function parseWindow(dict: JsonRecord, now: Date): WindowValues | undefined {
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

export function snapshotToMetrics(
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

export function percentMetric(
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

export function looksSignedOut(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('auth/authorize') ||
    lower.includes('not associated with an account') ||
    lower.includes('actor of type "public"')
}

export function firstDict(dict: JsonRecord, keys: string[]): JsonRecord | undefined {
  for (const key of keys) {
    const value = optionalRecord(dict[key])
    if (value) return value
  }
  return undefined
}

export function firstNumber(dict: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(dict[key])
    if (value !== undefined) return value
  }
  return undefined
}

export function firstInt(dict: JsonRecord, keys: string[]): number | undefined {
  const value = firstNumber(dict, keys)
  return value === undefined ? undefined : Math.trunc(value)
}

export function valueFrom(dict: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key]
  }
  return undefined
}

export function extractDouble(pattern: RegExp, text: string): number | undefined {
  const match = text.match(pattern)
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

export function extractInt(pattern: RegExp, text: string): number | undefined {
  const value = extractDouble(pattern, text)
  return value === undefined ? undefined : Math.trunc(value)
}

export function dateValue(value: unknown): Date | undefined {
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

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function optionalRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function unique(values: string[]): string[] {
  return [...new Set(values)]
}
