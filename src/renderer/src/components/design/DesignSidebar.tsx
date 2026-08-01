import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactElement
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Check,
  FileCode2,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderOpen,
  Layers,
  Moon,
  MoveRight,
  Palette,
  Pencil,
  RotateCcw,
  Settings,
  Spline,
  Sun,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SettingsRouteSection } from '../../store/chat-store'
import { useChatStore } from '../../store/chat-store'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import { WorkspaceModeTabs } from '../chat/WorkspaceModeTabs'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import {
  currentDesignArtifactVersion,
  designArtifactVersionLabel,
  designArtifactVersionNumber,
  isFileDesignArtifactKind,
  type DesignArtifact,
  type DesignDocument,
  type DesignWorkspaceFolder
} from '../../design/design-types'
import {
  designChildFolders,
  designFolderDescendantIds,
  designFolderNameExists
} from '../../design/design-workspace-folders'
import { readDesignDocumentsIndex, type DesignDocumentsIndex } from '../../design/design-document-persistence'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'
import { builtinDesignWorkspaceRoot } from '../../design/design-workspace-store/helpers'
import { designDocKey, readDesignThreadRegistry } from '../../design/design-thread-registry'
import { collectAgentDrawingArtifactIds, groupDesignArtifacts } from '../../design/design-artifact-actions'
import { findDesignBoardArtifact } from '../../design/design-board'
import { displayDrawingTitle } from '../../design/design-drawing-title'
import { drawingHistoryMutationMatches } from '../../design/design-drawing-history'
import { useCanvasShapeStore } from '../../design/canvas/canvas-shape-store'
import { useCanvasSelectionStore } from '../../design/canvas/canvas-selection-store'
import { embeddedArtifactOf, isArtifactFrame, isHtmlFrame, shapeBounds } from '../../design/canvas/canvas-types'
import { useCanvasViewportStore } from '../../design/canvas/canvas-viewport-store'
import {
  SidebarCommandRow,
  SidebarFrame,
  SidebarIconButton,
  SidebarSectionHeader,
  SidebarTreeRow
} from '../sidebar/SidebarPrimitives'
import {
  SidebarActionDialog,
  SidebarFolderDialog,
  type SidebarActionDialogState
} from '../chat/SidebarProjectOverlays'
import { CanvasLayersPanel } from './canvas/CanvasLayersPanel'

type Props = {
  onCodeOpen: () => void
  onWriteOpen: () => void
  onDesignOpen: () => void
  onOpenSettings: (section?: SettingsRouteSection) => void
  onToggleTheme: () => void
  onDeleteDrawing?: (documentId: string) => void | Promise<void>
}

type WorkspaceIndexSnapshot = {
  documents: DesignDocument[]
  folders: DesignWorkspaceFolder[]
  activeDocumentId: string | null
}

type FolderDialogState = {
  mode: 'create' | 'rename'
  workspaceRoot: string
  parentId: string | null
  folder?: DesignWorkspaceFolder
  value: string
  error?: string
}

type DraggedDocument = {
  workspaceRoot: string
  documentId: string
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizeDesignWorkspaceRoot(left) === normalizeDesignWorkspaceRoot(right)
}

