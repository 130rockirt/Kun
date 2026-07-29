import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement
} from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  FolderOpen,
  Plus,
  Search
} from 'lucide-react'
import type { NormalizedThread } from '../../agent/types'
import { getProvider } from '../../agent/registry'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { rememberCodeWorkspaceRoots } from '../../store/chat-store-helpers'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import { deleteSddDraft } from '../../sdd/sdd-draft-actions'
import { listSddDraftHistory, type SddDraftHistoryItem } from '../../sdd/sdd-draft-history'
import { useSddDraftStore, type SddDraft } from '../../sdd/sdd-draft-store'
import {
  normalizeWorkspaceRoot,
  workspaceRootIdentityKey
} from '../../lib/workspace-path'
import {
  SidebarIconButton,
  SidebarSearchField,
  SidebarTreeRow
} from '../sidebar/SidebarPrimitives'
import { readThreadWorktreeRegistry } from '../../lib/thread-worktree-registry'
import {
  SddDraftHistoryRows,
  SidebarEmpty,
  ThreadRow
} from './SidebarProjectRows'
export { SddDraftHistoryRows, ThreadRow } from './SidebarProjectRows'
import {
  FolderContextMenu,
  MoveThreadDialog,
  SidebarActionDialog,
  SidebarFolderDialog,
  ThreadContextMenu,
  ThreadRenameDialog,
  WorkspaceContextMenu,
  type FolderContextMenuState,
  type MoveThreadDialogState,
  type RenameThreadDialogState,
  type SidebarActionDialogState,
  type SidebarFolderDialogState,
  type ThreadContextMenuState,
  type WorkspaceContextMenuState
} from './SidebarProjectOverlays'
export {
  MoveThreadDialog,
  sidebarOverlayPortalHost,
  SidebarActionDialog,
  ThreadRenameDialog
} from './SidebarProjectOverlays'
export type { RenameThreadDialogState } from './SidebarProjectOverlays'
import {
  buildSidebarDraftWorkspacePaths,
  buildSidebarThreadMoveTargets,
  buildSidebarWorkspaceGroups,
  filterEmptySddAssistantThreadsFromSidebar,
  filterSddDraftHistoryItems,
  isSidebarProjectWorkspacePath,
  mergeSidebarWorkspaceGroupsWithDraftHistory,
  sidebarWorkspacePathForThread,
  sidebarWorkspaceResolutionCandidates,
  sddDraftHistoryForWorkspace,
  sortSidebarThreads,
  worktreeRecordForSidebarThread,
  type SidebarThreadWorktreeRecord,
  type SidebarThreadWorktrees
} from './sidebar-project-selectors'
import {
  SIDEBAR_THREAD_DRAG_DATA_KEY,
  SIDEBAR_WORKSPACE_DRAG_DATA_KEY,
  readSidebarOrderRegistry,
  reconcileSidebarThreadOrder,
  reconcileSidebarWorkspaceOrder,
  reorderSidebarThreadIds,
  reorderSidebarWorkspacePaths,
  saveSidebarOrderRegistry,
  setSidebarThreadOrder,
  setSidebarWorkspaceOrder,
  sidebarDropPosition,
  sidebarThreadOrderScope,
  type SidebarDropPosition,
  type SidebarOrderRegistry
} from './sidebar-order'
import {
  isSidebarFolderCollapsed,
  isSidebarWorkspaceCollapsed,
  readSidebarCollapseRegistry,
  removeSidebarFolderCollapse,
  saveSidebarCollapseRegistry,
  setSidebarFolderCollapsed,
  setSidebarWorkspaceCollapsed,
  setSidebarWorkspacesCollapsed,
  type SidebarCollapseRegistry
} from './sidebar-collapse'
import {
  createSidebarFolder,
  deleteSidebarFolder,
  moveThreadToSidebarFolder,
  readSidebarFolderRegistry,
  removeSidebarThreadAssignments,
  renameSidebarFolder,
  saveSidebarFolderRegistry,
  sidebarChildFolders,
  sidebarFolderIdForThread,
  sidebarFolderNameExists,
  sidebarFolderThreadCount,
  sidebarFoldersForWorkspace,
  type SidebarFolderRegistry,
  type SidebarVirtualFolder
} from './sidebar-folders'
export {
  buildSidebarDraftWorkspacePaths,
  buildSidebarThreadMoveTargets,
  buildSidebarWorkspaceGroups,
  filterEmptySddAssistantThreadsFromSidebar,
  filterSddDraftHistoryItems,
  isSidebarThreadMoveBlocked,
  mergeSidebarWorkspaceGroupsWithDraftHistory,
  resolveThreadPreviewPosition,
  sortSidebarThreads
} from './sidebar-project-selectors'
export type { SidebarWorkspaceGroup } from './sidebar-project-selectors'

type SidebarProjectsSectionProps = {
  threads: NormalizedThread[]
  activeView: 'chat' | 'write' | 'claw'
  activeThreadId: string | null
  runtimeReady: boolean
  searchQuery: string
  showArchived: boolean
  workspaceRoot: string
  workspaceRoots: string[]
  /** 对话工作目录根,用于在项目区块中过滤掉对话会话。 */
  conversationRoot: string
  busy: boolean
  watchTurnCompletion: Record<string, boolean>
  unreadThreadIds: Record<string, boolean>
  locale: string
  onPickWorkspace: () => void
  onRemoveWorkspace: (workspacePath: string) => Promise<void>
  onCreateThreadInWorkspace: (
    workspacePath: string,
    options?: { forceNew?: boolean }
  ) => Promise<string | null>
  onOpenRequirementDraft: (draft: SddDraft) => void
  onSelectThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => Promise<void>
  onPinThread: (threadId: string, pinned: boolean) => Promise<void>
  onArchiveThread: (threadId: string) => Promise<void>
  onDeleteThread: (threadId: string) => Promise<void>
  onRestoreThread: (threadId: string) => Promise<void>
  onSearchQueryChange: (query: string) => void
  t: (k: string, opts?: Record<string, unknown>) => string
}

const SDD_DRAFT_HISTORY_LOAD_LIMIT = 40

type WorkspaceOrderDropTarget = {
  workspacePath: string
  position: SidebarDropPosition
}

type ThreadOrderDropTarget = WorkspaceOrderDropTarget & {
  threadId: string
  folderId: string | null
}

type FolderDropTarget = {
  workspacePath: string
  folderId: string
}

