import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryArtifactStore } from '../../src/artifacts/artifact-store.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema,
  type GraphRunV1
} from '../../src/contracts/graph.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { createTurnRecord } from '../../src/domain/turn.js'
import { ContextCompactor } from '../../src/loop/context-compactor.js'
import { InflightTracker } from '../../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../../src/loop/steering-queue.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { TurnService } from '../../src/services/turn-service.js'
import type { GraphParentAuthority } from '../../src/graph/index.js'
import {
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphPlan
} from '../../src/graph/graph-test-fixtures.test-support.js'
import { GraphRuntimeComposition } from '../../src/server/graph-runtime-factory.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

function authority(workspaceRoot: string): GraphParentAuthority {
  return {
    workspaceRoot,
    model: 'test-model',
    providerId: 'default',
    allowedModelProviderIds: ['default'],
    allowedModels: ['test-model'],
    allowedProviderIds: [],
    reasoningEffort: 'off',
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    allowedTools: [],
    blockedTools: [],
    allowedSkills: [],
    blockedSkills: [],
    allowedMcpServers: [],
    blockedMcpServers: [],
    readScopes: ['.'],
    writeScopes: [],
    networkAllowed: false
  }
}

async function waitForRun(
  runtime: GraphRuntimeComposition,
  runId: string,
  status: GraphRunV1['status']
): Promise<GraphRunV1> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const run = await runtime.store.get(runId)
    if (run?.status === status) return run
    if (Date.now() >= deadline) {
      throw new Error(`GraphRun ${runId} did not reach ${status}; current=${run?.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Graph runtime shutdown recovery', () => {
  it('finishes a summarized run after its failed source turn is recovered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-shutdown-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    const config = testGraphConfig({
      supervision: { coalesceWindowMs: 0 }
    })
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_shutdown_recovery',
      title: 'Shutdown Graph recovery',
      workspace,
      model: 'test-model'
    })
    const sourceTurn = createTurnRecord({
      id: 'turn_shutdown_recovery',
      threadId: thread.id,
	      prompt: 'Finish this Graph.',
	      orchestration: 'graph',
	      status: 'running'
    })
    await threadStore.upsert({ ...thread, turns: [sourceTurn] })
    let next = 0
    const ids = { next: (prefix: string) => `${prefix}_${++next}` }
    const artifactStore = new InMemoryArtifactStore()
    const runtimeEvents = { record: vi.fn(async (event) => event as never) }
    const leadTurn = vi.fn(async () => undefined)
    const composition = () => new GraphRuntimeComposition({
      dataDir: root,
      config: () => config,
      artifactStore,
      runtimeEvents,
      threadStore,
      ids,
      nowIso: () => '2026-07-30T15:00:00.000Z'
    })
    const seed = composition()
    const identity = await seed.registry.identify(workspace)
    const created = await seed.control.create({
      runId: 'run_shutdown_recovery',
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: sourceTurn.id,
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_shutdown_recovery',
      idempotencyKey: 'create_shutdown_recovery',
      start: true
    })
    let run = created.run
    for (const node of run.plans.at(-1)!.nodes) {
      run = await acceptPersistedNode(seed, run, node.id, workspace)
    }
    run = await appendGraphEvent(seed, run, 'enter_completing', {
      type: 'run_status_changed',
      payload: {
        from: 'running',
        to: 'completing',
        reason: 'all completion gates passed'
      }
    })
    run = await appendGraphEvent(seed, run, 'persist_final_summary', {
      type: 'run_summary_recorded',
      payload: {
        summary: {
          version: GRAPH_CONTRACT_VERSION,
          finalAnswer: 'The accepted Graph report is durable.',
          evidenceRefs: [],
          unresolvedRisks: [],
          changedFiles: [],
          validationResults: [],
          totalTokens: 0,
          totalElapsedMs: 0,
          completedAt: '2026-07-30T15:00:00.000Z'
        }
      }
    })
    await appendGraphEvent(seed, run, 'hold_final_summary_for_recovery', {
      type: 'run_status_changed',
      payload: {
        from: 'completing',
        to: 'awaiting_supervision',
        reason: 'scheduler recovery required after summary persistence'
      }
    })
	    await threadStore.upsert({
	      ...thread,
	      turns: [{ ...sourceTurn, status: 'failed' }]
	    })

    const firstRestart = composition()
    await firstRestart.start({
      delegation: () => undefined,
      leadTurn,
      authorityForRun: () => authority(workspace)
    })
    await waitForRun(firstRestart, created.run.id, 'completed')
    await firstRestart.stop()

    const secondRestart = composition()
    await secondRestart.start({
      delegation: () => undefined,
      leadTurn,
      authorityForRun: () => authority(workspace)
    })
    await waitForRun(secondRestart, created.run.id, 'completed')
    const events = await secondRestart.store.events(created.run.id, 0)
    expect(events.filter((entry) =>
      entry.event.type === 'run_summary_recorded')).toHaveLength(1)
    expect(events.filter((entry) =>
      entry.event.type === 'run_status_changed' &&
      entry.event.payload.to === 'completed')).toHaveLength(1)
    expect(events.filter((entry) =>
      entry.event.type === 'run_status_changed' &&
      entry.event.payload.to === 'cancelled')).toHaveLength(0)
    expect((await threadStore.get(thread.id))?.turns[0]).toMatchObject({
      status: 'failed'
    })
    expect(leadTurn).not.toHaveBeenCalled()
    await secondRestart.stop()
  })

  it('preserves an unreviewed supervision cursor across clean shutdown and redelivers on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-supervision-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    const config = testGraphConfig({
      supervision: { coalesceWindowMs: 0 }
    })
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const runtimeEvents = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-07-30T15:10:00.000Z'
    })
    const thread = createThreadRecord({
      id: 'thread_supervision_recovery',
      title: 'Pending supervision recovery',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert(thread)
    let next = 0
    const composition = () => new GraphRuntimeComposition({
      dataDir: root,
      config: () => config,
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents,
      threadStore,
      sessionStore,
      ids: { next: (prefix) => `${prefix}_${++next}` },
      nowIso: () => '2026-07-30T15:10:00.000Z'
    })
    const seed = composition()
    let runId = ''
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: runtimeEvents,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async () => {
        const run = runId ? await seed.store.get(runId) : null
        return run
          ? {
              runId: run.id,
              lastEventSeq: run.lastEventSeq,
              terminal: false,
              supervisionPending: run.status === 'awaiting_supervision'
            }
          : null
      },
      ids: new SequentialIdGenerator(),
      nowIso: () => '2026-07-30T15:10:00.000Z'
    })
    const source = await turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'Review the submitted result.',
        model: 'test-model',
        orchestration: 'graph'
      }
    })
    const identity = await seed.registry.identify(workspace)
    let run = (await seed.control.create({
      runId: 'run_supervision_recovery',
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: source.turnId,
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_supervision_recovery',
      idempotencyKey: 'create_supervision_recovery',
      start: true
    })).run
    runId = run.id
    const sourceNode = run.plans.at(-1)!.nodes[0]!
    run = await appendGraphEvent(seed, run, 'ready_pending_review', {
      type: 'node_status_changed',
      payload: {
        nodeId: sourceNode.id,
        from: 'pending',
        to: 'ready',
        reason: 'persisted submitted-result fixture'
      }
    })
    const attempt = GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_pending_review',
      runId: run.id,
      nodeId: sourceNode.id,
      revision: run.currentRevision,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_pending_review',
      idempotencyKey: 'attempt_pending_review',
      status: 'queued',
      assignment: {
        ...testAssignmentSnapshot(),
        workspaceRoot: workspace
      },
      queuedAt: '2026-07-30T15:10:00.000Z',
      tokenUsage: 0,
      elapsedMs: 0
    })
    const submittedEvents = [
      { type: 'attempt_created' as const, payload: { attempt } },
      {
        type: 'attempt_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          from: 'queued' as const,
          to: 'running' as const
        }
      },
      {
        type: 'node_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          from: 'queued' as const,
          to: 'running' as const,
          reason: 'persisted submitted-result fixture'
        }
      },
      {
        type: 'result_submitted' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          result: {
            version: GRAPH_CONTRACT_VERSION,
            summary: 'The worker result is waiting for the source Lead.',
            artifactRefs: [],
            changedFiles: [],
            checks: [],
            evidence: ['Persisted evidence requires explicit Lead review.'],
            risks: [],
            suggestedMessages: []
          },
          validation: {
            version: GRAPH_CONTRACT_VERSION,
            valid: true,
            issues: [],
            normalizedNodeCount: 1,
            normalizedEdgeCount: 1
          },
          tokenUsage: 0,
          elapsedMs: 0
        }
      },
      {
        type: 'attempt_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          from: 'running' as const,
          to: 'submitted' as const
        }
      },
      {
        type: 'node_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          from: 'running' as const,
          to: 'submitted' as const,
          reason: 'worker result submitted'
        }
      }
    ]
    for (const [index, event] of submittedEvents.entries()) {
      run = await appendGraphEvent(seed, run, `pending_review_${index}`, event)
    }
    run = (await seed.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'await_supervision',
      idempotencyKey: 'await_supervision',
      event: {
        type: 'run_status_changed',
        payload: {
          from: 'running',
          to: 'awaiting_supervision',
          reason: 'submitted node requires Lead review'
        }
      }
    })).state
    await seed.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'signal_supervision',
      idempotencyKey: 'signal_supervision',
      event: {
        type: 'supervision_requested',
        payload: {
          signalId: 'signal_pending_review',
          reason: 'submitted',
          nodeIds: ['research'],
          digest: 'The submitted node still requires graph_review_node.'
        }
      }
    })

    await turns.suspendTurnForHostShutdown({
      threadId: thread.id,
      turnId: source.turnId
    })
    expect(await turns.getTurn(thread.id, source.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId,
        lastDeliveredSeq: 0
      }
    })

    const leadTurn = vi.fn(async () => undefined)
    const restarted = composition()
    await restarted.start({
      delegation: () => undefined,
      leadTurn,
      authorityForRun: () => authority(workspace)
    })
    await vi.waitFor(() => {
      expect(leadTurn).toHaveBeenCalledWith(expect.objectContaining({
        run: expect.objectContaining({
          id: runId,
          status: 'awaiting_supervision'
        }),
        reasons: ['submitted'],
        nodeIds: ['research'],
        digest: expect.stringContaining('graph_review_node')
      }))
    })
    await restarted.stop()
  })
})

async function appendGraphEvent(
  runtime: GraphRuntimeComposition,
  run: GraphRunV1,
  key: string,
  event: Parameters<GraphRuntimeComposition['store']['append']>[1]['event']
): Promise<GraphRunV1> {
  return (await runtime.store.append(run.id, {
    expectedSeq: run.lastEventSeq,
    graphRevision: run.currentRevision,
    commandId: `command_${key}`,
    idempotencyKey: key,
    event
  })).state
}

async function acceptPersistedNode(
  runtime: GraphRuntimeComposition,
  run: GraphRunV1,
  nodeId: string,
  workspace: string
): Promise<GraphRunV1> {
  let next = await appendGraphEvent(runtime, run, `${nodeId}_ready`, {
    type: 'node_status_changed',
    payload: {
      nodeId,
      from: 'pending',
      to: 'ready',
      reason: 'persisted accepted-result fixture'
    }
  })
  const attempt = GraphNodeAttemptV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    id: `attempt_${nodeId}_accepted`,
    runId: next.id,
    nodeId,
    revision: next.currentRevision,
    attemptNumber: 1,
    iteration: 0,
    commandId: `attempt_${nodeId}_accepted`,
    idempotencyKey: `attempt_${nodeId}_accepted`,
    status: 'queued',
    assignment: {
      ...testAssignmentSnapshot(),
      workspaceRoot: workspace
    },
    queuedAt: '2026-07-30T15:00:00.000Z',
    tokenUsage: 0,
    elapsedMs: 0
  })
  const events = [
    { type: 'attempt_created' as const, payload: { attempt } },
    {
      type: 'attempt_status_changed' as const,
      payload: {
        nodeId,
        attemptId: attempt.id,
        from: 'queued' as const,
        to: 'running' as const
      }
    },
    {
      type: 'node_status_changed' as const,
      payload: {
        nodeId,
        from: 'queued' as const,
        to: 'running' as const,
        reason: 'persisted accepted-result fixture'
      }
    },
    {
      type: 'attempt_status_changed' as const,
      payload: {
        nodeId,
        attemptId: attempt.id,
        from: 'running' as const,
        to: 'submitted' as const
      }
    },
    {
      type: 'node_status_changed' as const,
      payload: {
        nodeId,
        from: 'running' as const,
        to: 'submitted' as const,
        reason: 'persisted accepted-result fixture'
      }
    },
    {
      type: 'attempt_status_changed' as const,
      payload: {
        nodeId,
        attemptId: attempt.id,
        from: 'submitted' as const,
        to: 'accepted' as const
      }
    },
    {
      type: 'node_status_changed' as const,
      payload: {
        nodeId,
        from: 'submitted' as const,
        to: 'accepted' as const,
        reason: 'persisted accepted-result fixture'
      }
    }
  ]
  for (const [index, event] of events.entries()) {
    next = await appendGraphEvent(runtime, next, `${nodeId}_accepted_${index}`, event)
  }
  return next
}
