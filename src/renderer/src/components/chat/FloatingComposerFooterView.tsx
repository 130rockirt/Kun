import type { ReactElement } from 'react'
import type { FloatingComposerRenderContext } from './floating-composer-view-context'

export function FloatingComposerFooterView({
  context
}: {
  context: FloatingComposerRenderContext
}): ReactElement {
  const {
    BarChart3, FloatingComposerUsageHistory, activeThreadId, compact,
    cumulativeCacheHitRate, footerHint, formatCompactNumber, formatCost, formatPercent, formatTps,
    formatTtftSeconds, i18n, showUsageHistoryFooter, t, threadUsage, threadUsageState,
    timingThreadUsage
  } = context
  return (
    <>
      {compact ? null : (
        <div className="ds-composer-footer mt-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 px-3">
          <div className="ds-composer-footer-left flex min-w-0 flex-1 flex-wrap items-center gap-2">
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
                {threadUsage ? (
                  <>
                    <span className="ds-composer-usage-tokens shrink-0 truncate tabular-nums">
                      {t('sessionUsageTokens', {
                        tokens: formatCompactNumber(threadUsage.totalTokens)
                      })}
                    </span>
                    <span className="ds-composer-usage-cost-separator text-ds-faint">·</span>
                    <span className="ds-composer-usage-cost shrink-0 truncate tabular-nums">
                      {t('sessionUsageCost', {
                        cost: formatCost(threadUsage.costUsd, i18n.language, threadUsage.costCny)
                      })}
                    </span>
                    {threadUsage.turns > 1 ? (
                      <>
                        <span className="ds-composer-usage-cache-separator text-ds-faint">·</span>
                        <span className="ds-composer-usage-cache shrink-0 truncate tabular-nums">
                          {t('sessionUsageCache', {
                            cache: formatPercent(cumulativeCacheHitRate(threadUsage))
                          })}
                        </span>
                      </>
                    ) : null}
                    <span className="ds-composer-usage-turns-separator text-ds-faint">·</span>
                    <span className="ds-composer-usage-turns shrink-0 truncate tabular-nums">
                      {t('sessionUsageTurns', { turns: threadUsage.turns })}
                    </span>
                    {timingThreadUsage &&
                    (timingThreadUsage.avgTtftMs != null || timingThreadUsage.avgTokensPerSecond != null) ? (
                      <>
                        <span className="ds-composer-usage-turns-separator text-ds-faint">·</span>
                        <span
                          className="ds-composer-usage-metrics shrink-0 truncate tabular-nums"
                          title={t('sessionUsageAvgMetricsTitle')}
                        >
                          {t('sessionUsageAvgMetrics', {
                            ttft: formatTtftSeconds(timingThreadUsage.avgTtftMs) ?? '-',
                            tps: formatTps(timingThreadUsage.avgTokensPerSecond) ?? '-'
                          })}
                        </span>
                      </>
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
            <div className="ds-composer-footer-hint min-w-0 flex-1 text-right text-[12.5px] font-medium text-ds-faint">
              <span className="block truncate">{footerHint}</span>
            </div>
          ) : null}
        </div>
      )}    </>
  )
}
