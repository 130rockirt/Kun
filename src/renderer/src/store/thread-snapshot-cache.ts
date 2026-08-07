import type { ChatState, QueuedUserMessage } from './chat-store-types'
import type { ChatBlock, ThreadGoal, ThreadTodoList } from '../agent/types'

export const THREAD_SNAPSHOT_CACHE_MAX_ENTRIES = 6
export const THREAD_SNAPSHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024
// A snapshot normally gets the actual HTTP payload size on hydration. The
// conservative fallback still makes a locally-created thread bounded if it is
// switched away before a durable detail response has been observed.
const UNKNOWN_SNAPSHOT_BYTES = 4 * 1024 * 1024

export type ThreadSnapshot = {
  threadId: string
  blocks: ChatBlock[]
  lastSeq: number
  liveDeltaSeqFloor: number
  liveReasoning: string
  liveAssistant: string
  busy: boolean
  currentTurnId: string | null
  currentTurnOrchestration: 'direct' | 'graph' | null
  currentTurnUserId: string | null
  turnStartedAtByUserId: Record<string, number>
  turnDurationByUserId: Record<string, number>
  turnReasoningFirstAtByUserId: Record<string, number>
  turnReasoningLastAtByUserId: Record<string, number>
  activeThreadRelation: 'primary' | 'fork' | 'side' | null
  activeThreadParentId: string | null
  activeThreadGoal: ThreadGoal | null
  activeThreadTodos: ThreadTodoList | null
  queuedMessages: QueuedUserMessage[]
  composerMode: 'plan' | 'agent'
  composerModel: string
  composerProviderId: string
  composerReasoningEffort: ChatState['composerReasoningEffort']
  payloadBytes: number
}

const snapshots = new Map<string, ThreadSnapshot>()
let totalBytes = 0

function normalizedPayloadBytes(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : UNKNOWN_SNAPSHOT_BYTES
}

function evictUntilBounded(): void {
  while (
    snapshots.size > THREAD_SNAPSHOT_CACHE_MAX_ENTRIES ||
    totalBytes > THREAD_SNAPSHOT_CACHE_MAX_BYTES
  ) {
    const oldestId = snapshots.keys().next().value as string | undefined
    if (!oldestId) return
    const oldest = snapshots.get(oldestId)
    snapshots.delete(oldestId)
    totalBytes -= oldest?.payloadBytes ?? 0
  }
}

export function snapshotThreadProjection(state: ChatState, payloadBytes?: number): void {
  const threadId = state.activeThreadId
  if (!threadId || state.threadLoadingId === threadId) return
  const existing = snapshots.get(threadId)
  const bytes = normalizedPayloadBytes(payloadBytes ?? existing?.payloadBytes)
  if (bytes > THREAD_SNAPSHOT_CACHE_MAX_BYTES) {
    invalidateThreadSnapshot(threadId)
    return
  }
  if (existing) {
    snapshots.delete(threadId)
    totalBytes -= existing.payloadBytes
  }
  snapshots.set(threadId, {
    threadId,
    blocks: state.blocks,
    lastSeq: state.lastSeq,
    liveDeltaSeqFloor: state.liveDeltaSeqFloor,
    liveReasoning: state.liveReasoning,
    liveAssistant: state.liveAssistant,
    busy: state.busy,
    currentTurnId: state.currentTurnId,
    currentTurnOrchestration: state.currentTurnOrchestration,
    currentTurnUserId: state.currentTurnUserId,
    turnStartedAtByUserId: state.turnStartedAtByUserId,
    turnDurationByUserId: state.turnDurationByUserId,
    turnReasoningFirstAtByUserId: state.turnReasoningFirstAtByUserId,
    turnReasoningLastAtByUserId: state.turnReasoningLastAtByUserId,
    activeThreadRelation: state.activeThreadRelation,
    activeThreadParentId: state.activeThreadParentId,
    activeThreadGoal: state.activeThreadGoal,
    activeThreadTodos: state.activeThreadTodos,
    queuedMessages: state.queuedMessages,
    composerMode: state.composerMode,
    composerModel: state.composerModel,
    composerProviderId: state.composerProviderId,
    composerReasoningEffort: state.composerReasoningEffort,
    payloadBytes: bytes
  })
  totalBytes += bytes
  evictUntilBounded()
}

export function getThreadSnapshot(threadId: string): ThreadSnapshot | null {
  const snapshot = snapshots.get(threadId)
  if (!snapshot) return null
  // Map insertion order is our LRU ordering.
  snapshots.delete(threadId)
  snapshots.set(threadId, snapshot)
  return snapshot
}

export function invalidateThreadSnapshot(threadId: string): void {
  const existing = snapshots.get(threadId)
  if (!existing) return
  snapshots.delete(threadId)
  totalBytes -= existing.payloadBytes
}

export function clearThreadSnapshotCache(): void {
  snapshots.clear()
  totalBytes = 0
}

/** Test-only, kept narrow so product code never depends on cache internals. */
export function threadSnapshotCacheStats(): { entries: number; bytes: number } {
  return { entries: snapshots.size, bytes: totalBytes }
}
