import { useMemo, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { DailyUsageBucket } from '../../hooks/use-daily-usage'
import { formatCompactNumber, formatCost } from '../../hooks/use-thread-usage'
import { usageHeatmapIntensityLevel, usageHasBucketActivity } from '../chat/initial-session-usage-support'

export type UsageHistoryMetric = {
  label: string
  value: string
  detail?: string
  detailTitle?: string
  accent?: boolean
}

type HeatmapMode = 'tokens' | 'cost'
type ContributionWeek = { key: string; cells: Array<DailyUsageBucket | null> }

const HEATMAP_WEEKS = 12
const HEATMAP_CELLS = HEATMAP_WEEKS * 7
const CELL_SIZE = 13
const CELL_GAP = 3
const WEEKDAY_COLUMN_WIDTH = 30
const WEEKDAY_LABEL_ROWS = new Set([0, 2, 4, 6])
const TOOLTIP_WIDTH = 208
// 2026-08-31 is a Monday; weekday labels come from Intl so they localize.
const REFERENCE_MONDAY = '2026-08-31T00:00:00.000Z'
const HEATMAP_CLASSES = [
  'bg-ds-surface-subtle',
  'bg-accent/20',
  'bg-accent/40',
  'bg-accent/70',
  'bg-accent'
]

export function SidebarUsageHistoryCard({
  buckets,
  error,
  hasUsage,
  loading,
  metrics
}: {
  buckets: DailyUsageBucket[]
  error: string | null
  hasUsage: boolean
  loading: boolean
  metrics: UsageHistoryMetric[]
}): ReactElement {
  const { t } = useTranslation('common')
  const [mode, setMode] = useState<HeatmapMode>('tokens')

  return (
    <section
      aria-label={t('usageQuotaHistory')}
      className="overflow-hidden rounded-[16px] border border-ds-border-muted bg-ds-card shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-4 pt-4">
        <div>
          <h3 className="text-[15px] font-semibold leading-5 text-ds-ink">
            {t('usageQuotaHistory')}
          </h3>
          <p className="mt-1 text-[10.5px] text-ds-faint">
            {t('usageQuotaHistoryRange', { range: t('usageQuotaRange12Weeks') })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="inline-flex rounded-lg border border-ds-border-muted bg-ds-surface-subtle/60 p-0.5 text-[10.5px] font-medium text-ds-muted">
            {(['tokens', 'cost'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className={`min-h-7 rounded-md px-2.5 transition-colors ${
                  mode === value
                    ? 'bg-accent/10 text-accent shadow-sm dark:bg-accent/20'
                    : 'hover:text-ds-ink'
                }`}
                onClick={() => setMode(value)}
              >
                {t(value === 'tokens' ? 'usageQuotaMetricTokens' : 'usageQuotaMetricCost')}
              </button>
            ))}
          </div>
          <span className="inline-flex min-h-7 items-center rounded-lg border border-ds-border-muted px-2.5 text-[10.5px] font-medium text-ds-muted">
            {t('usageQuotaRange12Weeks')}
          </span>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          title={error}
          className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200"
        >
          <span aria-hidden>!</span>
          <span>{t(hasUsage ? 'usageQuotaCachedRefreshFailed' : 'usageQuotaInitialLoadFailed')}</span>
        </div>
      ) : null}

      {loading && !hasUsage ? (
        <div className="mx-4 mb-4 flex min-h-44 items-center justify-center gap-2 text-[11px] text-ds-faint">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ds-border border-t-accent" aria-hidden />
          {t('usageHeatmapLoading')}
        </div>
      ) : hasUsage ? (
        <>
          <HistoryMetricStrip metrics={metrics} />
          <ContributionHeatmap buckets={buckets} mode={mode} />
        </>
      ) : (
        <p className="mx-4 mb-4 rounded-xl bg-ds-surface-subtle px-3 py-8 text-center text-[11px] leading-5 text-ds-faint">
          {t('usageQuotaNoUsage')}
        </p>
      )}
    </section>
  )
}

function HistoryMetricStrip({ metrics }: { metrics: UsageHistoryMetric[] }): ReactElement {
  return (
    <dl className="grid grid-cols-2 border-b border-ds-border-muted sm:grid-cols-4">
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={[
            'min-w-0 px-4 py-3',
            index % 2 === 1 ? 'border-l border-ds-border-muted' : '',
            index >= 2 ? 'border-t border-ds-border-muted sm:border-t-0' : '',
            index > 0 ? 'sm:border-l sm:border-ds-border-muted' : ''
          ].join(' ')}
        >
          <dt className="truncate text-[10.5px] leading-4 text-ds-faint" title={metric.label}>
            {metric.label}
          </dt>
          <dd
            className="mt-1 truncate text-[18px] font-semibold leading-6 tabular-nums text-ds-ink"
            title={metric.value}
          >
            {metric.value}
          </dd>
          {metric.detail ? (
            <p className="mt-1 line-clamp-2 text-[9px] leading-3.5 text-ds-muted" title={metric.detailTitle}>
              {metric.detail}
            </p>
          ) : null}
        </div>
      ))}
    </dl>
  )
}

