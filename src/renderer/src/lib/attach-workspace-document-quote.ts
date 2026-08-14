import { useChatStore } from '../store/chat-store'
import { workspaceRootScopeKey } from './workspace-path'
import {
  createWorkspaceDocumentQuoteAttachment,
  type WorkspaceDocumentQuoteDraft
} from './workspace-document-quote'

function activeComposerWorkspaceRoot(): string {
  const state = useChatStore.getState()
  const threadWorkspace = state.activeThreadId
    ? state.threads.find((thread) => thread.id === state.activeThreadId)?.workspace
    : undefined
  return threadWorkspace?.trim() || state.workspaceRoot.trim()
}

export async function attachWorkspaceDocumentQuote(input: {
  workspaceRoot: string
  draft: WorkspaceDocumentQuoteDraft
}): Promise<boolean> {
  const initialState = useChatStore.getState()
  const workspaceRoot = input.workspaceRoot.trim()
  if (
    initialState.route !== 'chat' ||
    workspaceRootScopeKey(workspaceRoot) !== workspaceRootScopeKey(activeComposerWorkspaceRoot())
  ) return false

  const threadId = initialState.activeThreadId ?? undefined
  const attachment = await createWorkspaceDocumentQuoteAttachment({
    workspaceRoot,
    draft: input.draft
  })
  const currentState = useChatStore.getState()
  if (
    currentState.route !== 'chat' ||
    currentState.activeThreadId !== (threadId ?? null) ||
    workspaceRootScopeKey(workspaceRoot) !== workspaceRootScopeKey(activeComposerWorkspaceRoot())
  ) return false

  currentState.attachComposerContext({ workspaceRoot, threadId, attachment })
  const attached = useChatStore.getState().extensionComposerContexts.some(
    (event) => event.attachment.attachmentId === attachment.attachmentId
  )
  if (attached) {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.ds-floating-composer .ds-composer-textarea')?.focus()
    })
  }
  return attached
}
