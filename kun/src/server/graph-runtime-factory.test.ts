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

    await runtime.handleThreadStatus(thread.id, 'archived')
    const archived = await runtime.control.get('run_valid')
    expect(archived.status).toBe('paused')
    await runtime.control.resume('run_valid', {
      commandId: 'command_resume',
      idempotencyKey: 'resume_after_archive',
      expectedSeq: archived.lastEventSeq
    })

    config = testGraphConfig({ enabled: false })
    await runtime.reconfigureBackgroundServices()
    await expect(runtime.control.get('run_valid')).resolves.toMatchObject({
      status: 'paused'
    })
    await runtime.stop()
  })

  it('records legacy source-turn ambiguity without fabricating a replacement Lead', async () => {
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

    const events = await runtime.store.events('run_legacy')
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'supervision_requested',
        payload: expect.objectContaining({
          reason: 'recovery',
          digest: expect.stringContaining('already-terminal source turn')
        })
      })
    }))
    expect(await threadStore.get(thread.id)).toMatchObject({
      turns: [expect.objectContaining({
        id: 'turn_legacy',
        status: 'completed'
      })]
    })
    await runtime.stop()
  })
})
