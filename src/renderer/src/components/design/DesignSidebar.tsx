import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import {
  FilePlus2,
  FolderPlus,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SettingsRouteSection } from '../../store/chat-store'
import { useChatStore } from '../../store/chat-store'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import { WorkspaceModeTabs } from '../chat/WorkspaceModeTabs'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import {
  type DesignArtifact,
  type DesignDocument,
  type DesignWorkspaceFolder
} from '../../design/design-types'
import {
  designFolderDescendantIds,
  designFolderNameExists
} from '../../design/design-workspace-folders'
import { readDesignDocumentsIndex } from '../../design/design-document-persistence'
import { normalizeDesignWorkspaceRoot } from '../../design/design-workspace-lifecycle'
import { builtinDesignWorkspaceRoot } from '../../design/design-workspace-store/helpers'
import { designDocKey, readDesignThreadRegistry } from '../../design/design-thread-registry'
import { collectAgentDrawingArtifactIds, groupDesignArtifacts } from '../../design/design-artifact-actions'
import { findDesignBoardArtifact } from '../../design/design-board'
import { useCanvasShapeStore } from '../../design/canvas/canvas-shape-store'
import { useCanvasSelectionStore } from '../../design/canvas/canvas-selection-store'
import { embeddedArtifactOf, isArtifactFrame, isHtmlFrame, shapeBounds } from '../../design/canvas/canvas-types'
import { useCanvasViewportStore } from '../../design/canvas/canvas-viewport-store'
import {
  SidebarCommandRow,
  SidebarFrame,
  SidebarIconButton
} from '../sidebar/SidebarPrimitives'
import {
  SidebarActionDialog,
  SidebarFolderDialog,
  type SidebarActionDialogState
} from '../chat/SidebarProjectOverlays'
import { DesignSidebarArtifactTree } from './DesignSidebarArtifactTree'
import { DesignSidebarWorkspaceTree } from './DesignSidebarWorkspaceTree'
import {
  getDesignSidebarVisibleArtifacts,
  sameDesignWorkspace,
  uniqueDesignWorkspaceRoots,
  workspaceIndexSnapshot,
  type DraggedDocument,
  type WorkspaceIndexSnapshot
} from './design-sidebar-model'

export {
  getDesignSidebarArtifactVersionBadge,
  getDesignSidebarDocumentArtifactCount,
  getDesignSidebarDocumentLabel,
  getDesignSidebarDocumentScreenCount,
  getDesignSidebarVisibleArtifacts,
  sortDesignSidebarDocuments
} from './design-sidebar-model'

export function resolveDesignSidebarNavigationLocks(options: {
  workspaceSwitching: boolean
  drawingCreationSubmitting: boolean
  designAgentRunning: boolean
}): {
  modeSwitchLocked: boolean
  designNavigationLocked: boolean
} {
  const preparationLocked = options.workspaceSwitching || options.drawingCreationSubmitting
  return {
    modeSwitchLocked: preparationLocked,
    designNavigationLocked: preparationLocked || options.designAgentRunning
  }
}

type Props = {
  onCodeOpen: () => void
  onWriteOpen: () => void
  onDesignOpen: () => void
  onOpenSettings: (section?: SettingsRouteSection) => void
  onToggleTheme: () => void
  onDeleteDrawing?: (documentId: string) => void | Promise<void>
}

