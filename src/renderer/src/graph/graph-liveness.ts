import type {
  GraphChildRuntime,
  GraphNodeProjection,
  GraphSupervisionProjection
} from './graph-types'

export const GRAPH_ACTIVITY_QUIET_MS = 30_000

export type GraphLivenessKind =
  | 'working'
  | 'active_review'
  | 'waiting_lead'
  | 'retry_scheduled'
  | 'needs_attention'
  | 'retrying'
  | 'waiting_dependency'
  | 'waiting_human'
  | 'queued'
  | 'idle'
  | 'done'
  | 'failed'

export type GraphNodeLiveness = {
  kind: GraphLivenessKind
  child?: GraphChildRuntime
  childThreadId?: string
  attemptNumber?: number
  activityLabel?: string
  activityToolName?: string
  startedAt?: string
  elapsedMs: number
  lastActivityAgeMs?: number
  quiet: boolean
}

const PROCESSING_GRAPH_LIVENESS_KINDS = new Set<GraphLivenessKind>([
  'working',
  'active_review',
  'retrying'
])

export function graphLivenessIsProcessing(
  liveness: GraphNodeLiveness | null | undefined
): boolean {
  return Boolean(liveness && PROCESSING_GRAPH_LIVENESS_KINDS.has(liveness.kind))
}

function parsedTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function childRuntimeForNode(
  node: GraphNodeProjection,
  childRuns: Readonly<Record<string, GraphChildRuntime>>
): GraphChildRuntime | undefined {
  for (const attempt of [...node.attempts].reverse()) {
    if (attempt.childThreadId && childRuns[attempt.childThreadId]) {
      return childRuns[attempt.childThreadId]
    }
  }
  return undefined
}

export function graphNodeLiveness(
  node: GraphNodeProjection,
  childRuns: Readonly<Record<string, GraphChildRuntime>>,
  now = Date.now(),
  supervision?: GraphSupervisionProjection
): GraphNodeLiveness {
  const attempt = node.attempts.at(-1)
  const child = attempt?.childThreadId
    ? childRuns[attempt.childThreadId]
    : childRuntimeForNode(node, childRuns)
  const activity = child?.activity
  const startedAt = child?.startedAt ??
    activity?.startedAt ??
    attempt?.startedAt ??
    attempt?.queuedAt
  const startMs = parsedTimestamp(startedAt)
  const lastActivityMs = parsedTimestamp(activity?.updatedAt ?? child?.updatedAt)
  const nodeTerminal =
    node.status === 'accepted' ||
    node.status === 'skipped' ||
    node.status === 'superseded' ||
    node.status === 'failed' ||
    node.status === 'cancelled'
  const supervisionKind = supervisionLivenessForNode(node, supervision, now)
  const activelyRunning = !nodeTerminal && (
    node.status === 'running' ||
    supervisionKind === 'active_review' ||
    child?.status === 'running'
  )
  const elapsedMs = activelyRunning && startMs !== undefined
    ? Math.max(child?.durationMs ?? 0, attempt?.elapsedMs ?? 0, now - startMs)
    : child?.durationMs ?? attempt?.elapsedMs ?? 0
  const lastActivityAgeMs = lastActivityMs !== undefined
    ? Math.max(0, now - lastActivityMs)
    : undefined
  const quiet = !nodeTerminal &&
    child?.status === 'running' &&
    lastActivityAgeMs !== undefined &&
    lastActivityAgeMs >= GRAPH_ACTIVITY_QUIET_MS

  let kind: GraphLivenessKind
  if (node.status === 'accepted' || node.status === 'skipped' || node.status === 'superseded') {
    kind = 'done'
  } else if (node.status === 'failed' || node.status === 'cancelled') {
    kind = 'failed'
  } else if (node.status === 'blocked' || node.status === 'pending') {
    kind = 'waiting_dependency'
  } else if (node.status === 'reviewing' || node.status === 'submitted') {
    kind = supervisionKind ?? 'waiting_lead'
  } else if (node.status === 'repair_required' || activity?.phase === 'retrying') {
    kind = 'retrying'
  } else if (node.status === 'queued' || child?.status === 'queued') {
    kind = 'queued'
  } else if (activity?.phase === 'waiting') {
    kind = 'waiting_human'
  } else if (node.status === 'running' || child?.status === 'running') {
    kind = 'working'
  } else {
    kind = 'idle'
  }

  return {
    kind,
    ...(child ? { child } : {}),
    ...(attempt?.childThreadId ? { childThreadId: attempt.childThreadId } : {}),
    ...(attempt ? { attemptNumber: attempt.attemptNumber } : {}),
    ...(!nodeTerminal && !supervisionKind && activity?.label
      ? { activityLabel: activity.label }
      : {}),
    ...(!nodeTerminal && !supervisionKind && activity?.toolName
      ? { activityToolName: activity.toolName }
      : {}),
    ...(startedAt ? { startedAt } : {}),
    elapsedMs,
    ...(lastActivityAgeMs !== undefined ? { lastActivityAgeMs } : {}),
    quiet
  }
}

function supervisionLivenessForNode(
  node: GraphNodeProjection,
  supervision: GraphSupervisionProjection | undefined,
  now: number
): Extract<GraphLivenessKind,
  'active_review' | 'waiting_lead' | 'retry_scheduled' | 'needs_attention'> | undefined {
  const matching = supervision?.pendingActions.filter((action) =>
    action.nodeIds.includes(node.node.id)) ?? []
  if (matching.some((action) => action.liveness === 'needs_attention')) {
    return 'needs_attention'
  }
  if (supervision?.peerReviewLeases?.some((lease) =>
    lease.nodeId === node.node.id &&
    lease.attemptId === node.attempts.at(-1)?.id &&
    Date.parse(lease.leaseUntil) > now)) {
    return 'active_review'
  }
  if (matching.some((action) => action.liveness === 'active_review')) {
    return 'active_review'
  }
  if (matching.some((action) => action.liveness === 'retry_scheduled')) {
    return 'retry_scheduled'
  }
  if (matching.length) return 'waiting_lead'
  return undefined
}
