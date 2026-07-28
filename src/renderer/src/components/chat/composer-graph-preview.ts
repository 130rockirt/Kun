import type {
  GraphChildRuntime,
  GraphNodeProjection,
  GraphNodeStatus,
  GraphPlanEdge,
  GraphRun
} from '../../graph/graph-types'

const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled'])
// Completion is deliberately stricter than terminality. A skipped,
// superseded, failed, or cancelled node may close scheduler work, but it has
// not passed Graph acceptance and must not advance the accepted-work bar.
const completedNodeStatuses = new Set<GraphNodeStatus>(['accepted'])
const activeNodeStatuses = new Set<GraphNodeStatus>([
  'queued',
  'running',
  'submitted',
  'reviewing',
  'repair_required'
])
const currentNodeStatuses = new Set<GraphNodeStatus>([
  ...activeNodeStatuses,
  'ready'
])
const activeChildStatuses = new Set<GraphChildRuntime['status']>(['queued', 'running'])

const PHASE_WIDTH = 168
const PHASE_GAP = 24
const NODE_WIDTH = 144
const NODE_HEIGHT = 58
const NODE_GAP = 18
const LEFT_PADDING = 24
const TOP_PADDING = 56
const BOTTOM_PADDING = 22

export type ComposerGraphProgress = {
  completed: number
  total: number
  fraction: number
  activeAgents: string[]
  activeCount: number
  currentNodeTitle: string | null
  currentNodeId: string | null
  currentStatus: GraphNodeStatus | null
  currentAgent: string | null
  attemptNumber: number | null
  childThreadId: string | null
  childRuntime: GraphChildRuntime | null
}

export type ComposerGraphLayoutNode = {
  id: string
  phaseId: string
  title: string
  objective: string
  agentName: string
  status: GraphNodeStatus
  attemptNumber?: number
  childThreadId?: string
  childRuntime?: GraphChildRuntime
  x: number
  y: number
  width: number
  height: number
}

export type ComposerGraphLayoutEdge = GraphPlanEdge & {
  path: string
}

export type ComposerGraphLayout = {
  width: number
  height: number
  phases: Array<{ id: string; title: string; x: number; width: number }>
  nodes: ComposerGraphLayoutNode[]
  edges: ComposerGraphLayoutEdge[]
}

function currentPlan(run: GraphRun): GraphRun['plans'][number] | undefined {
  return run.plans.find((plan) => plan.revision === run.currentRevision) ?? run.plans.at(-1)
}

export function graphNodeAgentName(projection: GraphNodeProjection): string {
  const attemptName = projection.attempts.at(-1)?.assignment.name?.trim()
  if (attemptName) return attemptName
  const assignment = projection.node.assignment
  if (assignment?.kind === 'ephemeral') return assignment.name
  if (assignment?.kind === 'existing') return assignment.profileId
  return 'Kun'
}

export function selectComposerGraphRun(
  runs: readonly GraphRun[],
  selectedRunId: string | null
): GraphRun | null {
  const selected = runs.find((run) => run.id === selectedRunId)
  if (selected && !terminalRunStatuses.has(selected.status)) return selected
  return runs.find((run) => !terminalRunStatuses.has(run.status)) ?? null
}

export function getComposerGraphProgress(
  run: GraphRun,
  childRuns: Readonly<Record<string, GraphChildRuntime>> = {}
): ComposerGraphProgress {
  const runTerminal = terminalRunStatuses.has(run.status)
  const plan = currentPlan(run)
  const projections = (plan?.nodes ?? [])
    .map((node) => run.nodes[node.id])
    .filter((node): node is GraphNodeProjection => Boolean(node))
  const completed = projections.filter((projection) => (
    completedNodeStatuses.has(projection.status)
  )).length
  const childForProjection = (projection: GraphNodeProjection): GraphChildRuntime | null => {
    const childThreadId = projection.attempts.at(-1)?.childThreadId
    return childThreadId ? childRuns[childThreadId] ?? null : null
  }
  const projectionIsActive = (projection: GraphNodeProjection): boolean =>
    !runTerminal && (
      activeNodeStatuses.has(projection.status) ||
      activeChildStatuses.has(childForProjection(projection)?.status ?? 'completed')
    )
  const active = projections.filter(projectionIsActive)
  const current = projections.find(projectionIsActive) ??
    projections.find((projection) => currentNodeStatuses.has(projection.status))
  const activeAgents = [...new Set(active.map(graphNodeAgentName))]
  const currentAttempt = current?.attempts.at(-1)
  const childThreadId = currentAttempt?.childThreadId ?? null
  const childRuntime = childThreadId ? childRuns[childThreadId] ?? null : null

  return {
    completed,
    total: plan?.nodes.length ?? projections.length,
    fraction: plan?.nodes.length ? completed / plan.nodes.length : 0,
    activeAgents,
    activeCount: active.length,
    currentNodeTitle: current?.node.title ?? null,
    currentNodeId: current?.node.id ?? null,
    currentStatus: current?.status ?? null,
    currentAgent: current ? graphNodeAgentName(current) : null,
    attemptNumber: currentAttempt?.attemptNumber ?? null,
    childThreadId,
    childRuntime
  }
}

