import type { ReactElement } from 'react'
import type { FloatingComposerRenderContext } from './floating-composer-view-context'

export function FloatingComposerFooterView({
  context
}: {
  context: FloatingComposerRenderContext
}): ReactElement | null {
  const {
    BarChart3, FloatingComposerUsageHistory, activeThreadId, compact,
    cumulativeCacheHitRate, footerHint, formatCompactNumber, formatCost, formatPercent, formatTps,
    formatTtftSeconds, i18n, showUsageHistoryFooter, t, threadUsage, threadUsageState,
    timingThreadUsage
  } = context
  if (compact) return null

  return (
    <div className="ds-composer-footer ds-no-drag">
      <div className="ds-composer-footer-left">
        {showUsageHistoryFooter ? (
          <FloatingComposerUsageHistory
            title={
              threadUsage
                ? t(
                    threadUsage.lastTurnCacheHitRate != null
                      ? 'sessionUsageDetailsTitleWithLatestCache'
                      : 'sessionUsageDetailsTitle',
                    {
                      tokens: formatCompactNumber(threadUsage.totalTokens),
                      cost: formatCost(threadUsage.costUsd, i18n.language, threadUsage.costCny),
                      cache: formatPercent(threadUsage.cacheHitRate),
                      latestCache: formatPercent(threadUsage.lastTurnCacheHitRate),
                      cached: formatCompactNumber(threadUsage.cachedTokens),
                      miss: formatCompactNumber(threadUsage.cacheMissTokens),
                      turns: threadUsage.turns
                    }
                  )
                : activeThreadId
                  ? t('sessionUsageUnavailable')
                  : t('usageHistoryOpen')
            }
          >
            <BarChart3 className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.9} />
            <span className="ds-composer-usage-label shrink-0">
              {t('sessionUsageFooterLabel')}
            </span>
            {threadUsage ? (
              <>
                <span className="ds-composer-usage-metric ds-composer-usage-tokens shrink-0 tabular-nums">
                  {t('sessionUsageFooterTokens', {
                    tokens: formatCompactNumber(threadUsage.totalTokens)
                  })}
                </span>
                {threadUsage.turns > 1 ? (
                  <span className="ds-composer-usage-metric ds-composer-usage-cache shrink-0 tabular-nums">
                    <span className="ds-composer-usage-cache-indicator" aria-hidden="true" />
                    {t('sessionUsageFooterCache', {
                      cache: formatPercent(cumulativeCacheHitRate(threadUsage))
                    })}
                  </span>
                ) : null}
                <span className="ds-composer-usage-metric ds-composer-usage-turns shrink-0 tabular-nums">
                  {t('sessionUsageFooterTurns', { turns: threadUsage.turns })}
                </span>
                {timingThreadUsage?.avgTtftMs != null ? (
                  <span
                    className="ds-composer-usage-metric ds-composer-usage-ttft shrink-0 tabular-nums"
                    title={t('sessionUsageAvgMetricsTitle')}
                  >
                    {t('sessionUsageFooterTtft', {
                      ttft: formatTtftSeconds(timingThreadUsage.avgTtftMs) ?? '-'
                    })}
                  </span>
                ) : null}
                {timingThreadUsage?.avgTokensPerSecond != null ? (
                  <span
                    className="ds-composer-usage-metric ds-composer-usage-tps shrink-0 tabular-nums"
                    title={t('sessionUsageAvgMetricsTitle')}
                  >
                    {t('sessionUsageFooterTps', {
                      tps: formatTps(timingThreadUsage.avgTokensPerSecond) ?? '-'
                    })}
                  </span>
                ) : null}
              </>
            ) : activeThreadId ? (
              <span className="shrink-0 text-ds-faint">
                {threadUsageState.loading
                  ? t('sessionUsageLoading')
                  : t('sessionUsageUnavailable')}
              </span>
            ) : (
              <span className="shrink-0 text-ds-muted">
                {t('usageHistoryTitle')}
              </span>
            )}
          </FloatingComposerUsageHistory>
        ) : null}
      </div>
      {footerHint ? (
        <div className="ds-composer-footer-hint">
          <span>{footerHint}</span>
        </div>
      ) : null}
    </div>
  )
}
