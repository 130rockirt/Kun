import {
  AlertCircle,
  CircleOff,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ProviderQuotaEntry,
  ProviderQuotaListResult,
  ProviderQuotaMetric,
  ProviderQuotaStatus
} from '@shared/provider-quota'

type StatusPresentation = {
  labelKey: string
  className: string
  icon: typeof Gauge
}

const STATUS_PRESENTATION: Record<ProviderQuotaStatus, StatusPresentation> = {
  available: {
    labelKey: 'providerQuotaAvailable',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/35 dark:text-emerald-300',
    icon: Gauge
  },
  unsupported: {
    labelKey: 'providerQuotaUnsupported',
    className: 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted',
    icon: CircleOff
  },
  missing_credentials: {
    labelKey: 'providerQuotaMissingCredentials',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-300',
    icon: KeyRound
  },
  error: {
    labelKey: 'providerQuotaError',
    className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-300',
    icon: AlertCircle
  }
}

export function ProviderQuotaPanel(): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [result, setResult] = useState<ProviderQuotaListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (manual = false): Promise<void> => {
    if (manual) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      if (typeof window.kunGui?.listProviderQuotas !== 'function') {
        throw new Error(t('providerQuotaUnavailable'))
      }
      setResult(await window.kunGui.listProviderQuotas())
    } catch (cause) {
      setError(cause instanceof Error && cause.message
        ? cause.message
        : t('providerQuotaLoadFailed'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openDashboard = (url: string): void => {
    if (typeof window.kunGui?.openExternal === 'function') {
      void window.kunGui.openExternal(url)
    }
  }

  return (
    <section
      aria-label={t('providerQuotaTitle')}
      className="ds-no-drag flex h-full min-h-0 flex-col overflow-hidden bg-ds-sidebar"
    >
      <header className="shrink-0 border-b border-ds-border-muted px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-ds-border-muted bg-ds-card text-accent shadow-sm">
            <Gauge className="h-4.5 w-4.5" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-ds-ink">{t('providerQuotaTitle')}</h2>
            <p className="mt-0.5 text-[11px] leading-4 text-ds-muted">
              {t('providerQuotaDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={loading || refreshing}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 text-[11px] font-semibold text-ds-muted transition hover:border-ds-border-strong hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-55"
            aria-label={refreshing ? t('providerQuotaRefreshing') : t('providerQuotaRefresh')}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading || refreshing ? 'animate-spin' : ''}`}
              strokeWidth={1.9}
            />
            {t(refreshing ? 'providerQuotaRefreshing' : 'providerQuotaRefresh')}
          </button>
        </div>
        {result?.refreshedAt ? (
          <p className="mt-2 text-[10.5px] text-ds-faint">
            {t('providerQuotaLastRefreshed', {
              time: formatQuotaDate(result.refreshedAt, i18n.resolvedLanguage)
            })}
          </p>
        ) : null}
      </header>

      <div
        data-provider-quota-scroller
        className="h-0 min-h-0 flex-1 touch-pan-y overscroll-contain overflow-y-auto overflow-x-hidden px-3 py-3 [scrollbar-gutter:stable]"
        onWheel={(event) => event.stopPropagation()}
      >
        {loading && !result ? (
          <div role="status" className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-ds-muted">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.8} />
            <p className="text-[12px]">{t('providerQuotaLoading')}</p>
          </div>
        ) : error && !result ? (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-[12px] leading-5 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-300">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
              <span>{error}</span>
            </div>
          </div>
        ) : result && result.entries.length === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
            <CircleOff className="h-6 w-6 text-ds-faint" strokeWidth={1.6} />
            <p className="text-[13px] font-semibold text-ds-ink">{t('providerQuotaEmpty')}</p>
            <p className="text-[11px] leading-4 text-ds-muted">{t('providerQuotaEmptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {error ? (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-300">
                {error}
              </div>
            ) : null}
            {result?.entries.map((entry) => (
              <ProviderQuotaCard
                key={entry.providerId}
                entry={entry}
                locale={i18n.resolvedLanguage}
                onOpenDashboard={openDashboard}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ProviderQuotaCard({
  entry,
  locale,
  onOpenDashboard
}: {
  entry: ProviderQuotaEntry
  locale?: string
  onOpenDashboard: (url: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const presentation = STATUS_PRESENTATION[entry.status]
  const StatusIcon = presentation.icon
  return (
    <article
      data-provider-quota-status={entry.status}
      className="rounded-[14px] border border-ds-border-muted bg-ds-card p-3 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[13px] font-semibold text-ds-ink">{entry.providerName}</h3>
            <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold ${presentation.className}`}>
              <StatusIcon className="h-2.5 w-2.5" strokeWidth={2} />
              {t(presentation.labelKey)}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[9.5px] text-ds-faint">{entry.providerId}</p>
        </div>
        {entry.dashboardUrl ? (
          <button
            type="button"
            onClick={() => onOpenDashboard(entry.dashboardUrl!)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={t('providerQuotaOpenDashboard', { provider: entry.providerName })}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

      {entry.summary ? (
        <p className="mt-2 text-[11px] font-medium text-ds-muted">{entry.summary}</p>
      ) : null}

      {entry.status === 'available' ? (
        entry.metrics.length > 0 ? (
          <div className="mt-2.5 space-y-2">
            {entry.metrics.map((metric) => (
              <QuotaMetric key={metric.id} metric={metric} locale={locale} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-ds-muted">{t('providerQuotaNoMetrics')}</p>
        )
      ) : (
        <p className="mt-2 text-[11px] leading-4 text-ds-muted">
          {entry.status === 'unsupported'
            ? t('providerQuotaUnsupportedHint')
            : entry.status === 'missing_credentials'
              ? t('providerQuotaMissingCredentialsHint')
              : entry.message || t(presentation.labelKey)}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1 border-t border-ds-border-muted pt-2 text-[9.5px] text-ds-faint">
        <span>{entry.source || t('providerQuotaUnsupportedSource')}</span>
        {entry.updatedAt ? (
          <span>{t('providerQuotaUpdated', {
            time: formatQuotaDate(entry.updatedAt, locale)
          })}</span>
        ) : null}
      </div>
    </article>
  )
}

function QuotaMetric({
  metric,
  locale
}: {
  metric: ProviderQuotaMetric
  locale?: string
}): ReactElement {
  const { t } = useTranslation('common')
  const values = [
    metric.remaining === undefined
      ? null
      : { label: t('providerQuotaRemaining'), value: metric.remaining },
    metric.used === undefined
      ? null
      : { label: t('providerQuotaUsed'), value: metric.used },
    metric.limit === undefined
      ? null
      : { label: t('providerQuotaLimit'), value: metric.limit }
  ].filter((item): item is { label: string; value: number } => item !== null)

  return (
    <div className="rounded-xl border border-ds-border-muted bg-ds-surface-subtle/65 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[10.5px] font-semibold leading-4 text-ds-ink">{metric.label}</p>
        {metric.usedPercent !== undefined ? (
          <span className="shrink-0 text-[10px] font-semibold tabular-nums text-ds-muted">
            {Math.round(metric.usedPercent)}%
          </span>
        ) : null}
      </div>
      {metric.usedPercent !== undefined ? (
        <div
          role="progressbar"
          aria-label={metric.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(metric.usedPercent)}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ds-border-muted"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, metric.usedPercent))}%` }}
          />
        </div>
      ) : null}
      {values.length > 0 ? (
        <dl className="mt-2 grid grid-cols-3 gap-2">
          {values.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-[9px] text-ds-faint">{item.label}</dt>
              <dd className="mt-0.5 truncate text-[10.5px] font-semibold tabular-nums text-ds-ink">
                {formatQuotaValue(item.value, metric.unit, locale)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {metric.resetsAt ? (
        <p className="mt-1.5 text-[9.5px] text-ds-faint">
          {t('providerQuotaResetsAt', { time: formatQuotaDate(metric.resetsAt, locale) })}
        </p>
      ) : null}
    </div>
  )
}

export function formatQuotaValue(value: number, unit: string, locale?: string): string {
  const compact = Math.abs(value) >= 100_000
  const formatted = new Intl.NumberFormat(locale, {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 4
  }).format(value)
  return `${formatted} ${unit}`
}

function formatQuotaDate(value: string, locale?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}
