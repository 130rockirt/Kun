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
import { FileGraphRunStore } from './graph-run-store.js'
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
    store?: FileGraphRunStore
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
})
