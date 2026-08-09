import { useId, useState, type KeyboardEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { graphNodeLiveness } from '../../graph/graph-liveness'
import type { GraphChildRuntime, GraphNodeStatus, GraphRun } from '../../graph/graph-types'
import { formatSubagentElapsed, SubagentLiveAvatar } from '../subagents/SubagentLiveness'
import {
  fitComposerGraphLabel,
  layoutComposerGraph,
  type ComposerGraphLayout,
  type ComposerGraphLayoutNode
} from './composer-graph-preview'

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

export function AgentStack({ names }: { names: string[] }): ReactElement {
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
