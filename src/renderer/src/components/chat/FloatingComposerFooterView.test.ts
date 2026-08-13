import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { primaryCacheHitRate } from '../../hooks/use-thread-usage'
import { readStylesheetBundle } from '../../testing/stylesheet-bundle'
import { FloatingComposerFooterView } from './FloatingComposerFooterView'

function UsageHistory({ children, title }: { children: ReactNode, title: string }) {
  return createElement('button', { title }, children)
}

function translate(key: string, values: Record<string, unknown> = {}): string {
  const text = {
    sessionUsageFooterLabel: 'Session usage',
    sessionUsageFooterTokens: `${values.tokens} tokens`,
    sessionUsageFooterCache: `${values.cache} cache`,
    sessionUsageFooterTurns: `${values.turns} turns`,
    sessionUsageFooterTtft: `TTFT ${values.ttft}`,
    sessionUsageFooterTps: `${values.tps} tok/s`,
    sessionUsageAvgMetricsTitle: 'Average timing',
    sessionUsageDetailsTitle: `${values.tokens} tokens · ${values.cost} · ${values.turns} turns`,
    sessionUsageDetailsTitleWithLatestCache: `${values.tokens} tokens · ${values.cost} · ${values.turns} turns`,
    sessionUsageLoading: 'Loading usage',
    sessionUsageUnavailable: 'No usage yet',
    usageHistoryOpen: 'Open usage history',
    usageHistoryTitle: 'Usage history'
  } as Record<string, string>
  return text[key] ?? key
}

function usageSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totalTokens: 11_900_000,
    costUsd: 1.25,
    costCny: null,
    cacheHitRate: 0.41,
    lastTurnCacheHitRate: 0.95,
    cachedTokens: 410,
    cacheMissTokens: 590,
    turns: 278,
    avgTtftMs: 6200,
    avgTokensPerSecond: 121.9,
    ...overrides
  }
}

function renderFooter(overrides: Record<string, unknown> = {}): string {
  const usage = usageSummary()
  const context = {
    BarChart3: () => createElement('svg'),
    FloatingComposerUsageHistory: UsageHistory,
    activeThreadId: 'thread-1',
    compact: false,
    primaryCacheHitRate,
    footerHint: 'Enter to send · Shift+Enter for newline',
    formatCompactNumber: (value: number) => value === 11_900_000 ? '11.9M' : String(value),
    formatCost: () => '$1.25',
    formatPercent: (value: number | null) => value == null ? '-' : `${Math.round(value * 100)}%`,
    formatTps: () => '121.9',
    formatTtftSeconds: () => '6.2s',
    i18n: { language: 'en' },
    showUsageHistoryFooter: true,
    t: translate,
    threadUsage: usage,
    threadUsageState: { loading: false },
    timingThreadUsage: usage,
    ...overrides
  }
  return renderToStaticMarkup(createElement(FloatingComposerFooterView, { context }))
}

describe('FloatingComposerFooterView', () => {
  it('renders separately collapsible session metrics without a visible cost metric', () => {
    const html = renderFooter()

    expect(html).toContain('Session usage')
    expect(html).toContain('ds-composer-usage-tokens')
    expect(html).toContain('ds-composer-usage-cache')
    expect(html).toContain('ds-composer-usage-turns')
    expect(html).toContain('ds-composer-usage-ttft')
    expect(html).toContain('ds-composer-usage-tps')
    expect(html).toContain('ds-composer-usage-cache-indicator')
    expect(html).toContain('ds-composer-usage-cache-value')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('95% cache')
    expect(html).not.toContain('41% cache')
    expect(html).not.toContain('ds-composer-usage-cost')
  })

  it('omits cache when latest-request telemetry is unavailable instead of using cumulative usage', () => {
    const html = renderFooter({
      threadUsage: usageSummary({ lastTurnCacheHitRate: null, cacheHitRate: 0.81 })
    })

    expect(html).not.toContain('ds-composer-usage-cache')
    expect(html).not.toContain('81% cache')
  })

  it('omits cache when the latest-request cache hit rate is zero', () => {
    const html = renderFooter({
      threadUsage: usageSummary({ lastTurnCacheHitRate: 0, cacheHitRate: 0.81 })
    })

    expect(html).not.toContain('ds-composer-usage-cache')
    expect(html).not.toContain('0% cache')
    expect(html).not.toContain('81% cache')
  })

  it('keeps loading and unavailable states in the same history trigger', () => {
    expect(renderFooter({ threadUsage: null, threadUsageState: { loading: true } })).toContain('Loading usage')
    expect(renderFooter({ activeThreadId: null, threadUsage: null })).toContain('Usage history')
  })

  it('omits the footer from compact composers', () => {
    expect(renderFooter({ compact: true })).toBe('')
  })

  it('defines the planned container-query reductions without wrapping the footer', async () => {
    const css = await readStylesheetBundle(new URL('../../styles/base-shell.css', import.meta.url))

    expect(css).toMatch(/\.ds-composer-footer\s*\{[^}]*height:\s*2\.5rem[^}]*border-top:\s*0/s)
    expect(css).toMatch(/\.ds-composer-usage-cache-value\s*\{[^}]*min-width:\s*4\.5rem[^}]*overflow:\s*hidden/s)
    expect(css).toContain('@keyframes ds-composer-cache-value-in')
    expect(css).toContain('@keyframes ds-composer-cache-value-out')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ds-composer-usage-cache-value-in/s)
    expect(css).toMatch(/@container \(max-width: 760px\)[\s\S]*?\.ds-composer-footer-hint/s)
    expect(css).toMatch(/@container \(max-width: 640px\)[\s\S]*?\.ds-composer-usage-label/s)
    expect(css).toMatch(/@container \(max-width: 560px\)[\s\S]*?\.ds-composer-usage-ttft/s)
    expect(css).toMatch(/@container \(max-width: 460px\)[\s\S]*?\.ds-composer-usage-turns/s)
  })
})
