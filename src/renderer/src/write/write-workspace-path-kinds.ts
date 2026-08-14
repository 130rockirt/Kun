import {
  isWriteCodeFilePath,
  isWriteTextFilePath
} from '@shared/write-text-file'
import type { WriteActiveFileKind } from './write-workspace-store-types'
import type { WriteWorkspaceState } from './write-workspace-store-types'
import { projectFocusedDocument, writeDocumentKey } from './write-editor-layout'

function extensionFromWritePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  const dot = normalized.lastIndexOf('.')
  return dot > slash ? normalized.slice(dot) : ''
}

export function ensureMarkdownRenameExtension(path: string, newName: string): string {
  if (extensionFromWritePath(newName)) return newName
  const currentExtension = extensionFromWritePath(path)
  return /^(?:\.md|\.markdown|\.mdx)$/i.test(currentExtension)
    ? `${newName}${currentExtension.toLowerCase()}`
    : newName
}

export function renamedWritingDocumentKind(
  currentKind: WriteActiveFileKind,
  nextPath: string
): WriteActiveFileKind {
  if (currentKind !== 'text' && currentKind !== 'code') return currentKind
  if (isWriteCodeFilePath(nextPath)) return 'code'
  if (isWriteTextFilePath(nextPath)) return 'text'
  return currentKind
}

export function withoutLoadingDirs(
  loadingDirs: Record<string, boolean>,
  keys: Array<string | undefined>
): Record<string, boolean> {
  const next = { ...loadingDirs }
  for (const key of keys) {
    if (key) delete next[key]
  }
  return next
}

export function projectRenamedDocumentKind(
  state: WriteWorkspaceState,
  path: string,
  expectedKind: WriteActiveFileKind,
  nextKind: WriteActiveFileKind
): Partial<WriteWorkspaceState> {
  const key = writeDocumentKey(path)
  const document = state.documentsByPath[key]
  if (!document || document.kind !== expectedKind) return {}
  const documentsByPath = {
    ...state.documentsByPath,
    [key]: { ...document, kind: nextKind }
  }
  return {
    documentsByPath,
    ...projectFocusedDocument(state.editorLayout, documentsByPath)
  }
}
