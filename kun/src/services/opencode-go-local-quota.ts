import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { ProviderQuotaMetric } from '../contracts/provider-quota.js'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000
const PLAN_LIMITS_USD = {
  fiveHour: 12,
  weekly: 30,
  monthly: 60
} as const

const MESSAGE_USAGE_SQL = `
  SELECT
    CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
    CAST(json_extract(data, '$.cost') AS REAL) AS cost
  FROM message
  WHERE json_valid(data)
    AND json_extract(data, '$.providerID') = 'opencode-go'
    AND json_extract(data, '$.role') = 'assistant'
    AND json_type(data, '$.cost') IN ('integer', 'real')
`

const MESSAGE_AND_PART_USAGE_SQL = `
  WITH provider_messages AS (
    SELECT
      id AS messageID,
      CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
      CAST(json_extract(data, '$.cost') AS REAL) AS cost,
      json_type(data, '$.cost') IN ('integer', 'real') AS hasCost
    FROM message
    WHERE json_valid(data)
      AND json_extract(data, '$.providerID') = 'opencode-go'
      AND json_extract(data, '$.role') = 'assistant'
  )
  SELECT
    CAST(COALESCE(json_extract(p.data, '$.time.created'), p.time_created, m.createdMs) AS INTEGER)
      AS createdMs,
    CAST(json_extract(p.data, '$.cost') AS REAL) AS cost
  FROM part p
  JOIN provider_messages m ON m.messageID = p.message_id
  WHERE json_valid(p.data)
    AND json_extract(p.data, '$.type') = 'step-finish'
    AND json_type(p.data, '$.cost') IN ('integer', 'real')
  UNION ALL
  SELECT createdMs, cost
  FROM provider_messages m
  WHERE hasCost
    AND NOT EXISTS (
      SELECT 1
      FROM part p
      WHERE p.message_id = m.messageID
        AND json_valid(p.data)
        AND json_extract(p.data, '$.type') = 'step-finish'
        AND json_type(p.data, '$.cost') IN ('integer', 'real')
    )
`

export type OpenCodeGoLocalUsageRow = {
  createdMs: number
  cost: number
}

export type OpenCodeGoLocalQuotaResult = {
  metrics: ProviderQuotaMetric[]
  summary: string
}

export type OpenCodeGoLocalQuotaOptions = {
  databasePath?: string
  now?: Date
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
}

export function resolveOpenCodeGoDatabasePath(
  options: Omit<OpenCodeGoLocalQuotaOptions, 'databasePath' | 'now'> = {}
): string {
  const environment = options.environment ?? process.env
  const userHome = options.homeDirectory ?? homedir()
  const platform = options.platform ?? process.platform
  const joinPath = platform === 'win32' ? win32.join : posix.join
  const xdgDataHome = environment.XDG_DATA_HOME?.trim()
  const dataRoot = xdgDataHome || joinPath(userHome, '.local', 'share')
  return joinPath(dataRoot, 'opencode', 'opencode.db')
}

export async function readOpenCodeGoLocalQuota(
  options: OpenCodeGoLocalQuotaOptions = {}
): Promise<OpenCodeGoLocalQuotaResult | undefined> {
  const databasePath = options.databasePath ?? resolveOpenCodeGoDatabasePath(options)
  try {
    await access(databasePath)
  } catch {
    return undefined
  }

  try {
    const sqlite = await import('better-sqlite3')
    const database = new sqlite.default(databasePath, {
      readonly: true,
      fileMustExist: true
    })
    try {
      database.pragma('query_only = ON')
      database.pragma('busy_timeout = 250')
      const hasPartTable = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      ).get('part') !== undefined
      const rawRows = database.prepare(
        hasPartTable ? MESSAGE_AND_PART_USAGE_SQL : MESSAGE_USAGE_SQL
      ).all() as Array<{ createdMs?: unknown; cost?: unknown }>
      const rows = rawRows.flatMap((row) => {
        const createdMs = Number(row.createdMs)
        const cost = Number(row.cost)
        return Number.isFinite(createdMs) &&
          createdMs > 0 &&
          Number.isFinite(cost) &&
          cost >= 0
          ? [{ createdMs, cost }]
          : []
      })
      return rows.length > 0
        ? buildOpenCodeGoLocalQuota(rows, options.now ?? new Date())
        : undefined
    } finally {
      database.close()
    }
  } catch {
    throw new Error('OpenCode Go local usage database could not be read.')
  }
}

