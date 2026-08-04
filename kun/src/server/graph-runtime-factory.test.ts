import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemoryArtifactStore } from '../artifacts/artifact-store.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import { GRAPH_CONTRACT_VERSION, type GraphRunV1 } from '../contracts/graph.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { GraphRunConflictError } from '../graph/graph-run-store.js'
import {
  testGraphConfig,
  testGraphPlan
} from '../graph/graph-test-fixtures.test-support.js'
import { GraphRuntimeComposition } from './graph-runtime-factory.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

async function transitionRun(
  runtime: GraphRuntimeComposition,
  run: GraphRunV1,
  to: GraphRunV1['status'],
  commandId: string
): Promise<GraphRunV1> {
  return (await runtime.store.append(run.id, {
    expectedSeq: run.lastEventSeq,
    graphRevision: run.currentRevision,
    commandId,
    idempotencyKey: commandId,
    event: {
      type: 'run_status_changed',
      payload: { from: run.status, to }
    }
  })).state
}

async function recordFinalSummary(
  runtime: GraphRuntimeComposition,
  run: GraphRunV1,
  commandId: string
): Promise<GraphRunV1> {
  return (await runtime.store.append(run.id, {
    expectedSeq: run.lastEventSeq,
    graphRevision: run.currentRevision,
    commandId,
    idempotencyKey: commandId,
    event: {
      type: 'run_summary_recorded',
      payload: {
        summary: {
          version: GRAPH_CONTRACT_VERSION,
          finalAnswer: 'A stale Graph report was persisted before later work.',
          evidenceRefs: [],
          unresolvedRisks: [],
          changedFiles: [],
          validationResults: [],
          totalTokens: 0,
          totalElapsedMs: 0,
          completedAt: '2026-07-26T00:00:00.000Z'
        }
      }
    }
  })).state
}

