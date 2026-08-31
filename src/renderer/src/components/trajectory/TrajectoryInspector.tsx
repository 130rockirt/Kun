import { Check, Clipboard, X } from 'lucide-react'
import { diffLines } from 'diff'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { kunAttachmentContentPath } from '@shared/kun-endpoints'
import { fetchTrajectoryDetail, type TrajectoryDetail, type TrajectoryDetailSection } from '../../agent/trajectory'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { StreamdownAssistant } from '../chat/StreamdownAssistant'
import type { HarnessCell, HarnessRequestBoundary } from './trajectory-harness-model'
import styles from './TrajectoryInspector.module.css'

type Tab = { id: TrajectoryDetailSection; label: string }

export function TrajectoryInspector({
  threadId,
  cell,
  request,
  parentRequest,
  width,
  onWidthChange,
  onClose,
  onSelectParentRequest,
  loadDetail = fetchTrajectoryDetail
}: {
  threadId: string
  cell: HarnessCell | null
  request: HarnessRequestBoundary | null
  parentRequest: HarnessRequestBoundary | null
  width: number | null
  onWidthChange: (width: number | null) => void
  onClose: () => void
  onSelectParentRequest: (requestId: string) => void
  loadDetail?: typeof fetchTrajectoryDetail
}): ReactElement | null {
  const { t } = useTranslation('common')
  const targetId = request ? `request:${request.request.requestId}` : cell?.record.id
  const tabs = useMemo(() => tabsFor(cell, request, t), [cell, request, t])
  const [active, setActive] = useState<TrajectoryDetailSection>('overview')
  const [cache, setCache] = useState<Map<string, TrajectoryDetail>>(new Map())
  const [loading, setLoading] = useState(false)
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number; splitWidth: number } | null>(null)
  useEffect(() => { setActive(tabs[0]?.id ?? 'overview') }, [tabs, targetId])
  useEffect(() => {
    if (!targetId) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, targetId])
  const key = targetId ? `${targetId}:${active}` : ''
  const detail = cache.get(key)
  useEffect(() => {
    if (!targetId || detail) return
    let cancelled = false
    setLoading(true)
    void loadDetail(threadId, targetId, active)
      .then((value) => { if (!cancelled) setCache((current) => new Map(current).set(key, value)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, detail, key, loadDetail, targetId, threadId])
  if (!targetId) return null

  const title = request
    ? `Request #${request.number}`
    : cell?.kind.toUpperCase() ?? 'Event'
  const location = request
    ? `Turn ${request.request.turnId} · Step ${request.request.step}`
    : cell ? `Turn ${cell.turn} · Step ${cell.step}` : ''

  return (
    <aside className={styles.details} style={width === null ? undefined : { width }} aria-label={t('trajectoryDetails')}>
      <div
        className={styles.resizeHandle}
        role="separator"
        tabIndex={0}
        aria-label={t('trajectoryResizeDetails')}
        onDoubleClick={() => onWidthChange(null)}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const split = event.currentTarget.parentElement?.parentElement
          if (!split) return
          resize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: event.currentTarget.parentElement!.getBoundingClientRect().width, splitWidth: split.getBoundingClientRect().width }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = resize.current
          if (!drag || drag.pointerId !== event.pointerId) return
          onWidthChange(clampWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth))
        }}
        onPointerUp={(event) => { if (resize.current?.pointerId === event.pointerId) { resize.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          const splitWidth = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 720
          const current = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 380
          onWidthChange(clampWidth(current + (event.key === 'ArrowLeft' ? 16 : -16), splitWidth))
          event.preventDefault()
        }}
      />
      <div className={styles.header}><div className={styles.title}><span className={styles.dot} /><strong>{title}</strong><span className={styles.location}>{location}</span>{parentRequest ? <button type="button" className={styles.parent} onClick={() => onSelectParentRequest(parentRequest.request.requestId)}>Request #{parentRequest.number}</button> : null}</div><button type="button" className={styles.close} onClick={onClose} aria-label={t('trajectoryBack')}><X /></button></div>
      <div className={styles.tabs} role="tablist">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={active === tab.id} className={active === tab.id ? `${styles.tab} ${styles.tabActive}` : styles.tab} onClick={() => setActive(tab.id)}>{tab.label}</button>)}</div>
      <div className={styles.body} role="tabpanel">
        {loading && !detail ? <div className={styles.empty}>{t('trajectoryLoading')}</div> : detail ? <DetailContent detail={detail} threadId={threadId} attachmentIds={cell?.attachmentIds ?? []} /> : null}
      </div>
    </aside>
  )
}

function DetailContent({ detail, threadId, attachmentIds }: { detail: TrajectoryDetail; threadId: string; attachmentIds: readonly string[] }): ReactElement {
  const { t } = useTranslation('common')
  if (detail.state === 'not_captured') return <div className={styles.empty}>{t('trajectoryDetailNotCaptured')}</div>
  if (detail.state === 'evicted') return <div className={styles.empty}>{t('trajectoryDetailEvicted')}</div>
  if (detail.section === 'diff' && isRecord(detail.content)) return <PromptDiff content={detail.content} />
  const markdown = markdownText(detail.content)
  return (
    <div className={styles.payload}>
      {detail.section === 'rendered' && markdown !== null
        ? <StreamdownAssistant text={markdown} streaming={false} className={styles.markdown} />
        : <JsonTree value={detail.content} />}
      {attachmentIds.length ? <TrajectoryImages threadId={threadId} ids={attachmentIds} /> : null}
    </div>
  )
}

