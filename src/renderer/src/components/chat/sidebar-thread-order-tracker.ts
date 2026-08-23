import type { NormalizedThread } from '../../agent/types'
import {
  sidebarThreadActivity,
  type SidebarThreadActivity,
  type SidebarThreadActivityContext
} from './sidebar-project-selectors'

type ContainerSnapshot = {
  activityById: Map<string, SidebarThreadActivity>
  baselineKey: string
  order: string[]
  touchedAt: number
}

export type SidebarThreadOrderTracker = {
  currentOrder: (containerKey: string) => string[]
  reconcile: (options: {
    baselineKey?: string
    containerKey: string
    context: SidebarThreadActivityContext
    threads: readonly NormalizedThread[]
  }) => NormalizedThread[]
}

const MAX_TRACKED_CONTAINERS = 256

function uniqueThreads(threads: readonly NormalizedThread[]): NormalizedThread[] {
  const seen = new Set<string>()
  const result: NormalizedThread[] = []
  for (const thread of threads) {
    const id = thread.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(thread)
  }
  return result
}

/**
 * Retain the user's previous visual order while inserting newly discovered
 * rows beside their nearest neighbor from the current base order.
 */
function mergeNewRows(baseIds: string[], previousIds: string[]): string[] {
  const validIds = new Set(baseIds)
  const result = previousIds.filter((id) => validIds.has(id))
  const present = new Set(result)

  for (let index = 0; index < baseIds.length; index += 1) {
    const id = baseIds[index]!
    if (present.has(id)) continue
    const following = baseIds.slice(index + 1).find((candidate) => present.has(candidate))
    if (following) {
      result.splice(result.indexOf(following), 0, id)
    } else {
      const preceding = baseIds.slice(0, index).reverse().find((candidate) => present.has(candidate))
      if (preceding) result.splice(result.indexOf(preceding) + 1, 0, id)
      else result.push(id)
    }
    present.add(id)
  }
  return result
}

function partitionPinned(order: string[], byId: Map<string, NormalizedThread>): string[] {
  const pinned: string[] = []
  const unpinned: string[] = []
  for (const id of order) {
    if (byId.get(id)?.pinned === true) pinned.push(id)
    else unpinned.push(id)
  }
  return [...pinned, ...unpinned]
}

function isPersistentAttention(activity: SidebarThreadActivity): boolean {
  return activity === 'awaiting-input' || activity === 'failed' || activity === 'unread'
}

function shouldPromote(
  previous: SidebarThreadActivity | undefined,
  current: SidebarThreadActivity
): boolean {
  if (isPersistentAttention(current) && previous !== current) return true
  return previous === 'running' && current !== 'running'
}

/**
 * The user just opened an unread/failed result. Demote only that row so it
 * lands after the threads that are still working; no other row moves.
 */
function shouldDemoteAfterViewing(
  previous: SidebarThreadActivity | undefined,
  current: SidebarThreadActivity,
  threadId: string,
  context: SidebarThreadActivityContext
): boolean {
  if (previous !== 'unread' && previous !== 'failed') return false
  if (current !== 'read') return false
  return context.activeThreadId === threadId
}

function demoteAfterLastRunning(options: {
  activityById: Map<string, SidebarThreadActivity>
  id: string
  order: string[]
}): string[] {
  const order = [...options.order]
  const from = order.indexOf(options.id)
  if (from < 0) return order
  let insertAt = -1
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (order[index] !== options.id && options.activityById.get(order[index]!) === 'running') {
      insertAt = index + 1
      break
    }
  }
  if (insertAt < 0 || insertAt === from) return order
  const [moved] = order.splice(from, 1)
  if (moved === undefined) return order
  order.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved)
  return order
}

function parsedUpdatedAt(thread: NormalizedThread): number {
  const value = Date.parse(thread.updatedAt)
  return Number.isFinite(value) ? value : 0
}

function promoteAttentionRows(options: {
  byId: Map<string, NormalizedThread>
  order: string[]
  previousOrder: string[]
  promotedIds: string[]
}): string[] {
  const previousIndex = new Map(options.previousOrder.map((id, index) => [id, index]))
  const promotedIds = [...options.promotedIds]
    .filter((id) => options.byId.get(id)?.pinned !== true)
    .sort((left, right) => {
      const timeDifference = parsedUpdatedAt(options.byId.get(right)!) - parsedUpdatedAt(options.byId.get(left)!)
      if (timeDifference !== 0) return timeDifference
      return (previousIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (previousIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
    })
  if (promotedIds.length === 0) return partitionPinned(options.order, options.byId)

  const promoted = new Set(promotedIds)
  const remaining = options.order.filter((id) => !promoted.has(id))
  const pinned = remaining.filter((id) => options.byId.get(id)?.pinned === true)
  const unpinned = remaining.filter((id) => options.byId.get(id)?.pinned !== true)
  return [...pinned, ...promotedIds, ...unpinned]
}

export function createSidebarThreadOrderTracker(): SidebarThreadOrderTracker {
  const snapshots = new Map<string, ContainerSnapshot>()
  let touchSequence = 0

  const evictOldContainers = (): void => {
    if (snapshots.size <= MAX_TRACKED_CONTAINERS) return
    const oldest = [...snapshots.entries()]
      .sort(([, left], [, right]) => left.touchedAt - right.touchedAt)
      .slice(0, snapshots.size - MAX_TRACKED_CONTAINERS)
    for (const [key] of oldest) snapshots.delete(key)
  }

  return {
    currentOrder: (containerKey) => [...(snapshots.get(containerKey)?.order ?? [])],
    reconcile: ({ baselineKey = '', containerKey, context, threads }) => {
      const items = uniqueThreads(threads)
      const byId = new Map(items.map((thread) => [thread.id.trim(), thread] as const))
      const baseIds = items.map((thread) => thread.id.trim())
      const activityById = new Map(
        items.map((thread) => [thread.id.trim(), sidebarThreadActivity(thread, context)] as const)
      )
      const previous = snapshots.get(containerKey)
      const baselineChanged = previous !== undefined && previous.baselineKey !== baselineKey
      let order = previous && !baselineChanged
        ? mergeNewRows(baseIds, previous.order)
        : [...baseIds]
      const promotedIds = baselineChanged
        ? []
        : baseIds.filter((id) => shouldPromote(previous?.activityById.get(id), activityById.get(id)!))
      const demotedViewedIds = baselineChanged
        ? []
        : baseIds.filter((id) =>
            shouldDemoteAfterViewing(
              previous?.activityById.get(id),
              activityById.get(id)!,
              id,
              context
            )
          )

      order = promoteAttentionRows({
        byId,
        order,
        previousOrder: previous?.order ?? baseIds,
        promotedIds
      })
      for (const id of demotedViewedIds) {
        if (byId.get(id)?.pinned === true) continue
        order = demoteAfterLastRunning({ activityById, id, order })
      }
      snapshots.set(containerKey, {
        activityById,
        baselineKey,
        order,
        touchedAt: ++touchSequence
      })
      evictOldContainers()
      return order.flatMap((id) => {
        const thread = byId.get(id)
        return thread ? [thread] : []
      })
    }
  }
}
