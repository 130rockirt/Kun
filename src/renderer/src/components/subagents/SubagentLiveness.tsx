import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Check, Square, TriangleAlert } from 'lucide-react'
import { AgentKun } from './AgentKun'

export type SubagentLivenessStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'awaiting-permission'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function isTerminalSubagentStatus(status: SubagentLivenessStatus): boolean {
  return status === 'done' || status === 'stopped' || status === 'failed'
}

export function useSubagentReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

export function formatSubagentElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function useSubagentElapsed(
  status: SubagentLivenessStatus,
  startedAt: string | undefined,
  durationMs: number | undefined,
  tickNow?: number
): string {
  const start = useMemo(() => {
    const parsed = startedAt ? Date.parse(startedAt) : NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
  }, [startedAt])
  const [now, setNow] = useState(() => Date.now())
  const active = status === 'running' ||
    status === 'awaiting-permission' ||
    status === 'queued'
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [active])
  if (status === 'queued') return '—'
  if (isTerminalSubagentStatus(status) && typeof durationMs === 'number') {
    return formatSubagentElapsed(durationMs)
  }
  return formatSubagentElapsed((tickNow ?? now) - start)
}

const DISC_BG: Record<SubagentLivenessStatus, string> = {
  queued: 'radial-gradient(circle at 50% 36%,#fff 0%,#eef4fb 80%)',
  running: 'radial-gradient(circle at 50% 36%,#fff 0%,#e3eefb 82%)',
  done: 'radial-gradient(circle at 50% 36%,#fff 0%,#e4f5ee 82%)',
  stopped: 'radial-gradient(circle at 50% 36%,#fff 0%,#edf0f4 82%)',
  failed: 'radial-gradient(circle at 50% 36%,#fff 0%,#fbe6e4 82%)',
  'awaiting-permission': 'radial-gradient(circle at 50% 36%,#fff 0%,#fbf0df 82%)'
}

const DISC_RING: Record<SubagentLivenessStatus, string> = {
  queued: 'inset 0 0 0 1px rgba(188,214,245,0.7)',
  running: 'inset 0 0 0 1px var(--ds-accent, #3b82d8)',
  done: 'inset 0 0 0 1px #8fd9bf',
  stopped: 'inset 0 0 0 1px #b7bec8',
  failed: 'inset 0 0 0 1px #efa8a2',
  'awaiting-permission': 'inset 0 0 0 1px #e8c486'
}

function LivenessDot({ status }: { status: SubagentLivenessStatus }): ReactElement {
  const ring = 'absolute -bottom-px -right-px flex h-[13px] w-[13px] items-center justify-center rounded-full border-[2.5px] border-ds-card'
  if (status === 'done') {
    return (
      <span className={`${ring} bg-emerald-500 dark:bg-emerald-400`}>
        <Check className="h-2 w-2 text-white" strokeWidth={3.5} />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className={`${ring} bg-red-500 dark:bg-red-400`}>
        <TriangleAlert className="h-2 w-2 text-white" strokeWidth={3} />
      </span>
    )
  }
  if (status === 'stopped') {
    return (
      <span className={`${ring} bg-slate-500 dark:bg-slate-400`}>
        <Square className="h-1.5 w-1.5 fill-white text-white" strokeWidth={2.5} />
      </span>
    )
  }
  if (status === 'queued') return <span className={`${ring} bg-ds-faint/60`} />
  if (status === 'awaiting-permission') return <span className={`${ring} bg-amber-500`} />
  return <span className={`${ring} ds-subagent-dot-pulse bg-accent`} />
}

export function SubagentLiveAvatar({
  poseId,
  status,
  hue = null,
  compact = false,
  animate = true
}: {
  poseId: string
  status: SubagentLivenessStatus
  hue?: number | null
  compact?: boolean
  animate?: boolean
}): ReactElement {
  const disabled = status === 'queued'
  const frozen = !animate || status === 'failed' || isTerminalSubagentStatus(status)
  const size = compact ? 'h-9 w-9' : 'h-11 w-11'
  const inner = compact ? 'h-[31px] w-[31px]' : 'h-9 w-9'
  const background =
    hue !== null && !isTerminalSubagentStatus(status)
      ? `radial-gradient(circle at 50% 36%,#fff 0%,hsl(${hue} 60% 94%) 82%)`
      : DISC_BG[status]
  return (
    <span
      className={`relative flex ${size} shrink-0 items-center justify-center rounded-full ${
        frozen ? 'ds-subagent-frozen' : ''
      }`}
      style={{ background, boxShadow: DISC_RING[status] }}
    >
      <AgentKun id={poseId} disabled={disabled} className={inner} />
      <LivenessDot status={status} />
    </span>
  )
}

export function SubagentLivenessLane({
  status,
  animate
}: {
  status: SubagentLivenessStatus
  animate: boolean
}): ReactElement | null {
  if (status === 'queued') return null
  const base = 'relative h-[2.5px] w-full overflow-hidden bg-ds-border-muted'
  if (status === 'running') {
    return (
      <div className={base} aria-hidden>
        {animate ? (
          <span className="ds-subagent-lane-sweep absolute top-0 h-full w-2/5 rounded-[2px]" />
        ) : (
          <span className="absolute inset-y-0 left-0 w-1/3 bg-accent/60" />
        )}
      </div>
    )
  }
  if (status === 'done') {
    return (
      <div className={base} aria-hidden>
        <span className="absolute inset-0 bg-emerald-500" />
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className={base} aria-hidden>
        <span className="absolute inset-y-0 left-0 w-[62%] bg-red-500" />
      </div>
    )
  }
  if (status === 'stopped') {
    return (
      <div className={base} aria-hidden>
        <span className="absolute inset-0 bg-slate-400 dark:bg-slate-500" />
      </div>
    )
  }
  return (
    <div className={base} aria-hidden>
      <span
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg,#dd9444 0 6px,transparent 6px 12px)'
        }}
      />
    </div>
  )
}