export function SidebarProjectsSection({
  threads,
  activeView,
  activeThreadId,
  runtimeReady,
  searchQuery,
  showArchived,
  workspaceRoot,
  workspaceRoots,
  conversationRoot,
  busy,
  watchTurnCompletion,
  unreadThreadIds,
  locale,
  onPickWorkspace,
  onRemoveWorkspace,
  onCreateThreadInWorkspace,
  onOpenRequirementDraft,
  onSelectThread,
  onRenameThread,
  onPinThread,
  onArchiveThread,
  onDeleteThread,
  onRestoreThread,
  onSearchQueryChange,
  t
}: SidebarProjectsSectionProps): ReactElement {
  const [sidebarCollapse, setSidebarCollapse] = useState<SidebarCollapseRegistry>(
    () => readSidebarCollapseRegistry()
  )
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({})
  const [deletingThreadIds, setDeletingThreadIds] = useState<Record<string, boolean>>({})
  const [deletingDraftIds, setDeletingDraftIds] = useState<Record<string, boolean>>({})
  const [draftHistoryErrors, setDraftHistoryErrors] = useState<Record<string, string>>({})
  const [draftHistoryRefreshVersion, setDraftHistoryRefreshVersion] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenuState | null>(null)
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenuState | null>(null)
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState | null>(null)
  const [actionDialog, setActionDialog] = useState<SidebarActionDialogState | null>(null)
  const [renameThreadDialog, setRenameThreadDialog] = useState<RenameThreadDialogState | null>(null)
  const [moveThreadDialog, setMoveThreadDialog] = useState<MoveThreadDialogState | null>(null)
  const [folderDialog, setFolderDialog] = useState<SidebarFolderDialogState | null>(null)
  const [sidebarOrder, setSidebarOrder] = useState<SidebarOrderRegistry>(() => readSidebarOrderRegistry())
  const [sidebarFolders, setSidebarFolders] = useState<SidebarFolderRegistry>(() => readSidebarFolderRegistry())
  const [draggingWorkspacePath, setDraggingWorkspacePath] = useState<string | null>(null)
  const [workspaceOrderDropTarget, setWorkspaceOrderDropTarget] = useState<WorkspaceOrderDropTarget | null>(null)
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null)
  const [threadOrderDropTarget, setThreadOrderDropTarget] = useState<ThreadOrderDropTarget | null>(null)
  const [dragOverWorkspace, setDragOverWorkspace] = useState<string | null>(null)
  const [folderDropTarget, setFolderDropTarget] = useState<FolderDropTarget | null>(null)
  const [draftHistoryByWorkspace, setDraftHistoryByWorkspace] = useState<Record<string, SddDraftHistoryItem[]>>({})
  const [threadWorktrees, setThreadWorktrees] = useState<SidebarThreadWorktrees>(() => readThreadWorktreeRegistry().worktrees)
  const activeSddDraftId = useSddDraftStore((s) => s.activeDraft?.id ?? '')

  useEffect(() => {
    setThreadWorktrees(readThreadWorktreeRegistry().worktrees)
  }, [activeThreadId, threads, workspaceRoots])

  const groups = useMemo(() => {
    return buildSidebarWorkspaceGroups({
      threads,
      searchQuery,
      showArchived,
      workspaceRoot,
      workspaceRoots,
      conversationRoot,
      threadWorktrees
    })
  }, [searchQuery, showArchived, threadWorktrees, threads, workspaceRoot, workspaceRoots, conversationRoot])

  const draftHistoryWorkspacePaths = useMemo(() => {
    return buildSidebarDraftWorkspacePaths({
      threads,
      workspaceRoot,
      workspaceRoots,
      threadWorktrees
    })
  }, [threadWorktrees, threads, workspaceRoot, workspaceRoots])

  const allProjectGroups = useMemo(() => {
    const byWorkspace = new Map<string, [string, NormalizedThread[]]>()
    for (const archived of [false, true]) {
      const nextGroups = buildSidebarWorkspaceGroups({
        threads,
        searchQuery: '',
        showArchived: archived,
        workspaceRoot,
        workspaceRoots,
        conversationRoot,
        threadWorktrees
      })
      for (const [workspacePath, items] of nextGroups) {
        const key = workspaceRootIdentityKey(workspacePath)
        const existing = byWorkspace.get(key)
        if (existing) existing[1].push(...items)
        else byWorkspace.set(key, [workspacePath, [...items]])
      }
    }
    return [...byWorkspace.values()]
  }, [conversationRoot, threadWorktrees, threads, workspaceRoot, workspaceRoots])

  const allThreadIdsByScope = useMemo(() => {
    return Object.fromEntries(allProjectGroups.map(([workspacePath, items]) => [
      sidebarThreadOrderScope(workspacePath),
      sortSidebarThreads(items).map((thread) => thread.id)
    ]))
  }, [allProjectGroups])

  const filteredDraftHistoryByWorkspace = useMemo(() => {
    return Object.fromEntries(
      Object.entries(draftHistoryByWorkspace)
        .map(([path, history]) => [
          path,
          filterSddDraftHistoryItems(history, searchQuery, path)
        ] as const)
        .filter(([, history]) => history.length > 0)
    )
  }, [draftHistoryByWorkspace, searchQuery])

  const unorderedDisplayGroups = useMemo(() => {
    return mergeSidebarWorkspaceGroupsWithDraftHistory({
      groups,
      draftHistoryByWorkspace: filteredDraftHistoryByWorkspace,
      workspaceRoot
    })
  }, [filteredDraftHistoryByWorkspace, groups, workspaceRoot])

  const displayGroups = useMemo(() => {
    const byWorkspace = new Map(
      unorderedDisplayGroups.map((group) => [workspaceRootIdentityKey(group[0]), group] as const)
    )
    return reconcileSidebarWorkspaceOrder(
      unorderedDisplayGroups.map(([workspacePath]) => workspacePath),
      sidebarOrder.workspacePaths
    ).flatMap((workspacePath) => {
      const group = byWorkspace.get(workspaceRootIdentityKey(workspacePath))
      return group ? [group] : []
    })
  }, [sidebarOrder.workspacePaths, unorderedDisplayGroups])

  const workspacePathsForOrder = useMemo(() => reconcileSidebarWorkspaceOrder(
    [
      ...allProjectGroups.map(([workspacePath]) => workspacePath),
      ...unorderedDisplayGroups.map(([workspacePath]) => workspacePath)
    ],
    sidebarOrder.workspacePaths
  ), [allProjectGroups, sidebarOrder.workspacePaths, unorderedDisplayGroups])

  const searchVisible = searchOpen || searchQuery.trim().length > 0
  const allGroupsCollapsed = displayGroups.length > 0 && displayGroups.every(([workspacePath]) =>
    isSidebarWorkspaceCollapsed(sidebarCollapse, workspacePath)
  )
  const workspaceHistoryKey = draftHistoryWorkspacePaths.join('\n')
  const projectWorkspaceGroups = displayGroups.filter(([workspacePath]) => isSidebarProjectWorkspacePath(workspacePath))

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.kunGui?.listWorkspaceDirectory !== 'function' ||
      typeof window.kunGui?.readWorkspaceFile !== 'function'
    ) {
      setDraftHistoryByWorkspace({})
      return
    }
    const workspacePaths = workspaceHistoryKey.split('\n').filter(Boolean)
    if (workspacePaths.length === 0) {
      setDraftHistoryByWorkspace({})
      return
    }
    let cancelled = false
    void Promise.all(
      workspacePaths.map(async (path) => {
        const history = await listSddDraftHistory({
          workspaceRoot: path,
          listWorkspaceDirectory: window.kunGui.listWorkspaceDirectory,
          readWorkspaceFile: window.kunGui.readWorkspaceFile,
          limit: SDD_DRAFT_HISTORY_LOAD_LIMIT
        }).catch(() => [])
        return [path, history] as const
      })
    ).then((entries) => {
      if (cancelled) return
      setDraftHistoryByWorkspace(Object.fromEntries(entries.filter(([, history]) => history.length > 0)))
    })
    return () => {
      cancelled = true
    }
  }, [draftHistoryRefreshVersion, workspaceHistoryKey])

  useEffect(() => {
    if (!threadContextMenu && !workspaceContextMenu && !folderContextMenu) return
    const close = (): void => {
      setThreadContextMenu(null)
      setWorkspaceContextMenu(null)
      setFolderContextMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [folderContextMenu, threadContextMenu, workspaceContextMenu])

  const toggleAllGroups = (): void => {
    if (displayGroups.length === 0) return
    persistSidebarCollapse((current) => setSidebarWorkspacesCollapsed(
      current,
      displayGroups.map(([workspacePath]) => workspacePath),
      !allGroupsCollapsed
    ))
  }

  const openActionDialog = (dialog: Omit<SidebarActionDialogState, 'submitting'>): void => {
    setActionDialog({ ...dialog, submitting: false })
  }

  const closeActionDialog = (): void => {
    setActionDialog((current) => current?.submitting ? current : null)
  }

  const submitActionDialog = async (): Promise<void> => {
    const dialog = actionDialog
    if (!dialog || dialog.submitting) return
    setActionDialog((current) => current ? { ...current, submitting: true } : current)
    try {
      await dialog.onConfirm()
      setActionDialog(null)
    } catch {
      setActionDialog((current) => current ? { ...current, submitting: false } : current)
    }
  }

  const handleDeleteThread = async (thread: NormalizedThread): Promise<void> => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    openActionDialog({
      title: t('sidebarThreadDeleteDialogTitle', { title: thread.title }),
      description: t('sidebarThreadDeleteDialogDescription'),
      detail: t('sidebarThreadDeleteDialogDetail'),
      confirmLabel: t('sidebarThreadDeleteConfirmButton'),
      danger: true,
      onConfirm: async () => {
        setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
        try {
          await onDeleteThread(threadId)
          persistSidebarFolders((current) => removeSidebarThreadAssignments(current, [threadId]))
        } finally {
          setDeletingThreadIds((prev) => {
            const next = { ...prev }
            delete next[threadId]
            return next
          })
        }
      }
    })
  }

  const handleArchiveThread = async (thread: NormalizedThread): Promise<void> => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    openActionDialog({
      title: t('sidebarThreadArchiveDialogTitle', { title: thread.title }),
      description: t('sidebarThreadArchiveDialogDescription'),
      detail: t('sidebarThreadArchiveDialogDetail'),
      confirmLabel: t('sidebarThreadArchiveConfirmButton'),
      onConfirm: async () => {
        setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
        try {
          await onArchiveThread(threadId)
        } finally {
          setDeletingThreadIds((prev) => {
            const next = { ...prev }
            delete next[threadId]
            return next
          })
        }
      }
    })
  }

  const handleSummarizeThread = async (thread: NormalizedThread): Promise<void> => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
    try {
      const res = await rendererRuntimeClient.runtimeRequest(
        `/v1/threads/${encodeURIComponent(threadId)}/summarize`,
        'POST',
        '{}'
      )
      if (!res.ok) {
        useChatStore.getState().setError(t('summarizeFailed'))
        return
      }
      // The summary now lives on the thread; refresh the list so the new
      // subtitle/hover text is picked up from the thread-list projection.
      await useChatStore.getState().refreshThreads()
    } catch {
      useChatStore.getState().setError(t('summarizeFailed'))
    } finally {
      setDeletingThreadIds((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
    }
  }

  const handleRestoreThread = async (thread: NormalizedThread): Promise<void> => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
    try {
      await onRestoreThread(threadId)
    } finally {
      setDeletingThreadIds((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
    }
  }

  const handlePinThread = async (thread: NormalizedThread, pinned: boolean): Promise<void> => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
    try {
      await onPinThread(threadId, pinned)
    } finally {
      setDeletingThreadIds((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
    }
  }

  const openRenameThreadDialog = (thread: NormalizedThread): void => {
    const threadId = thread.id.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    setRenameThreadDialog({
      thread,
      value: thread.title,
      submitting: false
    })
  }

  const closeRenameThreadDialog = (): void => {
    setRenameThreadDialog((current) => current?.submitting ? current : null)
  }

  const submitRenameThreadDialog = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const dialog = renameThreadDialog
    if (!dialog || dialog.submitting) return
    const threadId = dialog.thread.id.trim()
    const nextTitle = dialog.value.trim()
    if (!threadId || deletingThreadIds[threadId]) return
    if (!nextTitle) return
    if (nextTitle === dialog.thread.title) {
      setRenameThreadDialog(null)
      return
    }
    setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
    setRenameThreadDialog((current) =>
      current?.thread.id === threadId ? { ...current, value: nextTitle, submitting: true } : current
    )
    try {
      await onRenameThread(threadId, nextTitle)
      setRenameThreadDialog(null)
    } catch {
      setRenameThreadDialog((current) =>
        current?.thread.id === threadId ? { ...current, submitting: false } : current
      )
    } finally {
      setDeletingThreadIds((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
    }
  }

  const moveTargetsForThread = (thread: NormalizedThread): string[] => {
    return buildSidebarThreadMoveTargets({
      thread,
      groups: projectWorkspaceGroups,
      threadWorktrees
    })
  }

  const threadMoveDisabledReason = (
    thread: NormalizedThread,
    worktreeRecord?: SidebarThreadWorktreeRecord
  ): string => {
    if (!thread.id.trim()) return t('sidebarThreadMoveUnsupported')
    if (deletingThreadIds[thread.id] === true) return t('loading')
    if (worktreeRecord) return t('sidebarThreadMoveWorktreeBlocked')
    if (thread.status?.trim().toLowerCase() === 'running') return t('sidebarThreadMoveRunningBlocked')
    if (watchTurnCompletion[thread.id] === true) return t('sidebarThreadMoveRunningBlocked')
    if (activeThreadId === thread.id && busy) return t('sidebarThreadMoveRunningBlocked')
    if (typeof getProvider().updateThreadWorkspace !== 'function') return t('sidebarThreadMoveUnsupported')
    return ''
  }

  const moveThreadToWorkspace = async (
    thread: NormalizedThread,
    targetWorkspace: string
  ): Promise<void> => {
    const threadId = thread.id.trim()
    const normalizedTarget = normalizeWorkspaceRoot(targetWorkspace)
    if (!threadId || !normalizedTarget) return
    const provider = getProvider()
    if (typeof provider.updateThreadWorkspace !== 'function') {
      throw new Error(t('sidebarThreadMoveUnsupported'))
    }
    setDeletingThreadIds((prev) => ({ ...prev, [threadId]: true }))
    try {
      await provider.updateThreadWorkspace(threadId, normalizedTarget)
      persistSidebarFolders((current) => removeSidebarThreadAssignments(current, [threadId]))
      useChatStore.setState((state) => ({
        codeWorkspaceRoots: rememberCodeWorkspaceRoots(state.codeWorkspaceRoots, [normalizedTarget]),
        threads: state.threads.map((item) =>
          item.id === threadId ? { ...item, workspace: normalizedTarget } : item
        )
      }))
      await useChatStore.getState().refreshThreads()
      setMoveThreadDialog(null)
      setThreadContextMenu(null)
      setDragOverWorkspace(null)
    } finally {
      setDeletingThreadIds((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
    }
  }

  const confirmThreadWorkspaceMove = (
    thread: NormalizedThread,
    targetWorkspace: string,
    worktreeRecord?: SidebarThreadWorktreeRecord
  ): void => {
    if (threadMoveDisabledReason(thread, worktreeRecord)) return
    const normalizedTarget = normalizeWorkspaceRoot(targetWorkspace)
    if (!normalizedTarget) return
    const currentWorkspaceKey = workspaceRootIdentityKey(
      sidebarWorkspacePathForThread(thread, threadWorktrees, projectWorkspaceGroups.map(([workspacePath]) => workspacePath))
    )
    if (!currentWorkspaceKey || workspaceRootIdentityKey(normalizedTarget) === currentWorkspaceKey) return
    setMoveThreadDialog({
      thread,
      targets: moveTargetsForThread(thread),
      targetWorkspace: normalizedTarget,
      submitting: false,
      error: ''
    })
  }

  const openMoveThreadDialog = (
    thread: NormalizedThread,
    worktreeRecord?: SidebarThreadWorktreeRecord
  ): void => {
    if (busy || threadMoveDisabledReason(thread, worktreeRecord)) return
    setMoveThreadDialog({
      thread,
      targets: moveTargetsForThread(thread),
      targetWorkspace: null,
      submitting: false,
      error: ''
    })
    setThreadContextMenu(null)
  }

  const closeMoveThreadDialog = (): void => {
    setMoveThreadDialog((current) => current?.submitting ? current : null)
  }

  const submitMoveThreadDialog = async (): Promise<void> => {
    const dialog = moveThreadDialog
    if (!dialog || !dialog.targetWorkspace || dialog.submitting) return
    setMoveThreadDialog((current) => current ? { ...current, submitting: true } : current)
    try {
      await moveThreadToWorkspace(dialog.thread, dialog.targetWorkspace)
    } catch (error) {
      setMoveThreadDialog((current) =>
        current
          ? {
              ...current,
              submitting: false,
              error: error instanceof Error && error.message.trim()
                ? error.message
                : t('sidebarThreadMoveFailed')
            }
          : current
      )
    }
  }

  const persistSidebarOrder = (
    update: (current: SidebarOrderRegistry) => SidebarOrderRegistry
  ): void => {
    const next = update(readSidebarOrderRegistry())
    saveSidebarOrderRegistry(next)
    setSidebarOrder(next)
  }

  const persistSidebarFolders = (
    update: (current: SidebarFolderRegistry) => SidebarFolderRegistry
  ): void => {
    const next = update(readSidebarFolderRegistry())
    saveSidebarFolderRegistry(next)
    setSidebarFolders(next)
  }

  const persistSidebarCollapse = (
    update: (current: SidebarCollapseRegistry) => SidebarCollapseRegistry
  ): void => {
    const next = update(readSidebarCollapseRegistry())
    saveSidebarCollapseRegistry(next)
    setSidebarCollapse(next)
  }

  const openCreateFolderDialog = (
    workspacePath: string,
    parentId: string | null = null
  ): void => {
    setFolderDialog({
      mode: 'create',
      workspacePath,
      parentId,
      value: ''
    })
    setWorkspaceContextMenu(null)
    setFolderContextMenu(null)
  }

  const openRenameFolderDialog = (
    workspacePath: string,
    folder: SidebarVirtualFolder
  ): void => {
    setFolderDialog({
      mode: 'rename',
      workspacePath,
      folder,
      value: folder.name
    })
    setFolderContextMenu(null)
  }

  const submitFolderDialog = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const dialog = folderDialog
    const name = dialog?.value.trim() ?? ''
    if (!dialog || !name) return
    const folders = sidebarFoldersForWorkspace(sidebarFolders, dialog.workspacePath)
    const parentId = dialog.mode === 'create'
      ? dialog.parentId ?? null
      : dialog.folder?.parentId ?? null
    if (sidebarFolderNameExists(folders, name, dialog.folder?.id, parentId)) {
      setFolderDialog((current) => current ? {
        ...current,
        value: name,
        error: t('sidebarFolderNameExists')
      } : current)
      return
    }
    if (dialog.mode === 'create') {
      const folderId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      persistSidebarFolders((current) =>
        createSidebarFolder(current, dialog.workspacePath, {
          id: folderId,
          name,
          parentId
        })
      )
    } else if (dialog.folder) {
      persistSidebarFolders((current) =>
        renameSidebarFolder(current, dialog.workspacePath, dialog.folder?.id ?? '', name)
      )
    }
    setFolderDialog(null)
  }

  const handleCreateThreadInFolder = async (
    workspacePath: string,
    folderId: string
  ): Promise<void> => {
    persistSidebarCollapse((current) =>
      setSidebarFolderCollapsed(current, workspacePath, folderId, false)
    )
    const threadId = await onCreateThreadInWorkspace(workspacePath, { forceNew: true })
    if (!threadId) return
    persistSidebarFolders((current) =>
      moveThreadToSidebarFolder(current, workspacePath, threadId, folderId)
    )
  }

  const handleDeleteFolder = (
    workspacePath: string,
    folder: SidebarVirtualFolder
  ): void => {
    openActionDialog({
      title: t('sidebarFolderDeleteDialogTitle', { name: folder.name }),
      description: t('sidebarFolderDeleteDialogDescription'),
      detail: t('sidebarFolderDeleteDialogDetail', { count: folder.threadIds.length }),
      confirmLabel: t('sidebarFolderDeleteConfirmButton'),
      danger: true,
      onConfirm: async () => {
        persistSidebarFolders((current) =>
          deleteSidebarFolder(current, workspacePath, folder.id)
        )
        persistSidebarCollapse((current) =>
          removeSidebarFolderCollapse(current, workspacePath, folder.id)
        )
      }
    })
    setFolderContextMenu(null)
  }

  const handleWorkspaceDragStart = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string
  ): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(SIDEBAR_WORKSPACE_DRAG_DATA_KEY, workspacePath)
    setDraggingWorkspacePath(workspacePath)
    setWorkspaceOrderDropTarget(null)
    setDraggingThreadId(null)
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleWorkspaceDragEnd = (): void => {
    setDraggingWorkspacePath(null)
    setWorkspaceOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleThreadDragStart = (
    event: ReactDragEvent<HTMLDivElement>,
    thread: NormalizedThread
  ): void => {
    if (!thread.id.trim() || deletingThreadIds[thread.id] === true) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(SIDEBAR_THREAD_DRAG_DATA_KEY, thread.id)
    setDraggingThreadId(thread.id)
    setThreadOrderDropTarget(null)
    setDraggingWorkspacePath(null)
    setWorkspaceOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleThreadDragEnd = (): void => {
    setDraggingThreadId(null)
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleWorkspaceDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string
  ): void => {
    const sourceWorkspacePath = draggingWorkspacePath || event.dataTransfer.getData(SIDEBAR_WORKSPACE_DRAG_DATA_KEY)
    if (sourceWorkspacePath) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverWorkspace(null)
      setWorkspaceOrderDropTarget(
        workspaceRootIdentityKey(sourceWorkspacePath) === workspaceRootIdentityKey(workspacePath)
          ? null
          : {
              workspacePath,
              position: sidebarDropPosition(
                event.clientY,
                event.currentTarget.getBoundingClientRect().top,
                event.currentTarget.getBoundingClientRect().height
              )
            }
      )
      return
    }
    const threadId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    if (!threadId) return
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(thread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) === workspaceRootIdentityKey(workspacePath)) {
      const folders = sidebarFoldersForWorkspace(sidebarFolders, workspacePath)
      if (!sidebarFolderIdForThread(folders, threadId)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setWorkspaceOrderDropTarget(null)
      setFolderDropTarget(null)
      setDragOverWorkspace(workspacePath)
      return
    }
    const worktreeRecord = worktreeRecordForSidebarThread(thread, threadWorktrees)
    if (threadMoveDisabledReason(thread, worktreeRecord)) return
    const targets = moveTargetsForThread(thread)
    if (!targets.some((target) => workspaceRootIdentityKey(target) === workspaceRootIdentityKey(workspacePath))) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setWorkspaceOrderDropTarget(null)
    setFolderDropTarget(null)
    setDragOverWorkspace(workspacePath)
  }

  const handleWorkspaceDragLeave = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string
  ): void => {
    if (
      event.relatedTarget instanceof Node
      && event.currentTarget.contains(event.relatedTarget)
    ) return
    setWorkspaceOrderDropTarget((current) =>
      current && workspaceRootIdentityKey(current.workspacePath) === workspaceRootIdentityKey(workspacePath)
        ? null
        : current
    )
    setDragOverWorkspace((current) =>
      workspaceRootIdentityKey(current ?? undefined) === workspaceRootIdentityKey(workspacePath)
        ? null
        : current
    )
  }

  const handleWorkspaceDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string
  ): void => {
    event.preventDefault()
    const sourceWorkspacePath = draggingWorkspacePath || event.dataTransfer.getData(SIDEBAR_WORKSPACE_DRAG_DATA_KEY)
    if (sourceWorkspacePath) {
      const rect = event.currentTarget.getBoundingClientRect()
      const nextWorkspacePaths = reorderSidebarWorkspacePaths({
        workspacePaths: workspacePathsForOrder,
        sourcePath: sourceWorkspacePath,
        targetPath: workspacePath,
        position: sidebarDropPosition(event.clientY, rect.top, rect.height)
      })
      persistSidebarOrder((current) => setSidebarWorkspaceOrder(current, nextWorkspacePaths))
      setDraggingWorkspacePath(null)
      setWorkspaceOrderDropTarget(null)
      setDragOverWorkspace(null)
      setFolderDropTarget(null)
      return
    }
    const threadId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    setDraggingThreadId(null)
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
    if (!threadId) return
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(thread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) === workspaceRootIdentityKey(workspacePath)) {
      persistSidebarFolders((current) =>
        moveThreadToSidebarFolder(current, workspacePath, threadId, null)
      )
      return
    }
    confirmThreadWorkspaceMove(
      thread,
      workspacePath,
      worktreeRecordForSidebarThread(thread, threadWorktrees)
    )
  }

  const handleThreadDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    targetThread: NormalizedThread,
    workspacePath: string,
    folderId: string | null
  ): void => {
    const sourceId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    if (!sourceId || sourceId === targetThread.id) return
    const sourceThread = threads.find((thread) => thread.id === sourceId)
    if (!sourceThread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(sourceThread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) !== workspaceRootIdentityKey(workspacePath)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setThreadOrderDropTarget({
      workspacePath,
      threadId: targetThread.id,
      folderId,
      position: sidebarDropPosition(event.clientY, rect.top, rect.height)
    })
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleThreadDragLeave = (
    event: ReactDragEvent<HTMLDivElement>,
    threadId: string
  ): void => {
    if (
      event.relatedTarget instanceof Node
      && event.currentTarget.contains(event.relatedTarget)
    ) return
    setThreadOrderDropTarget((current) => current?.threadId === threadId ? null : current)
  }

  const handleThreadDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    targetThread: NormalizedThread,
    workspacePath: string,
    folderId: string | null
  ): void => {
    const sourceId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    if (!sourceId || sourceId === targetThread.id) return
    const sourceThread = threads.find((thread) => thread.id === sourceId)
    if (!sourceThread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(sourceThread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) !== workspaceRootIdentityKey(workspacePath)) return
    event.preventDefault()
    event.stopPropagation()
    const position = sidebarDropPosition(
      event.clientY,
      event.currentTarget.getBoundingClientRect().top,
      event.currentTarget.getBoundingClientRect().height
    )
    persistSidebarFolders((current) =>
      moveThreadToSidebarFolder(
        current,
        workspacePath,
        sourceId,
        folderId,
        targetThread.id,
        position
      )
    )
    if (folderId) {
      setDraggingThreadId(null)
      setThreadOrderDropTarget(null)
      setDragOverWorkspace(null)
      setFolderDropTarget(null)
      return
    }
    const scope = sidebarThreadOrderScope(workspacePath)
    const baseIds = allThreadIdsByScope[scope] ?? []
    const orderedIds = reconcileSidebarThreadOrder(
      baseIds.map((id) => ({ id })),
      sidebarOrder.threadIdsByScope[scope] ?? []
    ).map(({ id }) => id)
    const nextIds = reorderSidebarThreadIds({
      threadIds: orderedIds,
      sourceId,
      targetId: targetThread.id,
      position
    })
    persistSidebarOrder((current) => setSidebarThreadOrder(current, workspacePath, nextIds))
    setDraggingThreadId(null)
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const handleFolderDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string,
    folderId: string
  ): void => {
    const threadId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    if (!threadId) return
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(thread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) !== workspaceRootIdentityKey(workspacePath)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget({ workspacePath, folderId })
  }

  const handleFolderDragLeave = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string,
    folderId: string
  ): void => {
    if (
      event.relatedTarget instanceof Node
      && event.currentTarget.contains(event.relatedTarget)
    ) return
    setFolderDropTarget((current) =>
      current
      && current.folderId === folderId
      && workspaceRootIdentityKey(current.workspacePath) === workspaceRootIdentityKey(workspacePath)
        ? null
        : current
    )
  }

  const handleFolderDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    workspacePath: string,
    folderId: string
  ): void => {
    const threadId = draggingThreadId || event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_DATA_KEY)
    if (!threadId) return
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    const candidatePaths = allProjectGroups.map(([path]) => path)
    const sourceWorkspace = sidebarWorkspacePathForThread(thread, threadWorktrees, candidatePaths)
    if (workspaceRootIdentityKey(sourceWorkspace) !== workspaceRootIdentityKey(workspacePath)) return
    event.preventDefault()
    event.stopPropagation()
    persistSidebarFolders((current) =>
      moveThreadToSidebarFolder(current, workspacePath, threadId, folderId)
    )
    persistSidebarCollapse((current) =>
      setSidebarFolderCollapsed(current, workspacePath, folderId, false)
    )
    setDraggingThreadId(null)
    setThreadOrderDropTarget(null)
    setDragOverWorkspace(null)
    setFolderDropTarget(null)
  }

  const openThreadContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    thread: NormalizedThread
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    const worktreeRecord = worktreeRecordForSidebarThread(thread, threadWorktrees)
    setWorkspaceContextMenu(null)
    setFolderContextMenu(null)
    setThreadContextMenu({
      thread,
      ...(worktreeRecord ? { worktreeRecord } : {}),
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 220)
    })
  }

  const openWorkspaceContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    workspacePath: string
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setThreadContextMenu(null)
    setFolderContextMenu(null)
    setWorkspaceContextMenu({
      workspacePath,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 210)
    })
  }

  const openFolderContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    workspacePath: string,
    folder: SidebarVirtualFolder
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setThreadContextMenu(null)
    setWorkspaceContextMenu(null)
    setFolderContextMenu({
      workspacePath,
      folder,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 130)
    })
  }

  // Thread hover preview card removed: it showed no useful content. Keep no-op
  // handlers so row hover wiring stays intact without rendering a popup.
  const openThreadPreview = (): void => {}

  const closeThreadPreview = (): void => {}

  const openWorkspaceInSystem = async (workspacePath: string): Promise<void> => {
    if (typeof window === 'undefined' || typeof window.kunGui?.openEditorPath !== 'function') return
    await window.kunGui.openEditorPath({
      path: workspacePath,
      workspaceRoot: workspacePath,
      editorId: 'system'
    }).catch(() => undefined)
  }

  const handleRemoveWorkspace = async (workspacePath: string): Promise<void> => {
    openActionDialog({
      title: t('sidebarWorkspaceRemoveDialogTitle', { name: workspaceLabelFromPath(workspacePath) }),
      description: t('sidebarWorkspaceRemoveDialogDescription'),
      detail: t('sidebarWorkspaceRemoveDialogDetail'),
      confirmLabel: t('sidebarWorkspaceRemoveConfirmButton'),
      danger: true,
      onConfirm: () => onRemoveWorkspace(workspacePath)
    })
  }

  const archivableWorkspaceThreads = (workspacePath: string): NormalizedThread[] => {
    const targetKey = workspaceRootIdentityKey(workspacePath)
    if (!targetKey) return []
    const candidateProjectPaths = sidebarWorkspaceResolutionCandidates({
      workspaceRoot,
      workspaceRoots,
      threadWorktrees,
      threads
    })
    return threads.filter((thread) =>
      thread.archived !== true &&
      workspaceRootIdentityKey(
        sidebarWorkspacePathForThread(thread, threadWorktrees, candidateProjectPaths)
      ) === targetKey
    )
  }

  const handleArchiveWorkspaceThreads = async (workspacePath: string): Promise<void> => {
    const targets = archivableWorkspaceThreads(workspacePath)
    if (targets.length === 0) return
    openActionDialog({
      title: t('sidebarWorkspaceArchiveDialogTitle', { name: workspaceLabelFromPath(workspacePath) }),
      description: t('sidebarWorkspaceArchiveDialogDescription', { count: targets.length }),
      detail: t('sidebarWorkspaceArchiveDialogDetail'),
      confirmLabel: t('sidebarWorkspaceArchiveConfirmButton'),
      onConfirm: async () => {
        const latestTargets = archivableWorkspaceThreads(workspacePath)
        const targetIds = latestTargets.map((thread) => thread.id.trim()).filter(Boolean)
        if (targetIds.length === 0) return
        setDeletingThreadIds((prev) => ({
          ...prev,
          ...Object.fromEntries(targetIds.map((threadId) => [threadId, true]))
        }))
        try {
          for (const threadId of targetIds) {
            await onArchiveThread(threadId)
          }
        } finally {
          setDeletingThreadIds((prev) => {
            const next = { ...prev }
            for (const threadId of targetIds) {
              delete next[threadId]
            }
            return next
          })
        }
      }
    })
  }

  const handleDeleteRequirementDraft = async (draft: SddDraftHistoryItem): Promise<void> => {
    const draftId = draft.id.trim()
    if (!draftId || deletingDraftIds[draftId]) return
    const workspaceKey = draft.workspaceRoot
    openActionDialog({
      title: t('sddDraftHistoryDeleteDialogTitle', { title: draft.title }),
      description: t('sddDraftHistoryDeleteDialogDescription'),
      detail: t('sddDraftHistoryDeleteDialogDetail'),
      confirmLabel: t('sddDraftHistoryDelete'),
      danger: true,
      onConfirm: async () => {
        setDeletingDraftIds((prev) => ({ ...prev, [draftId]: true }))
        setDraftHistoryErrors((prev) => {
          const next = { ...prev }
          delete next[workspaceKey]
          return next
        })
        try {
          const result = await deleteSddDraft(draft)
          if (!result.ok) {
            setDraftHistoryErrors((prev) => ({
              ...prev,
              [workspaceKey]: t('sddDraftHistoryDeleteFailed', { message: result.message })
            }))
            return
          }
          setDraftHistoryByWorkspace((current) => {
            const next = Object.fromEntries(
              Object.entries(current)
                .map(([workspacePath, items]) => [
                  workspacePath,
                  items.filter((item) => item.id !== draftId)
                ] as const)
                .filter(([, items]) => items.length > 0)
            )
            return next
          })
          setDraftHistoryRefreshVersion((version) => version + 1)
        } finally {
          setDeletingDraftIds((prev) => {
            const next = { ...prev }
            delete next[draftId]
            return next
          })
        }
      }
    })
  }

  const renderThreadRow = (
    thread: NormalizedThread,
    workspacePath: string,
    folderId: string | null
  ): ReactElement => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      worktreeRecord={worktreeRecordForSidebarThread(thread, threadWorktrees)}
      active={(activeView === 'chat' || activeView === 'write') && activeThreadId === thread.id}
      deleting={deletingThreadIds[thread.id] === true}
      locale={locale}
      showRunning={
        thread.status?.trim().toLowerCase() === 'running' ||
        (activeThreadId === thread.id && busy) ||
        watchTurnCompletion[thread.id] === true
      }
      showUnread={
        unreadThreadIds[thread.id] === true && activeThreadId !== thread.id
      }
      onSelect={() => onSelectThread(thread.id)}
      onContextMenu={(event) => openThreadContextMenu(event, thread)}
      onPreviewOpen={openThreadPreview}
      onPreviewClose={closeThreadPreview}
      draggable={deletingThreadIds[thread.id] !== true}
      dragging={draggingThreadId === thread.id}
      dropPosition={
        threadOrderDropTarget?.threadId === thread.id
        && threadOrderDropTarget.folderId === folderId
        && workspaceRootIdentityKey(threadOrderDropTarget.workspacePath) === workspaceRootIdentityKey(workspacePath)
          ? threadOrderDropTarget.position
          : null
      }
      onDragStart={(event) => handleThreadDragStart(event, thread)}
      onDragEnd={handleThreadDragEnd}
      onDragOver={(event) => handleThreadDragOver(event, thread, workspacePath, folderId)}
      onDragLeave={(event) => handleThreadDragLeave(event, thread.id)}
      onDrop={(event) => handleThreadDrop(event, thread, workspacePath, folderId)}
      onPin={() => void handlePinThread(thread, thread.pinned !== true)}
      onRename={() => openRenameThreadDialog(thread)}
      onArchive={() => void handleArchiveThread(thread)}
      onDelete={() => void handleDeleteThread(thread)}
      onRestore={() => void handleRestoreThread(thread)}
    />
  )

  return (
    <div className="ds-no-drag flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[38px] items-center justify-between px-2 pb-1.5 pt-3">
        <button
          type="button"
          onClick={toggleAllGroups}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-muted"
          title={t('sidebarProjects')}
          aria-label={t('sidebarProjects')}
        >
          <span className="truncate">{t('sidebarProjects')}</span>
          {allGroupsCollapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <SidebarIconButton
            onClick={() => setSearchOpen((open) => !open)}
            active={searchVisible}
            className="h-7 w-7"
            title={t('sidebarSearchThreads')}
            ariaLabel={t('sidebarSearchThreads')}
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.85} />
          </SidebarIconButton>
          <SidebarIconButton
            onClick={onPickWorkspace}
            className="h-7 w-7"
            title={workspaceRoot ? t('changeWorkspace') : t('selectWorkspace')}
            ariaLabel={workspaceRoot ? t('changeWorkspace') : t('selectWorkspace')}
          >
            <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </SidebarIconButton>
        </div>
      </div>

      {searchVisible ? (
        <div className="mb-2 flex items-center gap-1 px-2">
          <SidebarSearchField
            value={searchQuery}
            onChange={onSearchQueryChange}
            placeholder={t('sidebarSearchThreads')}
            clearLabel={t('clear')}
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-0.5">
        {displayGroups.length === 0 ? (
          <SidebarEmpty
            runtimeReady={runtimeReady}
            hasWorkspace={!!workspaceRoot}
            onPickWorkspace={onPickWorkspace}
            t={t}
          />
        ) : null}

        {displayGroups.map(([workspacePath, list]) => {
          const folderName = workspaceLabelFromPath(workspacePath)
          const workspaceContext = workspaceContextLabel(workspacePath, folderName)
          const isCollapsed = isSidebarWorkspaceCollapsed(sidebarCollapse, workspacePath)
          const isDragOver =
            dragOverWorkspace !== null
            && workspaceRootIdentityKey(dragOverWorkspace) === workspaceRootIdentityKey(workspacePath)
          const workspaceDropPosition =
            workspaceOrderDropTarget
            && workspaceRootIdentityKey(workspaceOrderDropTarget.workspacePath) === workspaceRootIdentityKey(workspacePath)
              ? workspaceOrderDropTarget.position
              : null
          const draftHistory = sddDraftHistoryForWorkspace(filteredDraftHistoryByWorkspace, workspacePath)
          const threadOrderScope = sidebarThreadOrderScope(workspacePath)
          const sortedThreads = reconcileSidebarThreadOrder(
            sortSidebarThreads(filterEmptySddAssistantThreadsFromSidebar(list, draftHistory)),
            sidebarOrder.threadIdsByScope[threadOrderScope] ?? []
          )
          const workspaceFolders = sidebarFoldersForWorkspace(sidebarFolders, workspacePath)
          const assignedThreadIds = new Set(
            workspaceFolders.flatMap((folder) => folder.threadIds)
          )
          const rootThreads = sortedThreads.filter((thread) => !assignedThreadIds.has(thread.id))
          const threadsById = new Map(sortedThreads.map((thread) => [thread.id, thread] as const))
          const visibleFolder = (folder: SidebarVirtualFolder): boolean => {
            if (!searchQuery.trim() && !showArchived) return true
            if (folder.threadIds.some((threadId) => threadsById.has(threadId))) return true
            return sidebarChildFolders(workspaceFolders, folder.id).some(visibleFolder)
          }
          const rootFolders = sidebarChildFolders(workspaceFolders, null).filter(visibleFolder)
          const workspaceExpanded = expandedWorkspaces[workspacePath] === true
          const hasOverflow = rootThreads.length > 5
          const visibleThreads = workspaceExpanded
            ? rootThreads
            : rootThreads.slice(0, 5)
          return (
            <div
              key={workspacePath}
              className={`relative mb-2 ${
                workspaceDropPosition === 'before'
                  ? "before:absolute before:inset-x-2 before:top-0 before:z-10 before:h-0.5 before:rounded-full before:bg-accent before:content-['']"
                  : workspaceDropPosition === 'after'
                    ? "after:absolute after:bottom-0 after:inset-x-2 after:z-10 after:h-0.5 after:rounded-full after:bg-accent after:content-['']"
                    : ''
              }`}
            >
              <SidebarTreeRow
                title={workspacePath}
                onClick={() =>
                  persistSidebarCollapse((current) =>
                    setSidebarWorkspaceCollapsed(current, workspacePath, !isCollapsed)
                  )
                }
                onContextMenu={(event) => openWorkspaceContextMenu(event, workspacePath)}
                draggable
                onDragStart={(event) => handleWorkspaceDragStart(event, workspacePath)}
                onDragEnd={handleWorkspaceDragEnd}
                onDragOver={(event) => handleWorkspaceDragOver(event, workspacePath)}
                onDragLeave={(event) => handleWorkspaceDragLeave(event, workspacePath)}
                onDrop={(event) => handleWorkspaceDrop(event, workspacePath)}
                className={`min-h-[36px] text-[13.5px] ${
                  isDragOver
                    ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]'
                    : ''
                } ${
                  draggingWorkspacePath !== null
                  && workspaceRootIdentityKey(draggingWorkspacePath) === workspaceRootIdentityKey(workspacePath)
                    ? 'opacity-55'
                    : ''
                }`}
                buttonClassName="items-center gap-2 px-2.5 py-2"
                actionsVisibility="hidden"
                actionsLayout="overlay"
                actions={
                  <>
                    <SidebarIconButton
                      onClick={() => openCreateFolderDialog(workspacePath)}
                      title={t('sidebarFolderCreate')}
                      ariaLabel={t('sidebarFolderCreate')}
                      className="h-6 w-6"
                      stopPropagation
                    >
                      <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </SidebarIconButton>
                    <SidebarIconButton
                      onClick={() => onCreateThreadInWorkspace(workspacePath)}
                      title={t('sidebarWorkspaceNewThread')}
                      ariaLabel={t('sidebarWorkspaceNewThread')}
                      className="h-6 w-6"
                      stopPropagation
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                    </SidebarIconButton>
                  </>
                }
              >
                {isCollapsed ? (
                  <Folder className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />
                ) : (
                  <FolderOpen className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />
                )}
                <span className="min-w-0 flex-1 truncate">{folderName}</span>
                {workspaceContext ? (
                  <span className="min-w-0 max-w-[42%] shrink truncate text-[12.5px] text-ds-faint transition group-hover:opacity-0 group-focus-within:opacity-0">
                    {workspaceContext}
                  </span>
                ) : null}
              </SidebarTreeRow>

              {!isCollapsed ? (
                <div className="mt-1 space-y-[3px] pl-4">
                  <SddDraftHistoryRows
                    items={draftHistory}
                    activeDraftId={activeSddDraftId}
                    deletingDraftIds={deletingDraftIds}
                    error={draftHistoryErrors[workspacePath] ?? ''}
                    onOpen={onOpenRequirementDraft}
                    onDelete={(draft) => void handleDeleteRequirementDraft(draft)}
                    t={t}
                  />
                  {rootFolders.map((folder) => {
                    const renderFolder = (item: SidebarVirtualFolder): ReactElement => {
                      const folderCollapsed = isSidebarFolderCollapsed(
                        sidebarCollapse,
                        workspacePath,
                        item.id
                      )
                      const folderThreads = item.threadIds.flatMap((threadId) => {
                        const thread = threadsById.get(threadId)
                        return thread ? [thread] : []
                      })
                      const childFolders = sidebarChildFolders(workspaceFolders, item.id).filter(visibleFolder)
                      const isFolderDragOver =
                        folderDropTarget?.folderId === item.id
                        && workspaceRootIdentityKey(folderDropTarget.workspacePath) === workspaceRootIdentityKey(workspacePath)
                      return (
                        <div key={item.id}>
                          <SidebarTreeRow
                            title={item.name}
                            ariaLabel={t('sidebarFolderAriaLabel', {
                              name: item.name,
                              count: sidebarFolderThreadCount(workspaceFolders, item.id)
                            })}
                            onClick={() =>
                              persistSidebarCollapse((current) =>
                                setSidebarFolderCollapsed(
                                  current,
                                  workspacePath,
                                  item.id,
                                  !folderCollapsed
                                )
                              )
                            }
                            onContextMenu={(event) => openFolderContextMenu(event, workspacePath, item)}
                            onDragOver={(event) => handleFolderDragOver(event, workspacePath, item.id)}
                            onDragLeave={(event) => handleFolderDragLeave(event, workspacePath, item.id)}
                            onDrop={(event) => handleFolderDrop(event, workspacePath, item.id)}
                            className={`min-h-[32px] ${
                              isFolderDragOver
                                ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(79,124,255,0.32)]'
                                : ''
                            }`}
                            buttonClassName="items-center gap-1.5 px-2 py-1.5"
                            actionsVisibility="hidden"
                            actionsLayout="overlay"
                            actions={
                              <>
                                <SidebarIconButton
                                  onClick={() => openCreateFolderDialog(workspacePath, item.id)}
                                  title={t('sidebarFolderCreateChild')}
                                  ariaLabel={t('sidebarFolderCreateChild')}
                                  className="h-6 w-6"
                                  stopPropagation
                                >
                                  <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.8} />
                                </SidebarIconButton>
                                <SidebarIconButton
                                  onClick={() => void handleCreateThreadInFolder(workspacePath, item.id)}
                                  title={t('sidebarWorkspaceNewThread')}
                                  ariaLabel={t('sidebarWorkspaceNewThread')}
                                  className="h-6 w-6"
                                  stopPropagation
                                >
                                  <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                                </SidebarIconButton>
                              </>
                            }
                          >
                            {folderCollapsed
                              ? <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} />
                              : <ChevronDown className="h-3 w-3 shrink-0 text-ds-faint" strokeWidth={2} />}
                            {folderCollapsed
                              ? <Folder className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} />
                              : <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.8} />}
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ds-ink">
                              {item.name}
                            </span>
                            <span className="shrink-0 rounded-md bg-ds-card/70 px-1.5 py-0.5 text-[10.5px] text-ds-faint tabular-nums transition group-hover:opacity-0 group-focus-within:opacity-0">
                              {sidebarFolderThreadCount(workspaceFolders, item.id)}
                            </span>
                          </SidebarTreeRow>
                          {!folderCollapsed ? (
                            <div className="space-y-[3px] pl-4 pt-[3px]">
                              {childFolders.map(renderFolder)}
                              {folderThreads.map((thread) => renderThreadRow(thread, workspacePath, item.id))}
                              {folderThreads.length === 0 && childFolders.length === 0 ? (
                                <div className="px-2.5 py-1.5 text-[12px] leading-5 text-ds-faint">
                                  {t('sidebarFolderEmpty')}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    }
                    return renderFolder(folder)
                  })}
                  {rootThreads.length === 0 && rootFolders.length === 0 && draftHistory.length === 0 ? (
                    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                      <div className="text-[12.5px] leading-5 text-ds-faint">
                        {searchQuery.trim()
                          ? t('sidebarSearchEmpty')
                          : showArchived
                            ? t('sidebarArchiveEmpty')
                            : t('sidebarWorkspaceEmpty')}
                      </div>
                      {!showArchived && !searchQuery.trim() ? (
                        <button
                          type="button"
                          data-cursor-spotlight-target
                          onClick={() => onCreateThreadInWorkspace(workspacePath)}
                          className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink"
                        >
                          {t('sidebarWorkspaceNewThread')}
                        </button>
                      ) : null}
                    </div>
                  ) : visibleThreads.map((thread) => renderThreadRow(thread, workspacePath, null))}
                  {hasOverflow ? (
                    <button
                      type="button"
                      data-cursor-spotlight-target
                      onClick={() =>
                        setExpandedWorkspaces((current) => ({
                          ...current,
                          [workspacePath]: !workspaceExpanded
                        }))
                      }
                      className="ml-1 mt-1 rounded-md px-2.5 py-1.5 text-[12.5px] text-ds-faint transition hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink"
                    >
                      {workspaceExpanded
                        ? t('sidebarWorkspaceShowLess')
                        : t('sidebarWorkspaceShowMore', {
                            count: rootThreads.length - 5
                          })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {threadContextMenu ? (
        <ThreadContextMenu
          state={threadContextMenu}
          busy={deletingThreadIds[threadContextMenu.thread.id] === true}
          moveDisabled={busy || Boolean(threadMoveDisabledReason(threadContextMenu.thread, threadContextMenu.worktreeRecord))}
          moveDisabledTitle={threadMoveDisabledReason(threadContextMenu.thread, threadContextMenu.worktreeRecord) || undefined}
          onClose={() => setThreadContextMenu(null)}
          onMove={() => openMoveThreadDialog(threadContextMenu.thread, threadContextMenu.worktreeRecord)}
          onPin={() => void handlePinThread(threadContextMenu.thread, threadContextMenu.thread.pinned !== true)}
          onRename={() => openRenameThreadDialog(threadContextMenu.thread)}
          onSummarize={() => void handleSummarizeThread(threadContextMenu.thread)}
          onArchive={() => void handleArchiveThread(threadContextMenu.thread)}
          onDelete={() => void handleDeleteThread(threadContextMenu.thread)}
          onRestore={() => void handleRestoreThread(threadContextMenu.thread)}
          t={t}
        />
      ) : null}

      {workspaceContextMenu ? (
        <WorkspaceContextMenu
          state={workspaceContextMenu}
          onClose={() => setWorkspaceContextMenu(null)}
          onNewThread={() => onCreateThreadInWorkspace(workspaceContextMenu.workspacePath)}
          onNewFolder={() => openCreateFolderDialog(workspaceContextMenu.workspacePath)}
          onOpenInSystem={() => void openWorkspaceInSystem(workspaceContextMenu.workspacePath)}
          onArchiveThreads={() => void handleArchiveWorkspaceThreads(workspaceContextMenu.workspacePath)}
          onRemove={() => void handleRemoveWorkspace(workspaceContextMenu.workspacePath)}
          archiveDisabled={archivableWorkspaceThreads(workspaceContextMenu.workspacePath).length === 0}
          t={t}
        />
      ) : null}

      {folderContextMenu ? (
        <FolderContextMenu
          state={folderContextMenu}
          onClose={() => setFolderContextMenu(null)}
          onNewThread={() =>
            void handleCreateThreadInFolder(
              folderContextMenu.workspacePath,
              folderContextMenu.folder.id
            )
          }
          onNewFolder={() =>
            openCreateFolderDialog(
              folderContextMenu.workspacePath,
              folderContextMenu.folder.id
            )
          }
          onRename={() =>
            openRenameFolderDialog(folderContextMenu.workspacePath, folderContextMenu.folder)
          }
          onDelete={() =>
            handleDeleteFolder(folderContextMenu.workspacePath, folderContextMenu.folder)
          }
          t={t}
        />
      ) : null}

      {renameThreadDialog ? (
        <ThreadRenameDialog
          state={renameThreadDialog}
          onClose={closeRenameThreadDialog}
          onValueChange={(value) =>
            setRenameThreadDialog((current) => current ? { ...current, value } : current)
          }
          onSubmit={(event) => void submitRenameThreadDialog(event)}
          t={t}
        />
      ) : null}

      {folderDialog ? (
        <SidebarFolderDialog
          state={folderDialog}
          onClose={() => setFolderDialog(null)}
          onValueChange={(value) =>
            setFolderDialog((current) => current ? { ...current, value, error: '' } : current)
          }
          onSubmit={submitFolderDialog}
          t={t}
        />
      ) : null}

      {moveThreadDialog ? (
        <MoveThreadDialog
          state={moveThreadDialog}
          onClose={closeMoveThreadDialog}
          onPickTarget={(targetWorkspace) =>
            confirmThreadWorkspaceMove(
              moveThreadDialog.thread,
              targetWorkspace,
              worktreeRecordForSidebarThread(moveThreadDialog.thread, threadWorktrees)
            )
          }
          onConfirm={submitMoveThreadDialog}
          t={t}
        />
      ) : null}

      {actionDialog ? (
        <SidebarActionDialog
          state={actionDialog}
          onClose={closeActionDialog}
          onConfirm={() => void submitActionDialog()}
          t={t}
        />
      ) : null}
    </div>
  )
}

function workspaceContextLabel(workspacePath: string, folderName: string): string {
  const normalized = workspacePath.replace(/[/\\]+$/, '')
  const parts = normalized.split(/[/\\]/).filter(Boolean)
  if (parts.length < 2) return ''
  const parent = parts[parts.length - 2] ?? ''
  if (!parent || parent.toLowerCase() === folderName.toLowerCase()) return ''
  return parent
}
