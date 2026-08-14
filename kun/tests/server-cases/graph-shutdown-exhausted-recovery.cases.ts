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
