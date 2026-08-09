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
  it('durably validates, creates, starts, pauses, resumes, and cancels a run', async () => {
    const { control, store, pauseActive } = await fixture()
    const create = vi.spyOn(store, 'create')
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
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('start')
    expect(created.run.status).toBe('running')
    const paused = await control.pause('run_1', {
      commandId: 'command_pause',
      idempotencyKey: 'pause_1',
      expectedRevision: 1
    })
    expect(paused.status).toBe('paused')
    expect(paused.pendingControlIntent).toBeUndefined()
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
    expect(cancelled.pendingControlIntent).toBeUndefined()
    const statusEvents = (await store.events('run_1'))
      .filter((event) => event.event.type === 'run_status_changed')
    expect(statusEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            to: 'pausing',
            pendingControlIntent: 'pause'
          })
        })
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            to: 'pausing',
            pendingControlIntent: 'cancel'
          })
        })
      })
    ]))
  })

  it('durably upgrades an in-flight pause to cancellation without allowing downgrade', async () => {
    const { control: creator, store } = await fixture()
    await creator.create({
      runId: 'run_pause_cancel_race',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: 'create_pause_cancel_race',
      idempotencyKey: 'create_pause_cancel_race',
      start: true
    })
    let releasePause!: () => void
    let pauseStarted!: () => void
    const pauseEntered = new Promise<void>((resolve) => { pauseStarted = resolve })
    const pauseBlocked = new Promise<void>((resolve) => { releasePause = resolve })
    const concurrent = new GraphControlService({
      store,
      config: () => testGraphConfig(),
      pauseActive: async () => {
        pauseStarted()
        await pauseBlocked
      },
      cancelActive: async () => {
        throw new Error('simulated process exit after cancellation intent')
      }
    })

    const pause = concurrent.pause('run_pause_cancel_race', {
      commandId: 'pause_race',
      idempotencyKey: 'pause_race'
    })
    await pauseEntered
    await expect(concurrent.cancel('run_pause_cancel_race', {
      commandId: 'cancel_race',
      idempotencyKey: 'cancel_race'
    })).rejects.toThrow(/simulated process exit/)
    expect(await store.get('run_pause_cancel_race')).toMatchObject({
      status: 'pausing',
      pendingControlIntent: 'cancel'
    })
    releasePause()
    await expect(pause).rejects.toThrow(/cancellation is pending/)
    expect(await store.get('run_pause_cancel_race')).toMatchObject({
      status: 'pausing',
      pendingControlIntent: 'cancel'
    })
    expect((await store.events('run_pause_cancel_race')).at(-1)?.event).toMatchObject({
      type: 'run_control_intent_changed',
      payload: { from: 'pause', to: 'cancel' }
    })
  })

  it.each([
    ['draft', []],
    ['validating', ['validating']],
    ['ready', ['validating', 'ready']],
    ['running', ['validating', 'ready', 'running']],
    ['paused', ['validating', 'ready', 'paused']],
    ['awaiting_supervision', ['validating', 'ready', 'running', 'awaiting_supervision']],
    ['awaiting_human', ['validating', 'ready', 'running', 'awaiting_human']],
    ['completing', ['validating', 'ready', 'running', 'completing']]
  ] as const)('fences cancellation durably from %s', async (status, transitions) => {
    const { store } = await fixture()
    await store.create({
      runId: `run_cancel_${status}`,
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan(),
      commandId: `create_cancel_${status}`,
      idempotencyKey: `create_cancel_${status}`
    })
    let run = (await store.get(`run_cancel_${status}`))!
    for (const to of transitions) {
      run = (await store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `enter_${to}_${status}`,
        idempotencyKey: `enter_${to}_${status}`,
        event: {
          type: 'run_status_changed',
          payload: { from: run.status, to }
        }
      })).state
    }
    expect(run.status).toBe(status)
    const control = new GraphControlService({
      store,
      config: () => testGraphConfig(),
      cancelActive: async () => {
        throw new Error('simulated exit after durable fence')
      }
    })

    await expect(control.cancel(run.id, {
      commandId: `cancel_${status}`,
      idempotencyKey: `cancel_${status}`
    })).rejects.toThrow(/simulated exit/)
    expect(await store.get(run.id)).toMatchObject({
      status: 'pausing',
      pendingControlIntent: 'cancel'
    })
    expect((await store.events(run.id)).at(-1)?.event).toMatchObject({
      type: 'run_status_changed',
      payload: {
        from: status,
        to: 'pausing',
        pendingControlIntent: 'cancel'
      }
    })
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
  it('enforces the durable Graph revision budget before applying another patch', async () => {
    const { control } = await fixture()
    const base = testGraphPlan()
    const plan = testGraphPlan({
      budget: { ...base.budget, maxRevisions: 1 }
    })
    const created = await control.create({
      runId: 'run_revision_budget',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan,
      commandId: 'create_revision_budget',
      idempotencyKey: 'create_revision_budget'
    })
    const first = await control.applyPatch(created.run.id, {
      version: 1,
      patchId: 'patch_revision_budget_1',
      commandId: 'patch_revision_budget_1',
      runId: created.run.id,
      baseRevision: 1,
      requester: { kind: 'lead', id: 'turn_1' },
      reason: 'Consume the only allowed revision.',
      operations: [{ op: 'update_budget', budget: plan.budget }],
      createdAt: TEST_GRAPH_NOW
    }, {
      commandId: 'patch_revision_budget_1',
      idempotencyKey: 'patch_revision_budget_1'
    })
    expect(first.budget.revisions).toBe(1)
    await expect(control.applyPatch(first.id, {
      version: 1,
      patchId: 'patch_revision_budget_2',
      commandId: 'patch_revision_budget_2',
      runId: first.id,
      baseRevision: 2,
      requester: { kind: 'lead', id: 'turn_1' },
      reason: 'Exceed the allowed revisions.',
      operations: [{ op: 'update_budget', budget: plan.budget }],
      createdAt: TEST_GRAPH_NOW
    }, {
      commandId: 'patch_revision_budget_2',
      idempotencyKey: 'patch_revision_budget_2'
    })).rejects.toThrow(/revision budget exhausted/)
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
    expect(revised.plans.at(-1)!.completionNodeIds).toEqual(['finish_v2'])
    expect(revised.plans.at(-1)!.edges).toEqual([
      expect.objectContaining({ from: 'research', to: 'finish_v2' })
    ])
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
