import { describe, expect, it, vi } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import type { TurnItem } from '../contracts/items.js'
import type { ToolHost, ToolHostContext, ToolHostResult } from '../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import { InflightTracker } from './inflight-tracker.js'
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
} = {}) {
  const lifecycle: string[] = []
  const events: Array<Record<string, unknown>> = []
  const turns = {
    updateItem: vi.fn(async () => { lifecycle.push('update'); return null }),
    applyItem: vi.fn(async () => { lifecycle.push('apply') })
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
    ...(input.onPlanWritten ? { onPlanWritten: input.onPlanWritten } : {})
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

  it('directs rejected PPT tools through managed skill recovery without shell fallback', async () => {
    const { service } = makeService({
      execute: async () => { throw new Error('tool ppt_master_run is not advertised in this turn context') }
    })

    const result = await service.executeSafely({
      threadId: 'thread_1',
      turnId: 'turn_1',
      call: { ...call, toolName: 'ppt_master_run' },
      context
    })
    const output = result.item.kind === 'tool_result' ? JSON.stringify(result.item.output) : ''

    expect(output).toContain('load_skill')
    expect(output).toContain('ppt-master')
    expect(output).toContain('Never run PPT Master scripts through')
    expect(output).toContain('direct Python')
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

    expect(lifecycle).toEqual(['update', 'apply', 'plan'])
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
})
