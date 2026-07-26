import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node
} from '@xyflow/react'
import {
  CirclePause,
  CirclePlay,
  GitBranch,
  List,
  RefreshCw,
  Send,
  Square,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  GraphArtifactPage,
  GraphNodeProjection,
  GraphPatchOperation,
  GraphRun
} from '../../graph/graph-types'
import { filterGraphElementsByPhases } from './graph-elements'
import { GraphNodeInspector } from './GraphNodeInspector'
import { GraphRunInspector } from './GraphRunInspector'
import {
  statusTone,
  StatusPill,
  terminalRunStatuses
} from './graph-panel-shared'

export function GraphRunView({
  run,
  runs,
  elements,
  progress,
  selectedNode,
  selectedNodeId,
  steering,
  onSteeringChange,
  onSendSteering,
  onSelectRun,
  onSelectNode,
  onRefresh,
  onCommand,
  onCancel,
  onRetry,
  onReview,
  onPatch,
  onRebind,
  onOpenChild,
  artifactPage,
  artifactContent,
  artifactLoading,
  onOpenArtifact,
  onNextArtifactPage,
  onCloseArtifact
}: {
  run: GraphRun | null
  runs: GraphRun[]
  elements: { nodes: Node[]; edges: Edge[] }
  progress: { completed: number; total: number }
  selectedNode?: GraphNodeProjection
  selectedNodeId: string | null
  steering: string
  onSteeringChange: (value: string) => void
  onSendSteering: () => void
  onSelectRun: (runId: string | null) => void
  onSelectNode: (nodeId: string | null) => void
  onRefresh: () => void
  onCommand: (action: 'start' | 'pause' | 'resume' | 'cleanup') => void
  onCancel: () => void
  onRetry: (nodeId: string) => void
  onReview: (nodeId: string, outcome: 'pass' | 'fail') => void
  onPatch: (operations: GraphPatchOperation[], reason: string) => Promise<void>
  onRebind: (nodeId: string, profileId: string) => void
  onOpenChild: (threadId: string) => void
  artifactPage: GraphArtifactPage | null
  artifactContent: string
  artifactLoading: boolean
  onOpenArtifact: (artifactId: string) => void
  onNextArtifactPage: () => void
  onCloseArtifact: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<string[]>([])
  const [listFallback, setListFallback] = useState(false)
  const defaultCollapsedPhaseIds = run?.plans.at(-1)?.phases
    .filter((phase) => phase.collapsedByDefault)
    .map((phase) => phase.id) ?? []
  const defaultCollapsedPhaseKey = defaultCollapsedPhaseIds.join(',')
  useEffect(() => {
    setCollapsedPhaseIds(defaultCollapsedPhaseKey ? defaultCollapsedPhaseKey.split(',') : [])
    setListFallback(false)
  }, [defaultCollapsedPhaseKey, run?.id, run?.currentRevision])
  const collapsedPhases = useMemo(
    () => new Set(collapsedPhaseIds),
    [collapsedPhaseIds]
  )
  const visibleElements = useMemo(
    () => run
      ? filterGraphElementsByPhases(run, elements, collapsedPhases)
      : { nodes: [], edges: [] },
    [collapsedPhases, elements, run]
  )
  if (!run) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <GitBranch className="h-8 w-8 text-ds-faint" strokeWidth={1.5} />
        <div className="mt-3 text-[13px] font-semibold text-ds-ink">
          {t('graphEmptyRunTitle')}
        </div>
        <div className="mt-1 text-[11px] leading-5 text-ds-muted">
          {t('graphEmptyRunBody')}
        </div>
      </div>
    )
  }
  const canPause = ['ready', 'running', 'awaiting_supervision'].includes(run.status)
  const canResume = run.status === 'paused'
  const canStart = run.status === 'ready'
  const canCleanup = terminalRunStatuses.has(run.status) &&
    !run.cleanup?.some((item) => item.resourceKind === 'journal' && item.state === 'completed')
  const plan = run.plans.at(-1)
  const visibleNodeIds = new Set(visibleElements.nodes.map((node) => node.id))
  const stateCounts = Object.values(run.nodes).reduce<Record<string, number>>((counts, node) => {
    counts[node.status] = (counts[node.status] ?? 0) + 1
    return counts
  }, {})
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-ds-border-muted px-3 py-2.5">
        <div className="flex items-center gap-2">
          <select
            value={run.id}
            onChange={(event) => onSelectRun(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-ds-border-muted bg-ds-card px-2 py-1.5 text-[11px] text-ds-ink outline-none"
          >
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.plans.at(-1)?.title ?? item.id}
              </option>
            ))}
          </select>
          <StatusPill status={run.status} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div role="status" aria-live="polite" className="text-[10px] text-ds-faint">
            {t('graphRunProgress', {
              revision: run.currentRevision,
              completed: progress.completed,
              total: progress.total,
              loops: run.budget.loopIterations,
              tokens: run.budget.totalTokens.toLocaleString()
            })}
          </div>
          <div className="flex items-center gap-1">
            {canStart ? <IconButton label={t('graphActionStart')} onClick={() => onCommand('start')}><CirclePlay /></IconButton> : null}
            {canPause ? <IconButton label={t('graphActionPause')} onClick={() => onCommand('pause')}><CirclePause /></IconButton> : null}
            {canResume ? <IconButton label={t('graphActionResume')} onClick={() => onCommand('resume')}><CirclePlay /></IconButton> : null}
            {!terminalRunStatuses.has(run.status) ? <IconButton label={t('graphActionCancel')} onClick={onCancel}><Square /></IconButton> : null}
            {canCleanup ? <IconButton label={t('graphActionCleanup')} onClick={() => onCommand('cleanup')}><Trash2 /></IconButton> : null}
            <IconButton label={t('refresh')} onClick={onRefresh}><RefreshCw /></IconButton>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-ds-hover">
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width]"
            role="progressbar"
            aria-label={t('graphProgressLabel')}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }}
          />
        </div>
        <div className="flex gap-1 overflow-x-auto" aria-label={t('graphStateCounts')}>
          {Object.entries(stateCounts)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([status, count]) => (
              <span
                key={status}
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] ${statusTone(status)}`}
              >
                {t(`graphStatus_${status}`, { defaultValue: status })} {count}
              </span>
            ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-ds-border-muted bg-ds-main px-3 py-1.5">
        <button
          type="button"
          aria-pressed={listFallback}
          onClick={() => setListFallback((value) => !value)}
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] ${
            listFallback ? 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-200' : 'bg-ds-card text-ds-muted'
          }`}
        >
          <List className="h-3 w-3" />
          {t('graphListFallback')}
        </button>
        {plan?.phases
          .slice()
          .sort((left, right) => left.order - right.order)
          .map((phase) => {
            const collapsed = collapsedPhases.has(phase.id)
            const count = plan.nodes.filter((node) => node.phaseId === phase.id).length
            return (
              <button
                key={phase.id}
                type="button"
                aria-pressed={!collapsed}
                aria-label={t('graphTogglePhase', { phase: phase.title, count })}
                onClick={() => setCollapsedPhaseIds((current) =>
                  current.includes(phase.id)
                    ? current.filter((id) => id !== phase.id)
                    : [...current, phase.id])}
                className={`h-7 shrink-0 rounded-md px-2 text-[10px] ${
                  collapsed ? 'border border-ds-border-muted text-ds-faint' : 'bg-ds-card text-ds-ink'
                }`}
              >
                {phase.title} · {count}
              </button>
            )
          })}
      </div>

      <div className="min-h-[260px] flex-1 bg-ds-main">
        {listFallback ? (
          <div role="list" aria-label={t('graphListFallback')} className="h-full overflow-y-auto p-3">
            {plan?.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => (
              <button
                key={node.id}
                type="button"
                role="listitem"
                onClick={() => onSelectNode(node.id)}
                className="mb-1.5 flex w-full items-center justify-between gap-3 rounded-lg border border-ds-border-muted bg-ds-card px-3 py-2 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-semibold text-ds-ink">
                    {node.title}
                  </span>
                  <span className="block truncate text-[9px] text-ds-faint">
                    {plan?.phases.find((phase) => phase.id === node.phaseId)?.title} · {node.kind}
                  </span>
                </span>
                <StatusPill status={run.nodes[node.id]?.status ?? 'pending'} />
              </button>
            ))}
          </div>
        ) : (
          <ReactFlow
            aria-label={t('graphCanvasLabel')}
            nodes={visibleElements.nodes}
            edges={visibleElements.edges}
            fitView
            minZoom={0.2}
            maxZoom={1.8}
            nodesDraggable
            nodesConnectable={false}
            onlyRenderVisibleElements
            elementsSelectable
            onPaneClick={() => onSelectNode(null)}
            onNodeClick={(_, node) => onSelectNode(node.id)}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      <div className="max-h-[42%] shrink-0 overflow-y-auto border-t border-ds-border-muted bg-ds-sidebar">
        {selectedNode ? (
          <GraphNodeInspector
            run={run}
            node={selectedNode}
            onRetry={() => onRetry(selectedNode.node.id)}
            onReview={(outcome) => onReview(selectedNode.node.id, outcome)}
            onRebind={(profileId) => onRebind(selectedNode.node.id, profileId)}
            onOpenChild={onOpenChild}
            artifactPage={artifactPage}
            artifactContent={artifactContent}
            artifactLoading={artifactLoading}
            onOpenArtifact={onOpenArtifact}
            onNextArtifactPage={onNextArtifactPage}
            onCloseArtifact={onCloseArtifact}
          />
        ) : (
          <GraphRunInspector run={run} onPatch={onPatch} />
        )}
        <div className="flex items-end gap-2 border-t border-ds-border-muted p-3">
          <textarea
            value={steering}
            onChange={(event) => onSteeringChange(event.target.value)}
            rows={2}
            placeholder={selectedNodeId ? t('graphSteerNodePlaceholder') : t('graphSteerRunPlaceholder')}
            className="min-w-0 flex-1 resize-none rounded-lg border border-ds-border-muted bg-ds-card px-2.5 py-2 text-[11px] text-ds-ink outline-none focus:border-indigo-400"
          />
          <button
            type="button"
            disabled={!steering.trim()}
            onClick={onSendSteering}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white disabled:opacity-40"
            aria-label={t('graphSendSteering')}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-lg border border-ds-border-muted bg-ds-card p-1.5 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
    </button>
  )
}
