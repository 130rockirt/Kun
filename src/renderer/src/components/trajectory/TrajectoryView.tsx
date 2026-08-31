import { Activity, ChevronsUp, Clock3, MoreHorizontal, RefreshCw, Search } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import { kunThreadPath } from '@shared/kun-endpoints'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import {
  trajectoryUiState,
  useTrajectoryUiStore
} from '../../store/trajectory-ui-store'
import type { TrajectoryFilter, TrajectoryRecord } from '../../agent/trajectory'
import type { TrajectoryData } from './useTrajectoryData'
import { TrajectoryTimeline, formatDuration } from './TrajectoryTimeline'
import { TrajectoryLedger } from './TrajectoryLedger'
import { TrajectoryInspector } from './TrajectoryInspector'

const FILTERS: TrajectoryFilter[] = ['all', 'llm', 'tool', 'error']

export function TrajectoryView({
  threadId,
  data
}: {
  threadId: string
  data: TrajectoryData
}): ReactElement {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const byThread = useTrajectoryUiStore((state) => state.byThread)
  const update = useTrajectoryUiStore((state) => state.update)
  const ui = trajectoryUiState(byThread, threadId)
  const [centerWidth, setCenterWidth] = useState(1_200)
  const [moreOpen, setMoreOpen] = useState(false)
  const [captureEnabled, setCaptureEnabled] = useState(false)
  const [captureBusy, setCaptureBusy] = useState(false)
  const selected = data.records.find((record) => record.id === ui.selectedRecordId) ?? null
  const turnIds = useMemo(() => [...new Set(data.records.map((record) => record.turnId))], [data.records])
  const displayMode = centerWidth >= 1_080 ? 'docked' : centerWidth >= 760 ? 'overlay' : 'full'

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCenterWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (ui.selectedRecordId || !data.records.length) return
    update(threadId, { selectedRecordId: data.records.at(-1)?.id ?? null })
  }, [data.records, threadId, ui.selectedRecordId, update])

  useEffect(() => {
    let cancelled = false
    void rendererRuntimeClient.runtimeRequest(kunThreadPath(threadId), 'GET')
      .then((response) => {
        if (cancelled || !response.ok) return
        const thread = JSON.parse(response.body) as { modelRequestCaptureEnabled?: boolean }
        setCaptureEnabled(thread.modelRequestCaptureEnabled === true)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [threadId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !ui.selectedRecordId) return
      update(threadId, { selectedRecordId: null })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [threadId, ui.selectedRecordId, update])

  const toggleCapture = async (): Promise<void> => {
    if (captureBusy) return
    const next = !captureEnabled
    setCaptureBusy(true)
    try {
      const response = await rendererRuntimeClient.runtimeRequest(
        kunThreadPath(threadId),
        'PATCH',
        JSON.stringify({ modelRequestCaptureEnabled: next })
      )
      if (!response.ok) throw new Error('failed to update capture policy')
      setCaptureEnabled(next)
      setMoreOpen(false)
    } finally {
      setCaptureBusy(false)
    }
  }

  const toggleTurn = (turnId: string): void => {
    const collapsed = new Set(ui.collapsedTurnIds)
    if (collapsed.has(turnId)) collapsed.delete(turnId)
    else collapsed.add(turnId)
    update(threadId, { collapsedTurnIds: [...collapsed] })
  }

  const toggleAllTurns = (): void => {
    update(threadId, {
      collapsedTurnIds: ui.collapsedTurnIds.length === turnIds.length ? [] : turnIds
    })
  }

  const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = ui.inspectorWidth
    const move = (next: PointerEvent): void => {
      update(threadId, { inspectorWidth: Math.min(640, Math.max(320, startWidth + startX - next.clientX)) })
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-ds-main" data-testid="trajectory-view">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted px-3 py-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-violet-500" />
          <span className="text-[13px] font-semibold text-ds-ink">{t('trajectoryTitle')}</span>
          <span className="text-[10.5px] text-ds-faint">{t('trajectoryRequestCount', { count: data.summary.requestCount })}</span>
          {data.summary.runningCount ? <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" /> : null}
          {data.summary.failedCount ? <span className="text-[10px] text-red-500">{t('trajectoryFailureCount', { count: data.summary.failedCount })}</span> : null}
        </div>
        <div className="flex rounded-md bg-ds-hover p-0.5">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={`rounded px-2 py-1 text-[10.5px] ${ui.filter === filter ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-faint hover:text-ds-ink'}`}
              onClick={() => update(threadId, { filter })}
            >
              {t(`trajectoryFilter_${filter}`)}
            </button>
          ))}
        </div>
        <div className="relative ml-auto min-w-[150px] max-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-faint" />
          <input
            value={ui.query}
            onChange={(event) => update(threadId, { query: event.target.value })}
            className="h-7 w-full rounded-md border border-ds-border bg-ds-card pl-7 pr-2 text-[11px] text-ds-ink outline-none focus:border-violet-500"
            placeholder={t('trajectorySearchPlaceholder')}
            aria-label={t('trajectorySearchPlaceholder')}
          />
        </div>
        <button type="button" className="rounded p-1.5 text-ds-faint hover:bg-ds-hover hover:text-ds-ink" onClick={toggleAllTurns} title={t('trajectoryCollapseAll')}>
          <ChevronsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={`rounded p-1.5 ${ui.timelineMode === 'actual' ? 'text-violet-500' : 'text-ds-faint'} hover:bg-ds-hover`}
          onClick={() => update(threadId, { timelineMode: ui.timelineMode === 'actual' ? 'equal' : 'actual' })}
          title={t('trajectoryTimelineMode')}
        >
          <Clock3 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1.5 text-ds-faint hover:bg-ds-hover" onClick={data.refresh} title={t('trajectoryRefresh')}>
          <RefreshCw className={`h-3.5 w-3.5 ${data.loading ? 'animate-spin' : ''}`} />
        </button>
        <div className="relative">
          <button type="button" className="rounded p-1.5 text-ds-faint hover:bg-ds-hover" onClick={() => setMoreOpen((open) => !open)} aria-label={t('trajectoryMore')}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {moreOpen ? (
            <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-ds-border bg-ds-card p-2 shadow-lg">
              <button type="button" className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-[11px] hover:bg-ds-hover" disabled={captureBusy} onClick={() => void toggleCapture()}>
                <span>{t('trajectoryCaptureFullContent')}</span>
                <span className={`h-4 w-7 rounded-full p-0.5 ${captureEnabled ? 'bg-violet-500' : 'bg-ds-border-strong'}`}>
                  <span className={`block h-3 w-3 rounded-full bg-white transition ${captureEnabled ? 'translate-x-3' : ''}`} />
                </span>
              </button>
              <p className="px-2 pt-1 text-[9.5px] leading-4 text-ds-faint">{t('trajectoryCaptureHint')}</p>
            </div>
          ) : null}
        </div>
      </div>
      <SummaryStrip data={data} />
      <TrajectoryTimeline records={data.records} selectedId={ui.selectedRecordId} mode={ui.timelineMode} onSelect={(id) => update(threadId, { selectedRecordId: id })} />
      {data.historyIncomplete || data.warnings.length ? (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-1 text-[9.5px] text-amber-700 dark:text-amber-300">
          {data.historyIncomplete ? t('trajectoryHistoryIncomplete') : data.warnings[0]}
        </div>
      ) : null}
      {data.error ? (
        <EmptyState title={t('trajectoryLoadError')} detail={data.error} action={data.refresh} />
      ) : data.loading && !data.records.length ? (
        <TrajectorySkeleton />
      ) : !data.records.length ? (
        <EmptyState title={t('trajectoryEmpty')} detail={t('trajectoryEmptyHint')} />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <TrajectoryLedger
            records={data.records}
            selectedId={ui.selectedRecordId}
            collapsedTurnIds={ui.collapsedTurnIds}
            initialScrollOffset={ui.scrollOffset}
            hasOlder={Boolean(data.nextCursor)}
            loadingOlder={data.loadingOlder}
            onSelect={(id) => update(threadId, { selectedRecordId: id })}
            onToggleTurn={toggleTurn}
            onScrollOffset={(scrollOffset) => update(threadId, { scrollOffset })}
            onLoadOlder={data.loadOlder}
          />
          {selected && displayMode === 'docked' ? <div className="w-1 cursor-col-resize hover:bg-violet-500/30" onPointerDown={beginInspectorResize} /> : null}
          <TrajectoryInspector threadId={threadId} record={selected} displayMode={displayMode} width={ui.inspectorWidth} onClose={() => update(threadId, { selectedRecordId: null })} />
        </div>
      )}
    </div>
  )
}

