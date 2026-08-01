import {
  currentDesignArtifactVersion,
  designArtifactVersionLabel,
  designArtifactVersionNumber,
  isFileDesignArtifactKind,
  type DesignArtifact,
  type DesignDocument,
  type DesignWorkspaceFolder
} from '../../design/design-types'
import type { DesignDocumentsIndex } from '../../design/design-document-persistence'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'
import { designChildFolders } from '../../design/design-workspace-folders'
import { displayDrawingTitle } from '../../design/design-drawing-title'

export type WorkspaceIndexSnapshot = {
  documents: DesignDocument[]
  folders: DesignWorkspaceFolder[]
  activeDocumentId: string | null
}

export type DraggedDocument = {
  workspaceRoot: string
  documentId: string
}

export function sameDesignWorkspace(left: string, right: string): boolean {
  return normalizeDesignWorkspaceRoot(left) === normalizeDesignWorkspaceRoot(right)
}

export function uniqueDesignWorkspaceRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  return roots.flatMap((root) => {
    const normalized = normalizeDesignWorkspaceRoot(root)
    if (!normalized || seen.has(normalized)) return []
    seen.add(normalized)
    return [normalized]
  })
}

export function sortDesignSidebarDocuments(
  documents: readonly DesignDocument[],
  isRunning: (document: DesignDocument) => boolean
): DesignDocument[] {
  return documents.slice().sort((left, right) => {
    const runningDifference = Number(isRunning(right)) - Number(isRunning(left))
    if (runningDifference !== 0) return runningDifference
    return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt)
  })
}

export function workspaceIndexSnapshot(index: DesignDocumentsIndex): WorkspaceIndexSnapshot {
  return {
    activeDocumentId: index.activeDocumentId,
    folders: index.folders,
    documents: index.documents.map((document) => ({ ...document, artifacts: [] }))
  }
}

export function designFolderOptions(
  folders: readonly DesignWorkspaceFolder[],
  parentId: string | null = null,
  prefix = ''
): Array<{ id: string; label: string }> {
  return designChildFolders(folders, parentId).flatMap((folder) => [
    { id: folder.id, label: `${prefix}${folder.name}` },
    ...designFolderOptions(folders, folder.id, `${prefix}— `)
  ])
}

export function getDesignSidebarVisibleArtifacts(artifacts: readonly DesignArtifact[]): DesignArtifact[] {
  return artifacts.filter((artifact) => artifact.node?.boardHidden !== true)
}

export function getDesignSidebarDocumentScreenCount(doc: Pick<DesignDocument, 'artifacts'>): number {
  return getDesignSidebarVisibleArtifacts(doc.artifacts).filter((artifact) => artifact.kind === 'html').length
}

/** Visible first-class HTML/SVG artifacts; excludes the implementation board. */
export function getDesignSidebarDocumentArtifactCount(doc: Pick<DesignDocument, 'artifacts'>): number {
  return getDesignSidebarVisibleArtifacts(doc.artifacts).filter((artifact) => isFileDesignArtifactKind(artifact.kind)).length
}

export function getDesignSidebarDocumentLabel(
  doc: Pick<DesignDocument, 'id' | 'title' | 'titleOrigin'>,
  untitledLabel = 'Untitled drawing'
): string {
  return displayDrawingTitle(doc, untitledLabel)
}

export function getDesignSidebarArtifactVersionBadge(artifact: DesignArtifact): string | null {
  const current = currentDesignArtifactVersion(artifact)
  const versionNumber = current ? designArtifactVersionNumber(current) : null
  if ((versionNumber ?? artifact.versions.length) <= 1 && artifact.versions.length <= 1) return null
  return designArtifactVersionLabel(current, Math.max(1, artifact.versions.length))
}