export function buildOpenCodeGoLocalQuota(
  rows: OpenCodeGoLocalUsageRow[],
  now: Date
): OpenCodeGoLocalQuotaResult {
  const nowMs = now.getTime()
  const fiveHourStartMs = nowMs - FIVE_HOURS_MS
  const weekStartMs = startOfUtcWeek(now).getTime()
  const weekEndMs = weekStartMs + WEEK_MS
  const earliestMs = rows.reduce(
    (minimum, row) => Math.min(minimum, row.createdMs),
    Number.POSITIVE_INFINITY
  )
  const month = monthBounds(now, Number.isFinite(earliestMs) ? earliestMs : undefined)

  let fiveHourUsed = 0
  let weeklyUsed = 0
  let monthlyUsed = 0
  let oldestFiveHourMs: number | undefined
  for (const row of rows) {
    if (!Number.isFinite(row.createdMs) || !Number.isFinite(row.cost) || row.cost < 0) continue
    if (row.createdMs >= fiveHourStartMs && row.createdMs < nowMs) {
      fiveHourUsed += row.cost
      oldestFiveHourMs = oldestFiveHourMs === undefined
        ? row.createdMs
        : Math.min(oldestFiveHourMs, row.createdMs)
    }
    if (row.createdMs >= weekStartMs && row.createdMs < weekEndMs) {
      weeklyUsed += row.cost
    }
    if (row.createdMs >= month.startMs && row.createdMs < month.endMs) {
      monthlyUsed += row.cost
    }
  }

  return {
    metrics: [
      localCostMetric(
        'five-hour',
        '5-hour usage',
        fiveHourUsed,
        PLAN_LIMITS_USD.fiveHour,
        oldestFiveHourMs === undefined
          ? undefined
          : oldestFiveHourMs + FIVE_HOURS_MS
      ),
      localCostMetric(
        'weekly',
        'Weekly usage',
        weeklyUsed,
        PLAN_LIMITS_USD.weekly,
        weekEndMs
      ),
      localCostMetric(
        'monthly',
        'Monthly usage',
        monthlyUsed,
        PLAN_LIMITS_USD.monthly,
        month.endMs
      )
    ],
    summary: 'Local estimate · $12 / $30 / $60 plan limits'
  }
}

function localCostMetric(
  id: string,
  label: string,
  used: number,
  limit: number,
  resetMs?: number
): ProviderQuotaMetric {
  const normalizedUsed = Math.max(0, used)
  return {
    id,
    label,
    unit: 'USD',
    used: normalizedUsed,
    limit,
    remaining: Math.max(0, limit - normalizedUsed),
    usedPercent: roundedPercent(normalizedUsed, limit),
    ...(resetMs === undefined ? {} : { resetsAt: new Date(resetMs).toISOString() })
  }
}

function roundedPercent(used: number, limit: number): number {
  const clamped = Math.min(100, Math.max(0, used / limit * 100))
  return Math.round(clamped * 10) / 10
}

function startOfUtcWeek(now: Date): Date {
  const day = now.getUTCDay()
  const daysSinceMonday = (day + 6) % 7
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceMonday
  ))
}

function monthBounds(
  now: Date,
  anchorMs?: number
): { startMs: number; endMs: number } {
  if (anchorMs === undefined) {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    return {
      startMs: start,
      endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    }
  }

  const anchor = new Date(anchorMs)
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()
  let start = anchoredUtcMonth(year, month, anchor)
  if (start.getTime() > now.getTime()) {
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
    start = anchoredUtcMonth(year, month, anchor)
  }
  const nextMonth = month === 11
    ? { year: year + 1, month: 0 }
    : { year, month: month + 1 }
  return {
    startMs: start.getTime(),
    endMs: anchoredUtcMonth(nextMonth.year, nextMonth.month, anchor).getTime()
  }
}

function anchoredUtcMonth(year: number, month: number, anchor: Date): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    year,
    month,
    Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds()
  ))
}
