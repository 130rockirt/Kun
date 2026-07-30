import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEventSink } from '../agent/types'
import { useGraphStore } from './graph-store'
import { useGraphParentObserver } from './use-graph-parent-observer'

const provider = vi.hoisted(() => ({
  subscribeThreadEvents: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: () => provider
}))

function Harness({ activeThreadId }: { activeThreadId: string | null }) {
  useGraphParentObserver(activeThreadId)
  return null
}

describe('Graph parent observer', () => {
  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useGraphStore.setState({
      threadId: 'parent_1',
      childRuns: {},
      childReturnTarget: {
        parentThreadId: 'parent_1',
        childThreadId: 'child_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        parentEventSeq: 7,
        childSessionStatus: 'open',
        observerStatus: 'connecting',
        openedAt: '2026-07-28T00:00:00.000Z'
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes to the parent while the child transcript is foregrounded', async () => {
    provider.subscribeThreadEvents.mockImplementation(
      (_threadId: string, _seq: number, _sink: ThreadEventSink, signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
          once: true
        }))
    )
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(Harness, { activeThreadId: 'child_1' }))
    })

    expect(provider.subscribeThreadEvents).toHaveBeenCalledTimes(1)
    const [threadId, sinceSeq, sink] = provider.subscribeThreadEvents.mock.calls[0]!
    expect([threadId, sinceSeq]).toEqual(['parent_1', 7])

    act(() => {
      ;(sink as ThreadEventSink).onConnected?.()
    })
    expect(useGraphStore.getState().childReturnTarget).toMatchObject({
      parentEventSeq: 7,
      observerStatus: 'live'
    })

    act(() => {
      ;(sink as ThreadEventSink).onSeq(9)
      ;(sink as ThreadEventSink).onChildRuntimeEvent?.({
        seq: 9,
        timestamp: '2026-07-28T00:00:09.000Z',
        child: {
          parentThreadId: 'parent_1',
          parentTurnId: 'turn_1',
          childId: 'child_1',
          childStatus: 'running',
          childSeq: 1,
          activity: {
            phase: 'tool',
            label: 'Reading files',
            toolName: 'read_file',
            startedAt: '2026-07-28T00:00:00.000Z',
            updatedAt: '2026-07-28T00:00:09.000Z'
          }
        }
      })
    })

    expect(useGraphStore.getState().childReturnTarget).toMatchObject({
      parentEventSeq: 9,
      observerStatus: 'live'
    })
    expect(useGraphStore.getState().childRuns.child_1?.activity?.label).toBe('Reading files')

    await act(async () => renderer!.unmount())
    expect(useGraphStore.getState().childReturnTarget?.observerStatus).toBe('stopped')
  })

  it('reconnects from the latest parent cursor without dropping activity history', async () => {
    vi.useFakeTimers()
    provider.subscribeThreadEvents
      .mockImplementationOnce(async (
        _threadId: string,
        _seq: number,
        sink: ThreadEventSink
      ) => {
        sink.onSeq(12)
      })
      .mockImplementation(
        (_threadId: string, _seq: number, _sink: ThreadEventSink, signal: AbortSignal) =>
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
            once: true
          }))
      )

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(Harness, { activeThreadId: 'child_1' }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(provider.subscribeThreadEvents).toHaveBeenCalledTimes(2)
    expect(provider.subscribeThreadEvents.mock.calls[1]?.slice(0, 2)).toEqual([
      'parent_1',
      12
    ])

    await act(async () => renderer!.unmount())
  })
})
