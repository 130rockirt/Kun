import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNodeAttemptV1, GraphRunV1 } from '../../contracts/index.js'
import { GraphNodeAttemptV1Schema } from '../../contracts/index.js'
import { FileArtifactStore } from '../../artifacts/artifact-store.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { GraphControlService } from '../../graph/graph-control-service.js'
import { FileGraphRunStore } from '../../graph/graph-run-store.js'
import { replayGraphEvents } from '../../graph/graph-reducer.js'
import {
  testGraphEnvelope,
  testGraphPlan,
  testAssignmentSnapshot,
  testGraphConfig
} from '../../graph/graph-test-fixtures.test-support.js'
import {
  buildGraphLeadPatchTool,
  GRAPH_LEAD_PATCH_INPUT_JSON_SCHEMA
} from './graph-lead-patch-tool.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

function context(): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

function failedRun(): GraphRunV1 {
  const run = replayGraphEvents([
    testGraphEnvelope(1, {
      type: 'run_created',
      payload: {
        plan: testGraphPlan(),
        projectId: 'project_1',
        sourceTurnId: 'turn_1'
      }
    })
  ])
  run.threadId = 'thread_1'
  run.nodes.research.status = 'failed'
  run.nodes.research.node.maxAttempts = 3
  run.plans.at(-1)!.nodes.find((node) => node.id === 'research')!.maxAttempts = 3
  run.nodes.research.attempts = Array.from({ length: 3 }, (_, index) => ({
    version: 1,
    id: `attempt_research_${index + 1}`,
    runId: run.id,
    nodeId: 'research',
    revision: 1,
    attemptNumber: index + 1,
    iteration: 0,
    commandId: `command_research_${index + 1}`,
    idempotencyKey: `attempt:research:${index + 1}`,
    status: 'failed',
    assignment: testAssignmentSnapshot(),
    failureClass: 'retryable',
    normalizedFailure: 'Host result normalization failed.',
    queuedAt: `2026-07-30T00:00:0${index}.000Z`,
    finishedAt: `2026-07-30T00:00:0${index + 1}.000Z`,
    tokenUsage: 0,
    elapsedMs: 1
  } satisfies GraphNodeAttemptV1))
  return run
}

