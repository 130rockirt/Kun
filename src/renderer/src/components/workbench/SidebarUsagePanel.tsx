import { AlertCircle, BarChart3, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildUsageCalendarWeeks,
  usageHeatmapIntensityLevel,
  usageTotalsFromBuckets
} from '../chat/InitialSessionUsageHeatmap'
import {
  cumulativeCacheHitRate,
  formatCompactNumber,
  formatCost,
  formatPercent,
  useThreadUsageState
} from '../../hooks/use-thread-usage'
import {
  type DailyUsageBucket,
  useDailyUsageState
} from '../../hooks/use-daily-usage'
import { useModelUsageState } from '../../hooks/use-model-usage'

type UsageRangeKey = 'all' | '90d' | '30d' | '7d'

const RANGE_DAYS: Record<UsageRangeKey, number> = {
  all: 365,
  '90d': 90,
  '30d': 30,
  '7d': 7
}

const RANGE_KEYS: UsageRangeKey[] = ['7d', '30d', '90d', 'all']

export type SidebarUsagePanelStatus = {
  loading: boolean
  refreshedAt?: string
}

type Props = {
  activeThreadId: string | null
  refreshKey: unknown
  onStatusChange?: (status: SidebarUsagePanelStatus) => void
}

export function SidebarUsagePanel({
  activeThreadId,
  refreshKey,
  onStatusChange
}: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [rangeKey, setRangeKey] = useState<UsageRangeKey>('all')
  const [refreshedAt, setRefreshedAt] = useState<string>()
  const threadState = useThreadUsageState(
    activeThreadId,
    Boolean(activeThreadId),
    refreshKey
  )
  const dailyState = useDailyUsageState(true, refreshKey, RANGE_DAYS.all)
  const modelState = useModelUsageState(
    true,
    `${String(refreshKey)}:${rangeKey}`,
    RANGE_DAYS[rangeKey]
  )
  const loading =
    dailyState.loading ||
    modelState.loading ||
    (Boolean(activeThreadId) && threadState.loading)
  const loaded =
    dailyState.loaded &&
    modelState.loaded &&
    (!activeThreadId || threadState.loaded)

  useEffect(() => {
    if (loaded && !loading) setRefreshedAt(new Date().toISOString())
  }, [loaded, loading])

  useEffect(() => {
    onStatusChange?.({
      loading,
      ...(refreshedAt ? { refreshedAt } : {})
    })
  }, [loading, onStatusChange, refreshedAt])

  const buckets = dailyState.usage?.buckets ?? []
  const rangeBuckets = useMemo(
    () => buckets.slice(-RANGE_DAYS[rangeKey]),
    [buckets, rangeKey]
  )
  const totals = useMemo(() => usageTotalsFromBuckets(rangeBuckets), [rangeBuckets])
  const calendarBuckets = useMemo(() => buckets.slice(-RANGE_DAYS.all), [buckets])
  const weeks = useMemo(() => buildUsageCalendarWeeks(calendarBuckets), [calendarBuckets])
  const positiveTokens = useMemo(
    () => calendarBuckets.map((bucket) => bucket.totalTokens).filter((value) => value > 0),
    [calendarBuckets]
  )
  const hasAccumulatedUsage =
    totals.totalTokens > 0 ||
    totals.turns > 0 ||
    totals.costUsd > 0 ||
    (totals.costCny ?? 0) > 0
  const modelBuckets = modelState.usage?.buckets ?? []
  const modelTotal = Math.max(
    1,
    modelState.usage?.totals.totalTokens ??
      modelBuckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)
  )
  const currentUsage = threadState.usage

  return (
    <div
      data-sidebar-usage-panel
      className="h-0 min-h-0 flex-1 touch-pan-y overflow-y-auto overflow-x-hidden px-3 py-3 [scrollbar-gutter:stable]"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="space-y-3">
        <section
          aria-label={t('usageQuotaCurrentSession')}
          className="rounded-[16px] border border-ds-border-muted bg-ds-card p-3 shadow-sm"
        >
          <div className="mb-2.5 flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-accent" strokeWidth={1.9} />
            <h3 className="text-[12.5px] font-semibold text-ds-ink">
              {t('usageQuotaCurrentSession')}
            </h3>
          </div>
          {activeThreadId && threadState.loading && !currentUsage ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-[11px] text-ds-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              {t('sessionUsageLoading')}
            </div>
          ) : currentUsage ? (
            <MetricGrid
              metrics={[
                {
                  label: t('usageQuotaMetricTokens'),
                  value: formatCompactNumber(currentUsage.totalTokens)
                },
                {
                  label: t('usageQuotaMetricCost'),
                  value: formatRecordedCost(
                    currentUsage.costUsd,
                    currentUsage.costCny,
                    i18n.language
                  )
                },
                {
                  label: t('usageQuotaMetricCache'),
                  value: formatPercent(cumulativeCacheHitRate(currentUsage))
                },
                {
                  label: t('usageQuotaMetricTurns'),
                  value: new Intl.NumberFormat(i18n.language).format(currentUsage.turns)
                }
              ]}
            />
          ) : (
            <p className="rounded-xl bg-ds-surface-subtle px-3 py-5 text-center text-[11px] leading-5 text-ds-faint">
              {activeThreadId ? t('sessionUsageUnavailable') : t('usageQuotaNoCurrentSession')}
            </p>
          )}
        </section>

        <section
          aria-label={t('usageQuotaHistory')}
          className="rounded-[16px] border border-ds-border-muted bg-ds-card p-3 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12.5px] font-semibold text-ds-ink">
              {t('usageQuotaHistory')}
            </h3>
            <div className="inline-flex rounded-lg bg-ds-surface-subtle p-0.5 text-[10px] font-medium text-ds-muted">
              {RANGE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  data-usage-range={key}
                  aria-pressed={rangeKey === key}
                  onClick={() => setRangeKey(key)}
                  className={`min-h-6 rounded-md px-1.5 transition ${
                    rangeKey === key
                      ? 'bg-ds-card text-ds-ink shadow-sm dark:bg-white/10'
                      : 'hover:text-ds-ink'
                  }`}
                >
                  {t(`usageHeatmapRange.${key}`)}
                </button>
              ))}
            </div>
          </div>

          {dailyState.error ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
              <span>{t('usageHeatmapErrorTitle')}</span>
            </div>
          ) : null}

          {dailyState.loading && !dailyState.usage ? (
            <div className="flex min-h-44 items-center justify-center gap-2 text-[11px] text-ds-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              {t('usageHeatmapLoading')}
            </div>
          ) : hasAccumulatedUsage ? (
            <>
              <div className="mt-3">
                <MetricGrid
                  metrics={[
                    {
                      label: t('usageQuotaMetricTokens'),
                      value: formatCompactNumber(totals.totalTokens)
                    },
                    {
                      label: t('usageQuotaMetricCost'),
                      value: formatRecordedCost(totals.costUsd, totals.costCny, i18n.language)
                    },
                    {
                      label: t('usageQuotaMetricCache'),
                      value: formatPercent(totals.cacheHitRate)
                    },
                    {
                      label: t('usageQuotaMetricSessions'),
                      value: new Intl.NumberFormat(i18n.language).format(totals.threadCount)
                    }
                  ]}
                />
              </div>
              <CompactHeatmap
                buckets={calendarBuckets}
                weeks={weeks}
                positiveTokens={positiveTokens}
              />
            </>
          ) : (
            <p className="mt-3 rounded-xl bg-ds-surface-subtle px-3 py-8 text-center text-[11px] leading-5 text-ds-faint">
              {t('usageQuotaNoUsage')}
            </p>
          )}
        </section>

        <section
          aria-label={t('usageQuotaModels')}
          className="rounded-[16px] border border-ds-border-muted bg-ds-card p-3 shadow-sm"
        >
          <h3 className="text-[12.5px] font-semibold text-ds-ink">
            {t('usageQuotaModels')}
          </h3>
          {modelState.loading && !modelState.usage ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-[11px] text-ds-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              {t('usageHeatmapLoading')}
            </div>
          ) : modelState.error ? (
            <p role="alert" className="mt-2 text-[10.5px] leading-4 text-amber-700 dark:text-amber-300">
              {t('usageHeatmapErrorTitle')}
            </p>
          ) : modelBuckets.length > 0 ? (
            <div className="mt-2.5 space-y-2.5">
              {modelBuckets.slice(0, 4).map((bucket) => {
                const percent = Math.max(0, Math.min(100, bucket.totalTokens / modelTotal * 100))
                return (
                  <div key={bucket.model} className="min-w-0">
                    <div className="flex items-center justify-between gap-3 text-[10.5px]">
                      <span className="min-w-0 flex-1 truncate font-medium text-ds-ink" title={bucket.model}>
                        {bucket.model}
                      </span>
                      <span className="shrink-0 tabular-nums text-ds-muted">
                        {percent.toFixed(percent >= 10 ? 0 : 1)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ds-border-muted">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-right text-[9px] tabular-nums text-ds-faint">
                      {formatCompactNumber(bucket.totalTokens)} tokens
                    </p>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="mt-2 rounded-xl bg-ds-surface-subtle px-3 py-5 text-center text-[11px] text-ds-faint">
              {t('usageHeatmapModelsEmpty', { model: '-' })}
            </p>
          )}
        </section>

        <p className="px-1 pb-1 text-[9.5px] leading-4 text-ds-faint">
          {t('usageQuotaLocalNote')}
        </p>
      </div>
    </div>
  )
}

function MetricGrid({
  metrics
}: {
  metrics: Array<{ label: string; value: string }>
}): ReactElement {
  return (
    <dl className="grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(6.5rem,1fr))]">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="min-w-0 rounded-xl border border-ds-border-muted bg-ds-surface-subtle/60 px-2.5 py-2"
        >
          <dt className="truncate text-[9.5px] leading-4 text-ds-faint" title={metric.label}>
            {metric.label}
          </dt>
          <dd className="mt-0.5 truncate text-[14px] font-semibold leading-5 tabular-nums text-ds-ink" title={metric.value}>
            {metric.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function CompactHeatmap({
  buckets,
  weeks,
  positiveTokens
}: {
  buckets: DailyUsageBucket[]
  weeks: ReturnType<typeof buildUsageCalendarWeeks>
  positiveTokens: number[]
}): ReactElement {
  const { t } = useTranslation('common')

  return (
    <div className="mt-3 border-t border-ds-border-muted pt-3">
      <div className="max-w-full overflow-x-auto pb-1 [scrollbar-width:thin]">
        <div
          role="grid"
          aria-label={t('usageHeatmapGridLabel')}
          className="grid min-w-max gap-x-px"
          style={{ gridTemplateColumns: `repeat(${Math.max(weeks.length, 1)}, 5px)` }}
        >
          {weeks.map((week) => (
            <span key={week.key} role="row" className="grid grid-rows-7 gap-y-px">
              {week.cells.map((bucket, index) => bucket ? (
                <span
                  key={bucket.date}
                  role="gridcell"
                  title={`${bucket.date} · ${formatCompactNumber(bucket.totalTokens)} tokens · ${bucket.turns} turns`}
                  aria-label={`${bucket.date} · ${bucket.totalTokens} tokens · ${bucket.turns} turns`}
                  className={`h-[5px] w-[5px] rounded-[1px] ${
                    heatmapCellClass(usageHeatmapIntensityLevel(bucket, positiveTokens))
                  }`}
                />
              ) : (
                <span key={`${week.key}-${index}`} aria-hidden className="h-[5px] w-[5px]" />
              ))}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[9px] text-ds-faint">
        <span>{t('usageHeatmapLess')}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            aria-hidden
            className={`h-2 w-2 rounded-[2px] ${heatmapCellClass(level)}`}
          />
        ))}
        <span>{t('usageHeatmapMore')}</span>
        <span className="sr-only">{buckets.length}</span>
      </div>
    </div>
  )
}

function heatmapCellClass(level: number): string {
  switch (level) {
    case 1: return 'bg-emerald-400 dark:bg-emerald-700'
    case 2: return 'bg-teal-500 dark:bg-teal-600'
    case 3: return 'bg-cyan-600 dark:bg-cyan-500'
    case 4: return 'bg-blue-700 dark:bg-blue-400'
    default: return 'border border-ds-border-muted bg-ds-surface-subtle'
  }
}

function formatRecordedCost(
  costUsd: number | null | undefined,
  costCny: number | null | undefined,
  locale: string
): string {
  const chineseLocale = /^zh(?:-|$)/i.test(locale.trim())
  const hasRecordedCny = typeof costCny === 'number' && Number.isFinite(costCny) && costCny > 0
  return formatCost(costUsd, chineseLocale && !hasRecordedCny ? 'en' : locale, costCny)
}
