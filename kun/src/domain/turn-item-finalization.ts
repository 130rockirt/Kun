import type { TurnItem } from '../contracts/items.js'
import type { TurnStatus } from '../contracts/turns.js'

export type FinishedTurnStatus = Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>

/**
 * Makes every still-open session item terminal when its owning turn is
 * terminal. Keeping this outside a route handler lets both ordinary recovery
 * and manager lease recovery apply the same durable state transition.
 */
export function finalizeTurnItems(
  items: TurnItem[],
  input: { turnId: string; status: FinishedTurnStatus; finishedAt: string }
): TurnItem[] {
  let changed = false
  const finalized = items.map((item) => {
    if (item.turnId !== input.turnId) return item
    const next = finalizeOpenTurnItem(item, input.status, input.finishedAt)
    changed ||= next !== item
    return next
  })
  return changed ? finalized : items
}

export function finalizeOpenTurnItem(
  item: TurnItem,
  status: FinishedTurnStatus,
  finishedAt: string
): TurnItem {
  if (item.status !== 'pending' && item.status !== 'running') return item
  if (item.kind === 'approval') return { ...item, status: 'expired', finishedAt }
  if (item.kind === 'user_input') return { ...item, status: 'cancelled', finishedAt }
  return {
    ...item,
    status: status === 'completed' ? 'completed' : status,
    finishedAt
  } as TurnItem
}
