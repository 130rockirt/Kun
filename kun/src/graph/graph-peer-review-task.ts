import type {
  GraphNodeAttemptV1,
  GraphRunV1
} from '../contracts/graph.js'

export const MAX_GRAPH_PEER_REVIEW_TIMEOUT_MS = 5 * 60 * 1_000

export class GraphPeerReviewShutdownError extends Error {
  constructor() {
    super('Graph runtime is shutting down')
    this.name = 'GraphPeerReviewShutdownError'
  }
}

/**
 * A peer review consumes the same bounded run/node time budget as the work it
 * verifies. Durable elapsed values keep the timeout aligned with the latest
 * reconciled accounting for both enclosing budgets.
 */
export function graphPeerReviewTimeoutMs(
  run: GraphRunV1,
  attempt: GraphNodeAttemptV1
): number {
  const runRemaining = run.budget.limits.maxWallTimeMs - run.budget.elapsedMs
  const nodeRemaining = attempt.assignment.maxWallTimeMs - attempt.elapsedMs
  return Math.max(1, Math.min(
    MAX_GRAPH_PEER_REVIEW_TIMEOUT_MS,
    runRemaining,
    nodeRemaining
  ))
}
