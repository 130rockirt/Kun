import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphNodeAttemptV1Schema
} from '../contracts/graph.js'
import { FileGraphRunStore, GraphRunConflictError } from './graph-run-store.js'
import { GraphControlService } from './graph-control-service.js'
import {
  TEST_GRAPH_NOW,
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kun-graph-control-'))
  roots.push(root)
  let id = 0
  const config = testGraphConfig()
  const store = new FileGraphRunStore({
    rootDir: join(root, 'graphs'),
    artifactStore: new FileArtifactStore(join(root, 'artifacts')),
    config: () => config,
    nextId: (prefix) => `${prefix}_${++id}`
  })
  const pauseActive = vi.fn(async () => undefined)
  const control = new GraphControlService({
    store,
    config: () => config,
    pauseActive,
    nextId: (prefix) => `${prefix}_${++id}`
  })
  return { control, store, pauseActive }
}

describe('GraphControlService', () => {
  it('durably validates, creates, starts, pauses, resumes, and cancels a run', async () => {
    const { control, pauseActive } = await fixture()
    const created = await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'command_create',
      idempotencyKey: 'create_1',
      start: true
    })
    expect(created.run.status).toBe('running')
    const paused = await control.pause('run_1', {
      commandId: 'command_pause',
      idempotencyKey: 'pause_1',
      expectedRevision: 1
    })
    expect(paused.status).toBe('paused')
    expect(pauseActive).toHaveBeenCalledOnce()
    const resumed = await control.resume('run_1', {
      commandId: 'command_resume',
      idempotencyKey: 'resume_1',
      expectedSeq: paused.lastEventSeq
    })
    expect(resumed.status).toBe('running')
    const cancelled = await control.cancel('run_1', {
      commandId: 'command_cancel',
      idempotencyKey: 'cancel_1',
      reason: 'test cancellation'
    })
    expect(cancelled.status).toBe('cancelled')
  })

  it('notifies supervision after durable user steering and cancellation', async () => {
    const { store } = await fixture()
    const onSteering = vi.fn(async () => undefined)
    const onCancelled = vi.fn(async () => undefined)
    const control = new GraphControlService({
      store,
      config: () => testGraphConfig(),
      onSteering,
      onCancelled
    })
    await control.create({
      runId: 'run_notifications',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'command_create_notifications',
      idempotencyKey: 'create_notifications',
      start: true
    })
    const steered = await control.steer('run_notifications', {
      version: GRAPH_CONTRACT_VERSION,
      steeringId: 'steering_1',
      runId: 'run_notifications',
      target: { kind: 'node', nodeId: 'research' },
      text: 'Use the smaller fixture.',
      status: 'persisted',
      createdAt: TEST_GRAPH_NOW
    }, {
      commandId: 'command_steer',
      idempotencyKey: 'steer_1'
    })
    expect(onSteering).toHaveBeenCalledOnce()
    expect(onSteering).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run_notifications',
        lastEventSeq: steered.lastEventSeq
      }),
      expect.objectContaining({
        steeringId: 'steering_1',
        text: 'Use the smaller fixture.'
      })
    )

    const cancelled = await control.cancel('run_notifications', {
      commandId: 'command_cancel_notifications',
      idempotencyKey: 'cancel_notifications',
      reason: 'No longer needed.'
    })
    expect(cancelled.status).toBe('cancelled')
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run_notifications', status: 'cancelled' }),
      'No longer needed.'
    )
  })

  it('rejects stale revisions and preserves accepted facts during patches', async () => {
    const { control } = await fixture()
    const created = await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'command_create',
      idempotencyKey: 'create_1'
    })
    await expect(control.applyPatch('run_1', {
      version: 1,
      patchId: 'patch_1',
      commandId: 'command_patch',
      runId: 'run_1',
      baseRevision: 2,
      requester: { kind: 'lead', id: 'lead_1' },
      reason: 'stale test',
      operations: [{
        op: 'update_budget',
        budget: created.run.budget.limits
      }],
      createdAt: new Date().toISOString()
    }, {
      commandId: 'command_patch',
      idempotencyKey: 'patch_1',
      expectedRevision: 1
    })).rejects.toBeInstanceOf(GraphRunConflictError)
  })

  it('supersedes accepted work with a distinct node while retaining accepted history', async () => {
    const { control, store } = await fixture()
    await control.create({
      runId: 'run_revision',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'command_create_revision',
      idempotencyKey: 'create_revision'
    })
    await submitAttempt(control, store, 'run_revision', 'finish', true)
    const accepted = await control.get('run_revision')
    const replacement = {
      ...accepted.nodes.finish.node,
      id: 'finish_v2',
      title: 'Revised finish'
    }
    const patchBase = {
      version: 1 as const,
      patchId: 'patch_revision',
      commandId: 'command_patch_revision',
      runId: 'run_revision',
      baseRevision: 1,
      requester: { kind: 'lead' as const, id: 'lead_1' },
      reason: 'New requirement supersedes the accepted completion.',
      createdAt: new Date().toISOString()
    }
    await expect(control.applyPatch('run_revision', {
      ...patchBase,
      operations: [{
        op: 'replace_node',
        nodeId: 'finish',
        replacement,
        supersedesAcceptedWork: false
      }]
    }, {
      commandId: 'reject_rewrite',
      idempotencyKey: 'reject_rewrite',
      expectedSeq: accepted.lastEventSeq,
      expectedRevision: 1
    })).rejects.toThrow(/distinct superseding node/)

    const revised = await control.applyPatch('run_revision', {
      ...patchBase,
      operations: [{
        op: 'replace_node',
        nodeId: 'finish',
        replacement,
        supersedesAcceptedWork: true
      }]
    }, {
      commandId: 'apply_supersession',
      idempotencyKey: 'apply_supersession',
      expectedSeq: accepted.lastEventSeq,
      expectedRevision: 1
    })
    expect(revised.currentRevision).toBe(2)
    expect(revised.nodes.finish.status).toBe('superseded')
    expect(revised.nodes.finish_v2.status).toBe('pending')
    expect(revised.nodes.finish.node.title).toBe('Finish')
    expect(revised.nodes.finish_v2.node.title).toBe('Revised finish')
  })

  it('rejects stale, duplicate, unrequired, and premature external reviews', async () => {
    const { control, store } = await fixture()
    const source = testGraphPlan().nodes[0]!
    await control.create({
      runId: 'run_review',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({
        nodes: [{
          ...source,
          completion: {
            ...source.completion,
            review: {
              kinds: ['human'],
              requireAll: true,
              deterministicChecks: []
            }
          }
        }],
        edges: [],
        completionNodeIds: [source.id]
      }),
      commandId: 'create_review',
      idempotencyKey: 'create_review'
    })
    await expect(control.recordReview('run_review', reviewFor('missing_attempt'), {
      commandId: 'premature_review',
      idempotencyKey: 'premature_review'
    })).rejects.toThrow()

    const submitted = await submitAttempt(control, store, 'run_review', source.id)
    const attempt = submitted.nodes[source.id]!.attempts.at(-1)!
    const review = reviewFor(attempt.id)
    const reviewed = await control.recordReview('run_review', review, {
      commandId: 'human_review',
      idempotencyKey: 'human_review',
      expectedSeq: submitted.lastEventSeq
    })
    expect(reviewed.reviews).toHaveLength(1)
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'human_review_duplicate'
    }, {
      commandId: 'human_review_duplicate',
      idempotencyKey: 'human_review_duplicate'
    })).rejects.toThrow(/already exists/)
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'deterministic_review',
      reviewerKind: 'deterministic'
    }, {
      commandId: 'deterministic_review',
      idempotencyKey: 'deterministic_review'
    }, 'system')).rejects.toThrow(/not required/)
  })

  it('rejects active-node rewrites and budgets below durable usage', async () => {
    const { control, store } = await fixture()
    await control.create({
      runId: 'run_patch_guard',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'create_patch_guard',
      idempotencyKey: 'create_patch_guard'
    })
    const submitted = await submitAttempt(control, store, 'run_patch_guard', 'research')
    const currentPlan = submitted.plans.at(-1)!
    await expect(control.applyPatch('run_patch_guard', {
      version: GRAPH_CONTRACT_VERSION,
      patchId: 'patch_active',
      commandId: 'patch_active',
      runId: submitted.id,
      baseRevision: submitted.currentRevision,
      requester: { kind: 'lead', id: 'lead_1' },
      reason: 'Unsafe active rewrite.',
      operations: [{
        op: 'replace_node',
        nodeId: 'research',
        replacement: { ...submitted.nodes.research.node, title: 'Changed while active' },
        supersedesAcceptedWork: false
      }],
      createdAt: TEST_GRAPH_NOW
    }, {
      commandId: 'patch_active',
      idempotencyKey: 'patch_active',
      expectedSeq: submitted.lastEventSeq
    })).rejects.toThrow(/active node/)
    await expect(control.applyPatch('run_patch_guard', {
      version: GRAPH_CONTRACT_VERSION,
      patchId: 'patch_budget',
      commandId: 'patch_budget',
      runId: submitted.id,
      baseRevision: submitted.currentRevision,
      requester: { kind: 'lead', id: 'lead_1' },
      reason: 'Unsafe budget reduction.',
      operations: [{
        op: 'update_budget',
        budget: { ...currentPlan.budget, maxNodes: 1 }
      }],
      createdAt: TEST_GRAPH_NOW
    }, {
      commandId: 'patch_budget',
      idempotencyKey: 'patch_budget'
    })).rejects.toThrow(/maxNodes/)
  })

  it('records terminal resource cleanup as durable graph truth', async () => {
    const { store } = await fixture()
    const cleanupResources = vi.fn(async () => [{
      resourceKind: 'worktree' as const,
      resourceId: 'worktree_1',
      attemptId: 'attempt_1',
      state: 'preserved' as const,
      lastError: 'unaccepted changes require human disposition'
    }])
    const control = new GraphControlService({
      store,
      config: () => testGraphConfig(),
      cleanupResources
    })
    await control.create({
      runId: 'run_cleanup',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'command_create_cleanup',
      idempotencyKey: 'create_cleanup'
    })
    await control.cancel('run_cleanup', {
      commandId: 'command_cancel_cleanup',
      idempotencyKey: 'cancel_cleanup'
    })
    const cancellationEvents = await store.events('run_cleanup')
    expect(cancellationEvents.at(-1)?.event).toMatchObject({
      type: 'run_status_changed',
      payload: { to: 'cancelled' }
    })
    expect(cancellationEvents.findIndex((event) => event.event.type === 'cleanup_updated'))
      .toBeLessThan(cancellationEvents.length - 1)
    const cleaned = await control.cleanup('run_cleanup', {
      commandId: 'command_cleanup',
      idempotencyKey: 'cleanup_1'
    })
    expect(cleanupResources).toHaveBeenCalledTimes(2)
    expect(cleaned.cleanup).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKind: 'worktree',
        resourceId: 'worktree_1',
        state: 'preserved'
      }),
      expect.objectContaining({
        resourceKind: 'journal',
        resourceId: 'run_cleanup',
        state: 'completed'
      })
    ]))
  })
})

