import { ArrowLeft, Check, Clipboard, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  fetchTrajectoryDetail,
  type TrajectoryDetail,
  type TrajectoryDetailSection,
  type TrajectoryRecord
} from '../../agent/trajectory'

export function TrajectoryInspector({
  threadId,
  record,
  displayMode,
  width,
  onClose
}: {
  threadId: string
  record: TrajectoryRecord | null
  displayMode: 'docked' | 'overlay' | 'full'
  width: number
  onClose: () => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const sections = useMemo(() => record ? sectionsFor(record) : [], [record])
  const [section, setSection] = useState<TrajectoryDetailSection>('overview')
  const [detail, setDetail] = useState<TrajectoryDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSection('overview')
    setDetail(null)
    setError('')
  }, [record?.id])

  useEffect(() => {
    if (!record) return
    let cancelled = false
    setLoading(true)
    setError('')
    void fetchTrajectoryDetail(threadId, record.id, section)
      .then((value) => { if (!cancelled) setDetail(value) })
      .catch((loadError) => { if (!cancelled) setError(message(loadError)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [record, section, threadId])

  if (!record) return null
  const copyId = async (): Promise<void> => {
    await navigator.clipboard.writeText(record.kind === 'llm_request' ? record.requestId : record.id)
    setCopied(true)
    globalThis.setTimeout(() => setCopied(false), 1_200)
  }
  return (
    <aside
      className={`${displayMode === 'docked' ? 'relative shrink-0' : 'absolute inset-y-0 right-0 z-30 shadow-2xl'} flex min-h-0 flex-col border-l border-ds-border bg-ds-main ${displayMode === 'full' ? 'left-0 w-full' : ''}`}
      style={displayMode === 'full' ? undefined : { width }}
      data-testid="trajectory-inspector"
    >
      <div className="border-b border-ds-border-muted px-3 py-2.5">
        <div className="flex items-start gap-2">
          {displayMode !== 'docked' ? (
            <button type="button" className="rounded p-1 text-ds-faint hover:bg-ds-hover" onClick={onClose} aria-label={t('trajectoryBack')}>
              {displayMode === 'full' ? <ArrowLeft className="h-4 w-4" /> : <X className="h-4 w-4" />}
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-ds-ink">{recordTitle(record)}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ds-faint">
              <span>{record.status}</span>
              <span>Turn {shortId(record.turnId)}</span>
              <span>Step {record.step + 1}</span>
            </div>
          </div>
          <button type="button" className="rounded p-1 text-ds-faint hover:bg-ds-hover" onClick={() => void copyId()} aria-label={t('trajectoryCopyId')}>
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Clipboard className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="flex shrink-0 overflow-x-auto border-b border-ds-border-muted px-2" role="tablist">
        {sections.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={section === item}
            className={`shrink-0 border-b-2 px-2 py-2 text-[10.5px] ${section === item ? 'border-violet-500 text-violet-600 dark:text-violet-300' : 'border-transparent text-ds-faint hover:text-ds-ink'}`}
            onClick={() => setSection(item)}
          >
            {t(`trajectorySection_${item}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-ds-faint"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : error ? (
          <InspectorNotice tone="error" text={error} />
        ) : detail?.state === 'not_captured' ? (
          <InspectorNotice text={t('trajectoryDetailNotCaptured')} />
        ) : detail?.state === 'evicted' ? (
          <InspectorNotice text={t('trajectoryDetailEvicted')} />
        ) : detail ? (
          <DetailContent detail={detail} />
        ) : null}
      </div>
    </aside>
  )
}

function DetailContent({ detail }: { detail: TrajectoryDetail }): ReactElement {
  const { t } = useTranslation('common')
  const content = detail.content
  if (content === null || content === undefined) return <InspectorNotice text={t('trajectoryDetailUnavailable')} />
  if (isRecord(content) && !Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {detail.truncated ? <InspectorNotice text={t('trajectoryDetailTruncated')} /> : null}
        <DefinitionOrJson value={content} />
      </div>
    )
  }
  return <JsonBlock value={content} />
}

function DefinitionOrJson({ value }: { value: Record<string, unknown> }): ReactElement {
  const simple = Object.entries(value).every(([, entry]) =>
    entry === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof entry))
  if (!simple) return <JsonBlock value={value} />
  return (
    <dl className="space-y-2">
      {Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => (
        <div key={key} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 border-b border-ds-border-muted pb-1.5 text-[11px]">
          <dt className="text-ds-faint">{key}</dt>
          <dd className="break-words text-ds-ink">{String(entry)}</dd>
        </div>
      ))}
    </dl>
  )
}

function JsonBlock({ value }: { value: unknown }): ReactElement {
  const text = safeJson(value)
  return (
    <pre className="max-h-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-ds-border-muted bg-ds-card p-2.5 font-mono text-[10.5px] leading-5 text-ds-muted">
      {text}
    </pre>
  )
}

function InspectorNotice({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'error' }): ReactElement {
  return (
    <div className={`rounded-md border px-3 py-3 text-[11px] ${tone === 'error' ? 'border-red-500/30 bg-red-500/5 text-red-600' : 'border-ds-border-muted bg-ds-card text-ds-faint'}`}>
      {text}
    </div>
  )
}

function sectionsFor(record: TrajectoryRecord): TrajectoryDetailSection[] {
  if (record.kind === 'llm_request') return ['overview', 'input', 'output', 'usage', 'timing', 'raw']
  if (record.kind === 'tool') return ['overview', 'arguments', 'result', 'timing', 'raw']
  return ['overview', 'output', 'timing', 'raw']
}

function recordTitle(record: TrajectoryRecord): string {
  if (record.kind === 'llm_request') return `${record.model} · Request #${record.step + 1}`
  if (record.kind === 'tool') return record.toolName
  if (record.kind === 'input') return 'User input'
  if (record.kind === 'compaction') return 'Compaction'
  return 'Assistant output'
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
