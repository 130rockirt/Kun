import type { Dispatch, DragEvent, ReactElement, SetStateAction } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  MoveRight,
  Pencil,
  Trash2
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import type { DrawingHistoryMutation } from '../../design/design-drawing-history'
import { drawingHistoryMutationMatches } from '../../design/design-drawing-history'
import {
  designChildFolders,
  designFolderDescendantIds
} from '../../design/design-workspace-folders'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'
import type { DesignDocument, DesignWorkspaceFolder } from '../../design/design-types'
import { SidebarIconButton, SidebarTreeRow } from '../sidebar/SidebarPrimitives'
import {
  designFolderOptions,
  DraggedDocument,
  getDesignSidebarDocumentArtifactCount,
  getDesignSidebarDocumentLabel,
  sameDesignWorkspace,
  sortDesignSidebarDocuments,
  type WorkspaceIndexSnapshot
} from './design-sidebar-model'

type Props = {
  activeDocumentId: string | null
  collapsedFolders: Record<string, boolean>
  collapsedWorkspaces: Record<string, boolean>
  docDraft: string
  documents: DesignDocument[]
  draggingDocument: DraggedDocument | null
  dragOverFolderKey: string | null
  drawingHistoryMutation: DrawingHistoryMutation | null
  editingDocId: string | null
  navigationLocked: boolean
  moveDocumentId: string | null
  resolvedDefaultWorkspaceRoot: string
  t: TFunction
  workspaceFolders: DesignWorkspaceFolder[]
  workspaceIndexes: Record<string, WorkspaceIndexSnapshot>
  workspaceRoot: string
  workspaceRoots: string[]
  onActivateWorkspace: (root: string, documentId?: string) => Promise<boolean>
  onBeginRenameDocument: (documentId: string, title: string) => void
  onCommitRenameDocument: (documentId: string) => void
  onDeleteDocument: (root: string, documentId: string) => Promise<void>
  onDeleteFolder: (root: string, folder: DesignWorkspaceFolder, folders: readonly DesignWorkspaceFolder[]) => void
  onDocumentIsRunning: (root: string, document: DesignDocument) => boolean
  onMoveDocumentToFolder: (root: string, documentId: string, folderId: string | null) => Promise<void>
  onNewDocument: (root?: string, folderId?: string | null) => Promise<void>
  onOpenFolderDialog: (
    root: string,
    mode: 'create' | 'rename',
    parentId?: string | null,
    folder?: DesignWorkspaceFolder
  ) => void
  onOpenMoveDocumentMenu: (root: string, documentId: string) => Promise<void>
  onRemoveWorkspace: (root: string) => void
  onSelectDocument: (root: string, documentId: string) => Promise<void>
  renderActiveDocumentContent: () => ReactElement
  setCollapsedFolders: Dispatch<SetStateAction<Record<string, boolean>>>
  setCollapsedWorkspaces: Dispatch<SetStateAction<Record<string, boolean>>>
  setDocDraft: Dispatch<SetStateAction<string>>
  setDraggingDocument: Dispatch<SetStateAction<DraggedDocument | null>>
  setDragOverFolderKey: Dispatch<SetStateAction<string | null>>
  setEditingDocId: Dispatch<SetStateAction<string | null>>
}

