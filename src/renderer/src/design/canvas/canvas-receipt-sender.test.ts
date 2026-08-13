import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendCanvasTurnReceipt } from './canvas-receipt-sender'

const mocks = vi.hoisted(() => ({ runtimeRequest: vi.fn(async () => ({})) }))

vi.mock('../../agent/runtime-client', () => ({
  rendererRuntimeClient: { runtimeRequest: (...args: unknown[]) => mocks.runtimeRequest(...args) }
}))

describe('sendCanvasTurnReceipt', () => {
  beforeEach(() => {
    mocks.runtimeRequest.mockClear()
    vi.stubGlobal('window', { kunGui: {} })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('acknowledges a keyed no-op without waiting for turn completion', () => {
    sendCanvasTurnReceipt({
      threadId: 'thread-1',
      turnId: 'turn-1',
      receiptKey: 'design-receipt-noop',
      affectedIds: [],
      errors: []
    })

    expect(mocks.runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thread-1/canvas-receipts',
      'POST',
      JSON.stringify({
        turnId: 'turn-1',
        receiptKey: 'design-receipt-noop',
        status: 'applied'
      })
    )
  })

  it('keeps suppressing empty legacy turn-level receipts', () => {
    sendCanvasTurnReceipt({
      threadId: 'thread-1', turnId: 'turn-1', affectedIds: [], errors: []
    })
    expect(mocks.runtimeRequest).not.toHaveBeenCalled()
  })
})
