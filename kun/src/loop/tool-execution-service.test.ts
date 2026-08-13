import { describe, expect, it, vi } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import type { TurnItem } from '../contracts/items.js'
import type { ToolHost, ToolHostContext, ToolHostResult } from '../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { CanvasReceiptRegistry } from '../services/canvas-receipt-registry.js'
import type { TurnService } from '../services/turn-service.js'
import { InflightTracker } from './inflight-tracker.js'
import { ToolCancellationRegistry } from './tool-cancellation-registry.js'
import { ToolExecutionService } from './tool-execution-service.js'

const call = {
  callId: 'call_1',
  toolName: 'read',
  arguments: {}
}

const context = {
  threadId: 'thread_1',
  turnId: 'turn_1',
  workspace: '/workspace',
  approvalPolicy: 'auto',
  sandboxMode: 'workspace-write',
  abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
} as ToolHostContext

function makeService(input: {
  execute?: ToolHost['execute']
  onPlanWritten?: () => Promise<void>
  awaitWorkspaceCheckpoint?: (requestId: string, signal: AbortSignal) => Promise<string | null>
  toolCancellation?: ToolCancellationRegistry
  receipts?: CanvasReceiptRegistry
} = {}) {
  const lifecycle: string[] = []
  const events: Array<Record<string, unknown>> = []
  const turns = {
    updateItem: vi.fn(async () => { lifecycle.push('update'); return null }),
    updateTurnMetadata: vi.fn(async () => { lifecycle.push('turn-metadata') }),
    applyItem: vi.fn(async () => { lifecycle.push('apply') }),
    publishTransientItem: vi.fn(async () => { lifecycle.push('transient') }),
    compactItemHistory: vi.fn(async () => { lifecycle.push('compact') })
  } as unknown as TurnService
  const service = new ToolExecutionService({
    toolHost: {
      id: 'test-host',
      listTools: async () => [],
      execute: input.execute ?? (async () => ({
        item: makeToolResultItem({
          id: 'item_call_1', threadId: 'thread_1', turnId: 'turn_1', callId: 'call_1', toolName: 'read', output: {}
        }),
        approved: true
      }))
    } as ToolHost,
    inflight: new InflightTracker(),
    turns,
    events: {
      record: async (event: Record<string, unknown>) => { events.push(event) }
    } as unknown as RuntimeEventRecorder,
    nowIso: () => '2026-07-10T00:00:00.000Z',
    ...(input.awaitWorkspaceCheckpoint
      ? { awaitWorkspaceCheckpoint: input.awaitWorkspaceCheckpoint }
      : {}),
    ...(input.onPlanWritten ? { onPlanWritten: input.onPlanWritten } : {}),
    ...(input.toolCancellation ? { toolCancellation: input.toolCancellation } : {}),
    ...(input.receipts ? { receipts: input.receipts } : {})
  })
  return { service, lifecycle, events, turns }
}