function uniqueWorkspaceRoots(roots: readonly string[]): string[] {
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

function workspaceIndexSnapshot(index: DesignDocumentsIndex): WorkspaceIndexSnapshot {
  return {
    activeDocumentId: index.activeDocumentId,
    folders: index.folders,
    documents: index.documents.map((document) => ({ ...document, artifacts: [] }))
  }
}

function designFolderOptions(
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

/**
 * Design-mode left sidebar: mode tabs + a 设计稿 (design document) tree. Each
 * 设计稿 is a top-level container; its 画布 (artifacts) show nested under the
 * active one.
 */
export function DesignSidebar({
  onCodeOpen,
  onWriteOpen,
  onDesignOpen,
  onOpenSettings,
  onToggleTheme,
  onDeleteDrawing
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [isDarkMode, setIsDarkMode] = useState(
    () => typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.getAttribute('data-theme') === 'dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const documents = useDesignWorkspaceStore((s) => s.documents)
  const workspaceRoot = useDesignWorkspaceStore((s) => s.workspaceRoot)
  const workspaceFolders = useDesignWorkspaceStore((s) => s.workspaceFolders)
  const activeDocumentId = useDesignWorkspaceStore((s) => s.activeDocumentId)
  const artifacts = useDesignWorkspaceStore((s) => s.artifacts)
  const activeArtifactId = useDesignWorkspaceStore((s) => s.activeArtifactId)
  const setActiveArtifact = useDesignWorkspaceStore((s) => s.setActiveArtifact)
  const removeArtifact = useDesignWorkspaceStore((s) => s.removeArtifact)
  const renameArtifact = useDesignWorkspaceStore((s) => s.renameArtifact)
  const drawingCreationSubmitting = useDesignWorkspaceStore((s) => s.drawingCreationSubmitting)
  const drawingHistoryMutation = useDesignWorkspaceStore((s) => s.drawingHistoryMutation)
  const beginDrawingCreation = useDesignWorkspaceStore((s) => s.beginDrawingCreation)
  const cancelDrawingCreation = useDesignWorkspaceStore((s) => s.cancelDrawingCreation)
  const renameDocument = useDesignWorkspaceStore((s) => s.renameDocument)
  const removeDocument = useDesignWorkspaceStore((s) => s.removeDocument)
  const designSystemHash = useDesignWorkspaceStore((s) => s.designSystemHash)
  const closeImplementPanel = useDesignWorkspaceStore((s) => s.closeImplementPanel)
  const setDesignIntentMode = useDesignWorkspaceStore((s) => s.setDesignIntentMode)
  const chatThreads = useChatStore((s) => s.threads)
  const chatBusy = useChatStore((s) => s.busy)
  const chatActiveThreadId = useChatStore((s) => s.activeThreadId)
  const activeArtifact = artifacts.find((a) => a.id === activeArtifactId) ?? null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const committingRef = useRef(false)
  const workspaceSwitchingRef = useRef(false)
  const workspaceActivationRef = useRef(0)
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [docDraft, setDocDraft] = useState('')
  const committingDocRef = useRef(false)
  const [agentDrawingsOpen, setAgentDrawingsOpen] = useState(true)
  const [workspaceIndexes, setWorkspaceIndexes] = useState<Record<string, WorkspaceIndexSnapshot>>({})
  const [configuredWorkspaceRoots, setConfiguredWorkspaceRoots] = useState<string[]>([])
  const [defaultWorkspaceRoot, setDefaultWorkspaceRoot] = useState('')
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false)
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({})
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null)
  const [folderActionDialog, setFolderActionDialog] = useState<SidebarActionDialogState | null>(null)
  const [draggingDocument, setDraggingDocument] = useState<DraggedDocument | null>(null)
  const [dragOverFolderKey, setDragOverFolderKey] = useState<string | null>(null)
  const [moveDocumentId, setMoveDocumentId] = useState<string | null>(null)

  const canvasDocument = useCanvasShapeStore((s) => s.document)
  const canvasObjects = canvasDocument.objects
  const selectedIds = useCanvasSelectionStore((s) => s.selectedIds)
  const visibleArtifacts = useMemo(() => getDesignSidebarVisibleArtifacts(artifacts), [artifacts])
  const screenLinkedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(canvasObjects)) {
      const shape = canvasObjects[id]
      if (shape && isHtmlFrame(shape) && shape.htmlArtifactId) ids.add(shape.htmlArtifactId)
    }
    return ids
  }, [canvasObjects])
  const selectedHtmlArtifactId = useMemo(() => {
    for (const id of selectedIds) {
      const shape = canvasObjects[id]
      if (shape && isHtmlFrame(shape) && shape.htmlArtifactId) return shape.htmlArtifactId
    }
    return null
  }, [canvasObjects, selectedIds])
  const selectedEmbeddedArtifactId = useMemo(() => {
    for (const id of selectedIds) {
      const shape = canvasObjects[id]
      const reference = shape ? embeddedArtifactOf(shape) : null
      if (reference) return reference.id
    }
    return null
  }, [canvasObjects, selectedIds])
  const grouped = useMemo(
    () => groupDesignArtifacts(visibleArtifacts, screenLinkedIds),
    [screenLinkedIds, visibleArtifacts]
  )
  const agentDrawingArtifactIds = useMemo(() => {
    return collectAgentDrawingArtifactIds(visibleArtifacts, grouped, screenLinkedIds)
  }, [grouped, screenLinkedIds, visibleArtifacts])
  const agentDrawingArtifacts = useMemo(
    () => visibleArtifacts.filter((artifact) => artifact.kind === 'html' && agentDrawingArtifactIds.has(artifact.id)),
    [agentDrawingArtifactIds, visibleArtifacts]
  )
  const knownWorkspaceRoots = useMemo(() => uniqueWorkspaceRoots([
    defaultWorkspaceRoot,
    ...configuredWorkspaceRoots,
    workspaceRoot
  ]), [configuredWorkspaceRoots, defaultWorkspaceRoot, workspaceRoot])
  const resolvedDefaultWorkspaceRoot = defaultWorkspaceRoot || knownWorkspaceRoots[0] || workspaceRoot

  useEffect(() => {
    let disposed = false
    void rendererRuntimeClient.getSettings().then((settings) => {
      if (disposed) return
      const defaultRoot = normalizeDesignWorkspaceRoot(
        settings.design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot()
      )
      setDefaultWorkspaceRoot(defaultRoot)
      setConfiguredWorkspaceRoots(uniqueWorkspaceRoots([defaultRoot, ...settings.design.workspaces]))
    }).catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (!workspaceRoot) return
    setWorkspaceIndexes((current) => ({
      ...current,
      [workspaceRoot]: { documents, folders: workspaceFolders, activeDocumentId }
    }))
  }, [activeDocumentId, documents, workspaceFolders, workspaceRoot])

  useEffect(() => {
    let disposed = false
    const rootsToLoad = knownWorkspaceRoots.filter((root) => !sameWorkspace(root, workspaceRoot))
    void Promise.all(rootsToLoad.map(async (root) => [root, workspaceIndexSnapshot(
      await readDesignDocumentsIndex(root)
    )] as const)).then((entries) => {
      if (disposed) return
      setWorkspaceIndexes((current) => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [knownWorkspaceRoots, workspaceRoot])

  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-design-start-composer] textarea')?.focus()
    })
  }

  const beginRename = (artifactId: string, title: string): void => {
    committingRef.current = false
    setDraft(title)
    setEditingId(artifactId)
  }
  const commitRename = (artifactId: string): void => {
    if (committingRef.current) return
    committingRef.current = true
    renameArtifact(artifactId, draft)
    setEditingId(null)
  }

  const beginRenameDoc = (documentId: string, title: string): void => {
    committingDocRef.current = false
    setDocDraft(title)
    setEditingDocId(documentId)
  }
  const commitRenameDoc = (documentId: string): void => {
    if (committingDocRef.current) return
    committingDocRef.current = true
    renameDocument(documentId, docDraft)
    setEditingDocId(null)
  }

  const runningDesignThreadIds = useMemo(() => {
    const registry = readDesignThreadRegistry()
    return new Set(Object.values(registry.workspaces).flatMap((record) => record.threadIds))
  }, [chatThreads])
  const documentIsRunning = (root: string, document: DesignDocument): boolean => {
    const record = readDesignThreadRegistry().workspaces[designDocKey(root, document.id)]
    if (!record) return false
    return record.threadIds.some((threadId) => {
      const thread = chatThreads.find((candidate) => candidate.id === threadId)
      return thread?.status?.trim().toLowerCase() === 'running' ||
        (threadId === chatActiveThreadId && chatBusy)
    })
  }
  const navigationLocked = workspaceSwitching || drawingCreationSubmitting || chatThreads.some((thread) =>
    runningDesignThreadIds.has(thread.id) &&
    (thread.status?.trim().toLowerCase() === 'running' || (thread.id === chatActiveThreadId && chatBusy))
  )

  const persistWorkspaceSelection = async (root: string, options?: { remove?: boolean }): Promise<void> => {
    const settings = await rendererRuntimeClient.getSettings()
    const normalizedRoot = normalizeDesignWorkspaceRoot(root)
    const effectiveDefaultRoot = normalizeDesignWorkspaceRoot(
      settings.design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot()
    )
    const roots = uniqueWorkspaceRoots([
      effectiveDefaultRoot,
      ...settings.design.workspaces,
      workspaceRoot,
      ...(options?.remove ? [] : [normalizedRoot])
    ]).filter((candidate) => !options?.remove || !sameWorkspace(candidate, normalizedRoot))
    const nextActive = options?.remove
      ? uniqueWorkspaceRoots([effectiveDefaultRoot, ...roots])[0] ?? ''
      : normalizedRoot
    const saved = await rendererRuntimeClient.setSettings({
      design: { workspaces: roots, activeWorkspaceRoot: nextActive }
    })
    const savedDefaultRoot = normalizeDesignWorkspaceRoot(
      saved.design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot()
    )
    setDefaultWorkspaceRoot(savedDefaultRoot)
    setConfiguredWorkspaceRoots(uniqueWorkspaceRoots([savedDefaultRoot, ...saved.design.workspaces]))
  }

  const activateWorkspace = async (root: string, documentId?: string): Promise<boolean> => {
    const normalizedRoot = normalizeDesignWorkspaceRoot(root)
    if (!normalizedRoot || navigationLocked || workspaceSwitchingRef.current) return false
    const store = useDesignWorkspaceStore.getState()
    if (!sameWorkspace(store.workspaceRoot, normalizedRoot)) {
      const activation = ++workspaceActivationRef.current
      workspaceSwitchingRef.current = true
      setWorkspaceSwitching(true)
      store.setWorkspaceRoot(normalizedRoot)
      useDesignWorkspaceStore.setState({ settingsLoaded: false })
      try {
        await useDesignWorkspaceStore.getState().rehydrateArtifacts()
        if (activation !== workspaceActivationRef.current) return false
        await useDesignWorkspaceStore.getState().refreshDesignSystemHash()
      } catch {
        return false
      } finally {
        if (activation === workspaceActivationRef.current) {
          workspaceSwitchingRef.current = false
          setWorkspaceSwitching(false)
          useDesignWorkspaceStore.setState({ settingsLoaded: true })
        }
      }
    }
    const refreshed = useDesignWorkspaceStore.getState()
    if (documentId && !refreshed.documents.some((document) => document.id === documentId)) return false
    if (documentId) refreshed.switchActiveDocument(documentId)
    await persistWorkspaceSelection(normalizedRoot)
    return true
  }

  // New drawing: enter the transient launcher. The document is created only
  // after the first prompt is accepted.
  const handleNewDocument = async (root = workspaceRoot, folderId: string | null = null): Promise<void> => {
    if (navigationLocked || !(await activateWorkspace(root))) return
    closeImplementPanel()
    setDesignIntentMode('generate')
    beginDrawingCreation({ folderId })
    useCanvasSelectionStore.getState().clearSelection()
    focusComposer()
  }

  const handleSelectDocument = async (root: string, documentId: string): Promise<void> => {
    if (navigationLocked || (sameWorkspace(root, workspaceRoot) && documentId === activeDocumentId)) return
    closeImplementPanel()
    useCanvasSelectionStore.getState().clearSelection()
    cancelDrawingCreation()
    await activateWorkspace(root, documentId)
  }

  const handleAddWorkspace = async (): Promise<void> => {
    if (navigationLocked || typeof window.kunGui?.pickWorkspaceDirectory !== 'function') return
    const picked = await window.kunGui.pickWorkspaceDirectory(workspaceRoot || defaultWorkspaceRoot || undefined)
    if (picked.canceled || !picked.path) return
    await activateWorkspace(picked.path)
  }

  const handleRemoveWorkspace = (root: string): void => {
    if (navigationLocked || sameWorkspace(root, resolvedDefaultWorkspaceRoot)) return
    setFolderActionDialog({
      title: t('sidebarWorkspaceRemoveDialogTitle', { name: workspaceLabelFromPath(root) }),
      description: t('sidebarWorkspaceRemoveDialogDescription'),
      detail: t('sidebarWorkspaceRemoveDialogDetail'),
      confirmLabel: t('sidebarWorkspaceRemoveConfirmButton'),
      danger: true,
      submitting: false,
      onConfirm: async () => {
        await persistWorkspaceSelection(root, { remove: true })
        if (sameWorkspace(root, workspaceRoot)) {
          const fallback = uniqueWorkspaceRoots([defaultWorkspaceRoot, ...configuredWorkspaceRoots])
            .find((candidate) => !sameWorkspace(candidate, root))
          if (fallback) await activateWorkspace(fallback)
        }
      }
    })
  }

  const openFolderDialog = (
    root: string,
    mode: FolderDialogState['mode'],
    parentId: string | null = null,
    folder?: DesignWorkspaceFolder
  ): void => {
    if (navigationLocked) return
    setFolderDialog({
      mode,
      workspaceRoot: root,
      parentId,
      folder,
      value: folder?.name ?? ''
    })
  }

  const submitFolderDialog = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const dialog = folderDialog
    if (!dialog || !dialog.value.trim()) return
    if (!(await activateWorkspace(dialog.workspaceRoot))) return
    const state = useDesignWorkspaceStore.getState()
    const parentId = dialog.mode === 'rename' ? dialog.folder?.parentId ?? null : dialog.parentId
    if (designFolderNameExists(state.workspaceFolders, dialog.value, parentId, dialog.folder?.id)) {
      setFolderDialog({ ...dialog, error: t('sidebarFolderNameExists') })
      return
    }
    if (dialog.mode === 'create') state.createWorkspaceFolder(dialog.value, dialog.parentId)
    else if (dialog.folder) state.renameWorkspaceFolder(dialog.folder.id, dialog.value)
    setFolderDialog(null)
  }

  const moveDocumentToFolder = async (root: string, documentId: string, folderId: string | null): Promise<void> => {
    if (!(await activateWorkspace(root))) return
    useDesignWorkspaceStore.getState().moveDocument(documentId, folderId)
    setMoveDocumentId(null)
  }

  const handleSelectAgentDrawing = (artifact: DesignArtifact): void => {
    closeImplementPanel()
    const boardArtifact = findDesignBoardArtifact(useDesignWorkspaceStore.getState().artifacts)
    if (boardArtifact) setActiveArtifact(boardArtifact.id)

    const frame = Object.values(useCanvasShapeStore.getState().document.objects).find((shape) =>
      shape && isArtifactFrame(shape) && embeddedArtifactOf(shape)?.id === artifact.id
    )
    const viewportStore = useCanvasViewportStore.getState()
    viewportStore.setActiveTool('select')

    if (frame) {
      useCanvasSelectionStore.getState().select([frame.id])
      viewportStore.zoomToFit(shapeBounds(frame), 72, { maxZoom: 1, minZoom: 0.18 })
      return
    }

    useCanvasSelectionStore.getState().clearSelection()
    if (boardArtifact && artifact.kind === 'html' && artifact.node?.boardHidden) {
      useDesignWorkspaceStore.getState().updateArtifactNode(artifact.id, { boardHidden: false })
    }
    if (artifact.node) {
      viewportStore.zoomToFit(
        {
          x: artifact.node.x,
          y: artifact.node.y,
          width: artifact.node.width,
          height: artifact.node.height
        },
        72,
        { maxZoom: 1, minZoom: 0.18 }
      )
    }
    if (!boardArtifact) setActiveArtifact(artifact.id)
  }

  const renderArtifactStatus = (artifact: DesignArtifact): ReactElement | null => {
    const implemented = Boolean(artifact.implementedAt)
    if (!implemented) return null
    const drift = (artifact.implementedAt ?? '') < artifact.updatedAt
    const codeDrift =
      !drift &&
      Boolean(artifact.implementedDesignSystemHash) &&
      Boolean(designSystemHash) &&
      artifact.implementedDesignSystemHash !== designSystemHash
    const title = drift ? t('designDrift') : codeDrift ? t('designCodeDrift') : t('designImplemented')
    const Icon = drift ? RotateCcw : codeDrift ? TriangleAlert : Check
    return (
      <span
        title={title}
        aria-label={title}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${
          drift ? 'text-[#c98a3a]' : codeDrift ? 'text-[#c0392b]' : 'text-[#2e9e6b]'
        }`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }

  const renderArtifactRows = (items: DesignArtifact[]): ReactElement => (
    <ul className="space-y-1">
      {items.map((artifact) => {
        const active = artifact.id === activeArtifactId || artifact.id === selectedEmbeddedArtifactId
        const status = renderArtifactStatus(artifact)
        const versionBadge = getDesignSidebarArtifactVersionBadge(artifact)
        return (
          <li key={artifact.id}>
            {editingId === artifact.id ? (
              <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(artifact.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(artifact.id)
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-none focus:border-[#3b82d8] dark:text-white"
                />
              </div>
            ) : (
              <SidebarTreeRow
                active={active}
                onClick={() => artifact.kind === 'svg'
                  ? handleSelectAgentDrawing(artifact)
                  : setActiveArtifact(artifact.id)}
                onDoubleClick={() => beginRename(artifact.id, artifact.title)}
                title={artifact.title}
                className="min-h-[34px]"
                buttonClassName="items-center gap-2 px-2.5 py-2"
                trailing={
                  <>
                    {versionBadge ? (
                      <span className="text-[11.5px] text-ds-faint">{versionBadge}</span>
                    ) : null}
                    {status}
                  </>
                }
                actions={
                  <SidebarIconButton
                    onClick={() => removeArtifact(artifact.id)}
                    title={t('designDeleteArtifact')}
                    ariaLabel={t('designDeleteArtifact')}
                    tone="danger"
                    stopPropagation
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </SidebarIconButton>
                }
              >
                {artifact.kind === 'canvas' ? (
                  <Layers className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                ) : artifact.kind === 'svg' ? (
                  <Spline className="h-3.5 w-3.5 shrink-0 text-[#6557ff]" strokeWidth={1.9} />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                )}
                <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
              </SidebarTreeRow>
            )}
          </li>
        )
      })}
    </ul>
  )

  const renderAgentDrawingRows = (items: DesignArtifact[]): ReactElement => {
    const scrollable = items.length > 5
    return (
      <div className={scrollable ? 'max-h-[190px] overflow-y-auto pr-1' : undefined}>
        <ul className="space-y-1">
          {items.map((artifact) => {
            const active = artifact.id === activeArtifactId || artifact.id === selectedHtmlArtifactId
            const status = renderArtifactStatus(artifact)
            const versionBadge = getDesignSidebarArtifactVersionBadge(artifact)
            return (
              <li key={artifact.id}>
                {editingId === artifact.id ? (
                  <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(artifact.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(artifact.id)
                        else if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-none focus:border-[#3b82d8] dark:text-white"
                    />
                  </div>
                ) : (
                  <SidebarTreeRow
                    active={active}
                    onClick={() => handleSelectAgentDrawing(artifact)}
                    onDoubleClick={() => beginRename(artifact.id, artifact.title)}
                    title={artifact.title}
                    className="min-h-[34px]"
                    buttonClassName="items-center gap-2 px-2.5 py-2"
                    trailing={
                      <>
                        {versionBadge ? (
                          <span className="text-[11.5px] text-ds-faint">{versionBadge}</span>
                        ) : null}
                        {status}
                      </>
                    }
                    actions={
                      <SidebarIconButton
                        onClick={() => removeArtifact(artifact.id)}
                        title={t('designDeleteArtifact')}
                        ariaLabel={t('designDeleteArtifact')}
                        tone="danger"
                        stopPropagation
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                      </SidebarIconButton>
                    }
                  >
                    <Palette className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  </SidebarTreeRow>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  const renderAgentDrawingsSection = (items: DesignArtifact[]): ReactElement => {
    const toggleLabel = t(agentDrawingsOpen ? 'designAgentDrawingsCollapse' : 'designAgentDrawingsExpand')
    return (
      <section>
        <button
          type="button"
          onClick={() => setAgentDrawingsOpen((open) => !open)}
          title={toggleLabel}
          aria-label={toggleLabel}
          className="flex w-full items-center gap-1 px-2.5 pb-2 pt-5 text-left text-[12px] font-normal text-[#9aa5b5] transition hover:text-ds-muted dark:text-white/35 dark:hover:text-white/55"
        >
          {agentDrawingsOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          )}
          <span className="min-w-0 flex-1 truncate">{t('designAgentDrawingsTitle')}</span>
          <span className="shrink-0 text-[11.5px] text-ds-faint">{items.length}</span>
        </button>
        {agentDrawingsOpen ? renderAgentDrawingRows(items) : null}
      </section>
    )
  }

  // The board canvas is an implementation surface, so keep the tree focused on
  // user-created drafts while exposing board layers below.
  const renderActiveDocBody = (): ReactElement => {
    const items = [
      ...grouped.html.filter((artifact) => !agentDrawingArtifactIds.has(artifact.id)),
      ...grouped.svg
    ]
    return (
      <div className="ml-3 mt-0.5 space-y-1 border-l border-[var(--ds-sidebar-row-ring)] pl-2">
        {items.length > 0 ? (
          renderArtifactRows(items)
        ) : agentDrawingArtifacts.length === 0 && activeArtifact?.kind !== 'canvas' ? (
          <div className="px-2.5 py-1.5 text-[12px] leading-5 text-ds-faint">{t('designDocEmpty')}</div>
        ) : null}
        {agentDrawingArtifacts.length > 0 ? renderAgentDrawingsSection(agentDrawingArtifacts) : null}
        {activeArtifact?.kind === 'canvas' ? (
          <section>
            <SidebarSectionHeader label={t('canvasLayersTitle')} />
            <CanvasLayersPanel />
          </section>
        ) : null}
      </div>
    )
  }

  const deleteDocumentInWorkspace = async (root: string, documentId: string): Promise<void> => {
    if (!(await activateWorkspace(root, documentId))) return
    if (onDeleteDrawing) await onDeleteDrawing(documentId)
    else await removeDocument(documentId)
  }

  const openMoveDocumentMenu = async (root: string, documentId: string): Promise<void> => {
    if (!(await activateWorkspace(root, documentId))) return
    setMoveDocumentId(documentId)
  }

  const deleteFolder = (root: string, folder: DesignWorkspaceFolder, folders: readonly DesignWorkspaceFolder[]): void => {
    if (navigationLocked) return
    const snapshot = sameWorkspace(root, workspaceRoot)
      ? { documents, folders }
      : workspaceIndexes[root] ?? { documents: [], folders, activeDocumentId: null }
    const directCount = snapshot.documents.filter((document) => document.folderId === folder.id).length
    setFolderActionDialog({
      title: t('sidebarFolderDeleteDialogTitle', { name: folder.name }),
      description: t('designFolderDeleteDialogDescription'),
      detail: t('designFolderDeleteDialogDetail', { count: directCount }),
      confirmLabel: t('sidebarFolderDeleteConfirmButton'),
      danger: true,
      submitting: false,
      onConfirm: async () => {
        if (!(await activateWorkspace(root))) return
        useDesignWorkspaceStore.getState().removeWorkspaceFolder(folder.id)
        setCollapsedFolders((current) => {
          const next = { ...current }
          for (const id of designFolderDescendantIds(folders, folder.id)) {
            delete next[`${normalizeDesignWorkspaceRoot(root)}:${id}`]
          }
          return next
        })
      }
    })
  }

  const renderDocument = (
    root: string,
    doc: DesignDocument,
    folders: readonly DesignWorkspaceFolder[]
  ): ReactElement => {
    const isCurrentWorkspace = sameWorkspace(root, workspaceRoot)
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
              onChange={(e) => setDocDraft(e.target.value)}
              onBlur={() => commitRenameDoc(doc.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRenameDoc(doc.id)
                else if (e.key === 'Escape') setEditingDocId(null)
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
            onClick={() => void handleSelectDocument(root, doc.id)}
            onDoubleClick={() => {
              if (navigationLocked) return
              void activateWorkspace(root, doc.id).then((activated) => {
                if (activated) beginRenameDoc(doc.id, documentLabel)
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
                  onChange={(event) => void moveDocumentToFolder(root, doc.id, event.target.value || null)}
                  className="max-w-[110px] rounded border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-1 py-0.5 text-[11px] text-ds-muted outline-none"
                >
                  <option value="">{t('designWorkspaceRoot')}</option>
                  {movableFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                </select>
              ) : artifactCount > 0 ? (
                <span className="text-[11.5px] text-ds-faint">{artifactCount}</span>
              ) : null
            }
            actionsVisibility="hidden"
            actionsLayout="inline"
            actions={
              <>
                <SidebarIconButton
                  onClick={() => void openMoveDocumentMenu(root, doc.id)}
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
                    void activateWorkspace(root, doc.id).then((activated) => {
                      if (activated) beginRenameDoc(doc.id, documentLabel)
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
                  onClick={() => void deleteDocumentInWorkspace(root, doc.id)}
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
        {isActive ? renderActiveDocBody() : null}
      </li>
    )
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
      (document) => documentIsRunning(root, document)
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
            const dragged = draggingDocument ?? (() => {
              try { return JSON.parse(event.dataTransfer.getData('application/x-kun-design-document')) as DraggedDocument } catch { return null }
            })()
            if (!dragged || !sameWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDragOverFolderKey(folderKey)
          }}
          onDragLeave={() => setDragOverFolderKey((current) => current === folderKey ? null : current)}
          onDrop={(event) => {
            event.preventDefault()
            const dragged = draggingDocument ?? (() => {
              try { return JSON.parse(event.dataTransfer.getData('application/x-kun-design-document')) as DraggedDocument } catch { return null }
            })()
            setDragOverFolderKey(null)
            setDraggingDocument(null)
            if (!dragged || !sameWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            void moveDocumentToFolder(root, dragged.documentId, folder.id)
          }}
          className={`min-h-[32px] ${isDragOver ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]' : ''}`}
          buttonClassName="items-center gap-1.5 px-2 py-1.5"
          actionsVisibility="hidden"
          actionsLayout="inline"
          actions={
            <>
              <SidebarIconButton
                onClick={() => openFolderDialog(root, 'create', folder.id)}
                disabled={navigationLocked}
                title={t('sidebarFolderCreateChild')}
                ariaLabel={t('sidebarFolderCreateChild')}
                stopPropagation
                className="h-6 w-6"
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton
                onClick={() => void handleNewDocument(root, folder.id)}
                disabled={navigationLocked}
                title={t('designNewDocument')}
                ariaLabel={t('designNewDocument')}
                stopPropagation
                className="h-6 w-6"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton
                onClick={() => openFolderDialog(root, 'rename', folder.parentId, folder)}
                disabled={navigationLocked}
                title={t('sidebarFolderRename')}
                ariaLabel={t('sidebarFolderRename')}
                stopPropagation
                className="h-6 w-6"
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton
                onClick={() => deleteFolder(root, folder, snapshot.folders)}
                disabled={navigationLocked}
                title={t('sidebarFolderDelete')}
                ariaLabel={t('sidebarFolderDelete')}
                tone="danger"
                stopPropagation
                className="h-6 w-6"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
            </>
          }
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} />
          )}
          {collapsed ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} />
          )}
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
    const isCurrentWorkspace = sameWorkspace(root, workspaceRoot)
    const snapshot = isCurrentWorkspace
      ? { documents, folders: workspaceFolders, activeDocumentId }
      : workspaceIndexes[root] ?? { documents: [], folders: [], activeDocumentId: null }
    const collapsed = collapsedWorkspaces[root] === true
    const rootFolders = designChildFolders(snapshot.folders, null)
    const rootDocuments = sortDesignSidebarDocuments(
      snapshot.documents.filter((document) => !document.folderId),
      (document) => documentIsRunning(root, document)
    )
    const isDragOver = dragOverFolderKey === `${root}:root`
    return (
      <section key={root} className="mb-2">
        <SidebarTreeRow
          title={root}
          onClick={() => setCollapsedWorkspaces((current) => ({ ...current, [root]: !collapsed }))}
          onDragOver={(event) => {
            const dragged = draggingDocument
            if (!dragged || !sameWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
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
            if (!dragged || !sameWorkspace(dragged.workspaceRoot, root) || navigationLocked) return
            void moveDocumentToFolder(root, dragged.documentId, null)
          }}
          className={`min-h-[36px] text-[13.5px] ${isDragOver ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]' : ''}`}
          buttonClassName="items-center gap-2 px-2.5 py-2"
          actionsVisibility="hidden"
          actionsLayout="inline"
          actions={
            <>
              <SidebarIconButton
                onClick={() => openFolderDialog(root, 'create')}
                disabled={navigationLocked}
                title={t('sidebarFolderCreate')}
                ariaLabel={t('sidebarFolderCreate')}
                stopPropagation
                className="h-6 w-6"
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              <SidebarIconButton
                onClick={() => void handleNewDocument(root)}
                disabled={navigationLocked}
                title={t('designNewDocument')}
                ariaLabel={t('designNewDocument')}
                stopPropagation
                className="h-6 w-6"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </SidebarIconButton>
              {!sameWorkspace(root, resolvedDefaultWorkspaceRoot) ? (
                <SidebarIconButton
                  onClick={() => handleRemoveWorkspace(root)}
                  disabled={navigationLocked}
                  title={t('sidebarWorkspaceRemove')}
                  ariaLabel={t('sidebarWorkspaceRemove')}
                  tone="danger"
                  stopPropagation
                  className="h-6 w-6"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </SidebarIconButton>
              ) : null}
            </>
          }
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
          )}
          {collapsed ? (
            <Folder className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />
          )}
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

  const confirmFolderAction = (): void => {
    const action = folderActionDialog
    if (!action || action.submitting) return
    setFolderActionDialog({ ...action, submitting: true })
    void action.onConfirm()
      .then(() => setFolderActionDialog(null))
      .catch(() => setFolderActionDialog((current) => current ? { ...current, submitting: false } : current))
  }

  return (
    <>
      <SidebarFrame
        title={t('appName')}
        footer={
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <SidebarCommandRow
                  icon={<Settings className="h-4 w-4" strokeWidth={1.75} />}
                  label={t('settings')}
                  onClick={() => onOpenSettings('design')}
                  disabled={navigationLocked}
                  disabledHint={t('designDrawingPreparing')}
                  variant="footer"
                />
              </div>
              <SidebarIconButton
                title={isDarkMode ? t('switchToLight') : t('switchToDark')}
                ariaLabel={t('toggleTheme')}
                onClick={onToggleTheme}
              >
                {isDarkMode ? (
                  <Sun className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <Moon className="h-4 w-4" strokeWidth={1.75} />
                )}
              </SidebarIconButton>
            </div>
          </div>
        }
      >
        <div className="ds-no-drag flex flex-col px-1">
          <WorkspaceModeTabs
            activeView="design"
            onCodeOpen={onCodeOpen}
            onWriteOpen={onWriteOpen}
            onDesignOpen={onDesignOpen}
            disabled={navigationLocked}
            disabledReason={t('designDrawingPreparing')}
          />
          <SidebarCommandRow
            icon={<FilePlus2 className="h-4 w-4" strokeWidth={1.9} />}
            label={t('designNewDocument')}
            onClick={() => void handleNewDocument()}
            disabled={navigationLocked}
            disabledHint={t('designDrawingPreparing')}
            variant="accent"
          />
          <SidebarCommandRow
            icon={<FolderPlus className="h-4 w-4" strokeWidth={1.9} />}
            label={t('designAddWorkspace')}
            onClick={() => void handleAddWorkspace()}
            disabled={navigationLocked}
            disabledHint={t('designDrawingPreparing')}
            variant="flat"
          />
        </div>

        <div className="ds-no-drag mx-1.5 my-3" />

        <div className="ds-no-drag flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {knownWorkspaceRoots.length === 0 ? (
              <div className="mx-2 mt-2 rounded-lg px-2 py-2">
                <p className="text-[15px] font-medium text-ds-muted">{t('designNewDocument')}</p>
                <p className="mt-1 text-[13px] leading-5 text-ds-faint">{t('designSidebarEmpty')}</p>
              </div>
            ) : (
              <div className="space-y-0.5">{knownWorkspaceRoots.map(renderWorkspace)}</div>
            )}
          </div>
        </div>
      </SidebarFrame>
      {folderDialog ? (
        <SidebarFolderDialog
          state={{
            mode: folderDialog.mode,
            workspacePath: folderDialog.workspaceRoot,
            parentId: folderDialog.parentId,
            ...(folderDialog.folder ? { folder: { ...folderDialog.folder, threadIds: [] } } : {}),
            value: folderDialog.value,
            ...(folderDialog.error ? { error: folderDialog.error } : {})
          }}
          onClose={() => setFolderDialog(null)}
          onValueChange={(value) => setFolderDialog((current) => current ? { ...current, value, error: undefined } : current)}
          onSubmit={(event) => void submitFolderDialog(event)}
          t={t}
        />
      ) : null}
      {folderActionDialog ? (
        <SidebarActionDialog
          state={folderActionDialog}
          onClose={() => {
            if (!folderActionDialog.submitting) setFolderActionDialog(null)
          }}
          onConfirm={confirmFolderAction}
          t={t}
        />
      ) : null}
    </>
  )
}
