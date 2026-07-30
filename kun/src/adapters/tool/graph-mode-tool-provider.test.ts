import { describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphValidationResultV1Schema
} from '../../contracts/index.js'
import { GraphPlanValidationError } from '../../graph/graph-validator.js'
import { GraphWorkerSessionRegistry } from '../../graph/graph-worker-sessions.js'
import { replayGraphEvents } from '../../graph/graph-reducer.js'
import {
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import {
  buildGraphModeLocalTools,
  GRAPH_CREATE_RUN_INPUT_JSON_SCHEMA
} from './graph-mode-tool-provider.js'

function context(
  threadId: string,
  orchestration: 'direct' | 'graph' = 'direct',
  messageSource?: 'graph_runtime'
): ToolHostContext {
  return {
    threadId,
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration,
    ...(messageSource ? { messageSource } : {}),
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

function planningDeps() {
  return {
    drafts: {} as never,
    events: { record: vi.fn() } as never
  }
}

describe('Graph Mode tool visibility boundaries', () => {
  it('advertises the lightweight Graph intent schema without durable host fields', () => {
    const properties = GRAPH_CREATE_RUN_INPUT_JSON_SCHEMA.properties as Record<string, unknown>
    const intent = properties.intent as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(intent.required).toEqual(expect.arrayContaining([
      'title',
      'goal',
      'tasks'
    ]))
    expect(intent.required).not.toContain('budget')
    expect(intent.properties).not.toHaveProperty('version')
    expect(intent.properties).not.toHaveProperty('revision')
    expect(intent.properties).not.toHaveProperty('workspaceRoot')
    expect(intent.properties).not.toHaveProperty('autoStart')
    expect(intent.properties).not.toHaveProperty('createdBy')
    expect(intent.properties).not.toHaveProperty('createdAt')
    const budget = intent.properties.budget as {
      required?: string[]
    }
    expect(budget.required ?? []).toEqual([])

    const tasks = intent.properties.tasks as {
      items: { properties: Record<string, unknown>; required: string[] }
    }
    expect(tasks.items.required).toEqual(expect.arrayContaining([
      'id',
      'title',
      'objective'
    ]))
    expect(tasks.items.properties).toHaveProperty('dependsOn')
    expect(tasks.items.properties).toHaveProperty('dataFrom')
    expect(tasks.items.properties).toHaveProperty('readScopes')
    expect(tasks.items.properties).toHaveProperty('writeScopes')
    expect(tasks.items.properties.kind).toMatchObject({
      enum: ['work', 'review', 'integration', 'loop_gate']
    })
    expect(JSON.stringify(intent.properties.strategy)).toContain('fanout_join')
    expect(JSON.stringify(intent.properties.strategy)).toContain('hybrid')
    expect(JSON.stringify(GRAPH_CREATE_RUN_INPUT_JSON_SCHEMA)).not.toContain('"$schema"')
  })

  it('materializes every omitted host budget field and preserves explicit limits', async () => {
    const create = vi.fn(async (input: { plan: ReturnType<typeof testGraphPlan> }) => ({
      run: { id: 'graph_run_1', plan: input.plan },
      validation: { valid: true }
    }))
    const hostConfig = testGraphConfig({
      scheduler: {
        maxNodes: 64,
        maxEdges: 256,
        maxConcurrentNodesPerRun: 3,
        maxAttemptsPerNode: 4,
        maxRevisions: 12,
        maxLoopIterations: 6,
        maxRunWallTimeMs: 7 * 24 * 60 * 60 * 1_000,
        maxNodeWallTimeMs: 24 * 60 * 60 * 1_000,
        maxArtifactBytes: 700_000_000,
        budgetWarningRatio: 0.73
      },
      mailbox: {
        maxMessagesPerRun: 1_337
      }
    })
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {
        allocateId: () => 'graph_run_1',
        create
      } as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/canonical/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true,
      config: () => hostConfig,
      nowIso: () => '2026-07-27T00:00:00.000Z',
      nextId: () => 'graph_command_1'
    })
    const graphCreate = tools.find((tool) => tool.name === 'graph_create_run')!
    const {
      version: _version,
      revision: _revision,
      workspaceRoot: _workspaceRoot,
      autoStart: _autoStart,
      createdBy: _createdBy,
      createdAt: _createdAt,
      ...modelPlan
    } = testGraphPlan()
    const {
      budget: explicitBudget,
      ...planWithoutBudget
    } = modelPlan
    const {
      maxWallTimeMs: explicitRunWallTime,
      maxNodeWallTimeMs: explicitNodeWallTime,
      warningRatio: _explicitWarningRatio,
      ...partialBudgetWithoutWarningOrWallTimes
    } = explicitBudget

    const result = await graphCreate.execute(
      { plan: planWithoutBudget },
      context('lead_thread', 'graph')
    )

    expect(result.isError).not.toBe(true)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'graph_run_1',
      projectId: 'project_1',
      start: true,
      plan: expect.objectContaining({
        version: GRAPH_CONTRACT_VERSION,
        revision: 1,
        workspaceRoot: '/canonical/workspace',
        autoStart: true,
        createdBy: 'lead',
        createdAt: '2026-07-27T00:00:00.000Z',
        budget: {
          maxNodes: 64,
          maxEdges: 256,
          maxConcurrentNodes: 3,
          maxAttemptsPerNode: 4,
          maxRevisions: 12,
          maxLoopIterations: 6,
          maxWallTimeMs: 7 * 24 * 60 * 60 * 1_000,
          maxNodeWallTimeMs: 24 * 60 * 60 * 1_000,
          maxMessages: 1_337,
          maxArtifactBytes: 700_000_000,
          warningRatio: 0.73
        }
      })
    }))
    expect(result.output).toMatchObject({
      executionShape: {
        initialExecutableNodeIds: ['research'],
        initialExecutableNodeCount: 1,
        effectivePerRunConcurrency: 3,
        maximumImmediateDispatchCount: 1
      },
      appliedBudgetDefaultFields: expect.arrayContaining([
        'maxNodes',
        'maxWallTimeMs',
        'maxNodeWallTimeMs',
        'warningRatio'
      ])
    })

    const partialResult = await graphCreate.execute(
      {
        plan: {
          ...planWithoutBudget,
          budget: {
            ...partialBudgetWithoutWarningOrWallTimes,
            maxNodes: 12,
            maxTotalTokens: 800_000
          }
        }
      },
      context('lead_thread', 'graph')
    )
    expect(partialResult.isError).not.toBe(true)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        budget: expect.objectContaining({
          maxNodes: 12,
          maxWallTimeMs: 7 * 24 * 60 * 60 * 1_000,
          maxNodeWallTimeMs: 24 * 60 * 60 * 1_000,
          warningRatio: 0.73
        })
      })
    }))
    expect(create.mock.lastCall?.[0].plan.budget).not.toHaveProperty('maxTotalTokens')

    await graphCreate.execute(
      { plan: modelPlan },
      context('lead_thread', 'graph')
    )
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        budget: expect.objectContaining({
          maxWallTimeMs: explicitRunWallTime,
          maxNodeWallTimeMs: explicitNodeWallTime,
          warningRatio: explicitBudget.warningRatio
        })
      })
    }))
  })

  it('compiles the advertised lightweight intent before durable creation', async () => {
    const create = vi.fn(async (input: { plan: ReturnType<typeof testGraphPlan> }) => ({
      run: { id: 'graph_run_intent', plan: input.plan },
      validation: { valid: true }
    }))
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {
        allocateId: () => 'graph_run_intent',
        create
      } as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true,
      config: () => testGraphConfig(),
      nowIso: () => '2026-07-29T00:00:00.000Z',
      nextId: () => 'graph_command_intent'
    })
    const result = await tools.find((tool) => tool.name === 'graph_create_run')!.execute({
      intent: {
        title: 'Hybrid implementation',
        goal: 'Implement independent runtime and UI work, then integrate.',
        strategy: 'hybrid',
        tasks: [
          {
            id: 'runtime',
            title: 'Runtime',
            objective: 'Implement the runtime contract.',
            readScopes: ['kun/src'],
            writeScopes: ['kun/src']
          },
          {
            id: 'ui',
            title: 'UI',
            objective: 'Implement the UI contract.',
            readScopes: ['src/renderer'],
            writeScopes: ['src/renderer']
          },
          {
            id: 'integrate',
            title: 'Integrate',
            objective: 'Verify the combined result.',
            dependsOn: ['runtime', 'ui'],
            readScopes: ['.']
          }
        ],
        completionTaskIds: ['integrate']
      }
    }, context('lead_thread', 'graph'))

    expect(result.isError).not.toBe(true)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        strategy: {
          kind: 'hybrid',
          selectedBy: 'lead'
        },
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'runtime' }),
          expect.objectContaining({ id: 'ui' }),
          expect.objectContaining({ id: 'integrate' })
        ]),
        edges: [
          expect.objectContaining({ from: 'runtime', to: 'integrate' }),
          expect.objectContaining({ from: 'ui', to: 'integrate' })
        ],
        completionNodeIds: ['integrate']
      })
    }))
    expect(result.output).toMatchObject({
      executionShape: {
        strategy: 'hybrid',
        initialExecutableNodeIds: ['runtime', 'ui'],
        maximumImmediateDispatchCount: 2
      }
    })
  })

  it('reports the realized parallel frontier and diagnoses a non-trivial serial graph', async () => {
    const create = vi.fn(async (input: { plan: ReturnType<typeof testGraphPlan> }) => ({
      run: { id: 'graph_run_shape', plan: input.plan },
      validation: { valid: true }
    }))
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {
        allocateId: () => 'graph_run_shape',
        create
      } as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true,
      config: () => testGraphConfig({
        scheduler: {
          maxConcurrentNodes: 8,
          maxConcurrentNodesPerRun: 4
        }
      })
    })
    const graphCreate = tools.find((tool) => tool.name === 'graph_create_run')!
    const base = testGraphPlan()
    const stripHostFields = (plan: ReturnType<typeof testGraphPlan>) => {
      const {
        version: _version,
        revision: _revision,
        workspaceRoot: _workspaceRoot,
        autoStart: _autoStart,
        createdBy: _createdBy,
        createdAt: _createdAt,
        ...modelPlan
      } = plan
      return modelPlan
    }
    const auditA = { ...base.nodes[0]!, id: 'audit-a', title: 'Audit A' }
    const auditB = { ...base.nodes[0]!, id: 'audit-b', title: 'Audit B' }
    const integrate = { ...base.nodes[1]!, id: 'integrate', title: 'Integrate' }
    const parallelResult = await graphCreate.execute({
      plan: stripHostFields(testGraphPlan({
        nodes: [auditA, auditB, integrate],
        edges: [
          {
            id: 'audit-a-integrate',
            kind: 'control',
            from: 'audit-a',
            to: 'integrate',
            requiredOutcomes: ['accepted']
          },
          {
            id: 'audit-b-integrate',
            kind: 'control',
            from: 'audit-b',
            to: 'integrate',
            requiredOutcomes: ['accepted']
          }
        ],
        completionNodeIds: ['integrate']
      }))
    }, context('lead_thread', 'graph'))
    expect(parallelResult.output).toMatchObject({
      executionShape: {
        initialExecutableNodeIds: ['audit-a', 'audit-b'],
        initialExecutableNodeCount: 2,
        effectivePerRunConcurrency: 4,
        maximumImmediateDispatchCount: 2
      }
    })
    expect((parallelResult.output as {
      executionShape: { diagnostic?: string }
    }).executionShape.diagnostic).toBeUndefined()

    const serialResult = await graphCreate.execute({
      plan: stripHostFields(testGraphPlan({
        nodes: [auditA, auditB, integrate],
        edges: [
          {
            id: 'audit-a-audit-b',
            kind: 'control',
            from: 'audit-a',
            to: 'audit-b',
            requiredOutcomes: ['accepted']
          },
          {
            id: 'audit-b-integrate',
            kind: 'control',
            from: 'audit-b',
            to: 'integrate',
            requiredOutcomes: ['accepted']
          }
        ],
        completionNodeIds: ['integrate']
      }))
    }, context('lead_thread', 'graph'))
    expect(serialResult.output).toMatchObject({
      executionShape: {
        initialExecutableNodeIds: ['audit-a'],
        initialExecutableNodeCount: 1,
        maximumImmediateDispatchCount: 1,
        diagnostic: expect.stringContaining('only one immediate worker')
      }
    })
  })

  it('returns structured retryable issues for guessed or host-owned fields', async () => {
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {} as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true
    })
    const graphCreate = tools.find((tool) => tool.name === 'graph_create_run')!
    const result = await graphCreate.execute(
      {
        plan: {
          version: '1.0',
          title: 'Guessed graph',
          objective: 'Wrong field names',
          phases: [{ id: 'phase', title: 'Phase', nodeIds: ['task'] }],
          nodes: [{ id: 'task', type: 'task' }]
        }
      },
      context('lead_thread', 'graph')
    )

    expect(result).toMatchObject({
      isError: true,
      output: {
        code: 'graph_create_run_schema_invalid',
        error: 'Graph creation arguments do not match the advertised schema.',
        retryable: true,
        guidance: expect.stringContaining('graph_create_run schema')
      }
    })
    const output = result.output as { issues: Array<{ path: unknown[]; code: string; message: string }> }
    expect(output.issues.length).toBeGreaterThan(0)
    expect(output.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['plan'], code: 'unrecognized_keys' })
    ]))
    expect(typeof output.issues[0]?.message).toBe('string')
  })

  it('distinguishes retryable Graph validation from non-retryable host failure', async () => {
    const modelPlan = (() => {
      const {
        version: _version,
        revision: _revision,
        workspaceRoot: _workspaceRoot,
        autoStart: _autoStart,
        createdBy: _createdBy,
        createdAt: _createdAt,
        ...plan
      } = testGraphPlan()
      return plan
    })()
    const validation = GraphValidationResultV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      valid: false,
      issues: [{
        code: 'cycle_detected',
        path: ['edges'],
        message: 'cycle is not bounded',
        severity: 'error'
      }],
      normalizedNodeCount: 2,
      normalizedEdgeCount: 2
    })
    const validationTools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {
        allocateId: () => 'graph_run_1',
        create: async () => {
          throw new GraphPlanValidationError(validation)
        }
      } as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true
    })
    const validationResult = await validationTools
      .find((tool) => tool.name === 'graph_create_run')!
      .execute({ plan: modelPlan }, context('lead_thread', 'graph'))
    expect(validationResult).toMatchObject({
      isError: true,
      output: {
        code: 'graph_create_run_validation_failed',
        retryable: true,
        issues: [{ path: ['edges'], code: 'cycle_detected' }]
      }
    })

    const hostFailureTools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {
        identify: async () => {
          throw new Error('workspace identity unavailable')
        }
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true
    })
    const hostResult = await hostFailureTools
      .find((tool) => tool.name === 'graph_create_run')!
      .execute({ plan: modelPlan }, context('lead_thread', 'graph'))
    expect(hostResult).toMatchObject({
      isError: true,
      output: {
        code: 'graph_create_run_failed',
        error: 'workspace identity unavailable',
        retryable: false
      }
    })
  })

  it('advertises Graph controls only to the owning Lead, never to executors', () => {
    const workerSessions = new GraphWorkerSessionRegistry()
    workerSessions.bind('worker_thread', {
      runId: 'run_1',
      nodeId: 'node_1',
      attemptId: 'attempt_1'
    })
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {} as never,
      artifactStore: {} as never,
      workerSessions,
      enabled: () => true
    })
    const leadNames = new Set([
      'graph_define_plan',
      'graph_control_run',
      'graph_patch_run',
      'graph_review_node',
      'graph_supervise_node'
    ])
    for (const tool of tools) {
      expect(tool.shouldAdvertise?.(context('direct_thread'))).toBe(false)
      expect(tool.shouldAdvertise?.(context('lead_thread', 'graph'))).toBe(
        leadNames.has(tool.name)
      )
      expect(tool.shouldAdvertise?.(context('runtime_thread', 'direct', 'graph_runtime'))).toBe(
        leadNames.has(tool.name) && tool.name !== 'graph_define_plan'
      )
      expect(tool.shouldAdvertise?.(context('worker_thread', 'graph'))).toBe(
        tool.name === 'report_to_parent'
      )
    }
  })

  it('safe-disable hides every Graph tool without losing durable state', () => {
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {} as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => false
    })
    expect(tools.every((tool) =>
      tool.shouldAdvertise?.(context('lead_thread', 'graph')) === false)).toBe(true)
  })

  it('rejects Lead access from a thread that does not own the GraphRun', async () => {
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
    const tools = buildGraphModeLocalTools({
      ...planningDeps(),
      control: {
        get: async () => run
      } as never,
      store: {
        get: async () => run
      } as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true
    })
    const inspect = tools.find((tool) => tool.name === 'graph_control_run')!
    const result = await inspect.execute(
      { action: 'inspect', runId: run.id },
      context('other_thread', 'graph')
    )
    expect(result).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/does not own/) }
    })
  })
})
