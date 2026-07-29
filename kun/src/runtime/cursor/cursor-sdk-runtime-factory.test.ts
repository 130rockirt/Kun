import { describe, expect, test, vi } from 'vitest'
import type {
  AgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage
} from '@cursor/sdk'
import { CapabilityRegistry } from '../../adapters/tool/capability-registry.js'
import { InMemoryApprovalGate } from '../../adapters/in-memory-approval-gate.js'
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
  test('uses the bounded Graph tool catalog and Graph Lead instruction by durable phase', async () => {
    const graphOnly = (context: { orchestration?: string }) =>
      context.orchestration === 'graph'
    const registry = CapabilityRegistry.fromLocalTools([
      LocalToolHost.defineTool({
        name: 'read',
        description: 'Read safely',
        inputSchema: { type: 'object' },
        sideEffect: 'read-only',
        execute: async () => ({ output: 'read' })
      }),
      LocalToolHost.defineTool({
        name: 'write',
        description: 'Write',
        inputSchema: { type: 'object' },
        sideEffect: 'unknown',
        execute: async () => ({ output: 'write' })
      }),
      LocalToolHost.defineTool({
        name: 'graph_define_plan',
        description: 'Define Graph plan',
        inputSchema: { type: 'object' },
        shouldAdvertise: graphOnly,
        execute: async () => ({ output: { status: 'committed' } })
      }),
      LocalToolHost.defineTool({
        name: 'graph_review_node',
        description: 'Review Graph node',
        inputSchema: { type: 'object' },
        shouldAdvertise: graphOnly,
        execute: async () => ({ output: { status: 'accepted' } })
      })
    ])
    const graphTurn = {
      id: 'turn_graph',
      prompt: 'plan with Graph',
      orchestration: 'graph',
      actingModelRoute: {
        model: 'cursor-model',
        providerId: 'cursor-provider'
      },
      graphPlanningLifecycle: {
        version: 1,
        draftId: 'draft_1',
        reservedRunId: 'run_1',
        state: 'planning',
        draftRevision: 1
      }
    }
    const thread = {
      id: 'thread_graph',
      title: 'Cursor Graph',
      workspace: '/tmp/cursor-graph',
      model: 'cursor-model',
      mode: 'agent',
      approvalPolicy: 'auto',
      approvalReviewer: 'user',
      sandboxMode: 'danger-full-access',
      turns: [graphTurn]
    }
    const runtime = createCursorSdkRuntime({
      registry,
      toolHost: new LocalToolHost({ registry }),
      providerConfigs: {},
      providerIds: new Set(['cursor-provider']),
      defaultIsCursor: false,
      defaultModel: 'cursor-model',
      defaultApprovalPolicy: 'auto',
      defaultSandboxMode: 'danger-full-access',
      threadStore: { get: async () => thread } as never,
      sessionStore: {} as never,
      turns: { updateTurnMetadata: async () => undefined } as never,
      events: { record: async () => undefined } as never,
      ids: { next: (prefix) => `${prefix}_1` }
    })
    const loadKunTurnContext = (runtime as unknown as {
      deps: {
        loadKunTurnContext(input: {
          threadId: string
          turnId: string
          userText: string
          actingModelRoute: {
            model: string
            providerId?: string
          }
          signal: AbortSignal
        }): Promise<{
          tools: Array<{ name: string }>
          instructionBlocks: string[]
          customTools: Record<string, {
            execute(
              args: Record<string, unknown>,
              context: { toolCallId: string }
            ): Promise<unknown>
          }>
          graphPhase?: 'planning' | 'supervising'
          graphPlanWasCommitted?: () => boolean
          graphPlanCanRetry?: () => boolean
        }>
      }
    }).deps.loadKunTurnContext
    const input = {
      threadId: 'thread_graph',
      turnId: 'turn_graph',
      userText: 'plan with Graph',
      actingModelRoute: graphTurn.actingModelRoute,
      signal: new AbortController().signal
    }

    const planning = await loadKunTurnContext(input)
    expect(planning.graphPhase).toBe('planning')
    expect(planning.tools.map((tool) => tool.name).sort()).toEqual([
      'graph_define_plan',
      'read'
    ])
    expect(planning.instructionBlocks.join('\n')).toContain(
      'Graph Mode: source Lead operating contract'
    )
    expect(Object.keys(planning.customTools).sort()).toEqual([
      'graph_define_plan',
      'read'
    ])
    expect(planning.graphPlanWasCommitted?.()).toBe(false)
    expect(planning.graphPlanCanRetry?.()).toBe(true)
    await planning.customTools.graph_define_plan!.execute(
      {},
      { toolCallId: 'call_define_plan' }
    )
    expect(planning.graphPlanWasCommitted?.()).toBe(true)
    expect(planning.graphPlanCanRetry?.()).toBe(false)

    graphTurn.graphPlanningLifecycle = {
      ...graphTurn.graphPlanningLifecycle,
      state: 'committed',
      draftRevision: 2
    }
    const supervising = await loadKunTurnContext(input)
    expect(supervising.graphPhase).toBe('supervising')
    expect(supervising.tools.map((tool) => tool.name).sort()).toEqual([
      'graph_review_node',
      'read'
    ])
  })

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
    let bridgedToolResult: unknown
    const debugSink = new LlmDebugRecorder()
    const agent = {
      agentId: 'agent_1',
      model: { id: 'auto' },
      send: async (message: unknown) => {
        sentMessages.push(message)
        bridgedToolResult = await createOptions[0]?.local?.customTools?.mcp_call_tool?.execute(
          { serverId: 'docs' },
          { toolCallId: 'cursor-mcp-call' }
        )
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

    expect(bridgedToolResult).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ server: 'docs', ok: true }, null, 2)
      }]
    })
    await expect(customTools?.mcp_call_tool?.execute(
      { serverId: 'late' },
      { toolCallId: 'cursor-late-call' }
    )).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'tool call aborted before start' }]
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

  test.each([
    {
      decision: 'allow' as const,
      reviewStatus: 'approved' as const,
      executed: true
    },
    {
      decision: 'deny' as const,
      reviewStatus: 'denied' as const,
      executed: false
    }
  ])('routes Cursor Kun tools through agent review ($decision)', async ({
    decision,
    reviewStatus,
    executed
  }) => {
    const execute = vi.fn(async () => ({ output: { published: true } }))
    const registry = new CapabilityRegistry([{
      id: 'mcp:publisher',
      kind: 'mcp',
      enabled: true,
      available: true,
      tools: [LocalToolHost.defineTool({
        name: 'mcp_publish',
        description: 'Publish with MCP',
        inputSchema: { type: 'object' },
        requiresExplicitApproval: true,
        effects: {
          network: true,
          externalWrite: true,
          processExecution: false,
          guiAutomation: false
        },
        execute
      })]
    }])
    const toolHost = new LocalToolHost({ registry })
    const approvalGate = new InMemoryApprovalGate()
    const gateRequest = vi.spyOn(approvalGate, 'request')
    const review = vi.fn(async () => ({
      decision,
      reviewer: 'agent' as const,
      reviewId: 'review_cursor',
      reviewStatus,
      riskLevel: decision === 'allow' ? 'low' as const : 'high' as const,
      reason: decision === 'allow'
        ? 'Action matches intent.'
        : 'Action exceeds intent.'
    }))
    const record = vi.fn(async () => undefined)
    const thread = {
      id: 'thread_cursor_review',
      title: 'Cursor review',
      workspace: '/tmp/cursor-review',
      model: 'cursor-model',
      mode: 'agent',
      approvalPolicy: 'on-request',
      approvalReviewer: 'agent',
      sandboxMode: 'workspace-write',
      turns: [{
        id: 'turn_cursor_review',
        prompt: 'Publish the report',
        approvalReviewer: 'agent',
        actingModelRoute: {
          model: 'cursor-model',
          providerId: 'cursor-provider',
          accountId: 'cursor-account'
        }
      }]
    }
    const runtime = createCursorSdkRuntime({
      registry,
      toolHost,
      providerConfigs: {},
      providerIds: new Set(['cursor-provider']),
      defaultIsCursor: false,
      defaultModel: 'cursor-model',
      defaultApprovalPolicy: 'on-request',
      defaultSandboxMode: 'workspace-write',
      defaultApprovalReviewer: 'agent',
      threadStore: { get: async () => thread } as never,
      sessionStore: {} as never,
      turns: {} as never,
      events: { record } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      approvalGate,
      approvalReview: { review }
    })
    const loadKunTurnContext = (runtime as unknown as {
      deps: {
        loadKunTurnContext(input: {
          threadId: string
          turnId: string
          userText: string
          actingModelRoute: {
            model: string
            providerId?: string
            accountId?: string
          }
          signal: AbortSignal
        }): Promise<{
          customTools: Record<string, {
            execute(
              args: Record<string, unknown>,
              context: { toolCallId?: string }
            ): Promise<unknown>
          }>
        }>
      }
    }).deps.loadKunTurnContext
    const context = await loadKunTurnContext({
      threadId: 'thread_cursor_review',
      turnId: 'turn_cursor_review',
      userText: 'Publish the report',
      actingModelRoute: {
        model: 'cursor-model',
        providerId: 'cursor-provider',
        accountId: 'cursor-account'
      },
      signal: new AbortController().signal
    })
    // A settings/thread edit after the turn starts must not replace the
    // captured reviewer, policy, sandbox, or model route for this invocation.
    Object.assign(thread, {
      approvalPolicy: 'auto',
      approvalReviewer: 'user',
      sandboxMode: 'danger-full-access'
    })
    Object.assign(thread.turns[0]!, {
      approvalReviewer: 'user',
      actingModelRoute: {
        model: 'later-model',
        providerId: 'later-provider',
        accountId: 'later-account'
      }
    })

    const result = await context.customTools.mcp_publish?.execute(
      {
        url: 'https://example.test/publish',
        apiKey: 'sk-cursor-secret-abcdefghijklmnop'
      },
      { toolCallId: 'cursor_call_1' }
    )

    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        model: 'cursor-model',
        providerId: 'cursor-provider',
        accountId: 'cursor-account'
      },
      intent: 'Publish the report',
      approval: expect.objectContaining({
        action: expect.objectContaining({
          providerId: 'mcp:publisher',
          providerKind: 'mcp',
          arguments: expect.objectContaining({ apiKey: '[redacted]' })
        })
      })
    }))
    expect(JSON.stringify(review.mock.calls)).not.toContain('sk-cursor-secret')
    expect(execute).toHaveBeenCalledTimes(executed ? 1 : 0)
    expect(result).toMatchObject(
      executed
        ? { content: [{ type: 'text', text: expect.stringContaining('published') }] }
        : {
            isError: true,
            content: [{
              type: 'text',
              text: expect.stringContaining('Agent reviewer denied')
            }]
          }
    )
    expect(gateRequest).not.toHaveBeenCalled()
    expect(approvalGate.pending()).toEqual([])
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval_requested'
    }))
  })
})
