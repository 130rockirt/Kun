import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrajectoryRecord } from '../../agent/trajectory'

export function TrajectoryTimeline({
  records,
  selectedId,
  mode,
  onSelect
}: {
  records: readonly TrajectoryRecord[]
  selectedId: string | null
  mode: 'actual' | 'equal'
  onSelect: (id: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const blocks = useMemo(() => timelineBlocks(records, mode), [mode, records])
  return (
    <div className="border-b border-ds-border-muted px-3 py-2" data-testid="trajectory-timeline">
      <div className="min-w-[520px] space-y-1 overflow-x-auto">
        {(['input', 'model', 'tool'] as const).map((lane) => (
          <div key={lane} className="flex h-6 items-center gap-2">
            <div className="w-12 shrink-0 text-[10px] font-medium text-ds-faint">
              {t(`trajectoryLane${lane[0].toUpperCase()}${lane.slice(1)}`)}
            </div>
            <div className="relative h-4 min-w-[440px] flex-1 rounded bg-ds-hover/50">
              {blocks.filter((block) => block.lane === lane).map((block) => (
                <button
                  key={block.record.id}
                  type="button"
                  className={`absolute top-0 h-4 min-w-[3px] rounded-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    block.record.id === selectedId ? 'ring-2 ring-accent ring-offset-1' : ''
                  } ${timelineColor(block.record)}`}
                  style={{ left: `${block.left}%`, width: `${block.width}%` }}
                  onClick={() => onSelect(block.record.id)}
                  aria-label={`${recordLabel(block.record)} · ${formatDuration(block.record.durationMs)}`}
                  title={`${recordLabel(block.record)}\n${formatTimestamp(block.record.startedAt)}\n${formatDuration(block.record.durationMs)}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type TimelineBlock = {
  lane: 'input' | 'model' | 'tool'
  record: TrajectoryRecord
  left: number
  width: number
}

function timelineBlocks(records: readonly TrajectoryRecord[], mode: 'actual' | 'equal'): TimelineBlock[] {
  if (!records.length) return []
  const start = Math.min(...records.map((record) => Date.parse(record.startedAt) || 0))
  const end = Math.max(...records.map((record) =>
    Date.parse(record.completedAt ?? record.startedAt) || start))
  const span = Math.max(1, end - start)
  return records.map((record, index) => {
    const started = Date.parse(record.startedAt) || start
    const duration = Math.max(1, record.durationMs ?? (record.status === 'running' ? Date.now() - started : 1))
    const left = mode === 'actual' ? ((started - start) / span) * 100 : (index / records.length) * 100
    const width = mode === 'actual'
      ? Math.max(0.7, Math.min(100 - left, (duration / span) * 100))
      : Math.max(1.5, 85 / records.length)
    return { lane: laneFor(record), record, left, width }
  })
}

function laneFor(record: TrajectoryRecord): TimelineBlock['lane'] {
  if (record.kind === 'input' || record.kind === 'compaction') return 'input'
  if (record.kind === 'tool') return 'tool'
  return 'model'
}

function timelineColor(record: TrajectoryRecord): string {
  if (record.status === 'failed') return 'bg-red-500'
  if (record.status === 'cancelled' || record.status === 'interrupted') return 'bg-ds-faint/70'
  if (record.status === 'running') return 'animate-pulse bg-violet-500'
  if (record.kind === 'tool') return 'bg-slate-500 dark:bg-slate-400'
  if (record.kind === 'input' || record.kind === 'compaction') return 'bg-ds-faint'
  return 'bg-violet-500/85'
}

function recordLabel(record: TrajectoryRecord): string {
  if (record.kind === 'llm_request') return `${record.model} · ${record.provider}`
  if (record.kind === 'tool') return record.toolName
  return record.preview
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour12: false })
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1_000) return `${Math.round(value)}ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
}
