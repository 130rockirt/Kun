import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, Clipboard, RefreshCw, ScanSearch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SemanticRequest } from '../../agent/agent-perspective-events'
import type {
  ModelRequestTraceBody,
  ModelRequestTraceHeaders,
  ModelRequestTraceRecord
} from '../../agent/model-request-traces'
import {
  attemptLabel,
  failureOriginLabel,
  formatMilliseconds,
  formatTimestamp,
  formatValue,
  phaseLabel,
  prettyJson,
  requestFailed,
  statusLabel
} from './agent-perspective-support'
import type { BodyMode } from './agent-perspective-types'

export function RawRequest({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  if (!record.request) {
    return <EmptyState text={record.status === 'not_started' ? t('agentPerspectiveNoRequest') : t('agentPerspectiveNoResponse')} />
  }
  return (
    <div className="space-y-4">
      <DetailBlock title={t('agentPerspectiveUrl')} value={record.request.url} copyValue={record.request.url} mono />
      <HeadersTable headers={record.request.headers} />
      <BodyViewer body={record.request.body} title={t('agentPerspectiveBody')} />
      {record.request.urlRedacted || record.request.headers.redactedNames.length > 0 ? <RedactionNotice /> : null}
    </div>
  )
}

export function ResponseDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  if (!record.response && !record.decoded) return <EmptyState text={t('agentPerspectiveNoResponse')} />
  return (
    <div className="space-y-3">
      {record.response ? (
        <div className="flex items-center gap-2 rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 py-2 text-[10px]">
          <StatusDot record={record} />
          <span className="font-semibold">HTTP {record.response.status}</span>
          <span className="text-ds-muted">{record.response.statusText}</span>
        </div>
      ) : null}
      {record.decoded?.text ? <TextCard title={t('agentPerspectiveResponseOutput')} value={record.decoded.text} /> : null}
      {record.decoded?.reasoning ? <TextCard title={t('agentPerspectiveReasoningOutput')} value={record.decoded.reasoning} /> : null}
      {record.decoded?.toolCalls.length ? <JsonCard title={t('agentPerspectiveToolCalls')} value={record.decoded.toolCalls} /> : null}
      {record.decoded?.usage ? <JsonCard title={t('agentPerspectiveUsage')} value={record.decoded.usage} /> : null}
      {record.decoded?.error ? <Notice text={record.decoded.error} warning /> : null}
      {record.response ? <HeadersTable headers={record.response.headers} /> : null}
      {!record.decoded?.text && !record.decoded?.reasoning && !record.decoded?.toolCalls.length && !record.decoded?.usage ? (
        <EmptyState text={t('agentPerspectiveNoDecoded')} />
      ) : null}
    </div>
  )
}

export function StreamDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  if (!record.response?.body) return <EmptyState text={record.response?.captureError || t('agentPerspectiveNoResponse')} />
  return (
    <div className="space-y-3">
      <BodyViewer body={record.response.body} title={t('agentPerspectiveRawResponse')} />
      {record.response.body.truncated ? <TruncationNotice /> : null}
    </div>
  )
}

export function TimingDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  const rows: Array<[string, string]> = [
    [t('agentPerspectiveStatus'), statusLabel(t, record)],
    [t('agentPerspectivePhase'), phaseLabel(t, record)],
    [t('agentPerspectiveAttempt'), `${record.attempt} · ${attemptLabel(t, record.attemptReason)}`],
    [t('agentPerspectiveStartedAt'), formatTimestamp(record.startedAt, true)]
  ]
  if (record.failureOrigin) {
    rows.push([t('agentPerspectiveFailureOrigin'), failureOriginLabel(t, record.failureOrigin)])
  }
  if (record.diagnosticCode) {
    rows.push([t('agentPerspectiveDiagnosticCode'), record.diagnosticCode])
  }
  if (record.responseStartedAt) rows.push([t('agentPerspectiveResponseStartedAt'), formatTimestamp(record.responseStartedAt, true)])
  if (record.finishedAt) rows.push([t('agentPerspectiveFinishedAt'), formatTimestamp(record.finishedAt, true)])
  if (record.timeToHeadersMs !== undefined) rows.push([t('agentPerspectiveTimeToHeaders'), `${Math.round(record.timeToHeadersMs)} ms`])
  if (record.durationMs !== undefined) rows.push([t('agentPerspectiveDuration'), `${Math.round(record.durationMs)} ms`])
  return (
    <div className="space-y-3">
      <dl className="overflow-hidden rounded-lg border border-ds-border-muted">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(110px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted last:border-b-0">
            <dt className="bg-ds-surface-subtle px-2.5 py-2 text-[9px] font-medium text-ds-muted">{label}</dt>
            <dd className="min-w-0 break-words px-2.5 py-2 text-[9px]">{value}</dd>
          </div>
        ))}
      </dl>
      {record.error ? <Notice text={record.error} warning /> : null}
      {record.captureWarnings?.map((warning) => <Notice key={warning} text={warning} warning />)}
      {record.request?.body.truncated || record.response?.body?.truncated ? <TruncationNotice /> : null}
    </div>
  )
}

