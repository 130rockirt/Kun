import type { AgentProvider } from '../agent/types'
import type { ChatState } from './chat-store-types'

export type ThreadEventSinkBinding = {
  threadId?: string
  signal?: AbortSignal
  /** Cursor already projected; replayed deltas at or below it are duplicates. */
  sinceSeq?: number
  /** Keep a parked projection covered until replay reaches this cursor. */
  revealAfterSeq?: number
  getThreadDetail?: AgentProvider['getThreadDetail']
}

export function parkedThreadReplayHighWater(
  snapshot: { busy: boolean; lastSeq: number },
  thread: { latestSeq?: number } | null
): number | undefined {
  return snapshot.busy &&
    typeof thread?.latestSeq === 'number' &&
    thread.latestSeq > snapshot.lastSeq
    ? thread.latestSeq
    : undefined
}

export function replayCursorPatch(
  state: ChatState,
  threadId: string,
  revealAfterSeq: number | undefined,
  observedSeq: number
): Pick<ChatState, 'lastSeq'> & Partial<Pick<ChatState, 'threadLoadingId'>> {
  const lastSeq = Math.max(state.lastSeq, observedSeq)
  const replayReady = Boolean(
    threadId &&
    typeof revealAfterSeq === 'number' &&
    lastSeq >= revealAfterSeq &&
    state.threadLoadingId === threadId
  )
  return { lastSeq, ...(replayReady ? { threadLoadingId: null } : {}) }
}

export function replayLoadingIsPending(
  state: ChatState,
  threadId: string,
  revealAfterSeq: number | undefined
): boolean {
  return typeof revealAfterSeq === 'number' &&
    Boolean(threadId) &&
    state.threadLoadingId === threadId
}