function SummaryStrip({ data }: { data: TrajectoryData }): ReactElement {
  const { t } = useTranslation('common')
  const values = [
    [t('trajectoryMetricCalls'), String(data.summary.requestCount)],
    [t('trajectoryMetricInput'), compact(data.summary.inputTokens)],
    [t('trajectoryMetricOutput'), compact(data.summary.outputTokens)],
    [t('trajectoryMetricCache'), data.summary.cacheHitRate === null ? '—' : `${Math.round(data.summary.cacheHitRate * 100)}%`],
    ['TTFT', data.summary.avgTtftMs === null ? '—' : formatDuration(data.summary.avgTtftMs)],
    [t('trajectoryMetricSpeed'), data.summary.avgTokensPerSecond === null ? '—' : `${data.summary.avgTokensPerSecond.toFixed(1)} tok/s`],
    [t('trajectoryMetricValue'), data.summary.valueEstimateCny ? `¥${data.summary.valueEstimateCny.toFixed(2)}` : '—']
  ]
  return (
    <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-ds-border-muted px-3">
      {values.map(([label, value], index) => (
        <div key={label} className={`flex shrink-0 items-center gap-1.5 px-2 text-[10px] ${index ? 'border-l border-ds-border-muted' : ''}`}>
          <span className="text-ds-faint">{label}</span><span className="font-medium text-ds-ink">{value}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: () => void }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <Activity className="h-8 w-8 text-ds-border-strong" />
      <h3 className="mt-3 text-[13px] font-medium text-ds-ink">{title}</h3>
      <p className="mt-1 max-w-md text-[11px] leading-5 text-ds-faint">{detail}</p>
      {action ? <button type="button" className="mt-3 rounded bg-accent px-3 py-1.5 text-[11px] text-white" onClick={action}>{t('trajectoryRetry')}</button> : null}
    </div>
  )
}

function TrajectorySkeleton(): ReactElement {
  return <div className="flex min-h-0 flex-1 animate-pulse gap-3 p-3"><div className="flex-1 space-y-2">{[1, 2, 3, 4, 5].map((id) => <div key={id} className="h-14 rounded bg-ds-hover" />)}</div><div className="hidden w-[38%] rounded bg-ds-hover lg:block" /></div>
}

function compact(value: number): string {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
