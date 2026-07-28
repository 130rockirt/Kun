import type {
  GraphNodeProjectionV1,
  GraphNodeStatus,
  GraphRunStatus,
  GraphRunV1
} from '../contracts/graph.js'

const TERMINAL_RUN_STATUSES = new Set<GraphRunStatus>([
  'completed',
  'failed',
  'cancelled'
])

const ACTIVE_NODE_STATUSES = new Set<GraphNodeStatus>([
  'queued',
  'running',
  'submitted',
  'reviewing',
  'repair_required'
])

const SETTLED_NODE_STATUSES = new Set<GraphNodeStatus>([
  'accepted',
  'failed',
  'cancelled',
  'skipped',
  'superseded'
])

const NODE_MARKERS: Record<GraphNodeStatus, string> = {
  pending: '·',
  blocked: '×',
  ready: '○',
  queued: '◌',
  running: '▶',
  submitted: '◇',
  reviewing: '◆',
  accepted: '✓',
  repair_required: '↻',
  failed: '!',
  cancelled: '−',
  skipped: '↷',
  superseded: '≈'
}

export type TuiGraphProgress = {
  runId: string
  title: string
  status: GraphRunStatus
  revision: number
  accepted: number
  settled: number
  active: number
  activeAgents: number
  total: number
}

export function isTerminalGraphRun(run: GraphRunV1): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status)
}

export function latestTuiGraphRun(
  runs: readonly GraphRunV1[],
  threadId?: string
): GraphRunV1 | undefined {
  return runs
    .filter((run) => !threadId || run.threadId === threadId)
    .sort((left, right) =>
      Number(isTerminalGraphRun(left)) - Number(isTerminalGraphRun(right)) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )[0]
}

export function summarizeTuiGraphRun(run: GraphRunV1): TuiGraphProgress {
  const nodes = Object.values(run.nodes)
  const activeNodes = nodes.filter((node) => ACTIVE_NODE_STATUSES.has(node.status))
  return {
    runId: run.id,
    title: currentPlan(run).title,
    status: run.status,
    revision: run.currentRevision,
    accepted: nodes.filter((node) => node.status === 'accepted').length,
    settled: nodes.filter((node) => SETTLED_NODE_STATUSES.has(node.status)).length,
    active: activeNodes.length,
    activeAgents: new Set(activeNodes.flatMap((node) => {
      const attempt = latestAttempt(node)
      return attempt ? [attempt.assignment.profileId] : []
    })).size,
    total: nodes.length
  }
}

export function renderTuiGraphStatus(
  run: GraphRunV1,
  maxNodes = 40
): string[] {
  const plan = currentPlan(run)
  const progress = summarizeTuiGraphRun(run)
  const dependencies = dependencyMap(plan.edges)
  const nodesByPhase = new Map(
    plan.phases.map((phase) => [
      phase.id,
      plan.nodes.filter((node) => node.phaseId === phase.id)
    ])
  )
  const lines = [
    `Run: ${run.id}`,
    `Title: ${plan.title}`,
    `Status: ${run.status} · revision ${run.currentRevision} · event ${run.lastEventSeq}`,
    `Progress: ${progress.accepted}/${progress.total} accepted · ${progress.settled}/${progress.total} settled · ${progress.active} active · ${progress.activeAgents} active agents`,
    `Budget: ${run.budget.totalTokens.toLocaleString()} tokens · ${run.budget.elapsedMs} ms · ${run.budget.attempts} attempts`,
    ''
  ]

  let rendered = 0
  const phases = [...plan.phases].sort((left, right) => left.order - right.order)
  for (const phase of phases) {
    const phaseNodes = nodesByPhase.get(phase.id) ?? []
    if (phaseNodes.length === 0) continue
    lines.push(`[Phase ${phase.order + 1}] ${phase.title}`)
    for (const node of phaseNodes) {
      if (rendered >= maxNodes) break
      const projection = run.nodes[node.id]
      const status = projection?.status ?? 'pending'
      const assignment = projection
        ? graphNodeAssignmentLabel(projection)
        : plannedAssignmentLabel(node.assignment)
      const child = projection ? latestAttempt(projection)?.childThreadId : undefined
      const dependencyIds = dependencies.get(node.id) ?? []
      lines.push(`  ${NODE_MARKERS[status]} ${node.title} · ${status} · agent ${assignment}`)
      if (dependencyIds.length > 0) lines.push(`    depends: ${dependencyIds.join(', ')}`)
      if (child) lines.push(`    child: ${child}`)
      if (projection?.lastTransitionReason) {
        lines.push(`    reason: ${oneLine(projection.lastTransitionReason, 240)}`)
      }
      rendered += 1
    }
    if (rendered >= maxNodes) break
  }
  if (rendered < plan.nodes.length) {
    lines.push(`… ${plan.nodes.length - rendered} more nodes omitted; Graph status is bounded to ${maxNodes}.`)
  }
  if (run.summary) {
    lines.push('', `Result: ${oneLine(run.summary.finalAnswer, 400)}`)
  }
  return lines
}

export function graphNodeAssignmentLabel(
  projection: GraphNodeProjectionV1
): string {
  const attempt = latestAttempt(projection)
  if (attempt) return `${attempt.assignment.name} (${attempt.assignment.profileId})`
  return plannedAssignmentLabel(projection.node.assignment)
}

function plannedAssignmentLabel(
  assignment: GraphNodeProjectionV1['node']['assignment']
): string {
  if (!assignment) return 'auto-route'
  return assignment.kind === 'existing'
    ? assignment.profileId
    : `${assignment.name} (ephemeral)`
}

function latestAttempt(projection: GraphNodeProjectionV1) {
  return projection.attempts.at(-1)
}

function currentPlan(run: GraphRunV1) {
  return run.plans.find((plan) => plan.revision === run.currentRevision) ??
    run.plans.at(-1)!
}

function dependencyMap(
  edges: GraphRunV1['plans'][number]['edges']
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.kind === 'message') continue
    result.set(edge.to, [...(result.get(edge.to) ?? []), edge.from])
  }
  return result
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}
