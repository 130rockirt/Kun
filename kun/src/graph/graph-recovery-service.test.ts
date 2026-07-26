import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileArtifactStore } from '../artifacts/artifact-store.js'
import { GRAPH_CONTRACT_VERSION, GraphNodeAttemptV1Schema } from '../contracts/graph.js'
import type { ChildRunRecord, DelegationRuntime } from '../delegation/delegation-runtime.js'
import { GraphControlService } from './graph-control-service.js'
import { GraphRecoveryService } from './graph-recovery-service.js'
import { FileGraphRunStore } from './graph-run-store.js'
import { testAssignmentSnapshot, testGraphConfig, testGraphPlan } from './graph-test-fixtures.test-support.js'
import { FileGraphWriteCoordinator } from './graph-write-coordinator.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GraphRecoveryService', () => {
  it('marks interrupted children orphaned, retries within budget, and records visible cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-recovery-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    await control.create({
      runId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_1',
      idempotencyKey: 'create_1',
      start: true
    })
    let run = (await store.get('run_1'))!
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'ready_1',
      idempotencyKey: 'ready_1',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: 'research', from: 'pending', to: 'ready' }
      }
    })).state
    const attempt = GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_1',
      runId: run.id,
      nodeId: 'research',
      revision: 1,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_command_1',
      idempotencyKey: 'attempt_1',
      status: 'queued',
      assignment: {
        ...testAssignmentSnapshot(),
        workspaceRoot: workspace
      },
      childThreadId: 'child_1',
      queuedAt: new Date().toISOString(),
      tokenUsage: 0,
      elapsedMs: 0
    })
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'attempt_created_1',
      idempotencyKey: 'attempt_created_1',
      event: { type: 'attempt_created', payload: { attempt } }
    })).state
    const signal = vi.fn()
    const delegation = {
      reconcileOrphanedChildRuns: vi.fn(async () => 1)
    } as unknown as DelegationRuntime
    const recovery = new GraphRecoveryService({
      store,
      config: () => config,
      writes: new FileGraphWriteCoordinator({
        rootDir: join(root, 'writes'),
        config: () => config,
        nextId
      }),
      delegation: () => delegation,
      supervision: () => ({ signal }),
      nextId
    })

    const report = await recovery.reconcile()
    const recovered = (await store.get('run_1'))!
    expect(report).toMatchObject({
      runsInspected: 1,
      orphanedAttempts: 1,
      retriedNodes: 1,
      orphanedChildRuns: 1
    })
    expect(recovered.nodes.research.status).toBe('ready')
    expect(recovered.nodes.research.attempts[0]?.status).toBe('orphaned')
    expect(recovered.cleanup).toEqual([
      expect.objectContaining({
        resourceKind: 'worker',
        resourceId: 'child_1',
        state: 'orphaned'
      })
    ])
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'recovery',
      nodeIds: ['research']
    }))
  })

  it('recovers a persisted completed child exactly once instead of orphaning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-recovery-complete-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    await control.create({
      runId: 'run_completed_child',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_completed_child',
      idempotencyKey: 'create_completed_child',
      start: true
    })
    let run = (await store.get('run_completed_child'))!
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'ready_completed_child',
      idempotencyKey: 'ready_completed_child',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: 'research', from: 'pending', to: 'ready' }
      }
    })).state
    const attempt = GraphNodeAttemptV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      id: 'attempt_completed_child',
      runId: run.id,
      nodeId: 'research',
      revision: 1,
      attemptNumber: 1,
      iteration: 0,
      commandId: 'attempt_completed_child',
      idempotencyKey: 'attempt_completed_child',
      status: 'queued',
      assignment: {
        ...testAssignmentSnapshot(),
        workspaceRoot: workspace
      },
      childThreadId: 'child_completed',
      queuedAt: new Date().toISOString(),
      tokenUsage: 0,
      elapsedMs: 0
    })
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'attempt_created_completed',
      idempotencyKey: 'attempt_created_completed',
      event: { type: 'attempt_created', payload: { attempt } }
    })).state
    const child = {
      id: 'child_completed',
      parentThreadId: 'thread_1',
      parentTurnId: 'turn_1',
      prompt: 'bounded',
      status: 'completed',
      summary: JSON.stringify({
        summary: 'Recovered verified research.',
        changedFiles: [],
        checks: [],
        evidence: ['persisted child evidence'],
        risks: []
      }),
      evidence: ['persisted child evidence'],
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      durationMs: 25,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      returnFormat: 'evidence'
    } as ChildRunRecord
    const delegation = {
      reconcileOrphanedChildRuns: vi.fn(async () => 0),
      diagnostics: vi.fn(async () => ({
        enabled: true,
        active: 0,
        childRuns: [child],
        aggregates: []
      }))
    } as unknown as DelegationRuntime
    const recovery = new GraphRecoveryService({
      store,
      config: () => config,
      writes: new FileGraphWriteCoordinator({
        rootDir: join(root, 'writes'),
        config: () => config,
        nextId
      }),
      delegation: () => delegation,
      nextId
    })

    const first = await recovery.reconcile()
    const recovered = (await store.get(run.id))!
    expect(first).toMatchObject({
      completedChildrenRecovered: 1,
      orphanedAttempts: 0
    })
    expect(recovered.nodes.research.status).toBe('submitted')
    expect(recovered.nodes.research.attempts[0]).toMatchObject({
      status: 'submitted',
      result: { summary: 'Recovered verified research.' },
      tokenUsage: 12,
      elapsedMs: 25
    })
    expect(recovered.budget.totalTokens).toBe(12)

    const second = await recovery.reconcile()
    expect(second.completedChildrenRecovered).toBe(0)
    expect((await store.events(run.id)).filter((event) =>
      event.event.type === 'result_submitted')).toHaveLength(1)
  })

  it('preserves completing runs so the scheduler can resume finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-recovery-completing-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({ store, config: () => config, nextId })
    const created = await control.create({
      runId: 'run_completing',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'create_completing',
      idempotencyKey: 'create_completing',
      start: true
    })
    await store.append(created.run.id, {
      expectedSeq: created.run.lastEventSeq,
      graphRevision: created.run.currentRevision,
      commandId: 'enter_completing',
      idempotencyKey: 'enter_completing',
      event: {
        type: 'run_status_changed',
        payload: { from: 'running', to: 'completing' }
      }
    })
    const recovery = new GraphRecoveryService({
      store,
      config: () => config,
      writes: new FileGraphWriteCoordinator({
        rootDir: join(root, 'writes'),
        config: () => config,
        nextId
      }),
      delegation: () => undefined,
      nextId
    })
    const report = await recovery.reconcile()
    expect(report.pausedRuns).toBe(0)
    expect((await store.get('run_completing'))?.status).toBe('completing')
  })
})