function ContributionHeatmap({
  buckets,
  mode
}: {
  buckets: DailyUsageBucket[]
  mode: HeatmapMode
}): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [selected, setSelected] = useState<DailyUsageBucket | null>(null)
  const [tooltip, setTooltip] = useState<{
    bucket: DailyUsageBucket
    left: number
    top: number
    above: boolean
    arrowLeft: number
  } | null>(null)
  const weeks = useMemo(() => buildContributionWeeks(buckets), [buckets])
  const values = useMemo(
    () => buckets.map((bucket) => heatmapValue(bucket, mode)).filter((value) => value > 0),
    [buckets, mode]
  )
  const monthMarkers = useMemo(() => buildMonthMarkers(weeks, i18n.language), [i18n.language, weeks])
  const summary = useMemo(() => usageSummary(buckets, mode, i18n.language), [buckets, i18n.language, mode])

  const showTooltip = (bucket: DailyUsageBucket, element: HTMLElement): void => {
    if (typeof window === 'undefined') return
    const rect = element.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const left = Math.max(8, Math.min(centerX - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 8))
    const above = rect.top > 56
    setTooltip({
      bucket,
      left,
      top: above ? rect.top - 38 : rect.bottom + 10,
      above,
      arrowLeft: Math.max(12, Math.min(centerX - left, TOOLTIP_WIDTH - 12))
    })
  }

  const selectBucket = (bucket: DailyUsageBucket, element: HTMLElement): void => {
    setSelected((current) => (current?.date === bucket.date ? null : bucket))
    showTooltip(bucket, element)
  }

  return (
    <div className="px-4 pb-4 pt-4" data-usage-contribution-heatmap>
      <div className="mx-auto w-max">
        <div
          className="relative mb-1.5 h-3.5 text-[10px] leading-3.5 text-ds-faint"
          style={{ marginLeft: WEEKDAY_COLUMN_WIDTH + 8 }}
          aria-hidden
        >
          {monthMarkers.map((marker) => (
            <span
              key={`${marker.index}-${marker.label}`}
              className="absolute whitespace-nowrap"
              style={{ left: marker.index * (CELL_SIZE + CELL_GAP) }}
            >
              {marker.label}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <div
            className="grid shrink-0 grid-rows-7 text-[10px] leading-none text-ds-faint"
            style={{ rowGap: CELL_GAP, width: WEEKDAY_COLUMN_WIDTH }}
            aria-hidden
          >
            {[0, 1, 2, 3, 4, 5, 6].map((row) => (
              <span key={row} className="flex items-center" style={{ height: CELL_SIZE }}>
                {WEEKDAY_LABEL_ROWS.has(row) ? weekdayLabel(i18n.language, row) : ''}
              </span>
            ))}
          </div>
          <div
            role="grid"
            aria-label={t('usageHeatmapGridLabel')}
            className="grid shrink-0"
            style={{ gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, ${CELL_SIZE}px)`, columnGap: CELL_GAP }}
          >
            {weeks.map((week) => (
              <span key={week.key} role="row" className="grid grid-rows-7" style={{ rowGap: CELL_GAP }}>
                {week.cells.map((bucket, index) => bucket ? (
                  <button
                    key={bucket.date}
                    type="button"
                    role="gridcell"
                    title={tooltipText(bucket, mode, i18n.language)}
                    aria-label={tooltipText(bucket, mode, i18n.language)}
                    aria-pressed={selected?.date === bucket.date}
                    onMouseEnter={(event) => showTooltip(bucket, event.currentTarget)}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={(event) => showTooltip(bucket, event.currentTarget)}
                    onBlur={() => setTooltip(null)}
                    onClick={(event) => selectBucket(bucket, event.currentTarget)}
                    className={`rounded-[3px] transition-[box-shadow] hover:ring-2 hover:ring-ds-ink/30 focus:outline-none focus:ring-2 focus:ring-accent dark:hover:ring-white/40 ${HEATMAP_CLASSES[usageHeatmapIntensityLevel(
                      { totalTokens: heatmapValue(bucket, mode), turns: bucket.turns },
                      values
                    )]} ${
                      selected?.date === bucket.date
                        ? 'ring-2 ring-ds-ink ring-offset-1 ring-offset-ds-card dark:ring-white dark:ring-offset-ds-bg'
                        : ''
                    }`}
                    style={{ width: CELL_SIZE, height: CELL_SIZE }}
                  />
                ) : (
                  <span key={`${week.key}-${index}`} style={{ width: CELL_SIZE, height: CELL_SIZE }} aria-hidden />
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] text-ds-faint">
            {t(mode === 'tokens' ? 'usageQuotaDailyTokens' : 'usageQuotaDailyCost')}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ds-faint">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
            <span>{t('usageQuotaCurrentStreak', { count: summary.currentStreak })}</span>
            <span aria-hidden>·</span>
            <span>{t('usageQuotaMostActiveWeekday', { weekday: summary.mostActiveWeekday })}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-ds-faint">
          <span>{t('usageHeatmapLess')}</span>
          <span className="flex items-center gap-1" aria-hidden>
            {HEATMAP_CLASSES.map((className, index) => (
              <span key={index} className={`h-3 w-3 rounded-[3px] ${className}`} />
            ))}
          </span>
          <span>{t('usageHeatmapMore')}</span>
        </div>
      </div>

      {tooltip && typeof document !== 'undefined' ? createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[12000] whitespace-nowrap rounded-md bg-[#1f2328] px-2.5 py-1.5 text-[10.5px] font-medium text-white shadow-lg dark:bg-white dark:text-[#1f2328]"
          style={{ left: tooltip.left, top: tooltip.top, minWidth: 120 }}
        >
          {tooltipText(tooltip.bucket, mode, i18n.language)}
          <span
            aria-hidden
            className={`absolute h-2 w-2 rotate-45 bg-inherit ${
              tooltip.above ? 'top-full -translate-y-1/2' : 'bottom-full translate-y-1/2'
            }`}
            style={{ left: tooltip.arrowLeft - 4 }}
          />
        </div>,
        document.body
      ) : null}
    </div>
  )
}

export function buildContributionWeeks(buckets: DailyUsageBucket[]): ContributionWeek[] {
  const sorted = [...buckets].sort((left, right) => left.date.localeCompare(right.date)).slice(-HEATMAP_CELLS)
  if (sorted.length === 0) return emptyWeeks()
  const first = new Date(`${sorted[0].date}T00:00:00.000Z`)
  const mondayOffset = Number.isNaN(first.getTime()) ? 0 : (first.getUTCDay() + 6) % 7
  const cells: Array<DailyUsageBucket | null> = [
    ...Array.from({ length: mondayOffset }, () => null),
    ...sorted
  ]
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: ContributionWeek[] = []
  for (let index = 0; index < cells.length; index += 7) {
    const weekCells = cells.slice(index, index + 7)
    weeks.push({ key: weekCells.find(Boolean)?.date ?? `blank-${index}`, cells: weekCells })
  }
  const visible = weeks.slice(-HEATMAP_WEEKS)
  while (visible.length < HEATMAP_WEEKS) {
    visible.unshift({ key: `empty-${visible.length}`, cells: Array.from({ length: 7 }, () => null) })
  }
  return visible
}

function emptyWeeks(): ContributionWeek[] {
  return Array.from({ length: HEATMAP_WEEKS }, (_, index) => ({
    key: `empty-${index}`,
    cells: Array.from({ length: 7 }, () => null)
  }))
}

function heatmapValue(bucket: DailyUsageBucket, mode: HeatmapMode): number {
  if (mode === 'tokens') return bucket.totalTokens
  return bucket.costCny ?? bucket.costUsd
}

function buildMonthMarkers(
  weeks: ContributionWeek[],
  locale: string
): Array<{ index: number; label: string }> {
  const markers: Array<{ index: number; label: string }> = []
  let previousMonth = -1
  weeks.forEach((week, index) => {
    const firstCell = week.cells.find((cell): cell is DailyUsageBucket => Boolean(cell))
    if (!firstCell) return
    const date = new Date(`${firstCell.date}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime())) return
    const month = date.getUTCMonth()
    if (month === previousMonth) return
    previousMonth = month
    markers.push({
      index,
      label: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)
    })
  })
  return markers
}

