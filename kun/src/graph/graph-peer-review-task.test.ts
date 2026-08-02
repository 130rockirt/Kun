import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GraphNodeAttemptV1,
  GraphReviewResultV1,
  GraphRunV1
} from '../contracts/graph.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'
import { replayGraphEvents } from './graph-reducer.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  testAssignmentSnapshot,
  testCompletedChild,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  cleanupSchedulerHarnesses,
  schedulerHarness,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

afterEach(cleanupSchedulerHarnesses)

describe('Graph peer review tasks', () => {
  it('bounds a real Supervisor review even when the child ignores abort', async () => {
    const run = replayGraphEvents([testGraphEnvelope(1, {
      type: 'run_created',
      payload: {
        plan: peerPlan(undefined, 100),
        projectId: 'project_1',
        sourceTurnId: 'turn_1'
      }
    })])
    run.budget.elapsedMs = 75
    const node = run.nodes.research!
    const attempt: GraphNodeAttemptV1 = {
      version: 1,
      id: 'attempt_hung_real_supervisor',
      runId: run.id,
      nodeId: node.node.id,
      revision: run.currentRevision,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_hung_real_supervisor',
      idempotencyKey: 'attempt_hung_real_supervisor',
      status: 'reviewing',
      assignment: {
        ...testAssignmentSnapshot(),
        maxWallTimeMs: 100
      },
      result: {
        version: 1,
        summary: 'Review this result.',
        artifactRefs: [],
        changedFiles: [],
        evidence: [],
        risks: [],
        suggestedMessages: []
      },
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      tokenUsage: 0,
      elapsedMs: 75
    }
    node.status = 'reviewing'
    node.attempts = [attempt]
    let childSignal: AbortSignal | undefined
    const runChild = vi.fn(async (input: { signal: AbortSignal }) => {
      childSignal = input.signal
      return new Promise<never>(() => undefined)
    })
    const supervisor = new GraphSupervisor({
      store: {} as never,
      config: () => testGraphConfig(),
      delegation: () => ({ enabled: () => true, runChild } as never)
    })

    const startedAt = Date.now()
    const review = await supervisor.review({ run, node, attempt, kind: 'peer' })

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(childSignal?.aborted).toBe(true)
    expect(review).toMatchObject({
      reviewerKind: 'peer',
      outcome: 'needs_human',
      summary: expect.stringContaining('timed out')
    })
    await supervisor.stop()
  })

  it('times out a hung reviewer without blocking another run or launching duplicates', async () => {
    const peerStarts = new Map<string, number>()
    let hungSignal: AbortSignal | undefined
    let childSequence = 0
    const delegation = workerDelegation(() => ++childSequence)
    let harness!: Awaited<ReturnType<typeof schedulerHarness>>
    const supervision: GraphSupervisionPort = {
      signal: async (input) => recordLeadPass(harness, input),
      review: async (input) => {
        peerStarts.set(input.run.id, (peerStarts.get(input.run.id) ?? 0) + 1)
        if (input.run.id === 'run_harness') {
          hungSignal = input.signal
          return new Promise<GraphReviewResultV1>(() => undefined)
        }
        return peerPass(input, `peer_${input.run.id}`)
      }
    }
    harness = await schedulerHarness(
      peerPlan(undefined, 500, 30_000),
      () => delegation,
      {},
      { autoLeadReview: false, supervision: () => supervision }
    )
    await harness.control.create({
      runId: 'run_healthy',
      threadId: 'thread_healthy',
      projectId: harness.identity.projectId,
      sourceTurnId: 'turn_healthy',
      plan: peerPlan(harness.workspace, 30_000),
      commandId: 'create_healthy',
      idempotencyKey: 'create_healthy',
      start: true
    })

    harness.scheduler.start()
    await waitFor(async () => peerStarts.get('run_harness') === 1 ? true : null)
    await Promise.all([
      harness.scheduler.tick(),
      harness.scheduler.tick(),
      harness.scheduler.tick()
    ])
    expect(peerStarts.get('run_harness')).toBe(1)

    let healthy: GraphRunV1
    try {
      healthy = await waitFor(async () => {
        const run = await harness.store.get('run_healthy')
        return run?.status === 'completed' ? run : null
      }, 10_000)
    } catch (error) {
      const runs = await harness.store.list()
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(
          runs.map((run) => ({
            id: run.id,
            status: run.status,
            nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [
              id,
              {
                status: node.status,
                attempts: node.attempts.map((attempt) => attempt.status)
              }
            ])),
            reviews: run.reviews.map((review) => ({
              reviewerKind: review.reviewerKind,
              outcome: review.outcome
            }))
          }))
        )}`
      )
    }
    expect(healthy.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewerKind: 'peer', outcome: 'pass' }),
      expect.objectContaining({ reviewerKind: 'lead', outcome: 'pass' })
    ]))

    let attention: GraphRunV1
    try {
      attention = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        return run?.status === 'awaiting_human' && run.reviews.some((review) =>
          review.reviewerKind === 'peer' && review.outcome === 'needs_human')
          ? run
          : null
      }, 10_000)
    } catch (error) {
      const run = await harness.store.get('run_harness')
      const events = await harness.store.events('run_harness', 0)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
          status: run?.status,
          peerStarts: peerStarts.get('run_harness'),
          hungSignalAborted: hungSignal?.aborted,
          node: run?.nodes.research && {
            status: run.nodes.research.status,
            attempts: run.nodes.research.attempts.map((attempt) => attempt.status)
          },
          reviews: run?.reviews.map((review) => ({
            reviewerKind: review.reviewerKind,
            outcome: review.outcome
          })),
          terminalEvents: events.filter((entry) =>
            entry.event.type === 'run_status_changed' &&
            ['failed', 'awaiting_human'].includes(entry.event.payload.to))
            .map((entry) => entry.event)
        })}`
      )
    }
    expect(hungSignal?.aborted).toBe(true)
    expect(peerStarts.get('run_harness')).toBe(1)
    expect(attention.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reviewerKind: 'peer',
        outcome: 'needs_human',
        summary: expect.stringContaining('timed out')
      })
    ]))
    expect(attention.status).toBe('awaiting_human')
    await harness.scheduler.stop()
  }, 20_000)

  it('recovers a durable reviewing attempt after scheduler restart', async () => {
    let mode: 'hang' | 'complete' = 'hang'
    let peerStarts = 0
    let childSequence = 0
    const delegation = workerDelegation(() => ++childSequence)
    let harness!: Awaited<ReturnType<typeof schedulerHarness>>
    const supervision: GraphSupervisionPort = {
      signal: async (input) => recordLeadPass(harness, input),
      review: async (input) => {
        peerStarts += 1
        if (mode === 'hang') return new Promise<GraphReviewResultV1>(() => undefined)
        return peerPass(input, `peer_restart_${peerStarts}`)
      }
    }
    harness = await schedulerHarness(
      peerPlan(undefined, 10_000),
      () => delegation,
      {},
      { autoLeadReview: false, supervision: () => supervision }
    )

    harness.scheduler.start()
    const reviewing = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.nodes.research.status === 'reviewing' && peerStarts === 1 ? run : null
    })
    expect(reviewing.reviews.some((review) => review.reviewerKind === 'peer')).toBe(false)

    await harness.scheduler.stop()
    const parked = await harness.store.get('run_harness')
    expect(parked?.nodes.research.status).toBe('reviewing')
    expect(parked?.reviews.some((review) => review.reviewerKind === 'peer')).toBe(false)

    mode = 'complete'
    harness.scheduler.start()
    const completed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'completed' ? run : null
    })
    expect(peerStarts).toBe(2)
    expect(completed.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewerKind: 'peer', outcome: 'pass' })
    ]))
    await harness.scheduler.stop()
  }, 10_000)
})

