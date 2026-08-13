import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CanvasReceiptRegistry, type CanvasReceiptRegistryDeps } from './canvas-receipt-registry'

const call = { callId: 'call_1', toolName: 'design_update_shapes', arguments: {} }

function makeRegistry() {
  const applied: unknown[] = []
  const records: Array<Record<string, unknown>> = []
  const record = vi.fn(async (event: unknown) => {
    records.push(event as Record<string, unknown>)
  })
  const registry = new CanvasReceiptRegistry({
    turns: {
      applyItem: async (threadId: string, item: unknown) => {
        applied.push({ threadId, item })
      }
    },
    events: { record },
    nowIso: () => '2026-08-13T00:00:00.000Z'
  } as unknown as CanvasReceiptRegistryDeps)
  return { registry, applied, records }
}

describe('CanvasReceiptRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('finalizes a turn receipt as applied with the real outcome', async () => {
    const { registry, applied, records } = makeRegistry()
    registry.register({
      receiptKey: 'design-receipt-abc',
      threadId: 'thread_1',
      turnId: 'turn_1',
      call,
      itemId: 'item_call_1',
      acceptedOutput: { ok: true, status: 'accepted', receiptKey: 'design-receipt-abc', ops: [] }
    })
    const wait = registry.awaitTurnReceipts('thread_1', 'turn_1', 45_000)
    const fulfilled = await registry.fulfillTurn('thread_1', 'turn_1', {
      status: 'applied',
      affectedIds: ['shape-1']
    })
    await wait
    expect(fulfilled).toBe(true)
    expect(applied).toHaveLength(1)
    const item = (applied[0] as { item: { output: Record<string, unknown>; isError?: boolean } }).item
    expect(item.output).toMatchObject({ ok: true, status: 'applied', unverified: false, affectedIds: ['shape-1'] })
    expect(item.isError).toBe(false)
    expect(records.some((record) => record.kind === 'canvas_receipt' && record.status === 'applied')).toBe(true)
  })

  it('finalizes a failed turn receipt as an error result', async () => {
    const { registry, applied } = makeRegistry()
    registry.register({
      receiptKey: 'design-receipt-xyz',
      threadId: 'thread_1',
      turnId: 'turn_2',
      call,
      itemId: 'item_call_2',
      acceptedOutput: { ok: true, status: 'accepted', ops: [] }
    })
    const wait = registry.awaitTurnReceipts('thread_1', 'turn_2', 45_000)
    await registry.fulfillTurn('thread_1', 'turn_2', {
      status: 'failed',
      errors: [{ code: 'INVALID_OP', message: 'bad op' }]
    })
    await wait
    const item = (applied[0] as { item: { output: Record<string, unknown>; isError: boolean } }).item
    expect(item.output).toMatchObject({ ok: false, status: 'failed', unverified: false, errors: [{ code: 'INVALID_OP', message: 'bad op' }] })
    expect(item.isError).toBe(true)
  })

  it('times out to an explicit unverified result (never ok:true)', async () => {
    const { registry, applied } = makeRegistry()
    registry.register({
      receiptKey: 'design-receipt-timeout',
      threadId: 'thread_1',
      turnId: 'turn_3',
      call,
      itemId: 'item_call_3',
      acceptedOutput: { ok: true, status: 'accepted', ops: [] }
    })
    const wait = registry.awaitTurnReceipts('thread_1', 'turn_3', 100)
    await vi.advanceTimersByTimeAsync(200)
    await wait
    const item = (applied[0] as { item: { output: Record<string, unknown>; isError: boolean } }).item
    expect(item.output).toMatchObject({ ok: false, status: 'accepted', unverified: true })
    expect(item.isError).toBe(true)
  })

  it('is idempotent: a second turn receipt for a settled turn is ignored', async () => {
    const { registry } = makeRegistry()
    registry.register({
      receiptKey: 'design-receipt-dup',
      threadId: 'thread_1',
      turnId: 'turn_4',
      call,
      itemId: 'item_call_4',
      acceptedOutput: { ok: true, status: 'accepted', ops: [] }
    })
    const first = await registry.fulfillTurn('thread_1', 'turn_4', { status: 'applied' })
    const second = await registry.fulfillTurn('thread_1', 'turn_4', { status: 'failed' })
    expect(first).toBe(true)
    expect(second).toBe(false)
  })
})
