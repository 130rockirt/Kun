import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphReviewResultV1, GraphRunV1 } from '../contracts/graph.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { GraphSupervisionPort } from './graph-scheduler-types.js'
import { GraphRunConflictError } from './graph-run-store.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  testCompletedChild,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import {
  cleanupSchedulerHarnesses,
  schedulerHarness,
  waitFor
} from '../../tests/graph-scheduler-test-harness.js'

const supervisors: GraphSupervisor[] = []
const supervisionLivenessTimeoutMs = 60_000
const leadReviewConflictTimeoutMs = 5_000

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  await cleanupSchedulerHarnesses()
})

describe('Graph scheduler supervision liveness', () => {
  it('keeps a submitted result reviewable when its supervision notification conflicts', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    let submittedSignals = 0
    const supervision: GraphSupervisionPort = {
      signal: async (input) => {
        if (input.reason === 'submitted' && ++submittedSignals === 1) {
          throw new GraphRunConflictError('simulated concurrent supervision append')
        }
      }
    }
    const harness = await schedulerHarness(
      plan,
      () => completedWorker(() => 1),
      {},
      { autoLeadReview: false, supervision: () => supervision }
    )

    harness.scheduler.start()
    const reviewing = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.nodes.research.status === 'reviewing' ? run : null
    })
    const attempt = reviewing.nodes.research.attempts.at(-1)!
    await recordLeadPass(harness, reviewing.id, ['research'])
    await harness.scheduler.resumeRun(reviewing.id)

    const completed = await waitFor(async () => {
      const run = await harness.store.get(reviewing.id)
      return run?.status === 'completed' ? run : null
    })
    const lease = (await harness.writes.list()).leases.find((entry) =>
      entry.attemptId === attempt.id)
    expect(submittedSignals).toBeGreaterThanOrEqual(1)
    expect(completed.nodes.research.status).toBe('accepted')
    expect(lease).toMatchObject({ state: 'released', releaseDisposition: 'accepted' })
    await harness.scheduler.stop()
  })

  it('redelivers two parked prose-only Lead episodes in-process before review completes the run', async () => {
    let nowMs = Date.now()
    let workerStarts = 0
    let leadEpisodes = 0
    const delegation = completedWorker(() => ++workerStarts)
    let runtimeSupervisor!: GraphSupervisor
    const harness = await schedulerHarness(
      testGraphPlan({ autoStart: true }),
      () => delegation,
      {},
      { autoLeadReview: false, supervision: () => runtimeSupervisor }
    )
    runtimeSupervisor = new GraphSupervisor({
      store: harness.store,
      config: () => testGraphConfig({
        supervision: { requireFinalReview: false, coalesceWindowMs: 0 }
      }),
      delegation: () => delegation,
      nowMs: () => nowMs,
      nowIso: () => new Date(nowMs).toISOString(),
      leadTurn: async ({ run, reasons, nodeIds }) => {
        if (reasons.includes('submitted')) {
          leadEpisodes += 1
          // The first two bounded Lead episodes model prose-only responses:
          // the source turn parks without recording the required review.
          if (leadEpisodes >= 3) await recordLeadPass(harness, run.id, nodeIds)
        }
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: false,
          parkedWithPendingSupervision: true
        }
      }
    })
    supervisors.push(runtimeSupervisor)
    harness.scheduler.start()

    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const obligation = run?.supervisionObligations.find((entry) =>
        entry.kind === 'review_required' && entry.state === 'pending')
      return obligation ? run : null
    })
    await runtimeSupervisor.sweepObligations()
    await runtimeSupervisor.flush('run_harness')
    await harness.scheduler.resumeRun('run_harness')
    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const obligation = run?.supervisionObligations.find((entry) =>
        entry.kind === 'review_required' && entry.state === 'retry_scheduled')
      return leadEpisodes === 1 && obligation?.noProgressCount === 1 ? run : null
    })
    nowMs += 2_000
    await runtimeSupervisor.sweepObligations()
    await runtimeSupervisor.flush('run_harness')
    await harness.scheduler.resumeRun('run_harness')
    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const obligation = run?.supervisionObligations.find((entry) =>
        entry.kind === 'review_required' && entry.state === 'retry_scheduled')
      return leadEpisodes === 2 && obligation?.noProgressCount === 2 ? run : null
    })
    nowMs += 5_000
    await runtimeSupervisor.sweepObligations()
    await runtimeSupervisor.flush('run_harness')
    await harness.scheduler.resumeRun('run_harness')
    await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      const finish = run?.nodes.finish
      const attempt = finish?.attempts.at(-1)
      const obligation = attempt
        ? run?.supervisionObligations.find((entry) =>
            entry.kind === 'review_required' &&
            entry.attemptIds.includes(attempt.id) &&
            entry.state === 'pending')
        : undefined
      return finish?.status === 'reviewing' && obligation ? run : null
    })
    await runtimeSupervisor.sweepObligations()
    await runtimeSupervisor.flush('run_harness')
    await harness.scheduler.resumeRun('run_harness')
    let completed: GraphRunV1
    try {
      completed = await waitFor(async () => {
        const run = await harness.store.get('run_harness')
        return run?.status === 'completed' ? run : null
      })
    } catch (error) {
      const run = await harness.store.get('run_harness')
      const writeState = await harness.writes.list()
      const events = await harness.store.events('run_harness')
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
          leadEpisodes,
          workerStarts,
          status: run?.status,
          nodes: run
            ? Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [
                id,
                {
                  status: node.status,
                  attempts: node.attempts.map((attempt) => attempt.status)
                }
              ]))
            : {},
          obligations: run?.supervisionObligations.map((obligation) => ({
            kind: obligation.kind,
            state: obligation.state,
            noProgressCount: obligation.noProgressCount,
            attemptIds: obligation.attemptIds,
            digest: obligation.digest
          })),
          leases: writeState.leases.map((lease) => ({
            leaseId: lease.leaseId,
            attemptId: lease.attemptId,
            state: lease.state,
            releaseDisposition: lease.releaseDisposition
          })),
          events: events.slice(-20).map((event) => ({
            seq: event.graphSeq,
            type: event.event.type,
            payload: event.event.payload
          }))
        })}`
      )
    }
    expect(leadEpisodes).toBeGreaterThanOrEqual(4)
    expect(workerStarts).toBe(2)
    expect(completed.nodes.research.status).toBe('accepted')
    expect(completed.nodes.finish.status).toBe('accepted')
    expect(completed.supervisionObligations.filter((entry) =>
      entry.kind === 'review_required')).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'resolved', noProgressCount: 2 })
    ]))
    await harness.scheduler.stop()
    await runtimeSupervisor.stop()
  }, supervisionLivenessTimeoutMs)

  it('continues an independent ready branch while another result awaits Lead review', async () => {
    const base = testGraphPlan()
    const plan = testGraphPlan({
      edges: [],
      completionNodeIds: ['finish'],
      autoStart: true,
      budget: {
        ...base.budget,
        maxConcurrentNodes: 1
      }
    })
    let workerStarts = 0
    const delegation = completedWorker(() => ++workerStarts)
    const signals: Parameters<GraphSupervisionPort['signal']>[0][] = []
    const supervision: GraphSupervisionPort = {
      signal: async (input) => { signals.push(input) }
    }
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      {
        scheduler: {
          maxConcurrentNodes: 1,
          maxConcurrentNodesPerRun: 1
        },
        supervision: { requireFinalReview: false }
      },
      { autoLeadReview: false, supervision: () => supervision }
    )

    harness.scheduler.start()
    const waiting = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'awaiting_supervision' &&
        run.nodes.research.status === 'reviewing' &&
        ['submitted', 'reviewing'].includes(run.nodes.finish.status)
        ? run
        : null
    })

    expect(workerStarts).toBe(2)
    expect(waiting.nodes.research.status).toBe('reviewing')
    expect(['submitted', 'reviewing']).toContain(waiting.nodes.finish.status)
    expect(waiting.reviews.some((review) => review.reviewerKind === 'lead')).toBe(false)
    expect(signals.filter((signal) => signal.reason === 'submitted')).not.toHaveLength(0)
    await harness.scheduler.stop()
  })

  it('isolates a synthesis failure, persists scheduler attention, and completes a healthy run', async () => {
    const source = testGraphPlan().nodes[0]!
    const plan = testGraphPlan({
      nodes: [source],
      edges: [],
      completionNodeIds: [source.id],
      autoStart: true
    })
    let childSequence = 0
    const delegation = completedWorker(() => ++childSequence)
    let port: GraphSupervisionPort | undefined
    const harness = await schedulerHarness(
      plan,
      () => delegation,
      {
        scheduler: { maxConcurrentRuns: 2 },
        supervision: { requireFinalReview: false, coalesceWindowMs: 60_000 }
      },
      { autoLeadReview: false, supervision: () => port }
    )
    await harness.control.create({
      runId: 'run_healthy',
      threadId: 'thread_healthy',
      projectId: harness.identity.projectId,
      sourceTurnId: 'turn_healthy',
      plan: testGraphPlan({ ...plan, workspaceRoot: harness.workspace }),
      commandId: 'create_healthy_liveness',
      idempotencyKey: 'create-healthy-liveness',
      start: true
    })

    const runtimeSupervisor = new GraphSupervisor({
      store: harness.store,
      config: () => testGraphConfig({
        supervision: { requireFinalReview: false, coalesceWindowMs: 60_000 }
      }),
      delegation: () => delegation,
      leadTurn: async ({ run, reasons, nodeIds }) => {
        if (reasons.includes('submitted')) {
          await recordLeadPass(harness, run.id, nodeIds)
        }
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: reasons.includes('submitted')
        }
      }
    })
    supervisors.push(runtimeSupervisor)
    const failedSynthesis = vi.fn(async (run: GraphRunV1) => {
      if (run.id === 'run_harness') throw new Error('deterministic synthesis fixture failure')
      return runtimeSupervisor.synthesize(run)
    })
    port = {
      signal: async (input) => {
        await runtimeSupervisor.signal(input)
        // Delivery may synchronously record a review and wake the scheduler.
        // Do not make that scheduler tick wait on another same-run Lead flush.
        void runtimeSupervisor.flush(input.runId)
      },
      review: (input) => runtimeSupervisor.review(input),
      synthesize: failedSynthesis
    }

    harness.scheduler.start()
    let healthy: GraphRunV1
    try {
      healthy = await waitFor(async () => {
        const run = await harness.store.get('run_healthy')
        return run?.status === 'completed' ? run : null
      }, 5_000)
    } catch (error) {
      const runs = await harness.store.list()
      const writeState = await harness.writes.list()
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(
          {
            runs: runs.map((run) => ({
              id: run.id,
              status: run.status,
              nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [
                id,
                {
                  status: node.status,
                  attempts: node.attempts.map((attempt) => ({
                    id: attempt.id,
                    status: attempt.status
                  }))
                }
              ])),
              obligations: run.supervisionObligations.map((obligation) => ({
                kind: obligation.kind,
                state: obligation.state
              }))
            })),
            leases: writeState.leases.map((lease) => ({
              id: lease.leaseId,
              runId: lease.runId,
              attemptId: lease.attemptId,
              state: lease.state
            }))
          }
        )}`
      )
    }
    const failed = await waitFor(async () => {
      const run = await harness.store.get('run_harness')
      return run?.status === 'awaiting_supervision' &&
        run.supervisionObligations.some((obligation) =>
          obligation.kind === 'scheduler_error' && obligation.state !== 'resolved')
        ? run
        : null
    }, 5_000)

    expect(healthy.summary).toBeDefined()
    expect(failed.summary).toBeUndefined()
    expect(failedSynthesis).toHaveBeenCalledWith(expect.objectContaining({ id: 'run_harness' }))
    expect((await harness.store.events(failed.id)).some((envelope) =>
      envelope.event.type === 'supervision_requested' &&
      envelope.event.payload.reason === 'scheduler_error')).toBe(true)

    await harness.scheduler.stop()
    await runtimeSupervisor.stop()
  }, 10_000)
})

