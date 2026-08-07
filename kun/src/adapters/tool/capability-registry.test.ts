import { describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost } from './local-tool-host.js'
import { CapabilityRegistry } from './capability-registry.js'

function tool(name: string, sideEffect?: 'read-only' | 'unknown') {
  return LocalToolHost.defineTool({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    policy: 'auto',
    ...(sideEffect ? { sideEffect } : {}),
    execute: async () => ({ output: { ok: true } })
  })
}

function context(
  activeSkillIds: string[],
  threadMode?: 'agent' | 'plan',
  orchestration?: 'direct' | 'graph',
  messageSource?: 'graph_runtime'
): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    ...(threadMode ? { threadMode } : {}),
    ...(orchestration ? { orchestration } : {}),
    ...(messageSource ? { messageSource } : {}),
    activeSkillIds,
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

describe('CapabilityRegistry managed skill policy', () => {
  it('blocks generic shell tools only while PPT Master is active', () => {
    const registry = CapabilityRegistry.fromLocalTools([
      tool('read'),
      tool('bash'),
      tool('background_shell'),
      tool('ppt_master_run')
    ])

    expect(registry.listTools(context([])).map((spec) => spec.name)).toEqual([
      'read', 'bash', 'background_shell', 'ppt_master_run'
    ])
    expect(registry.listTools(context(['ppt-master'])).map((spec) => spec.name)).toEqual([
      'read', 'ppt_master_run'
    ])
    expect(() => registry.resolveTool('bash', context(['ppt-master'])))
      .toThrow('tool bash is not advertised by active tool policy')
    expect(() => registry.resolveTool('background_shell', context(['ppt-master'])))
      .toThrow('tool background_shell is not advertised by active tool policy')
  })
})

describe('CapabilityRegistry Graph orchestration policy', () => {
  const providers = () => [
    {
      id: 'builtin',
      kind: 'built-in' as const,
      enabled: true,
      available: true,
      tools: [
        tool('read', 'read-only'),
        tool('task_graph'),
        tool('design_component'),
        tool('graph_create_run'),
        tool('graph_control_run')
      ]
    },
    {
      id: 'delegation',
      kind: 'delegation' as const,
      enabled: true,
      available: true,
      tools: [tool('delegate_task'), tool('list_subagent_profiles', 'read-only')]
    },
    {
      id: 'explore-agent',
      kind: 'delegation' as const,
      enabled: true,
      available: true,
      tools: [tool('explore_agent', 'read-only')]
    }
  ]

  it('hides and rejects ordinary orchestration tools for Graph user and runtime Lead turns', () => {
    const registry = new CapabilityRegistry(providers())
    const graph = context([], 'agent', 'graph')
    const supervision = context([], 'agent', 'direct', 'graph_runtime')

    for (const current of [graph, supervision]) {
      expect(registry.listTools(current).map((spec) => spec.name)).toEqual([
        'read',
        'graph_create_run',
        'graph_control_run',
        'explore_agent'
      ])
      expect(registry.resolveTool('explore_agent', current).provider.id).toBe('explore-agent')
      for (const name of [
        'delegate_task',
        'list_subagent_profiles',
        'task_graph',
        'design_component'
      ]) {
        expect(() => registry.resolveTool(name, current))
          .toThrow('unavailable in the Graph capability plane')
      }
    }
  })

  it('preserves ordinary delegation and legacy task graphs for direct turns', () => {
    const registry = new CapabilityRegistry(providers())
    const direct = context([], 'agent', 'direct')

    expect(registry.listTools(direct).map((spec) => spec.name)).toEqual([
      'read',
      'task_graph',
      'design_component',
      'graph_create_run',
      'graph_control_run',
      'delegate_task',
      'list_subagent_profiles',
      'explore_agent'
    ])
    expect(registry.resolveTool('delegate_task', direct).provider.kind).toBe('delegation')
    expect(registry.resolveTool('task_graph', direct).provider.id).toBe('builtin')
  })
})

describe('CapabilityRegistry Plan mode policy', () => {
  it('allows host-classified read-only tools and blocks unknown external tools', () => {
    const registry = new CapabilityRegistry([{
      id: 'mcp:test',
      kind: 'mcp',
      enabled: true,
      available: true,
      tools: [tool('mcp_test_lookup', 'read-only'), tool('mcp_test_mutate')]
    }])
    const planContext = context([], 'plan')

    expect(registry.listTools(planContext).map((spec) => spec.name)).toEqual(['mcp_test_lookup'])
    expect(registry.listTools(planContext)[0]).toMatchObject({ sideEffect: 'read-only' })
    expect(() => registry.resolveTool('mcp_test_mutate', planContext))
      .toThrow('tool mcp_test_mutate is not advertised by active tool policy')
  })

  it('keeps read-only explore_agent visible in plan mode while hiding delegate_task', () => {
    const registry = new CapabilityRegistry([
      {
        id: 'delegation',
        kind: 'delegation',
        enabled: true,
        available: true,
        tools: [tool('delegate_task'), tool('list_subagent_profiles', 'read-only')]
      },
      {
        id: 'explore-agent',
        kind: 'delegation',
        enabled: true,
        available: true,
        tools: [tool('explore_agent', 'read-only')]
      }
    ])
    const planContext = context([], 'plan')

    expect(registry.listTools(planContext).map((spec) => spec.name)).toEqual([
      'list_subagent_profiles',
      'explore_agent'
    ])
    expect(() => registry.resolveTool('delegate_task', planContext))
      .toThrow('tool delegate_task is not advertised by active tool policy')
  })
})
