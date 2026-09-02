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
const HEATMAP_CLASSES = [
  'border-ds-border-muted bg-ds-surface-subtle',
  'border-accent/10 bg-accent/20 dark:border-accent/15 dark:bg-accent/25',
  'border-accent/15 bg-accent/40 dark:border-accent/25 dark:bg-accent/45',
  'border-accent/20 bg-accent/70 dark:border-accent/40 dark:bg-accent/70',
  'border-accent bg-accent dark:border-accent dark:bg-accent'
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
    <dl className="mx-4 grid grid-cols-2 border-y border-ds-border-muted sm:grid-cols-4">
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={`relative min-w-0 py-3 ${index % 2 === 0 ? 'pr-3' : 'border-l border-ds-border-muted pl-3'} ${
            index >= 2 ? 'border-t border-ds-border-muted sm:border-t-0' : ''
          } ${index > 0 ? 'sm:border-l sm:border-ds-border-muted sm:px-3' : 'sm:pr-3'}`}
        >
          {metric.accent ? <span className="absolute inset-x-0 top-0 h-px bg-accent" aria-hidden /> : null}
          <dt className="truncate text-[10.5px] leading-4 text-ds-faint" title={metric.label}>
            {metric.label}
          </dt>
          <dd className="mt-1 truncate text-[18px] font-semibold leading-6 tabular-nums text-ds-ink" title={metric.value}>
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
  const [tooltip, setTooltip] = useState<{ bucket: DailyUsageBucket; left: number; top: number } | null>(null)
  const weeks = useMemo(() => buildContributionWeeks(buckets), [buckets])
  const values = useMemo(
    () => buckets.map((bucket) => heatmapValue(bucket, mode)).filter((value) => value > 0),
    [buckets, mode]
  )
  const months = useMemo(() => monthLabels(weeks, i18n.language), [i18n.language, weeks])
  const summary = useMemo(() => usageSummary(buckets, mode, i18n.language), [buckets, i18n.language, mode])

  const showTooltip = (bucket: DailyUsageBucket, element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    const width = 220
    const top = rect.top > 52 ? rect.top - 42 : rect.bottom + 8
    setTooltip({
      bucket,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      top
    })
  }

  return (
    <div className="px-4 pb-4 pt-4" data-usage-contribution-heatmap>
      <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2">
        <span aria-hidden />
        <div
          className="mb-1.5 grid text-[9px] text-ds-faint"
          style={{ gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))`, columnGap: '4px' }}
          aria-hidden
        >
          {months.map((label, index) => (
            <span key={`${index}-${label}`} className="h-3 whitespace-nowrap">{label}</span>
          ))}
        </div>
        <div className="grid grid-rows-7 text-[9px] leading-none text-ds-faint" style={{ rowGap: '4px' }} aria-hidden>
          {[
            t('usageHeatmapWeekdayMon'), '', t('usageHeatmapWeekdayWed'), '',
            t('usageHeatmapWeekdayFri'), '', t('usageHeatmapWeekdaySun')
          ].map((label, index) => (
            <span key={`${label}-${index}`} className="flex h-[13px] items-center">{label}</span>
          ))}
        </div>
        <div
          role="grid"
          aria-label={t('usageHeatmapGridLabel')}
          className="grid min-w-0"
          style={{ gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))`, columnGap: '4px' }}
        >
          {weeks.map((week) => (
            <span key={week.key} role="row" className="grid min-w-0 grid-rows-7" style={{ rowGap: '4px' }}>
              {week.cells.map((bucket, index) => bucket ? (
                <button
                  key={bucket.date}
                  type="button"
                  role="gridcell"
                  title={tooltipText(bucket, mode, i18n.language)}
                  aria-label={tooltipText(bucket, mode, i18n.language)}
                  onMouseEnter={(event) => showTooltip(bucket, event.currentTarget)}
                  onMouseLeave={() => setTooltip(null)}
                  onFocus={(event) => showTooltip(bucket, event.currentTarget)}
                  onBlur={() => setTooltip(null)}
                  className={`h-[13px] w-full max-w-[13px] justify-self-center rounded-[3px] border transition-[box-shadow] hover:ring-1 hover:ring-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-ds-bg ${
                    HEATMAP_CLASSES[usageHeatmapIntensityLevel(
                      { totalTokens: heatmapValue(bucket, mode), turns: bucket.turns },
                      values
                    )]
                  }`}
                />
              ) : (
                <span key={`${week.key}-${index}`} className="h-[13px] w-full max-w-[13px] justify-self-center" aria-hidden />
              ))}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[9.5px] text-ds-faint">
        <span>{t(mode === 'tokens' ? 'usageQuotaDailyTokens' : 'usageQuotaDailyCost')}</span>
        <span className="flex items-center gap-1.5">
          <span>{t('usageHeatmapLess')}</span>
          <span className="flex items-center gap-1" aria-hidden>
            {HEATMAP_CLASSES.map((className, index) => (
              <span key={index} className={`h-2.5 w-2.5 rounded-[3px] border ${className}`} />
            ))}
          </span>
          <span>{t('usageHeatmapMore')}</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[9.5px] text-ds-faint">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        <span>{t('usageQuotaCurrentStreak', { count: summary.currentStreak })}</span>
        <span aria-hidden>·</span>
        <span>{t('usageQuotaMostActiveWeekday', { weekday: summary.mostActiveWeekday })}</span>
      </div>

      {tooltip && typeof document !== 'undefined' ? createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[12000] w-[220px] rounded-lg bg-[#222222] px-3 py-2 text-center text-[10.5px] font-medium text-white shadow-xl dark:bg-white dark:text-[#181818]"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          {tooltipText(tooltip.bucket, mode, i18n.language)}
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

function monthLabels(weeks: ContributionWeek[], locale: string): string[] {
  return weeks.map((week, index) => {
    const bucket = week.cells.find((cell) => cell?.date.endsWith('-01'))
      ?? (index === 0 ? week.cells.find((cell): cell is DailyUsageBucket => Boolean(cell)) : undefined)
    if (!bucket) return ''
    const date = new Date(`${bucket.date}T00:00:00.000Z`)
    return Number.isNaN(date.getTime())
      ? ''
      : new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)
  })
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
    const mondayIndex = (date.getUTCDay() + 6) % 7
    weekdayTotals[mondayIndex] += heatmapValue(bucket, mode)
  }
  const max = Math.max(...weekdayTotals)
  const weekdayIndex = max > 0 ? weekdayTotals.indexOf(max) : 0
  const monday = new Date('2026-08-31T00:00:00.000Z')
  monday.setUTCDate(monday.getUTCDate() + weekdayIndex)
  return {
    currentStreak,
    mostActiveWeekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(monday)
  }
}
