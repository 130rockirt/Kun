import type {
  ChatBlock,
  NormalizedThread,
  ThreadDetail,
  ThreadGoal,
  ThreadTodoList
} from '../agent/types'
import type { ChatState, QueuedUserMessage } from './chat-store-types'
import { hydrateBlockModelLabels } from './chat-store-helpers'
import {
  settlePendingRuntimeWorkAfterInterrupt,
  threadSnapshotLooksRunning
} from './chat-store-runtime-helpers'
import {
  queuedMessagesForThread,
  reconcileQueuedMessages
} from './queued-message-persistence'

export const THREAD_SNAPSHOT_CACHE_MAX_ENTRIES = 6
export const THREAD_SNAPSHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024
// A snapshot normally gets the actual HTTP payload size on hydration. The
// conservative fallback still makes a locally-created thread bounded if it is
// switched away before a durable detail response has been observed.
const UNKNOWN_SNAPSHOT_BYTES = 4 * 1024 * 1024

export type ThreadSnapshot = {
  threadId: string
  fingerprint: string
  blocks: ChatBlock[]
  lastSeq: number
  threadHistoryCursor: string | null
  threadHasMoreHistory: boolean
  liveDeltaSeqFloor: number
  liveReasoning: string
  liveAssistant: string
  busy: boolean
  busyUnconfirmed: boolean
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
  payloadBytes: number
}

const snapshots = new Map<string, ThreadSnapshot>()
let totalBytes = 0
let cacheGeneration = 0
const threadGenerations = new Map<string, number>()

export type ThreadSnapshotCacheToken = {
  cacheGeneration: number
  threadGeneration: number
}

type ThreadFingerprintSource = Pick<
  NormalizedThread,
  | 'id'
  | 'updatedAt'
  | 'status'
  | 'latestSeq'
  | 'latestTurnId'
  | 'latestTurnStatus'
  | 'relation'
  | 'archived'
>

export function threadSnapshotFingerprint(thread: ThreadFingerprintSource): string {
  return [
    thread.id,
    thread.updatedAt,
    thread.status?.trim().toLowerCase() ?? '',
    String(thread.latestSeq ?? ''),
    thread.latestTurnId ?? '',
    thread.latestTurnStatus?.trim().toLowerCase() ?? '',
    thread.relation ?? '',
    thread.archived === true ? 'archived' : ''
  ].join('\u0000')
}

export function captureThreadSnapshotCacheToken(threadId: string): ThreadSnapshotCacheToken {
  return {
    cacheGeneration,
    threadGeneration: threadGenerations.get(threadId) ?? 0
  }
}

export function threadSnapshotCacheTokenIsCurrent(
  threadId: string,
  token: ThreadSnapshotCacheToken
): boolean {
  return token.cacheGeneration === cacheGeneration &&
    token.threadGeneration === (threadGenerations.get(threadId) ?? 0)
}

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

function removeSnapshot(threadId: string): void {
  const existing = snapshots.get(threadId)
  if (!existing) return
  snapshots.delete(threadId)
  totalBytes -= existing.payloadBytes
}

export function cacheThreadSnapshot(
  snapshot: ThreadSnapshot,
  token?: ThreadSnapshotCacheToken
): boolean {
  if (token && !threadSnapshotCacheTokenIsCurrent(snapshot.threadId, token)) return false
  const bytes = normalizedPayloadBytes(snapshot.payloadBytes)
  if (bytes > THREAD_SNAPSHOT_CACHE_MAX_BYTES) {
    removeSnapshot(snapshot.threadId)
    return false
  }
  removeSnapshot(snapshot.threadId)
  snapshots.set(snapshot.threadId, { ...snapshot, payloadBytes: bytes })
  totalBytes += bytes
  evictUntilBounded()
  return snapshots.has(snapshot.threadId)
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
  const thread = state.threads?.find((candidate) => candidate.id === threadId)
  cacheThreadSnapshot({
    threadId,
    fingerprint: thread
      ? threadSnapshotFingerprint(thread)
      : [threadId, '', '', '', '', '', '', ''].join('\u0000'),
    blocks: state.blocks,
    lastSeq: state.lastSeq,
    threadHistoryCursor: state.threadHistoryCursor,
    threadHasMoreHistory: state.threadHasMoreHistory,
    liveDeltaSeqFloor: state.liveDeltaSeqFloor,
    liveReasoning: state.liveReasoning,
    liveAssistant: state.liveAssistant,
    busy: state.busy,
    busyUnconfirmed: state.busyUnconfirmed,
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
    payloadBytes: bytes
  })
}

export function getThreadSnapshot(
  threadId: string,
  expectedFingerprint?: string
): ThreadSnapshot | null {
  const snapshot = snapshots.get(threadId)
  if (!snapshot) return null
  if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint) {
    invalidateThreadSnapshot(threadId)
    return null
  }
  // Map insertion order is our LRU ordering.
  snapshots.delete(threadId)
  snapshots.set(threadId, snapshot)
  return snapshot
}

export function buildPrefetchedThreadSnapshot(
  thread: NormalizedThread,
  detail: ThreadDetail
): ThreadSnapshot | null {
  const labeledBlocks =
    detail.relation === 'side' && detail.model
      ? detail.blocks.map((block) =>
          block.kind === 'user' && !block.modelLabel
            ? { ...block, modelLabel: detail.model }
            : block
        )
      : detail.blocks
  const loaded = hydrateBlockModelLabels(thread.id, labeledBlocks)
  const busy = threadSnapshotLooksRunning(
    loaded,
    detail.threadStatus,
    detail.latestTurnStatus
  )
  if (busy) return null
  const blocks = settlePendingRuntimeWorkAfterInterrupt(loaded)
  const queuedMessages = reconcileQueuedMessages(queuedMessagesForThread(thread.id), {
    busy: false,
    turnId: detail.latestTurnId,
    blocks
  })
  return {
    threadId: thread.id,
    fingerprint: threadSnapshotFingerprint(thread),
    blocks,
    lastSeq: detail.latestSeq,
    threadHistoryCursor: detail.historyCursor ?? null,
    threadHasMoreHistory: detail.hasMoreHistory === true,
    liveDeltaSeqFloor: detail.latestSeq,
    liveReasoning: '',
    liveAssistant: '',
    busy: false,
    busyUnconfirmed: false,
    currentTurnId: null,
    currentTurnOrchestration: null,
    currentTurnUserId: null,
    turnStartedAtByUserId: {},
    turnDurationByUserId: detail.turnDurationByUserId ?? {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    activeThreadRelation: detail.relation ?? thread.relation ?? 'primary',
    activeThreadParentId: detail.parentThreadId ?? thread.parentThreadId ?? null,
    activeThreadGoal: detail.goal ?? thread.goal ?? null,
    activeThreadTodos: detail.todos ?? thread.todos ?? null,
    queuedMessages,
    payloadBytes: normalizedPayloadBytes(detail.payloadBytes)
  }
}

export function invalidateThreadSnapshot(threadId: string): void {
  threadGenerations.set(threadId, (threadGenerations.get(threadId) ?? 0) + 1)
  removeSnapshot(threadId)
}

export function clearThreadSnapshotCache(): void {
  snapshots.clear()
  totalBytes = 0
  cacheGeneration += 1
  threadGenerations.clear()
}

/** Test-only, kept narrow so product code never depends on cache internals. */
export function threadSnapshotCacheStats(): { entries: number; bytes: number } {
  return { entries: snapshots.size, bytes: totalBytes }
}
