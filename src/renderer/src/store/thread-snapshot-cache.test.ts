import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import type { ChatState } from './chat-store-types'
import {
  buildPrefetchedThreadSnapshot,
  cacheThreadSnapshot,
  captureThreadSnapshotCacheToken,
  clearThreadSnapshotCache,
  getThreadSnapshot,
  invalidateThreadSnapshot,
  snapshotThreadProjection,
  THREAD_SNAPSHOT_CACHE_MAX_BYTES,
  threadSnapshotFingerprint,
  threadSnapshotCacheStats
} from './thread-snapshot-cache'

function thread(id: string, overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-08-23T00:00:00.000Z',
    model: 'deepseek-chat',
    mode: 'agent',
    status: 'idle',
    ...overrides
  }
}

function stateFor(threadId: string): ChatState {
  return {
    activeThreadId: threadId,
    threads: [thread(threadId)],
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

  it('rejects a snapshot when the authoritative thread fingerprint changes', () => {
    const state = stateFor('thr_changed')
    snapshotThreadProjection(state, 10)
    const changed = thread('thr_changed', {
      updatedAt: '2026-08-23T00:01:00.000Z',
      latestSeq: 2
    })

    expect(getThreadSnapshot('thr_changed', threadSnapshotFingerprint(changed))).toBeNull()
    expect(threadSnapshotCacheStats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('fences a late prewarm write after thread invalidation', () => {
    const target = thread('thr_late')
    const snapshot = buildPrefetchedThreadSnapshot(target, {
      blocks: [{ kind: 'assistant', id: 'answer', text: 'fresh' }],
      latestSeq: 1,
      threadStatus: 'idle',
      payloadBytes: 10
    })
    const token = captureThreadSnapshotCacheToken(target.id)
    invalidateThreadSnapshot(target.id)

    expect(snapshot).not.toBeNull()
    expect(cacheThreadSnapshot(snapshot!, token)).toBe(false)
    expect(getThreadSnapshot(target.id)).toBeNull()
  })

  it('builds click-ready settled snapshots but skips running details', () => {
    const target = thread('thr_ready')
    const settled = buildPrefetchedThreadSnapshot(target, {
      blocks: [{ kind: 'assistant', id: 'answer', text: 'ready' }],
      latestSeq: 3,
      threadStatus: 'idle',
      historyCursor: 'cursor-1',
      hasMoreHistory: true,
      payloadBytes: 42
    })
    const running = buildPrefetchedThreadSnapshot(target, {
      blocks: [{ kind: 'assistant', id: 'answer-running', text: '' }],
      latestSeq: 4,
      threadStatus: 'running',
      latestTurnStatus: 'running'
    })

    expect(settled).toMatchObject({
      threadId: target.id,
      lastSeq: 3,
      threadHistoryCursor: 'cursor-1',
      threadHasMoreHistory: true,
      busy: false,
      payloadBytes: 42
    })
    expect(running).toBeNull()
  })
})
