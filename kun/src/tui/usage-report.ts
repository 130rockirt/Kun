import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI
} from '@earendil-works/pi-tui'
import type {
  ThreadUsageBucket,
  ThreadUsageResponse,
  ThreadUsageTotals
} from '../contracts/usage.js'
import { redactSecretText } from '../config/secret-redaction.js'
import { sanitizeTerminalText } from './layout.js'
import {
  joinVisualSides,
  pageFrame,
  sectionLabel,
  statusGlyph,
  visual,
  visualDensity
} from './visual-system.js'

const safe = (value: string): string => sanitizeTerminalText(redactSecretText(value))
const bold = visual.strong
const dim = visual.muted
const cyan = visual.focus
const yellow = visual.warning
const red = visual.danger

export type UsageReportData = {
  usage: ThreadUsageResponse
  activeThreadId?: string
  threadTitles?: Readonly<Record<string, string>>
}

export class UsageDialog implements Component, Focusable {
  private snapshot?: UsageReportData
  private loading = false
  private error = ''
  private refreshedAt?: number
  private offset = 0
  private maxOffset = 0
  private pageSize = 1
  private _focused = true

  constructor(
    private readonly tui: TUI,
    private readonly load: () => Promise<UsageReportData>,
    private readonly close: () => void,
    private readonly terminalRows: () => number,
    private readonly nowMs: () => number = Date.now
  ) {}

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  async refresh(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.error = ''
    this.tui.requestRender()
    try {
      this.snapshot = await this.load()
      this.refreshedAt = this.nowMs()
      this.offset = 0
    } catch (error) {
      this.error = safe(error instanceof Error ? error.message : 'Usage refresh failed.')
      this.offset = 0
    } finally {
      this.loading = false
      this.tui.requestRender()
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(12, width - 2)
    const body = usageReportBody(
      this.snapshot,
      contentWidth,
      this.loading,
      this.error,
      this.nowMs()
    )
    this.pageSize = Math.max(1, this.terminalRows() - 7)
    this.maxOffset = Math.max(0, body.length - this.pageSize)
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset))
    const visible = body.slice(this.offset, this.offset + this.pageSize)
    const range = this.maxOffset > 0
      ? `${this.offset + 1}-${Math.min(body.length, this.offset + this.pageSize)}/${body.length}`
      : ''
    const refreshed = this.refreshedAt
      ? `updated ${formatClock(this.refreshedAt)}`
      : this.loading
        ? 'loading'
        : ''
    return pageFrame({
      path: ['KUN', 'Usage'],
      right: [this.loading && this.snapshot ? 'refreshing' : refreshed, range].filter(Boolean).join(' · '),
      description: 'Local accumulated model usage. Provider allowance is shown in /quota.',
      body: visible,
      footer: [
        ...(this.maxOffset > 0 ? [{ key: '↑/↓ PgUp/PgDn', label: 'navigate' }] : []),
        { key: 'r', label: this.loading ? 'refreshing…' : 'refresh' },
        { key: '/quota', label: 'provider allowance' },
        { key: '/context', label: 'request context' },
        { key: 'Esc', label: 'back' }
      ],
      width
    })
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.close()
      return
    }
    const key = data.toLowerCase()
    if (key === 'r' || matchesKey(data, 'ctrl+r')) {
      void this.refresh()
      return
    }
    if (matchesKey(data, 'up') || key === 'k') this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down') || key === 'j') this.offset = Math.min(this.maxOffset, this.offset + 1)
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - this.pageSize)
    else if (matchesKey(data, 'pageDown')) this.offset = Math.min(this.maxOffset, this.offset + this.pageSize)
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = this.maxOffset
    this.tui.requestRender()
  }

  invalidate(): void {}
}

export function usageReportBody(
  snapshot: UsageReportData | undefined,
  width: number,
  loading = false,
  error = '',
  nowMs = Date.now()
): string[] {
  if (!snapshot) {
    return [
      loading
        ? ` ${statusGlyph('running', Math.floor(nowMs / 200))} ${yellow('Loading Kun usage…')}`
        : ` ${statusGlyph('failed')} ${red(error || 'Kun usage is unavailable.')}`
    ]
  }

  const lines: string[] = []
  if (error) {
    lines.push(
      ` ${statusGlyph('warning')} ${yellow('Refresh failed')}  ${dim(safe(error))}`,
      ''
    )
  } else if (loading) {
    lines.push(
      ` ${statusGlyph('running', Math.floor(nowMs / 200))} ${dim('Refreshing Kun usage…')}`,
      ''
    )
  }

  const current = snapshot.activeThreadId
    ? snapshot.usage.buckets.find((bucket) => bucket.thread_id === snapshot.activeThreadId)
    : undefined
  lines.push(sectionLabel('CURRENT SESSION', width))
  if (current) {
    lines.push(...usageMetricRows(currentMetrics(current), width))
  } else {
    lines.push(` ${statusGlyph('idle')} ${dim(
      snapshot.activeThreadId
        ? 'No usage has been recorded for the current session.'
        : 'No current session is open.'
    )}`)
  }

  lines.push('', sectionLabel('ALL SESSIONS', width))
  if (hasUsage(snapshot.usage.totals)) {
    lines.push(...usageMetricRows(totalMetrics(snapshot.usage.totals), width))
  } else {
    lines.push(` ${statusGlyph('idle')} ${dim('No accumulated Kun usage has been recorded.')}`)
  }

  lines.push('', sectionLabel('TOP SESSIONS', width))
  const top = snapshot.usage.buckets
    .filter(hasUsage)
    .slice(0, 3)
  if (top.length === 0) {
    lines.push(` ${statusGlyph('idle')} ${dim('No session usage is available.')}`)
  } else {
    const maxTokens = Math.max(1, ...top.map((bucket) => bucket.total_tokens))
    top.forEach((bucket, index) => {
      const title = snapshot.threadTitles?.[bucket.thread_id]?.trim() || bucket.thread_id
      lines.push(...topSessionLines(bucket, title, index + 1, maxTokens, width))
    })
  }
  return lines
}

