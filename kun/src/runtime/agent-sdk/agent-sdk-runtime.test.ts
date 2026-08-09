import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AgentSdkCredentialUnavailableError,
  AgentSdkRuntime,
  decideSdkBuiltinSandbox,
  type SdkRuntimeDeps,
  type SdkTurnContext
} from './agent-sdk-runtime.js'
import type { SdkApi, SdkCanUseTool, SdkMessage, SdkQueryResult } from './sdk-protocol.js'
import type { RuntimeEventDraft } from '../../services/runtime-event-recorder.js'
import { LlmDebugRecorder } from '../../services/llm-debug-recorder.js'
import type { TurnItem } from '../../contracts/items.js'

function fakeSdk(messages: SdkMessage[], onQuery?: (opts: unknown) => void): SdkApi {
  const query = (input: { options?: unknown }): SdkQueryResult => {
    onQuery?.(input.options)
    async function* gen(): AsyncGenerator<SdkMessage> {
      for (const m of messages) yield m
    }
    const it = gen() as SdkQueryResult
    it.interrupt = async () => {}
    return it
  }
  return {
    query,
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
    tool: (name) => ({ name })
  }
}

function fakeSdkAttempts(
  attempts: readonly SdkMessage[][],
  onQuery?: (input: { prompt: unknown; options?: unknown }, attempt: number) => void
): SdkApi {
  let attempt = 0
  return {
    query: (input): SdkQueryResult => {
      const current = attempt
      attempt += 1
      onQuery?.(input as { prompt: unknown; options?: unknown }, current)
      async function* gen(): AsyncGenerator<SdkMessage> {
        for (const message of attempts[current] ?? attempts.at(-1) ?? []) yield message
      }
      const stream = gen() as SdkQueryResult
      stream.interrupt = async () => {}
      return stream
    },
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
    tool: (name) => ({ name })
  }
}

type GraphPlanSdkAttempt = {
  arguments?: Record<string, unknown>
  text: string
  sessionId?: string
}

function fakeGraphPlanSdkAttempts(
  attempts: readonly GraphPlanSdkAttempt[],
  onQuery?: (input: { prompt: unknown; options?: unknown }, attempt: number) => void
): SdkApi {
  let attempt = 0
  let graphDefinePlanHandler:
    | ((args: Record<string, unknown>, extra: unknown) => Promise<unknown>)
    | undefined
  return {
    tool: (name, _description, _schema, handler) => {
      if (name === 'graph_define_plan') graphDefinePlanHandler = handler
      return { name }
    },
    createSdkMcpServer: (config) => ({
      type: 'sdk',
      name: config.name,
      instance: {}
    }),
    query: (input): SdkQueryResult => {
      const current = attempt
      attempt += 1
      onQuery?.(input as { prompt: unknown; options?: unknown }, current)
      async function* gen(): AsyncGenerator<SdkMessage> {
        const currentAttempt = attempts[current] ?? attempts.at(-1)
        if (!currentAttempt) return
        if (currentAttempt.arguments) {
          if (!graphDefinePlanHandler) {
            throw new Error('graph_define_plan handler was not registered')
          }
          await graphDefinePlanHandler(currentAttempt.arguments, {})
        }
        if (currentAttempt.sessionId) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: currentAttempt.sessionId
          } as SdkMessage
        }
        yield* svgSdkTextAttempt(currentAttempt.text)
      }
      const stream = gen() as SdkQueryResult
      stream.interrupt = async () => {}
      return stream
    }
  }
}

function stalledSdk(onStarted: () => void, onInterrupt: () => void): SdkApi {
  return {
    query: (): SdkQueryResult => {
      onStarted()
      const stream = {
        next: () => new Promise<IteratorResult<SdkMessage>>(() => {}),
        [Symbol.asyncIterator]: () => stream,
        interrupt: async () => { onInterrupt() }
      } as SdkQueryResult
      return stream
    },
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
    tool: () => ({})
  }
}

