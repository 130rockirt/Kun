import { createHash } from 'node:crypto'
import {
  GRAPH_CONTRACT_VERSION,
  type GraphEventEnvelopeV1,
  type GraphRunV1,
  type GraphSupervisionObligationKind,
  type GraphSupervisionObligationV1
} from '../contracts/graph.js'

export type GraphSupervisionReason = GraphSupervisionObligationV1['reason']

export type GraphSupervisionSignalInput = {
  runId: string
  reason: GraphSupervisionReason
  nodeIds: string[]
  digest: string
}

const INFRASTRUCTURE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000] as const

export function graphSupervisionRetryDelayMs(attempt: number): number {
  return INFRASTRUCTURE_RETRY_DELAYS_MS[
    Math.min(Math.max(0, attempt), INFRASTRUCTURE_RETRY_DELAYS_MS.length - 1)
  ]
}

export function graphSupervisionObligationForSignal(
  run: GraphRunV1,
  input: GraphSupervisionSignalInput,
  nowIso: string
): GraphSupervisionObligationV1 {
  const nodeIds = [...new Set(input.nodeIds)]
    .filter((nodeId) => Boolean(run.nodes[nodeId]))
    .sort()
  const attemptIds = nodeIds.flatMap((nodeId) => {
    const attempt = run.nodes[nodeId]?.attempts.at(-1)
    return attempt ? [attempt.id] : []
  })
  const kind = obligationKind(input.reason)
  const subject = {
    runId: run.id,
    graphRevision: run.currentRevision,
    kind,
    nodeIds,
    attemptIds,
    ...(kind === 'stall'
      ? {
          activityEpoch: nodeIds.map((nodeId) => ({
            nodeId,
            latestProgressAt: run.nodes[nodeId]?.lastProgress?.createdAt ?? null,
            attemptStartedAt: run.nodes[nodeId]?.attempts.at(-1)?.startedAt ?? null
          }))
        }
      : {}),
    ...(kind === 'scheduler_error'
      ? {
          schedulerProjection: {
            status: run.status,
            hasSummary: Boolean(run.summary),
            nodes: Object.values(run.nodes)
              .map((node) => ({
                nodeId: node.node.id,
                status: node.status,
                attemptId: node.attempts.at(-1)?.id ?? null,
                attemptStatus: node.attempts.at(-1)?.status ?? null
              }))
              .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
          }
        }
      : {}),
    ...(subjectUsesDigest(kind)
      ? { digest: normalizeDigest(input.digest), steeringId: run.steering.at(-1)?.steeringId }
      : {})
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(subject))
    .digest('hex')
    .slice(0, 32)
  return {
    version: GRAPH_CONTRACT_VERSION,
    id: `graph_obligation_${digest}`,
    kind,
    reason: input.reason,
    graphRevision: run.currentRevision,
    nodeIds,
    attemptIds,
    digest: input.digest.slice(0, 4_096),
    state: 'pending',
    deliveryAttempts: 0,
    noProgressCount: 0,
    lastProgressSeq: run.lastEventSeq,
    createdAt: nowIso,
    updatedAt: nowIso
  }
}

export function graphSupervisionSignalForObligation(
  runId: string,
  obligation: GraphSupervisionObligationV1
): GraphSupervisionSignalInput {
  return {
    runId,
    reason: obligation.reason,
    nodeIds: obligation.nodeIds,
    digest: obligation.digest
  }
}

const SEMANTIC_PROGRESS_EVENT_TYPES = new Set<GraphEventEnvelopeV1['event']['type']>([
  'plan_validated',
  'run_status_changed',
  'plan_revised',
  'node_status_changed',
  'loop_iteration_advanced',
  'attempt_created',
  'attempt_status_changed',
  'progress_reported',
  'result_submitted',
  'review_recorded',
  'message_created',
  'artifact_published',
  'steering_recorded',
  'run_summary_recorded'
])

/**
 * Return the latest durable Graph sequence that represents domain progress,
 * excluding supervision bookkeeping and other maintenance-only events.
 */
export function graphLatestSemanticProgressSeq(
  events: readonly GraphEventEnvelopeV1[],
  afterSeq: number
): number | undefined {
  let latest: number | undefined
  for (const envelope of events) {
    if (
      envelope.graphSeq <= afterSeq ||
      !SEMANTIC_PROGRESS_EVENT_TYPES.has(envelope.event.type)
    ) continue
    latest = Math.max(latest ?? 0, envelope.graphSeq)
  }
  return latest
}

export function graphSupervisionObligationIsActionable(
  run: GraphRunV1,
  obligation: GraphSupervisionObligationV1
): boolean {
  if (obligation.state === 'resolved' || obligation.state === 'needs_attention') return false
  if (obligation.kind === 'completion') {
    return run.status === 'completed' || run.status === 'completing'
  }
  if (isTerminal(run.status)) {
    return obligation.kind === 'repair_required' || obligation.reason === 'failure'
  }
  if (obligation.graphRevision !== run.currentRevision) return false

  switch (obligation.kind) {
    case 'review_required':
      return obligation.attemptIds.some((attemptId) => {
        const node = obligation.nodeIds
          .map((nodeId) => run.nodes[nodeId])
          .find((projection) => projection?.attempts.some((attempt) => attempt.id === attemptId))
        const attempt = node?.attempts.find((candidate) => candidate.id === attemptId)
        if (!node || !attempt) return false
        if (!['submitted', 'reviewing'].includes(node.status)) return false
        if (!['submitted', 'reviewing'].includes(attempt.status)) return false
        return !run.reviews.some((review) =>
          review.attemptId === attemptId && review.reviewerKind === 'lead')
      })
    case 'repair_required':
      return obligation.nodeIds.some((nodeId) => {
        const status = run.nodes[nodeId]?.status
        return status === 'failed' || status === 'repair_required'
      })
    case 'stall':
      return obligation.attemptIds.some((attemptId) =>
        obligation.nodeIds.some((nodeId) => {
          const node = run.nodes[nodeId]
          const attempt = node?.attempts.find((candidate) => candidate.id === attemptId)
          if (
            node?.lastProgress?.createdAt &&
            Date.parse(node.lastProgress.createdAt) > Date.parse(obligation.createdAt)
          ) return false
          return attempt?.status === 'running' || attempt?.status === 'waiting'
        }))
    case 'conflict':
    case 'scheduler_error':
    case 'recovery':
      return run.status === 'awaiting_supervision' || run.status === 'completing'
    default:
      return true
  }
}

function obligationKind(reason: GraphSupervisionReason): GraphSupervisionObligationKind {
  if (reason === 'submitted') return 'review_required'
  if (reason === 'failure') return 'repair_required'
  return reason
}

function subjectUsesDigest(kind: GraphSupervisionObligationKind): boolean {
  return !['review_required', 'repair_required', 'stall'].includes(kind)
}

function normalizeDigest(value: string): string {
  return value.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 4_096)
}

function isTerminal(status: GraphRunV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
