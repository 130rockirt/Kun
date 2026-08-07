import { describe, expect, it, vi } from 'vitest'
import { makeToolCallItem } from '../domain/item.js'
import type { ToolCallTurnItem } from '../contracts/items.js'
import type { Turn } from '../contracts/turns.js'
import { ToolCancellationRegistry } from '../loop/tool-cancellation-registry.js'
import { ToolCancellationService } from './tool-cancellation-service.js'

describe('ToolCancellationService', () => {
  it('records the request and keeps retries idempotent after execution cleanup', async () => {
    const call: ToolCallTurnItem = makeToolCallItem({
      id: 'item_call',
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      toolName: 'read',
      arguments: {},
      status: 'running'
    }) as ToolCallTurnItem
    const turn = {
      id: 'turn',
      threadId: 'thread',
      status: 'running',
      items: [call]
    } as unknown as Turn
    const getTurn = vi.fn(async () => turn)
    const updateItem = vi.fn(async (_threadId: string, _itemId: string, patch: Record<string, unknown>) => {
      Object.assign(call, patch)
      return call
    })
    const registry = new ToolCancellationRegistry()
    const registration = registry.register(
      { threadId: 'thread', turnId: 'turn', callId: 'call' },
      new AbortController().signal
    )
    const service = new ToolCancellationService(
      { getTurn, updateItem } as never,
      registry,
      () => '2026-08-07T00:00:00.000Z'
    )

    await expect(service.cancel({ threadId: 'thread', turnId: 'turn', callId: 'call' }))
      .resolves.toMatchObject({ status: 'cancellation_requested' })
    expect(call.cancelRequestedAt).toBe('2026-08-07T00:00:00.000Z')
    expect(updateItem).toHaveBeenCalledWith('thread', 'item_call', {
      cancelRequestedAt: '2026-08-07T00:00:00.000Z'
    })

    await expect(service.cancel({ threadId: 'thread', turnId: 'turn', callId: 'call' }))
      .resolves.toMatchObject({ status: 'already_requested' })
    registration.dispose()
    await expect(service.cancel({ threadId: 'thread', turnId: 'turn', callId: 'call' }))
      .resolves.toMatchObject({ status: 'already_requested' })
  })
})
