import type { TurnItem } from '../contracts/items.js'

export function effectiveHistoryAfterLatestCompaction(items: readonly TurnItem[]): TurnItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'compaction' && item.replacedTokens > 0) {
      return items.slice(index)
    }
  }
  return [...items]
}

export function insertCompactionIntoVisibleHistory(input: {
  visibleItems: readonly TurnItem[]
  compactedItems: readonly TurnItem[]
  summaryItem: TurnItem
}): TurnItem[] {
  const summaryIndex = input.compactedItems.findIndex((item) => item.id === input.summaryItem.id)
  if (summaryIndex < 0) {
    return replaceOrAppendItem(
      coalesceAutomaticCompactions(input.visibleItems, input.summaryItem),
      input.summaryItem
    )
  }

  // Goal context is internal model history. `ContextCompactor` intentionally
  // positions it immediately after the new summary, but the public transcript
  // insertion path otherwise preserves folded items before that summary. Do
  // not let the internal record choose the insertion point: doing so would
  // leave folded visible items after the summary and replay them again.
  const goalContexts = uniqueGoalContexts([
    ...input.compactedItems,
    ...input.visibleItems
  ])
  const tailIds = new Set(
    input.compactedItems
      .slice(summaryIndex + 1)
      .filter((item) => item.kind !== 'goal_context')
      .map((item) => item.id)
  )
  const withoutSummary = coalesceAutomaticCompactions(
    input.visibleItems,
    input.summaryItem
  ).filter((item) => item.id !== input.summaryItem.id && item.kind !== 'goal_context')
  if (tailIds.size === 0) return [...withoutSummary, input.summaryItem, ...goalContexts]

  const insertIndex = withoutSummary.findIndex((item) => tailIds.has(item.id))
  if (insertIndex < 0) return [...withoutSummary, input.summaryItem, ...goalContexts]

  return [
    ...withoutSummary.slice(0, insertIndex),
    input.summaryItem,
    ...goalContexts,
    ...withoutSummary.slice(insertIndex)
  ]
}

function uniqueGoalContexts(items: readonly TurnItem[]): TurnItem[] {
  const seen = new Set<string>()
  const contexts: TurnItem[] = []
  for (const item of items) {
    if (item.kind !== 'goal_context' || seen.has(item.id)) continue
    seen.add(item.id)
    contexts.push(item)
  }
  return contexts
}

function replaceOrAppendItem(items: readonly TurnItem[], item: TurnItem): TurnItem[] {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index < 0) return [...items, item]
  return items.map((existing) => (existing.id === item.id ? item : existing))
}

/**
 * Restore compaction markers to their chronological position for a
 * renderer-facing turn bucket.
 *
 * The canonical session layout intentionally inserts a compaction summary
 * before the retained model-history tail. The UI mirror must not reuse that
 * model-facing order or force the marker to the end of the turn: either choice
 * can put work performed after compaction above the marker. Only compaction
 * items move here; every other item keeps its established relative order.
 */
export function placeCompactionsChronologically(items: readonly TurnItem[]): TurnItem[] {
  const coalesced = coalesceAutomaticCompactions(items)
  const indexed = coalesced.map((item, sourceIndex) => ({ item, sourceIndex }))
  const compactions = indexed.filter(({ item }) => isVisibleCompaction(item))
  if (compactions.length === 0) return coalesced

  const timeline = indexed.filter(({ item }) => !isVisibleCompaction(item))
  const turnOwnerItemIds = new Map<string, string>()
  for (const { item } of indexed) {
    if (item.kind === 'user_message' && !turnOwnerItemIds.has(item.turnId)) {
      turnOwnerItemIds.set(item.turnId, item.id)
    }
  }
  compactions.sort(compareTimelineEntries)

  for (const compaction of compactions) {
    const insertIndex = timeline.findIndex((candidate) =>
      timelineEntryFollowsCompaction(
        candidate,
        compaction,
        turnOwnerItemIds.get(compaction.item.turnId)
      )
    )
    timeline.splice(insertIndex < 0 ? timeline.length : insertIndex, 0, compaction)
  }
  return timeline.map(({ item }) => item)
}

type TimelineEntry = {
  item: TurnItem
  sourceIndex: number
}

function timelineTimestamp(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  const leftTimestamp = timelineTimestamp(left.item.createdAt)
  const rightTimestamp = timelineTimestamp(right.item.createdAt)
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp
  }
  return left.sourceIndex - right.sourceIndex
}

function timelineEntryFollowsCompaction(
  candidate: TimelineEntry,
  compaction: TimelineEntry,
  turnOwnerItemId: string | undefined
): boolean {
  const candidateTimestamp = timelineTimestamp(candidate.item.createdAt)
  const compactionTimestamp = timelineTimestamp(compaction.item.createdAt)
  if (
    candidateTimestamp !== null &&
    compactionTimestamp !== null &&
    candidateTimestamp !== compactionTimestamp
  ) {
    return candidateTimestamp > compactionTimestamp
  }

  // The model-facing insertion can place the summary immediately before the
  // retained user message. At an equal/invalid timestamp, keep that turn owner
  // before the UI marker and use stable source order for every other item.
  if (
    candidate.item.kind === 'user_message' &&
    candidate.item.id === turnOwnerItemId
  ) {
    return false
  }
  return candidate.sourceIndex > compaction.sourceIndex
}

function isVisibleCompaction(item: TurnItem): boolean {
  return item.kind === 'compaction' && item.replacedTokens > 0
}

/** Keep manual markers and only the newest automatic marker for each turn. */
function coalesceAutomaticCompactions(
  items: readonly TurnItem[],
  incoming?: TurnItem
): TurnItem[] {
  const latestAutoByTurn = new Map<string, string>()
  for (const item of [...items, ...(incoming ? [incoming] : [])]) {
    if (isAutomaticCompaction(item)) latestAutoByTurn.set(item.turnId, item.id)
  }
  if (latestAutoByTurn.size === 0) return [...items]
  return items.filter((item) =>
    !isAutomaticCompaction(item) || latestAutoByTurn.get(item.turnId) === item.id
  )
}

function isAutomaticCompaction(item: TurnItem): boolean {
  return item.kind === 'compaction' && item.replacedTokens > 0 && item.auto !== false
}
