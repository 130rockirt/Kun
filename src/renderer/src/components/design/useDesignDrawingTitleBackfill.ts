import { useEffect, useState } from 'react'
import type { NormalizedThread, RuntimeConnectionStatus } from '../../agent/types'
import { getProvider } from '../../agent/registry'
import type { DesignDocument } from '../../design/design-types'
import {
  deriveDrawingTitleFromBlocks,
  deriveDrawingTitleFromPrompt,
  drawingTitleNeedsBackfill
} from '../../design/design-drawing-title'
import {
  hydrateDesignChatMetaForDoc,
  readFirstDesignPromptFromMirrors
} from '../../design/design-chat-transcript'
import { designDocKey, readDesignThreadRegistry } from '../../design/design-thread-registry'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'

type Options = {
  workspaceRoot: string
  documents: readonly DesignDocument[]
  threads: readonly NormalizedThread[]
  runtimeConnection: RuntimeConnectionStatus
}

export function useDesignDrawingTitleBackfill({
  workspaceRoot,
  documents,
  threads,
  runtimeConnection
}: Options): void {
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    if (!workspaceRoot) return
    const candidates = documents.filter(drawingTitleNeedsBackfill)
    if (candidates.length === 0) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryNeeded = false

    const orderedThreadIds = (threadIds: readonly string[]): string[] => {
      return threadIds
        .map((id, index) => ({
          id,
          index,
          updatedAt: Date.parse(threads.find((thread) => thread.id === id)?.updatedAt ?? '')
        }))
        .sort((left, right) => {
          const leftHasTime = Number.isFinite(left.updatedAt)
          const rightHasTime = Number.isFinite(right.updatedAt)
          if (leftHasTime && rightHasTime && left.updatedAt !== right.updatedAt) {
            return left.updatedAt - right.updatedAt
          }
          if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1
          // New Design threads are prepended to the legacy registry, so the
          // tail is the best available creation-order fallback.
          return right.index - left.index
        })
        .map(({ id }) => id)
    }

    const tasks = candidates.map(async (document) => {
      let record = readDesignThreadRegistry().workspaces[
        designDocKey(workspaceRoot, document.id)
      ]
      if (!record?.threadIds.length) {
        await hydrateDesignChatMetaForDoc({ workspaceRoot, docId: document.id })
        if (cancelled) return
        record = readDesignThreadRegistry().workspaces[
          designDocKey(workspaceRoot, document.id)
        ]
      }
      const threadIds = orderedThreadIds(record?.threadIds ?? [])
      if (threadIds.length === 0) {
        retryNeeded = true
        return
      }

      try {
        let title = ''
        if (runtimeConnection === 'ready') {
          for (const threadId of threadIds) {
            try {
              const detail = await getProvider().getThreadDetail(threadId)
              title = deriveDrawingTitleFromBlocks(detail.blocks)
              if (title) break
            } catch {
              // Fall back to the self-contained transcript mirror below.
            }
          }
        }
        if (!title) {
          const prompt = await readFirstDesignPromptFromMirrors({
            workspaceRoot,
            docId: document.id,
            threadIds
          })
          title = deriveDrawingTitleFromPrompt(prompt)
        }
        if (!title || cancelled) {
          if (!cancelled) retryNeeded = true
          return
        }
        const state = useDesignWorkspaceStore.getState()
        if (state.workspaceRoot !== workspaceRoot) return
        const current = state.documents.find((item) => item.id === document.id)
        if (!current || !drawingTitleNeedsBackfill(current)) return
        state.renameDocument(document.id, title, { titleOrigin: 'generated' })
      } catch {
        if (!cancelled) retryNeeded = true
      }
    })

    void Promise.allSettled(tasks).then(() => {
      if (cancelled || !retryNeeded || retryTimer) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        setRetryNonce((value) => value + 1)
      }, 5_000)
    })

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [documents, retryNonce, runtimeConnection, threads, workspaceRoot])
}