function completedWorker(next: () => number): DelegationRuntime {
  return {
    enabled: () => true,
    runChild: async (input) => {
      const childId = `supervision_liveness_worker_${next()}`
      await input.onQueued?.(childId)
      await input.onRunning?.(childId)
      return {
        ...testCompletedChild(childId, 'Completed independent Graph work.'),
        parentThreadId: input.parentThreadId,
        parentTurnId: input.parentTurnId
      }
    }
  } as DelegationRuntime
}

async function recordLeadPass(
  harness: Awaited<ReturnType<typeof schedulerHarness>>,
  runId: string,
  nodeIds: readonly string[]
): Promise<void> {
  for (const nodeId of nodeIds) {
    const conflictDeadline = Date.now() + leadReviewConflictTimeoutMs
    while (true) {
      const run = await harness.store.get(runId)
      const node = run?.nodes[nodeId]
      const attempt = node?.attempts.at(-1)
      if (!run || !node || !attempt?.result || !attempt.validation) break
      if (run.reviews.some((entry) =>
        entry.attemptId === attempt.id && entry.reviewerKind === 'lead')) break
      const review: GraphReviewResultV1 = {
        version: 1,
        reviewId: `lead_${run.id}_${attempt.id}`,
        nodeId,
        attemptId: attempt.id,
        reviewerKind: 'lead',
        outcome: 'pass',
        summary: 'Source Lead accepted the host-validated result.',
        evidence: [],
        artifactRefs: [],
        createdAt: new Date().toISOString()
      }
      try {
        await harness.control.recordReview(run.id, review, {
          commandId: `lead_command_${run.id}_${attempt.id}`,
          idempotencyKey: `lead-review:${run.id}:${attempt.id}`
        }, 'lead')
        break
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || Date.now() >= conflictDeadline) throw error
        // Let the scheduler's in-flight durable write settle before reading the
        // latest attempt/review projection and retrying the idempotent command.
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }
}