export function CompositionBar({ items }: { items: Array<{ label: string; value: number; color: string }> }): ReactElement {
  const { t } = useTranslation('common')
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return (
    <section className="rounded-xl border border-ds-border-muted bg-ds-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{t('agentPerspectiveRequestComposition')}</h4>
        <span className="text-[8px] tabular-nums text-ds-faint">≈ {total.toLocaleString()} tokens</span>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ds-surface-subtle">
        {items.filter((item) => item.value > 0).map((item) => (
          <span key={item.label} className={item.color} style={{ width: `${Math.max(2, item.value / Math.max(1, total) * 100)}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[8px] text-ds-muted">
        {items.map((item) => (
          <span key={item.label} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${item.color}`} />
            {item.label} <span className="tabular-nums text-ds-faint">≈{item.value}</span>
          </span>
        ))}
      </div>
    </section>
  )
}

export function SummaryComposition({ items }: { items: Array<{ label: string; value: number; color: string }> }): ReactElement {
  const { t } = useTranslation('common')
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return (
    <section>
      <h4 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">
        {t('agentPerspectiveRequestComposition')}
      </h4>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ds-surface-subtle">
        {items.filter((item) => item.value > 0).map((item) => (
          <span
            key={item.label}
            className={item.color}
            style={{ width: `${Math.max(2, item.value / Math.max(1, total) * 100)}%` }}
          />
        ))}
      </div>
      <p className="mt-2 truncate text-[8px] text-ds-faint">
        {items.map((item) => `${item.label} ${Math.round(item.value / Math.max(1, total) * 100)}%`).join(' · ')}
      </p>
    </section>
  )
}

export function SemanticSection({
  title,
  count,
  icon,
  open = false,
  children
}: {
  title: string
  count: number
  icon: ReactNode
  open?: boolean
  children: ReactNode
}): ReactElement {
  const [expanded, setExpanded] = useState(open)
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group overflow-hidden rounded-xl border border-ds-border-muted bg-ds-card"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] font-semibold hover:bg-ds-hover [&::-webkit-details-marker]:hidden">
        <span className="text-ds-muted">{icon}</span>
        <span>{title}</span>
        <span className="rounded-full bg-ds-surface-subtle px-1.5 py-0.5 text-[8px] font-medium text-ds-faint">{count}</span>
        <ChevronDown className="ml-auto h-3 w-3 text-ds-faint transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-ds-border-muted">{children}</div>
    </details>
  )
}

export function SectionEmpty({ text }: { text: string }): ReactElement {
  return <div className="px-2.5 py-3 text-center text-[9px] text-ds-faint">{text}</div>
}

export function ScrollablePre({
  ariaLabel,
  className,
  children
}: {
  ariaLabel: string
  className: string
  children: ReactNode
}): ReactElement {
  return (
    <pre
      tabIndex={0}
      aria-label={ariaLabel}
      className={`overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${className}`}
    >
      {children}
    </pre>
  )
}

export function MetaChip({ children }: { children: ReactNode }): ReactElement {
  return <span className="max-w-48 truncate rounded-md border border-ds-border-muted bg-ds-surface-subtle px-1.5 py-0.5 text-ds-muted">{children}</span>
}

