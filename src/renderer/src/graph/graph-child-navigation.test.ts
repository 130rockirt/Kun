import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store/chat-store'
import { openGraphChildThread } from './graph-child-navigation'
import { useGraphStore } from './graph-store'

const originalSelectThread = useChatStore.getState().selectThread

describe('Graph child navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useChatStore.setState({
      activeThreadId: 'parent_1',
      selectThread: originalSelectThread
    })
    useGraphStore.setState({
      childReturnTarget: {
        parentThreadId: 'parent_1',
        childThreadId: 'child_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        parentEventSeq: 4,
        childSessionStatus: 'creating',
        observerStatus: 'connecting',
        openedAt: '2026-07-28T00:00:00.000Z'
      }
    })
  })

  afterEach(() => {
    useChatStore.setState({ selectThread: originalSelectThread })
    vi.useRealTimers()
  })

  it('retries a short missing-thread race and opens the same child session', async () => {
    let calls = 0
    const selectThread = vi.fn(async (threadId: string) => {
      calls += 1
      if (calls === 2) useChatStore.setState({ activeThreadId: threadId })
    })
    useChatStore.setState({ selectThread })

    const opening = openGraphChildThread('child_1')
    await vi.advanceTimersByTimeAsync(250)
    await expect(opening).resolves.toBe(true)

    expect(selectThread).toHaveBeenCalledTimes(2)
    expect(useGraphStore.getState().childReturnTarget?.childSessionStatus).toBe('open')
  })

  it('keeps return context and reports a bounded failure without resetting Graph', async () => {
    const selectThread = vi.fn(async () => undefined)
    useChatStore.setState({ selectThread })

    const opening = openGraphChildThread('child_1')
    await vi.runAllTimersAsync()
    await expect(opening).resolves.toBe(false)

    expect(selectThread).toHaveBeenCalledTimes(6)
    expect(selectThread).toHaveBeenLastCalledWith('parent_1')
    expect(useGraphStore.getState().childReturnTarget).toMatchObject({
      runId: 'run_1',
      nodeId: 'node_1',
      childSessionStatus: 'failed'
    })
    expect(useChatStore.getState().activeThreadId).toBe('parent_1')
  })
})
