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

function context(activeSkillIds: string[], threadMode?: 'agent' | 'plan'): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    ...(threadMode ? { threadMode } : {}),
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
})
