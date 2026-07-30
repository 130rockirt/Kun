import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemoryArtifactStore } from '../artifacts/artifact-store.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
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
          orchestration: 'graph'
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

    await runtime.handleSourceTurnTerminal(thread.id, 'turn_1', 'aborted')
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
        status: 'completed'
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
})
