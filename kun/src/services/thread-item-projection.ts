import type { TurnItem } from '../contracts/items.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { touchThread } from '../domain/thread.js'
import { placeCompactionsChronologically } from '../loop/compaction-history.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import { withThreadStoreMutation } from './thread-mutation-coordinator.js'

/**
 * Build the renderer-facing item mirror for turns that already exist on a
 * thread. The SessionStore remains canonical: unknown historical turn ids do
 * not manufacture new turn records, and turns without session items retain
 * their current items.
 */
export function projectSessionItemsOntoExistingTurns(
  thread: ThreadRecord,
  items: readonly TurnItem[]
): ThreadRecord | null {
  const itemsByTurn = new Map<string, TurnItem[]>()
  for (const item of items) {
    const turnItems = itemsByTurn.get(item.turnId) ?? []
    turnItems.push(item)
    itemsByTurn.set(item.turnId, turnItems)
  }

  let changed = false
  const turns = thread.turns.map((turn) => {
    const sessionItems = itemsByTurn.get(turn.id)
    if (!sessionItems) return turn
    changed = true
    return { ...turn, items: placeCompactionsChronologically(sessionItems) }
  })
  return changed ? { ...thread, turns } : null
}

export type ThreadItemProjectionServiceDeps = {
  threadStore: ThreadStore
  sessionStore: Pick<SessionStore, 'loadItems'>
  nowIso: () => string
}

/**
 * Synchronizes the canonical session item stream into a thread's UI mirror.
 * Loading session items inside the shared thread-store mutation lock is
 * intentional: a concurrent item append cannot update the thread mirror and
 * then be overwritten by a projection built from an older session snapshot.
 */
export class ThreadItemProjectionService {
  constructor(private readonly deps: ThreadItemProjectionServiceDeps) {}

  async syncFromSession(threadId: string): Promise<void> {
    await withThreadStoreMutation(this.deps.threadStore, threadId, async () => {
      const current = await this.deps.threadStore.get(threadId)
      if (!current) return
      const items = await this.deps.sessionStore.loadItems(threadId)
      const projected = projectSessionItemsOntoExistingTurns(current, items)
      if (!projected) return
      await this.deps.threadStore.upsert(touchThread(projected, this.deps.nowIso()))
    })
  }
}
