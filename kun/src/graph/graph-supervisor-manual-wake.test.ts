import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema,
  type GraphDomainEventV1,
  type GraphRunV1
} from '../contracts/graph.js'
import { FileGraphRunStore } from './graph-run-store.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })))
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'kun-graph-manual-wake-'))
  roots.push(root)
  const config = testGraphConfig({ supervision: { coalesceWindowMs: 60_000 } })
  const nowIso = () => '2026-07-31T00:00:00.000Z'
  let next = 0
  const nextId = (prefix: string) => `${prefix}_${++next}`
  const store = new FileGraphRunStore({
    rootDir: join(root, 'graphs'),
    config: () => config,
    nowIso,
    nextId
  })
  await store.create({
    runId: 'run_manual_wake',
    threadId: 'thread_manual_wake',
    projectId: 'project_manual_wake',
    sourceTurnId: 'turn_manual_wake',
    plan: testGraphPlan(),
    commandId: 'command_create_manual_wake',
    idempotencyKey: 'create-manual-wake'
  })
  return { config, nextId, nowIso, store }
}

type Harness = Awaited<ReturnType<typeof harness>>

function supervisorFor(
  value: Harness,
  options: {
    leadTurn?: ConstructorParameters<typeof GraphSupervisor>[0]['leadTurn']
    isLeadTurnActive?: (run: GraphRunV1) => boolean
  } = {}
): GraphSupervisor {
  return new GraphSupervisor({
    store: value.store,
    config: () => value.config,
    delegation: () => undefined,
    leadTurn: options.leadTurn,
    isLeadTurnActive: options.isLeadTurnActive,
    nowIso: value.nowIso,
    nowMs: () => Date.parse(value.nowIso()),
    nextId: value.nextId
  })
}

async function append(
  value: Harness,
  event: GraphDomainEventV1,
  label: string
): Promise<GraphRunV1> {
  const run = (await value.store.get('run_manual_wake'))!
  return (await value.store.append(run.id, {
    expectedSeq: run.lastEventSeq,
    graphRevision: run.currentRevision,
    commandId: `command_${label}`,
    idempotencyKey: `manual-wake-test:${label}`,
    timestamp: value.nowIso(),
    event
  })).state
}

async function runningRun(value: Harness): Promise<GraphRunV1> {
  let run = (await value.store.get('run_manual_wake'))!
  for (const [index, transition] of [
    { from: 'draft' as const, to: 'validating' as const },
    { from: 'validating' as const, to: 'ready' as const },
    { from: 'ready' as const, to: 'running' as const }
  ].entries()) {
    run = await append(value, {
      type: 'run_status_changed',
      payload: transition
    }, `run-running-${index}`)
  }
  return run
}

async function reviewableRun(value: Harness): Promise<GraphRunV1> {
  let run = await runningRun(value)
  run = await append(value, {
    type: 'node_status_changed',
    payload: {
      nodeId: 'research',
      from: 'pending',
      to: 'ready',
      reason: 'test fixture'
    }
  }, 'node-ready')
  const attempt = GraphNodeAttemptV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    id: 'attempt_manual_review',
    runId: run.id,
    nodeId: 'research',
    revision: run.currentRevision,
    attemptNumber: 1,
    iteration: 0,
    commandId: 'command_attempt_manual_review',
    idempotencyKey: 'attempt-manual-review',
    status: 'queued',
    assignment: testAssignmentSnapshot(),
    queuedAt: value.nowIso(),
    tokenUsage: 0,
    elapsedMs: 0
  })
  const events: GraphDomainEventV1[] = [{
    type: 'attempt_created',
    payload: { attempt }
  }, {
    type: 'attempt_status_changed',
    payload: {
      nodeId: 'research',
      attemptId: attempt.id,
      from: 'queued',
      to: 'running'
    }
  }, {
    type: 'node_status_changed',
    payload: {
      nodeId: 'research',
      from: 'queued',
      to: 'running',
      reason: 'test fixture'
    }
  }, {
    type: 'result_submitted',
    payload: {
      nodeId: 'research',
      attemptId: attempt.id,
      result: {
        version: GRAPH_CONTRACT_VERSION,
        summary: 'Review this durable result.',
        artifactRefs: [],
        changedFiles: [],
        checks: [],
        evidence: ['durable evidence'],
        risks: [],
        suggestedMessages: []
      },
      validation: {
        version: GRAPH_CONTRACT_VERSION,
        valid: true,
        issues: [],
        normalizedNodeCount: 1,
        normalizedEdgeCount: 0
      },
      tokenUsage: 1,
      elapsedMs: 1
    }
  }, {
    type: 'attempt_status_changed',
    payload: {
      nodeId: 'research',
      attemptId: attempt.id,
      from: 'running',
      to: 'submitted'
    }
  }, {
    type: 'node_status_changed',
    payload: {
      nodeId: 'research',
      from: 'running',
      to: 'submitted',
      reason: 'await source Lead review'
    }
  }]
  for (const [index, event] of events.entries()) {
    run = await append(value, event, `reviewable-${index}`)
  }
  return run
}

