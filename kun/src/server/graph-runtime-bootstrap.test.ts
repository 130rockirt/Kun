import { describe, expect, it, vi } from 'vitest'
import type { CapabilityToolSpec } from '../adapters/tool/capability-registry.js'
import type { GraphRunV1 } from '../contracts/graph.js'
import { GRAPH_WORKER_TOOL_NAMES } from '../graph/graph-tool-boundary.js'
import { createGraphRuntimeStartOptions } from './graph-runtime-bootstrap.js'

function runtimeOptions() {
  const startTurn = vi.fn(async () => ({
    threadId: 'thread_1',
    turnId: 'runtime_turn',
    userMessageItemId: 'item_runtime_user'
  }))
  const runAgentTurn = vi.fn(async () => 'completed' as const)
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
          model: 'source-model',
          providerId: 'source-provider',
          reasoningEffort: 'high'
        }]
      } as never)
    },
    startTurn,
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
  return { options, startTurn, runAgentTurn }
}

const run = {
  id: 'run_1',
  threadId: 'thread_1',
  sourceTurnId: 'turn_1',
  status: 'running',
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

  it('labels automatic supervision for the isolated Graph Lead policy', async () => {
    const { options, startTurn, runAgentTurn } = runtimeOptions()

    await options.leadTurn({
      run,
      reasons: ['failure'],
      nodeIds: ['node_1'],
      digest: 'bounded failure'
    })

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        orchestration: 'direct',
        messageSource: 'graph_runtime',
        disableUserInput: true
      })
    }))
    expect(runAgentTurn).toHaveBeenCalledWith('thread_1', 'runtime_turn')
  })
})