describe('ToolExecutionService', () => {
  it('normalizes advertised-tool rejection into a model-visible result', async () => {
    const { service, events } = makeService({
      execute: async () => { throw new Error('unknown tool: missing_tool') }
    })

    const result = await service.executeSafely({
      threadId: 'thread_1', turnId: 'turn_1', call: { ...call, toolName: 'missing_tool' }, context
    })

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: expect.objectContaining({ code: 'tool_dispatch_rejected' })
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', code: 'tool_dispatch_rejected' })
    ]))
  })

  it('turns an accepted tool cancellation into a paired model-visible error result', async () => {
    const registry = new ToolCancellationRegistry()
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => { started = resolve })
    const setup = makeService({
      toolCancellation: registry,
      execute: async (_call, executionContext) => {
        started()
        return await new Promise<never>((_resolve, reject) => {
          executionContext.abortSignal.addEventListener('abort', () => {
            reject(executionContext.abortSignal.reason)
          }, { once: true })
        })
      }
    })
    const parent = new AbortController()
    const execution = setup.service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call,
      context: { ...context, abortSignal: parent.signal }
    })
    await toolStarted
    expect(registry.request(
      { threadId: 'thread_1', turnId: 'turn_1', callId: 'call_1' },
      '2026-08-07T00:00:00.000Z'
    )).toBe('cancellation_requested')
    const result = await execution
    expect(result).toMatchObject({ approved: false, item: { isError: true } })
    expect(result.item.kind === 'tool_result' ? result.item.output : null).toMatchObject({
      code: 'tool_cancelled_by_user',
      guidance: expect.stringContaining('Do not repeat the identical call automatically')
    })
    expect(registry.list()).toEqual([])
  })

  it('keeps the cancellation result when a tool catches abort and returns normally', async () => {
    const registry = new ToolCancellationRegistry()
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => { started = resolve })
    const setup = makeService({
      toolCancellation: registry,
      execute: async (toolCall, executionContext) => {
        started()
        await new Promise<void>((resolve) => {
          executionContext.abortSignal.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          item: makeToolResultItem({
            id: `item_${toolCall.callId}`,
            threadId: 'thread_1',
            turnId: 'turn_1',
            callId: toolCall.callId,
            toolName: toolCall.toolName,
            output: { stale: true }
          }),
          approved: true
        }
      }
    })
    const execution = setup.service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call,
      context: { ...context, abortSignal: new AbortController().signal }
    })
    await toolStarted
    expect(registry.request(
      { threadId: 'thread_1', turnId: 'turn_1', callId: 'call_1' },
      '2026-08-07T00:00:00.000Z'
    )).toBe('cancellation_requested')
    const result = await execution
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
    expect(result.item.kind === 'tool_result' ? result.item.output : null).toMatchObject({
      code: 'tool_cancelled_by_user'
    })
  })

  it('waits for a pending checkpoint before the first workspace mutation', async () => {
    const order: string[] = []
    const setup = makeService({
      awaitWorkspaceCheckpoint: async (requestId) => {
        order.push(`checkpoint:${requestId}`)
        return 'gcp_ready'
      },
      execute: async () => {
        order.push('execute')
        return {
          item: makeToolResultItem({
            id: 'item_call_1',
            threadId: 'thread_1',
            turnId: 'turn_1',
            callId: 'call_1',
            toolName: 'write',
            output: {}
          }),
          approved: true
        }
      }
    })

    await setup.service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call: { ...call, toolName: 'write', toolKind: 'file_change' },
      context: { ...context, workspaceCheckpointRequestId: 'gcp_pending' }
    })

    expect(order).toEqual(['checkpoint:gcp_pending', 'execute'])
    expect(setup.turns.updateTurnMetadata).toHaveBeenCalledWith(
      'thread_1',
      'turn_1',
      { workspaceCheckpointId: 'gcp_ready' }
    )
    expect(setup.turns.updateItem).toHaveBeenCalledWith(
      'thread_1',
      'item_turn_1_user',
      { workspaceCheckpointId: 'gcp_ready' }
    )
  })

  it('persists a successful plan result before notifying the plan callback', async () => {
    let lifecycle: string[] = []
    const setup = makeService({
      onPlanWritten: async () => { lifecycle.push('plan') }
    })
    lifecycle = setup.lifecycle
    const result: ToolHostResult = {
      item: makeToolResultItem({
        id: 'item_call_plan', threadId: 'thread_1', turnId: 'turn_1', callId: 'call_plan',
        toolName: 'create_plan', output: { plan_id: 'plan_1', relative_path: '.kun/plan.md' }
      }),
      approved: true
    }

    await setup.service.persistResult('thread_1', 'turn_1', {
      callId: 'call_plan',
      toolName: 'create_plan',
      arguments: { markdown: '# Plan' }
    }, result)

    expect(lifecycle).toEqual(['update', 'apply', 'plan', 'compact'])
  })

  it('registers a renderer receipt before publishing its accepted result', async () => {
    const register = vi.fn()
    const setup = makeService({
      receipts: { register } as unknown as CanvasReceiptRegistry
    })
    const result: ToolHostResult = {
      item: makeToolResultItem({
        id: 'item_call_design', threadId: 'thread_1', turnId: 'turn_1',
        callId: 'call_design', toolName: 'design_update_shapes',
        output: { status: 'accepted', receiptKey: 'design-receipt-order', ops: [] }
      }),
      approved: true
    }

    await setup.service.persistResult('thread_1', 'turn_1', {
      callId: 'call_design', toolName: 'design_update_shapes', arguments: {}
    }, result)

    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(setup.turns.applyItem).mock.invocationCallOrder[0]!)
  })

  it('persists storm suppression as a failed result and public event', async () => {
    const { service, lifecycle, events } = makeService()

    await service.persistSuppressed({
      threadId: 'thread_1', turnId: 'turn_1', call, reason: 'duplicate call'
    })

    expect(lifecycle).toEqual(['update', 'apply'])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_storm_suppressed', message: 'duplicate call' })
    ]))
  })

  it('drains in-flight progress and ignores updates after tool execution completes', async () => {
    let emitUpdate: ((item: TurnItem) => Promise<void> | void) | undefined
    const runningItem = makeToolResultItem({
      id: 'item_call_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'read',
      output: { partial: true },
      status: 'running'
    })
    const { service, lifecycle } = makeService({
      execute: async (_call, _context, onUpdate) => {
        emitUpdate = onUpdate
        void onUpdate?.(runningItem)
        return {
          item: makeToolResultItem({
            id: 'item_call_1',
            threadId: 'thread_1',
            turnId: 'turn_1',
            callId: 'call_1',
            toolName: 'read',
            output: { completed: true }
          }),
          approved: true
        }
      }
    })

    const result = await service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call,
      context
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', status: 'completed' })
    expect(lifecycle).toEqual(['update', 'apply'])

    await emitUpdate?.(runningItem)
    expect(lifecycle).toEqual(['update', 'apply'])
  })

  it('persists the first progress state and publishes only changed later snapshots transiently', async () => {
    const first = makeToolResultItem({
      id: 'item_call_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'read',
      output: { output: 'a', partial: true },
      status: 'running'
    })
    const second = makeToolResultItem({
      id: 'item_call_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'read',
      output: { output: 'ab', partial: true },
      status: 'running'
    })
    const setup = makeService({
      execute: async (_call, _context, onUpdate) => {
        await onUpdate?.(first)
        await onUpdate?.(first)
        await onUpdate?.(second)
        return {
          item: makeToolResultItem({
            id: first.id,
            threadId: first.threadId,
            turnId: first.turnId,
            callId: 'call_1',
            toolName: 'read',
            output: { output: 'ab', partial: false }
          }),
          approved: true
        }
      }
    })

    await setup.service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call,
      context
    })

    expect(setup.turns.updateItem).toHaveBeenCalledTimes(1)
    expect(setup.turns.applyItem).toHaveBeenCalledTimes(1)
    expect(setup.turns.publishTransientItem).toHaveBeenCalledTimes(1)
    expect(setup.lifecycle).toEqual(['update', 'apply', 'transient'])
  })
})
