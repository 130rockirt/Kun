import { describe, expect, it, vi } from 'vitest'
import type { CapabilityToolSpec } from '../adapters/tool/capability-registry.js'
import type { GraphRunV1 } from '../contracts/graph.js'
import { GRAPH_WORKER_TOOL_NAMES } from '../graph/graph-tool-boundary.js'
import type { TurnRunOutcome } from '../loop/turn-execution-types.js'
import { createGraphRuntimeStartOptions } from './graph-runtime-bootstrap.js'

function runtimeOptions(active = false) {
  const resumeTurn = vi.fn(async () => 'resumed' as const)
  const isTurnExecutionActive = vi.fn(() => active)
  const steerTurn = vi.fn(async () => undefined)
  const runAgentTurn = vi.fn<
    (threadId: string, turnId: string) => Promise<TurnRunOutcome>
  >(async () => 'suspended')
  const options = createGraphRuntimeStartOptions({
    delegation: () => undefined,
    threads: {
      get: async () => ({
        id: 'thread_1',
        workspace: '/workspace',
        model: 'thread-model',
        providerId: 'thread-provider',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        turns: [{
          id: 'turn_1',
          status: 'running',
          model: 'source-model',
          providerId: 'source-provider',
          reasoningEffort: 'high'
        }]
      } as never)
    },
    resumeTurn,
    isTurnExecutionActive,
    steerTurn,
    runAgentTurn,
    defaults: () => ({
      model: 'default-model',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      allowedMcpServers: [],
      disabledSkillIds: [],
      networkAllowed: false
    }),
    tools: (): CapabilityToolSpec[] => [...[
      'read',
      'delegate_task',
      'list_subagent_profiles',
      'task_graph',
      'design_component'
    ].map((name) => ({
      name,
      description: name,
      inputSchema: {},
      providerId: 'builtin',
      providerKind: 'built-in' as const,
      effects: {
        network: false,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      }
    })), {
      name: 'mcp_read',
      description: 'Read-only MCP capability',
      inputSchema: {},
      providerId: 'mcp:facade',
      providerKind: 'mcp' as const,
      effects: {
        network: false,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      }
    }, {
      name: 'unknown_remote',
      description: 'Unclassified remote capability',
      inputSchema: {},
      providerId: 'extension:unknown',
      providerKind: 'extension' as const
    }, {
      name: 'web_fetch',
      description: 'Network capability',
      inputSchema: {},
      providerId: 'web',
      providerKind: 'web' as const,
      effects: {
        network: true,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      }
    }],
    skillIds: () => ['safe-skill']
  })
  return { options, resumeTurn, isTurnExecutionActive, steerTurn, runAgentTurn }
}

const run = {
  id: 'run_1',
  threadId: 'thread_1',
  sourceTurnId: 'turn_1',
  status: 'running',
  lastEventSeq: 12,
  plans: [{ workspaceRoot: '/workspace' }]
} as GraphRunV1

describe('Graph runtime bootstrap capability boundary', () => {
  it('captures Graph-only worker authority while preserving source model routing', async () => {
    const { options } = runtimeOptions()
    const authority = await options.authorityForRun(run)

    expect(authority).toMatchObject({
      model: 'source-model',
      providerId: 'source-provider',
      allowedModelProviderIds: ['source-provider'],
      allowedModels: ['source-model'],
      allowedProviderIds: ['builtin', 'mcp:facade'],
      reasoningEffort: 'high',
      allowedSkills: ['safe-skill']
    })
    expect(authority.allowedTools).toEqual([
      ...GRAPH_WORKER_TOOL_NAMES,
      'mcp_read',
      'read'
    ].sort())
    expect(authority.allowedTools).not.toEqual(expect.arrayContaining([
      'delegate_task',
      'list_subagent_profiles',
      'task_graph',
      'design_component',
      'unknown_remote',
      'web_fetch'
    ]))
  })

  it('resumes the suspended source Lead turn instead of creating a replacement turn', async () => {
    const { options, resumeTurn, steerTurn, runAgentTurn } = runtimeOptions()

    await options.leadTurn({
      run,
      reasons: ['failure'],
      nodeIds: ['node_1'],
      digest: 'bounded failure'
    })

    expect(resumeTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      runId: 'run_1',
      lastDeliveredSeq: 12,
      terminal: false
    })
    expect(steerTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      text: expect.stringContaining('Graph Lead supervision for durable run run_1.'),
      messageSource: 'graph_runtime'
    })
    expect(runAgentTurn).toHaveBeenCalledWith('thread_1', 'turn_1')
  })

  it('steers supervision into the executing source turn without another execution', async () => {
    const { options, resumeTurn, steerTurn, runAgentTurn } = runtimeOptions(true)

    await options.leadTurn({
      run,
      reasons: ['stall'],
      nodeIds: ['node_1'],
      digest: 'No safe child activity for 15 minutes; the attempt remains running.'
    })

    expect(steerTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      text: expect.stringContaining('Graph Lead supervision for durable run run_1.'),
      messageSource: 'graph_runtime'
    })
    expect(resumeTurn).not.toHaveBeenCalled()
    expect(runAgentTurn).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'resumes the original source turn for %s terminal delivery',
    async (status) => {
      const { options, resumeTurn, steerTurn, runAgentTurn } = runtimeOptions()
      runAgentTurn.mockResolvedValueOnce('completed')

      await options.leadTurn({
        run: { ...run, status },
        reasons: ['completion'],
        nodeIds: [],
        digest: `terminal status: ${status}`
      })

      expect(resumeTurn).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'thread_1',
        turnId: 'turn_1',
        runId: 'run_1',
        terminal: true
      }))
      expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
        turnId: 'turn_1',
        text: expect.stringContaining(
          'Present the persisted terminal outcome'
        )
      }))
      expect(runAgentTurn).toHaveBeenCalledOnce()
    }
  )

  it('starts the continuation that reacquired a lease during a suspension race', async () => {
    const { options, isTurnExecutionActive, runAgentTurn } = runtimeOptions()
    isTurnExecutionActive
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    runAgentTurn
      .mockResolvedValueOnce('suspended')
      .mockResolvedValueOnce('suspended')

    await options.leadTurn({
      run,
      reasons: ['help'],
      nodeIds: ['node_1'],
      digest: 'A second signal arrived while the first slice parked.'
    })

    expect(runAgentTurn).toHaveBeenCalledTimes(2)
    expect(runAgentTurn).toHaveBeenNthCalledWith(1, 'thread_1', 'turn_1')
    expect(runAgentTurn).toHaveBeenNthCalledWith(2, 'thread_1', 'turn_1')
  })
})