function edgePath(
  from: ComposerGraphLayoutNode,
  to: ComposerGraphLayoutNode
): string {
  const fromX = from.x + from.width
  const fromY = from.y + from.height / 2
  const toX = to.x
  const toY = to.y + to.height / 2
  const controlOffset = Math.max(34, Math.abs(toX - fromX) * 0.45)
  const direction = toX >= fromX ? 1 : -1
  return [
    `M ${fromX} ${fromY}`,
    `C ${fromX + controlOffset * direction} ${fromY}`,
    `${toX - controlOffset * direction} ${toY}`,
    `${toX} ${toY}`
  ].join(' ')
}

export function layoutComposerGraph(
  run: GraphRun,
  childRuns: Readonly<Record<string, GraphChildRuntime>> = {}
): ComposerGraphLayout {
  const plan = currentPlan(run)
  if (!plan) return { width: 640, height: 220, phases: [], nodes: [], edges: [] }
  const phases = [...plan.phases].sort((left, right) => left.order - right.order)
  const nodesByPhase = new Map<string, ComposerGraphLayoutNode[]>()

  for (const node of plan.nodes) {
    const projection = run.nodes[node.id]
    if (!projection) continue
    const phaseIndex = Math.max(0, phases.findIndex((phase) => phase.id === node.phaseId))
    const phaseNodes = nodesByPhase.get(node.phaseId) ?? []
    const attempt = projection.attempts.at(-1)
    const childThreadId = attempt?.childThreadId
    const layoutNode: ComposerGraphLayoutNode = {
      id: node.id,
      phaseId: node.phaseId,
      title: node.title,
      objective: node.objective,
      agentName: graphNodeAgentName(projection),
      status: projection.status,
      ...(attempt ? { attemptNumber: attempt.attemptNumber } : {}),
      ...(childThreadId ? { childThreadId } : {}),
      ...(childThreadId && childRuns[childThreadId]
        ? { childRuntime: childRuns[childThreadId] }
        : {}),
      x: LEFT_PADDING + phaseIndex * (PHASE_WIDTH + PHASE_GAP),
      y: TOP_PADDING + phaseNodes.length * (NODE_HEIGHT + NODE_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    }
    phaseNodes.push(layoutNode)
    nodesByPhase.set(node.phaseId, phaseNodes)
  }

  const nodes = phases.flatMap((phase) => nodesByPhase.get(phase.id) ?? [])
  const nodeLookup = new Map(nodes.map((node) => [node.id, node]))
  const edges = plan.edges.flatMap((edge) => {
    const from = nodeLookup.get(edge.from)
    const to = nodeLookup.get(edge.to)
    return from && to ? [{ ...edge, path: edgePath(from, to) }] : []
  })
  const maximumRows = Math.max(1, ...[...nodesByPhase.values()].map((items) => items.length))
  const width = Math.max(
    640,
    LEFT_PADDING * 2 + phases.length * PHASE_WIDTH + Math.max(0, phases.length - 1) * PHASE_GAP
  )
  const height = TOP_PADDING + maximumRows * NODE_HEIGHT
    + Math.max(0, maximumRows - 1) * NODE_GAP + BOTTOM_PADDING

  return {
    width,
    height,
    phases: phases.map((phase, index) => ({
      id: phase.id,
      title: phase.title,
      x: LEFT_PADDING + index * (PHASE_WIDTH + PHASE_GAP),
      width: PHASE_WIDTH
    })),
    nodes,
    edges
  }
}
