import { useCallback, useEffect, useRef } from 'react'
import { MAX_COMPOSER_CONTEXT_ATTACHMENTS } from '@kun/extension-api'
import { useChatStore } from '../../store/chat-store'
import { workspaceRootScopeKey } from '../../lib/workspace-path'
import { resolveActiveExtensionWorkspaceRoot } from '../../extensions/active-extension-workspace'
import { createDevPreviewComposerContextAttachment } from '../../lib/dev-preview-composer-context'
import type { DevPreviewContextDraft } from '../DevBrowserPanel'
import type { useWorkbenchChatStoreState } from './useWorkbenchChatStoreState'

type WorkbenchState = ReturnType<typeof useWorkbenchChatStoreState>

type Params = {
  activeThreadId: string | null
  route: WorkbenchState['route']
  extensionWorkspaceRoot: string
  extensionComposerContexts: WorkbenchState['extensionComposerContexts']
  activeComposerContextEvents: WorkbenchState['extensionComposerContexts']
  selectedModelSupportsImageInput: boolean
  attachmentUploadEnabled: boolean
  addComposerImageBase64: (input: { dataBase64: string; mimeType: string; name: string }) => Promise<string | null>
  removeComposerAttachments: (ids: string[], scope: 'chat') => void
  removeComposerContext: WorkbenchState['removeComposerContext']
  clearComposerContexts: WorkbenchState['clearComposerContexts']
  attachComposerContext: WorkbenchState['attachComposerContext']
}

export function useWorkbenchDevPreviewContexts({
  activeThreadId,
  route,
  extensionWorkspaceRoot,
  extensionComposerContexts,
  activeComposerContextEvents,
  selectedModelSupportsImageInput,
  attachmentUploadEnabled,
  addComposerImageBase64,
  removeComposerAttachments,
  removeComposerContext,
  clearComposerContexts,
  attachComposerContext
}: Params) {
  const removeComposerContextWithLinkedImage = useCallback((attachmentId: string): void => {
    const linkedId = extensionComposerContexts.find(
      (event) => event.attachment.attachmentId === attachmentId
    )?.linkedAttachmentId
    removeComposerContext(attachmentId)
    if (linkedId) removeComposerAttachments([linkedId], 'chat')
  }, [extensionComposerContexts, removeComposerAttachments, removeComposerContext])

  const clearDevPreviewContexts = useCallback((): void => {
    const linkedIds = extensionComposerContexts.flatMap((event) =>
      'source' in event.attachment.provenance &&
      event.attachment.provenance.source === 'dev-preview' &&
      event.linkedAttachmentId
        ? [event.linkedAttachmentId]
        : []
    )
    if (linkedIds.length > 0) removeComposerAttachments(linkedIds, 'chat')
    clearComposerContexts({ source: 'dev-preview' })
  }, [clearComposerContexts, extensionComposerContexts, removeComposerAttachments])

  const attachDevPreviewContext = useCallback(async (
    draft: DevPreviewContextDraft
  ): Promise<void> => {
    const threadId = activeThreadId
    const contextWorkspaceRoot = extensionWorkspaceRoot
    if (!threadId || route !== 'chat') return
    let linkedAttachmentId: string | null = null
    if (draft.screenshot && selectedModelSupportsImageInput && attachmentUploadEnabled) {
      linkedAttachmentId = await addComposerImageBase64({
        dataBase64: draft.screenshot.dataBase64,
        mimeType: draft.screenshot.mimeType,
        name: `preview-${draft.kind}.png`
      })
    }
    if (
      useChatStore.getState().activeThreadId !== threadId ||
      workspaceRootScopeKey(resolveActiveExtensionWorkspaceRoot(
        useChatStore.getState().activeThreadId,
        useChatStore.getState().threads,
        useChatStore.getState().workspaceRoot
      )) !== workspaceRootScopeKey(contextWorkspaceRoot)
    ) {
      if (linkedAttachmentId) removeComposerAttachments([linkedAttachmentId], 'chat')
      return
    }
    const attachment = await createDevPreviewComposerContextAttachment({
      workspaceRoot: contextWorkspaceRoot,
      threadId,
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      reference: draft.reference
    })
    if (activeComposerContextEvents.length >= MAX_COMPOSER_CONTEXT_ATTACHMENTS) {
      const oldest = activeComposerContextEvents[0]
      if (oldest) removeComposerContextWithLinkedImage(oldest.attachment.attachmentId)
    }
    attachComposerContext({
      workspaceRoot: contextWorkspaceRoot,
      threadId,
      attachment,
      ...(linkedAttachmentId ? { linkedAttachmentId } : {})
    })
  }, [
    activeThreadId,
    activeComposerContextEvents,
    addComposerImageBase64,
    attachComposerContext,
    attachmentUploadEnabled,
    extensionWorkspaceRoot,
    removeComposerAttachments,
    removeComposerContextWithLinkedImage,
    route,
    selectedModelSupportsImageInput
  ])

  const previewScopeRef = useRef(`${workspaceRootScopeKey(extensionWorkspaceRoot)}:${activeThreadId ?? ''}`)
  useEffect(() => {
    const nextScope = `${workspaceRootScopeKey(extensionWorkspaceRoot)}:${activeThreadId ?? ''}`
    if (previewScopeRef.current === nextScope) return
    previewScopeRef.current = nextScope
    clearDevPreviewContexts()
  }, [activeThreadId, clearDevPreviewContexts, extensionWorkspaceRoot])

  return { attachDevPreviewContext, clearDevPreviewContexts, removeComposerContextWithLinkedImage }
}
