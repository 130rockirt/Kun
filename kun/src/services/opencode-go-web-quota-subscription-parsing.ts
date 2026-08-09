import { randomUUID } from 'node:crypto'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'
import { type JsonRecord, type OpenCodeGoWebSnapshot, RENEW_AT_KEYS } from './opencode-go-web-quota-client.js'
import { clampPercentage, dateValue, extractDouble, extractInt, firstDict, isRecord, optionalRecord, parseWindow, unique, valueFrom } from './opencode-go-web-quota-metrics.js'

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

export function collectWorkspaceIds(value: unknown, out: string[]): void {
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

export function parseSubscriptionJson(text: string, now: Date): OpenCodeGoWebSnapshot | undefined {
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

export function parseUsageDictionary(
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

export function parseUsageNested(
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

export function parseSubscriptionEmbedded(text: string, now: Date): OpenCodeGoWebSnapshot | undefined {
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

export function parseUsageFromCandidates(
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

export type WindowCandidate = {
  id: string
  percent: number
  resetInSec: number
  pathLower: string
}

export function collectWindowCandidates(object: unknown, now: Date): WindowCandidate[] {
  const out: WindowCandidate[] = []
  walkWindowCandidates(object, now, [], out)
  return out
}

export function walkWindowCandidates(
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

export function pickCandidate(
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

export function buildSnapshot(
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
