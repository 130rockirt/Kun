import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, Circle, Wrench } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TrajectoryRecord } from '../../agent/trajectory'
import { formatDuration } from './TrajectoryTimeline'

type LedgerRow =
  | { kind: 'turn'; id: string; turnId: string; turnIndex: number; records: TrajectoryRecord[] }
  | { kind: 'record'; id: string; record: TrajectoryRecord }

export function TrajectoryLedger({
  records,
  selectedId,
  collapsedTurnIds,
  initialScrollOffset,
  hasOlder,
  loadingOlder,
  onSelect,
  onToggleTurn,
  onScrollOffset,
  onLoadOlder
}: {
  records: readonly TrajectoryRecord[]
  selectedId: string | null
  collapsedTurnIds: readonly string[]
  initialScrollOffset: number
  hasOlder: boolean
  loadingOlder: boolean
  onSelect: (id: string) => void
  onToggleTurn: (turnId: string) => void
  onScrollOffset: (offset: number) => void
  onLoadOlder: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const parentRef = useRef<HTMLDivElement>(null)
  const [newRecordCount, setNewRecordCount] = useState(0)
  const atLiveEdge = useRef(true)
  const previousIds = useRef(new Set(records.map((record) => record.id)))
  const anchor = useRef<{ height: number; top: number; firstId?: string } | null>(null)
  const rows = useMemo(
    () => buildRows(records, new Set(collapsedTurnIds)),
    [collapsedTurnIds, records]
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => rows[index]?.kind === 'turn' ? 44 : 62,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index
  })

  useEffect(() => {
    const element = parentRef.current
    if (!element) return
    element.scrollTop = initialScrollOffset
  }, [initialScrollOffset])

  useEffect(() => {
    if (!selectedId) return
    const index = rows.findIndex((row) => row.kind === 'record' && row.record.id === selectedId)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [rows, selectedId, virtualizer])

  useEffect(() => {
    const currentIds = new Set(records.map((record) => record.id))
    const incoming = records.filter((record) => !previousIds.current.has(record.id)).length
    previousIds.current = currentIds
    if (!incoming) return
    if (anchor.current) {
      requestAnimationFrame(() => {
        const element = parentRef.current
        const saved = anchor.current
        if (element && saved) element.scrollTop = saved.top + (element.scrollHeight - saved.height)
        anchor.current = null
      })
      return
    }
    if (atLiveEdge.current) {
      requestAnimationFrame(() => virtualizer.scrollToIndex(Math.max(0, rows.length - 1), { align: 'end' }))
    } else {
      setNewRecordCount((count) => count + incoming)
    }
  }, [records, rows.length, virtualizer])

  const loadOlder = (): void => {
    const element = parentRef.current
    if (element) anchor.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      firstId: records[0]?.id
    }
    onLoadOlder()
  }

  const onScroll = (): void => {
    const element = parentRef.current
    if (!element) return
    atLiveEdge.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56
    if (atLiveEdge.current) setNewRecordCount(0)
    onScrollOffset(element.scrollTop)
  }

  const jumpToLive = (): void => {
    virtualizer.scrollToIndex(Math.max(0, rows.length - 1), { align: 'end' })
    setNewRecordCount(0)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col border-r border-ds-border-muted">
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll} data-testid="trajectory-ledger">
        {hasOlder ? (
          <div className="sticky top-0 z-10 flex justify-center border-b border-ds-border-muted bg-ds-main/95 py-1.5 backdrop-blur">
            <button type="button" className="rounded px-2 py-1 text-[11px] text-accent hover:bg-accent/10" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? t('trajectoryLoadingOlder') : t('trajectoryLoadOlder')}
            </button>
          </div>
        ) : null}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            if (!row) return null
            return (
              <div
                key={row.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.kind === 'turn' ? (
                  <TurnHeader row={row} collapsed={collapsedTurnIds.includes(row.turnId)} onToggle={onToggleTurn} />
                ) : (
                  <RecordRow record={row.record} selected={row.record.id === selectedId} onSelect={onSelect} />
                )}
              </div>
            )
          })}
        </div>
      </div>
      {newRecordCount > 0 ? (
        <button
          type="button"
          className="absolute bottom-3 right-3 rounded-full bg-accent px-3 py-1.5 text-[11px] font-medium text-white shadow-lg"
          onClick={jumpToLive}
        >
          {t('trajectoryNewRecords', { count: newRecordCount })}
        </button>
      ) : null}
    </div>
  )
}

