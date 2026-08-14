import {
  startWorkspaceOfficePreviewController,
  type WorkspaceOfficePreviewControllerApi,
  type WorkspaceOfficePreviewControllerCallbacks
} from '../lib/workspace-office-preview-controller'

export function startWriteOfficeSessionWatch(options: {
  api: WorkspaceOfficePreviewControllerApi
  path: string
  workspaceRoot: string
  callbacks: WorkspaceOfficePreviewControllerCallbacks
}): () => void {
  return startWorkspaceOfficePreviewController({ ...options, loadImmediately: false })
}