describe('GraphRuntimeComposition creation authority', () => {
  it('binds HTTP/tool creation inputs to the canonical parent thread and source turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-runtime-authority-'))
    const workspace = join(root, 'workspace')
    const otherWorkspace = join(root, 'other')
    await Promise.all([mkdir(workspace), mkdir(otherWorkspace)])
    roots.push(root)
    let config: GraphRuntimeConfig = testGraphConfig()
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_1',
      title: 'Graph authority',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert({
      ...thread,
      turns: [
        createTurnRecord({
          id: 'turn_1',
	          threadId: thread.id,
	          prompt: 'Build a graph.',
	          orchestration: 'graph',
	          status: 'running'
        }),
        createTurnRecord({
          id: 'turn_direct',
          threadId: thread.id,
          prompt: 'Run directly.'
        })
      ]
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => config,
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-26T00:00:00.000Z'
    })
    const identity = await runtime.registry.identify(workspace)
    const base = {
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: 'turn_1',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'command_create',
      idempotencyKey: 'create'
    }

    await expect(runtime.control.create({
      ...base,
      runId: 'run_bad_turn',
      sourceTurnId: 'turn_missing'
    })).rejects.toBeInstanceOf(GraphRunConflictError)
    await expect(runtime.control.create({
      ...base,
      runId: 'run_direct_turn',
      sourceTurnId: 'turn_direct'
    })).rejects.toThrow(/not authorized/)
    await expect(runtime.control.create({
      ...base,
      runId: 'run_bad_workspace',
      plan: testGraphPlan({ workspaceRoot: otherWorkspace })
    })).rejects.toThrow(/workspace must match/)
    await expect(runtime.control.create({
      ...base,
      runId: 'run_bad_project',
      projectId: 'project_forged'
    })).rejects.toThrow(/project id/)

    await expect(runtime.control.create({
      ...base,
      runId: 'run_valid'
    })).resolves.toMatchObject({ run: { status: 'ready' } })

    let completing = await runtime.control.get('run_valid')
    completing = await transitionRun(runtime, completing, 'running', 'start_run_valid')
    completing = await transitionRun(runtime, completing, 'completing', 'complete_run_valid')
    await runtime.handleSourceTurnTerminal(thread.id, 'turn_1', 'aborted')
    await expect(runtime.control.get('run_valid')).resolves.toMatchObject({
      status: 'completing'
    })

    // A stale summary must not fence later unfinished Graph work from a
    // passive source-turn cancellation.
    await runtime.control.create({
      ...base,
      runId: 'run_summarized',
      commandId: 'command_create_summarized',
      idempotencyKey: 'create_summarized'
    })
    let summarized = await runtime.control.get('run_summarized')
    summarized = await transitionRun(runtime, summarized, 'running', 'start_run_summarized')
    summarized = await transitionRun(runtime, summarized, 'completing', 'complete_run_summarized')
    summarized = await recordFinalSummary(runtime, summarized, 'summarize_run_summarized')
    summarized = await transitionRun(
      runtime,
      summarized,
      'awaiting_supervision',
      'hold_summarized_run_for_recovery'
    )
    await runtime.handleSourceTurnTerminal(thread.id, 'turn_1', 'failed')
    await expect(runtime.control.get('run_summarized')).resolves.toMatchObject({
      status: 'cancelled',
      summary: { finalAnswer: 'A stale Graph report was persisted before later work.' }
    })

    await runtime.control.create({
      ...base,
      runId: 'run_active',
      commandId: 'command_create_active',
      idempotencyKey: 'create_active'
    })
    let active = await runtime.control.get('run_active')
    active = await transitionRun(runtime, active, 'running', 'start_run_active')
    await runtime.handleSourceTurnTerminal(thread.id, 'turn_1', 'aborted')
    await expect(runtime.control.get(active.id)).resolves.toMatchObject({
      status: 'cancelled'
    })

    await runtime.handleSourceTurnTerminal(thread.id, 'turn_1', 'aborted', {
      forceCancel: true
    })
    await expect(runtime.control.get('run_valid')).resolves.toMatchObject({
      status: 'cancelled'
    })

    await runtime.control.create({
      ...base,
      runId: 'run_archived',
      commandId: 'command_create_archived',
      idempotencyKey: 'create_archived'
    })
    await runtime.handleThreadStatus(thread.id, 'archived')
    const archived = await runtime.control.get('run_archived')
    expect(archived.status).toBe('paused')
    await runtime.control.resume('run_archived', {
      commandId: 'command_resume',
      idempotencyKey: 'resume_after_archive',
      expectedSeq: archived.lastEventSeq
    })

    config = testGraphConfig({ enabled: false })
    await runtime.reconfigureBackgroundServices()
    await expect(runtime.control.get('run_archived')).resolves.toMatchObject({
      status: 'paused'
    })
    await runtime.stop()
  })

  it('cancels a legacy nonterminal run owned by an already-terminal source turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-runtime-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_legacy',
      title: 'Legacy Graph recovery',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert({
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_legacy',
        threadId: thread.id,
	        prompt: 'Build a graph.',
	        orchestration: 'graph',
	        status: 'running'
      })]
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => testGraphConfig(),
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-26T00:00:00.000Z'
    })
    const identity = await runtime.registry.identify(workspace)
	    await runtime.control.create({
      runId: 'run_legacy',
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: 'turn_legacy',
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'command_create_legacy',
	      idempotencyKey: 'create_legacy'
	    })
	    const createdThread = (await threadStore.get(thread.id))!
	    await threadStore.upsert({
	      ...createdThread,
	      turns: createdThread.turns.map((turn) =>
	        turn.id === 'turn_legacy'
	          ? { ...turn, status: 'completed' as const }
	          : turn)
	    })
	    const leadTurn = vi.fn(async () => undefined)

    await runtime.start({
      delegation: () => undefined,
      leadTurn,
      authorityForRun: () => ({
        workspaceRoot: workspace,
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
      })
    })

    await expect(runtime.control.get('run_legacy')).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(leadTurn).not.toHaveBeenCalled()
    expect(await threadStore.get(thread.id)).toMatchObject({
      turns: [expect.objectContaining({
        id: 'turn_legacy',
        status: 'completed'
      })]
    })
    await runtime.stop()
  })

  it('finishes an interrupted committing draft once with its reserved run id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-planning-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_planning',
      title: 'Planning recovery',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert({
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_planning',
        threadId: thread.id,
        prompt: 'Build a graph.',
        orchestration: 'graph',
        status: 'running'
      })]
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => testGraphConfig(),
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-29T00:00:00.000Z'
    })
    const identity = await runtime.registry.identify(workspace)
    const draft = await runtime.drafts.create({
      id: 'draft_recovery',
      reservedRunId: 'run_reserved',
      threadId: thread.id,
      sourceTurnId: 'turn_planning',
      projectId: identity.projectId,
      goal: 'Build a graph.'
    })
    await runtime.drafts.writeCommitPlan(
      draft.id,
      testGraphPlan({ workspaceRoot: workspace, autoStart: true })
    )
    await runtime.drafts.update(draft.id, {
      expectedRevision: draft.revision,
      status: 'committing'
    })

    await runtime.start({
      delegation: () => undefined,
      leadTurn: async () => undefined,
      authorityForRun: () => ({
        workspaceRoot: workspace,
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
      })
    })

    await expect(runtime.control.get('run_reserved')).resolves.toMatchObject({
      id: 'run_reserved'
    })
    await expect(runtime.drafts.require('draft_recovery')).resolves.toMatchObject({
      status: 'committed',
      committedRunId: 'run_reserved'
    })
    expect((await runtime.control.list({ threadId: thread.id }))
      .filter((run) => run.sourceTurnId === 'turn_planning')).toHaveLength(1)
    await runtime.stop()
  })

  it('retries a Stop cancellation when planning advances the draft revision concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-draft-cancel-cas-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_draft_cancel_cas',
      title: 'Draft cancel CAS',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert({
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_draft_cancel_cas',
        threadId: thread.id,
        prompt: 'Build a graph.',
        orchestration: 'graph',
        status: 'running'
      })]
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => testGraphConfig(),
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: {
        record: vi.fn(async () => {
          throw new Error('planning projection unavailable')
        })
      },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-30T16:00:00.000Z'
    })
    const draft = await runtime.createPlanningDraft({
      threadId: thread.id,
      sourceTurnId: 'turn_draft_cancel_cas',
      goal: 'Build a graph.',
      workspace
    })
    expect(await runtime.drafts.list({ threadId: thread.id })).toHaveLength(1)
    const update = runtime.drafts.update.bind(runtime.drafts)
    let collided = false
    vi.spyOn(runtime.drafts, 'update').mockImplementation(async (draftId, input) => {
      if (!collided && input.status === 'cancelled') {
        collided = true
        const current = await runtime.drafts.require(draftId)
        await update(draftId, {
          expectedRevision: current.revision,
          status: 'validating',
          issues: []
        })
      }
      return update(draftId, input)
    })

    await expect(runtime.transitionPlanningDraft({
      threadId: thread.id,
      sourceTurnId: 'turn_draft_cancel_cas',
      action: 'cancel'
    })).resolves.toMatchObject({
      draftId: draft.draftId,
      state: 'cancelled',
      draftRevision: 3
    })
    expect(collided).toBe(true)
    expect(await runtime.control.list({ threadId: thread.id })).toEqual([])
  })

  it('starts a committed ready run left by a crash between draft commit and start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-ready-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_ready_recovery',
      title: 'Ready Graph recovery',
      workspace,
      model: 'test-model'
    })
    await threadStore.upsert({
      ...thread,
      turns: [
        createTurnRecord({
          id: 'turn_ready_recovery',
          threadId: thread.id,
          prompt: 'Build a graph.',
          orchestration: 'graph',
          status: 'running'
        }),
        createTurnRecord({
          id: 'turn_cancelled_recovery',
          threadId: thread.id,
          prompt: 'Cancel this graph.',
          orchestration: 'graph',
          status: 'running'
        }),
        createTurnRecord({
          id: 'turn_missing_recovery',
          threadId: thread.id,
          prompt: 'Recover a missing graph.',
          orchestration: 'graph',
          status: 'running'
        })
      ]
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => testGraphConfig(),
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-29T00:10:00.000Z'
    })
    const identity = await runtime.registry.identify(workspace)
    const draft = await runtime.drafts.create({
      id: 'draft_ready_recovery',
      reservedRunId: 'run_ready_recovery',
      threadId: thread.id,
      sourceTurnId: 'turn_ready_recovery',
      projectId: identity.projectId,
      goal: 'Build a graph.'
    })
    const plan = testGraphPlan({ workspaceRoot: workspace, autoStart: true })
    const ready = (await runtime.control.create({
      runId: draft.reservedRunId,
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: 'turn_ready_recovery',
      plan,
      commandId: 'create_ready_recovery',
      idempotencyKey: 'create_ready_recovery',
      start: false
    })).run
    expect(ready.status).toBe('ready')
    await runtime.drafts.update(draft.id, {
      expectedRevision: draft.revision,
      status: 'committed',
      committedRunId: ready.id
    })
    const cancelledDraft = await runtime.drafts.create({
      id: 'draft_cancelled_recovery',
      reservedRunId: 'run_cancelled_recovery',
      threadId: thread.id,
      sourceTurnId: 'turn_cancelled_recovery',
      projectId: identity.projectId,
      goal: 'Cancel this graph.'
    })
    const cancelledReady = (await runtime.control.create({
      runId: cancelledDraft.reservedRunId,
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: 'turn_cancelled_recovery',
      plan,
      commandId: 'create_cancelled_recovery',
      idempotencyKey: 'create_cancelled_recovery',
      start: false
    })).run
    await runtime.drafts.update(cancelledDraft.id, {
      expectedRevision: cancelledDraft.revision,
      status: 'cancelled'
    })
    const missingDraft = await runtime.drafts.create({
      id: 'draft_missing_recovery',
      reservedRunId: 'run_missing_recovery',
      threadId: thread.id,
      sourceTurnId: 'turn_missing_recovery',
      projectId: identity.projectId,
      goal: 'Recover a missing graph.'
    })
    await runtime.drafts.update(missingDraft.id, {
      expectedRevision: missingDraft.revision,
      status: 'committed',
      committedRunId: missingDraft.reservedRunId
    })

    await runtime.start({
      delegation: () => undefined,
      leadTurn: async () => undefined,
      authorityForRun: () => ({
        workspaceRoot: workspace,
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
      })
    })

    await expect(runtime.control.get(ready.id)).resolves.not.toMatchObject({
      status: 'ready'
    })
    await expect(runtime.control.get(cancelledReady.id)).resolves.toMatchObject({
      status: 'cancelled'
    })
    await expect(runtime.drafts.require(missingDraft.id)).resolves.toMatchObject({
      status: 'host_error',
      issues: [expect.objectContaining({ code: 'graph_committed_run_missing' })]
    })
    await runtime.stop()
  })

  it('wakes a parked Lead once when durable planning is committed but turn metadata is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-planning-lifecycle-recovery-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    roots.push(root)
    let id = 0
    const threadStore = new InMemoryThreadStore()
    const thread = createThreadRecord({
      id: 'thread_stale_planning',
      title: 'Stale planning lifecycle recovery',
      workspace,
      model: 'test-model'
    })
    const sourceTurn = {
      ...createTurnRecord({
        id: 'turn_stale_planning',
        threadId: thread.id,
        prompt: 'Build a graph.',
        orchestration: 'graph',
        status: 'running'
      }),
      graphPlanningLifecycle: {
        version: 1 as const,
        draftId: 'draft_stale_planning',
        reservedRunId: 'run_stale_planning',
        state: 'planning' as const,
        draftRevision: 1
      }
    }
    await threadStore.upsert({ ...thread, turns: [sourceTurn] })
    const config = testGraphConfig({
      supervision: { coalesceWindowMs: 0 }
    })
    const runtime = new GraphRuntimeComposition({
      dataDir: root,
      config: () => config,
      artifactStore: new InMemoryArtifactStore(),
      runtimeEvents: { record: vi.fn(async (event) => event as never) },
      threadStore,
      ids: { next: (prefix) => `${prefix}_${++id}` },
      nowIso: () => '2026-07-30T00:00:00.000Z'
    })
    const identity = await runtime.registry.identify(workspace)
    const draft = await runtime.drafts.create({
      id: 'draft_stale_planning',
      reservedRunId: 'run_stale_planning',
      threadId: thread.id,
      sourceTurnId: sourceTurn.id,
      projectId: identity.projectId,
      goal: 'Build a graph.'
    })
    await runtime.control.create({
      runId: draft.reservedRunId,
      threadId: thread.id,
      projectId: identity.projectId,
      sourceTurnId: sourceTurn.id,
      plan: testGraphPlan({ workspaceRoot: workspace }),
      commandId: 'command_create_stale_planning',
      idempotencyKey: 'create_stale_planning'
    })
    await runtime.drafts.update(draft.id, {
      expectedRevision: draft.revision,
      status: 'committed',
      committedRunId: draft.reservedRunId
    })
    const leadTurn = vi.fn(async () => undefined)

    await runtime.start({
      delegation: () => undefined,
      leadTurn,
      authorityForRun: () => ({
        workspaceRoot: workspace,
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
      })
    })

    await vi.waitFor(() => {
      expect(leadTurn).toHaveBeenCalledWith(expect.objectContaining({
        run: expect.objectContaining({ id: 'run_stale_planning' }),
        reasons: ['recovery'],
        digest: expect.stringContaining('Recovered stale Graph planning lifecycle')
      }))
    })
    await runtime.stop()
  })
})
