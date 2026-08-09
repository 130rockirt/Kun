import type { ChatBlock, ThreadDeltaEvent, ToolBlock, ToolEventPayload } from '../agent/types'
import type { ChatState } from './chat-store-types'

export function monotonicToolStatus(
  current: ToolBlock['status'],
  incoming: ToolBlock['status']
): ToolBlock['status'] {
  // A persisted replay may contain the historical tool_call_started record
  // after the snapshot already contains its terminal result.  Terminal state
  // is durable; only a running -> terminal transition is actionable.
  return current !== 'running' && incoming === 'running' ? current : incoming
}

export function unseenDeltaText(
  delta: ThreadDeltaEvent,
  blocks: ChatBlock[],
  liveText: string,
  liveItemId: string | undefined
): string {
  const offset = delta.deltaOffset
  if (
    !delta.itemId ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    // Legacy events have no stable item-relative position and retain the
    // original append-only projection semantics.
    return delta.text
  }

  const blockKind = delta.kind === 'agent_message' ? 'assistant' : 'reasoning'
  const hydrated = blocks.find(
    (block) => block.kind === blockKind && block.id === delta.itemId
  )
  const hydratedText = hydrated && (
    hydrated.kind === 'assistant' || hydrated.kind === 'reasoning'
  ) ? hydrated.text : ''
  const projectedText = hydratedText + (
    liveItemId === delta.itemId ? liveText : ''
  )
  const overlapLength = Math.min(
    delta.text.length,
    Math.max(0, projectedText.length - offset)
  )
  if (
    overlapLength > 0 &&
    projectedText.slice(offset, offset + overlapLength) !== delta.text.slice(0, overlapLength)
  ) {
    // The offset is only a deduplication hint. If the projected prefix does
    // not actually contain this fragment, preserve the payload instead of
    // silently trimming potentially new content.
    return delta.text
  }
  return delta.text.slice(overlapLength)
}

export function flushLiveProjection(
  state: ChatState,
  now: number,
  base: Partial<ChatState> = {}
): Partial<ChatState> {
  let nextBlocks = state.blocks
  const createdAt = new Date(now).toISOString()
  if (state.liveReasoning.trim()) {
    nextBlocks = upsertTimelineBlock(nextBlocks, {
      kind: 'reasoning',
      id: state.liveReasoningItemId ?? `r-${now}`,
      turnId: state.liveReasoningTurnId ?? state.currentTurnId ?? undefined,
      createdAt: state.liveReasoningCreatedAt ?? createdAt,
      text: state.liveReasoning
    })
  }
  if (state.liveAssistant.trim()) {
    nextBlocks = upsertTimelineBlock(nextBlocks, {
      kind: 'assistant',
      id: state.liveAssistantItemId ?? `a-${now}`,
      turnId: state.liveAssistantTurnId ?? state.currentTurnId ?? undefined,
      createdAt: state.liveAssistantCreatedAt ?? createdAt,
      text: state.liveAssistant
    })
  }
  if (
    nextBlocks === state.blocks &&
    !state.liveReasoningItemId &&
    !state.liveReasoningTurnId &&
    !state.liveReasoningCreatedAt &&
    !state.liveAssistantItemId &&
    !state.liveAssistantTurnId &&
    !state.liveAssistantCreatedAt
  ) return base
  return {
    ...base,
    ...(nextBlocks !== state.blocks ? { blocks: nextBlocks } : {}),
    liveReasoning: '',
    liveAssistant: '',
    liveReasoningItemId: undefined,
    liveReasoningTurnId: undefined,
    liveReasoningCreatedAt: undefined,
    liveAssistantItemId: undefined,
    liveAssistantTurnId: undefined,
    liveAssistantCreatedAt: undefined
  }
}

export function updateProjectedThreadStatus(
  threads: ChatState['threads'],
  threadId: string,
  status: string,
  latestTurnStatus?: string,
  latestTurnId?: string
): ChatState['threads'] {
  let changed = false
  const next = threads.map((thread) => {
    if (thread.id !== threadId) return thread
    if (thread.status === status && (
      latestTurnStatus === undefined || thread.latestTurnStatus === latestTurnStatus
    ) && (
      latestTurnId === undefined || thread.latestTurnId === latestTurnId
    )) {
      return thread
    }
    changed = true
    return {
      ...thread,
      status,
      ...(latestTurnStatus ? { latestTurnStatus } : {}),
      ...(latestTurnId ? { latestTurnId } : {})
    }
  })
  return changed ? next : threads
}