type SvgSdkToolResult = {
  name: 'design_svg_edit' | 'design_svg_animate' | 'design_svg_validate'
  id: string
  output: unknown
  isError?: boolean
}

function svgSdkAttempt(results: readonly SvgSdkToolResult[], finalText = 'done'): SdkMessage[] {
  return [
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: results.map((entry) => ({
          type: 'tool_use' as const,
          id: entry.id,
          name: `mcp__kun__${entry.name}`,
          input: {}
        }))
      }
    } as SdkMessage,
    {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: results.map((entry) => ({
          type: 'tool_result' as const,
          tool_use_id: entry.id,
          content: JSON.stringify(entry.output),
          ...(entry.isError ? { is_error: true } : {})
        }))
      }
    } as SdkMessage,
    {
      type: 'result', subtype: 'success', is_error: false, result: finalText,
      num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
    } as SdkMessage
  ]
}

function svgSdkTextAttempt(text = 'done'): SdkMessage[] {
  return [
    {
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    } as SdkMessage,
    {
      type: 'result', subtype: 'success', is_error: false, result: text,
      num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
    } as SdkMessage
  ]
}

function svgSdkContext(): SdkTurnContext {
  return {
    workspace: '/ws',
    userText: 'make the reserved svg',
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    allowSdkBuiltins: false,
    requireSvgCompletion: true,
    bridgeableTools: [
      { name: 'design_svg_edit', description: 'edit', inputSchema: {} },
      { name: 'design_svg_animate', description: 'animate', inputSchema: {} },
      { name: 'design_svg_validate', description: 'validate', inputSchema: {} }
    ]
  }
}

function makeDeps(overrides: Partial<SdkRuntimeDeps> = {}): {
  deps: SdkRuntimeDeps
  events: RuntimeEventDraft[]
  items: TurnItem[]
  finished: Array<{ status: string; error?: string; code?: string }>
  sessions: string[]
} {
  const events: RuntimeEventDraft[] = []
  const items: TurnItem[] = []
  const finished: Array<{ status: string; error?: string; code?: string }> = []
  const sessions: string[] = []
  let n = 0
  const ctx: SdkTurnContext = {
    workspace: '/ws',
    userText: 'hello',
    approvalPolicy: 'auto',
    bridgeableTools: [{ name: 'generate_image', description: 'gen', inputSchema: {} }]
  }
  const deps: SdkRuntimeDeps = {
    handlesProvider: (id) => id === 'claude-sub',
    loadTurnContext: async () => ctx,
    executeKunTool: async () => ({ output: 'tool-ok' }),
    decideToolApproval: async () => ({ allow: true }),
    recordEvent: async (d) => {
      events.push(d)
    },
    applyItem: async (_t, item) => {
      items.push(item)
    },
    applyAssistantDelta: async (threadId, item, deltaText, deltaOffset) => {
      if (item.kind === 'assistant_text') {
        events.push({
          kind: 'assistant_text_delta',
          threadId,
          turnId: item.turnId,
          itemId: item.id,
          deltaOffset,
          item: { ...item, text: deltaText }
        })
        return
      }
      if (item.kind === 'assistant_reasoning') {
        events.push({
          kind: 'assistant_reasoning_delta',
          threadId,
          turnId: item.turnId,
          itemId: item.id,
          deltaOffset,
          item: { ...item, text: deltaText }
        })
        return
      }
      throw new TypeError(`unexpected assistant delta item: ${item.kind}`)
    },
    finishTurn: async (_t, _u, status, error, code) => {
      finished.push({ status, error, code })
    },
    saveSessionId: async (_t, _turnId, id) => {
      sessions.push(id)
    },
    loadSdk: async () => fakeSdk([]),
    baseEnv: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'leak' }),
    kunSystemPrompt: () => 'You are kun.',
    nextId: (p) => `${p}_${++n}`,
    ...overrides
  }
  return { deps, events, items, finished, sessions }
}

