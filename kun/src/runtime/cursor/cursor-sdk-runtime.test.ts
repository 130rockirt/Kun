import { describe, expect, test, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage
} from '@cursor/sdk'
import type { RuntimeEvent } from '../../contracts/events.js'
import type { TurnItem } from '../../contracts/items.js'
import {
  applyRuntimeEvent,
  createRuntimeEventProjection
} from '../../domain/runtime-event-reducer.js'
import { LlmDebugRecorder } from '../../services/llm-debug-recorder.js'
import {
  CursorSdkRuntime,
  cursorSdkCapabilities,
  cursorAgentExecutionOptions,
  sanitizeCursorSdkError,
  type CursorSdkApi,
  type CursorKunTurnContext,
  type CursorSdkRuntimeDeps
} from './cursor-sdk-runtime.js'
import {
  DelegatedSessionCoordinator,
  FileDelegatedSessionBindingStore,
  delegatedCapabilityFingerprint,
  delegatedCredentialIdentity,
  delegatedHistoryDigest
} from '../delegated-session-binding.js'
import { goalContextKey } from '../../loop/continuation-instructions.js'

function messages(values: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  return (async function* () {
    for (const value of values) yield value
  })()
}

function fakeRun(input: {
  stream?: SDKMessage[]
  result?: Partial<RunResult>
  cancel?: () => Promise<void>
} = {}): Run {
  const result: RunResult = {
    id: 'run_1',
    status: 'finished',
    result: 'hello',
    ...input.result
  }
  return {
    id: 'run_1',
    agentId: 'agent_1',
    supports: (operation) => operation === 'stream' || operation === 'wait' || operation === 'cancel',
    unsupportedReason: () => undefined,
    stream: () => messages(input.stream ?? [{
      type: 'assistant',
      agent_id: 'agent_1',
      run_id: 'run_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
    }]),
    conversation: async () => [],
    wait: async () => result,
    cancel: input.cancel ?? (async () => undefined),
    status: result.status,
    onDidChangeStatus: () => () => undefined,
    result: result.result,
    error: result.error,
    model: result.model,
    durationMs: result.durationMs,
    usage: result.usage,
    git: result.git,
    createdAt: 1
  }
}

