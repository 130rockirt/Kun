import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TurnUsageActualCost, TurnUsageSummary } from '../../hooks/use-turn-usage'
import {
  formatProviderLocalCostAmount,
  formatProviderLocalCostCount
} from '../provider-local-cost-summary'

export function TurnUsageRow({
  usage,
  stale = false
}: {
  usage: TurnUsageSummary
  stale?: boolean
}): ReactElement {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const hasReference = usage.referenceEstimateUsd !== null &&
    usage.estimateCoverage !== 'unavailable'
  const unavailable = usage.actualCost === null && !hasReference

  return (
    <div
      className="turn-usage-row flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ds-faint"
      data-turn-usage={usage.turnId}
      data-estimate-coverage={usage.estimateCoverage}
      data-stale={stale ? 'true' : 'false'}
    >
      <span className="whitespace-nowrap tabular-nums">
        {t('sessionUsageFooterTokens', {
          tokens: formatProviderLocalCostCount(usage.totalTokens, locale)
        })}
      </span>
      {usage.actualCost ? (
        <span
          className="whitespace-nowrap tabular-nums text-ds-muted"
          title={t('sessionUsageActualCostTitle')}
          data-turn-usage-actual-cost
        >
          {t('sessionUsageFooterActualCost', {
            value: formatTurnActualCost(usage.actualCost, locale)
          })}
        </span>
      ) : null}
      {hasReference ? (
        <span
          className="whitespace-nowrap tabular-nums text-ds-muted"
          title={t('sessionUsageEstimateTitle')}
          data-turn-usage-reference-estimate
        >
          {t('sessionUsageFooterEstimate', {
            value: formatProviderLocalCostAmount(usage.referenceEstimateUsd as number, locale)
          })}
        </span>
      ) : null}
      {usage.estimateCoverage === 'partial' && hasReference ? (
        <span
          className="rounded-full border border-amber-500/30 px-1.5 text-[10.5px] text-amber-700 dark:text-amber-300"
          title={t('sessionUsageEstimateTitle')}
          data-turn-usage-partial
        >
          {t('turnUsageEstimatePartial')}
        </span>
      ) : null}
      {unavailable ? (
        <span
          className="whitespace-nowrap"
          title={t('sessionUsagePriceUnavailableTitle')}
          data-turn-usage-unavailable
        >
          {t('sessionUsagePriceUnavailable')}
        </span>
      ) : null}
      {stale ? (
        <span
          className="whitespace-nowrap"
          title={t('turnUsageStaleTitle')}
          data-turn-usage-stale
        >
          {t('turnUsageStale')}
        </span>
      ) : null}
    </div>
  )
}

export function formatTurnActualCost(
  cost: TurnUsageActualCost,
  locale?: string
): string {
  const value = Math.max(0, Number.isFinite(cost.amount) ? cost.amount : 0)
  if (value > 0 && value < 0.0001) {
    const symbol = cost.currency === 'USD' ? '$' : cost.currency === 'CNY' ? '￥' : `${cost.currency} `
    return `${symbol}<0.0001`
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: cost.currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4
  }).format(value)
}
