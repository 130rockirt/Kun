import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { Edge, Node } from '@xyflow/react'
import {
  CirclePause,
  CirclePlay,
  Clock3,
  GitBranch,
  List,
  RefreshCw,
  Square,
  Trash2,
  UserRoundCheck
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { graphNodeLiveness } from '../../graph/graph-liveness'
import { useGraphStore } from '../../graph/graph-store'
import type {
  GraphArtifactPage,
  GraphNodeProjection,
  GraphPatchOperation,
  GraphRun
} from '../../graph/graph-types'
import {
  formatSubagentElapsed,
  SubagentLivenessLane,
  useSubagentReducedMotion
} from '../subagents/SubagentLiveness'
import { filterGraphElementsByPhases } from './graph-elements'
import { GraphRunWorkspace } from './GraphRunWorkspace'
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
  onOpenChild: (threadId: string, nodeId: string, attemptId: string) => void
  artifactPage: GraphArtifactPage | null
  artifactContent: string
  artifactLoading: boolean
  onOpenArtifact: (artifactId: string) => void
  onNextArtifactPage: () => void
  onCloseArtifact: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const childRuns = useGraphStore((state) => state.childRuns)
  const reducedMotion = useSubagentReducedMotion()
  const [now, setNow] = useState(() => Date.now())
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
  const activeProjection = run
    ? Object.values(run.nodes).find((node) =>
        ['queued', 'submitted', 'running', 'reviewing', 'repair_required'].includes(node.status))
    : undefined
  const activeLiveness = activeProjection
    ? graphNodeLiveness(activeProjection, childRuns, now)
    : null
  useEffect(() => {
    if (!run || !activeProjection || terminalRunStatuses.has(run.status)) return
    const id = globalThis.setInterval(() => setNow(Date.now()), 1_000)
    return () => globalThis.clearInterval(id)
  }, [activeProjection, run])
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
  const stateCounts = Object.values(run.nodes).reduce<Record<string, number>>((counts, node) => {
    counts[node.status] = (counts[node.status] ?? 0) + 1
    return counts
  }, {})
  const activeAgents = Object.values(run.nodes).filter((node) =>
    ['queued', 'submitted', 'running', 'reviewing', 'repair_required'].includes(node.status)).length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="graph-run-overview shrink-0 border-b border-ds-border-muted bg-ds-sidebar px-3 pb-2.5 pt-2">
        <div className="flex items-center gap-2">
          <select
            value={run.id}
            onChange={(event) => onSelectRun(event.target.value)}
            aria-label={t('graphSelectRun')}
            className="h-9 min-w-0 flex-1 rounded-xl border border-ds-border-muted bg-ds-card px-3 text-[11px] font-semibold text-ds-ink shadow-sm outline-none transition focus:border-indigo-400"
          >
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.plans.at(-1)?.title ?? item.id}
              </option>
            ))}
          </select>
          <StatusPill status={run.status} />
          <div className="flex items-center gap-1">
            {canStart ? <IconButton label={t('graphActionStart')} onClick={() => onCommand('start')}><CirclePlay /></IconButton> : null}
            {canPause ? <IconButton label={t('graphActionPause')} onClick={() => onCommand('pause')}><CirclePause /></IconButton> : null}
            {canResume ? <IconButton label={t('graphActionResume')} onClick={() => onCommand('resume')}><CirclePlay /></IconButton> : null}
            {!terminalRunStatuses.has(run.status) ? <IconButton label={t('graphActionCancel')} onClick={onCancel}><Square /></IconButton> : null}
            {canCleanup ? <IconButton label={t('graphActionCleanup')} onClick={() => onCommand('cleanup')}><Trash2 /></IconButton> : null}
            <IconButton label={t('refresh')} onClick={onRefresh}><RefreshCw /></IconButton>
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          className="mt-2 grid grid-cols-3 gap-1.5 xl:grid-cols-6"
        >
          <RunMetric
            label={t('graphMetricProgress')}
            value={`${progress.completed}/${progress.total}`}
            detail={t('graphRevisionShort', { revision: run.currentRevision })}
            tone="indigo"
          />
          <RunMetric
            label={t('graphStatus_blocked')}
            value={String(stateCounts.blocked ?? 0)}
            detail={t('graphMetricNodes')}
            tone="neutral"
          />
          <RunMetric
            label={t('graphStatus_ready')}
            value={String(stateCounts.ready ?? 0)}
            detail={t('graphMetricNodes')}
          />
          <RunMetric
            label={t('graphActiveAgents')}
            value={String(activeAgents)}
            detail={t('graphMetricRunning')}
            icon={<UserRoundCheck />}
          />
          <RunMetric
            label={t('graphMetricElapsed')}
            value={formatElapsed(run.budget.elapsedMs)}
            detail={formatElapsed(run.budget.limits.maxWallTimeMs)}
            icon={<Clock3 />}
          />
          <RunMetric
            label={t('graphAttempts')}
            value={run.budget.attempts.toLocaleString()}
            detail={t('graphMetricTotal')}
          />
        </div>

        {activeProjection && activeLiveness ? (
          <div
            role="status"
            aria-live="polite"
            className="mt-2 flex items-center gap-2 rounded-lg border border-indigo-400/15 bg-indigo-500/5 px-2.5 py-1.5 text-[10px]"
          >
            <span className="shrink-0 font-semibold text-indigo-700 dark:text-indigo-200">
              {t(`graphLiveness_${activeLiveness.kind}`)}
            </span>
            <span className="min-w-0 flex-1 truncate text-ds-muted">
              {activeProjection.node.title}
              {' · '}
              {activeLiveness.quiet
                ? t('graphStillWaiting', {
                    seconds: Math.floor((activeLiveness.lastActivityAgeMs ?? 0) / 1_000)
                  })
                : activeLiveness.activityLabel ?? t(`graphStatus_${activeProjection.status}`)}
              {activeLiveness.activityToolName ? ` · ${activeLiveness.activityToolName}` : ''}
            </span>
            {activeLiveness.attemptNumber ? (
              <span className="shrink-0 text-ds-faint">#{activeLiveness.attemptNumber}</span>
            ) : null}
            {activeLiveness.elapsedMs ? (
              <span className="shrink-0 tabular-nums text-ds-faint">
                {formatSubagentElapsed(activeLiveness.elapsedMs)}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="relative mt-2 h-1 overflow-hidden rounded-full bg-ds-hover">
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width]"
            role="progressbar"
            aria-label={t('graphProgressLabel')}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }}
          />
          {activeAgents > 0 ? (
            <span className="absolute inset-0">
              <SubagentLivenessLane status="running" animate={!reducedMotion} />
            </span>
          ) : null}
        </div>
      </div>

      <div className="graph-phase-nav flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-ds-border-muted bg-ds-main px-3 py-2">
        <button
          type="button"
          aria-pressed={listFallback}
          onClick={() => setListFallback((value) => !value)}
          className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[10px] font-semibold ${
            listFallback
              ? 'border-indigo-400/40 bg-indigo-500/12 text-indigo-700 dark:text-indigo-200'
              : 'border-ds-border-muted bg-ds-card text-ds-muted'
          }`}
        >
          <List className="h-3 w-3" />
          {t('graphListFallback')}
        </button>
        <span aria-hidden className="h-5 w-px shrink-0 bg-ds-border-muted" />
        {plan?.phases
          .slice()
          .sort((left, right) => left.order - right.order)
          .map((phase, phaseIndex) => {
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
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-semibold transition ${
                  collapsed
                    ? 'border-ds-border-muted bg-transparent text-ds-faint'
                    : 'border-indigo-300/30 bg-ds-card text-ds-ink shadow-sm'
                }`}
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] ${
                  collapsed ? 'bg-ds-hover text-ds-faint' : 'bg-indigo-600 text-white'
                }`}>
                  {phaseIndex + 1}
                </span>
                {phase.title}
                <span className="text-ds-faint">· {count}</span>
              </button>
            )
          })}
        <div className="ml-auto flex shrink-0 gap-1" aria-label={t('graphStateCounts')}>
          {Object.entries(stateCounts)
            .filter(([, count]) => count > 0)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 4)
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

      <GraphRunWorkspace
        run={run}
        elements={visibleElements}
        listFallback={listFallback}
        selectedNode={selectedNode}
        selectedNodeId={selectedNodeId}
        steering={steering}
        onSteeringChange={onSteeringChange}
        onSendSteering={onSendSteering}
        onSelectNode={onSelectNode}
        onRetry={onRetry}
        onReview={onReview}
        onPatch={onPatch}
        onRebind={onRebind}
        onOpenChild={onOpenChild}
        artifactPage={artifactPage}
        artifactContent={artifactContent}
        artifactLoading={artifactLoading}
        onOpenArtifact={onOpenArtifact}
        onNextArtifactPage={onNextArtifactPage}
        onCloseArtifact={onCloseArtifact}
      />
    </div>
  )
}

function RunMetric({
  label,
  value,
  detail,
  tone = 'neutral',
  icon
}: {
  label: string
  value: string
  detail: string
  tone?: 'neutral' | 'indigo' | 'amber'
  icon?: ReactElement
}): ReactElement {
  const toneClass = tone === 'indigo'
    ? 'border-indigo-400/25 bg-indigo-500/7'
    : tone === 'amber'
      ? 'border-amber-400/30 bg-amber-500/8'
      : 'border-ds-border-muted bg-ds-card'
  return (
    <div className={`min-w-0 rounded-xl border px-2.5 py-2 ${toneClass}`}>
      <div className="flex items-center gap-1 truncate text-[8px] font-semibold uppercase tracking-wide text-ds-faint [&_svg]:h-3 [&_svg]:w-3">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[13px] font-semibold tabular-nums text-ds-ink">{value}</span>
        <span className="truncate text-[8px] text-ds-faint">{detail}</span>
      </div>
    </div>
  )
}

function formatElapsed(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
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
