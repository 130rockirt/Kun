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
  const resumeActive = vi.fn(async () => undefined)
  const control = new GraphControlService({
    store,
    config: () => config,
    pauseActive,
    resumeActive,
    nextId: (prefix) => `${prefix}_${++id}`
  })
  return { control, store, pauseActive, resumeActive }
}

describe('GraphControlService', () => {
  it('replays equivalent reviews and rejects conflicting, unrequired, and premature reviews', async () => {
    const { control, store, resumeActive } = await fixture()
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
    resumeActive.mockClear()
    const reviewed = await control.recordReview('run_review', review, {
      commandId: 'human_review',
      idempotencyKey: 'human_review',
      expectedSeq: submitted.lastEventSeq
    })
    expect(reviewed.reviews).toHaveLength(1)
    expect(resumeActive).toHaveBeenCalledOnce()
    expect(resumeActive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run_review', lastEventSeq: reviewed.lastEventSeq })
    )
    resumeActive.mockClear()
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'human_review_replayed',
      createdAt: '2026-07-29T01:00:00.000Z'
    }, {
      commandId: 'human_review_replay',
      idempotencyKey: 'human_review_replay',
      expectedSeq: submitted.lastEventSeq
    })).resolves.toMatchObject({ id: 'run_review' })
    expect(resumeActive).toHaveBeenCalledOnce()
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'human_review_conflicting_outcome',
      outcome: 'revise',
      repairInstructions: 'Collect the missing evidence.'
    }, {
      commandId: 'human_review_conflicting_outcome',
      idempotencyKey: 'human_review_conflicting_outcome'
    })).rejects.toThrow(/conflicting human review already exists/)
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'human_review_conflicting_content',
      summary: 'A materially different approval.'
    }, {
      commandId: 'human_review_conflicting_content',
      idempotencyKey: 'human_review_conflicting_content'
    })).rejects.toThrow(/conflicting human review already exists/)
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'deterministic_review',
      reviewerKind: 'deterministic'
    }, {
      commandId: 'deterministic_review',
      idempotencyKey: 'deterministic_review'
    }, 'system')).rejects.toThrow(/not required/)

    let advanced = await control.get('run_review')
    for (const [index, event] of [
      {
        type: 'attempt_status_changed' as const,
        payload: {
          nodeId: source.id,
          attemptId: attempt.id,
          from: 'submitted' as const,
          to: 'accepted' as const
        }
      },
      {
        type: 'node_status_changed' as const,
        payload: {
          nodeId: source.id,
          from: 'submitted' as const,
          to: 'accepted' as const,
          reason: 'test review reconciliation'
        }
      }
    ].entries()) {
      advanced = (await store.append(advanced.id, {
        expectedSeq: advanced.lastEventSeq,
        graphRevision: advanced.currentRevision,
        commandId: `advance_review_${index}`,
        idempotencyKey: `advance-review:${index}`,
        event
      })).state
    }
    resumeActive.mockClear()
    await expect(control.recordReview('run_review', {
      ...review,
      reviewId: 'human_review_after_reconciliation',
      createdAt: '2026-07-29T02:00:00.000Z'
    }, {
      commandId: 'human_review_after_reconciliation',
      idempotencyKey: 'human_review_after_reconciliation',
      expectedSeq: submitted.lastEventSeq
    })).resolves.toMatchObject({
      nodes: { [source.id]: expect.objectContaining({ status: 'accepted' }) }
    })
    expect(resumeActive).not.toHaveBeenCalled()
  })

  it('rejects a pass review when host validation is invalid', async () => {
    const { control, store } = await fixture()
    const source = testGraphPlan().nodes[0]!
    await control.create({
      runId: 'run_invalid_review',
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
      commandId: 'create_invalid_review',
      idempotencyKey: 'create_invalid_review'
    })
    const submitted = await submitAttempt(
      control,
      store,
      'run_invalid_review',
      source.id,
      false,
      false
    )
    const attempt = submitted.nodes[source.id]!.attempts.at(-1)!
    await expect(control.recordReview('run_invalid_review', reviewFor(attempt.id), {
      commandId: 'pass_invalid_review',
      idempotencyKey: 'pass_invalid_review'
    })).rejects.toThrow(/cannot pass invalid attempt/)
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
  accept = false,
  validationValid = true
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
          valid: validationValid,
          issues: validationValid
            ? []
            : [{
                code: 'missing_required_artifact',
                path: ['artifactRefs'],
                message: 'required artifact was not published',
                severity: 'error' as const
              }],
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