function buildRows(records: readonly TrajectoryRecord[], collapsed: ReadonlySet<string>): LedgerRow[] {
  const turns = new Map<string, TrajectoryRecord[]>()
  records.forEach((record) => {
    const group = turns.get(record.turnId) ?? []
    group.push(record)
    turns.set(record.turnId, group)
  })
  const rows: LedgerRow[] = []
  let turnIndex = 0
  for (const [turnId, group] of turns) {
    turnIndex += 1
    rows.push({ kind: 'turn', id: `turn:${turnId}`, turnId, turnIndex, records: group })
    if (!collapsed.has(turnId)) group.forEach((record) => rows.push({ kind: 'record', id: record.id, record }))
  }
  return rows
}

function TurnHeader({
  row,
  collapsed,
  onToggle
}: {
  row: Extract<LedgerRow, { kind: 'turn' }>
  collapsed: boolean
  onToggle: (turnId: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const requestCount = row.records.filter((record) => record.kind === 'llm_request').length
  const toolCount = row.records.filter((record) => record.kind === 'tool').length
  const firstInput = row.records.find((record) => record.kind === 'input')?.preview
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b border-ds-border-muted bg-ds-main px-3 py-2 text-left hover:bg-ds-hover/60"
      onClick={() => onToggle(row.turnId)}
      aria-expanded={!collapsed}
    >
      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      <span className="text-[12px] font-semibold text-ds-ink">{t('trajectoryTurn', { index: row.turnIndex })}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-ds-faint">{firstInput}</span>
      <span className="shrink-0 text-[10px] text-ds-faint">
        {t('trajectoryTurnCounts', { requests: requestCount, tools: toolCount })}
      </span>
    </button>
  )
}

function RecordRow({
  record,
  selected,
  onSelect
}: {
  record: TrajectoryRecord
  selected: boolean
  onSelect: (id: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const Icon = record.kind === 'tool' ? Wrench : record.kind === 'llm_request' ? Bot : Circle
  return (
    <button
      type="button"
      className={`relative flex w-full gap-2 border-b border-ds-border-muted px-3 py-2.5 text-left transition ${
        selected ? 'bg-violet-500/10 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-violet-500' : 'hover:bg-ds-hover/60'
      } ${record.kind === 'tool' ? 'pl-8' : ''} ${record.status === 'failed' ? 'bg-red-500/5' : ''}`}
      onClick={() => onSelect(record.id)}
      data-trajectory-record-id={record.id}
    >
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${record.status === 'failed' ? 'text-red-500' : record.kind === 'tool' ? 'text-slate-500' : 'text-violet-500'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium text-ds-ink">{recordTitle(record)}</span>
          {record.kind === 'llm_request' && record.attempt > 1 ? (
            <span className="rounded bg-ds-hover px-1 text-[9px] text-ds-faint">Attempt {record.attempt}</span>
          ) : null}
          <span className="ml-auto shrink-0 text-[10px] text-ds-faint">{formatDuration(record.durationMs)}</span>
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-ds-faint">{record.preview}</div>
        {record.kind === 'llm_request' && record.usage ? (
          <div className="mt-1 text-[9.5px] text-ds-faint">
            Input {compactNumber(record.usage.promptTokens)} · Output {compactNumber(record.usage.completionTokens)}
            {record.usage.requestTtftMs !== undefined ? ` · TTFT ${formatDuration(record.usage.requestTtftMs)}` : ''}
          </div>
        ) : null}
      </div>
      <StatusIcon status={record.status} label={t(`trajectoryStatus_${record.status}`)} />
    </button>
  )
}

function StatusIcon({ status, label }: { status: TrajectoryRecord['status']; label: string }): ReactElement {
  if (status === 'completed') return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label={label} />
  if (status === 'failed') return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" aria-label={label} />
  return <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status === 'running' ? 'animate-pulse bg-violet-500' : 'bg-ds-faint'}`} aria-label={label} />
}

function recordTitle(record: TrajectoryRecord): string {
  if (record.kind === 'llm_request') return `#${record.step + 1} ${record.model}`
  if (record.kind === 'tool') return record.toolName
  if (record.kind === 'input') return 'User input'
  if (record.kind === 'compaction') return 'Compaction'
  return 'Assistant'
}

function compactNumber(value: number): string {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