function obligation(run: GraphRunV1) {
  expect(run.supervisionObligations).toHaveLength(1)
  return run.supervisionObligations[0]!
}

describe('GraphSupervisor manual wake', () => {
  it('deduplicates a repeated command without duplicating Lead delivery', async () => {
    const value = await harness()
    await runningRun(value)
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: true
    }))
    const supervisor = supervisorFor(value, {
      leadTurn,
      isLeadTurnActive: () => true
    })
    await supervisor.signal({
      runId: 'run_manual_wake',
      reason: 'help',
      nodeIds: [],
      digest: 'Source Lead action remains required.'
    })
    let run = (await value.store.get('run_manual_wake'))!
    const obligationId = obligation(run).id

    const first = await supervisor.wake(run.id, obligationId, 'manual-command-1')
    const duplicate = await supervisor.wake(run.id, obligationId, 'manual-command-1')
    expect(duplicate!.lastEventSeq).toBe(first!.lastEventSeq)
    expect((await value.store.events(run.id, 0)).filter((event) =>
      event.idempotencyKey === `manual-wake:manual-command-1:${obligationId}`
    )).toHaveLength(1)

    await supervisor.flush(run.id)
    run = (await value.store.get(run.id))!
    expect(obligation(run).state).toBe('awaiting_action')
    expect(leadTurn).toHaveBeenCalledOnce()
    await supervisor.stop()
  })

  it('does not redeliver when durable review resolution wins the race', async () => {
    const value = await harness()
    let run = await reviewableRun(value)
    const leadTurn = vi.fn(async () => {
      throw new Error('resolved review must never be delivered')
    })
    const supervisor = supervisorFor(value, { leadTurn })
    await supervisor.signal({
      runId: run.id,
      reason: 'submitted',
      nodeIds: ['research'],
      digest: 'Source Lead review is required.'
    })
    run = (await value.store.get(run.id))!
    const obligationId = obligation(run).id
    const attempt = run.nodes.research!.attempts.at(-1)!
    run = await append(value, {
      type: 'review_recorded',
      payload: {
        review: {
          version: GRAPH_CONTRACT_VERSION,
          reviewId: 'review_manual_wake_race',
          nodeId: 'research',
          attemptId: attempt.id,
          reviewerKind: 'lead',
          outcome: 'pass',
          summary: 'The source Lead accepted the durable result.',
          evidence: ['reviewed durable evidence'],
          artifactRefs: [],
          createdAt: value.nowIso()
        }
      }
    }, 'manual-wake-race-review')

    await supervisor.wake(run.id, obligationId, 'manual-race-command')
    await supervisor.flush(run.id)
    run = (await value.store.get(run.id))!
    expect(obligation(run).state).toBe('resolved')
    expect(leadTurn).not.toHaveBeenCalled()

    const resolvedSeq = run.lastEventSeq
    await supervisor.wake(run.id, obligationId, 'manual-race-command')
    expect((await value.store.get(run.id))!.lastEventSeq).toBe(resolvedSeq)
    await supervisor.stop()
  })

  it('does not interrupt or duplicate an active source Lead review lease', async () => {
    const value = await harness()
    await runningRun(value)
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: true
    }))
    const supervisor = supervisorFor(value, {
      leadTurn,
      isLeadTurnActive: () => true
    })
    await supervisor.signal({
      runId: 'run_manual_wake',
      reason: 'help',
      nodeIds: [],
      digest: 'Source Lead action remains required.'
    })
    await supervisor.flush('run_manual_wake')
    let run = (await value.store.get('run_manual_wake'))!
    const current = obligation(run)
    expect(current.state).toBe('awaiting_action')
    const activeSeq = run.lastEventSeq

    await supervisor.wake(run.id, current.id, 'manual-active-command')
    run = (await value.store.get(run.id))!
    expect(run.lastEventSeq).toBe(activeSeq)
    expect(obligation(run).state).toBe('awaiting_action')
    expect(leadTurn).toHaveBeenCalledOnce()
    await supervisor.stop()
  })
})
