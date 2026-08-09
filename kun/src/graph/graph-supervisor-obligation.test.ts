import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema,
  type GraphDomainEventV1,
  type GraphRunV1,
  type GraphSupervisionObligationV1
} from '../contracts/graph.js'
import { FileGraphRunStore, type GraphRunStore } from './graph-run-store.js'
import { checksumJson } from './graph-run-store-support.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
  graphSupervisionObligationForSignal,
  graphSupervisionObligationIsActionable
} from './graph-supervision-obligation.js'
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

type PersistentHarness = Awaited<ReturnType<typeof persistentHarness>>

async function persistentHarness() {
  const root = await mkdtemp(join(tmpdir(), 'kun-graph-supervision-obligation-'))
  roots.push(root)
  const config = testGraphConfig({
    supervision: { coalesceWindowMs: 60_000 }
  })
  let nowMs = Date.parse('2026-07-31T00:00:00.000Z')
  let next = 0
  const nextId = (prefix: string) => `${prefix}_${++next}`
  const nowIso = () => new Date(nowMs).toISOString()
  const storeOptions = {
    rootDir: join(root, 'graphs'),
    config: () => config,
    nowIso,
    nextId
  }
  const store = new FileGraphRunStore(storeOptions)
  await store.create({
    runId: 'run_obligation',
    threadId: 'thread_obligation',
    projectId: 'project_obligation',
    sourceTurnId: 'turn_obligation',
    plan: testGraphPlan(),
    commandId: 'command_create_obligation',
    idempotencyKey: 'create-obligation'
  })
  return {
    root,
    config,
    nextId,
    nowIso,
    nowMs: () => nowMs,
    advance: (delayMs: number) => { nowMs += delayMs },
    store,
    storeOptions
  }
}

function supervisorFor(
  harness: PersistentHarness,
  options: {
    leadTurn?: ConstructorParameters<typeof GraphSupervisor>[0]['leadTurn']
    isLeadTurnActive?: (run: GraphRunV1) => boolean
    store?: GraphRunStore
  } = {}
): GraphSupervisor {
  return new GraphSupervisor({
    store: options.store ?? harness.store,
    config: () => harness.config,
    delegation: () => undefined,
    leadTurn: options.leadTurn,
    isLeadTurnActive: options.isLeadTurnActive,
    nowIso: harness.nowIso,
    nowMs: harness.nowMs,
    nextId: harness.nextId
  })
}

async function appendEvent(
  harness: PersistentHarness,
  event: GraphDomainEventV1,
  label: string,
  store = harness.store
): Promise<GraphRunV1> {
  const run = await store.get('run_obligation')
  if (!run) throw new Error('missing test GraphRun')
  return (await store.append(run.id, {
    expectedSeq: run.lastEventSeq,
    graphRevision: run.currentRevision,
    commandId: `command_${label}`,
    idempotencyKey: `obligation-test:${label}`,
    timestamp: harness.nowIso(),
    event
  })).state
}

async function transitionRunToRunning(harness: PersistentHarness): Promise<GraphRunV1> {
  let run = (await harness.store.get('run_obligation'))!
  for (const [index, transition] of [
    { from: 'draft' as const, to: 'validating' as const },
    { from: 'validating' as const, to: 'ready' as const },
    { from: 'ready' as const, to: 'running' as const }
  ].entries()) {
    run = await appendEvent(harness, {
      type: 'run_status_changed',
      payload: transition
    }, `run-running-${index}`)
  }
  return run
}

async function submitReviewableAttempt(harness: PersistentHarness): Promise<GraphRunV1> {
  let run = await transitionRunToRunning(harness)
  run = await appendEvent(harness, {
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
    id: 'attempt_reviewable',
    runId: run.id,
    nodeId: 'research',
    revision: run.currentRevision,
    attemptNumber: 1,
    iteration: 0,
    commandId: 'command_attempt_reviewable',
    idempotencyKey: 'attempt-reviewable',
    status: 'queued',
    assignment: testAssignmentSnapshot(),
    queuedAt: harness.nowIso(),
    tokenUsage: 0,
    elapsedMs: 0
  })
  const events: Array<[string, GraphDomainEventV1]> = [
    ['attempt-created', { type: 'attempt_created', payload: { attempt } }],
    ['attempt-running', {
      type: 'attempt_status_changed',
      payload: {
        nodeId: 'research',
        attemptId: attempt.id,
        from: 'queued',
        to: 'running'
      }
    }],
    ['node-running', {
      type: 'node_status_changed',
      payload: {
        nodeId: 'research',
        from: 'queued',
        to: 'running',
        reason: 'test fixture'
      }
    }],
    ['result-submitted', {
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
    }],
    ['attempt-submitted', {
      type: 'attempt_status_changed',
      payload: {
        nodeId: 'research',
        attemptId: attempt.id,
        from: 'running',
        to: 'submitted'
      }
    }],
    ['node-submitted', {
      type: 'node_status_changed',
      payload: {
        nodeId: 'research',
        from: 'running',
        to: 'submitted',
        reason: 'await source Lead review'
      }
    }]
  ]
  for (const [label, event] of events) run = await appendEvent(harness, event, label)
  return run
}

function onlyObligation(run: GraphRunV1): GraphSupervisionObligationV1 {
  expect(run.supervisionObligations).toHaveLength(1)
  return run.supervisionObligations[0]!
}

