import type {
  GraphRunV1,
  GraphSupervisionObligationKind,
  GraphSupervisionObligationV1
} from '../contracts/graph.js'

export type GraphSupervisionLiveness =
  | 'idle'
  | 'waiting_for_lead'
  | 'active_review'
  | 'retry_scheduled'
  | 'needs_attention'

export type GraphSupervisionItemV1 = {
  obligationId: string
  pendingAction: GraphSupervisionObligationKind
  nodeIds: string[]
  liveness: Exclude<GraphSupervisionLiveness, 'idle'>
  retryCount: number
  noProgressCount: number
  nextWakeAt?: string
  lastWakeAt?: string
  lastError?: string
  attentionReason?: string
  canWake: boolean
}

export type GraphSupervisionProjectionV1 = {
  version: 1
  runId: string
  lastEventSeq: number
  leadActive: boolean
  liveness: GraphSupervisionLiveness
  pendingActions: GraphSupervisionItemV1[]
  peerReviewLeases: Array<{
    nodeId: string
    attemptId: string
    leaseUntil: string
  }>
  canWake: boolean
  updatedAt: string
}

const MAX_PUBLIC_OBLIGATIONS = 64
const MAX_PUBLIC_NODE_IDS = 32

export function graphSupervisionProjection(
  run: GraphRunV1,
  options: {
    leadActive: boolean
    nowMs?: number
    peerReviewLeases?: Array<{ nodeId: string; attemptId: string; leaseUntil: string }>
  }
): GraphSupervisionProjectionV1 {
  const nowMs = options.nowMs ?? Date.now()
  const terminal = isTerminal(run.status)
  const peerReviewLeases = terminal
    ? []
    : (options.peerReviewLeases ?? [])
        .filter((lease) => isFuture(lease.leaseUntil, nowMs))
        .slice(0, MAX_PUBLIC_OBLIGATIONS)
  const pendingActions = run.supervisionObligations
    .filter((obligation) => obligation.state !== 'resolved')
    .map((obligation) => projectObligation(obligation, options.leadActive, terminal, nowMs))
    .sort((left, right) =>
      livenessPriority(right.liveness) - livenessPriority(left.liveness) ||
      (right.lastWakeAt ?? '').localeCompare(left.lastWakeAt ?? '') ||
      left.obligationId.localeCompare(right.obligationId))
    .slice(0, MAX_PUBLIC_OBLIGATIONS)
  const liveness = pendingActions.some((item) => item.liveness === 'needs_attention')
    ? 'needs_attention'
    : peerReviewLeases.length > 0 || pendingActions.some((item) => item.liveness === 'active_review')
      ? 'active_review'
      : pendingActions.some((item) => item.liveness === 'retry_scheduled')
        ? 'retry_scheduled'
        : pendingActions.length
          ? 'waiting_for_lead'
          : 'idle'

  return {
    version: 1,
    runId: run.id,
    lastEventSeq: run.lastEventSeq,
    leadActive: options.leadActive,
    liveness,
    pendingActions,
    peerReviewLeases,
    canWake: pendingActions.some((item) => item.canWake),
    updatedAt: run.updatedAt
  }
}

function projectObligation(
  obligation: GraphSupervisionObligationV1,
  leadActive: boolean,
  terminal: boolean,
  nowMs: number
): GraphSupervisionItemV1 {
  const activeLease = obligation.state === 'delivering' && isFuture(obligation.leaseUntil, nowMs)
  const activeReview = activeLease || (
    obligation.state === 'awaiting_action' && leadActive
  )
  const liveness: GraphSupervisionItemV1['liveness'] =
    obligation.state === 'needs_attention'
      ? 'needs_attention'
      : activeReview
        ? 'active_review'
        : obligation.state === 'retry_scheduled' && isFuture(obligation.nextWakeAt, nowMs)
          ? 'retry_scheduled'
          : 'waiting_for_lead'
  return {
    obligationId: obligation.id,
    pendingAction: obligation.kind,
    nodeIds: obligation.nodeIds.slice(0, MAX_PUBLIC_NODE_IDS),
    liveness,
    retryCount: Math.max(0, obligation.deliveryAttempts - 1),
    noProgressCount: obligation.noProgressCount,
    ...(obligation.nextWakeAt ? { nextWakeAt: obligation.nextWakeAt } : {}),
    ...(obligation.lastDeliveredAt ? { lastWakeAt: obligation.lastDeliveredAt } : {}),
    ...(obligation.lastError
      ? { lastError: publicDiagnostic(obligation.lastError, 'delivery') }
      : {}),
    ...(obligation.attentionReason
      ? { attentionReason: publicDiagnostic(obligation.attentionReason, 'attention') }
      : {}),
    canWake: !terminal && !activeReview
  }
}

function publicDiagnostic(value: string, kind: 'delivery' | 'attention'): string {
  if (/no durable progress|without resolving|required action/i.test(value)) {
    return 'The source Lead made no durable progress after repeated wake attempts.'
  }
  if (/orphan|missing|not found|unavailable source|terminal source/i.test(value)) {
    return 'The original source Lead is unavailable and needs user attention.'
  }
  if (/timed? out|timeout/i.test(value)) {
    return 'The source Lead wake timed out.'
  }
  if (/capacity|queue|active turn|accepting steering|temporarily unavailable/i.test(value)) {
    return 'The source Lead is temporarily unavailable; retry remains scheduled.'
  }
  return kind === 'attention'
    ? 'The Graph run needs user attention before supervision can continue.'
    : 'The source Lead wake failed; automatic retry remains scheduled.'
}

function isFuture(value: string | undefined, nowMs: number): boolean {
  if (!value) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs
}

function isTerminal(status: GraphRunV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function livenessPriority(liveness: GraphSupervisionItemV1['liveness']): number {
  switch (liveness) {
    case 'needs_attention': return 4
    case 'active_review': return 3
    case 'retry_scheduled': return 2
    case 'waiting_for_lead': return 1
  }
}