function harness(input: {
  apiKey?: string
  credentialSourceId?: string
  resolveCredentialSource?: CursorSdkRuntimeDeps['resolveCredentialSource']
  run?: Run
  sendResults?: Array<Run | Error>
  thread?: Record<string, unknown>
  items?: Array<Record<string, unknown>>
  attachmentStore?: CursorSdkRuntimeDeps['attachmentStore']
  debugSink?: LlmDebugRecorder
  turnLimits?: { maxWallTimeMs?: number }
  loadError?: Error
  sessionCoordinator?: CursorSdkRuntimeDeps['sessionCoordinator']
  omitLocalStore?: boolean
  kunContext?: CursorKunTurnContext
  onLoadKunTurnContext?: () => void | Promise<void>
  contextProfile?: CursorSdkRuntimeDeps['contextProfile']
  streamLimits?: CursorSdkRuntimeDeps['streamLimits']
  todoSyncError?: Error
  suspendGraphLeadTurn?: (
    input: Record<string, unknown>
  ) => Promise<
    | 'not_graph'
    | 'suspended'
    | 'supervision_pending'
    | 'suspended_pending_supervision'
  >
}) {
  const applied: unknown[] = []
  const updated: unknown[] = []
  const materialized = new Map<string, TurnItem>()
  const recorded: unknown[] = []
  const recordedDeltaSnapshots: Array<{
    event: unknown
    item: TurnItem
  }> = []
  const finished: unknown[] = []
  const createOptions: AgentOptions[] = []
  const sentMessages: unknown[] = []
  const sentOptions: unknown[] = []
  const resumedAgentIds: string[] = []
  const resumedOptions: Array<Partial<AgentOptions> | undefined> = []
  const kunContextSignals: AbortSignal[] = []
  const syncedTodos: unknown[] = []
  const loadItems = vi.fn(async () => input.items ?? [{
    id: 'user_1',
    threadId: 'thread_1',
    turnId: 'turn_1',
    role: 'user',
    status: 'completed',
    createdAt: new Date().toISOString(),
    kind: 'user_message',
    text: 'hi'
  }])
  const sendResults = input.sendResults ?? [input.run ?? fakeRun()]
  let sendIndex = 0
  const reload = vi.fn(async () => undefined)
  const dispose = vi.fn(async () => undefined)
  const agent = {
    agentId: 'agent_1',
    model: { id: 'auto' },
    send: async (message: unknown, options: unknown) => {
      sentMessages.push(message)
      sentOptions.push(options)
      const result = sendResults[Math.min(sendIndex, sendResults.length - 1)]
      sendIndex += 1
      if (result instanceof Error) throw result
      return result
    },
    close: vi.fn(),
    reload,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    [Symbol.asyncDispose]: dispose
  } as SDKAgent
  const sdk: CursorSdkApi = {
    Agent: {
      create: async (options) => {
        createOptions.push(options)
        return agent
      },
      resume: async (agentId, options) => {
        resumedAgentIds.push(agentId)
        resumedOptions.push(options)
        return agent
      }
    },
    ...(input.sessionCoordinator && !input.omitLocalStore
      ? {
          JsonlLocalAgentStore: class {
            constructor(readonly rootDir: string) {}
          } as never
        }
      : {})
  }
  const thread = {
    id: 'thread_1',
    title: 'Cursor test',
    workspace: '/tmp/cursor-workspace',
    model: 'auto',
    mode: 'agent',
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    systemPrompt: '',
    turns: [{ id: 'turn_1', model: 'auto', mode: 'agent' }],
    ...input.thread
  }
  const deps = {
    providerConfigs: {
      'cursor-subscription': {
        kind: 'cursor-sdk',
        apiKey: input.apiKey ?? 'cursor-secret',
        ...(input.credentialSourceId ? { credentialSourceId: input.credentialSourceId } : {})
      }
    },
    providerIds: new Set(['cursor-subscription']),
    defaultIsCursor: false,
    defaultModel: 'auto',
    systemPrompt: 'Kun system prompt',
    threadStore: { get: async () => thread },
    sessionStore: {
      loadItems
    },
    turns: {
      applyItem: async (_threadId: string, item: TurnItem) => {
        applied.push(item)
        materialized.set(item.id, item)
      },
      updateItem: async (_threadId: string, itemId: string, patch: Partial<TurnItem>) => {
        const existing = materialized.get(itemId)
        if (!existing) return null
        const item = { ...existing, ...patch } as TurnItem
        updated.push(item)
        materialized.set(itemId, item)
        return item
      },
      updateTurnMetadata: async (_threadId: string, turnId: string, patch: Record<string, unknown>) => {
        const turn = thread.turns.find((candidate) => candidate.id === turnId)
        if (turn) Object.assign(turn, patch)
      },
      ...(input.suspendGraphLeadTurn
        ? { suspendGraphLeadTurn: input.suspendGraphLeadTurn }
        : {}),
      finishTurn: async (value: unknown) => { finished.push(value) }
    },
    events: {
      record: async (value: unknown) => {
        recorded.push(value)
        const event = value as { kind?: unknown; itemId?: unknown }
        if (
          (event.kind === 'assistant_text_delta' ||
            event.kind === 'assistant_reasoning_delta') &&
          typeof event.itemId === 'string'
        ) {
          const item = materialized.get(event.itemId)
          if (item) recordedDeltaSnapshots.push({ event: value, item: structuredClone(item) })
        }
      }
    },
    ids: { next: (prefix: string) => `${prefix}_1` },
    setThreadTodos: async (threadId: string, request: unknown) => {
      if (input.todoSyncError) throw input.todoSyncError
      syncedTodos.push({ threadId, request })
    },
    loadSdk: async () => {
      if (input.loadError) throw input.loadError
      return sdk
    },
    ...(input.resolveCredentialSource
      ? { resolveCredentialSource: input.resolveCredentialSource }
      : {}),
    debugSink: input.debugSink,
    attachmentStore: input.attachmentStore,
    turnLimits: input.turnLimits,
    sessionCoordinator: input.sessionCoordinator,
    contextProfile: input.contextProfile,
    streamLimits: input.streamLimits,
    ...(input.kunContext
      ? {
          loadKunTurnContext: async ({ signal }: { signal: AbortSignal }) => {
            kunContextSignals.push(signal)
            await input.onLoadKunTurnContext?.()
            return input.kunContext!
          }
        }
      : {})
  } as unknown as CursorSdkRuntimeDeps
  return {
    runtime: new CursorSdkRuntime(deps),
    createOptions,
    applied,
    updated,
    materialized,
    recorded,
    recordedDeltaSnapshots,
    finished,
    sentMessages,
    sentOptions,
    loadItems,
    kunContextSignals,
    resumedAgentIds,
    resumedOptions,
    syncedTodos,
    agent,
    reload,
    dispose
  }
}

