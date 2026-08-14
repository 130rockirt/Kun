import type { ThreadRecord } from '../../contracts/threads.js'
import { legacyWorkThreadTitleMatches } from '../../domain/thread.js'

/**
 * Metadata JSONL intentionally omits turn-item bodies. Only this narrow
 * legacy Work shape needs those bodies to resolve its persisted surface.
 */
export function requiresLegacyWorkThreadHydration(thread: ThreadRecord): boolean {
  return thread.agentSurface === undefined &&
    thread.designProfile === undefined &&
    thread.turns.length > 0 &&
    thread.turns.every((turn) => turn.agentSurface === undefined) &&
    legacyWorkThreadTitleMatches(thread.title)
}
