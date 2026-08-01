import { flushDocumentsIndex, persistDocumentsIndex } from './design-document-persistence'
import type { DesignWorkspaceState } from './design-workspace-store-types'

type DesignIndexState = Pick<
  DesignWorkspaceState,
  'workspaceRoot' | 'documents' | 'activeDocumentId' | 'workspaceFolders'
>

export function persistDesignWorkspaceIndex(state: DesignIndexState, immediate = false): void {
  if (immediate) {
    void flushDocumentsIndex(state.workspaceRoot, state.documents, state.activeDocumentId, state.workspaceFolders)
    return
  }
  persistDocumentsIndex(state.workspaceRoot, state.documents, state.activeDocumentId, state.workspaceFolders)
}
