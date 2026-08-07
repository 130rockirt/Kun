import { afterEach, describe, expect, it } from 'vitest'
import type { ChatState } from './chat-store-types'
import {
  clearThreadSnapshotCache,
  getThreadSnapshot,
  snapshotThreadProjection,
  THREAD_SNAPSHOT_CACHE_MAX_BYTES,
  threadSnapshotCacheStats
} from './thread-snapshot-cache'

function stateFor(threadId: string): ChatState {
  return {
    activeThreadId: threadId,
    threadLoadingId: null,
    blocks: [{ kind: 'assistant', id: `${threadId}-answer`, text: threadId }],
    lastSeq: 1,
    liveDeltaSeqFloor: 1,
    liveReasoning: '',
    liveAssistant: '',
    busy: false,
    currentTurnId: null,
    currentTurnOrchestration: null,
    currentTurnUserId: null,
    turnStartedAtByUserId: {},
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    activeThreadRelation: 'primary',
    activeThreadParentId: null,
    activeThreadGoal: null,
    activeThreadTodos: null,
    queuedMessages: [],
    composerMode: 'agent',
    composerModel: '',
    composerProviderId: '',
    composerReasoningEffort: 'max'
  } as unknown as ChatState
}

describe('thread snapshot cache', () => {
  afterEach(() => clearThreadSnapshotCache())

  it('keeps an LRU of six renderer projections', () => {
    for (let index = 0; index < 7; index += 1) {
      snapshotThreadProjection(stateFor(`thr_${index}`), 1)
    }

    expect(threadSnapshotCacheStats()).toEqual({ entries: 6, bytes: 6 })
    expect(getThreadSnapshot('thr_0')).toBeNull()
    expect(getThreadSnapshot('thr_6')?.lastSeq).toBe(1)
  })

  it('does not retain one snapshot larger than the shared byte budget', () => {
    snapshotThreadProjection(stateFor('thr_large'), THREAD_SNAPSHOT_CACHE_MAX_BYTES + 1)

    expect(getThreadSnapshot('thr_large')).toBeNull()
    expect(threadSnapshotCacheStats()).toEqual({ entries: 0, bytes: 0 })
  })
})