export function settleProjectedThreadStatus(
  threads: ChatState['threads'],
  threadId: string,
  latestTurnStatus: 'completed' | 'failed' | 'aborted'
): ChatState['threads'] {
  const thread = threads.find((candidate) => candidate.id === threadId)
  if (!thread || thread.status?.trim().toLowerCase() !== 'running') return threads
  return updateProjectedThreadStatus(threads, threadId, 'idle', latestTurnStatus)
}

export function runtimeEventStartedAt(createdAt: string | undefined, now: number): number {
  if (!createdAt) return now
  const parsed = Date.parse(createdAt)
  if (!Number.isFinite(parsed)) return now
  const maxPastAgeMs = 30 * 60_000
  const maxFutureSkewMs = 5_000
  return parsed < now - maxPastAgeMs || parsed > now + maxFutureSkewMs ? now : parsed
}

export function finalizeTurnTimingAt(state: ChatState, now: number): Partial<ChatState> {
  const userId = state.currentTurnUserId
  if (!userId) return {}
  const startedAt = state.turnStartedAtByUserId[userId]
  if (typeof startedAt !== 'number') return { currentTurnUserId: null }
  return {
    currentTurnUserId: null,
    turnDurationByUserId: {
      ...state.turnDurationByUserId,
      [userId]: Math.max(0, now - startedAt)
    }
  }
}

export function toolBlockChildId(block: ToolBlock): string | undefined {
  const child = block.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child)) {
    const nested = (child as Record<string, unknown>).childId
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return childIdFromDetail(block.detail)
}

export function toolEventChildId(event: ToolEventPayload): string | undefined {
  const child = event.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child)) {
    const nested = (child as Record<string, unknown>).childId
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return childIdFromDetail(event.detail)
}

export function mergeToolProjectionEvents(
  base: ToolEventPayload,
  update: ToolEventPayload
): ToolEventPayload {
  const status = monotonicToolStatus(base.status, update.status)
  // The pending update may be an older queued/running lifecycle snapshot that
  // raced ahead of the settled tool result. Keep terminal summary/detail intact
  // instead of replacing them with the minimal lifecycle payload.
  const staleRunning = status !== update.status
  return {
    ...base,
    turnId: update.turnId ?? base.turnId,
    createdAt: base.createdAt ?? update.createdAt,
    summary: staleRunning ? base.summary : (update.summary || base.summary),
    status,
    toolKind: update.toolKind ?? base.toolKind,
    detail: staleRunning ? base.detail : (update.detail ?? base.detail),
    filePath: update.filePath ?? base.filePath,
    meta: mergeToolProjectionMeta(base.meta, update.meta)
  }
}

export function mergeToolProjectionMeta(
  current: ToolBlock['meta'],
  incoming: ToolEventPayload['meta']
): ToolBlock['meta'] {
  if (!current) return incoming
  if (!incoming) return current
  const merged = { ...current, ...incoming }
  const currentChild = current.child
  const incomingChild = incoming.child
  if (
    currentChild && typeof currentChild === 'object' && !Array.isArray(currentChild) &&
    incomingChild && typeof incomingChild === 'object' && !Array.isArray(incomingChild)
  ) {
    merged.child = mergeChildMetadata(
      currentChild as Record<string, unknown>,
      incomingChild as Record<string, unknown>
    )
  }
  return merged
}

/**
 * Child lifecycle metadata is monotonic: a terminal `childStatus` recorded by
 * the settled result must survive an older queued/running snapshot, while a
 * genuine running -> terminal transition still wins.
 */
function mergeChildMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current, ...incoming }
  const currentStatus = current.childStatus
  const incomingStatus = incoming.childStatus
  if (
    typeof currentStatus === 'string' &&
    typeof incomingStatus === 'string' &&
    isTerminalChildStatus(currentStatus) &&
    (incomingStatus === 'queued' || incomingStatus === 'running')
  ) {
    merged.childStatus = currentStatus
  }
  return merged
}

function isTerminalChildStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

export function isDetachedSubagentToolEvent(event: ToolEventPayload): boolean {
  const child = event.meta?.child
  if (child && typeof child === 'object' && !Array.isArray(child) &&
    (child as Record<string, unknown>).detached === true) return true
  return detailRecord(event.detail)?.detached === true
}

function childIdFromDetail(detail: string | undefined): string | undefined {
  const id = detailRecord(detail)?.childId
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function detailRecord(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail?.trim()) return undefined
  try {
    const parsed = JSON.parse(detail) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function isUserInputInterruptError(message: string | undefined): boolean {
  if (!message) return false
  const normalized = message.trim().toLowerCase()
  return normalized.includes('interrupt') || normalized.includes('cancelled') || normalized.includes('canceled')
}

export function upsertTimelineBlock(blocks: ChatBlock[], incoming: ChatBlock): ChatBlock[] {
  const index = blocks.findIndex(
    (block) => block.kind === incoming.kind && block.id === incoming.id
  )
  if (index < 0) return [...blocks, incoming]
  const current = blocks[index]
  if (sameStableTimelineBlock(current, incoming)) return blocks
  const next = [...blocks]
  next[index] = incoming
  return next
}

function sameStableTimelineBlock(left: ChatBlock, right: ChatBlock): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false
  if (
    (left.kind === 'assistant' && right.kind === 'assistant') ||
    (left.kind === 'reasoning' && right.kind === 'reasoning')
  ) {
    return (
      left.turnId === right.turnId &&
      left.createdAt === right.createdAt &&
      left.text === right.text
    )
  }
  return left === right
}

export function reconcileSnapshotBlocks(current: ChatBlock[], persisted: ChatBlock[]): ChatBlock[] {
  const currentByIdentity = new Map(
    current.map((block) => [`${block.kind}:${block.id}`, block] as const)
  )
  return persisted.map((block) => {
    const existing = currentByIdentity.get(`${block.kind}:${block.id}`)
    return existing && sameStableTimelineBlock(existing, block) ? existing : block
  })
}

export function reconcileSnapshotTurn(
  current: ChatBlock[],
  persisted: ChatBlock[],
  turnId: string,
  userBlockId?: string | null
): ChatBlock[] {
  const persistedTurn = persisted.filter(
    (block) => block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId)
  )
  if (persistedTurn.length === 0) return current

  const currentByIdentity = new Map(
    current.map((block) => [`${block.kind}:${block.id}`, block] as const)
  )
  const stablePersistedTurn = persistedTurn.map((block) => {
    const existing = currentByIdentity.get(`${block.kind}:${block.id}`)
    return existing && sameStableTimelineBlock(existing, block) ? existing : block
  })
  const explicitTargetIndexes = current.flatMap((block, index) =>
    block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId) ? [index] : []
  )
  const userIndex = userBlockId
    ? current.findIndex((block) => block.kind === 'user' && block.id === userBlockId)
    : -1
  let nextUserIndex = current.length
  if (userIndex >= 0) {
    for (let index = userIndex + 1; index < current.length; index += 1) {
      if (current[index]?.kind === 'user') {
        nextUserIndex = index
        break
      }
    }
  }
  const belongsToTarget = (block: ChatBlock, index: number): boolean => {
    if (block.turnId === turnId || Boolean(userBlockId && block.id === userBlockId)) return true
    return (
      userIndex >= 0 &&
      index > userIndex &&
      index < nextUserIndex &&
      !block.turnId &&
      (block.kind === 'assistant' || block.kind === 'reasoning')
    )
  }
  const insertionIndex = explicitTargetIndexes.length > 0
    ? Math.min(...explicitTargetIndexes)
    : current.length
  const before = current.slice(0, insertionIndex).filter((block, index) => !belongsToTarget(block, index))
  const after = current.slice(insertionIndex).filter(
    (block, offset) => !belongsToTarget(block, insertionIndex + offset)
  )
  return [...before, ...stablePersistedTurn, ...after]
}
