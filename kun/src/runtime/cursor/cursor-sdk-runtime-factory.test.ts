import { describe, expect, test, vi } from 'vitest'
import type {
  AgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage
} from '@cursor/sdk'
import { CapabilityRegistry } from '../../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../../adapters/tool/local-tool-host.js'
import { LlmDebugRecorder } from '../../services/llm-debug-recorder.js'
import {
  createCursorSdkRuntime,
  type CursorSdkRuntimeFactoryDeps
} from './cursor-sdk-runtime-factory.js'
import type { CursorSdkApi } from './cursor-sdk-runtime.js'

function messages(values: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  return (async function* () {
    for (const value of values) yield value
  })()
}

function completedRun(): Run {
  const result: RunResult = {
    id: 'run_1',
    status: 'finished',
    result: 'done'
  }
  return {
    id: 'run_1',
    agentId: 'agent_1',
    supports: (operation) => operation === 'stream' || operation === 'wait' || operation === 'cancel',
    unsupportedReason: () => undefined,
    stream: () => messages([{
      type: 'assistant',
      agent_id: 'agent_1',
      run_id: 'run_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    }]),
    conversation: async () => [],
    wait: async () => result,
    cancel: async () => undefined,
    status: result.status,
    onDidChangeStatus: () => () => undefined,
    result: result.result,
    error: undefined,
    model: undefined,
    durationMs: undefined,
    usage: undefined,
    git: undefined,
    createdAt: 1
  }
}

describe('Cursor SDK runtime factory', () => {
  test('bridges policy-filtered MCP and extension tools through Kun ToolHost', async () => {
    const mcpExecute = vi.fn(async (args: Record<string, unknown>) => ({
      output: { server: args.serverId, ok: true }
    }))
    const extensionExecute = vi.fn(async () => ({ output: 'extension result' }))
    const registry = new CapabilityRegistry([{
      id: 'mcp:facade',
      kind: 'mcp',
      enabled: true,
      available: true,
      tools: [LocalToolHost.defineTool({
        name: 'mcp_call_tool',
        description: 'Call an MCP tool through Kun',
        inputSchema: {
          type: 'object',
          properties: { serverId: { type: 'string' } },
          required: ['serverId']
        },
        sideEffect: 'read-only',
        execute: mcpExecute
      })]
    }, {
      id: 'extension:demo',
      kind: 'extension',
      enabled: true,
      available: true,
      tools: [LocalToolHost.defineTool({
        name: 'extension_render',
        description: 'Render through a Kun extension',
        inputSchema: { type: 'object' },
        execute: extensionExecute
      })]
    }])
    const toolHost = new LocalToolHost({ registry })
    const createOptions: AgentOptions[] = []
    const sentMessages: unknown[] = []
    const recorded: unknown[] = []
    const updatedMetadata: unknown[] = []
    const debugSink = new LlmDebugRecorder()
    const agent = {
      agentId: 'agent_1',
      model: { id: 'auto' },
      send: async (message: unknown) => {
        sentMessages.push(message)
        return completedRun()
      },
      close: vi.fn(),
      reload: async () => undefined,
      listArtifacts: async () => [],
      downloadArtifact: async () => Buffer.alloc(0),
      [Symbol.asyncDispose]: async () => undefined
    } as SDKAgent
    const sdk: CursorSdkApi = {
      Agent: {
        create: async (options) => {
          createOptions.push(options)
          return agent
        },
        resume: async () => agent
      }
    }
    const thread = {
      id: 'thread_1',
      title: 'Cursor bridge',
      workspace: '/tmp/cursor-bridge',
      model: 'auto',
      mode: 'agent',
      approvalPolicy: 'always',
      sandboxMode: 'workspace-write',
      systemPrompt: 'Thread persona',
      turns: [{ id: 'turn_1', model: 'auto', mode: 'agent' }]
    }
    const userItem = {
      id: 'user_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      role: 'user',
      status: 'completed',
      createdAt: '2026-07-25T00:00:00.000Z',
      kind: 'user_message',
      text: 'Use the MCP server'
    }
    const approvalGate = {
      request: vi.fn(async () => 'allow' as const),
      decide: vi.fn(() => true),
      reserveDecision: vi.fn(() => true),
      commitDecision: vi.fn(() => true),
      rollbackDecision: vi.fn(() => true),
      expire: vi.fn(() => true),
      pending: vi.fn(() => []),
      get: vi.fn(() => undefined)
    }
    const runtime = createCursorSdkRuntime({
      registry,
      toolHost,
      providerConfigs: {
        'cursor-subscription': { kind: 'cursor-sdk', apiKey: 'cursor-secret' }
      },
      providerIds: new Set(['cursor-subscription']),
      defaultIsCursor: false,
      defaultModel: 'auto',
      defaultApprovalPolicy: 'always',
      defaultSandboxMode: 'workspace-write',
      systemPrompt: 'Kun canonical system prompt',
      threadStore: { get: async () => thread } as never,
      sessionStore: {
        loadItems: async () => [userItem],
        loadEventsSince: async () => []
      } as never,
      turns: {
        applyItem: async () => undefined,
        updateItem: async () => undefined,
        updateTurnMetadata: async (_threadId: string, _turnId: string, metadata: unknown) => {
          updatedMetadata.push(metadata)
        },
        finishTurn: async () => undefined
      } as never,
      events: {
        record: async (event: unknown) => {
          recorded.push(event)
          return event
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      debugSink,
      approvalGate,
      instructionRuntime: {
        resolveTurn: async () => ({
          instruction: 'Workspace AGENTS.md instruction',
          sources: [{ kind: 'workspace', path: '/tmp/cursor-bridge/AGENTS.md' }],
          injectedBytes: 31
        })
      } as never,
      loadSdk: async () => sdk
    } satisfies CursorSdkRuntimeFactoryDeps)

    await expect(runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    const customTools = createOptions[0]?.local?.customTools
    expect(Object.keys(customTools ?? {}).sort()).toEqual([
      'extension_render',
      'mcp_call_tool'
    ])
    expect(String(sentMessages[0])).toContain('Kun canonical system prompt')
    expect(String(sentMessages[0])).toContain('Thread persona')
    expect(String(sentMessages[0])).toContain('Workspace AGENTS.md instruction')
    expect(String(sentMessages[0])).toContain('Kun-managed tools are available')
    expect(updatedMetadata).toContainEqual(expect.objectContaining({
      instructionInjectionBytes: 31
    }))

    await expect(customTools?.mcp_call_tool?.execute(
      { serverId: 'docs' },
      { toolCallId: 'cursor-mcp-call' }
    )).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ server: 'docs', ok: true }, null, 2)
      }]
    })
    expect(mcpExecute).toHaveBeenCalledWith(
      { serverId: 'docs' },
      expect.objectContaining({
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/cursor-bridge',
        approvalPolicy: 'always',
        sandboxMode: 'workspace-write'
      }),
      expect.any(Function)
    )
    expect(approvalGate.request).toHaveBeenCalled()
    expect(recorded).toContainEqual(expect.objectContaining({
      kind: 'approval_requested',
      toolName: 'mcp_call_tool'
    }))
    expect(recorded).toContainEqual(expect.objectContaining({
      kind: 'delegated_runtime',
      capabilities: expect.objectContaining({
        kunTools: true,
        externalApproval: true
      })
    }))

    const trace = debugSink.snapshot()[0]?.exchanges[0]
    expect(trace?.toolCatalog).toEqual(expect.arrayContaining([
      {
        name: 'mcp_call_tool',
        providerId: 'mcp:facade',
        providerKind: 'mcp'
      },
      {
        name: 'extension_render',
        providerId: 'extension:demo',
        providerKind: 'extension'
      }
    ]))
  })
})
