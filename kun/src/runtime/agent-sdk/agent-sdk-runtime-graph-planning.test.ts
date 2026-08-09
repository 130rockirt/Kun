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
    const sdk = fakeGraphPlanSdkAttempts([{
      arguments: {},
      text: 'The plan is ready.',
      sessionId: 'graph_session_after_invalid_plan'
    }, {
      text: 'Still prose only.'
    }], (input) => queries.push(input as typeof queries[number]))
    const executeKunTool = vi.fn(async () => ({
      output: {
        code: 'graph_plan_invalid',
        retryable: true,
        issues: [{
          path: ['tasks', 0, 'loop'],
          message: 'Ordinary work tasks cannot contain loop.',
          repairHint: 'Remove loop or change kind to loop_gate.'
        }]
      },
      isError: true
    }))
    const finishTurn = vi.fn(async () => 'suspended' as const)
    const { deps, events } = makeDeps({
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
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      'structured top-level `{ plan: ... }` object'
    ))
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      'Do not use `__raw`'
    ))
    expect(executeKunTool).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => (
      event.kind === 'error' && event.code === 'graph_plan_submission_required'
    ))).toHaveLength(1)
  })

  test('does not inject a second Graph planning query after a non-retryable plan result', async () => {
    const queries: Array<{ prompt: unknown }> = []
    const sdk = fakeGraphPlanSdkAttempts([{
      arguments: { __raw: '{"plan":{"title":"still incomplete"' },
      text: 'The plan needs user correction.'
    }, {
      arguments: { plan: { title: 'must not run' } },
      text: 'unexpected retry'
    }], (input) => queries.push(input))
    const executeKunTool = vi.fn(async () => ({
      output: {
        code: 'graph_plan_needs_correction',
        retryable: false,
        issues: [{
          path: ['plan'],
          message: 'The corrected plan is still incomplete.'
        }]
      },
      isError: true
    }))
    const finishTurn = vi.fn(async () => 'suspended' as const)
    const { deps, events } = makeDeps({
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

    expect(queries).toHaveLength(1)
    expect(executeKunTool).toHaveBeenCalledTimes(1)
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'graph_plan_submission_required'
    }))
    expect(finishTurn).toHaveBeenCalledTimes(1)
  })


})