describe('CursorSdkRuntime', () => {
  test('claims only configured Cursor providers', () => {
    const h = harness({})
    expect(h.runtime.handlesProvider('cursor-subscription')).toBe(true)
    expect(h.runtime.handlesProvider('claude-subscription')).toBe(false)
    expect(h.runtime.handlesProvider(undefined)).toBe(false)
  })

  test('runs a complete local SDK turn with isolated settings and an SDK trace', async () => {
    const debugSink = new LlmDebugRecorder()
    const h = harness({
      debugSink,
      run: fakeRun({
        stream: [{
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_1',
          name: 'shell',
          status: 'running',
          args: { command: 'pwd' }
        }, {
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_1',
          name: 'shell',
          status: 'completed',
          result: { stdout: '/tmp' }
        }, {
          type: 'assistant',
          agent_id: 'agent_1',
          run_id: 'run_1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
        }]
      })
    })
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.createOptions[0]).toMatchObject({
      apiKey: 'cursor-secret',
      model: { id: 'auto' },
      mode: 'agent',
      local: {
        cwd: '/tmp/cursor-workspace',
        settingSources: [],
        sandboxOptions: { enabled: false }
      }
    })
    expect(h.applied).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'hello',
      status: 'completed'
    }))
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'completed' }))
    const trace = debugSink.snapshot()[0]?.exchanges[0]
    expect(trace).toMatchObject({
      transport: 'sdk',
      endpointFormat: 'cursor-sdk',
      request: { method: 'SDK', url: 'cursor-sdk://local/agent' },
      delegated: {
        providerKind: 'cursor-sdk',
        phase: 'rebased',
        contextManagement: 'sdk-managed',
        nativeHistory: 'none'
      },
      decoded: {
        toolResults: [{
          callId: 'call_1',
          toolName: 'shell',
          output: '{"stdout":"/tmp"}',
          isError: false
        }]
      }
    })
    expect(JSON.stringify(trace)).not.toContain('cursor-secret')
  })

  test('reloads canonical history after Kun context materializes a goal', async () => {
    const createdAt = '2026-08-06T00:00:00.000Z'
    const goal = {
      threadId: 'thread_1',
      objective: 'Finish the migration safely.',
      status: 'active' as const,
      tokenBudget: 10_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt,
      updatedAt: createdAt
    }
    const items: Array<Record<string, unknown>> = [{
      id: 'user_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      role: 'user',
      status: 'completed',
      createdAt,
      kind: 'user_message',
      text: 'continue the migration'
    }]
    const debugSink = new LlmDebugRecorder()
    const h = harness({
      items,
      debugSink,
      kunContext: {
        instructionBlocks: [],
        activeSkillIds: [],
        tools: [],
        customTools: {}
      },
      thread: { goal },
      onLoadKunTurnContext: () => {
        items.push({
          id: 'item_turn_1_goal_context',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'system',
          status: 'completed',
          goalKey: goalContextKey(goal)!,
          createdAt,
          kind: 'goal_context',
          text: 'Finish the migration safely.'
        })
      }
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.loadItems).toHaveBeenCalledTimes(2)
    expect(String(h.sentMessages[0])).toContain(
      '[active goal] Finish the migration safely.'
    )
    expect(String(h.sentMessages[0])).toContain('<prior_conversation>')
    const trace = (await debugSink.listThread('thread_1')).records[0]
    expect(trace?.request.body.text).not.toContain('Finish the migration safely.')
    expect(trace?.request.body.text).toContain('[REDACTED]')
  })

  test('keeps Graph in plan mode and gives pending review a real second Cursor exchange', async () => {
    const suspendGraphLeadTurn = vi.fn()
      .mockResolvedValueOnce('supervision_pending')
      .mockResolvedValueOnce('supervision_pending')
      .mockResolvedValueOnce('suspended_pending_supervision')
    const h = harness({
      thread: {
        turns: [{
          id: 'turn_1',
          model: 'auto',
          mode: 'agent',
          orchestration: 'graph'
        }]
      },
      kunContext: {
        instructionBlocks: [],
        activeSkillIds: [],
        tools: [],
        customTools: {},
        graphPhase: 'supervising'
      },
      sendResults: [fakeRun(), fakeRun()],
      suspendGraphLeadTurn
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('suspended_pending_supervision')

    expect(h.createOptions[0]).toMatchObject({
      mode: 'plan',
      local: { sandboxOptions: { enabled: true } }
    })
    expect(h.sentMessages).toHaveLength(2)
    expect(h.sentMessages[1]).toContain('Host supervision gate')
    expect(h.sentMessages[1]).toContain('call `graph_review_node`')
    expect(suspendGraphLeadTurn).toHaveBeenNthCalledWith(1, {
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(suspendGraphLeadTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(suspendGraphLeadTurn).toHaveBeenNthCalledWith(3, {
      threadId: 'thread_1',
      turnId: 'turn_1',
      force: true,
      preserveDeliveryCursor: true,
      allowPendingSupervision: true
    })
    expect(h.finished).toEqual([])
  })

  test('reminds Graph planning once before a second prose response becomes needs-correction', async () => {
    const suspendGraphLeadTurn = vi.fn(async () => 'suspended' as const)
    const h = harness({
      thread: {
        turns: [{
          id: 'turn_1',
          model: 'auto',
          mode: 'agent',
          orchestration: 'graph'
        }]
      },
      kunContext: {
        instructionBlocks: [],
        activeSkillIds: [],
        tools: [],
        customTools: {},
        graphPhase: 'planning',
        graphPlanWasCommitted: () => false
      },
      sendResults: [fakeRun(), fakeRun()],
      suspendGraphLeadTurn
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('suspended')

    expect(h.sentMessages).toHaveLength(2)
    expect(h.sentMessages[1]).toContain('Host planning gate')
    expect(h.sentMessages[1]).toContain('call `graph_define_plan` now')
    // Planning is not suspended on the first prose response. The only
    // suspension happens after the bounded second exchange is exhausted.
    expect(suspendGraphLeadTurn).toHaveBeenCalledTimes(1)
    expect(h.finished).toEqual([])
  })

  test('syncs successful Cursor updateTodos results without redispatching the tool', async () => {
    const h = harness({
      run: fakeRun({
        stream: [{
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_todos',
          name: 'updateTodos',
          status: 'completed',
          result: {
            status: 'success',
            value: {
              todos: [
                { content: 'Finished step', status: 'completed' },
                { content: 'Current step', status: 'inProgress' },
                { content: 'Later step', status: 'pending' }
              ],
              totalCount: 3
            }
          }
        }]
      })
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.syncedTodos).toEqual([{
      threadId: 'thread_1',
      request: {
        todos: [
          { content: 'Finished step', status: 'completed' },
          { content: 'Current step', status: 'in_progress' },
          { content: 'Later step', status: 'pending' }
        ]
      }
    }])
    expect(h.recorded).not.toContainEqual(expect.objectContaining({
      kind: 'tool_call_ready',
      toolName: 'updateTodos'
    }))
  })

  test('keeps a Cursor turn successful when todo mirroring fails', async () => {
    const h = harness({
      todoSyncError: new Error('todo store unavailable'),
      run: fakeRun({
        stream: [{
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_todos',
          name: 'updateTodos',
          status: 'completed',
          result: {
            status: 'success',
            value: {
              todos: [{ content: 'Current step', status: 'inProgress' }],
              totalCount: 1
            }
          }
        }]
      })
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'cursor_sdk_todo_sync_failed',
      severity: 'warning',
      message: expect.stringContaining('todo store unavailable')
    }))
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'completed' }))
  })

  test('materializes cumulative partial output before a stream failure', async () => {
    const h = harness({
      streamLimits: { maxToolCalls: 1 },
      kunContext: {
        instructionBlocks: [],
        activeSkillIds: [],
        tools: [],
        customTools: {}
      },
      run: fakeRun({
        stream: [{
          type: 'assistant',
          agent_id: 'agent_1',
          run_id: 'run_1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'first part' }] }
        }, {
          type: 'assistant',
          agent_id: 'agent_1',
          run_id: 'run_1',
          message: { role: 'assistant', content: [{ type: 'text', text: ' and second part' }] }
        }, {
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_1',
          name: 'shell',
          status: 'running',
          args: { command: 'pwd' }
        }, {
          type: 'tool_call',
          agent_id: 'agent_1',
          run_id: 'run_1',
          call_id: 'call_2',
          name: 'shell',
          status: 'running',
          args: { command: 'ls' }
        }]
      })
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')

    expect(h.applied).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'first part',
      status: 'running'
    }))
    expect(h.updated).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'first part and second part',
      status: 'running'
    }))
    expect([...h.materialized.values()]).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'first part and second part'
    }))
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'cursor_sdk_stream_resource_limit'
    }))
    expect(h.kunContextSignals[0]?.aborted).toBe(true)
  })

  test('replays Cursor text and reasoning fragments over cumulative snapshots without duplication', async () => {
    const h = harness({
      run: fakeRun({
        stream: [{
          type: 'thinking',
          agent_id: 'agent_1',
          run_id: 'run_1',
          text: '思😀'
        }, {
          type: 'assistant',
          agent_id: 'agent_1',
          run_id: 'run_1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A😀' },
              { type: 'text', text: 'B' }
            ]
          }
        }, {
          type: 'thinking',
          agent_id: 'agent_1',
          run_id: 'run_1',
          text: '考'
        }, {
          type: 'assistant',
          agent_id: 'agent_1',
          run_id: 'run_1',
          message: { role: 'assistant', content: [{ type: 'text', text: '猫' }] }
        }],
        result: { result: 'A😀B猫' }
      })
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    const deltas = h.recordedDeltaSnapshots.map(({ event, item }) => {
      const draft = event as {
        kind: string
        deltaOffset?: number
        item: { text?: string }
      }
      return {
        kind: draft.kind,
        offset: draft.deltaOffset,
        fragment: draft.item.text,
        persistedText: 'text' in item ? item.text : undefined
      }
    })
    expect(deltas).toEqual([
      {
        kind: 'assistant_reasoning_delta',
        offset: 0,
        fragment: '思😀',
        persistedText: '思😀'
      },
      {
        kind: 'assistant_text_delta',
        offset: 0,
        fragment: 'A😀',
        persistedText: 'A😀B'
      },
      {
        kind: 'assistant_text_delta',
        offset: 3,
        fragment: 'B',
        persistedText: 'A😀B'
      },
      {
        kind: 'assistant_reasoning_delta',
        offset: 3,
        fragment: '考',
        persistedText: '思😀考'
      },
      {
        kind: 'assistant_text_delta',
        offset: 4,
        fragment: '猫',
        persistedText: 'A😀B猫'
      }
    ])

    const latestSnapshots = new Map<string, TurnItem>()
    for (const snapshot of h.recordedDeltaSnapshots) {
      latestSnapshots.set(snapshot.item.id, snapshot.item)
    }
    let replayed = {
      ...createRuntimeEventProjection('thread_1'),
      items: [...latestSnapshots.values()]
    }
    for (const [index, snapshot] of h.recordedDeltaSnapshots.entries()) {
      replayed = applyRuntimeEvent(replayed, {
        ...(snapshot.event as RuntimeEvent),
        seq: index + 1,
        timestamp: `2026-08-05T00:00:0${index}.000Z`
      })
    }
    expect(replayed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant_text', text: 'A😀B猫' }),
      expect.objectContaining({ kind: 'assistant_reasoning', text: '思😀考' })
    ]))
  })

  test('rebuilds the SDK session once and continues an accepted run after authentication expires', async () => {
    const h = harness({
      sendResults: [
        fakeRun({
          stream: [{
            type: 'tool_call',
            agent_id: 'agent_1',
            run_id: 'run_1',
            call_id: 'call_1',
            name: 'shell',
            status: 'running',
            args: { command: 'pwd' }
          }, {
            type: 'tool_call',
            agent_id: 'agent_1',
            run_id: 'run_1',
            call_id: 'call_1',
            name: 'shell',
            status: 'completed',
            result: { stdout: '/tmp' }
          }, {
            type: 'assistant',
            agent_id: 'agent_1',
            run_id: 'run_1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'partial result' }] }
          }],
          result: {
            status: 'error',
            error: {
              code: 'unauthenticated',
              message: 'Authentication error If you are logged in, try logging out and back in.'
            }
          }
        }),
        fakeRun({
          stream: [{
            type: 'assistant',
            agent_id: 'agent_1',
            run_id: 'run_2',
            message: { role: 'assistant', content: [{ type: 'text', text: ' completed' }] }
          }],
          result: { id: 'run_2', result: ' completed' }
        })
      ]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.resumedAgentIds).toEqual(['agent_1'])
    expect(h.createOptions[0]?.local?.enableAgentRetries).toBe(true)
    expect(h.sentMessages).toHaveLength(2)
    expect(String(h.sentMessages[1])).toContain('Continue the interrupted request')
    expect(String(h.sentMessages[1])).toContain('Do not repeat tool calls')
    expect(h.sentOptions[1]).toMatchObject({ local: { force: true } })
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'pipeline_stage',
      stage: 'pre_send',
      details: expect.objectContaining({
        reason: 'cursor_sdk_authentication_failed',
        attempt: 2,
        maxAttempts: 2,
        requestAccepted: true
      })
    }))
    expect(h.recorded).not.toContainEqual(expect.objectContaining({
      kind: 'error',
      code: 'cursor_sdk_authentication_failed'
    }))
    expect(h.recorded.filter((event) => (
      event as { kind?: unknown }
    ).kind === 'assistant_text_delta')).toEqual([
      expect.objectContaining({ deltaOffset: 0 }),
      expect.objectContaining({ deltaOffset: 'partial result'.length })
    ])
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'completed' }))
  })

  test('resends the original request when authentication fails before the SDK accepts it', async () => {
    const authenticationError = new Error('authentication transport expired')
    authenticationError.name = 'unauthenticated'
    const h = harness({
      sendResults: [authenticationError, fakeRun()]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.resumedAgentIds).toEqual(['agent_1'])
    expect(h.sentMessages).toHaveLength(2)
    expect(h.sentMessages[1]).toEqual(h.sentMessages[0])
    expect(h.sentOptions[1]).toMatchObject({ local: { force: true } })
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'pipeline_stage',
      details: expect.objectContaining({ requestAccepted: false })
    }))
  })

  test('reports a service-side authentication failure only after the automatic retry also fails', async () => {
    const authenticationFailure = () => fakeRun({
      stream: [],
      result: {
        status: 'error',
        error: {
          code: 'unauthenticated',
          message: 'Authentication error If you are logged in, try logging out and back in.'
        }
      }
    })
    const h = harness({
      sendResults: [authenticationFailure(), authenticationFailure()]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')

    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.resumedAgentIds).toEqual(['agent_1'])
    expect(h.sentMessages).toHaveLength(2)
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'cursor_sdk_authentication_failed',
      error: expect.stringContaining('automatically rebuilt the SDK session')
    }))
    expect(h.finished).toContainEqual(expect.objectContaining({
      error: expect.stringContaining('Cursor SDK/service authentication failure')
    }))
    expect(JSON.stringify(h.finished)).not.toContain('logging out')
  })

  test('injects Kun instructions and custom tools into Cursor capabilities, context, and traces', async () => {
    const debugSink = new LlmDebugRecorder()
    const mcpExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'mcp result' }]
    }))
    const h = harness({
      debugSink,
      contextProfile: () => ({
        contextWindowTokens: 100_000,
        softThresholdTokens: 80_000,
        hardThresholdTokens: 90_000
      }),
      kunContext: {
        instructionBlocks: ['Workspace AGENTS instructions', 'Active skill instructions'],
        activeSkillIds: ['docs-skill'],
        tools: [{
          name: 'mcp_call_tool',
          description: 'Call an MCP tool',
          inputSchema: { type: 'object' },
          providerId: 'mcp:facade',
          providerKind: 'mcp'
        }],
        customTools: {
          mcp_call_tool: {
            description: 'Call an MCP tool',
            inputSchema: { type: 'object' },
            execute: mcpExecute
          }
        }
      }
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.createOptions[0]?.local?.customTools).toHaveProperty('mcp_call_tool')
    // The per-send local override must carry the same Kun custom tools so
    // resumed and forced recovery runs never lose the tool catalog.
    expect(h.sentOptions[0]).toMatchObject({
      local: expect.objectContaining({
        customTools: expect.objectContaining({
          mcp_call_tool: expect.objectContaining({ execute: mcpExecute })
        })
      })
    })
    expect(String(h.sentMessages[0])).toContain('Kun system prompt')
    expect(String(h.sentMessages[0])).toContain('Workspace AGENTS instructions')
    expect(String(h.sentMessages[0])).toContain('Active skill instructions')
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'delegated_runtime',
      capabilities: expect.objectContaining({
        kunTools: true,
        externalApproval: true
      })
    }))
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'context_snapshot',
      toolCount: 1,
      activeSkillIds: ['docs-skill'],
      breakdown: expect.objectContaining({ tools: expect.any(Number) })
    }))
    const trace = debugSink.snapshot()[0]?.exchanges[0]
    expect(trace?.toolCatalog).toEqual([{
      name: 'mcp_call_tool',
      providerId: 'mcp:facade',
      providerKind: 'mcp'
    }])
    const traceBody = JSON.parse(trace?.request.body.text ?? '{}') as Record<string, unknown>
    expect(traceBody).toMatchObject({
      instructions: expect.arrayContaining([
        'Kun system prompt',
        'Workspace AGENTS instructions'
      ]),
      tools: [{
        name: 'mcp_call_tool',
        description: 'Call an MCP tool'
      }]
    })
    expect(JSON.stringify(traceBody)).not.toContain('mcpExecute')
  })

  test('resumes a compatible persisted agent and sends only the current request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-resume-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const priorItems = [{
      id: 'user_old',
      threadId: 'thread_1',
      turnId: 'turn_old',
      role: 'user',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'user_message',
      text: 'portable old context'
    }] as const
    const route = {
      providerKind: 'cursor-sdk' as const,
      providerId: 'cursor-subscription',
      credentialIdentity: delegatedCredentialIdentity({
        providerId: 'cursor-subscription',
        credentialSecret: 'cursor-secret'
      }),
      workspace: '/tmp/cursor-workspace',
      model: 'auto',
      capabilityFingerprint: delegatedCapabilityFingerprint({
        systemPrompt: 'Kun system prompt',
        threadPersona: '',
        mode: 'agent',
        sandbox: false,
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        settingSources: [],
        capabilities: cursorSdkCapabilities()
      }),
      continuationMode: 'native' as const
    }
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route,
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: priorItems as never,
      lastCommittedTurnId: 'turn_old',
      nativeSessionId: 'agent_persisted'
    })
    expect((await coordinator.store.load('thread_1'))?.synchronizedHistoryDigest)
      .toBe(delegatedHistoryDigest(priorItems as never))
    const h = harness({
      sessionCoordinator: coordinator,
      thread: {
        turns: [{ id: 'turn_1', model: 'auto', mode: 'agent' }]
      },
      items: [
        ...priorItems,
        {
          id: 'user_1',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          status: 'completed',
          createdAt: '2026-01-01T00:01:00.000Z',
          kind: 'user_message',
          text: 'current only'
        }
      ]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.resumedAgentIds).toEqual(['agent_persisted'])
    expect(
      (h.resumedOptions[0]?.local?.store as unknown as { rootDir?: string })?.rootDir
    ).toContain('provider-state')
    expect(String(h.sentMessages[0])).toContain('current only')
    expect(String(h.sentMessages[0])).not.toContain('portable old context')
  })

  test('rebases a native session when the current turn introduces active goal context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-goal-rebase-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const priorItems = [{
      id: 'user_old_goal_rebase',
      threadId: 'thread_1',
      turnId: 'turn_old',
      role: 'user',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'user_message',
      text: 'portable context before the goal'
    }] as const
    const route = {
      providerKind: 'cursor-sdk' as const,
      providerId: 'cursor-subscription',
      credentialIdentity: delegatedCredentialIdentity({
        providerId: 'cursor-subscription',
        credentialSecret: 'cursor-secret'
      }),
      workspace: '/tmp/cursor-workspace',
      model: 'auto',
      capabilityFingerprint: delegatedCapabilityFingerprint({
        systemPrompt: 'Kun system prompt',
        threadPersona: '',
        mode: 'agent',
        sandbox: false,
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        settingSources: [],
        capabilities: cursorSdkCapabilities()
      }),
      continuationMode: 'native' as const
    }
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route,
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: priorItems as never,
      lastCommittedTurnId: 'turn_old',
      nativeSessionId: 'agent_persisted'
    })
    const createdAt = '2026-08-06T00:00:00.000Z'
    const goal = {
      threadId: 'thread_1',
      objective: 'Finish the migration before answering anything else.',
      status: 'active' as const,
      tokenBudget: 1_000,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt,
      updatedAt: createdAt
    }
    const h = harness({
      sessionCoordinator: coordinator,
      thread: {
        goal,
        turns: [{ id: 'turn_1', model: 'auto', mode: 'agent' }]
      },
      items: [
        ...priorItems,
        {
          id: 'user_goal_rebase',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          status: 'completed',
          createdAt,
          kind: 'user_message',
          text: 'continue now'
        },
        {
          id: 'goal_context_rebase',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'system',
          status: 'completed',
          createdAt,
          kind: 'goal_context',
          goalKey: goalContextKey(goal)!,
          text: 'Finish the migration before answering anything else.'
        }
      ]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.resumedAgentIds).toEqual([])
    expect(String(h.sentMessages[0])).toContain('<prior_conversation>')
    expect(String(h.sentMessages[0])).toContain('portable context before the goal')
    expect(String(h.sentMessages[0])).toContain(
      '[active goal] Finish the migration before answering anything else.'
    )
  })

  test('rotates native continuation when the bridged Kun tool catalog changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-tool-rotation-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const priorItems = [{
      id: 'user_old',
      threadId: 'thread_1',
      turnId: 'turn_old',
      role: 'user',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'user_message',
      text: 'portable old context'
    }] as const
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: {
        providerKind: 'cursor-sdk',
        providerId: 'cursor-subscription',
        credentialIdentity: delegatedCredentialIdentity({
          providerId: 'cursor-subscription',
          credentialSecret: 'cursor-secret'
        }),
        workspace: '/tmp/cursor-workspace',
        model: 'auto',
        capabilityFingerprint: delegatedCapabilityFingerprint({
          systemPrompt: 'Kun system prompt',
          threadPersona: '',
          mode: 'agent',
          sandbox: false,
          settingSources: [],
          capabilities: cursorSdkCapabilities(true),
          instructions: [],
          tools: [{
            name: 'old_mcp_tool',
            description: 'Old MCP tool',
            inputSchema: { type: 'object' },
            providerId: 'mcp:old',
            providerKind: 'mcp'
          }]
        }),
        continuationMode: 'native'
      },
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: priorItems as never,
      lastCommittedTurnId: 'turn_old',
      nativeSessionId: 'agent_old_catalog'
    })
    const h = harness({
      sessionCoordinator: coordinator,
      kunContext: {
        instructionBlocks: [],
        activeSkillIds: [],
        tools: [{
          name: 'new_mcp_tool',
          description: 'New MCP tool',
          inputSchema: { type: 'object' },
          providerId: 'mcp:new',
          providerKind: 'mcp'
        }],
        customTools: {}
      },
      items: [
        ...priorItems,
        {
          id: 'user_1',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          status: 'completed',
          createdAt: '2026-01-01T00:01:00.000Z',
          kind: 'user_message',
          text: 'current request'
        }
      ]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.resumedAgentIds).toEqual([])
    expect(h.createOptions).toHaveLength(1)
    expect(String(h.sentMessages[0])).toContain('portable old context')
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'delegated_runtime',
      phase: 'rebased',
      reason: 'capabilities_changed'
    }))
  })

  test('fails closed when an SDK downgrade removes the isolated local store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-store-missing-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const h = harness({
      sessionCoordinator: coordinator,
      omitLocalStore: true
    })
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(h.createOptions).toEqual([])
    expect(h.recorded).toContainEqual(expect.objectContaining({
      kind: 'delegated_runtime',
      phase: 'portable',
      reason: 'capabilities_changed',
      capabilities: expect.objectContaining({ nativeResume: false })
    }))
  })

  test('uses plan+sandbox with Cursor classifier disabled when Kun owns review', () => {
    const approveForMe = cursorAgentExecutionOptions({
      workspace: '/tmp/work',
      apiKey: 'key',
      model: 'auto',
      name: 'test',
      planMode: false,
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write'
    })
    expect(approveForMe).toMatchObject({
      mode: 'plan',
      local: {
        autoReview: false,
        settingSources: [],
        sandboxOptions: { enabled: true }
      }
    })
    expect(approveForMe.local?.autoReview).toBe(false)
    expect(cursorAgentExecutionOptions({
      workspace: '/tmp/work',
      apiKey: 'key',
      model: 'auto',
      name: 'test',
      planMode: false,
      approvalPolicy: 'auto',
      sandboxMode: 'read-only'
    }).mode).toBe('plan')
  })

  test('uses the restricted turn snapshot after the thread is patched to full access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-authority-snapshot-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const h = harness({
      sessionCoordinator: coordinator,
      thread: {
        model: 'thread-full-model',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        turns: [{
          id: 'turn_1',
          model: 'turn-restricted-model',
          mode: 'agent',
          approvalPolicy: 'on-request',
          sandboxMode: 'workspace-write',
          actingModelRoute: {
            model: 'turn-restricted-model',
            providerId: 'cursor-subscription',
            accountId: 'turn-account'
          }
        }]
      }
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.createOptions[0]).toMatchObject({
      model: { id: 'turn-restricted-model' },
      mode: 'plan',
      local: { sandboxOptions: { enabled: true } }
    })
    expect((await coordinator.store.load('thread_1'))?.capabilityFingerprint).toBe(
      delegatedCapabilityFingerprint({
        systemPrompt: 'Kun system prompt',
        threadPersona: '',
        mode: 'plan',
        sandbox: true,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        settingSources: [],
        capabilities: cursorSdkCapabilities()
      })
    )
  })

  test('keeps a full-access turn full after the thread is patched to restricted', async () => {
    const h = harness({
      thread: {
        model: 'thread-restricted-model',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        turns: [{
          id: 'turn_1',
          model: 'turn-full-model',
          mode: 'agent',
          approvalPolicy: 'auto',
          sandboxMode: 'danger-full-access',
          actingModelRoute: {
            model: 'turn-full-model',
            providerId: 'cursor-subscription',
            accountId: 'turn-account'
          }
        }]
      }
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.createOptions[0]).toMatchObject({
      model: { id: 'turn-full-model' },
      mode: 'agent',
      local: { sandboxOptions: { enabled: false } }
    })
  })

  test('forwards authorized image attachments as a structured SDK message without tracing bytes', async () => {
    const debugSink = new LlmDebugRecorder()
    const imageBytes = Buffer.from('sensitive-image-bytes')
    const resolveContent = vi.fn(async () => ({
      id: 'att_0123456789abcdef01234567',
      name: 'diagram.png',
      kind: 'image',
      mimeType: 'image/png',
      byteSize: imageBytes.byteLength,
      hash: 'hash',
      width: 640,
      height: 480,
      threadIds: ['thread_1'],
      workspaces: ['/tmp/cursor-workspace'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: imageBytes
    }))
    const h = harness({
      debugSink,
      attachmentStore: { resolveContent } as unknown as CursorSdkRuntimeDeps['attachmentStore'],
      items: [{
        id: 'user_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: new Date().toISOString(),
        kind: 'user_message',
        text: 'describe this image',
        attachmentIds: ['att_0123456789abcdef01234567']
      }]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(resolveContent).toHaveBeenCalledWith(
      'att_0123456789abcdef01234567',
      { threadId: 'thread_1', workspace: '/tmp/cursor-workspace' }
    )
    expect(h.sentMessages[0]).toMatchObject({
      text: expect.stringContaining('describe this image'),
      images: [{
        data: imageBytes.toString('base64'),
        mimeType: 'image/png',
        dimension: { width: 640, height: 480 }
      }]
    })
    const traceJson = JSON.stringify(debugSink.snapshot())
    expect(traceJson).not.toContain(imageBytes.toString('base64'))
    expect(traceJson).toContain('"count":1')
    expect(traceJson).toContain('"mimeType":"image/png"')
  })

  test('fails closed without borrowing the default provider credential', async () => {
    const h = harness({ apiKey: '' })
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(h.createOptions).toEqual([])
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'cursor_sdk_missing_credential'
    }))
  })

  test('re-resolves a managed credential for every turn on the same Runtime', async () => {
    let authoritativeKey = ''
    const resolveCredentialSource = vi.fn(async () =>
      authoritativeKey ? { apiKey: authoritativeKey } : null)
    const h = harness({
      apiKey: 'stale-constructor-key',
      credentialSourceId: 'model-connection:cursor-subscription',
      resolveCredentialSource
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(h.createOptions).toEqual([])

    authoritativeKey = 'authoritative-cursor-key'
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')
    expect(h.createOptions).toContainEqual(expect.objectContaining({
      apiKey: 'authoritative-cursor-key'
    }))
    expect(resolveCredentialSource).toHaveBeenCalledTimes(2)
  })

  test('cancels an active SDK run when the Kun turn aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-cursor-abort-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const cancel = vi.fn(async () => { release() })
    const run = fakeRun({ cancel })
    run.stream = () => (async function* () {
      await blocked
      yield* []
    })()
    const h = harness({ run, sessionCoordinator: coordinator })
    const controller = new AbortController()
    const outcome = h.runtime.runTurn('thread_1', 'turn_1', controller.signal, 'cursor-subscription')
    await vi.waitFor(() => expect(h.createOptions).toHaveLength(1))
    controller.abort()
    await expect(outcome).resolves.toBe('aborted')
    expect(cancel).toHaveBeenCalled()
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'aborted' }))
    expect(await coordinator.store.load('thread_1')).toBeNull()
  })

  test('cancels and reports a stable failure when wall time expires', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const cancel = vi.fn(async () => { release() })
    const run = fakeRun({ cancel })
    run.stream = () => (async function* () {
      await blocked
      yield* []
    })()
    const h = harness({ run, turnLimits: { maxWallTimeMs: 5 } })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(cancel).toHaveBeenCalled()
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'turn_wall_time_limit'
    }))
  })

  test('redacts the configured key from SDK failures', () => {
    expect(sanitizeCursorSdkError(
      new Error('request using cursor-secret failed'),
      'cursor-secret'
    )).toBe('request using [REDACTED] failed')
  })

  test('keeps SDK errors and traces free of the configured key', async () => {
    const debugSink = new LlmDebugRecorder()
    const h = harness({
      debugSink,
      loadError: new Error('Cursor rejected cursor-secret')
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(JSON.stringify(h.recorded)).not.toContain('cursor-secret')
    expect(JSON.stringify(h.finished)).not.toContain('cursor-secret')
    expect(JSON.stringify(debugSink.snapshot())).not.toContain('cursor-secret')
    expect(JSON.stringify(h.finished)).toContain('[REDACTED]')
  })
})