async function durableEventTypes(store: FileGraphRunStore): Promise<string[]> {
  return (await store.events('run_obligation', 0)).map((event) => event.event.type)
}

function expectDurableLiveness(run: GraphRunV1, nowMs: number): void {
  for (const obligation of run.supervisionObligations) {
    if (!graphSupervisionObligationIsActionable(run, obligation)) continue
    if (run.status === 'awaiting_human') continue
    if (obligation.state === 'pending') continue
    if (obligation.state === 'delivering') {
      expect(Date.parse(obligation.leaseUntil ?? '')).toBeGreaterThan(nowMs)
      continue
    }
    if (obligation.state === 'awaiting_action' || obligation.state === 'retry_scheduled') {
      expect(Number.isFinite(Date.parse(obligation.nextWakeAt ?? ''))).toBe(true)
      continue
    }
    expect.fail(`actionable obligation ${obligation.id} has no durable continuation`)
  }
}

const HELP_SIGNAL = {
  runId: 'run_obligation',
  reason: 'help' as const,
  nodeIds: [] as string[],
  digest: 'Source Lead action remains required.'
}

describe('GraphSupervisor durable supervision obligations', () => {
  it('records delivery as awaiting_action without acknowledging semantic completion', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    let promptSnapshotSeq = -1
    const supervisor = supervisorFor(harness, {
      leadTurn: async ({ run }) => {
        promptSnapshotSeq = run.lastEventSeq
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        }
      },
      isLeadTurnActive: () => true
    })

    await supervisor.signal(HELP_SIGNAL)
    await supervisor.flush(HELP_SIGNAL.runId)

    const run = (await harness.store.get(HELP_SIGNAL.runId))!
    const obligation = onlyObligation(run)
    expect(obligation).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 1,
      lastDeliveredSeq: promptSnapshotSeq,
      noProgressCount: 0
    })
    expect(obligation.resolvedAt).toBeUndefined()
    expect(promptSnapshotSeq).toBeLessThan(run.lastEventSeq)
    expect(Date.parse(obligation.nextWakeAt!) - harness.nowMs()).toBe(2_000)
    expectDurableLiveness(run, harness.nowMs())
    expect(await durableEventTypes(harness.store)).toEqual(expect.arrayContaining([
      'supervision_obligation_opened',
      'supervision_delivery_started'
    ]))
    await supervisor.stop()
  })

  it('keeps a recorded delivery durable when steering acknowledgement fails', async () => {
    const harness = await persistentHarness()
    let run = await transitionRunToRunning(harness)
    run = await appendEvent(harness, {
      type: 'steering_recorded',
      payload: {
        steering: {
          version: GRAPH_CONTRACT_VERSION,
          steeringId: 'steering_ack_failure',
          runId: run.id,
          target: { kind: 'lead' },
          text: 'Inspect the durable supervision signal.',
          status: 'persisted',
          createdAt: harness.nowIso()
        }
      }
    }, 'steering-for-ack-failure')
    const originalAppend = harness.store.append.bind(harness.store)
    let failAcknowledgement = true
    vi.spyOn(harness.store, 'append').mockImplementation(async (runId, input) => {
      if (failAcknowledgement && input.event.type === 'steering_status_changed') {
        failAcknowledgement = false
        throw new Error('simulated steering acknowledgement failure')
      }
      return originalAppend(runId, input)
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const leadTurn = vi.fn(async ({ run: current }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: current.sourceTurnId,
      deliveredSeq: current.lastEventSeq,
      executionActive: true
    }))
    const supervisor = supervisorFor(harness, {
      leadTurn,
      isLeadTurnActive: () => false
    })

    try {
      await supervisor.signal(HELP_SIGNAL)
      await supervisor.flush(run.id)
      run = (await harness.store.get(run.id))!
      expect(onlyObligation(run)).toMatchObject({
        state: 'awaiting_action',
        deliveryAttempts: 1,
        consecutiveDeliveryFailures: 0
      })
      expect(run.steering.find((entry) =>
        entry.steeringId === 'steering_ack_failure')?.status).toBe('persisted')

      harness.advance(2_000)
      await supervisor.sweepObligations()
      harness.advance(2_000)
      await supervisor.sweepObligations()
      await supervisor.flush(run.id)
      run = (await harness.store.get(run.id))!
      expect(onlyObligation(run)).toMatchObject({
        state: 'awaiting_action',
        deliveryAttempts: 2,
        consecutiveDeliveryFailures: 0
      })
      expect(run.steering.find((entry) =>
        entry.steeringId === 'steering_ack_failure')?.status).toBe('handled')
      expect(leadTurn).toHaveBeenCalledTimes(2)
    } finally {
      warning.mockRestore()
      await supervisor.stop()
    }
  })

  it('persists bounded 2/5/15/60 second retries after Lead delivery I/O failures', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const leadTurn = vi.fn(async () => {
      throw new Error('EIO while resuming the source Lead')
    })
    const supervisor = supervisorFor(harness, { leadTurn })
    const expectedDelays = [2_000, 5_000, 15_000, 60_000]

    await supervisor.signal(HELP_SIGNAL)
    for (const [index, expectedDelay] of expectedDelays.entries()) {
      if (index > 0) await supervisor.sweepObligations()
      await supervisor.flush(HELP_SIGNAL.runId)
      const run = (await harness.store.get(HELP_SIGNAL.runId))!
      const obligation = onlyObligation(run)
      expect(obligation).toMatchObject({
        state: 'retry_scheduled',
        deliveryAttempts: index + 1,
        consecutiveDeliveryFailures: index + 1,
        lastError: 'EIO while resuming the source Lead'
      })
      expect(obligation.lastDeliveredSeq).toBeUndefined()
      expect(Date.parse(obligation.nextWakeAt!) - harness.nowMs()).toBe(expectedDelay)
      expectDurableLiveness(run, harness.nowMs())
      const reopened = new FileGraphRunStore(harness.storeOptions)
      expect(onlyObligation((await reopened.get(run.id))!).nextWakeAt)
        .toBe(obligation.nextWakeAt)
      harness.advance(expectedDelay)
    }
    expect(leadTurn).toHaveBeenCalledTimes(4)
    const eventTypes = await durableEventTypes(harness.store)
    expect(eventTypes.filter((type) => type === 'supervision_obligation_opened')).toHaveLength(1)
    expect(eventTypes.filter((type) => type === 'supervision_delivery_started')).toHaveLength(4)
    expect(eventTypes.filter((type) => type === 'supervision_retry_scheduled')).toHaveLength(4)
    await supervisor.stop()
  })

  it('caps eight consecutive delivery failures and lets a manual wake recover', async () => {
    const harness = await persistentHarness()
    let run = await transitionRunToRunning(harness)
    run = await appendEvent(harness, {
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
    const supervisor = supervisorFor(harness, {
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
        harness.advance(retryDelays[attempt - 2]!)
        await supervisor.sweepObligations()
      }
      await supervisor.flush(run.id)
      run = (await harness.store.get(run.id))!
      const current = onlyObligation(run)
      expect(current.deliveryAttempts).toBe(attempt)
      expect(current.consecutiveDeliveryFailures).toBe(attempt)
      if (attempt < 8) expect(current.state).toBe('retry_scheduled')
    }

    let obligation = onlyObligation(run)
    expect(run.status).toBe('awaiting_human')
    expect(obligation).toMatchObject({
      state: 'needs_attention',
      consecutiveDeliveryFailures: 8,
      lastError: 'persistent source Lead HTTP 500'
    })
    expect(obligation.nextWakeAt).toBeUndefined()
    expect(obligation.deliveryLeaseId).toBeUndefined()
    const cappedSeq = run.lastEventSeq
    await supervisor.sweepObligations()
    expect((await harness.store.get(run.id))!.lastEventSeq).toBe(cappedSeq)

    failDelivery = false
    run = (await supervisor.wake(
      run.id,
      obligation.id,
      'manual-retry-after-delivery-cap'
    ))!
    obligation = onlyObligation(run)
    expect(run.status).toBe('awaiting_supervision')
    expect(obligation).toMatchObject({
      state: 'pending',
      deliveryAttempts: 8,
      consecutiveDeliveryFailures: 0
    })
    expect(obligation.lastError).toBeUndefined()
    expect(obligation.attentionReason).toBeUndefined()

    await supervisor.flush(run.id)
    run = (await harness.store.get(run.id))!
    expect(run.status).toBe('awaiting_supervision')
    expect(onlyObligation(run)).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 9,
      consecutiveDeliveryFailures: 0
    })
    expect(leadTurn).toHaveBeenCalledTimes(9)
    await supervisor.stop()
  })

  it('keeps a deferred delivery durable without advancing the prompt snapshot cursor', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const supervisor = supervisorFor(harness, {
      leadTurn: async () => ({
        status: 'deferred',
        reason: 'Source Lead execution capacity is temporarily unavailable.',
        retryAfterMs: 10_000
      })
    })
    await supervisor.signal(HELP_SIGNAL)
    await supervisor.flush(HELP_SIGNAL.runId)

    const run = (await harness.store.get(HELP_SIGNAL.runId))!
    const obligation = onlyObligation(run)
    expect(obligation).toMatchObject({
      state: 'retry_scheduled',
      deliveryAttempts: 1,
      lastError: 'Source Lead execution capacity is temporarily unavailable.'
    })
    expect(obligation.lastDeliveredSeq).toBeUndefined()
    expect(obligation.lastDeliveredAt).toBeUndefined()
    expect(Date.parse(obligation.nextWakeAt!) - harness.nowMs()).toBe(2_000)
    expectDurableLiveness(run, harness.nowMs())
    await supervisor.stop()
  })

  it('redelivers one durable obligation when the same signal arrives after restart', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const firstLead = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: true
    }))
    const first = supervisorFor(harness, { leadTurn: firstLead, isLeadTurnActive: () => true })
    await first.signal(HELP_SIGNAL)
    await first.flush(HELP_SIGNAL.runId)
    const obligationId = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!).id
    await first.stop()

    harness.advance(2_000)
    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    const secondLead = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: true
    }))
    const second = supervisorFor(harness, {
      store: reopenedStore,
      leadTurn: secondLead,
      isLeadTurnActive: () => false
    })
    await second.signal(HELP_SIGNAL)
    await second.flush(HELP_SIGNAL.runId)

    const run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(run.supervisionObligations).toHaveLength(1)
    expect(onlyObligation(run)).toMatchObject({
      id: obligationId,
      state: 'awaiting_action',
      deliveryAttempts: 2
    })
    expect(firstLead).toHaveBeenCalledOnce()
    expect(secondLead).toHaveBeenCalledOnce()
    await second.stop()
  })

  it('renews a long delivery beyond 30 seconds without recording extra starts', async () => {
    vi.useFakeTimers()
    let releaseLead: (() => void) | undefined
    let flushing: Promise<void> | undefined
    let supervisor: GraphSupervisor | undefined
    try {
      const harness = await persistentHarness()
      await transitionRunToRunning(harness)
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const held = new Promise<void>((resolve) => { releaseLead = resolve })
      supervisor = supervisorFor(harness, {
        leadTurn: async ({ run }) => {
          markStarted()
          await held
          return {
            status: 'delivered',
            sourceTurnId: run.sourceTurnId,
            deliveredSeq: run.lastEventSeq,
            executionActive: true
          }
        },
        isLeadTurnActive: () => true
      })

      await supervisor.signal(HELP_SIGNAL)
      flushing = supervisor.flush(HELP_SIGNAL.runId)
      await started
      const initial = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!)
      expect(initial.state).toBe('delivering')
      expect(initial.deliveryLeaseId).toMatch(/^graph_delivery_lease_/)
      expect(Date.parse(initial.leaseUntil!) - harness.nowMs()).toBe(30_000)

      for (let heartbeat = 1; heartbeat <= 4; heartbeat += 1) {
        harness.advance(10_000)
        await vi.advanceTimersByTimeAsync(10_000)
        for (let poll = 0; poll < 100; poll += 1) {
          const eventTypes = await durableEventTypes(harness.store)
          if (eventTypes.filter((type) =>
            type === 'supervision_obligation_updated').length >= heartbeat) break
        }
        expect((await durableEventTypes(harness.store)).filter((type) =>
          type === 'supervision_obligation_updated')).toHaveLength(heartbeat)
      }
      const renewed = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!)
      expect(renewed).toMatchObject({
        state: 'delivering',
        deliveryLeaseId: initial.deliveryLeaseId,
        deliveryAttempts: 1
      })
      expect(Date.parse(renewed.leaseUntil!) - harness.nowMs()).toBe(30_000)
      await supervisor.sweepObligations()
      const heartbeatEvents = await durableEventTypes(harness.store)
      expect(heartbeatEvents.filter((type) =>
        type === 'supervision_delivery_started')).toHaveLength(1)
      expect(heartbeatEvents.filter((type) =>
        type === 'supervision_obligation_updated')).toHaveLength(4)

      releaseLead?.()
      releaseLead = undefined
      await flushing
      flushing = undefined
      const delivered = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!)
      expect(delivered).toMatchObject({
        state: 'awaiting_action',
        deliveryAttempts: 1,
        consecutiveDeliveryFailures: 0
      })
      expect(delivered.deliveryLeaseId).toBeUndefined()
    } finally {
      releaseLead?.()
      await flushing?.catch(() => undefined)
      await supervisor?.stop()
      vi.useRealTimers()
    }
  })

  it('ignores a stale completion after its delivery token has expired', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    let markStarted!: () => void
    let releaseLead!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseLead = resolve })
    const abandoned = supervisorFor(harness, {
      leadTurn: async ({ run }) => {
        markStarted()
        await held
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        }
      },
      isLeadTurnActive: () => true
    })
    await abandoned.signal(HELP_SIGNAL)
    const staleFlush = abandoned.flush(HELP_SIGNAL.runId)
    await started
    const stale = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!)
    expect(stale.deliveryLeaseId).toMatch(/^graph_delivery_lease_/)

    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    let replacementLeaseId: string | undefined
    const resumedLead = vi.fn(async ({ run }: { run: GraphRunV1 }) => {
      replacementLeaseId = onlyObligation(run).deliveryLeaseId
      return {
        status: 'delivered' as const,
        sourceTurnId: run.sourceTurnId,
        deliveredSeq: run.lastEventSeq,
        executionActive: true
      }
    })
    const resumed = supervisorFor(harness, {
      store: reopenedStore,
      leadTurn: resumedLead,
      isLeadTurnActive: () => true
    })
    harness.advance(30_000)
    await resumed.sweepObligations()
    let run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'retry_scheduled',
      consecutiveDeliveryFailures: 1,
      lastError: 'Graph supervision delivery lease expired.'
    })

    releaseLead()
    await staleFlush
    run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'retry_scheduled',
      deliveryAttempts: 1,
      consecutiveDeliveryFailures: 1
    })
    expect(onlyObligation(run).lastDeliveredSeq).toBeUndefined()

    harness.advance(2_000)
    await resumed.sweepObligations()
    await resumed.flush(HELP_SIGNAL.runId)
    run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 2,
      consecutiveDeliveryFailures: 0
    })
    expect(replacementLeaseId).toMatch(/^graph_delivery_lease_/)
    expect(replacementLeaseId).not.toBe(stale.deliveryLeaseId)
    expect(resumedLead).toHaveBeenCalledOnce()
    await Promise.all([abandoned.stop(), resumed.stop()])
  })

  it('stops a held delivery heartbeat before waiting and lets a new owner reclaim', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    let markStarted!: () => void
    let releaseLead: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseLead = resolve })
    const oldSupervisor = supervisorFor(harness, {
      leadTurn: async ({ run }) => {
        markStarted()
        await held
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        }
      },
      isLeadTurnActive: () => true
    })
    let oldFlush: Promise<void> | undefined
    let stopping: Promise<void> | undefined
    let resumed: GraphSupervisor | undefined

    try {
      await oldSupervisor.signal(HELP_SIGNAL)
      oldFlush = oldSupervisor.flush(HELP_SIGNAL.runId)
      await started
      const oldLease = onlyObligation((await harness.store.get(HELP_SIGNAL.runId))!)
      expect(oldLease.state).toBe('delivering')

      let stopCompleted = false
      stopping = oldSupervisor.stop().then(() => { stopCompleted = true })
      await Promise.resolve()
      expect(stopCompleted).toBe(false)

      const reopenedStore = new FileGraphRunStore(harness.storeOptions)
      const resumedLead = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
        status: 'delivered' as const,
        sourceTurnId: run.sourceTurnId,
        deliveredSeq: run.lastEventSeq,
        executionActive: true
      }))
      resumed = supervisorFor(harness, {
        store: reopenedStore,
        leadTurn: resumedLead,
        isLeadTurnActive: () => true
      })
      harness.advance(30_000)
      await resumed.sweepObligations()
      let run = (await reopenedStore.get(HELP_SIGNAL.runId))!
      expect(onlyObligation(run)).toMatchObject({
        state: 'retry_scheduled',
        deliveryAttempts: 1,
        consecutiveDeliveryFailures: 1
      })

      harness.advance(2_000)
      await resumed.sweepObligations()
      await resumed.flush(HELP_SIGNAL.runId)
      run = (await reopenedStore.get(HELP_SIGNAL.runId))!
      expect(onlyObligation(run)).toMatchObject({
        state: 'awaiting_action',
        deliveryAttempts: 2,
        consecutiveDeliveryFailures: 0
      })
      expect(resumedLead).toHaveBeenCalledOnce()

      releaseLead?.()
      releaseLead = undefined
      await Promise.all([oldFlush, stopping])
      oldFlush = undefined
      stopping = undefined
      run = (await reopenedStore.get(HELP_SIGNAL.runId))!
      expect(onlyObligation(run)).toMatchObject({
        state: 'awaiting_action',
        deliveryAttempts: 2
      })
      expect(onlyObligation(run).lastDeliveredSeq).toBeDefined()
    } finally {
      releaseLead?.()
      await Promise.allSettled([
        oldFlush ?? Promise.resolve(),
        stopping ?? oldSupervisor.stop(),
        resumed?.stop() ?? Promise.resolve()
      ])
    }
  })

  it('does not start Lead delivery when stop wins a delayed claim race', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const oldLead = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: true
    }))
    const oldSupervisor = supervisorFor(harness, {
      leadTurn: oldLead,
      isLeadTurnActive: () => true
    })
    await oldSupervisor.signal(HELP_SIGNAL)

    const originalAppend = harness.store.append.bind(harness.store)
    let markClaimStarted!: () => void
    let releaseClaim!: () => void
    const claimStarted = new Promise<void>((resolve) => { markClaimStarted = resolve })
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve })
    const appendSpy = vi.spyOn(harness.store, 'append').mockImplementation(
      async (runId, input) => {
        if (input.event.type === 'supervision_delivery_started') {
          markClaimStarted()
          await claimGate
        }
        return originalAppend(runId, input)
      }
    )
    const oldFlush = oldSupervisor.flush(HELP_SIGNAL.runId)
    await claimStarted
    let stopCompleted = false
    const stopping = oldSupervisor.stop().then(() => { stopCompleted = true })
    await Promise.resolve()
    expect(stopCompleted).toBe(false)

    releaseClaim()
    await Promise.all([oldFlush, stopping])
    appendSpy.mockRestore()
    let run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(oldLead).not.toHaveBeenCalled()
    expect(onlyObligation(run)).toMatchObject({
      state: 'delivering',
      deliveryAttempts: 1
    })

    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    const resumedLead = vi.fn(async ({ run: current }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: current.sourceTurnId,
      deliveredSeq: current.lastEventSeq,
      executionActive: true
    }))
    const resumed = supervisorFor(harness, {
      store: reopenedStore,
      leadTurn: resumedLead,
      isLeadTurnActive: () => true
    })
    harness.advance(30_000)
    await resumed.sweepObligations()
    harness.advance(2_000)
    await resumed.sweepObligations()
    await resumed.flush(HELP_SIGNAL.runId)
    run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 2,
      consecutiveDeliveryFailures: 0
    })
    expect(resumedLead).toHaveBeenCalledOnce()
    await resumed.stop()
  })

  it('does not expire a delivery lease when renewal wins the stale sweep race', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    let markStarted!: () => void
    let releaseLead!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const held = new Promise<void>((resolve) => { releaseLead = resolve })
    const delivering = supervisorFor(harness, {
      leadTurn: async ({ run }) => {
        markStarted()
        await held
        return {
          status: 'delivered',
          sourceTurnId: run.sourceTurnId,
          deliveredSeq: run.lastEventSeq,
          executionActive: true
        }
      },
      isLeadTurnActive: () => true
    })
    await delivering.signal(HELP_SIGNAL)
    const deliveryFlush = delivering.flush(HELP_SIGNAL.runId)
    await started
    const staleRun = (await harness.store.get(HELP_SIGNAL.runId))!
    const staleObligation = onlyObligation(staleRun)
    harness.advance(30_000)
    const renewedLeaseUntil = new Date(harness.nowMs() + 30_000).toISOString()
    await appendEvent(harness, {
      type: 'supervision_obligation_updated',
      payload: {
        obligation: {
          ...staleObligation,
          leaseUntil: renewedLeaseUntil,
          updatedAt: harness.nowIso()
        }
      }
    }, 'heartbeat-renewal-wins-expiry-race')

    const originalGet = harness.store.get.bind(harness.store)
    let staleReadPending = true
    const staleReadStore = new Proxy(harness.store, {
      get(target, property) {
        if (property === 'get') {
          return async (runId: string) => {
            if (staleReadPending) {
              staleReadPending = false
              return runId === staleRun.id ? structuredClone(staleRun) : originalGet(runId)
            }
            return originalGet(runId)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as GraphRunStore
    const sweeper = supervisorFor(harness, { store: staleReadStore })
    await sweeper.sweepObligations()

    let run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'delivering',
      deliveryLeaseId: staleObligation.deliveryLeaseId,
      leaseUntil: renewedLeaseUntil,
      consecutiveDeliveryFailures: 0
    })
    expect((await durableEventTypes(harness.store)).filter((type) =>
      type === 'supervision_retry_scheduled')).toHaveLength(0)

    releaseLead()
    await deliveryFlush
    run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run).state).toBe('awaiting_action')
    await Promise.all([delivering.stop(), sweeper.stop()])
  })

  it('recovers an abandoned 30 second delivery lease from a reopened store', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const neverReturns = new Promise<never>(() => {})
    const abandoned = supervisorFor(harness, {
      leadTurn: async () => {
        markStarted()
        return neverReturns
      }
    })
    await abandoned.signal(HELP_SIGNAL)
    void abandoned.flush(HELP_SIGNAL.runId)
    await started

    let run = (await harness.store.get(HELP_SIGNAL.runId))!
    let obligation = onlyObligation(run)
    expect(obligation.state).toBe('delivering')
    expect(Date.parse(obligation.leaseUntil!) - harness.nowMs()).toBe(30_000)
    expectDurableLiveness(run, harness.nowMs())

    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    const resumedLead = vi.fn(async ({ run: current }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: current.sourceTurnId,
      deliveredSeq: current.lastEventSeq,
      executionActive: true
    }))
    const resumed = supervisorFor(harness, {
      store: reopenedStore,
      leadTurn: resumedLead,
      isLeadTurnActive: () => true
    })
    harness.advance(30_000)
    await resumed.sweepObligations()
    run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    obligation = onlyObligation(run)
    expect(obligation.state).toBe('retry_scheduled')
    expect(Date.parse(obligation.nextWakeAt!) - harness.nowMs()).toBe(2_000)

    harness.advance(2_000)
    await resumed.sweepObligations()
    await resumed.flush(HELP_SIGNAL.runId)
    run = (await reopenedStore.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'awaiting_action',
      deliveryAttempts: 2
    })
    expect(resumedLead).toHaveBeenCalledOnce()
    expectDurableLiveness(run, harness.nowMs())
    await resumed.stop()
  })

  it('moves an orphaned source owner to durable human attention', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const supervisor = supervisorFor(harness, {
      leadTurn: async () => ({
        status: 'orphaned',
        reason: 'The durable source turn no longer exists.'
      })
    })
    await supervisor.signal(HELP_SIGNAL)
    await supervisor.flush(HELP_SIGNAL.runId)

    const run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(run.status).toBe('awaiting_human')
    expect(onlyObligation(run)).toMatchObject({
      state: 'needs_attention',
      attentionReason: 'The durable source turn no longer exists.'
    })
    expectDurableLiveness(run, harness.nowMs())
    expect(await durableEventTypes(harness.store)).toContain('supervision_attention_required')
    await supervisor.stop()
  })

  it('escalates after three delivered episodes without semantic progress', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: false,
      parkedWithPendingSupervision: true
    }))
    const supervisor = supervisorFor(harness, { leadTurn, isLeadTurnActive: () => false })
    await supervisor.signal(HELP_SIGNAL)

    for (let episode = 1; episode <= 3; episode += 1) {
      if (episode > 1) await supervisor.sweepObligations()
      await supervisor.flush(HELP_SIGNAL.runId)
      const run = (await harness.store.get(HELP_SIGNAL.runId))!
      const obligation = onlyObligation(run)
      expect(obligation.noProgressCount).toBe(episode)
      if (episode < 3) {
        expect(obligation.state).toBe('retry_scheduled')
        expectDurableLiveness(run, harness.nowMs())
        harness.advance(episode === 1 ? 2_000 : 5_000)
      }
    }

    const run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(run.status).toBe('awaiting_human')
    expect(onlyObligation(run).state).toBe('needs_attention')
    expect(leadTurn).toHaveBeenCalledTimes(3)
    await supervisor.stop()
  })

  it('resets the consecutive no-progress count after a durable semantic event', async () => {
    const harness = await persistentHarness()
    await transitionRunToRunning(harness)
    const leadTurn = vi.fn(async ({ run }: { run: GraphRunV1 }) => ({
      status: 'delivered' as const,
      sourceTurnId: run.sourceTurnId,
      deliveredSeq: run.lastEventSeq,
      executionActive: false,
      parkedWithPendingSupervision: true
    }))
    const supervisor = supervisorFor(harness, { leadTurn, isLeadTurnActive: () => false })
    await supervisor.signal(HELP_SIGNAL)
    await supervisor.flush(HELP_SIGNAL.runId)
    let run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run).noProgressCount).toBe(1)

    harness.advance(2_000)
    run = await appendEvent(harness, {
      type: 'steering_recorded',
      payload: {
        steering: {
          version: GRAPH_CONTRACT_VERSION,
          steeringId: 'steering_semantic_progress',
          runId: run.id,
          target: { kind: 'lead' },
          text: 'Inspect the new durable evidence before reviewing.',
          status: 'persisted',
          createdAt: harness.nowIso()
        }
      }
    }, 'semantic-steering')
    const semanticProgressSeq = run.lastEventSeq
    await supervisor.sweepObligations()
    await supervisor.flush(HELP_SIGNAL.runId)

    run = (await harness.store.get(HELP_SIGNAL.runId))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'retry_scheduled',
      noProgressCount: 0,
      lastProgressSeq: semanticProgressSeq
    })
    expect(run.status).toBe('running')
    expectDurableLiveness(run, harness.nowMs())
    await supervisor.stop()
  })

  it('resolves a review obligation when its durable review predicate disappears', async () => {
    const harness = await persistentHarness()
    let run = await submitReviewableAttempt(harness)
    const supervisor = supervisorFor(harness, {
      leadTurn: async () => {
        throw new Error('review predicate should resolve before delivery')
      }
    })
    await supervisor.signal({
      runId: run.id,
      reason: 'submitted',
      nodeIds: ['research'],
      digest: 'Source Lead review is required.'
    })
    const attempt = run.nodes.research!.attempts.at(-1)!
    run = await appendEvent(harness, {
      type: 'review_recorded',
      payload: {
        review: {
          version: GRAPH_CONTRACT_VERSION,
          reviewId: 'review_lead_predicate_resolved',
          nodeId: 'research',
          attemptId: attempt.id,
          reviewerKind: 'lead',
          outcome: 'pass',
          summary: 'The source Lead accepted the durable result.',
          evidence: ['reviewed durable evidence'],
          artifactRefs: [],
          createdAt: harness.nowIso()
        }
      }
    }, 'lead-review')

    expect(graphSupervisionObligationIsActionable(run, onlyObligation(run))).toBe(false)
    await supervisor.sweepObligations()
    run = (await harness.store.get(run.id))!
    expect(onlyObligation(run)).toMatchObject({
      state: 'resolved',
      resolvedAt: harness.nowIso()
    })
    expect(await durableEventTypes(harness.store)).toContain('supervision_obligation_resolved')
    await supervisor.stop()
  })

  it('reconstructs a corrupted snapshot from a legacy journal with duplicate resolution', async () => {
    const harness = await persistentHarness()
    let run = await submitReviewableAttempt(harness)
    const supervisor = supervisorFor(harness)
    await supervisor.signal({
      runId: run.id,
      reason: 'submitted',
      nodeIds: ['research'],
      digest: 'Source Lead review is required.'
    })
    const attempt = run.nodes.research!.attempts.at(-1)!
    run = await appendEvent(harness, {
      type: 'review_recorded',
      payload: {
        review: {
          version: GRAPH_CONTRACT_VERSION,
          reviewId: 'review_legacy_resolution_replay',
          nodeId: 'research',
          attemptId: attempt.id,
          reviewerKind: 'lead',
          outcome: 'pass',
          summary: 'The source Lead accepted the durable result.',
          evidence: [],
          artifactRefs: [],
          createdAt: harness.nowIso()
        }
      }
    }, 'legacy-replay-review')
    await supervisor.sweepObligations()
    await supervisor.stop()

    const events = await harness.store.events(run.id, 0)
    const resolution = events.find((event) =>
      event.event.type === 'supervision_obligation_resolved')
    if (!resolution || resolution.event.type !== 'supervision_obligation_resolved') {
      throw new Error('missing resolution fixture event')
    }
    const originalResolvedAt = resolution.event.payload.obligation.resolvedAt
    const legacyTimestamp = new Date(harness.nowMs() + 1_000).toISOString()
    const duplicateEnvelope = {
      ...resolution,
      eventId: 'graph_event_legacy_duplicate_resolution',
      graphSeq: events.at(-1)!.graphSeq + 1,
      timestamp: legacyTimestamp,
      commandId: 'command_legacy_duplicate_resolution',
      idempotencyKey: 'legacy-duplicate-resolution',
      event: {
        type: 'supervision_obligation_resolved' as const,
        payload: {
          obligation: {
            ...resolution.event.payload.obligation,
            updatedAt: legacyTimestamp,
            resolvedAt: legacyTimestamp
          }
        }
      }
    }
    const runDir = join(harness.root, 'graphs', run.id)
    await appendFile(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({
        checksum: checksumJson(duplicateEnvelope),
        envelope: duplicateEnvelope
      })}\n`,
      'utf8'
    )
    await writeFile(join(runDir, 'snapshot.json'), '{invalid snapshot\n', 'utf8')

    const reopened = new FileGraphRunStore(harness.storeOptions)
    const replayed = (await reopened.get(run.id))!
    expect(replayed.lastEventSeq).toBe(duplicateEnvelope.graphSeq)
    expect(onlyObligation(replayed)).toMatchObject({
      state: 'resolved',
      resolvedAt: originalResolvedAt,
      updatedAt: resolution.event.payload.obligation.updatedAt
    })
    await expect(reopened.append(run.id, {
      expectedSeq: replayed.lastEventSeq,
      graphRevision: replayed.currentRevision,
      commandId: 'command_new_duplicate_resolution',
      idempotencyKey: 'new-duplicate-resolution',
      event: duplicateEnvelope.event
    })).rejects.toThrow(/resolved -> resolved/)
  })

  it('reconciles stale pre-terminal obligations once after reopening the durable store', async () => {
    const harness = await persistentHarness()
    let run = await transitionRunToRunning(harness)
    const original = supervisorFor(harness)
    await original.signal(HELP_SIGNAL)
    await original.signal({
      runId: run.id,
      reason: 'user_steering',
      nodeIds: [],
      digest: 'Stale steering from before cancellation.'
    })
    expect((await harness.store.get(run.id))!.supervisionObligations).toHaveLength(2)
    await original.stop()
    run = await appendEvent(harness, {
      type: 'run_status_changed',
      payload: {
        from: 'running',
        to: 'pausing',
        pendingControlIntent: 'cancel',
        reason: 'test cancellation fence'
      }
    }, 'terminal-reconcile-pausing')
    run = await appendEvent(harness, {
      type: 'run_status_changed',
      payload: {
        from: 'pausing',
        to: 'cancelled',
        reason: 'test cancellation completed'
      }
    }, 'terminal-reconcile-cancelled')

    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    const leadTurn = vi.fn(async () => undefined)
    const reopened = supervisorFor(harness, { store: reopenedStore, leadTurn })
    await reopened.redeliverNow({
      runId: run.id,
      reason: 'completion',
      nodeIds: [],
      digest: 'Recovered cancelled GraphRun.',
      recoveryKey: `terminal:cancelled:${run.sourceTurnId}:0`
    })

    const reconciled = (await reopenedStore.get(run.id))!
    expect(reconciled.supervisionObligations).toHaveLength(3)
    expect(reconciled.supervisionObligations.every((entry) => entry.state === 'resolved'))
      .toBe(true)
    expect(leadTurn).toHaveBeenCalledOnce()
    const resolvedEvents = (await reopenedStore.events(run.id, 0)).filter((event) =>
      event.event.type === 'supervision_obligation_resolved')
    expect(resolvedEvents).toHaveLength(3)

    const stableSeq = reconciled.lastEventSeq
    await Promise.all(Array.from({ length: 1_000 }, () => reopened.sweepObligations()))
    expect((await reopenedStore.get(run.id))!.lastEventSeq).toBe(stableSeq)
    await reopened.stop()
  })

  it('repairs a persisted attention obligation whose run transition was interrupted', async () => {
    const harness = await persistentHarness()
    let run = await transitionRunToRunning(harness)
    const candidate = graphSupervisionObligationForSignal(
      run,
      HELP_SIGNAL,
      harness.nowIso()
    )
    run = await appendEvent(harness, {
      type: 'supervision_obligation_updated',
      payload: {
        obligation: {
          ...candidate,
          state: 'needs_attention',
          attentionReason: 'Persisted source-owner failure requires attention.'
        }
      }
    }, 'partial-attention')
    expect(run.status).toBe('running')

    const reopenedStore = new FileGraphRunStore(harness.storeOptions)
    const supervisor = supervisorFor(harness, { store: reopenedStore })
    await supervisor.sweepObligations()
    run = (await reopenedStore.get(run.id))!
    expect(run.status).toBe('awaiting_human')
    expect(onlyObligation(run).state).toBe('needs_attention')
    expectDurableLiveness(run, harness.nowMs())
    await supervisor.stop()
  })

  it('holds non-actionable obligations when an earlier attention transition turns human', async () => {
    const harness = await persistentHarness()
    let run = await transitionRunToRunning(harness)
    run = await appendEvent(harness, {
      type: 'run_status_changed',
      payload: {
        from: 'running',
        to: 'awaiting_supervision',
        reason: 'test supervision hold'
      }
    }, 'awaiting-supervision-for-attention-hold')
    const attention = graphSupervisionObligationForSignal(run, HELP_SIGNAL, harness.nowIso())
    run = await appendEvent(harness, {
      type: 'supervision_attention_required',
      payload: {
        obligation: {
          ...attention,
          state: 'needs_attention',
          attentionReason: 'Human attention must remain authoritative.'
        }
      }
    }, 'attention-before-held-obligation')
    const held = graphSupervisionObligationForSignal(run, {
      runId: run.id,
      reason: 'scheduler_error',
      nodeIds: [],
      digest: 'Hold this scheduler obligation while attention remains.'
    }, harness.nowIso())
    run = await appendEvent(harness, {
      type: 'supervision_obligation_opened',
      payload: { obligation: held }
    }, 'pending-obligation-held-for-attention')

    const supervisor = supervisorFor(harness)
    await supervisor.sweepObligations()
    run = (await harness.store.get(run.id))!
    expect(run.status).toBe('awaiting_human')
    expect(run.supervisionObligations.find((entry) =>
      entry.id === attention.id)?.state).toBe('needs_attention')
    expect(run.supervisionObligations.find((entry) =>
      entry.id === held.id)?.state).toBe('pending')
    await supervisor.stop()
  })
})
