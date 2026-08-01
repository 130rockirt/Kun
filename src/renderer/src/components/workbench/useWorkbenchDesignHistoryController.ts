import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { threadSnapshotLooksRunning } from '../../store/chat-store-runtime-helpers'
import { useChatStore } from '../../store/chat-store'
import { confirmDialog } from '../../lib/confirm-dialog'
import { displayDrawingTitle } from '../../design/design-drawing-title'
import { removePersistedDesignDocument } from '../../design/design-document-persistence'
import { designDocKey, readDesignThreadRegistry } from '../../design/design-thread-registry'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import {
  markDesignArtifactRemoved,
  markDesignDocumentRemoved
} from '../../design/design-workspace-registry'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'

function registeredDrawingIsRunning(workspaceRoot: string, documentId: string): boolean {
  const state = useChatStore.getState()
  const record = readDesignThreadRegistry().workspaces[designDocKey(workspaceRoot, documentId)]
  if (!record) return false
  return record.threadIds.some((threadId) => {
    const thread = state.threads.find((candidate) => candidate.id === threadId)
    return Boolean(
      thread && (
        threadSnapshotLooksRunning([], thread.status) ||
        threadSnapshotLooksRunning([], thread.latestTurnStatus)
      )
    )
  })
}

export function useWorkbenchDesignHistoryController(): {
  clearActiveDrawingHistory: () => Promise<void>
  deleteDrawing: (documentId: string) => Promise<void>
} {
  const { t } = useTranslation('common')

  const clearActiveDrawingHistory = useCallback(async (): Promise<void> => {
    const design = useDesignWorkspaceStore.getState()
    const chat = useChatStore.getState()
    const documentId = design.activeDocumentId
    const workspaceRoot = design.workspaceRoot
    if (
      !documentId ||
      !workspaceRoot ||
      design.pagesRun ||
      chat.busy ||
      chat.runtimeConnection !== 'ready' ||
      registeredDrawingIsRunning(workspaceRoot, documentId)
    ) return

    const record = readDesignThreadRegistry().workspaces[designDocKey(workspaceRoot, documentId)]
    if (!record || record.threadIds.length === 0) return
    if (!design.beginDrawingHistoryMutation(workspaceRoot, documentId, 'clear')) return
    try {
      const confirmed = await confirmDialog(
        t('designClearHistoryConfirm'),
        t('designClearHistoryConfirmDetail')
      )
      if (!confirmed) return

      const latestDesign = useDesignWorkspaceStore.getState()
      const latestChat = useChatStore.getState()
      if (
        normalizeDesignWorkspaceRoot(latestDesign.workspaceRoot) !==
          normalizeDesignWorkspaceRoot(workspaceRoot) ||
        latestDesign.activeDocumentId !== documentId ||
        latestDesign.pagesRun ||
        latestChat.busy ||
        latestChat.runtimeConnection !== 'ready' ||
        registeredDrawingIsRunning(workspaceRoot, documentId)
      ) return

      let result
      try {
        result = await latestChat.clearDesignHistory(workspaceRoot, documentId)
      } catch {
        latestChat.setError(t('designClearHistoryFailed'))
        return
      }
      if (!result.cleared) {
        useChatStore.getState().setError(
          result.deletedThreadIds.length > 0
            ? t('designClearHistoryPartialFailed')
            : t('designClearHistoryFailed')
        )
      }
    } finally {
      useDesignWorkspaceStore.getState().endDrawingHistoryMutation(workspaceRoot, documentId)
    }
  }, [t])

  const deleteDrawing = useCallback(async (documentId: string): Promise<void> => {
    const design = useDesignWorkspaceStore.getState()
    const chat = useChatStore.getState()
    const drawing = design.documents.find((document) => document.id === documentId)
    const workspaceRoot = design.workspaceRoot
    if (!drawing || !workspaceRoot) return
    if (
      design.pagesRun ||
      chat.busy ||
      registeredDrawingIsRunning(workspaceRoot, documentId)
    ) {
      chat.setError(t('designAgentBusy'))
      return
    }
    if (!design.beginDrawingHistoryMutation(workspaceRoot, documentId, 'delete')) return
    const snapshotDocuments = design.documents.slice()
    const snapshotActiveDocumentId = design.activeDocumentId
    try {
      const title = displayDrawingTitle(drawing, t('designUntitledDrawing'))
      const confirmed = await confirmDialog(
        t('designDeleteDrawingConfirm', { title }),
        t('designDeleteDrawingConfirmDetail')
      )
      if (!confirmed) return

      const latestDesign = useDesignWorkspaceStore.getState()
      const latestChat = useChatStore.getState()
      if (
        normalizeDesignWorkspaceRoot(latestDesign.workspaceRoot) !==
          normalizeDesignWorkspaceRoot(workspaceRoot) ||
        !latestDesign.documents.some((document) => document.id === documentId) ||
        latestDesign.pagesRun ||
        latestChat.busy ||
        registeredDrawingIsRunning(workspaceRoot, documentId)
      ) return

      let result
      try {
        result = await latestChat.clearDesignHistory(
          workspaceRoot,
          documentId,
          { recreate: false }
        )
      } catch {
        latestChat.setError(t('designDeleteDrawingFailed'))
        return
      }
      if (!result.cleared) {
        useChatStore.getState().setError(t('designDeleteDrawingFailed'))
        return
      }

      const currentDesign = useDesignWorkspaceStore.getState()
      if (
        normalizeDesignWorkspaceRoot(currentDesign.workspaceRoot) ===
          normalizeDesignWorkspaceRoot(workspaceRoot) &&
        currentDesign.documents.some((document) => document.id === documentId)
      ) {
        const removed = await currentDesign.removeDocument(documentId)
        if (!removed) useChatStore.getState().setError(t('designDeleteDrawingFailed'))
        return
      }

      const removed = await removePersistedDesignDocument({
        workspaceRoot,
        documentId,
        fallbackDocuments: snapshotDocuments,
        fallbackActiveDocumentId: snapshotActiveDocumentId
      })
      if (!removed) {
        useChatStore.getState().setError(t('designDeleteDrawingFailed'))
        return
      }
      markDesignDocumentRemoved(workspaceRoot, documentId)
      for (const artifact of drawing.artifacts) {
        markDesignArtifactRemoved(workspaceRoot, artifact.id)
      }
    } finally {
      useDesignWorkspaceStore.getState().endDrawingHistoryMutation(workspaceRoot, documentId)
    }
  }, [t])

  return { clearActiveDrawingHistory, deleteDrawing }
}
