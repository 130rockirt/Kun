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

  test('commits a changed direct plan on the single recovery query and exits planning', async () => {
    const initialArguments = {
      plan: {
        title: 'Initial oversized plan',
        tasks: [{ id: 'task_1', objective: 'Repeat all background details' }]
      }
    }
    const correctedArguments = {
      plan: {
        title: 'Focused plan',
        tasks: [{ id: 'task_1', objective: 'Apply the requested change' }]
      }
    }
    const queries: Array<{
      prompt: unknown
      options?: { resume?: string }
    }> = []
    const sdk = fakeGraphPlanSdkAttempts([{
      arguments: initialArguments,
      text: 'The first plan needs correction.',
      sessionId: 'graph_session_after_retryable_plan'
    }, {
      arguments: correctedArguments,
      text: 'The corrected plan was committed.'
    }], (input) => queries.push(input as typeof queries[number]))
    let toolAttempt = 0
    let planCommitted = false
    const executeKunTool = vi.fn(async (
      _threadId: string,
      _turnId: string,
      _toolName: string,
      _args: Record<string, unknown>
    ): Promise<{ output: unknown; isError?: boolean }> => {
      toolAttempt += 1
      if (toolAttempt === 1) {
        return {
          output: {
            code: 'graph_plan_invalid',
            retryable: true,
            issues: [{
              path: ['plan', 'tasks'],
              message: 'The plan is too large.',
              repairHint: 'Submit a smaller changed plan.'
            }]
          },
          isError: true
        }
      }
      planCommitted = true
      return {
        output: { status: 'committed', runId: 'run_graph_1' },
        isError: false
      }
    })
    const finishTurn = vi.fn(async () => (
      planCommitted ? 'suspended_pending_supervision' as const : 'suspended' as const
    ))
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
    )).resolves.toBe('suspended_pending_supervision')

    expect(queries).toHaveLength(2)
    expect(queries[1]?.options?.resume).toBe(
      'graph_session_after_retryable_plan'
    )
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      'structured top-level `{ plan: ... }` object'
    ))
    expect(queries[1]?.prompt).toEqual(expect.stringContaining(
      'Do not use `__raw`'
    ))
    expect(executeKunTool).toHaveBeenCalledTimes(2)
    expect(executeKunTool.mock.calls[0]?.[3]).toEqual(initialArguments)
    expect(executeKunTool.mock.calls[1]?.[3]).toEqual(correctedArguments)
    expect(executeKunTool.mock.calls[1]?.[3]).not.toHaveProperty('__raw')
    expect(planCommitted).toBe(true)
    expect(events.filter((event) => (
      event.kind === 'error' && event.code === 'graph_plan_submission_required'
    ))).toHaveLength(1)
    expect(finishTurn).toHaveBeenCalledTimes(1)
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


})
