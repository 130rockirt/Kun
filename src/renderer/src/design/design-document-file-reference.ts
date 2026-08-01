import type { ComposerFileReference } from '../lib/composer-file-references'
import i18n from '../i18n'
import { documentDirPath } from './design-document-persistence'
import { displayDrawingTitle } from './design-drawing-title'
import type { DesignDocument } from './design-types'

function trimTrailingSlash(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/g, '')
}

function workspaceAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const root = trimTrailingSlash(workspaceRoot)
  return root ? `${root}/${relativePath}` : relativePath
}

export function designDocumentComposerFileReference(
  document: Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>,
  workspaceRoot: string
): ComposerFileReference {
  const root = trimTrailingSlash(workspaceRoot)
  const relativePath = documentDirPath(document.id)
  return {
    path: workspaceAbsolutePath(root, relativePath),
    relativePath,
    name: displayDrawingTitle(document, i18n.t('common:designUntitledDrawing')),
    type: 'directory',
    ...(root ? { workspaceRoot: root } : {})
  }
}

export function designDocumentComposerFileReferences(
  documents: readonly Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>[],
  workspaceRoot: string
): ComposerFileReference[] {
  return documents
    .filter((document) => document.id.trim())
    .map((document) => designDocumentComposerFileReference(document, workspaceRoot))
}
