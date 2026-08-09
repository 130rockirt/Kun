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
