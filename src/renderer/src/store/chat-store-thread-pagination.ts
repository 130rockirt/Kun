import type { NormalizedThread } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { getProvider } from '../agent/registry'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'

/**
 * Paginated sidebar thread loading. `refreshThreads` (in the workspace actions
 * file) owns the first-page load; this module owns the "show more" pages that
 * append older threads per workspace using the runtime's keyset cursor.
 */

function mergeThreadPages(
  existing: NormalizedThread[],
  incoming: NormalizedThread[]
): NormalizedThread[] {
  const byId = new Map(existing.map((thread) => [thread.id, thread]))
  for (const thread of incoming) {
    // Incoming pages are ordered newest-first; keep the first occurrence so a
    // later refresh does not downgrade a locally-confirmed running state.
    if (!byId.has(thread.id)) byId.set(thread.id, thread)
  }
  return [...byId.values()].sort((a, b) => {
    const timeDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    if (timeDelta !== 0) return timeDelta
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

export async function loadMoreThreads(
  workspacePath: string,
  set: ChatStoreSet,
  get: ChatStoreGet
): Promise<void> {
  if (get().runtimeConnection !== 'ready') return
  const scope = get().threadListCursorByWorkspace[workspacePath]
  if (!scope || !scope.nextCursor || scope.hasMore !== true) return

  try {
    const p = getProvider()
    if (typeof p.listThreadsPage !== 'function') {
      // Older runtime without cursor support: nothing more to load.
      set((s) => ({
        threadListCursorByWorkspace: {
          ...s.threadListCursorByWorkspace,
          [workspacePath]: { hasMore: false }
        }
      }))
      return
    }
    const page = await p.listThreadsPage({
      cursor: scope.nextCursor,
      workspace: normalizeWorkspaceRoot(workspacePath),
      includeArchived: get().showArchivedThreads,
      includeSide: true,
      lean: true
    })
    const filtered = page.threads.filter((thread) => thread.relation !== 'side')
    set((s) => ({
      threads: mergeThreadPages(s.threads, filtered),
      threadListCursorByWorkspace: {
        ...s.threadListCursorByWorkspace,
        [workspacePath]: {
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          ...(page.total != null ? { total: page.total } : {})
        }
      }
    }))
  } catch {
    // Keep the existing cursor so the user can retry "show more" later.
  }
}

export type ThreadListPageMeta = { nextCursor?: string; hasMore: boolean; total?: number }

/**
 * Build the per-workspace cursor map after a full calibration refresh. Every
 * workspace present in the committed list is fully loaded, so `hasMore` stays
 * false unless the runtime reports a pending cursor; `total` feeds the
 * "show more" count badge.
 */
export function buildWorkspaceCursorByWorkspace(
  threads: NormalizedThread[],
  meta: ThreadListPageMeta | null
): Record<string, { nextCursor?: string; hasMore: boolean; total?: number }> {
  if (!meta) return {}
  const cursorByWorkspace: Record<string, { nextCursor?: string; hasMore: boolean; total?: number }> = {}
  for (const thread of threads) {
    const workspace = normalizeWorkspaceRoot(thread.workspace ?? '')
    if (!workspace || cursorByWorkspace[workspace]) continue
    cursorByWorkspace[workspace] = {
      nextCursor: meta.nextCursor,
      hasMore: meta.hasMore,
      total: meta.total
    }
  }
  return cursorByWorkspace
}