const STREAM: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'sess_42' } as SdkMessage,
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
  } as SdkMessage,
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hi there' },
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__kun__generate_image', input: { prompt: 'cat' } }
      ]
    }
  } as SdkMessage,
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]
    }
  } as SdkMessage,
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'all done',
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 }
  } as SdkMessage
]

describe('AgentSdkRuntime.runTurn', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  test('decideSdkBuiltinSandbox limits SDK reads to the workspace in workspace-write mode', () => {
    expect(decideSdkBuiltinSandbox('Bash', { command: 'pwd' }, {
      workspace: '/ws',
      sandboxMode: 'workspace-write'
    })).toBeNull()
    expect(decideSdkBuiltinSandbox('Bash', { command: 'pwd' }, {
      workspace: '/ws',
      sandboxMode: 'read-only'
    })).toMatchObject({ allow: false })
    expect(decideSdkBuiltinSandbox('Read', { file_path: '/tmp/outside.txt' }, {
      workspace: '/ws',
      sandboxMode: 'workspace-write'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to workspace paths')
    })
    expect(decideSdkBuiltinSandbox('Read', { file_path: '/ws/inside.txt' }, {
      workspace: '/ws',
      sandboxMode: 'workspace-write'
    })).toBeNull()
    const existingExtra = realpathSync(tmpdir())
    expect(decideSdkBuiltinSandbox('Write', { file_path: join(existingExtra, 'kun-shared-inside.txt') }, {
      workspace: '/ws',
      additionalWorkspaces: [existingExtra],
      sandboxMode: 'workspace-write'
    })).toBeNull()
    const missingExtra = `/kun-missing-extra-${process.pid}`
    expect(decideSdkBuiltinSandbox('Write', { file_path: `${missingExtra}/inside.txt` }, {
      workspace: '/ws',
      additionalWorkspaces: [missingExtra],
      sandboxMode: 'workspace-write'
    })).toMatchObject({ allow: false })
  })

  test('rejects SDK Glob patterns that select paths outside the workspace', () => {
    const context = { workspace: '/ws', sandboxMode: 'read-only' as const }
    expect(decideSdkBuiltinSandbox('Glob', { pattern: '../.ssh/**' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('workspace glob patterns')
    })
    expect(decideSdkBuiltinSandbox('Glob', { pattern: '/etc/**' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('workspace glob patterns')
    })
    expect(decideSdkBuiltinSandbox('Glob', { pattern: 'src/**/*.ts' }, context)).toBeNull()
    // Grep's pattern is content regex; its optional `path` remains the
    // filesystem selector and must stay contained.
    expect(decideSdkBuiltinSandbox('Grep', { pattern: 'secret', path: '../.ssh' }, context)).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to workspace paths')
    })
  })

  test('denies an SDK file operation that escapes through a workspace symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-sdk-sandbox-'))
    cleanup.push(root)
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await symlink(outside, join(workspace, 'escape'))

    expect(decideSdkBuiltinSandbox('Write', { file_path: join(workspace, 'escape', 'owned.txt') }, {
      workspace,
      sandboxMode: 'workspace-write'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('limited to the workspace sandbox')
    })
  })

  test('denies unknown SDK tools even in danger-full-access mode', () => {
    expect(decideSdkBuiltinSandbox('FutureWriteTool', {}, {
      workspace: '/ws',
      sandboxMode: 'danger-full-access'
    })).toMatchObject({
      allow: false,
      message: expect.stringContaining('SDK tool allowlist')
    })
  })

  test('denies every native SDK tool in Plan mode before full-access handling', () => {
    const context = {
      workspace: '/ws',
      sandboxMode: 'danger-full-access' as const,
      planMode: true
    }
    for (const toolName of ['Write', 'Edit', 'Bash', 'Read']) {
      expect(decideSdkBuiltinSandbox(toolName, { file_path: '/ws/file.ts' }, context)).toMatchObject({
        allow: false,
        message: expect.stringContaining('Plan mode')
      })
    }
    expect(decideSdkBuiltinSandbox('mcp__kun__create_plan', {}, context)).toBeNull()
  })

  test('Plan turns disable SDK built-ins and bridge Kun read tools plus create_plan', async () => {
    let options: {
      tools?: unknown[]
      allowedTools?: string[]
      permissionMode?: unknown
    } = {}
    const sdk = fakeSdk(STREAM, (value) => {
      options = value as typeof options
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'plan this safely',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        planMode: true,
        bridgeableTools: [
          { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
          { name: 'grep', description: 'Search files', inputSchema: { type: 'object' } },
          { name: 'create_plan', description: 'Save the plan', inputSchema: { type: 'object' } }
        ]
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')

    expect(options.tools).toEqual([])
    expect(options.permissionMode).toBe('default')
    expect(options.allowedTools).toEqual(expect.arrayContaining([
      'mcp__kun__read',
      'mcp__kun__grep',
      'mcp__kun__create_plan'
    ]))
    expect(options.allowedTools).not.toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']))
  })

  test('drives the SDK stream into kun events/items and completes the turn', async () => {
    const { deps, events, items, finished, sessions } = makeDeps({ loadSdk: async () => fakeSdk(STREAM) })
    const runtime = new AgentSdkRuntime(deps)
    const status = await runtime.runTurn('th', 'tn', new AbortController().signal)

    expect(status).toBe('completed')
    expect(finished).toEqual([{ status: 'completed', error: undefined }])
    expect(sessions).toEqual(['sess_42'])

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('assistant_text_delta')
    expect(kinds).toContain('tool_call_ready')
    expect(kinds).toContain('tool_call_finished')
    expect(kinds).toContain('usage')

    // Persisted milestones: tool_call item + tool_result + completed assistant text
    const persistedKinds = items.map((i) => i.kind)
    expect(persistedKinds).toContain('tool_call')
    expect(persistedKinds).toContain('tool_result')
    expect(persistedKinds).toContain('assistant_text')
  })

  test('publishes a sanitized Claude SDK trace to Agent Perspective', async () => {
    const debugSink = new LlmDebugRecorder()
    const internalGoalText = 'Internal active goal must not be exposed through the SDK trace.'
    const { deps } = makeDeps({
      debugSink,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'inspect this turn',
        approvalPolicy: 'auto',
        oauthToken: 'sk-ant-oat01-claude-oauth-secret',
        images: [{ mediaType: 'image/png', base64: 'private-image-bytes' }],
        historyTranscript: `[active goal] ${internalGoalText}`,
        redactedRequestValues: [internalGoalText],
        contextInstructions: ['Workspace AGENTS.md instruction'],
        bridgeableTools: [{
          name: 'generate_image',
          description: 'Generate an image',
          inputSchema: { type: 'object' },
          providerId: 'image:primary',
          providerKind: 'image'
        }]
      }),
      loadSdk: async () => fakeSdk(STREAM)
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')

    const trace = debugSink.snapshot()[0]?.exchanges[0]
    expect(trace).toMatchObject({
      transport: 'sdk',
      endpointFormat: 'agent-sdk',
      status: 'completed',
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'rebased',
        contextManagement: 'sdk-managed',
        nativeHistory: 'none'
      },
      request: {
        method: 'SDK',
        url: 'agent-sdk://local/query'
      },
      toolCatalog: [{
        name: 'mcp__kun__generate_image',
        providerId: 'image:primary',
        providerKind: 'image'
      }],
      decoded: {
        text: 'Hi there',
        toolCalls: [{
          callId: 'toolu_1',
          toolName: 'mcp__kun__generate_image'
        }],
        toolResults: [{
          callId: 'toolu_1',
          toolName: 'mcp__kun__generate_image',
          output: 'done',
          isError: false
        }]
      }
    })
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toContain('claude-oauth-secret')
    expect(serialized).not.toContain('private-image-bytes')
    expect(serialized).not.toContain('sess_42')
    expect(serialized).not.toContain(internalGoalText)
    expect(serialized).toContain('[REDACTED]')
    expect(JSON.parse(trace!.request!.body.text)).toMatchObject({
      system: 'You are kun.',
      instructions: ['Workspace AGENTS.md instruction'],
      tools: [{
        name: 'mcp__kun__generate_image',
        description: 'Generate an image',
        input_schema: { type: 'object' }
      }],
      attachments: {
        count: 1,
        images: [{ mediaType: 'image/png' }]
      }
    })
  })

  test('uses official resume without replaying portable history', async () => {
    const queries: Array<{ prompt: unknown; options?: unknown }> = []
    const { deps } = makeDeps({
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'current request',
        approvalPolicy: 'auto',
        bridgeableTools: [],
        resumeSessionId: 'session_previous',
        historyTranscript: '[user] should not be replayed'
      }),
      loadSdk: async () => fakeSdkAttempts([STREAM], (input) => queries.push(input))
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')

    expect(queries).toHaveLength(1)
    expect(queries[0]?.options).toMatchObject({ resume: 'session_previous' })
    expect(String(queries[0]?.prompt)).toContain('current request')
    expect(String(queries[0]?.prompt)).not.toContain('should not be replayed')
  })

  test('retains the validated resume id when a successful stream omits init metadata', async () => {
    const { deps, sessions } = makeDeps({
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'current request',
        approvalPolicy: 'auto',
        bridgeableTools: [],
        resumeSessionId: 'session_previous'
      }),
      loadSdk: async () => fakeSdk(svgSdkTextAttempt('continued'))
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')

    expect(sessions).toEqual(['session_previous'])
  })

  test('rebases once from portable history when native resume cannot load', async () => {
    const queries: Array<{ prompt: unknown; options?: unknown }> = []
    const rejectResume = vi.fn()
    let call = 0
    const sdk = fakeSdkAttempts([STREAM], (input) => queries.push(input))
    const successfulQuery = sdk.query
    sdk.query = (input): SdkQueryResult => {
      queries.push(input as { prompt: unknown; options?: unknown })
      call += 1
      if (call === 1) {
        const failed = (async function* (): AsyncGenerator<SdkMessage> {
          yield await Promise.reject(new Error('session checkpoint missing'))
        })() as SdkQueryResult
        failed.interrupt = async () => {}
        return failed
      }
      return successfulQuery(input)
    }
    const debugSink = new LlmDebugRecorder()
    const { deps } = makeDeps({
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'current request',
        approvalPolicy: 'auto',
        bridgeableTools: [],
        resumeSessionId: 'session_missing',
        historyTranscript: '[user] portable recovery state'
      }),
      loadSdk: async () => sdk,
      rejectResume,
      debugSink
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')

    expect(rejectResume).toHaveBeenCalledWith('th', 'tn')
    const actualQueries = queries.filter((entry, index) => index === 0 || index === queries.length - 1)
    expect(actualQueries[0]?.options).toMatchObject({ resume: 'session_missing' })
    expect(actualQueries.at(-1)?.options).not.toHaveProperty('resume')
    expect(String(actualQueries.at(-1)?.prompt)).toContain('portable recovery state')
    const traces = debugSink.snapshot()
      .flatMap((round) => round.exchanges)
      .sort((left, right) => left.sequence - right.sequence)
    expect(traces).toHaveLength(2)
    expect(traces[0]).toMatchObject({
      status: 'transport_error',
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'resumed',
        nativeHistory: 'unknown'
      }
    })
    expect(traces[1]).toMatchObject({
      status: 'completed',
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'rebased',
        reason: 'native_state_unavailable',
        nativeHistory: 'none'
      }
    })
    expect(JSON.stringify(traces)).not.toContain('session_missing')
  })


})
