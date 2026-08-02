import { useCallback, useEffect, useMemo } from 'react'
import type { NormalizedThread } from '../../agent/types'
import { getProvider } from '../../agent/registry'
import { refreshDesignChatTranscriptFromProvider } from '../../design/design-chat-transcript'
import {
  designThreadSelectionSyncForDocument,
  designThreadsForDocument,
  recoverOrphanDesignThreadForDocument,
  registeredDesignThreadIdsForDocument,
  switchDesignThreadForDocument
} from '../../design/design-thread-workbench'
import { readDesignThreadRegistry } from '../../design/design-thread-registry'
import { drawingHistoryMutationMatches } from '../../design/design-drawing-history'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'
import { useChatStore } from '../../store/chat-store'

export type DesignThreadBindingOptions = {
  threads: NormalizedThread[]
  workspaceRoot: string
  designWorkspaceRoot: string
  activeDocumentId: string | null
  activeThreadId: string | null
  route: string
  selectThread: (threadId: string) => Promise<void>
  clearActiveThreadSelection?: () => void
}

export type DesignThreadBindingState = {
  designThreads: NormalizedThread[]
  designHistoryThreadIds: string[]
  hasRegisteredHistory: boolean
  switchDesignThread: (threadId: string) => Promise<void>
}

export function useDesignThreadBinding({
  threads,
  workspaceRoot,
  designWorkspaceRoot,
  activeDocumentId,
  activeThreadId,
  route,
  selectThread,
  clearActiveThreadSelection
}: DesignThreadBindingOptions): DesignThreadBindingState {
  const effectiveWorkspaceRoot = designWorkspaceRoot || workspaceRoot
  const drawingCreationSubmitting = useDesignWorkspaceStore(
    (state) => state.drawingCreationSubmitting
  )
  const drawingCreationDocumentId = useDesignWorkspaceStore(
    (state) => state.drawingCreationDocumentId
  )
  const documents = useDesignWorkspaceStore((state) => state.documents)
  const designThreads = useMemo(() => {
    return designThreadsForDocument({
      threads,
      workspaceRoot: effectiveWorkspaceRoot,
      docId: activeDocumentId
    })
  }, [activeDocumentId, effectiveWorkspaceRoot, threads])
  const designHistoryThreadIds = registeredDesignThreadIdsForDocument({
    workspaceRoot: effectiveWorkspaceRoot,
    docId: activeDocumentId,
    registry: readDesignThreadRegistry()
  })
  const hasRegisteredHistory = designHistoryThreadIds.length > 0

  const switchDesignThread = useCallback(async (threadId: string): Promise<void> => {
    const designStore = useDesignWorkspaceStore.getState()
    const expectedWorkspaceRoot = designStore.workspaceRoot || workspaceRoot
    const expectedDocumentId = designStore.activeDocumentId
    const canSwitch = (): boolean => {
      const latest = useDesignWorkspaceStore.getState()
      return (
        normalizeDesignWorkspaceRoot(latest.workspaceRoot || workspaceRoot) ===
          normalizeDesignWorkspaceRoot(expectedWorkspaceRoot) &&
        latest.activeDocumentId === expectedDocumentId &&
        !drawingHistoryMutationMatches(
          latest.drawingHistoryMutation,
          expectedWorkspaceRoot,
          expectedDocumentId
        )
      )
    }
    if (!canSwitch()) return
    await switchDesignThreadForDocument({
      workspaceRoot: expectedWorkspaceRoot,
      docId: expectedDocumentId,
      threadId,
      selectThread,
      canSwitch
    })
  }, [selectThread, workspaceRoot])

  useEffect(() => {
    if (
      drawingCreationSubmitting &&
      activeDocumentId === drawingCreationDocumentId
    ) return
    const sync = designThreadSelectionSyncForDocument({
      route,
      activeThreadId,
      threads,
      workspaceRoot: effectiveWorkspaceRoot,
      docId: activeDocumentId
    })
    if (sync.action === 'select') {
      void selectThread(sync.threadId)
      return
    }
    if (sync.action === 'clear') {
      clearActiveThreadSelection?.()
    }
  }, [
    activeDocumentId,
    activeThreadId,
    clearActiveThreadSelection,
    drawingCreationDocumentId,
    drawingCreationSubmitting,
    effectiveWorkspaceRoot,
    route,
    selectThread,
    threads
  ])

  useEffect(() => {
    if (route !== 'design' || !activeDocumentId || !effectiveWorkspaceRoot) return
    void refreshDesignChatTranscriptFromProvider({
      workspaceRoot: effectiveWorkspaceRoot,
      docId: activeDocumentId
    })
  }, [activeDocumentId, effectiveWorkspaceRoot, route])

  useEffect(() => {
    if (route !== 'design' || !activeDocumentId || !effectiveWorkspaceRoot) return
    let cancelled = false
    const expectedWorkspaceRoot = normalizeDesignWorkspaceRoot(effectiveWorkspaceRoot)
    const expectedDocumentId = activeDocumentId
    const isCurrent = (): boolean => {
      if (cancelled || useChatStore.getState().route !== 'design') return false
      const designState = useDesignWorkspaceStore.getState()
      return normalizeDesignWorkspaceRoot(designState.workspaceRoot || workspaceRoot) ===
        expectedWorkspaceRoot && designState.activeDocumentId === expectedDocumentId
    }
    void recoverOrphanDesignThreadForDocument({
      route,
      workspaceRoot: expectedWorkspaceRoot,
      docId: expectedDocumentId,
      documents,
      threads,
      getThreadDetail: async (threadId) => getProvider().getThreadDetail(threadId),
      selectThread,
      isCurrent
    })
    return () => {
      cancelled = true
    }
  }, [
    activeDocumentId,
    documents,
    effectiveWorkspaceRoot,
    route,
    selectThread,
    threads,
    workspaceRoot
  ])

  return { designThreads, designHistoryThreadIds, hasRegisteredHistory, switchDesignThread }
}
