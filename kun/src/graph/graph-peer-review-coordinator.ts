import {
  GRAPH_CONTRACT_VERSION,
  GraphReviewResultV1Schema,
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphReviewResultV1,
  type GraphRunV1
} from '../contracts/graph.js'
import { GraphRunConflictError } from './graph-run-store.js'
import { errorMessage, isTerminalRunStatus } from './graph-scheduler-policy.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'
import { GraphPeerReviewShutdownError, graphPeerReviewTimeoutMs } from './graph-peer-review-task.js'
import { graphReviewSemanticKey } from './graph-review-idempotency.js'
import type { GraphRunStore } from './graph-run-store.js'

type ActivePeerReview = { runId: string; controller: AbortController; promise: Promise<void> }

export class GraphPeerReviewCoordinator {
  private readonly active = new Map<string, ActivePeerReview>()

  constructor(private readonly options: {
    store: GraphRunStore
    nextId: (prefix: string) => string
    nowIso: () => string
    isStopping: () => boolean
    onResume: (runId: string) => Promise<void>
    withRunQueue: <T>(runId: string, operation: () => Promise<T>) => Promise<T>
    requireRun: (runId: string) => Promise<GraphRunV1>
  }) {}

  hasActiveForRun(runId: string): boolean {
    return [...this.active.values()].some((review) => review.runId === runId)
  }

  abortAll(): void {
    for (const review of this.active.values()) review.controller.abort(new GraphPeerReviewShutdownError())
  }

  pending(): Promise<void>[] {
    return [...this.active.values()].map((review) => review.promise)
  }

  launch(
    run: GraphRunV1,
    node: GraphNodeProjectionV1,
    attempt: GraphNodeAttemptV1,
    supervision: GraphSupervisionPort | undefined
  ): void {
    const taskKey = graphReviewSemanticKey(run.id, attempt.id, 'peer')
    if (this.options.isStopping() || this.active.has(taskKey)) return
    const controller = new AbortController()
    const operation = this.execute(run, node, attempt, supervision, controller).catch((error) => {
      console.warn(`[kun] Graph peer review task failed for ${run.id}/${attempt.id}: ${errorMessage(error)}`)
    })
    let tracked!: Promise<void>
    tracked = operation.finally(() => {
      if (this.active.get(taskKey)?.promise === tracked) this.active.delete(taskKey)
      if (!this.options.isStopping()) void this.options.onResume(run.id)
    })
    this.active.set(taskKey, { runId: run.id, controller, promise: tracked })
  }

  private async execute(
    run: GraphRunV1,
    node: GraphNodeProjectionV1,
    attempt: GraphNodeAttemptV1,
    supervision: GraphSupervisionPort | undefined,
    controller: AbortController
  ): Promise<void> {
    let review: GraphReviewResultV1
    try {
      if (!supervision?.review) throw new Error('Independent peer reviewer runtime is unavailable.')
      const rawReview = await abortablePeerReview(
        Promise.resolve().then(() => supervision.review!({
          run, node, attempt, kind: 'peer', signal: controller.signal
        })),
        controller,
        graphPeerReviewTimeoutMs(run, attempt)
      )
      review = GraphReviewResultV1Schema.parse(rawReview)
      if (review.nodeId !== node.node.id || review.attemptId !== attempt.id || review.reviewerKind !== 'peer') {
        throw new Error('Independent peer reviewer returned mismatched review provenance.')
      }
    } catch (error) {
      if (this.options.isStopping() || error instanceof GraphPeerReviewShutdownError) return
      review = GraphReviewResultV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        reviewId: this.options.nextId('graph_review'),
        nodeId: node.node.id,
        attemptId: attempt.id,
        reviewerKind: 'peer',
        outcome: 'needs_human',
        summary: `Independent peer review could not complete: ${errorMessage(error)}`.slice(0, 4_096),
        evidence: [], artifactRefs: [], createdAt: this.options.nowIso()
      })
    }
    if (!this.options.isStopping()) await this.persist(run.id, review)
  }

  private async persist(runId: string, review: GraphReviewResultV1): Promise<void> {
    for (let retry = 0; retry < 5; retry += 1) {
      try {
        await this.options.withRunQueue(runId, async () => {
          const run = await this.options.requireRun(runId)
          if (run.reviews.some((entry) => entry.nodeId === review.nodeId && entry.attemptId === review.attemptId && entry.reviewerKind === 'peer')) return
          const node = run.nodes[review.nodeId]
          const attempt = node?.attempts.find((entry) => entry.id === review.attemptId)
          if (!node || !attempt || node.attempts.at(-1)?.id !== attempt.id || isTerminalRunStatus(run.status) || !['submitted', 'reviewing'].includes(node.status) || !['submitted', 'reviewing'].includes(attempt.status)) return
          await this.options.store.append(run.id, {
            expectedSeq: run.lastEventSeq,
            graphRevision: run.currentRevision,
            commandId: `review_${review.reviewId}`,
            idempotencyKey: graphReviewSemanticKey(run.id, attempt.id, 'peer'),
            event: { type: 'review_recorded', payload: { review } }
          })
        })
        return
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || retry === 4) throw error
      }
    }
  }
}

function abortablePeerReview<T>(operation: Promise<T>, controller: AbortController, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => finish(() => reject(
      controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Graph peer review was aborted')
    ))
    const timeout = setTimeout(() => controller.abort(new Error('Graph peer review timed out')), Math.max(1, timeoutMs))
    timeout.unref?.()
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) return onAbort()
    operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
  })
}
