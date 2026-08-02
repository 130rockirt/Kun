import type { TFunction } from 'i18next'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Layers,
  Plus
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { DesignArtifact, DesignDocument } from '../../design/design-types'
import { artifactDirOf } from '../../design/design-artifact-persistence'
import { designDocumentComposerFileReference } from '../../design/design-document-file-reference'
import { displayDrawingTitle } from '../../design/design-drawing-title'
import type { ChatFileTreeReference } from './ChatFileTreePanel'
import {
  SidebarIconButton,
  SidebarSectionHeader,
  SidebarTreeRow
} from '../sidebar/SidebarPrimitives'

type Props = {
  workspaceRoot: string
  documents: readonly DesignDocument[]
  activeDocumentId?: string | null
  onAddReference: (reference: ChatFileTreeReference) => void
  t: TFunction
  fill?: boolean
}

function trimTrailingSlash(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/g, '')
}

function workspaceAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const root = trimTrailingSlash(workspaceRoot)
  return root ? `${root}/${relativePath}` : relativePath
}

export function designArtifactDirectoryReference(
  artifact: DesignArtifact,
  workspaceRoot: string
): ChatFileTreeReference {
  const relativePath = artifactDirOf(artifact.relativePath)
  return {
    path: workspaceAbsolutePath(workspaceRoot, relativePath),
    relativePath,
    name: artifact.title.trim() || artifact.id,
    type: 'directory',
    workspaceRoot: trimTrailingSlash(workspaceRoot)
  }
}

export function designDocumentScreenCount(doc: Pick<DesignDocument, 'artifacts'>): number {
  return doc.artifacts.filter((artifact) => artifact.kind === 'html').length
}

export function ChatDesignTreePanel({
  workspaceRoot,
  documents,
  activeDocumentId,
  onAddReference,
  t,
  fill = false
}: Props): ReactElement {
  const root = trimTrailingSlash(workspaceRoot)
  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)),
    [documents]
  )
  const initialExpanded = activeDocumentId ?? sortedDocuments[0]?.id ?? ''
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialExpanded ? [initialExpanded] : []))

  useEffect(() => {
    if (!activeDocumentId) return
    setExpanded((current) => {
      if (current.has(activeDocumentId)) return current
      const next = new Set(current)
      next.add(activeDocumentId)
      return next
    })
  }, [activeDocumentId])

  const toggleDocument = (documentId: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      return next
    })
  }

  const addDocumentReference = (doc: DesignDocument): void => {
    onAddReference(designDocumentComposerFileReference(doc, root) as ChatFileTreeReference)
  }

  const addArtifactReference = (artifact: DesignArtifact): void => {
    onAddReference(designArtifactDirectoryReference(artifact, root))
  }

  const renderArtifactRow = (artifact: DesignArtifact, depth: number): ReactElement => {
    const relativePath = artifactDirOf(artifact.relativePath)
    return (
      <SidebarTreeRow
        key={artifact.id}
        title={relativePath}
        buttonClassName="items-center gap-1.5 py-1.5 pr-1.5 text-[12.5px]"
        buttonStyle={{ paddingLeft: depth * 14 + 8 }}
        actionsVisibility="hidden"
        actions={
          <SidebarIconButton
            onClick={() => addArtifactReference(artifact)}
            title={t('designFileTreeAddArtifactReference')}
            ariaLabel={t('designFileTreeAddArtifactReference')}
            stopPropagation
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
          </SidebarIconButton>
        }
      >
        {artifact.kind === 'canvas' ? (
          <Layers className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.75} />
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{artifact.title || artifact.id}</span>
          <span className="block truncate font-mono text-[10.5px] leading-4 text-ds-faint">
            {relativePath}
          </span>
        </span>
      </SidebarTreeRow>
    )
  }

  const renderDocument = (doc: DesignDocument): ReactElement[] => {
    const isExpanded = expanded.has(doc.id)
    const active = doc.id === activeDocumentId
    const screenCount = designDocumentScreenCount(doc)
    const drawingTitle = displayDrawingTitle(doc, t('designUntitledDrawing'))
    const documentRow = (
      <SidebarTreeRow
        key={doc.id}
        active={active}
        title={drawingTitle}
        onClick={() => toggleDocument(doc.id)}
        buttonClassName="items-center gap-1.5 px-2.5 py-2 text-[12.5px]"
        trailing={
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-ds-faint" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-ds-faint" strokeWidth={1.8} />
          )
        }
        actionsVisibility="visible"
        actions={
          <SidebarIconButton
            onClick={() => addDocumentReference(doc)}
            title={t('designFileTreeAddDocumentReference')}
            ariaLabel={t('designFileTreeAddDocumentReference')}
            stopPropagation
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
          </SidebarIconButton>
        }
      >
        {isExpanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.75} />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{drawingTitle}</span>
          <span className="block truncate text-[10.5px] leading-4 text-ds-faint">
            {t('designFileTreeScreenCount', { count: screenCount })}
          </span>
        </span>
      </SidebarTreeRow>
    )
    if (!isExpanded) return [documentRow]
    const artifactRows = doc.artifacts.length > 0
      ? doc.artifacts.map((artifact) => renderArtifactRow(artifact, 1))
      : [
          <div key={`${doc.id}-empty`} className="px-2.5 py-1.5 text-[12px] text-ds-faint">
            {t('designFileTreeEmptyDocument')}
          </div>
        ]
    return [documentRow, ...artifactRows]
  }

  return (
    <div className={`ds-no-drag min-h-0 ${fill ? 'flex h-full flex-col' : ''}`}>
      <SidebarSectionHeader label={t('designFileTreeTitle')} title={root} />
      <div className={`${fill ? 'min-h-0 flex-1' : 'max-h-[34vh] min-h-[96px]'} overflow-y-auto overflow-x-hidden px-1`}>
        {sortedDocuments.length > 0 ? (
          sortedDocuments.flatMap((doc) => renderDocument(doc))
        ) : (
          <div className="px-2.5 py-2 text-[12px] text-ds-muted">
            {t('designFileTreeEmpty')}
          </div>
        )}
      </div>
    </div>
  )
}
