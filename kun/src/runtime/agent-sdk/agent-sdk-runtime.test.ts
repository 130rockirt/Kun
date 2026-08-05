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
    const { deps } = makeDeps({
      debugSink,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'inspect this turn',
        approvalPolicy: 'auto',
        oauthToken: 'sk-ant-oat01-claude-oauth-secret',
        images: [{ mediaType: 'image/png', base64: 'private-image-bytes' }],
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
    expect(JSON.parse(trace!.request.body.text)).toMatchObject({
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

  test('rebases when the official resume query throws synchronously', async () => {
    let queryCount = 0
    const sdk = fakeSdk(STREAM)
    const query = sdk.query
    sdk.query = (input): SdkQueryResult => {
      queryCount += 1
      if (queryCount === 1) throw new Error('native session unavailable')
      return query(input)
    }
    const rejectResume = vi.fn()
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
      rejectResume
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('completed')
    expect(queryCount).toBe(2)
    expect(rejectResume).toHaveBeenCalledWith('th', 'tn')
  })

  test('coalesces token-granular SDK deltas before durable recording', async () => {
    const text = 'x'.repeat(1_000)
    const messages: SdkMessage[] = [
      ...Array.from({ length: 1_000 }, () => ({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }
      } as SdkMessage)),
      {
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      } as SdkMessage,
      {
        type: 'result', subtype: 'success', is_error: false, result: text,
        num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
      } as SdkMessage
    ]
    const { deps, events, items } = makeDeps({ loadSdk: async () => fakeSdk(messages) })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')

    const deltas = events.filter((event) => event.kind === 'assistant_text_delta')
    expect(deltas).toHaveLength(1)
    expect((deltas[0] as { item: { text: string } }).item.text).toBe(text)
    expect(events.findIndex((event) => event.kind === 'assistant_text_delta'))
      .toBeLessThan(events.findIndex((event) => event.kind === 'usage'))
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'assistant_text', text, status: 'completed'
    }))
  })

  test('splits one large SDK delta into replay-safe UTF-8 event blocks', async () => {
    const text = `${'a'.repeat(4_095)}${'💡'.repeat(2_000)}`
    const messages: SdkMessage[] = [
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
      } as SdkMessage,
      {
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      } as SdkMessage,
      {
        type: 'result', subtype: 'success', is_error: false, result: text,
        num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
      } as SdkMessage
    ]
    const { deps, events } = makeDeps({ loadSdk: async () => fakeSdk(messages) })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')

    const deltas = events.filter((event) => event.kind === 'assistant_text_delta')
    const retained = deltas.map((event) => (event as { item: { text: string } }).item.text)
    expect(retained.join('')).toBe(text)
    expect(retained.every((value) => Buffer.byteLength(value, 'utf8') <= 4 * 1024)).toBe(true)
  })

  test('flushes a low-volume SDK delta after the live-update delay', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      let markWaiting!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const waiting = new Promise<void>((resolve) => { markWaiting = resolve })
      const sdk: SdkApi = {
        query: (): SdkQueryResult => {
          const stream = (async function* (): AsyncGenerator<SdkMessage> {
            yield {
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'live' } }
            } as SdkMessage
            markWaiting()
            await gate
            yield {
              type: 'assistant', parent_tool_use_id: null,
              message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] }
            } as SdkMessage
            yield {
              type: 'result', subtype: 'success', is_error: false, result: 'live',
              num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
            } as SdkMessage
          })() as SdkQueryResult
          stream.interrupt = async () => {}
          return stream
        },
        createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
        tool: () => ({})
      }
      const { deps, events } = makeDeps({ loadSdk: async () => sdk })
      const running = new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
      await waiting

      expect(events.filter((event) => event.kind === 'assistant_text_delta')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(40)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'assistant_text_delta', item: expect.objectContaining({ text: 'live' })
      }))

      release()
      await expect(running).resolves.toBe('completed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('flushes a pending SDK delta before reporting a resource error', async () => {
    const { deps, events } = makeDeps({
      getSdkStreamLimits: () => ({ maxOutputBytes: 2 }),
      loadSdk: async () => fakeSdk([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
        } as SdkMessage,
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'overflow' } }
        } as SdkMessage
      ])
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    const terminalEvents = events.filter((event) =>
      event.kind === 'assistant_text_delta' || event.kind === 'error'
    )
    expect(terminalEvents.map((event) => event.kind)).toEqual(['assistant_text_delta', 'error'])
    expect((terminalEvents[0] as { item: { text: string } }).item.text).toBe('ok')
    expect(terminalEvents[1]).toMatchObject({ code: 'stream_resource_limit' })
  })

  test('flushes pending SDK deltas when the user aborts a stalled stream', async () => {
    let waiting!: () => void
    const didWait = new Promise<void>((resolve) => { waiting = resolve })
    let interrupts = 0
    const sdk: SdkApi = {
      query: (): SdkQueryResult => {
        async function* gen(): AsyncGenerator<SdkMessage> {
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
          } as SdkMessage
          waiting()
          await new Promise<void>(() => {})
        }
        const stream = gen() as SdkQueryResult
        stream.interrupt = async () => { interrupts += 1 }
        return stream
      },
      createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
      tool: () => ({})
    }
    const controller = new AbortController()
    const { deps, events } = makeDeps({ loadSdk: async () => sdk })
    const running = new AgentSdkRuntime(deps).runTurn('th', 'tn', controller.signal)
    await didWait

    controller.abort()

    await expect(running).resolves.toBe('aborted')
    expect(interrupts).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'assistant_text_delta', item: expect.objectContaining({ text: 'partial' })
    }))
  })

  test('scopes the env: strips runtime secrets and injects only the selected token', async () => {
    let seenOptions: { env?: Record<string, string | undefined> } = {}
    const sdk = fakeSdk(STREAM, (opts) => {
      seenOptions = opts as typeof seenOptions
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      baseEnv: () => ({
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'leak',
        KUN_BROWSER_USE_BRIDGE_URL: 'http://127.0.0.1:12345',
        KUN_BROWSER_USE_BRIDGE_TOKEN: 'bridge-token',
        KUN_BROWSER_USE_APPROVAL_SIGNING_KEY: 'signing-key'
      }),
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'hi',
        approvalPolicy: 'auto',
        oauthToken: 'sk-ant-oat01-tok',
        bridgeableTools: []
      })
    })
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(seenOptions.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seenOptions.env?.KUN_BROWSER_USE_BRIDGE_URL).toBeUndefined()
    expect(seenOptions.env?.KUN_BROWSER_USE_BRIDGE_TOKEN).toBeUndefined()
    expect(seenOptions.env?.KUN_BROWSER_USE_APPROVAL_SIGNING_KEY).toBeUndefined()
    expect(seenOptions.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-tok')
  })

  test('omits the SDK maxTurns option by default', async () => {
    let seenMaxTurns: number | undefined
    const { deps } = makeDeps({
      loadSdk: async () => fakeSdk(STREAM, (options) => {
        seenMaxTurns = (options as { maxTurns?: number }).maxTurns
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')
    expect(seenMaxTurns).toBeUndefined()
  })

  test('maps an explicit native maxSteps onto the SDK maxTurns option', async () => {
    let seenMaxTurns: number | undefined
    const { deps } = makeDeps({
      getTurnLimits: () => ({ maxSteps: 7, maxWallTimeMs: 60_000, maxToolCallsPerStep: 3 }),
      loadSdk: async () => fakeSdk(STREAM, (options) => {
        seenMaxTurns = (options as { maxTurns?: number }).maxTurns
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')
    expect(seenMaxTurns).toBe(7)
  })

  test('bounds terminal iterator cleanup and interrupts when return never settles', async () => {
    vi.useFakeTimers()
    try {
      let returnStarted!: () => void
      const didStartReturn = new Promise<void>((resolve) => { returnStarted = resolve })
      let interrupts = 0
      const sdk = fakeSdk([{
        type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1
      } as SdkMessage])
      const query = sdk.query
      sdk.query = (input) => {
        const stream = query(input)
        stream.return = () => {
          returnStarted()
          return new Promise<IteratorResult<SdkMessage>>(() => {})
        }
        stream.interrupt = async () => { interrupts += 1 }
        return stream
      }
      const { deps } = makeDeps({ loadSdk: async () => sdk })
      const running = new AgentSdkRuntime(deps).runTurn(
        'th', 'tn', new AbortController().signal
      )
      await didStartReturn

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(running).resolves.toBe('completed')
      expect(interrupts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('allows approved Bash but still gates SDK file paths in workspace-write', async () => {
    let canUseTool: SdkCanUseTool | undefined
    let permissionMode: unknown
    let tools: unknown
    let allowedTools: string[] | undefined
    const sdk = fakeSdk(STREAM, (opts) => {
      canUseTool = (opts as { canUseTool?: SdkCanUseTool }).canUseTool
      permissionMode = (opts as { permissionMode?: unknown }).permissionMode
      tools = (opts as { tools?: unknown }).tools
      allowedTools = (opts as { allowedTools?: string[] }).allowedTools
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'hi',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        bridgeableTools: []
      })
    })

    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(permissionMode).toBe('default')
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']))
    expect(allowedTools).not.toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']))
    expect(canUseTool).toBeDefined()
    await expect(canUseTool!('Bash', { command: 'pwd' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pwd' }
    })
    await expect(canUseTool!('Write', { file_path: '/tmp/outside.txt', content: 'x' })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('limited to the workspace sandbox')
    })
    await expect(canUseTool!('Write', { file_path: '/ws/inside.txt', content: 'x' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/ws/inside.txt', content: 'x' }
    })
  })

  test('bridges Kun read tools when Graph disables all overlapping SDK built-ins', async () => {
    let options: {
      tools?: unknown[]
      allowedTools?: string[]
      mcpServers?: Record<string, unknown>
    } = {}
    const sdk = fakeSdk(svgSdkTextAttempt('planning paused'), (value) => {
      options = value as typeof options
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'inspect and define the Graph',
        approvalPolicy: 'auto',
        sandboxMode: 'workspace-write',
        allowSdkBuiltins: false,
        bridgeKunBuiltinOverlaps: true,
        bridgeableTools: [{
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object' }
        }]
      })
    })

    await expect(
      new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    ).resolves.toBe('completed')

    expect(options.tools).toEqual([])
    expect(options.allowedTools).toContain('mcp__kun__read')
    expect(options.mcpServers).toHaveProperty('kun')
  })

  test('gives Graph planning one real SDK recovery exchange before parking prose-only output', async () => {
    const prompts: string[] = []
    const checkGraphCompletion = vi.fn(async () => 'complete' as const)
    const finishTurn = vi.fn(async () => 'suspended' as const)
    const sdk = fakeSdkAttempts([
      svgSdkTextAttempt('I have a plan.'),
      svgSdkTextAttempt('I still will not call the tool.')
    ], (input) => {
      if (typeof input.prompt === 'string') prompts.push(input.prompt)
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      checkGraphCompletion,
      finishTurn,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'build this with Graph',
        approvalPolicy: 'auto',
        sandboxMode: 'read-only',
        allowSdkBuiltins: false,
        bridgeKunBuiltinOverlaps: true,
        graphPhase: 'planning',
        bridgeableTools: [{
          name: 'graph_define_plan',
          description: 'Define the Graph plan',
          inputSchema: { type: 'object' }
        }]
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('suspended')

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Host planning gate')
    expect(prompts[1]).toContain('call `graph_define_plan` now')
    expect(checkGraphCompletion).not.toHaveBeenCalled()
    expect(finishTurn).toHaveBeenCalledTimes(1)
  })

  test('resumes the first Graph SDK session and carries exact plan issue paths into recovery', async () => {
    const queries: Array<{
      prompt: unknown
      options?: { resume?: string }
    }> = []
    let graphDefinePlanHandler:
      | ((args: Record<string, unknown>, extra: unknown) => Promise<unknown>)
      | undefined
    let queryIndex = 0
    const sdk: SdkApi = {
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
        const current = queryIndex
        queryIndex += 1
        queries.push(input as typeof queries[number])
        async function* gen(): AsyncGenerator<SdkMessage> {
          if (current === 0) {
            await graphDefinePlanHandler?.({}, {})
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'graph_session_after_invalid_plan'
            } as SdkMessage
          }
          yield* svgSdkTextAttempt(
            current === 0 ? 'The plan is ready.' : 'Still prose only.'
          )
        }
        const stream = gen() as SdkQueryResult
        stream.interrupt = async () => {}
        return stream
      }
    }
    const executeKunTool = vi.fn(async () => ({
      output: {
        code: 'graph_plan_invalid',
        issues: [{
          path: ['tasks', 0, 'loop'],
          message: 'Ordinary work tasks cannot contain loop.',
          repairHint: 'Remove loop or change kind to loop_gate.'
        }]
      },
      isError: true
    }))
    const finishTurn = vi.fn(async () => 'suspended' as const)
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      executeKunTool,
      finishTurn,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'build this with Graph',
        approvalPolicy: 'auto',
        sandboxMode: 'read-only',
        allowSdkBuiltins: false,
        bridgeKunBuiltinOverlaps: true,
        graphPhase: 'planning',
        bridgeableTools: [{
          name: 'graph_define_plan',
          description: 'Define the Graph plan',
          inputSchema: { type: 'object' }
        }]
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('suspended')

    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.resume).toBe(
      'graph_session_after_invalid_plan'
    )
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      '"path":["tasks",0,"loop"]'
    ))
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      'Remove loop or change kind to loop_gate.'
    ))
    expect(executeKunTool).toHaveBeenCalledTimes(1)
  })

  test('gives pending Graph supervision one real SDK recovery exchange before parking', async () => {
    const prompts: string[] = []
    const checkGraphCompletion = vi.fn(async () => 'retry_required' as const)
    const finishTurn = vi.fn(async () => 'suspended_pending_supervision' as const)
    const sdk = fakeSdkAttempts([
      svgSdkTextAttempt('Everything looks complete.'),
      svgSdkTextAttempt('Still prose only.')
    ], (input) => {
      if (typeof input.prompt === 'string') prompts.push(input.prompt)
    })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      checkGraphCompletion,
      finishTurn,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'continue Graph supervision',
        approvalPolicy: 'auto',
        sandboxMode: 'read-only',
        allowSdkBuiltins: false,
        bridgeKunBuiltinOverlaps: true,
        graphPhase: 'supervising',
        bridgeableTools: [{
          name: 'graph_review_node',
          description: 'Review a pending Graph node',
          inputSchema: { type: 'object' }
        }]
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('suspended_pending_supervision')

    expect(checkGraphCompletion).toHaveBeenCalledTimes(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Host supervision gate')
    expect(prompts[1]).toContain('call `graph_review_node`')
    expect(finishTurn).toHaveBeenCalledTimes(1)
  })

  test('disables SDK built-ins and completes after mutation plus matching validation', async () => {
    const seenOptions: Array<{ tools?: unknown; strictMcpConfig?: boolean; allowedTools?: string[] }> = []
    const sdk = fakeSdkAttempts([
      svgSdkAttempt([
        { name: 'design_svg_edit', id: 'edit_ok', output: { ok: true, revision: 'rev_1' } },
        { name: 'design_svg_validate', id: 'validate_ok', output: { ok: true, revision: 'rev_1' } }
      ])
    ], (input) => seenOptions.push(input.options as typeof seenOptions[number]))
    const { deps, finished } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })

    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('completed')
    expect(finished).toEqual([{ status: 'completed', error: undefined }])
    expect(seenOptions).toHaveLength(1)
    expect(seenOptions[0]).toMatchObject({ tools: [], strictMcpConfig: true })
    expect(seenOptions[0].allowedTools).not.toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']))
  })

  test('preserves SVG recovery while sharing the maxSteps budget across SDK queries', async () => {
    const seenMaxTurns: number[] = []
    const sdk = fakeSdkAttempts([
      svgSdkTextAttempt('not ready'),
      svgSdkAttempt([
        { name: 'design_svg_edit', id: 'edit_budgeted', output: { ok: true, revision: 'rev_budgeted' } },
        { name: 'design_svg_validate', id: 'validate_budgeted', output: { ok: true, revision: 'rev_budgeted' } }
      ])
    ], (input) => {
      seenMaxTurns.push((input.options as { maxTurns: number }).maxTurns)
    })
    const query = sdk.query
    let queryIndex = 0
    let firstQueryClosed = false
    sdk.query = (input) => {
      const index = queryIndex
      queryIndex += 1
      if (index === 1) expect(firstQueryClosed).toBe(true)
      const stream = query(input)
      if (index === 0) {
        const closable = stream as unknown as {
          return(value?: unknown): Promise<IteratorResult<SdkMessage>>
        }
        const close = closable.return.bind(stream)
        closable.return = async (value) => {
          await Promise.resolve()
          firstQueryClosed = true
          return close(value)
        }
      }
      return stream
    }
    const { deps } = makeDeps({
      getTurnLimits: () => ({ maxSteps: 2 }),
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')
    expect(seenMaxTurns).toEqual([2, 1])
    expect(firstQueryClosed).toBe(true)
  })

  test('fails a terminal-less SVG SDK query without retrying it', async () => {
    let queries = 0
    const { deps, events } = makeDeps({
      getTurnLimits: () => ({ maxSteps: 1 }),
      loadSdk: async () => fakeSdkAttempts([[], [], []], () => { queries += 1 }),
      loadTurnContext: async () => svgSdkContext()
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(queries).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'agent_sdk_protocol_error'
    }))
  })

  test('fails a truncated SVG recovery query instead of reusing a stale final', async () => {
    let queries = 0
    const { deps, events } = makeDeps({
      loadSdk: async () => fakeSdkAttempts([
        svgSdkTextAttempt('first attempt completed'),
        []
      ], () => { queries += 1 }),
      loadTurnContext: async () => svgSdkContext()
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(queries).toBe(2)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'agent_sdk_protocol_error'
    }))
  })

  test('exhausts three recovery attempts when no structured mutation succeeds', async () => {
    let queries = 0
    const sdk = fakeSdkAttempts([
      svgSdkTextAttempt('prose only'), svgSdkTextAttempt('still prose'), svgSdkTextAttempt('done')
    ], () => { queries += 1 })
    const { deps, events, finished } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })

    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('failed')
    expect(queries).toBe(3)
    expect(finished.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('recovery attempts') })
    expect(events.filter((event) => event.kind === 'error')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'required_svg_mutation_missing' })
    ]))
  })

  test('fails before loading the SDK when SVG mutation tools are unavailable', async () => {
    const loadSdk = vi.fn(async () => fakeSdk([]))
    const { deps, events } = makeDeps({
      loadSdk,
      loadTurnContext: async () => ({
        ...svgSdkContext(),
        bridgeableTools: [{ name: 'design_svg_validate', description: 'validate', inputSchema: {} }]
      })
    })
    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('failed')
    expect(loadSdk).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'svg_tools_unavailable' }))
  })

  test('exhausts recovery when mutation is never followed by validation', async () => {
    const sdk = fakeSdkAttempts([
      svgSdkAttempt([{ name: 'design_svg_edit', id: 'edit_only', output: { ok: true, revision: 'rev_1' } }]),
      svgSdkTextAttempt(),
      svgSdkTextAttempt()
    ])
    const { deps, events } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })
    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('failed')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', code: 'required_svg_validation_missing' })
    ]))
  })

  test('requires validation after the mutation and ignores failed tool results', async () => {
    let queries = 0
    const sdk = fakeSdkAttempts([
      svgSdkAttempt([
        { name: 'design_svg_validate', id: 'validate_first', output: { ok: true, revision: 'rev_0' } },
        { name: 'design_svg_edit', id: 'edit_failed', output: { ok: false, error: 'bad op' }, isError: true }
      ]),
      svgSdkAttempt([{ name: 'design_svg_edit', id: 'edit_second', output: { ok: true, revision: 'rev_2' } }]),
      svgSdkAttempt([{ name: 'design_svg_validate', id: 'validate_last', output: { ok: true, revision: 'rev_2' } }])
    ], () => { queries += 1 })
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })
    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('completed')
    expect(queries).toBe(3)
  })

  test('rejects stale validation revisions and retries with tool feedback', async () => {
    const prompts: unknown[] = []
    const sdk = fakeSdkAttempts([
      svgSdkAttempt([
        { name: 'design_svg_edit', id: 'edit_new', output: { ok: true, revision: 'rev_new' } },
        { name: 'design_svg_validate', id: 'validate_old', output: { ok: true, revision: 'rev_old' } }
      ]),
      svgSdkAttempt([{ name: 'design_svg_validate', id: 'validate_new', output: { ok: true, revision: 'rev_new' } }])
    ], (input) => prompts.push(input.prompt))
    let mcpServerInstances = 0
    const createServer = sdk.createSdkMcpServer
    sdk.createSdkMcpServer = (config) => {
      mcpServerInstances += 1
      return createServer(config)
    }
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => svgSdkContext()
    })
    await expect(new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)).resolves.toBe('completed')
    expect(prompts).toHaveLength(2)
    expect(mcpServerInstances).toBe(2)
    expect(prompts[1]).toContain('SVG completion gate')
    expect(prompts[1]).toContain('design_svg_validate result')
  })

  test('null turn context fails the turn early', async () => {
    const { deps, finished } = makeDeps({ loadTurnContext: async () => null })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(status).toBe('failed')
    expect(finished[0].status).toBe('failed')
  })

  test('fails a fenced managed credential explicitly before loading the SDK', async () => {
    const loadSdk = vi.fn(async () => fakeSdk(STREAM))
    const { deps, events, finished } = makeDeps({
      loadTurnContext: async () => { throw new AgentSdkCredentialUnavailableError() },
      loadSdk
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('failed')
    expect(loadSdk).not.toHaveBeenCalled()
    expect(finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'agent_sdk_credential_unavailable',
      error: expect.stringContaining('credentials are unavailable')
    }))
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'agent_sdk_credential_unavailable'
    }))
  })

  test('an already-aborted signal yields an aborted turn', async () => {
    const ac = new AbortController()
    ac.abort()
    const loadSdk = vi.fn(async () => fakeSdk(STREAM))
    const { deps, finished } = makeDeps({ loadSdk })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', ac.signal)
    expect(status).toBe('aborted')
    expect(finished[0].status).toBe('aborted')
    expect(loadSdk).not.toHaveBeenCalled()
  })

  test('fails an SDK turn that exceeds the runtime wall-time limit', async () => {
    let interrupted = false
    const { deps, events, finished } = makeDeps({
      getTurnLimits: () => ({ maxWallTimeMs: 1 }),
      loadSdk: async () => ({
        query: ({ options }) => {
          const abortController = (options as { abortController: AbortController }).abortController
          async function* gen(): AsyncGenerator<SdkMessage> {
            await new Promise<void>((resolve) => {
              abortController.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            for (const message of [] as SdkMessage[]) yield message
          }
          const stream = gen() as SdkQueryResult
          stream.interrupt = async () => { interrupted = true }
          return stream
        },
        createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }),
        tool: () => ({})
      })
    })

    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(status).toBe('failed')
    expect(interrupted).toBe(true)
    expect(finished).toContainEqual(expect.objectContaining({
      status: 'failed', error: expect.stringContaining('wall time')
    }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'turn_wall_time_limit' }))
  })

  test('wall-time interrupts a stalled iterator that ignores the abort controller', async () => {
    let interrupts = 0
    const { deps, events } = makeDeps({
      getTurnLimits: () => ({ maxWallTimeMs: 5 }),
      loadSdk: async () => stalledSdk(() => undefined, () => { interrupts += 1 })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(interrupts).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'turn_wall_time_limit'
    }))
  })

  test('user cancellation interrupts a stalled iterator and returns aborted', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    let interrupts = 0
    const controller = new AbortController()
    const { deps } = makeDeps({
      loadSdk: async () => stalledSdk(started, () => { interrupts += 1 })
    })
    const running = new AgentSdkRuntime(deps).runTurn('th', 'tn', controller.signal)
    await didStart

    controller.abort()

    await expect(running).resolves.toBe('aborted')
    expect(interrupts).toBe(1)
  })

  test('fails a non-SVG SDK stream that ends without a terminal result', async () => {
    const { deps, events, finished } = makeDeps({ loadSdk: async () => fakeSdk([]) })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'agent_sdk_protocol_error', severity: 'error'
    }))
    expect(finished.at(-1)?.error).toContain('without a terminal result')
  })

  test('interrupts the SDK stream and reports a stable resource code on output overflow', async () => {
    let interrupts = 0
    const sdk = fakeSdk([{
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'SECRET_MARKER' }
      }
    } as SdkMessage])
    const query = sdk.query
    sdk.query = (input) => {
      const stream = query(input)
      stream.interrupt = () => {
        interrupts += 1
        return new Promise<void>(() => {})
      }
      return stream
    }
    const { deps, events, items, finished } = makeDeps({
      loadSdk: async () => sdk,
      getSdkStreamLimits: () => ({ maxOutputBytes: 3 })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(interrupts).toBe(1)
    expect(items).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'stream_resource_limit', severity: 'warning'
    }))
    const error = finished.at(-1)?.error ?? ''
    expect(error).toContain('response text and reasoning bytes')
    expect(error).not.toContain('SECRET_MARKER')
  })

  test('rejects a per-step SDK tool storm before persisting partial calls', async () => {
    let interrupts = 0
    const sdk = fakeSdk([{
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: {} },
          { type: 'tool_use', id: 'two', name: 'Read', input: {} }
        ]
      }
    } as SdkMessage])
    const query = sdk.query
    sdk.query = (input) => {
      const stream = query(input)
      stream.interrupt = async () => { interrupts += 1 }
      return stream
    }
    const { deps, events, items } = makeDeps({
      loadSdk: async () => sdk,
      getTurnLimits: () => ({ maxToolCallsPerStep: 1 })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(interrupts).toBe(1)
    expect(items).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'tool_call_limit_exceeded'
    }))
  })

  test('maps SDK error_max_turns onto the native turn_step_limit code', async () => {
    const debugSink = new LlmDebugRecorder()
    const { deps, events, finished } = makeDeps({
      debugSink,
      getTurnLimits: () => ({ maxSteps: 3 }),
      loadSdk: async () => fakeSdk([{
        type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3
      } as SdkMessage])
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'turn_step_limit', severity: 'warning'
    }))
    expect(finished.at(-1)?.error).toBe('turn exceeded 3 model steps')
    expect(debugSink.snapshot()[0]?.exchanges[0]).toMatchObject({
      status: 'completed',
      decoded: {
        error: 'error_max_turns',
        stopReason: 'error'
      }
    })
  })

  test('fails closed when SDK usage reports more turns than the supplied maxTurns', async () => {
    const { deps, events } = makeDeps({
      getTurnLimits: () => ({ maxSteps: 2 }),
      loadSdk: async () => fakeSdk([{
        type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3
      } as SdkMessage])
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('failed')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error', code: 'turn_step_limit'
    }))
  })

  test('a query failure records an error event and fails the turn', async () => {
    const { deps, events, finished } = makeDeps({
      loadSdk: async () => ({
        query: () => {
          throw new Error('sdk boom')
        },
        createSdkMcpServer: () => ({ type: 'sdk', name: 'kun', instance: {} }),
        tool: () => ({})
      })
    })
    const status = await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(status).toBe('failed')
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(finished[0]).toMatchObject({ status: 'failed' })
  })

  test('redacts a Claude credential from Agent Perspective and conversation failures', async () => {
    const token = 'sk-ant-oat01-private-auth-token'
    const debugSink = new LlmDebugRecorder()
    const { deps, events, finished } = makeDeps({
      debugSink,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'authenticate',
        approvalPolicy: 'auto',
        oauthToken: token,
        bridgeableTools: []
      }),
      loadSdk: async () => ({
        query: () => {
          throw new Error(`Failed to authenticate: 401 Invalid Bearer ${token}`)
        },
        createSdkMcpServer: () => ({ type: 'sdk', name: 'kun', instance: {} }),
        tool: () => ({})
      })
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('failed')

    const diagnostics = JSON.stringify({
      events,
      finished,
      perspective: debugSink.snapshot()
    })
    expect(diagnostics).toContain('401 Invalid Bearer [REDACTED]')
    expect(diagnostics).not.toContain(token)
  })

  test('redacts credentials from a terminal SDK error result', async () => {
    const token = 'sk-ant-oat01-terminal-result-secret'
    const debugSink = new LlmDebugRecorder()
    const { deps, finished } = makeDeps({
      debugSink,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: 'authenticate',
        approvalPolicy: 'auto',
        oauthToken: token,
        bridgeableTools: []
      }),
      loadSdk: async () => fakeSdk([{
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: `Invalid Bearer ${token}`,
        num_turns: 1
      } as SdkMessage])
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th',
      'tn',
      new AbortController().signal
    )).resolves.toBe('failed')

    const diagnostics = JSON.stringify({
      finished,
      perspective: debugSink.snapshot()
    })
    expect(diagnostics).toContain('Invalid Bearer [REDACTED]')
    expect(diagnostics).not.toContain(token)
  })

  test('forwards image attachments as a structured user message (text + image block)', async () => {
    let prompt: unknown
    const sdk = fakeSdk(STREAM)
    const inner = sdk.query
    sdk.query = (input) => {
      prompt = (input as { prompt?: unknown }).prompt
      return inner(input)
    }
    const { deps } = makeDeps({
      loadSdk: async () => sdk,
      loadTurnContext: async () => ({
        workspace: '/ws',
        userText: '这是什么',
        approvalPolicy: 'auto',
        images: [{ mediaType: 'image/png', base64: 'AAAA' }],
        bridgeableTools: []
      })
    })
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)

    expect(typeof prompt).not.toBe('string')
    const messages: Array<{ message: { content: unknown } }> = []
    for await (const m of prompt as AsyncIterable<{ message: { content: unknown } }>) messages.push(m)
    expect(messages).toHaveLength(1)
    expect(messages[0].message.content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
  })

  test('uses a plain string prompt when there are no images', async () => {
    let prompt: unknown
    const sdk = fakeSdk(STREAM)
    const inner = sdk.query
    sdk.query = (input) => {
      prompt = (input as { prompt?: unknown }).prompt
      return inner(input)
    }
    const { deps } = makeDeps({ loadSdk: async () => sdk }) // default ctx: userText 'hello', no images
    await new AgentSdkRuntime(deps).runTurn('th', 'tn', new AbortController().signal)
    expect(prompt).toBe('hello')
  })

  test('handlesProvider delegates to deps', () => {
    const { deps } = makeDeps()
    const runtime = new AgentSdkRuntime(deps)
    expect(runtime.handlesProvider('claude-sub')).toBe(true)
    expect(runtime.handlesProvider('deepseek')).toBe(false)
  })
})
