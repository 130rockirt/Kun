import { describe, expect, it, vi } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import type { ToolCallLike, ToolHostContext, ToolHostResult } from '../ports/tool-host.js'
import type { ToolDispatchInput } from './turn-execution-types.js'
import { ToolCallDispatcher } from './tool-call-dispatcher.js'

const context = {
  threadId: 'thread_1',
  turnId: 'turn_1',
  workspace: '/workspace',
  approvalPolicy: 'auto',
  sandboxMode: 'workspace-write',
  abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
} as ToolHostContext

const call = (toolName: string, callId: string): ToolCallLike => ({ callId, toolName, arguments: {} })

function resultFor(call: ToolCallLike): ToolHostResult {
  return {
    item: makeToolResultItem({
      id: `item_${call.callId}`,
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: call.callId,
      toolName: call.toolName,
      output: { ok: true }
    }),
    approved: true
  }
}

function dispatchInput(calls: ToolCallLike[]): ToolDispatchInput {
  return {
    calls,
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    clientSurface: 'api',
    modelCapabilities: {
      id: 'model_1',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text']
    },
    activeSkillIds: [],
    toolProviderKinds: new Map([
      ['read', 'built-in'],
      ['grep', 'built-in'],
      ['delegate_task', 'delegation']
    ]),
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    signal: new AbortController().signal
  }
}

describe('ToolCallDispatcher', () => {
  it('shares the source result budget across a parallel source batch', async () => {
    const observed: number[] = []
    const dispatcher = new ToolCallDispatcher({
      executeSafely: vi.fn(async (input: { call: ToolCallLike; context: ToolHostContext }) => {
        observed.push(input.context.sourceResultBudgetTokens ?? 0)
        return resultFor(input.call)
      }),
      persistResult: vi.fn(async () => undefined), persistSuppressed: vi.fn(async () => undefined)
    } as never)
    await dispatcher.dispatch({ dispatch: dispatchInput([call('read', 'a'), call('grep', 'b')]), context: { ...context, sourceResultBudgetTokens: 100 } })
    expect(observed).toEqual([50, 50])
  })
  it('fans out a read-only batch but persists results in model order', async () => {
    const started: string[] = []
    const persisted: string[] = []
    const executed: string[] = []
    const toolExecution = {
      executeSafely: vi.fn(async (input: { call: ToolCallLike }) => {
        started.push(input.call.callId)
        return resultFor(input.call)
      }),
      persistResult: vi.fn(async (_threadId: string, _turnId: string, entry: ToolCallLike) => {
        persisted.push(entry.callId)
      }),
      persistSuppressed: vi.fn(async () => undefined)
    }
    const dispatcher = new ToolCallDispatcher(toolExecution as never)
    const calls = [call('read', 'read_1'), call('grep', 'grep_1')]

    await expect(dispatcher.dispatch({
      dispatch: dispatchInput(calls),
      context,
      onToolExecuted: (toolName) => { executed.push(toolName) }
    })).resolves.toBe('continue')

    expect(started).toEqual(['read_1', 'grep_1'])
    expect(persisted).toEqual(['read_1', 'grep_1'])
    expect(executed).toEqual(['read', 'grep'])
  })

  it('continues a parallel batch when one result is a tool-level cancellation', async () => {
    const persisted: Array<{ callId: string; isError?: boolean }> = []
    const dispatcher = new ToolCallDispatcher({
      executeSafely: vi.fn(async (input: { call: ToolCallLike }) => {
        if (input.call.callId === 'read_1') {
          return {
            item: makeToolResultItem({
              id: 'item_read_1',
              threadId: 'thread_1',
              turnId: 'turn_1',
              callId: 'read_1',
              toolName: input.call.toolName,
              output: { code: 'tool_cancelled_by_user' },
              isError: true
            }),
            approved: false
          }
        }
        return resultFor(input.call)
      }),
      persistResult: vi.fn(async (_threadId: string, _turnId: string, entry: ToolCallLike, result: ToolHostResult) => {
        persisted.push({
          callId: entry.callId,
          isError: result.item.kind === 'tool_result' ? result.item.isError : undefined
        })
      }),
      persistSuppressed: vi.fn(async () => undefined)
    } as never)

    await expect(dispatcher.dispatch({
      dispatch: dispatchInput([call('read', 'read_1'), call('grep', 'grep_1')]),
      context
    })).resolves.toBe('continue')
    expect(persisted).toEqual([
      { callId: 'read_1', isError: true },
      { callId: 'grep_1', isError: false }
    ])
  })

  it('reports all-suppressed only when no call executes', async () => {
    const persistSuppressed = vi.fn(async () => undefined)
    const dispatcher = new ToolCallDispatcher({
      executeSafely: vi.fn(),
      persistResult: vi.fn(),
      persistSuppressed
    } as never)
    const calls = [call('read', 'read_1'), call('grep', 'grep_1')]

    await expect(dispatcher.dispatch({
      dispatch: dispatchInput(calls),
      context,
      stormBreaker: { inspect: () => ({ suppress: true, reason: 'duplicate' }) } as never
    })).resolves.toBe('all_suppressed')

    expect(persistSuppressed).toHaveBeenCalledTimes(2)
  })
})
