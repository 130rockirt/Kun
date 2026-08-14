import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  type GraphDomainEventV1,
  type GraphRunV1,
  type GraphSupervisionObligationV1
} from '../contracts/graph.js'
import { FileGraphRunStore, type GraphRunStore } from './graph-run-store.js'
import { GraphSupervisor } from './graph-supervisor.js'
import {
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


function onlyObligation(run: GraphRunV1): GraphSupervisionObligationV1 {
  expect(run.supervisionObligations).toHaveLength(1)
  return run.supervisionObligations[0]!
}

async function durableEventTypes(store: FileGraphRunStore): Promise<string[]> {
  return (await store.events('run_obligation', 0)).map((event) => event.event.type)
}

const HELP_SIGNAL = {
  runId: 'run_obligation',
  reason: 'help' as const,
  nodeIds: [] as string[],
  digest: 'Source Lead action remains required.'
}

describe('GraphSupervisor delivery lease fencing', () => {
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
})