export function DesignSidebarWorkspaceTree({
  activeDocumentId,
  collapsedFolders,
  collapsedWorkspaces,
  docDraft,
  documents,
  draggingDocument,
  dragOverFolderKey,
  drawingHistoryMutation,
  editingDocId,
  navigationLocked,
  moveDocumentId,
  resolvedDefaultWorkspaceRoot,
  t,
  workspaceFolders,
  workspaceIndexes,
  workspaceRoot,
  workspaceRoots,
  onActivateWorkspace,
  onBeginRenameDocument,
  onCommitRenameDocument,
  onDeleteDocument,
  onDeleteFolder,
  onDocumentIsRunning,
  onMoveDocumentToFolder,
  onNewDocument,
  onOpenFolderDialog,
  onOpenMoveDocumentMenu,
  onRemoveWorkspace,
  onSelectDocument,
  renderActiveDocumentContent,
  setCollapsedFolders,
  setCollapsedWorkspaces,
  setDocDraft,
  setDraggingDocument,
  setDragOverFolderKey,
  setEditingDocId
}: Props): ReactElement {
  const renderDocument = (
    root: string,
    doc: DesignDocument,
    folders: readonly DesignWorkspaceFolder[]
  ): ReactElement => {
    const isCurrentWorkspace = sameDesignWorkspace(root, workspaceRoot)
    const isActive = isCurrentWorkspace && doc.id === activeDocumentId
    const historyMutationPending = isCurrentWorkspace && drawingHistoryMutationMatches(
      drawingHistoryMutation,
      workspaceRoot,
      doc.id
    )
    const artifactCount = isCurrentWorkspace ? getDesignSidebarDocumentArtifactCount(doc) : 0
    const documentLabel = getDesignSidebarDocumentLabel(doc, t('designUntitledDrawing'))
    const movableFolders = designFolderOptions(folders)
    return (
      <li key={`${root}:${doc.id}`}>
        {isActive && editingDocId === doc.id ? (
          <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
            <input
              autoFocus
              value={docDraft}
              onChange={(event) => setDocDraft(event.target.value)}
              onBlur={() => onCommitRenameDocument(doc.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onCommitRenameDocument(doc.id)
                else if (event.key === 'Escape') setEditingDocId(null)
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-none focus:border-[#3b82d8] dark:text-white"
            />
          </div>
        ) : (
          <SidebarTreeRow
            active={isActive}
            disabled={navigationLocked || (historyMutationPending && drawingHistoryMutation?.kind === 'delete')}
            draggable={!navigationLocked}
            onDragStart={(event: DragEvent<HTMLDivElement>) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-kun-design-document', JSON.stringify({
                workspaceRoot: root,
                documentId: doc.id
              } satisfies DraggedDocument))
              setDraggingDocument({ workspaceRoot: root, documentId: doc.id })
            }}
            onDragEnd={() => {
              setDraggingDocument(null)
              setDragOverFolderKey(null)
            }}
            onClick={() => void onSelectDocument(root, doc.id)}
            onDoubleClick={() => {
              if (navigationLocked) return
              void onActivateWorkspace(root, doc.id).then((activated) => {
                if (activated) onBeginRenameDocument(doc.id, documentLabel)
              })
            }}
            title={documentLabel}
            className="min-h-[34px]"
            buttonClassName="items-center gap-2 px-2.5 py-2"
            trailing={
              moveDocumentId === doc.id && isCurrentWorkspace ? (
                <select
                  value={doc.folderId ?? ''}
                  aria-label={t('designMoveDocument')}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => void onMoveDocumentToFolder(root, doc.id, event.target.value || null)}
                  className="max-w-[110px] rounded border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-1 py-0.5 text-[11px] text-ds-muted outline-none"
                >
                  <option value="">{t('designWorkspaceRoot')}</option>
                  {movableFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                </select>
              ) : artifactCount > 0 ? <span className="text-[11.5px] text-ds-faint">{artifactCount}</span> : null
            }
            actionsVisibility="hidden"
            actionsLayout="inline"
            actions={
              <>
                <SidebarIconButton
                  onClick={() => void onOpenMoveDocumentMenu(root, doc.id)}
                  disabled={navigationLocked || historyMutationPending}
                  title={t('designMoveDocument')}
                  ariaLabel={t('designMoveDocument')}
                  stopPropagation
                  className="h-6 w-6"
                >
                  <MoveRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                </SidebarIconButton>
                <SidebarIconButton
                  onClick={() => {
                    if (navigationLocked) return
                    void onActivateWorkspace(root, doc.id).then((activated) => {
                      if (activated) onBeginRenameDocument(doc.id, documentLabel)
                    })
                  }}
                  disabled={navigationLocked || historyMutationPending}
                  title={t('designRenameDocument')}
                  ariaLabel={t('designRenameDocument')}
                  stopPropagation
                  className="h-6 w-6"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
                </SidebarIconButton>
                <SidebarIconButton
                  onClick={() => void onDeleteDocument(root, doc.id)}
                  title={t('designDeleteDocument')}
                  ariaLabel={t('designDeleteDocument')}
                  disabled={navigationLocked || Boolean(drawingHistoryMutation)}
                  tone="danger"
                  stopPropagation
                  className="h-6 w-6"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                </SidebarIconButton>
              </>
            }
          >
            {isActive ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#3b82d8]" strokeWidth={1.9} />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
            )}
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 truncate">{documentLabel}</span>
            </span>
          </SidebarTreeRow>
        )}
        {isActive ? renderActiveDocumentContent() : null}
      </li>
    )
  }

  const parseDraggedDocument = (event: DragEvent<HTMLDivElement>): DraggedDocument | null => {
    try {
      return JSON.parse(event.dataTransfer.getData('application/x-kun-design-document')) as DraggedDocument
    } catch {
      return null
    }
  }

  const renderFolder = (
    root: string,
    folder: DesignWorkspaceFolder,
    snapshot: WorkspaceIndexSnapshot
  ): ReactElement => {
    const folderKey = `${normalizeDesignWorkspaceRoot(root)}:${folder.id}`
    const collapsed = collapsedFolders[folderKey] === true
    const children = designChildFolders(snapshot.folders, folder.id)
    const folderDocuments = sortDesignSidebarDocuments(
      snapshot.documents.filter((document) => document.folderId === folder.id),
      (document) => onDocumentIsRunning(root, document)
    )
    const folderDocumentCount = snapshot.documents.filter((document) =>
      designFolderDescendantIds(snapshot.folders, folder.id).has(document.folderId ?? '')
    ).length
    const isDragOver = dragOverFolderKey === folderKey
    return (
      <li key={folderKey}>
        <SidebarTreeRow
          title={folder.name}
          ariaLabel={t('designFolderAriaLabel', { name: folder.name, count: folderDocumentCount })}
          disabled={navigationLocked}
          onClick={() => setCollapsedFolders((current) => ({ ...current, [folderKey]: !collapsed }))}
          onDragOver={(event) => {
            const dragged = draggingDocument ?? parseDraggedDocument(event)
            if (!dragged || !sameDesignWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDragOverFolderKey(folderKey)
          }}
          onDragLeave={() => setDragOverFolderKey((current) => current === folderKey ? null : current)}
          onDrop={(event) => {
            event.preventDefault()
            const dragged = draggingDocument ?? parseDraggedDocument(event)
            setDragOverFolderKey(null)
            setDraggingDocument(null)
            if (!dragged || !sameDesignWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            void onMoveDocumentToFolder(root, dragged.documentId, folder.id)
          }}
          className={`min-h-[32px] ${isDragOver ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]' : ''}`}
          buttonClassName="items-center gap-1.5 px-2 py-1.5"
          actionsVisibility="hidden"
          actionsLayout="inline"
          actions={
            <>
              <SidebarIconButton onClick={() => onOpenFolderDialog(root, 'create', folder.id)} disabled={navigationLocked} title={t('sidebarFolderCreateChild')} ariaLabel={t('sidebarFolderCreateChild')} stopPropagation className="h-6 w-6">
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton onClick={() => void onNewDocument(root, folder.id)} disabled={navigationLocked} title={t('designNewDocument')} ariaLabel={t('designNewDocument')} stopPropagation className="h-6 w-6">
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton onClick={() => onOpenFolderDialog(root, 'rename', folder.parentId, folder)} disabled={navigationLocked} title={t('sidebarFolderRename')} ariaLabel={t('sidebarFolderRename')} stopPropagation className="h-6 w-6">
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton onClick={() => onDeleteFolder(root, folder, snapshot.folders)} disabled={navigationLocked} title={t('sidebarFolderDelete')} ariaLabel={t('sidebarFolderDelete')} tone="danger" stopPropagation className="h-6 w-6">
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
            </>
          }
        >
          {collapsed ? <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} /> : <ChevronDown className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} />}
          {collapsed ? <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} /> : <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} />}
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {folderDocumentCount > 0 ? <span className="text-[11.5px] text-ds-faint">{folderDocumentCount}</span> : null}
        </SidebarTreeRow>
        {!collapsed ? (
          <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-[var(--ds-sidebar-row-ring)] pl-2">
            {children.map((child) => renderFolder(root, child, snapshot))}
            {folderDocuments.map((document) => renderDocument(root, document, snapshot.folders))}
          </ul>
        ) : null}
      </li>
    )
  }

  const renderWorkspace = (root: string): ReactElement => {
    const isCurrentWorkspace = sameDesignWorkspace(root, workspaceRoot)
    const snapshot = isCurrentWorkspace
      ? { documents, folders: workspaceFolders, activeDocumentId }
      : workspaceIndexes[root] ?? { documents: [], folders: [], activeDocumentId: null }
    const collapsed = collapsedWorkspaces[root] === true
    const rootFolders = designChildFolders(snapshot.folders, null)
    const rootDocuments = sortDesignSidebarDocuments(
      snapshot.documents.filter((document) => !document.folderId),
      (document) => onDocumentIsRunning(root, document)
    )
    const isDragOver = dragOverFolderKey === `${root}:root`
    return (
      <section key={root} className="mb-2">
        <SidebarTreeRow
          title={root}
          onClick={() => setCollapsedWorkspaces((current) => ({ ...current, [root]: !collapsed }))}
          onDragOver={(event) => {
            const dragged = draggingDocument
            if (!dragged || !sameDesignWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDragOverFolderKey(`${root}:root`)
          }}
          onDragLeave={() => setDragOverFolderKey((current) => current === `${root}:root` ? null : current)}
          onDrop={(event) => {
            event.preventDefault()
            const dragged = draggingDocument
            setDragOverFolderKey(null)
            setDraggingDocument(null)
            if (!dragged || !sameDesignWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            void onMoveDocumentToFolder(root, dragged.documentId, null)
          }}
          className={`min-h-[36px] text-[13.5px] ${isDragOver ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]' : ''}`}
          buttonClassName="items-center gap-2 px-2.5 py-2"
          actionsVisibility="hidden"
          actionsLayout="inline"
          actions={
            <>
              <SidebarIconButton onClick={() => onOpenFolderDialog(root, 'create')} disabled={navigationLocked} title={t('sidebarFolderCreate')} ariaLabel={t('sidebarFolderCreate')} stopPropagation className="h-6 w-6">
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton onClick={() => void onNewDocument(root)} disabled={navigationLocked} title={t('designNewDocument')} ariaLabel={t('designNewDocument')} stopPropagation className="h-6 w-6">
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              {!sameDesignWorkspace(root, resolvedDefaultWorkspaceRoot) ? (
                <SidebarIconButton onClick={() => onRemoveWorkspace(root)} disabled={navigationLocked} title={t('sidebarWorkspaceRemove')} ariaLabel={t('sidebarWorkspaceRemove')} tone="danger" stopPropagation className="h-6 w-6">
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </SidebarIconButton>
              ) : null}
            </>
          }
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />}
          {collapsed ? <Folder className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} /> : <FolderOpen className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />}
          <span className="min-w-0 flex-1 truncate">{workspaceLabelFromPath(root)}</span>
          <span className="max-w-[34%] truncate text-[11.5px] text-ds-faint">{root}</span>
        </SidebarTreeRow>
        {!collapsed ? (
          <ul className="mt-1 space-y-0.5 pl-4">
            {rootFolders.map((folder) => renderFolder(root, folder, snapshot))}
            {rootDocuments.map((document) => renderDocument(root, document, snapshot.folders))}
          </ul>
        ) : null}
      </section>
    )
  }

  return <div className="space-y-0.5">{workspaceRoots.map(renderWorkspace)}</div>
}