function JsonTree({ value, name = '$', path = '$' }: { value: unknown; name?: string; path?: string }): ReactElement {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState<'value' | 'path' | 'json' | null>(null)
  const copy = (kind: 'value' | 'path' | 'json', text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind)
      setTimeout(() => setCopied(null), 900)
    }).catch(() => undefined)
  }
  if (value === null || typeof value !== 'object') return <div className={styles.leaf}><span>{name}</span><code>{JSON.stringify(value)}</code><span className={styles.copyActions}><button type="button" onClick={() => copy('value', String(value))} aria-label={t('trajectoryCopyValue')}>{copied === 'value' ? <Check /> : <Clipboard />}</button><button type="button" onClick={() => copy('path', path)} aria-label={t('trajectoryCopyPath')}>$</button></span></div>
  const entries = Array.isArray(value) ? value.map((entry, index) => [String(index), entry] as const) : Object.entries(value)
  return <details className={styles.tree} open><summary><span>{name}</span><span className={styles.copyActions}><button type="button" onClick={(event) => { event.preventDefault(); copy('path', path) }} aria-label={t('trajectoryCopyPath')}>$</button><button type="button" onClick={(event) => { event.preventDefault(); copy('json', JSON.stringify(value, null, 2)) }} aria-label={t('trajectoryCopyJson')}>{copied === 'json' ? <Check /> : <Clipboard />}</button></span></summary><div>{entries.map(([key, entry]) => <JsonTree key={key} name={key} path={Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`} value={entry} />)}</div></details>
}

function PromptDiff({ content }: { content: Record<string, unknown> }): ReactElement {
  const previous = JSON.stringify(content.previous ?? [], null, 2)
  const current = JSON.stringify(content.current ?? [], null, 2)
  return <pre className={styles.diff}>{diffLines(previous, current).map((part, index) => <span key={index} data-change={part.added ? 'added' : part.removed ? 'removed' : 'context'}>{part.value}</span>)}</pre>
}

function TrajectoryImages({ threadId, ids }: { threadId: string; ids: readonly string[] }): ReactElement {
  const [images, setImages] = useState<Array<{ id: string; url: string; name: string }>>([])
  useEffect(() => {
    let cancelled = false
    void Promise.all(ids.map(async (id) => {
      const response = await rendererRuntimeClient.runtimeRequest(`${kunAttachmentContentPath(id)}?thread_id=${encodeURIComponent(threadId)}`, 'GET')
      if (!response.ok) return null
      const body = JSON.parse(response.body) as { dataBase64?: string; attachment?: { mimeType?: string; name?: string } }
      return body.dataBase64 ? { id, url: `data:${body.attachment?.mimeType ?? 'application/octet-stream'};base64,${body.dataBase64}`, name: body.attachment?.name ?? id } : null
    })).then((values) => { if (!cancelled) setImages(values.filter((value): value is NonNullable<typeof value> => value !== null)) })
    return () => { cancelled = true }
  }, [ids, threadId])
  return <div className={styles.images}>{images.map((image) => <img key={image.id} src={image.url} alt={image.name} />)}</div>
}

function tabsFor(cell: HarnessCell | null, request: HarnessRequestBoundary | null, t: (key: string) => string): Tab[] {
  if (request) return [{ id: 'overview', label: t('trajectoryTabSummary') }, ...(request.request.optionsAvailable ? [{ id: 'options' as const, label: t('trajectoryTabOptions') }] : []), { id: 'usage', label: t('trajectorySection_usage') }, { id: 'timing', label: t('trajectorySection_timing') }]
  if (!cell) return []
  if (cell.kind === 'system') return [...(cell.record.kind === 'system' && cell.record.previousPromptFingerprint ? [{ id: 'diff' as const, label: t('trajectoryTabDiff') }] : []), { id: 'system-prompt', label: t('trajectoryTabSystemPrompt') }, { id: 'tools', label: t('trajectoryTabTools') }]
  if (cell.kind === 'tool' || cell.kind === 'subtool') return [{ id: 'overview', label: t('trajectoryTabSummary') }, { id: 'arguments', label: t('trajectoryTabPayload') }, { id: 'result', label: t('trajectorySection_result') }, { id: 'schema', label: t('trajectoryTabSchema') }, { id: 'timing', label: t('trajectorySection_timing') }]
  if (cell.kind === 'compacted') return [{ id: 'overview', label: t('trajectoryTabSummary') }, { id: 'raw', label: t('trajectorySection_raw') }]
  return [{ id: 'overview', label: t('trajectoryTabSummary') }, { id: 'rendered', label: t('trajectoryTabPreview') }, { id: 'raw', label: t('trajectorySection_raw') }, { id: 'source', label: t('trajectoryTabSource') }]
}

function markdownText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((entry) => isRecord(entry) && typeof entry.text === 'string' ? entry.text : '').filter(Boolean).join('\n') || null
  return null
}
function clampWidth(width: number, splitWidth: number): number { return Math.round(Math.min(720, Math.max(320, Math.min(width, splitWidth - 280)))) }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
