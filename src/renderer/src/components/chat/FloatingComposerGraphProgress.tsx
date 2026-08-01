import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import { AlertTriangle, ChevronUp, ExternalLink, GitBranch, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { graphNodeLiveness } from '../../graph/graph-liveness'
import {
  selectGraphPlanningCorrectionDraft,
  useGraphStore
} from '../../graph/graph-store'
import type {
  GraphChildRuntime,
  GraphNodeStatus,
  GraphRun
} from '../../graph/graph-types'
import {
  formatSubagentElapsed,
  SubagentLiveAvatar,
  useSubagentReducedMotion
} from '../subagents/SubagentLiveness'
import {
  fitComposerGraphLabel,
  getComposerGraphProgress,
  layoutComposerGraph,
  selectComposerGraphRun,
  type ComposerGraphLayout,
  type ComposerGraphLayoutNode
} from './composer-graph-preview'
import {
  calculateComposerPopoverPlacement,
  currentComposerBodyZoom,
  type ComposerPopoverPlacement
} from './floating-composer-popover-placement'

const GRAPH_POPOVER_WIDTH = 680
const GRAPH_POPOVER_MAX_HEIGHT = 420
const GRAPH_POPOVER_ESTIMATED_HEIGHT = 390
const NODE_TEXT_LEFT_PADDING = 13
const NODE_TEXT_RIGHT_PADDING = 8
const NODE_TITLE_RIGHT_PADDING = 21
const NODE_STATUS_WIDTH = 44
const NODE_METADATA_GAP = 7
const TERMINAL_GRAPH_RUN_STATUSES = new Set<GraphRun['status']>([
  'completed',
  'failed',
  'cancelled'
])

const nodeTone: Record<GraphNodeStatus, { fill: string; stroke: string; accent: string }> = {
  pending: { fill: 'var(--ds-surface-card)', stroke: 'var(--ds-border)', accent: '#94a3b8' },
  blocked: { fill: 'var(--ds-surface-card)', stroke: '#94a3b8', accent: '#94a3b8' },
  ready: { fill: 'var(--ds-surface-card)', stroke: '#60a5fa', accent: '#60a5fa' },
  queued: { fill: 'var(--ds-surface-card)', stroke: '#38bdf8', accent: '#38bdf8' },
  running: { fill: 'var(--ds-surface-card)', stroke: '#3b82f6', accent: '#3b82f6' },
  submitted: { fill: 'var(--ds-surface-card)', stroke: '#8b5cf6', accent: '#8b5cf6' },
  reviewing: { fill: 'var(--ds-surface-card)', stroke: '#8b5cf6', accent: '#8b5cf6' },
  accepted: { fill: 'var(--ds-surface-card)', stroke: '#10b981', accent: '#10b981' },
  repair_required: { fill: 'var(--ds-surface-card)', stroke: '#f59e0b', accent: '#f59e0b' },
  failed: { fill: 'var(--ds-surface-card)', stroke: '#ef4444', accent: '#ef4444' },
  cancelled: { fill: 'var(--ds-surface-card)', stroke: '#ef4444', accent: '#ef4444' },
  skipped: { fill: 'var(--ds-surface-card)', stroke: '#94a3b8', accent: '#94a3b8' },
  superseded: { fill: 'var(--ds-surface-card)', stroke: '#94a3b8', accent: '#94a3b8' }
}

function useSvgFragmentId(prefix: string): string {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return `${prefix}-${reactId}`
}

function AgentStack({ names }: { names: string[] }): ReactElement {
  const { t } = useTranslation('common')
  if (names.length === 0) {
    return <span className="text-[11px] text-ds-faint">{t('graphComposerNoActiveAgents')}</span>
  }
  return (
    <div
      className="flex items-center"
      aria-label={t('graphComposerActiveAgents', { count: names.length })}
    >
      {names.slice(0, 3).map((name, index) => (
        <span
          key={name}
          title={name}
          className="-ml-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-accent/10 text-[9px] font-bold text-accent first:ml-0 dark:border-ds-card"
          style={{ zIndex: 3 - index }}
        >
          {name.trim().slice(0, 1).toUpperCase() || 'K'}
        </span>
      ))}
      {names.length > 3 ? (
        <span className="ml-1 text-[10px] font-semibold text-ds-faint">+{names.length - 3}</span>
      ) : null}
    </div>
  )
}

function GraphPreviewPhase({
  phase
}: {
  phase: ComposerGraphLayout['phases'][number]
}): ReactElement {
  const clipId = useSvgFragmentId('graph-preview-phase')
  const label = fitComposerGraphLabel(phase.title, phase.width - 20, 10, 8)
  return (
    <g>
      <title>{phase.title}</title>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <rect x={phase.x} y={12} width={phase.width - 20} height={15} />
        </clipPath>
      </defs>
      <text
        x={phase.x}
        y={24}
        fill="var(--ds-text-muted)"
        fontSize={label.fontSize}
        fontWeight={650}
        clipPath={`url(#${clipId})`}
        data-graph-preview-phase-label
        data-label-truncated={label.truncated || undefined}
      >
        {label.text}
      </text>
      <line
        x1={phase.x}
        x2={phase.x + phase.width - 20}
        y1={34}
        y2={34}
        stroke="var(--ds-border)"
        strokeDasharray="3 4"
      />
    </g>
  )
}

function GraphPreviewNode({
  node,
  terminal,
  onInspect,
  onOpen
}: {
  node: ComposerGraphLayoutNode
  terminal: boolean
  onInspect: (node: ComposerGraphLayoutNode) => void
  onOpen: (nodeId: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const tone = nodeTone[node.status]
  const clipId = useSvgFragmentId('graph-preview-node')
  const titleWidth = node.width - NODE_TEXT_LEFT_PADDING - NODE_TITLE_RIGHT_PADDING
  const agentWidth = node.width
    - NODE_TEXT_LEFT_PADDING
    - NODE_TEXT_RIGHT_PADDING
    - NODE_STATUS_WIDTH
    - NODE_METADATA_GAP
  const statusLabel = t(`graphStatus_${node.status}`, { defaultValue: node.status })
  const title = fitComposerGraphLabel(node.title, titleWidth, 11, 8)
  const agent = fitComposerGraphLabel(
    node.attemptNumber
      ? `${node.agentName} · #${node.attemptNumber}`
      : node.agentName,
    agentWidth,
    9,
    7
  )
  const status = fitComposerGraphLabel(statusLabel, NODE_STATUS_WIDTH, 8, 7)
  const statusX = node.x + node.width - NODE_TEXT_RIGHT_PADDING
  const statusClipX = statusX - NODE_STATUS_WIDTH
  const openFromKeyboard = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen(node.id)
  }
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={t('graphComposerNodeAria', {
        title: node.title,
        status: t(`graphStatus_${node.status}`, { defaultValue: node.status }),
        agent: node.agentName
      })}
      className="cursor-pointer outline-none"
      data-graph-preview-node={node.id}
      onClick={() => onOpen(node.id)}
      onKeyDown={openFromKeyboard}
      onPointerEnter={() => onInspect(node)}
      onFocus={() => onInspect(node)}
    >
      <title>{`${node.title} · ${node.agentName} · ${node.status}`}</title>
      <defs>
        <clipPath id={`${clipId}-title`} clipPathUnits="userSpaceOnUse">
          <rect
            x={node.x + NODE_TEXT_LEFT_PADDING}
            y={node.y + 8}
            width={titleWidth}
            height={16}
          />
        </clipPath>
        <clipPath id={`${clipId}-agent`} clipPathUnits="userSpaceOnUse">
          <rect
            x={node.x + NODE_TEXT_LEFT_PADDING}
            y={node.y + 29}
            width={agentWidth}
            height={14}
          />
        </clipPath>
        <clipPath id={`${clipId}-status`} clipPathUnits="userSpaceOnUse">
          <rect
            x={statusClipX}
            y={node.y + 29}
            width={NODE_STATUS_WIDTH}
            height={14}
          />
        </clipPath>
      </defs>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={11}
        fill={tone.fill}
        stroke={tone.stroke}
        strokeWidth={node.processing ? 2 : 1.25}
      />
      {node.processing && !terminal ? (
        <circle
          cx={node.x + node.width - 10}
          cy={node.y + 11}
          r={3}
          className="ds-subagent-dot-pulse fill-accent"
        />
      ) : null}
      <rect
        x={node.x}
        y={node.y}
        width={4}
        height={node.height}
        rx={2}
        fill={tone.accent}
      />
      <text
        x={node.x + NODE_TEXT_LEFT_PADDING}
        y={node.y + 21}
        fill="var(--ds-text)"
        fontSize={title.fontSize}
        fontWeight={650}
        clipPath={`url(#${clipId}-title)`}
        data-graph-preview-node-title
        data-label-truncated={title.truncated || undefined}
      >
        {title.text}
      </text>
      <text
        x={node.x + NODE_TEXT_LEFT_PADDING}
        y={node.y + 39}
        fill="var(--ds-text-muted)"
        fontSize={agent.fontSize}
        clipPath={`url(#${clipId}-agent)`}
        data-graph-preview-node-agent
        data-label-truncated={agent.truncated || undefined}
      >
        {agent.text}
      </text>
      <text
        x={statusX}
        y={node.y + 39}
        fill={tone.accent}
        fontSize={status.fontSize}
        textAnchor="end"
        clipPath={`url(#${clipId}-status)`}
        data-graph-preview-node-status
        data-label-truncated={status.truncated || undefined}
      >
        {status.text}
      </text>
    </g>
  )
}

export function FloatingComposerGraphPreview({
  run,
  childRuns = {},
  now = Date.now(),
  reducedMotion = false,
  onOpenGraph,
  onOpenChild
}: {
  run: GraphRun
  childRuns?: Readonly<Record<string, GraphChildRuntime>>
  now?: number
  reducedMotion?: boolean
  onOpenGraph: (runId: string, nodeId?: string) => void
  onOpenChild?: (
    runId: string,
    nodeId: string,
    attemptId: string,
    childThreadId: string
  ) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const terminal = TERMINAL_GRAPH_RUN_STATUSES.has(run.status)
  const layout = layoutComposerGraph(run, childRuns)
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(
    layout.nodes.find((node) => node.status === 'running')?.id ?? layout.nodes[0]?.id ?? null
  )
  const inspectedNode = layout.nodes.find((node) => node.id === inspectedNodeId)
    ?? layout.nodes.find((node) => node.status === 'running')
    ?? layout.nodes[0]
    ?? null
  const inspectedProjection = inspectedNode ? run.nodes[inspectedNode.id] : undefined
  const inspectedAttempt = inspectedProjection?.attempts.at(-1)
  const inspectedLiveness = inspectedProjection
    ? graphNodeLiveness(inspectedProjection, childRuns, now, run.supervision)
    : null

  return (
    <div className="min-h-0 overflow-auto rounded-2xl border border-ds-border-muted bg-ds-subtle/55">
      <svg
        role="img"
        aria-label={t('graphComposerPreviewSummary', {
          phases: layout.phases.length,
          nodes: layout.nodes.length
        })}
        className="block min-h-[210px] w-full"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        data-graph-composer-preview
      >
        <defs>
          <marker
            id={`graph-composer-arrow-${run.id}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ds-text-faint)" />
          </marker>
          <marker
            id={`graph-composer-active-arrow-${run.id}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ds-accent)" />
          </marker>
        </defs>
        {layout.phases.map((phase) => (
          <GraphPreviewPhase key={phase.id} phase={phase} />
        ))}
        {layout.edges.map((edge) => (
          <g key={edge.id}>
            <path
              d={edge.path}
              fill="none"
              stroke="var(--ds-text-faint)"
              strokeWidth={edge.kind === 'control' ? 1.35 : 1}
              strokeDasharray={edge.kind === 'message' ? '4 4' : undefined}
              markerEnd={`url(#graph-composer-arrow-${run.id})`}
              opacity={0.75}
              data-graph-preview-edge={edge.id}
            />
            {edge.flowing ? (
              <path
                d={edge.path}
                fill="none"
                stroke="var(--ds-accent)"
                strokeWidth={edge.kind === 'control' ? 1.8 : 1.5}
                strokeDasharray={reducedMotion ? undefined : '7 9'}
                markerEnd={`url(#graph-composer-active-arrow-${run.id})`}
                opacity={reducedMotion ? 0.72 : 0.92}
                className={`graph-composer-edge-flow${reducedMotion ? ' is-static' : ''}`}
                aria-hidden
                data-graph-preview-edge-flow={edge.id}
              />
            ) : null}
          </g>
        ))}
        {layout.nodes.map((node) => (
          <GraphPreviewNode
            key={node.id}
            node={node}
            terminal={terminal}
            onInspect={(next) => setInspectedNodeId(next.id)}
            onOpen={(nodeId) => onOpenGraph(run.id, nodeId)}
          />
        ))}
      </svg>
      {inspectedNode ? (
        <div
          className="border-t border-ds-border-muted bg-white/70 px-3 py-2 dark:bg-ds-card/70"
          data-graph-preview-inspector
        >
          <div className="flex items-center gap-2">
            <SubagentLiveAvatar
              poseId={inspectedLiveness?.child?.profile ?? inspectedNode.agentName}
              status={
                terminal
                  ? run.status === 'completed' ? 'done' : 'failed'
                  : inspectedNode.status === 'failed' || inspectedNode.status === 'cancelled'
                  ? 'failed'
                  : inspectedNode.status === 'accepted'
                    ? 'done'
                  : inspectedNode.status === 'blocked'
                      ? 'queued'
                      : inspectedLiveness && [
                          'active_review',
                          'waiting_lead',
                          'retry_scheduled',
                          'needs_attention',
                          'waiting_human',
                          'retrying'
                        ].includes(inspectedLiveness.kind)
                        ? 'awaiting-permission'
                        : 'running'
              }
              compact
              animate={!terminal && inspectedLiveness?.kind === 'working'}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 truncate font-semibold text-ds-ink">
                  {inspectedNode.title}
                </span>
                <span className="shrink-0 text-ds-faint">
                  {t('graphComposerAssignedAgent', { agent: inspectedNode.agentName })}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-ds-muted">
                {terminal
                  ? t(`graphStatus_${run.status}`, { defaultValue: run.status })
                  : inspectedLiveness?.quiet
                  ? t('graphStillWaiting', {
                      seconds: Math.floor((inspectedLiveness.lastActivityAgeMs ?? 0) / 1_000)
                    })
                  : inspectedLiveness?.activityLabel ??
                    t(`graphLiveness_${inspectedLiveness?.kind ?? 'idle'}`)}
                {inspectedLiveness?.activityToolName
                  ? ` · ${inspectedLiveness.activityToolName}`
                  : ''}
                {inspectedLiveness?.elapsedMs
                  ? ` · ${formatSubagentElapsed(inspectedLiveness.elapsedMs)}`
                  : ''}
              </div>
            </div>
            {inspectedNode.childThreadId && inspectedAttempt && onOpenChild ? (
              <button
                type="button"
                className="shrink-0 rounded-lg border border-accent/25 bg-accent/8 px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent/12"
                onClick={() => onOpenChild(
                  run.id,
                  inspectedNode.id,
                  inspectedAttempt.id,
                  inspectedNode.childThreadId!
                )}
              >
                {t('graphViewLiveWork')}
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-ds-muted">
            {inspectedNode.objective}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export function FloatingComposerGraphProgress({
  threadId,
  enabled,
  onOpenGraph,
  onOpenChild
}: {
  threadId: string | null
  enabled: boolean
  onOpenGraph?: (runId: string, nodeId?: string) => void
  onOpenChild?: (
    runId: string,
    nodeId: string,
    attemptId: string,
    childThreadId: string
  ) => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const reducedMotion = useSubagentReducedMotion()
  const runs = useGraphStore((state) => state.runs)
  const drafts = useGraphStore((state) => state.drafts)
  const childRuns = useGraphStore((state) => state.childRuns)
  const selectedRunId = useGraphStore((state) => state.selectedRunId)
  const refreshThread = useGraphStore((state) => state.refreshThread)
  const resumeDraft = useGraphStore((state) => state.resumeDraft)
  const cancelDraft = useGraphStore((state) => state.cancelDraft)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [placement, setPlacement] = useState<ComposerPopoverPlacement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !threadId) return
    void refreshThread(threadId)
  }, [enabled, refreshThread, threadId])

  useEffect(() => {
    setOpen(false)
  }, [enabled, threadId])

  const threadRuns = threadId ? runs.filter((candidate) => candidate.threadId === threadId) : []
  const run = enabled ? selectComposerGraphRun(threadRuns, selectedRunId) : null
  const correctionDraft = enabled
    ? selectGraphPlanningCorrectionDraft(drafts, threadId)
    : null
  const progress = run ? getComposerGraphProgress(run, childRuns) : null
  const currentProjection = run && progress?.currentNodeId
    ? run.nodes[progress.currentNodeId]
    : undefined
  const currentLiveness = currentProjection
    ? graphNodeLiveness(currentProjection, childRuns, now, run?.supervision)
    : null

  useEffect(() => {
    if (!run || !progress?.activeCount || typeof window === 'undefined') return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [progress?.activeCount, run])

  useEffect(() => {
    if (!open || !run || typeof window === 'undefined') {
      setPlacement(null)
      return
    }
    const updatePlacement = (): void => {
      const button = buttonRef.current
      if (!button) return
      setPlacement(calculateComposerPopoverPlacement({
        anchorRect: button.getBoundingClientRect(),
        popoverHeight: popoverRef.current?.offsetHeight ?? GRAPH_POPOVER_ESTIMATED_HEIGHT,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        coordinateScale: currentComposerBodyZoom(),
        preferredWidth: GRAPH_POPOVER_WIDTH,
        maximumHeight: GRAPH_POPOVER_MAX_HEIGHT
      }))
    }
    updatePlacement()
    const frame = window.requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open, run])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => () => {
    if (hoverCloseTimerRef.current != null && typeof window !== 'undefined') {
      window.clearTimeout(hoverCloseTimerRef.current)
    }
  }, [])

  if (!run && correctionDraft) {
    const issue = correctionDraft.draft.issues[0]
    return (
      <div
        data-composer-stack-item="graph"
        data-graph-planning-correction
        className="pointer-events-auto flex min-h-12 w-full max-w-[46rem] shrink-0 items-center gap-3 rounded-2xl border border-amber-400/35 bg-amber-50/95 px-3 py-2 text-left shadow-[0_10px_30px_rgba(120,72,20,0.10)] backdrop-blur-xl dark:bg-amber-950/35"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-ds-ink">
            {t('graphPlanningStatus_needs_correction')}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-ds-muted">
            {issue
              ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`
              : t('graphPlanningCorrectionBody')}
          </span>
        </span>
        <button
          type="button"
          data-graph-planning-cancel
          onClick={() => void cancelDraft(correctionDraft.draft.id)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[10px] font-semibold text-ds-muted transition hover:bg-amber-500/10 hover:text-ds-ink"
        >
          <X className="h-3.5 w-3.5" />
          {t('graphPlanningCancel')}
        </button>
        <button
          type="button"
          data-graph-planning-resume
          onClick={() => void resumeDraft(correctionDraft.draft.id)}
          className="h-8 shrink-0 rounded-lg bg-indigo-600 px-3 text-[10px] font-semibold text-white transition hover:bg-indigo-500"
        >
          {t('graphPlanningContinue')}
        </button>
      </div>
    )
  }

  if (!run || !progress) return null

  const cancelClose = (): void => {
    if (hoverCloseTimerRef.current == null || typeof window === 'undefined') return
    window.clearTimeout(hoverCloseTimerRef.current)
    hoverCloseTimerRef.current = null
  }
  const openDetails = (): void => {
    cancelClose()
    setOpen(true)
  }
  const closeDetailsSoon = (): void => {
    cancelClose()
    if (typeof window === 'undefined') {
      setOpen(false)
      return
    }
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null
      setOpen(false)
    }, 140)
  }
  const openFullGraph = (runId: string, nodeId?: string): void => {
    setOpen(false)
    onOpenGraph?.(runId, nodeId)
  }
  const popoverStyle: CSSProperties = placement
    ? {
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        width: `${placement.width}px`,
        maxHeight: `${placement.maxHeight}px`
      }
    : {
        left: 0,
        top: 0,
        width: `${GRAPH_POPOVER_WIDTH}px`,
        maxHeight: `${GRAPH_POPOVER_MAX_HEIGHT}px`,
        visibility: 'hidden'
      }
  const statusLabel = t(`graphStatus_${run.status}`, { defaultValue: run.status })

  return (
    <>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={t('graphComposerPreview')}
              className="ds-no-drag fixed z-[1000] flex flex-col gap-2.5 overflow-y-auto rounded-[22px] border border-ds-border bg-white p-3 text-ds-ink shadow-[0_20px_54px_rgba(20,47,95,0.18)] dark:bg-ds-card"
              style={popoverStyle}
              data-graph-composer-popover
              onPointerEnter={cancelClose}
              onPointerLeave={closeDetailsSoon}
              onFocus={cancelClose}
              onBlur={closeDetailsSoon}
            >
              <div className="flex shrink-0 items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <GitBranch className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-ds-ink">
                    {run.plans.at(-1)?.title ?? t('graphPanelTitle')}
                  </div>
                  <div className="text-[10px] text-ds-faint">
                    {t('graphComposerProgress', {
                      completed: progress.completed,
                      total: progress.total,
                      status: statusLabel
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openFullGraph(run.id)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ds-border-muted px-2.5 text-[10px] font-semibold text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                >
                  {t('graphComposerOpenFull')}
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
              <FloatingComposerGraphPreview
                run={run}
                childRuns={childRuns}
                now={now}
                reducedMotion={reducedMotion}
                onOpenGraph={openFullGraph}
                onOpenChild={onOpenChild}
              />
            </div>,
            document.body
          )
        : null}
      <div
        ref={rootRef}
        data-composer-stack-item="graph"
        className="pointer-events-auto w-full max-w-[46rem] shrink-0"
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={openDetails}
          onFocus={openDetails}
          onBlur={closeDetailsSoon}
          onPointerEnter={openDetails}
          onPointerLeave={closeDetailsSoon}
          className="ds-no-drag flex min-h-11 w-full items-center gap-3 rounded-2xl border border-ds-border bg-white/96 px-3 py-2 text-left shadow-[0_10px_30px_rgba(20,47,95,0.10)] backdrop-blur-xl transition hover:border-ds-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 dark:bg-ds-card/96"
          aria-label={t('graphComposerAria', {
            completed: progress.completed,
            total: progress.total,
            status: statusLabel
          })}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <GitBranch className="h-4 w-4" strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-ds-ink">Graph</span>
              <span className="truncate text-[11px] text-ds-muted">
                {currentLiveness?.quiet
                  ? t('graphStillWaiting', {
                      seconds: Math.floor((currentLiveness.lastActivityAgeMs ?? 0) / 1_000)
                    })
                  : currentLiveness?.activityLabel ??
                    t(`graphLiveness_${currentLiveness?.kind ?? 'idle'}`, {
                      defaultValue: progress.currentNodeTitle ?? statusLabel
                    })}
              </span>
              <span className="ml-auto shrink-0 text-[10px] font-semibold text-ds-faint">
                {t('graphCompletedAndRunning', {
                  completed: progress.completed,
                  total: progress.total,
                  running: progress.activeCount
                })}
              </span>
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-[9px] text-ds-faint">
              <span className="truncate">
                {progress.currentNodeTitle ?? statusLabel}
                {progress.currentAgent ? ` · ${progress.currentAgent}` : ''}
                {progress.attemptNumber ? ` · #${progress.attemptNumber}` : ''}
              </span>
              {currentLiveness?.elapsedMs ? (
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatSubagentElapsed(currentLiveness.elapsedMs)}
                </span>
              ) : null}
            </span>
            <span className="relative mt-1 block h-1 overflow-hidden rounded-full bg-ds-border-muted">
              <span
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
              {progress.activeCount > 0 ? (
                <span
                  className={
                    reducedMotion
                      ? 'absolute inset-y-0 left-0 w-1/3 bg-accent/45'
                      : 'ds-subagent-lane-sweep absolute inset-y-0 w-2/5'
                  }
                  aria-hidden
                />
              ) : null}
            </span>
          </span>
          <AgentStack names={progress.activeAgents} />
          <ChevronUp
            className={`h-3.5 w-3.5 shrink-0 text-ds-faint transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>
    </>
  )
}
