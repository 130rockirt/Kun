import { createHash } from 'node:crypto'
import type { GraphReviewResultV1 } from '../contracts/graph.js'

/**
 * Review commands occupy one semantic slot per attempt and reviewer kind.
 * Hashing keeps the durable key within the Graph idempotency-key limit even
 * when both user-supplied run and attempt ids are at their maximum length.
 */
export function graphReviewSemanticKey(
  runId: string,
  attemptId: string,
  reviewerKind: GraphReviewResultV1['reviewerKind']
): string {
  const digest = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(attemptId)
    .update('\0')
    .update(reviewerKind)
    .digest('hex')
  return `graph-review:${reviewerKind}:${digest}`
}