type FolderDialogState = {
  mode: 'create' | 'rename'
  workspaceRoot: string
  parentId: string | null
  folder?: DesignWorkspaceFolder
  value: string
  error?: string
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
  const knownWorkspaceRoots = useMemo(() => uniqueDesignWorkspaceRoots([
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
      setConfiguredWorkspaceRoots(uniqueDesignWorkspaceRoots([defaultRoot, ...settings.design.workspaces]))
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
    const rootsToLoad = knownWorkspaceRoots.filter((root) => !sameDesignWorkspace(root, workspaceRoot))
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
    void chatThreads
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
  const designAgentRunning = chatThreads.some((thread) =>
    runningDesignThreadIds.has(thread.id) &&
    (thread.status?.trim().toLowerCase() === 'running' || (thread.id === chatActiveThreadId && chatBusy))
  )
  const {
    modeSwitchLocked,
    designNavigationLocked: navigationLocked
  } = resolveDesignSidebarNavigationLocks({
    workspaceSwitching,
    drawingCreationSubmitting,
    designAgentRunning
  })

  const persistWorkspaceSelection = async (root: string, options?: { remove?: boolean }): Promise<void> => {
    const settings = await rendererRuntimeClient.getSettings()
    const normalizedRoot = normalizeDesignWorkspaceRoot(root)
    const effectiveDefaultRoot = normalizeDesignWorkspaceRoot(
      settings.design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot()
    )
    const roots = uniqueDesignWorkspaceRoots([
      effectiveDefaultRoot,
      ...settings.design.workspaces,
      workspaceRoot,
      ...(options?.remove ? [] : [normalizedRoot])
    ]).filter((candidate) => !options?.remove || !sameDesignWorkspace(candidate, normalizedRoot))
    const nextActive = options?.remove
      ? uniqueDesignWorkspaceRoots([effectiveDefaultRoot, ...roots])[0] ?? ''
      : normalizedRoot
    const saved = await rendererRuntimeClient.setSettings({
      design: { workspaces: roots, activeWorkspaceRoot: nextActive }
    })
    const savedDefaultRoot = normalizeDesignWorkspaceRoot(
      saved.design.defaultWorkspaceRoot || builtinDesignWorkspaceRoot()
    )
    setDefaultWorkspaceRoot(savedDefaultRoot)
    setConfiguredWorkspaceRoots(uniqueDesignWorkspaceRoots([savedDefaultRoot, ...saved.design.workspaces]))
  }

  const activateWorkspace = async (root: string, documentId?: string): Promise<boolean> => {
    const normalizedRoot = normalizeDesignWorkspaceRoot(root)
    if (!normalizedRoot || navigationLocked || workspaceSwitchingRef.current) return false
    const store = useDesignWorkspaceStore.getState()
    if (!sameDesignWorkspace(store.workspaceRoot, normalizedRoot)) {
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
    if (navigationLocked || (sameDesignWorkspace(root, workspaceRoot) && documentId === activeDocumentId)) return
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
    if (navigationLocked || sameDesignWorkspace(root, resolvedDefaultWorkspaceRoot)) return
    setFolderActionDialog({
      title: t('sidebarWorkspaceRemoveDialogTitle', { name: workspaceLabelFromPath(root) }),
      description: t('sidebarWorkspaceRemoveDialogDescription'),
      detail: t('sidebarWorkspaceRemoveDialogDetail'),
      confirmLabel: t('sidebarWorkspaceRemoveConfirmButton'),
      danger: true,
      submitting: false,
      onConfirm: async () => {
        await persistWorkspaceSelection(root, { remove: true })
        if (sameDesignWorkspace(root, workspaceRoot)) {
          const fallback = uniqueDesignWorkspaceRoots([defaultWorkspaceRoot, ...configuredWorkspaceRoots])
            .find((candidate) => !sameDesignWorkspace(candidate, root))
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

  const renderActiveDocBody = (): ReactElement => {
    return (
      <DesignSidebarArtifactTree
        activeArtifact={activeArtifact}
        activeArtifactId={activeArtifactId}
        agentDrawingArtifactIds={agentDrawingArtifactIds}
        agentDrawingArtifacts={agentDrawingArtifacts}
        agentDrawingsOpen={agentDrawingsOpen}
        designSystemHash={designSystemHash}
        draft={draft}
        editingId={editingId}
        grouped={grouped}
        selectedEmbeddedArtifactId={selectedEmbeddedArtifactId}
        selectedHtmlArtifactId={selectedHtmlArtifactId}
        t={t}
        onBeginRename={beginRename}
        onCommitRename={commitRename}
        onRemoveArtifact={removeArtifact}
        onSelectAgentDrawing={handleSelectAgentDrawing}
        onSetActiveArtifact={setActiveArtifact}
        setAgentDrawingsOpen={setAgentDrawingsOpen}
        setDraft={setDraft}
        setEditingId={setEditingId}
      />
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
    const snapshot = sameDesignWorkspace(root, workspaceRoot)
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
            disabled={modeSwitchLocked}
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
              <DesignSidebarWorkspaceTree
                activeDocumentId={activeDocumentId}
                collapsedFolders={collapsedFolders}
                collapsedWorkspaces={collapsedWorkspaces}
                docDraft={docDraft}
                documents={documents}
                draggingDocument={draggingDocument}
                dragOverFolderKey={dragOverFolderKey}
                drawingHistoryMutation={drawingHistoryMutation}
                editingDocId={editingDocId}
                moveDocumentId={moveDocumentId}
                navigationLocked={navigationLocked}
                resolvedDefaultWorkspaceRoot={resolvedDefaultWorkspaceRoot}
                t={t}
                workspaceFolders={workspaceFolders}
                workspaceIndexes={workspaceIndexes}
                workspaceRoot={workspaceRoot}
                workspaceRoots={knownWorkspaceRoots}
                onActivateWorkspace={activateWorkspace}
                onBeginRenameDocument={beginRenameDoc}
                onCommitRenameDocument={commitRenameDoc}
                onDeleteDocument={deleteDocumentInWorkspace}
                onDeleteFolder={deleteFolder}
                onDocumentIsRunning={documentIsRunning}
                onMoveDocumentToFolder={moveDocumentToFolder}
                onNewDocument={handleNewDocument}
                onOpenFolderDialog={openFolderDialog}
                onOpenMoveDocumentMenu={openMoveDocumentMenu}
                onRemoveWorkspace={handleRemoveWorkspace}
                onSelectDocument={handleSelectDocument}
                renderActiveDocumentContent={renderActiveDocBody}
                setCollapsedFolders={setCollapsedFolders}
                setCollapsedWorkspaces={setCollapsedWorkspaces}
                setDocDraft={setDocDraft}
                setDraggingDocument={setDraggingDocument}
                setDragOverFolderKey={setDragOverFolderKey}
                setEditingDocId={setEditingDocId}
              />
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