async function submitAttempt(
  control: GraphControlService,
  store: FileGraphRunStore,
  runId: string,
  nodeId: string,
  accept = false
) {
  let run = await control.get(runId)
  if (run.nodes[nodeId]!.status === 'pending') {
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: `ready_${nodeId}`,
      idempotencyKey: `ready:${runId}:${nodeId}`,
      event: {
        type: 'node_status_changed',
        payload: { nodeId, from: 'pending', to: 'ready', reason: 'test fixture' }
      }
    })).state
  }
  const attempt = GraphNodeAttemptV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    id: `attempt_${nodeId}`,
    runId,
    nodeId,
    revision: run.currentRevision,
    attemptNumber: 1,
    iteration: 0,
    commandId: `attempt_${nodeId}`,
    idempotencyKey: `attempt:${runId}:${nodeId}`,
    status: 'queued',
    assignment: testAssignmentSnapshot(),
    queuedAt: TEST_GRAPH_NOW,
    tokenUsage: 0,
    elapsedMs: 0
  })
  const events = [
    { type: 'attempt_created' as const, payload: { attempt } },
    {
      type: 'attempt_status_changed' as const,
      payload: { nodeId, attemptId: attempt.id, from: 'queued' as const, to: 'running' as const }
    },
    {
      type: 'node_status_changed' as const,
      payload: { nodeId, from: 'queued' as const, to: 'running' as const, reason: 'test fixture' }
    },
    {
      type: 'result_submitted' as const,
      payload: {
        nodeId,
        attemptId: attempt.id,
        result: {
          version: GRAPH_CONTRACT_VERSION,
          summary: 'Submitted test result.',
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
      payload: { nodeId, attemptId: attempt.id, from: 'running' as const, to: 'submitted' as const }
    },
    {
      type: 'node_status_changed' as const,
      payload: { nodeId, from: 'running' as const, to: 'submitted' as const, reason: 'test fixture' }
    }
  ]
  for (const [index, event] of events.entries()) {
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: `submit_${nodeId}_${index}`,
      idempotencyKey: `submit:${runId}:${nodeId}:${index}`,
      event
    })).state
  }
  if (accept) {
    for (const [index, event] of [
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
          reason: 'test accepted fact'
        }
      }
    ].entries()) {
      run = (await store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `accept_${nodeId}_${index}`,
        idempotencyKey: `accept:${runId}:${nodeId}:${index}`,
        event
      })).state
    }
  }
  return run
}

function reviewFor(attemptId: string) {
  return {
    version: GRAPH_CONTRACT_VERSION,
    reviewId: 'human_review_1',
    nodeId: 'research',
    attemptId,
    reviewerKind: 'human' as const,
    outcome: 'pass' as const,
    summary: 'Approved.',
    evidence: [],
    artifactRefs: [],
    createdAt: TEST_GRAPH_NOW
  }
}
