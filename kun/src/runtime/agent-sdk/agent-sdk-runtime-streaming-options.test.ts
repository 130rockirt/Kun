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

  test('routes provider deltas through cumulative state-first writes with UTF-16 offsets', async () => {
    const messages: SdkMessage[] = [
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } }
      } as SdkMessage,
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'think' } }
      } as SdkMessage,
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }
      } as SdkMessage,
      {
        type: 'assistant', parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'think' },
            { type: 'text', text: 'Hi there' }
          ]
        }
      } as SdkMessage,
      {
        type: 'result', subtype: 'success', is_error: false, result: 'Hi there',
        num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }
      } as SdkMessage
    ]
    const applyAssistantDelta = vi.fn<SdkRuntimeDeps['applyAssistantDelta']>(async () => undefined)
    const recordEvent = vi.fn<SdkRuntimeDeps['recordEvent']>(async () => undefined)
    const { deps, items } = makeDeps({
      applyAssistantDelta,
      recordEvent,
      loadSdk: async () => fakeSdk(messages)
    })

    await expect(new AgentSdkRuntime(deps).runTurn(
      'th', 'tn', new AbortController().signal
    )).resolves.toBe('completed')

    expect(applyAssistantDelta.mock.calls.map(([, item, deltaText, deltaOffset]) => ({
      kind: item.kind,
      cumulativeText: 'text' in item ? item.text : '',
      deltaText,
      deltaOffset
    }))).toEqual([
      {
        kind: 'assistant_text',
        cumulativeText: 'Hi ',
        deltaText: 'Hi ',
        deltaOffset: 0
      },
      {
        kind: 'assistant_reasoning',
        cumulativeText: 'think',
        deltaText: 'think',
        deltaOffset: 0
      },
      {
        kind: 'assistant_text',
        cumulativeText: 'Hi there',
        deltaText: 'there',
        deltaOffset: 3
      }
    ])
    expect(recordEvent.mock.calls.some(([event]) =>
      event.kind === 'assistant_text_delta' || event.kind === 'assistant_reasoning_delta'
    )).toBe(false)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'assistant_text', text: 'Hi there', status: 'completed'
    }))
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'assistant_reasoning', text: 'think', status: 'completed'
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
    expect(deltas.map((event) => 'deltaOffset' in event ? event.deltaOffset : undefined)).toEqual(
      retained.reduce<number[]>((offsets, value) => [
        ...offsets,
        (offsets.at(-1) ?? 0) + (offsets.length === 0 ? 0 : retained[offsets.length - 1]!.length)
      ], [])
    )
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


})
