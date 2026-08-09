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
  let nowMs = Date.parse('2026-07-31T00:00:00.000Z')
  const nowIso = () => new Date(nowMs).toISOString()
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
  return { config, nextId, nowIso, advance: (delayMs: number) => { nowMs += delayMs }, store }
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
  it('caps eight consecutive delivery failures and lets a manual wake recover', async () => {
    const value = await harness()
    let run = await runningRun(value)
    run = await append(value, {
      type: 'run_status_changed',
      payload: {
        from: 'running',
        to: 'awaiting_supervision',
        reason: 'test scheduler failure'
      }
    }, 'awaiting-supervision-for-delivery-cap')
    let failDelivery = true
    const leadTurn = vi.fn(async ({ run: current }: { run: GraphRunV1 }) => {
      if (failDelivery) throw new Error('persistent source Lead HTTP 500')
      return {
        status: 'delivered' as const,
        sourceTurnId: current.sourceTurnId,
        deliveredSeq: current.lastEventSeq,
        executionActive: true
      }
    })
    const supervisor = supervisorFor(value, {
      leadTurn,
      isLeadTurnActive: () => true
    })
    const retryDelays = [2_000, 5_000, 15_000, 60_000, 60_000, 60_000, 60_000]

    await supervisor.signal({
      runId: run.id,
      reason: 'scheduler_error',
      nodeIds: [],
      digest: 'Scheduler could not resume the source Lead.'
    })
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      if (attempt > 1) {
        value.advance(retryDelays[attempt - 2]!)
        await supervisor.sweepObligations()
      }
      await supervisor.flush(run.id)
      run = (await value.store.get(run.id))!
      const current = obligation(run)
      expect(current.deliveryAttempts).toBe(attempt)
      expect(current.consecutiveDeliveryFailures).toBe(attempt)
      if (attempt < 8) expect(current.state).toBe('retry_scheduled')
    }

    let current = obligation(run)
    expect(run.status).toBe('awaiting_human')
    expect(current).toMatchObject({
      state: 'needs_attention',
      consecutiveDeliveryFailures: 8,
      lastError: 'persistent source Lead HTTP 500'
    })
    expect(current.nextWakeAt).toBeUndefined()
    expect(current.deliveryLeaseId).toBeUndefined()
    const cappedSeq = run.lastEventSeq
    await supervisor.sweepObligations()
    expect((await value.store.get(run.id))!.lastEventSeq).toBe(cappedSeq)

    failDelivery = false
    run = (await supervisor.wake(
      run.id,
      current.id,
      'manual-retry-after-delivery-cap'
    ))!
    current = obligation(run)
    expect(run.status).toBe('awaiting_supervision')
    expect(current).toMatchObject({
      state: 'pending',
      deliveryAttempts: 8,
      consecutiveDeliveryFailures: 0
    })
    expect(current.lastError).toBeUndefined()
    expect(current.attentionReason).toBeUndefined()

    await supervisor.flush(run.id)
    run = (await value.store.get(run.id))!
    expect(run.status).toBe('awaiting_supervision')
    expect(obligation(run)).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 9,
      consecutiveDeliveryFailures: 0
    })
    expect(leadTurn).toHaveBeenCalledTimes(9)
    await supervisor.stop()
  })

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

  it('fails closed for a targeted wake when another attention obligation remains', async () => {
    const value = await harness()
    await runningRun(value)
    let orphaned = true
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => orphaned
      ? {
          status: 'orphaned' as const,
          reason: 'Source Lead owner is temporarily unavailable.'
        }
      : {
          status: 'delivered' as const,
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        })
    const supervisor = supervisorFor(value, {
      leadTurn,
      isLeadTurnActive: () => true
    })

    await supervisor.signal({
      runId: 'run_manual_wake',
      reason: 'help',
      nodeIds: [],
      digest: 'First independent attention obligation.'
    })
    await supervisor.signal({
      runId: 'run_manual_wake',
      reason: 'help',
      nodeIds: [],
      digest: 'Second independent attention obligation.'
    })
    await supervisor.flush('run_manual_wake')
    let run = (await value.store.get('run_manual_wake'))!
    expect(run.supervisionObligations).toHaveLength(2)
    const [first] = run.supervisionObligations
    expect(run.status).toBe('awaiting_human')
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'needs_attention')).toBe(true)
    const attentionSeq = run.lastEventSeq

    run = (await supervisor.wake(
      run.id,
      first!.id,
      'targeted-wake-must-fail-closed'
    ))!
    expect(run.lastEventSeq).toBe(attentionSeq)
    expect(run.status).toBe('awaiting_human')
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'needs_attention')).toBe(true)

    orphaned = false
    run = (await supervisor.wake(
      run.id,
      undefined,
      'wake-all-attention-obligations'
    ))!
    expect(run.status).toBe('awaiting_supervision')
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'pending')).toBe(true)
    await supervisor.flush(run.id)

    run = (await value.store.get(run.id))!
    expect(run.status).toBe('awaiting_supervision')
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'awaiting_action')).toBe(true)
    expect(leadTurn).toHaveBeenCalledTimes(2)
    await supervisor.stop()
  })

  it('aborts a wake when concurrent attention arrives before the final check', async () => {
    const value = await harness()
    await runningRun(value)
    let orphaned = true
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => orphaned
      ? {
          status: 'orphaned' as const,
          reason: 'Source Lead owner is temporarily unavailable.'
        }
      : {
          status: 'delivered' as const,
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        })
    const supervisor = supervisorFor(value, {
      leadTurn,
      isLeadTurnActive: () => true
    })
    await supervisor.signal({
      runId: 'run_manual_wake',
      reason: 'help',
      nodeIds: [],
      digest: 'Original attention obligation.'
    })
    await supervisor.flush('run_manual_wake')
    let run = (await value.store.get('run_manual_wake'))!
    const original = obligation(run)
    expect(run.status).toBe('awaiting_human')
    expect(original.state).toBe('needs_attention')

    const concurrent = {
      ...original,
      id: 'graph_obligation_concurrent_attention',
      digest: 'Attention created concurrently with manual wake.',
      attentionReason: 'Concurrent supervision requires human attention.',
      createdAt: value.nowIso(),
      updatedAt: value.nowIso()
    }
    const originalAppend = value.store.append.bind(value.store)
    let injected = false
    const appendSpy = vi.spyOn(value.store, 'append').mockImplementation(
      async (runId, input) => {
        if (
          !injected &&
          input.event.type === 'supervision_obligation_updated' &&
          input.event.payload.obligation.id === original.id &&
          input.event.payload.obligation.state === 'pending'
        ) {
          injected = true
          const woken = await originalAppend(runId, input)
          await originalAppend(runId, {
            expectedSeq: woken.state.lastEventSeq,
            graphRevision: woken.state.currentRevision,
            commandId: 'command_concurrent_attention',
            idempotencyKey: 'manual-wake-test:concurrent-attention',
            timestamp: value.nowIso(),
            event: {
              type: 'supervision_attention_required',
              payload: { obligation: concurrent }
            }
          })
          return woken
        }
        return originalAppend(runId, input)
      }
    )

    run = (await supervisor.wake(
      run.id,
      original.id,
      'wake-racing-concurrent-attention'
    ))!
    appendSpy.mockRestore()
    expect(injected).toBe(true)
    expect(run.status).toBe('awaiting_human')
    expect(run.supervisionObligations).toHaveLength(2)
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'needs_attention')).toBe(true)
    expect(leadTurn).toHaveBeenCalledOnce()
    await supervisor.flush(run.id)
    expect(leadTurn).toHaveBeenCalledOnce()

    orphaned = false
    run = (await supervisor.wake(
      run.id,
      undefined,
      'wake-all-after-concurrent-attention'
    ))!
    expect(run.status).toBe('awaiting_supervision')
    const lateAttention = {
      ...concurrent,
      id: 'graph_obligation_late_attention',
      digest: 'Attention arrived after wake verification but before claim.',
      attentionReason: 'Late attention must fence the queued delivery.',
      createdAt: value.nowIso(),
      updatedAt: value.nowIso()
    }
    run = await append(value, {
      type: 'supervision_attention_required',
      payload: { obligation: lateAttention }
    }, 'late-attention-after-wake-verification')
    run = await append(value, {
      type: 'run_status_changed',
      payload: {
        from: 'awaiting_supervision',
        to: 'awaiting_human',
        reason: lateAttention.attentionReason
      }
    }, 'late-attention-human-fence')
    await supervisor.flush(run.id)
    run = (await value.store.get(run.id))!
    expect(leadTurn).toHaveBeenCalledOnce()
    expect(run.supervisionObligations.filter((entry) =>
      entry.id !== lateAttention.id).every((entry) =>
      entry.state === 'pending')).toBe(true)
    expect(run.supervisionObligations.find((entry) =>
      entry.id === lateAttention.id)?.state).toBe('needs_attention')

    run = (await supervisor.wake(
      run.id,
      undefined,
      'wake-all-after-late-attention'
    ))!
    await supervisor.flush(run.id)
    run = (await value.store.get(run.id))!
    expect(run.supervisionObligations.every((entry) =>
      entry.state === 'awaiting_action')).toBe(true)
    expect(leadTurn).toHaveBeenCalledTimes(2)
    await supervisor.stop()
  })
})