function currentMetrics(bucket: ThreadUsageBucket): UsageMetric[] {
  return [
    { label: 'Total tokens', value: formatAmount(bucket.total_tokens) },
    { label: 'Turns', value: formatAmount(bucket.turns) },
    { label: 'Input tokens', value: formatAmount(bucket.input_tokens) },
    { label: 'Output tokens', value: formatAmount(bucket.output_tokens) },
    { label: 'Cached tokens', value: formatAmount(bucket.cached_tokens) },
    { label: 'Cache hit', value: formatRate(bucket.cache_hit_rate) },
    { label: 'Reasoning tokens', value: formatAmount(bucket.reasoning_tokens) },
    { label: 'Recorded cost', value: formatCost(bucket.cost_usd, bucket.cost_cny) }
  ]
}

function totalMetrics(totals: ThreadUsageTotals): UsageMetric[] {
  return [
    { label: 'Total tokens', value: formatAmount(totals.total_tokens) },
    { label: 'Sessions', value: formatAmount(totals.thread_count) },
    { label: 'Input tokens', value: formatAmount(totals.input_tokens) },
    { label: 'Output tokens', value: formatAmount(totals.output_tokens) },
    { label: 'Cached tokens', value: formatAmount(totals.cached_tokens) },
    { label: 'Cache hit', value: formatRate(totals.cache_hit_rate) },
    { label: 'Context saved', value: formatAmount(totals.token_economy_savings_tokens) },
    { label: 'Recorded cost', value: formatCost(totals.cost_usd, totals.cost_cny) }
  ]
}

type UsageMetric = {
  label: string
  value: string
}

function usageMetricRows(metrics: readonly UsageMetric[], width: number): string[] {
  if (visualDensity(width) === 'wide') {
    const rows: string[] = []
    for (let index = 0; index < metrics.length; index += 2) {
      const left = metrics[index]!
      const right = metrics[index + 1]
      rows.push(joinVisualSides(
        ` ${dim(left.label)}  ${cyan(left.value)}`,
        right ? `${dim(right.label)}  ${cyan(right.value)} ` : '',
        width
      ))
    }
    return rows
  }
  return metrics.map((metric) =>
    joinVisualSides(` ${dim(metric.label)}`, cyan(metric.value), width)
  )
}

function topSessionLines(
  bucket: ThreadUsageBucket,
  title: string,
  rank: number,
  maxTokens: number,
  width: number
): string[] {
  const density = visualDensity(width)
  const label = `${rank}. ${safe(title)}`
  const value = formatAmount(bucket.total_tokens)
  const cells = density === 'narrow'
    ? Math.max(6, width - 8)
    : Math.max(10, Math.min(28, Math.floor(width * 0.34)))
  const ratio = bucket.total_tokens / maxTokens
  const filled = Math.max(1, Math.round(ratio * cells))
  const bar = `[${cyan('■'.repeat(filled))}${dim('·'.repeat(cells - filled))}]`
  if (density === 'wide') {
    const prefixWidth = Math.max(12, width - visibleWidth(bar) - value.length - 5)
    return [
      joinVisualSides(
        ` ${truncateToWidth(label, prefixWidth)}  ${bar}`,
        cyan(value),
        width
      )
    ]
  }
  return [
    joinVisualSides(` ${bold(truncateToWidth(label, Math.max(8, width - value.length - 3)))}`, cyan(value), width),
    truncateToWidth(`   ${bar}`, width)
  ]
}

function hasUsage(
  value: Pick<ThreadUsageBucket | ThreadUsageTotals, 'total_tokens' | 'turns' | 'cost_usd' | 'cost_cny'>
): boolean {
  return value.total_tokens > 0 || value.turns > 0 || value.cost_usd > 0 || value.cost_cny > 0
}

function formatAmount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US')
}

function formatRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const percent = Math.max(0, Math.min(100, value * 100))
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`
}

function formatCost(usd: number, cny: number): string {
  const values = [
    usd > 0 ? `$${formatMoney(usd)}` : '',
    cny > 0 ? `CNY ${formatMoney(cny)}` : ''
  ].filter(Boolean)
  return values.join(' · ') || '—'
}

function formatMoney(value: number): string {
  if (value > 0 && value < 0.0001) return '<0.0001'
  return value.toFixed(value >= 1 ? 2 : 4)
}

function formatClock(value: number): string {
  const date = new Date(value)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

export function usageReportVisibleWidth(lines: readonly string[]): number {
  return Math.max(0, ...lines.map((line) => visibleWidth(line)))
}