function peerPlan(
  workspaceRoot: string | undefined,
  nodeWallTimeMs: number,
  runWallTimeMs = nodeWallTimeMs
) {
  const base = testGraphPlan()
  const source = base.nodes[0]!
  return testGraphPlan({
    ...(workspaceRoot ? { workspaceRoot } : {}),
    nodes: [{
      ...source,
      completion: {
        ...source.completion,
        review: {
          kinds: ['peer'],
          requireAll: true,
          deterministicChecks: []
        }
      }
    }],
    edges: [],
    completionNodeIds: [source.id],
    budget: {
      ...base.budget,
      maxWallTimeMs: runWallTimeMs,
      maxNodeWallTimeMs: nodeWallTimeMs
    },
    autoStart: true
  })
}

function workerDelegation(next: () => number): DelegationRuntime {
  return {
    enabled: () => true,
    runChild: async (input) => {
      const childId = `peer_task_worker_${next()}`
      await input.onQueued?.(childId)
      await input.onRunning?.(childId)
      return {
        ...testCompletedChild(childId, 'Worker result ready for independent review.'),
        parentThreadId: input.parentThreadId,
        parentTurnId: input.parentTurnId
      }
    }
  } as DelegationRuntime
}

async function recordLeadPass(
  harness: Awaited<ReturnType<typeof schedulerHarness>>,
  input: Parameters<GraphSupervisionPort['signal']>[0]
): Promise<void> {
  if (input.reason !== 'submitted') return
  for (const nodeId of input.nodeIds) {
    const run = await harness.store.get(input.runId)
    const node = run?.nodes[nodeId]
    const attempt = node?.attempts.at(-1)
    if (
      !run ||
      !attempt?.result ||
      !attempt.validation ||
      run.reviews.some((review) =>
        review.attemptId === attempt.id && review.reviewerKind === 'lead')
    ) continue
    await harness.control.recordReview(run.id, {
      version: 1,
      reviewId: `lead_${run.id}_${attempt.attemptNumber}`,
      nodeId,
      attemptId: attempt.id,
      reviewerKind: 'lead',
      outcome: 'pass',
      summary: 'Source Lead accepted the independently reviewed result.',
      evidence: [],
      artifactRefs: [],
      createdAt: new Date().toISOString()
    }, {
      commandId: `lead_command_${run.id}_${attempt.attemptNumber}`,
      idempotencyKey: `lead-review:${run.id}:${attempt.id}`
    }, 'lead')
  }
}

function peerPass(
  input: Parameters<NonNullable<GraphSupervisionPort['review']>>[0],
  reviewId: string
): GraphReviewResultV1 {
  return {
    version: 1,
    reviewId,
    nodeId: input.node.node.id,
    attemptId: input.attempt.id,
    reviewerKind: 'peer',
    outcome: 'pass',
    summary: 'Independent peer reviewer accepted the result.',
    evidence: ['Peer review completed.'],
    artifactRefs: [],
    createdAt: new Date().toISOString()
  }
}
