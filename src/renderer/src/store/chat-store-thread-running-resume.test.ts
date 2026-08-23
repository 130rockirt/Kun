import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread, ThreadEventSink } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { clearThreadSnapshotCache } from './thread-snapshot-cache'

const registryMock = vi.hoisted(() => ({ getProvider: vi.fn() }))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

import { createThreadActions } from './chat-store-thread-actions'

function thread(id: string, overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-08-23T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace: '/workspace/deepseek-gui',
    status: 'running',
    ...overrides
  }
}

function buildHarness(busyUnconfirmed = false): {
  actions: ReturnType<typeof createThreadActions>
  state: ChatState
} {
  let state: ChatState
  state = {
    activeThreadId: 'thr_a',
    activeThreadRelation: 'primary',
    activeThreadParentId: null,
    activeThreadGoal: null,
    activeThreadTodos: null,
    awaitingUserInputThreadIds: {},
    blocks: [{ kind: 'user', id: 'a-user', text: 'Run the long task' }],
    busy: true,
    busyUnconfirmed,
    clawChannels: [],
    codeWorkspaceRoots: [],
    composerModel: '',
    composerMode: 'agent',
    composerOrchestration: 'direct',
    composerPickList: [],
    composerModelGroups: [],
    composerProviderId: '',
    currentTurnId: 'turn_a',
    currentTurnOrchestration: 'direct',
    currentTurnUserId: 'a-user',
    error: null,
    extensionComposerContexts: [],
    lastSeq: 11,
    liveDeltaSeqFloor: 11,
    liveReasoning: 'Still working',
    liveAssistant: '',
    queuedMessages: [],
    recoverActiveTurn: vi.fn(async () => true),
    refreshThreads: vi.fn(async () => undefined),
    route: 'chat',
    runtimeConnection: 'ready',
    threadLoadingId: null,
    threadHistoryCursor: null,
    threadHasMoreHistory: false,
    threadHistoryLoading: false,
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    turnStartedAtByUserId: {},
    unreadThreadIds: {},
    watchTurnCompletion: {},
    threads: [
      thread('thr_a', {
        latestSeq: 11,
        latestTurnId: 'turn_a',
        latestTurnStatus: 'running'
      }),
      thread('thr_b', {
        status: 'idle',
        latestSeq: 22,
        latestTurnId: 'turn_b',
        latestTurnStatus: 'completed'
      })
    ]
  } as unknown as ChatState
  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, update)
  }
  const get: ChatStoreGet = () => state
  const actions = createThreadActions({ set, get, sseAbortRef: { current: null } })
  return { actions, state }
}

function settledDetail() {
  return {
    blocks: [{ kind: 'assistant' as const, id: 'b-answer', text: 'B' }],
    latestSeq: 22,
    threadStatus: 'idle',
    latestTurnId: 'turn_b',
    latestTurnStatus: 'completed'
  }
}

describe('running thread parked projection resume', () => {
  beforeEach(() => {
    clearThreadSnapshotCache()
    registryMock.getProvider.mockReset()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
  })

  afterEach(() => {
    clearThreadSnapshotCache()
    vi.unstubAllGlobals()
  })

  it('restores immediately across sequence drift and replays from the parked cursor', async () => {
    const sinks = new Map<string, ThreadEventSink>()
    const subscribeThreadEvents = vi.fn(async (
      id: string,
      _sinceSeq: number,
      sink: ThreadEventSink
    ) => {
      sinks.set(id, sink)
    })
    const getThreadDetail = vi.fn(async (id: string) => {
      if (id === 'thr_b') return settledDetail()
      throw new Error(`unexpected detail request for ${id}`)
    })
    registryMock.getProvider.mockReturnValue({ getThreadDetail, subscribeThreadEvents })
    const { actions, state } = buildHarness()

    await actions.selectThread('thr_b')
    state.threads = state.threads.map((candidate) => candidate.id === 'thr_a'
      ? { ...candidate, updatedAt: '2026-08-23T00:01:00.000Z', latestSeq: 15 }
      : candidate)

    const selecting = actions.selectThread('thr_a')

    expect(state.activeThreadId).toBe('thr_a')
    expect(state.threadLoadingId).toBeNull()
    expect(state.blocks).toEqual([{ kind: 'user', id: 'a-user', text: 'Run the long task' }])
    expect(state.busy).toBe(true)
    expect(state.busyUnconfirmed).toBe(false)
    expect(state.liveReasoning).toBe('Still working')
    expect(getThreadDetail).toHaveBeenCalledTimes(1)
    await selecting
    expect(subscribeThreadEvents).toHaveBeenLastCalledWith(
      'thr_a',
      11,
      expect.anything(),
      expect.anything()
    )

    const resumedSink = sinks.get('thr_a')
    expect(resumedSink).toBeDefined()
    resumedSink!.onDeltas([{ kind: 'agent_message', text: 'Caught up', seq: 12 }])
    resumedSink!.onSeq(12)
    expect(state.liveAssistant).toBe('Caught up')
    expect(state.lastSeq).toBe(12)

    resumedSink!.onTurnComplete({
      threadId: 'thr_a',
      turnId: 'turn_a',
      status: 'completed',
      seq: 13
    })
    expect(state.busy).toBe(false)
    expect(state.busyUnconfirmed).toBe(false)
    expect(state.currentTurnId).toBeNull()
  })

  it('preserves the unconfirmed guard for an exact parked snapshot', async () => {
    const getThreadDetail = vi.fn(async (id: string) => {
      if (id === 'thr_b') return settledDetail()
      throw new Error(`unexpected detail request for ${id}`)
    })
    registryMock.getProvider.mockReturnValue({
      getThreadDetail,
      subscribeThreadEvents: vi.fn(async () => undefined)
    })
    const { actions, state } = buildHarness(true)

    await actions.selectThread('thr_b')
    await actions.selectThread('thr_a')

    expect(getThreadDetail).toHaveBeenCalledTimes(1)
    expect(state.busy).toBe(true)
    expect(state.busyUnconfirmed).toBe(true)
  })
})
