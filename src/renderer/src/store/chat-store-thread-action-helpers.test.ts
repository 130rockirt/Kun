import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProvider, ThreadEventSink } from '../agent/types'
import type { ChatState } from './chat-store-types'
import { subscribeThreadEventsWithRecovery } from './chat-store-thread-action-helpers'

describe('subscribeThreadEventsWithRecovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rehydrates a selected idle thread after SSE ends so late restart events are not lost', async () => {
    vi.useFakeTimers()
    const recoverActiveTurn = vi.fn(async () => false)
    const state = {
      activeThreadId: 'thread_idle_restart',
      busy: false,
      recoverActiveTurn
    } as unknown as ChatState
    const provider = {
      subscribeThreadEvents: vi.fn(async (
        _threadId: string,
        _sinceSeq: number,
        sink: ThreadEventSink
      ) => {
        sink.onError(new Error('runtime restarted'))
      })
    } as unknown as AgentProvider
    const sink = { onError: vi.fn() } as unknown as ThreadEventSink
    const controller = new AbortController()

    subscribeThreadEventsWithRecovery(
      provider,
      state.activeThreadId!,
      42,
      sink,
      controller.signal,
      () => state
    )
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)

    expect(recoverActiveTurn).toHaveBeenCalledOnce()
    controller.abort()
  })
})