export function StatusBadge({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  const failed = requestFailed(record)
  const pending = record.status === 'pending'
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-medium ${
      failed
        ? 'bg-red-500/10 text-red-600 dark:text-red-300'
        : pending
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    }`}>
      {failed ? t('agentPerspectiveTransportError') : pending ? t('agentPerspectivePending') : `HTTP ${record.response?.status ?? '200'}`}
    </span>
  )
}

export function StatusDot({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const failed = requestFailed(record)
  const pending = record.status === 'pending'
  return <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : pending ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />
}

export function RoleBadge({ role }: { role: string }): ReactElement {
  const className = role === 'user'
    ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
    : role === 'assistant'
      ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
      : role === 'tool'
        ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
        : 'bg-ds-surface-subtle text-ds-muted'
  return <span className={`rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase ${className}`}>{role}</span>
}

export function EmptyState({
  text,
  spinning = false,
  warning = false
}: {
  text: string
  spinning?: boolean
  warning?: boolean
}): ReactElement {
  const Icon = warning ? AlertTriangle : spinning ? RefreshCw : ScanSearch
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-ds-muted">
      <Icon className={`h-5 w-5 ${spinning ? 'animate-spin' : ''}`} aria-hidden />
      <p className="max-w-72 leading-5">{text}</p>
    </div>
  )
}

export function HeadersTable({ headers }: { headers: ModelRequestTraceHeaders }): ReactElement {
  const { t } = useTranslation('common')
  const entries = Object.entries(headers.values)
  return (
    <section>
      <SectionHeading title={t('agentPerspectiveHeaders')} copyValue={JSON.stringify(headers.values, null, 2)} />
      <div className="overflow-hidden rounded-lg border border-ds-border-muted">
        {entries.length === 0 ? (
          <div className="px-2.5 py-2 text-[10px] text-ds-faint">—</div>
        ) : entries.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[minmax(100px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted font-mono text-[9px] last:border-b-0">
            <div className="break-all bg-ds-surface-subtle px-2.5 py-2 text-ds-muted">{name}</div>
            <div className="min-w-0 break-all px-2.5 py-2">{value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function BodyViewer({
  body,
  title
}: {
  body: ModelRequestTraceBody
  title: string
}): ReactElement {
  const { t } = useTranslation('common')
  const pretty = useMemo(() => prettyJson(body.text), [body.text])
  const [mode, setMode] = useState<BodyMode>(pretty !== null ? 'pretty' : 'raw')
  const value = mode === 'pretty' && pretty !== null ? pretty : body.text
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1">
        <h3 className="mr-auto text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
        {pretty !== null ? (
          <div className="flex rounded-md bg-ds-surface-subtle p-0.5 text-[8px]">
            {(['pretty', 'raw'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded px-1.5 py-0.5 ${mode === item ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted'}`}
              >
                {t(item === 'pretty' ? 'agentPerspectivePretty' : 'agentPerspectiveRaw')}
              </button>
            ))}
          </div>
        ) : null}
        <CopyButton value={value} />
      </div>
      <textarea
        readOnly
        value={value}
        spellCheck={false}
        aria-label={title}
        className="h-72 w-full resize-y rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[9px] leading-4 text-ds-ink outline-none"
      />
      <div className="mt-1 flex items-center justify-between text-[8px] text-ds-faint">
        <span>{body.capturedBytes.toLocaleString()} / {body.originalBytes.toLocaleString()} B</span>
        {body.truncated ? <span>{t('agentPerspectiveTruncated')}</span> : null}
      </div>
    </section>
  )
}

export function JsonCard({ title, value }: { title: string; value: unknown }): ReactElement {
  const text = JSON.stringify(value, null, 2)
  return (
    <section>
      <SectionHeading title={title} copyValue={text} />
      <ScrollablePre
        ariaLabel={title}
        className="max-h-96 whitespace-pre-wrap break-words rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[9px] leading-4"
      >
        {text}
      </ScrollablePre>
    </section>
  )
}

export function TextCard({ title, value }: { title: string; value: string }): ReactElement {
  return (
    <section>
      <SectionHeading title={title} copyValue={value} />
      <ScrollablePre
        ariaLabel={title}
        className="max-h-96 whitespace-pre-wrap break-words rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-sans text-[10px] leading-4"
      >
        {value}
      </ScrollablePre>
    </section>
  )
}

export function SectionHeading({ title, copyValue }: { title: string; copyValue?: string }): ReactElement {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <h3 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
      {copyValue ? <CopyButton value={copyValue} /> : null}
    </div>
  )
}

export function DetailBlock({
  title,
  value,
  copyValue,
  mono = false
}: {
  title: string
  value: string
  copyValue?: string
  mono?: boolean
}): ReactElement {
  return (
    <section>
      <SectionHeading title={title} copyValue={copyValue} />
      <div className={`break-all rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 py-2 text-[9px] ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </section>
  )
}

export function CopyButton({ value }: { value: string }): ReactElement {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }
  const Icon = copied ? Check : Clipboard
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded p-1 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
      aria-label={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
      data-tooltip={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

export function Notice({ text, warning = false }: { text: string; warning?: boolean }): ReactElement {
  return (
    <div className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[9px] leading-4 ${warning ? 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300' : 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted'}`}>
      {warning ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> : null}
      <span>{text}</span>
    </div>
  )
}

export function RedactionNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveRedacted')} />
}

export function TruncationNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveTruncationNotice')} warning />
}
