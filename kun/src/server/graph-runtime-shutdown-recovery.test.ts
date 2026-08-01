import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryArtifactStore } from '../artifacts/artifact-store.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema,
  type GraphRunV1
} from '../contracts/graph.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import type { GraphParentAuthority } from '../graph/index.js'
import {
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphPlan
} from '../graph/graph-test-fixtures.test-support.js'
import { GraphRuntimeComposition } from './graph-runtime-factory.js'

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
  it('does not cancel an aborted legacy owner while completing and finalizes once', async () => {
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
	    await seed.store.append(created.run.id, {
      expectedSeq: created.run.lastEventSeq,
      graphRevision: created.run.currentRevision,
      commandId: 'enter_completing',
      idempotencyKey: 'enter_completing',
      event: {
        type: 'run_status_changed',
        payload: {
          from: 'running',
          to: 'completing',
          reason: 'all completion gates passed'
        }
	      }
	    })
	    await threadStore.upsert({
	      ...thread,
	      turns: [{ ...sourceTurn, status: 'aborted' }]
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
      status: 'aborted'
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

  it('redelivers a persisted exhausted screenshot-state as a semantic patch episode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-exhausted-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    const config = testGraphConfig({
      scheduler: { maxAttemptsPerNode: 1 },
      supervision: { coalesceWindowMs: 0 }
    })
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_exhausted_recovery',
      title: 'Exhausted Graph recovery',
      workspace,
      model: 'test-model'
    })
    const sourceTurn = createTurnRecord({
      id: 'turn_exhausted_recovery',
      threadId: thread.id,
      prompt: 'Repair the exhausted Graph.',
      orchestration: 'graph',
      status: 'running'
    })
    await threadStore.upsert({ ...thread, turns: [sourceTurn] })
    let next = 0
    const composition = () => new GraphRuntimeComposition({
      dataDir: root,
      config: () => config,
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++next}` },
      nowIso: () => '2026-07-30T16:30:00.000Z'
    })
    const seed = composition()
    const identity = await seed.registry.identify(workspace)
    const sourceNode = {
      ...testGraphPlan().nodes[0]!,
      maxAttempts: 1,
      completion: {
        ...testGraphPlan().nodes[0]!.completion,
        review: {
          kinds: ['lead' as const],
          requireAll: true,
          deterministicChecks: []
        }
      }
    }
    let run = (await seed.control.create({
      runId: 'run_exhausted_recovery',
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: sourceTurn.id,
      plan: testGraphPlan({
        workspaceRoot: workspace,
        nodes: [sourceNode],
        edges: [],
        completionNodeIds: [sourceNode.id],
        budget: {
          ...testGraphPlan().budget,
          maxAttemptsPerNode: 1
        }
      }),
      commandId: 'create_exhausted_recovery',
      idempotencyKey: 'create_exhausted_recovery',
      start: true
    })).run
    run = await appendGraphEvent(seed, run, 'ready_exhausted', {
      type: 'node_status_changed',
      payload: {
        nodeId: sourceNode.id,
        from: 'pending',
        to: 'ready',
        reason: 'persisted screenshot fixture'
      }
    })
    const attempt = GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_exhausted',
      runId: run.id,
      nodeId: sourceNode.id,
      revision: run.currentRevision,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_exhausted',
      idempotencyKey: 'attempt_exhausted',
      status: 'queued',
      assignment: testAssignmentSnapshot(),
      queuedAt: '2026-07-30T16:30:00.000Z',
      tokenUsage: 0,
      elapsedMs: 0
    })
    const fixtureEvents = [
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
          reason: 'persisted screenshot fixture'
        }
      },
      {
        type: 'result_submitted' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          result: {
            version: GRAPH_CONTRACT_VERSION,
            summary: 'The third bounded attempt still needs repair.',
            artifactRefs: [],
            changedFiles: [],
            checks: [],
            evidence: [],
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
      },
      {
        type: 'attempt_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          from: 'submitted' as const,
          to: 'reviewing' as const
        }
      },
      {
        type: 'node_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          from: 'submitted' as const,
          to: 'reviewing' as const,
          reason: 'Lead review requested repair'
        }
      },
      {
        type: 'review_recorded' as const,
        payload: {
          review: {
            version: GRAPH_CONTRACT_VERSION,
            reviewId: 'review_exhausted',
            nodeId: sourceNode.id,
            attemptId: attempt.id,
            reviewerKind: 'lead' as const,
            outcome: 'revise' as const,
            summary: 'The bounded attempt must be replaced.',
            evidence: [],
            artifactRefs: [],
            repairInstructions: 'Create a semantic replacement node.',
            createdAt: '2026-07-30T16:30:00.000Z'
          }
        }
      },
      {
        type: 'attempt_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          attemptId: attempt.id,
          from: 'reviewing' as const,
          to: 'repair_required' as const,
          failureClass: 'retryable' as const,
          normalizedFailure: 'Lead requested repair'
        }
      },
      {
        type: 'node_status_changed' as const,
        payload: {
          nodeId: sourceNode.id,
          from: 'reviewing' as const,
          to: 'repair_required' as const,
          reason: 'Lead requested repair'
        }
      },
      {
        type: 'run_status_changed' as const,
        payload: {
          from: 'running' as const,
          to: 'awaiting_supervision' as const,
          reason: 'old runtime parked after the final revise'
        }
      }
    ]
    for (const [index, event] of fixtureEvents.entries()) {
      run = await appendGraphEvent(seed, run, `exhausted_${index}`, event)
    }
    await threadStore.upsert({
      ...thread,
      turns: [{
        ...sourceTurn,
        graphLeadLifecycle: {
          version: 1,
          runId: run.id,
          state: 'supervising',
          lastDeliveredSeq: run.lastEventSeq,
          suspendedAt: '2026-07-30T16:30:00.000Z'
        }
      }]
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
        reasons: ['failure'],
        nodeIds: [sourceNode.id],
        digest: expect.stringContaining('graph_patch_run')
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