function weekdayLabel(locale: string, mondayIndex: number): string {
  const date = new Date(REFERENCE_MONDAY)
  date.setUTCDate(date.getUTCDate() + mondayIndex)
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(date)
}

function tooltipText(bucket: DailyUsageBucket, mode: HeatmapMode, locale: string): string {
  const date = new Date(`${bucket.date}T00:00:00.000Z`)
  const dateLabel = Number.isNaN(date.getTime())
    ? bucket.date
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
  const value = mode === 'tokens'
    ? `${formatCompactNumber(bucket.totalTokens)} Tokens`
    : formatCost(bucket.costUsd, locale, bucket.costCny)
  return `${dateLabel} · ${value}`
}

function usageSummary(
  buckets: DailyUsageBucket[],
  mode: HeatmapMode,
  locale: string
): { currentStreak: number; mostActiveWeekday: string } {
  const sorted = [...buckets].sort((left, right) => left.date.localeCompare(right.date))
  let currentStreak = 0
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (!usageHasBucketActivity(sorted[index])) break
    currentStreak += 1
  }
  const weekdayTotals = Array.from({ length: 7 }, () => 0)
  for (const bucket of sorted) {
    const date = new Date(`${bucket.date}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime())) continue
    weekdayTotals[(date.getUTCDay() + 6) % 7] += heatmapValue(bucket, mode)
  }
  const max = Math.max(...weekdayTotals)
  return {
    currentStreak,
    mostActiveWeekday: weekdayLabel(locale, max > 0 ? weekdayTotals.indexOf(max) : 0)
  }
}