describe('Graph Lead patch tool', () => {
  it('advertises semantic input without durable patch mechanics', () => {
    const properties = GRAPH_LEAD_PATCH_INPUT_JSON_SCHEMA.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(['runId', 'reason', 'operations'])
    const serialized = JSON.stringify(GRAPH_LEAD_PATCH_INPUT_JSON_SCHEMA)
    for (const hostField of [
      '"patch"',
      '"expectedSeq"',
      '"patchId"',
      '"commandId"',
      '"baseRevision"',
      '"requester"',
      '"createdAt"'
    ]) {
      expect(serialized).not.toContain(hostField)
    }
    expect(serialized).toContain('supersede_node')
    for (const durableOperationField of [
      '"add_node"',
      '"replace_node"',
      '"update_budget"',
      '"assignment"',
      '"providerId"',
      '"phaseId"',
      '"review"'
    ]) {
      expect(serialized).not.toContain(durableOperationField)
    }
  })

  it('fills host metadata and compiles exhausted work into a fresh replacement', async () => {
    const run = failedRun()
    const applyPatch = vi.fn(async (_runId: string, _patch: unknown) => run)
    const tool = buildGraphLeadPatchTool({
      control: { applyPatch } as never,
      store: { get: async () => run } as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:00.000Z',
      nextId: (prefix) => `${prefix}_unused`
    })

    const result = await tool.execute({
      runId: run.id,
      reason: 'Replace the exhausted audit.',
      operations: [{
        op: 'supersede_node',
        nodeId: 'research',
        title: 'Compact research',
        objective: 'Return a bounded result.',
        acceptanceCriteria: ['The result is concise.'],
        readScopes: ['src'],
        writeScopes: []
      }]
    }, context())

    expect(result.isError).not.toBe(true)
    expect(applyPatch).toHaveBeenCalledOnce()
    expect(applyPatch).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        version: 1,
        patchId: expect.stringMatching(/^graph_patch_[a-f0-9]{24}$/),
        commandId: expect.stringMatching(/^graph_command_[a-f0-9]{24}$/),
        runId: run.id,
        baseRevision: run.currentRevision,
        requester: { kind: 'lead', id: 'turn_1' },
        reason: 'Replace the exhausted audit.',
        createdAt: '2026-07-30T00:00:00.000Z',
        operations: [{
          op: 'replace_node',
          nodeId: 'research',
          replacement: expect.objectContaining({
            id: expect.stringMatching(/^graph_node_[a-f0-9]{20}_1$/),
            title: 'Compact research',
            objective: 'Return a bounded result.',
            readScopes: ['src'],
            writeScopes: [],
            metadata: expect.objectContaining({
              supersedes: 'research',
              leadPatchIntentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
            })
          }),
          supersedesAcceptedWork: false
        }]
      }),
      expect.objectContaining({
        commandId: expect.stringMatching(/^graph_command_[a-f0-9]{24}$/),
        idempotencyKey: expect.stringMatching(/^graph-patch:[a-f0-9]{64}$/),
        expectedSeq: run.lastEventSeq,
        expectedRevision: run.currentRevision
      })
    )
  })

  it('gives an exhausted read-only review only its accepted predecessor repair scopes', async () => {
    const run = failedRun()
    run.nodes.research.status = 'accepted'
    run.nodes.research.node.writeScopes = ['docs']
    run.nodes.finish.node.kind = 'review'
    run.nodes.finish.node.writeScopes = []
    run.nodes.finish.status = 'repair_required'
    run.nodes.finish.attempts = run.nodes.research.attempts.map((attempt, index) => ({
      ...attempt,
      id: `attempt_finish_${index + 1}`,
      nodeId: 'finish',
      attemptNumber: index + 1,
      status: 'repair_required'
    }))
    const applyPatch = vi.fn(async (_runId: string, _patch: unknown) => run)
    const tool = buildGraphLeadPatchTool({
      control: { applyPatch } as never,
      store: { get: async () => run } as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:00.000Z',
      nextId: (prefix) => `${prefix}_unused`
    })

    const result = await tool.execute({
      runId: run.id,
      reason: 'Repair defects found by the read-only review.',
      operations: [{
        op: 'supersede_node',
        nodeId: 'finish',
        objective: 'Apply the reported documentation fixes, then verify them.'
      }]
    }, context())

    expect(result.isError).not.toBe(true)
    const patch = applyPatch.mock.calls[0]?.[1] as {
      operations: Array<{ replacement: { writeScopes: string[] } }>
    }
    expect(patch.operations[0]?.replacement.writeScopes).toEqual(['docs'])

    const expanded = await tool.execute({
      runId: run.id,
      reason: 'Attempt to expand repair authority.',
      operations: [{
        op: 'supersede_node',
        nodeId: 'finish',
        writeScopes: ['.']
      }]
    }, context())
    expect(expanded).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/may only preserve or narrow/) }
    })
  })

  it('deduplicates an identical semantic repair after the first revision commits', async () => {
    let current = failedRun()
    const applyPatch = vi.fn(async (
      _runId: string,
      patch: {
        operations: Array<{
          nodeId: string
          replacement: GraphRunV1['nodes'][string]['node']
        }>
      }
    ) => {
      const operation = patch.operations[0]!
      current = {
        ...current,
        currentRevision: current.currentRevision + 1,
        lastEventSeq: current.lastEventSeq + 1,
        nodes: {
          ...current.nodes,
          [operation.nodeId]: {
            ...current.nodes[operation.nodeId]!,
            status: 'superseded',
            supersededByNodeId: operation.replacement.id
          },
          [operation.replacement.id]: {
            node: operation.replacement,
            status: 'pending',
            attempts: [],
            loopIteration: 0
          }
        }
      }
      return current
    })
    const tool = buildGraphLeadPatchTool({
      control: { applyPatch } as never,
      store: { get: async () => current } as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:00.000Z',
      nextId: (prefix) => `${prefix}_unused`
    })
    const input = {
      runId: current.id,
      reason: 'Replace the exhausted audit.',
      operations: [{ op: 'supersede_node', nodeId: 'research' }]
    }

    const first = await tool.execute(input, context())
    const second = await tool.execute(input, context())

    expect(first.output).toMatchObject({ applied: true, duplicate: false })
    expect(second.output).toMatchObject({
      applied: true,
      duplicate: true,
      replacementNodeIds: [expect.stringMatching(/^graph_node_/)]
    })
    expect(applyPatch).toHaveBeenCalledOnce()
  })

  it('rejects duplicate targets and work with retries remaining', async () => {
    const run = failedRun()
    run.nodes.research.attempts.pop()
    const applyPatch = vi.fn()
    const tool = buildGraphLeadPatchTool({
      control: { applyPatch } as never,
      store: { get: async () => run } as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:00.000Z',
      nextId: (prefix) => `${prefix}_unused`
    })

    const unexhausted = await tool.execute({
      runId: run.id,
      reason: 'Too early.',
      operations: [{ op: 'supersede_node', nodeId: 'research' }]
    }, context())
    expect(unexhausted).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/used 2 of 3 attempts/) }
    })

    run.nodes.research.attempts.push({
      ...run.nodes.research.attempts.at(-1)!,
      id: 'attempt_research_3',
      attemptNumber: 3
    })
    const duplicate = await tool.execute({
      runId: run.id,
      reason: 'Duplicate target.',
      operations: [
        { op: 'supersede_node', nodeId: 'research' },
        { op: 'supersede_node', nodeId: 'research' }
      ]
    }, context())
    expect(duplicate).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/appears more than once/) }
    })
    expect(applyPatch).not.toHaveBeenCalled()
  })

  it('rejects scope expansion and active downstream rewrites', async () => {
    const run = failedRun()
    run.nodes.finish.status = 'running'
    const applyPatch = vi.fn()
    const tool = buildGraphLeadPatchTool({
      control: { applyPatch } as never,
      store: { get: async () => run } as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:00.000Z',
      nextId: (prefix) => `${prefix}_1`
    })

    const activeResult = await tool.execute({
      runId: run.id,
      reason: 'Unsafe replacement.',
      operations: [{ op: 'supersede_node', nodeId: 'research' }]
    }, context())
    expect(activeResult).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/downstream node finish reached running/) }
    })

    run.nodes.finish.status = 'blocked'
    const scopeResult = await tool.execute({
      runId: run.id,
      reason: 'Unsafe scope expansion.',
      operations: [{
        op: 'supersede_node',
        nodeId: 'research',
        readScopes: ['.']
      }]
    }, context())
    expect(scopeResult).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/may only preserve or narrow/) }
    })
    expect(applyPatch).not.toHaveBeenCalled()
  })

  it('commits one revision for concurrent identical repair calls in the real store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-lead-patch-'))
    roots.push(root)
    const config = testGraphConfig()
    let id = 0
    const nextId = (prefix: string) => `${prefix}_${++id}`
    const store = new FileGraphRunStore({
      rootDir: join(root, 'graphs'),
      artifactStore: new FileArtifactStore(join(root, 'artifacts')),
      config: () => config,
      nextId
    })
    const control = new GraphControlService({
      store,
      config: () => config,
      nextId,
      nowIso: () => '2026-07-30T00:00:00.000Z'
    })
    const base = testGraphPlan()
    const plan = testGraphPlan({
      nodes: base.nodes.map((node) =>
        node.id === 'research' ? { ...node, maxAttempts: 3 } : node)
    })
    let run = (await control.create({
      runId: 'run_real_patch',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      plan,
      commandId: 'create_real_patch',
      idempotencyKey: 'create_real_patch'
    })).run
    run = (await store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: 'ready_research',
      idempotencyKey: 'ready_research',
      event: {
        type: 'node_status_changed',
        payload: { nodeId: 'research', from: 'pending', to: 'ready' }
      }
    })).state
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const attempt = GraphNodeAttemptV1Schema.parse({
        version: 1,
        id: `attempt_real_${attemptNumber}`,
        runId: run.id,
        nodeId: 'research',
        revision: run.currentRevision,
        attemptNumber,
        iteration: 0,
        commandId: `attempt_real_${attemptNumber}`,
        idempotencyKey: `attempt:real:${attemptNumber}`,
        status: 'queued',
        assignment: testAssignmentSnapshot(),
        queuedAt: `2026-07-30T00:00:0${attemptNumber}.000Z`,
        tokenUsage: 0,
        elapsedMs: 0
      })
      for (const [suffix, event] of [
        ['created', { type: 'attempt_created' as const, payload: { attempt } }],
        ['attempt_running', {
          type: 'attempt_status_changed' as const,
          payload: {
            nodeId: 'research',
            attemptId: attempt.id,
            from: 'queued' as const,
            to: 'running' as const
          }
        }],
        ['node_running', {
          type: 'node_status_changed' as const,
          payload: {
            nodeId: 'research',
            from: 'queued' as const,
            to: 'running' as const
          }
        }],
        ['attempt_failed', {
          type: 'attempt_status_changed' as const,
          payload: {
            nodeId: 'research',
            attemptId: attempt.id,
            from: 'running' as const,
            to: 'failed' as const,
            failureClass: 'retryable' as const,
            normalizedFailure: 'Host rejected the bounded result.'
          }
        }],
        ['node_failed', {
          type: 'node_status_changed' as const,
          payload: {
            nodeId: 'research',
            from: 'running' as const,
            to: 'failed' as const
          }
        }]
      ] as const) {
        run = (await store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: `${suffix}_${attemptNumber}`,
          idempotencyKey: `${suffix}:${attemptNumber}`,
          event
        })).state
      }
      if (attemptNumber < 3) {
        run = await control.retryNode(run.id, 'research', {
          commandId: `retry_${attemptNumber}`,
          idempotencyKey: `retry:${attemptNumber}`
        })
      }
    }
    const tool = buildGraphLeadPatchTool({
      control,
      store,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      shouldAdvertise: () => true,
      nowIso: () => '2026-07-30T00:00:10.000Z',
      nextId,
      config: () => config
    })
    const input = {
      runId: run.id,
      reason: 'Replace the exhausted screenshot audit.',
      operations: [{
        op: 'supersede_node',
        nodeId: 'research',
        objective: 'Return a bounded audit result.'
      }]
    }

    const results = await Promise.all([
      tool.execute(input, context()),
      tool.execute(input, context())
    ])
    expect(results.every((result) => result.isError !== true)).toBe(true)
    expect(results.map((result) =>
      (result.output as { duplicate: boolean }).duplicate).sort()
    ).toEqual([false, true])

    const revised = (await store.get(run.id))!
    const replacementId = revised.nodes.research.supersededByNodeId!
    expect(revised.currentRevision).toBe(2)
    expect(revised.nodes.research.status).toBe('superseded')
    expect(revised.nodes[replacementId]).toMatchObject({
      status: 'pending',
      attempts: []
    })
    expect(revised.plans.at(-1)!.edges[0]).toMatchObject({
      from: replacementId,
      to: 'finish'
    })
    expect((await store.events(run.id)).filter((event) =>
      event.event.type === 'plan_revised')).toHaveLength(1)
  })
})
