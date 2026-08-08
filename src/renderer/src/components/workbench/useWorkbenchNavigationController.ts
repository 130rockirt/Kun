import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import type { NormalizedThread, RuntimeConnectionStatus } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import type { ChatState } from '../../store/chat-store-types'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { useCodeCanvasDesignSurface } from '../../design/code-canvas-design-surface'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import type { SddDraft } from '../../sdd/sdd-draft-store'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import { markSddAssistantThread } from '../../sdd/sdd-thread-registry'
import {
  designDocRefForThreadId,
  isDesignThreadId,
  readDesignThreadRegistry,
  type DesignThreadRegistry
} from '../../design/design-thread-registry'
import { formatWorkspacePickerError } from '../../lib/format-workspace-picker-error'
import type { RightPanelMode } from '../chat/WorkbenchTopBar'
import { BUILTIN_RIGHT_PANEL_IDS } from '../../extensions/contribution-ids'

export type WorkbenchSidebarView = 'chat' | 'write' | 'claw' | 'schedule' | 'workflow' | 'subagents'

export type UseWorkbenchNavigationControllerParams = {
  activeSddDraft: boolean
  activeThreadId: string | null
  pluginHostRoute: ChatState['pluginHostRoute']
  rightPanelMode: RightPanelMode
  route: ChatState['route']
  runtimeConnection: RuntimeConnectionStatus
  sddDraftContent: string
  threads: NormalizedThread[]
  useWorktreePool: boolean
  workspaceRoot: string
  worktreeBranch: string
  archiveThread?: ChatState['archiveThread']
  clearFilePreviewTargets: () => void
  createConversation: ChatState['createConversation']
  createThread: ChatState['createThread']
  createWriteThread: ChatState['createWriteThread']
  dismissActiveSddDraft: (options?: { closeAssistant?: boolean }) => void
  ensureWriteThreadForWorkspace: ChatState['ensureWriteThreadForWorkspace']
  findSddDraftForSidebarThread: (
    threadId: string,
    thread: NormalizedThread | null
  ) => Promise<SddDraft | null>
  openClaw: ChatState['openClaw']
  openCode: ChatState['openCode']
  openDesign: ChatState['openDesign']
  openPlugins: ChatState['openPlugins']
  openSchedule: ChatState['openSchedule']
  openWorkflow: ChatState['openWorkflow']
  openWrite: ChatState['openWrite']
  selectThread: ChatState['selectThread']
  setConnectPhoneSidebarOpen: Dispatch<SetStateAction<boolean>>
  setDesignAssistantOpen: (open: boolean) => void
  setFilePreviewTarget: (target: WorkspaceFileTarget | null) => void
  setInput: (value: string) => void
  setRightPanelMode: (mode: RightPanelMode) => void
  setRoute: ChatState['setRoute']
  setUseWorktreePool: Dispatch<SetStateAction<boolean>>
  setWriteAssistantOpen: (open: boolean) => void
}

export type WorkbenchNavigationController = {
  closeRightPanel: () => void
  exploreSddRequirementInDesign: () => void
  openCodeMode: () => void
  openPluginsView: () => void
  openExtensionsView: () => void
  openScheduleView: () => void
  openThread: (id: string) => void
  openWorkflowView: () => void
  openWriteMode: () => void
  pickWriteAssistantWorkspace: () => Promise<void>
  sidebarView: WorkbenchSidebarView
  startNewChat: () => void
  startNewChatInWorkspace: (
    workspaceRoot: string,
    options?: { forceNew?: boolean }
  ) => Promise<string | null>
  startNewConversation: () => void
  startNewWriteAssistantConversation: () => void
  toggleConnectPhone: () => void
}

export function isWorkbenchDesignThread(
  threadId: string,
  thread: NormalizedThread | null,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  return thread?.agentSurface === 'design' || isDesignThreadId(threadId, registry)
}

export function useWorkbenchNavigationController({
  activeSddDraft,
  activeThreadId,
  pluginHostRoute,
  rightPanelMode,
  route,
  runtimeConnection,
  sddDraftContent,
  threads,
  useWorktreePool,
  workspaceRoot,
  worktreeBranch,
  clearFilePreviewTargets,
  createConversation,
  createThread,
  createWriteThread,
  dismissActiveSddDraft,
  ensureWriteThreadForWorkspace,
  findSddDraftForSidebarThread,
  openClaw,
  openCode,
  openDesign,
  openPlugins,
  openSchedule,
  openWorkflow,
  openWrite,
  selectThread,
  setConnectPhoneSidebarOpen,
  setDesignAssistantOpen,
  setFilePreviewTarget,
  setInput,
  setRightPanelMode,
  setRoute,
  setUseWorktreePool,
  setWriteAssistantOpen
}: UseWorkbenchNavigationControllerParams): WorkbenchNavigationController {
  const connectPhoneReturnRouteRef = useRef<ChatState['route']>('chat')

  useEffect(() => {
    if (route !== 'claw') connectPhoneReturnRouteRef.current = route
  }, [route])

  const sidebarView: WorkbenchSidebarView = useMemo(() => {
    if (route === 'claw' || (route === 'plugins' && pluginHostRoute === 'claw')) return 'claw'
    if (route === 'schedule') return 'schedule'
    if (route === 'workflow') return 'workflow'
    if (route === 'write') return 'write'
    return 'chat'
  }, [pluginHostRoute, route])

  const openThread = useCallback((id: string): void => {
    setConnectPhoneSidebarOpen(false)
    void (async () => {
      const thread = threads.find((item) => item.id === id) ?? null
      const designRegistry = readDesignThreadRegistry()
      if (isWorkbenchDesignThread(id, thread, designRegistry)) {
        const designRef = designDocRefForThreadId(id, designRegistry)
        // Clicking a 设计稿 thread opens it in the Code whiteboard panel
        // instead of switching to Design mode. Orphan threads without a
        // registered drawing keep the previous Design-mode fallback.
        if (designRef) {
          useCodeCanvasDesignSurface.getState().showDesignDocument(
            id,
            designRef.workspaceRoot,
            designRef.docId
          )
          requestCodeCanvasPanelOpen()
        } else {
          openDesign()
        }
        // A durable Design thread can outlive a renderer-local registry. In that
        // orphan case we still route to Design, but do not attach it to an
        // unrelated drawing. Registered threads can safely restore their owner.
        if (!designRef) return

        const designStore = useDesignWorkspaceStore.getState()
        designStore.setWorkspaceRoot(designRef.workspaceRoot)
        if (!useDesignWorkspaceStore.getState().documents.some(
          (document) => document.id === designRef.docId
        )) {
          await useDesignWorkspaceStore.getState().rehydrateArtifacts().catch(() => undefined)
        }
        const restoredDesignStore = useDesignWorkspaceStore.getState()
        if (!restoredDesignStore.documents.some((document) => document.id === designRef.docId)) return
        restoredDesignStore.switchActiveDocument(designRef.docId)
        await selectThread(id)
        return
      }
      const sddDraft = await findSddDraftForSidebarThread(id, thread)
      if (sddDraft) {
        // 点击“需求 AI”会话只打开该会话本身:登记草稿归属后精确选择点击的线程,
        // 不调用 openSddRequirementDraftFromHistory(),因此不会自动展开草稿编辑器。
        // 若当前正显示其他草稿,先保存并关闭草稿视图与需求 AI 右栏。
        markSddAssistantThread(sddDraft, id)
        if (useSddDraftStore.getState().activeDraft) dismissActiveSddDraft({ closeAssistant: true })
        setRoute('chat')
        await selectThread(id)
        void useChatStore.getState().refreshThreads()
        return
      }
      if (useSddDraftStore.getState().activeDraft) dismissActiveSddDraft({ closeAssistant: true })
      setRoute('chat')
      await selectThread(id)
    })()
  }, [
    dismissActiveSddDraft,
    findSddDraftForSidebarThread,
    openDesign,
    selectThread,
    setConnectPhoneSidebarOpen,
    setRoute,
    threads
  ])

  const startNewChat = useCallback((): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    setRoute('chat')
    void createThread({ useWorktreePool, worktreeBranch })
    if (useWorktreePool) setUseWorktreePool(false)
  }, [
    activeSddDraft,
    createThread,
    dismissActiveSddDraft,
    setConnectPhoneSidebarOpen,
    setRoute,
    setUseWorktreePool,
    useWorktreePool,
    worktreeBranch
  ])

  const startNewChatInWorkspace = useCallback(async (
    targetWorkspaceRoot: string,
    options?: { forceNew?: boolean }
  ): Promise<string | null> => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    setRoute('chat')
    const threadId = await createThread({
      workspaceRoot: targetWorkspaceRoot,
      forceNew: options?.forceNew,
      useWorktreePool,
      worktreeBranch
    })
    if (useWorktreePool) setUseWorktreePool(false)
    return threadId
  }, [
    activeSddDraft,
    createThread,
    dismissActiveSddDraft,
    setConnectPhoneSidebarOpen,
    setRoute,
    setUseWorktreePool,
    useWorktreePool,
    worktreeBranch
  ])

  const startNewConversation = useCallback((): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    setRoute('chat')
    void createConversation()
  }, [activeSddDraft, createConversation, dismissActiveSddDraft, setConnectPhoneSidebarOpen, setRoute])

  const openCodeMode = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    void openCode()
  }, [openCode, setConnectPhoneSidebarOpen])

  const openWriteMode = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    void openWrite()
  }, [openWrite, setConnectPhoneSidebarOpen])

  const exploreSddRequirementInDesign = useCallback((): void => {
    const requirement = sddDraftContent.trim()
    dismissActiveSddDraft({ closeAssistant: true })
    setInput(requirement)
    openDesign()
  }, [dismissActiveSddDraft, openDesign, sddDraftContent, setInput])

  const openPluginsView = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    openPlugins(sidebarView === 'claw' ? 'claw' : 'chat')
  }, [openPlugins, setConnectPhoneSidebarOpen, sidebarView])

  const openExtensionsView = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    setRoute('extensions')
  }, [setConnectPhoneSidebarOpen, setRoute])

  const openScheduleView = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    openSchedule()
  }, [openSchedule, setConnectPhoneSidebarOpen])

  const openWorkflowView = useCallback((): void => {
    setConnectPhoneSidebarOpen(false)
    openWorkflow()
  }, [openWorkflow, setConnectPhoneSidebarOpen])

  const toggleConnectPhone = useCallback((): void => {
    // 打开 Connect Phone 不清空需求草稿:草稿内容与保存状态留在本地 store,
    // 返回原工作台后继续可见。
    if (route === 'claw') {
      setConnectPhoneSidebarOpen(false)
      const returnRoute =
        connectPhoneReturnRouteRef.current === 'claw' ? 'chat' : connectPhoneReturnRouteRef.current
      if (returnRoute === 'chat') {
        // 利用 lastCodeThreadId 恢复离开前的 Code 会话(含需求 AI 会话)。
        void openCode()
        return
      }
      if (returnRoute === 'write') {
        void openWrite()
        return
      }
      if (returnRoute === 'design') {
        openDesign()
        return
      }
      setRoute(returnRoute)
      return
    }
    connectPhoneReturnRouteRef.current = route
    openClaw()
    setConnectPhoneSidebarOpen(true)
  }, [openClaw, openCode, openDesign, openWrite, route, setConnectPhoneSidebarOpen, setRoute])

  const closeRightPanel = useCallback((): void => {
    if (route === 'write') {
      setWriteAssistantOpen(false)
      return
    }
    if (route === 'design') {
      const designState = useDesignWorkspaceStore.getState()
      if (designState.implementOpen) {
        designState.closeImplementPanel()
        setDesignAssistantOpen(true)
      } else {
        setDesignAssistantOpen(false)
      }
      return
    }
    if (rightPanelMode === BUILTIN_RIGHT_PANEL_IDS.file) clearFilePreviewTargets()
    setRightPanelMode(null)
    setFilePreviewTarget(null)
  }, [
    clearFilePreviewTargets,
    rightPanelMode,
    route,
    setDesignAssistantOpen,
    setFilePreviewTarget,
    setRightPanelMode,
    setWriteAssistantOpen
  ])

  const startNewWriteAssistantConversation = useCallback((): void => {
    const writeState = useWriteWorkspaceStore.getState()
    const writeWorkspaceRoot = writeState.workspaceRoot || workspaceRoot
    setInput('')
    writeState.clearQuotedSelections()
    void createWriteThread(writeWorkspaceRoot, writeState.activeFilePath ?? undefined)
  }, [createWriteThread, setInput, workspaceRoot])

  const pickWriteAssistantWorkspace = useCallback(async (): Promise<void> => {
    try {
      const writeState = useWriteWorkspaceStore.getState()
      writeState.setFileError(null)
      if (typeof window.kunGui?.pickWorkspaceDirectory !== 'function') {
        throw new Error('workspace:pick-directory unavailable')
      }
      const picked = await window.kunGui.pickWorkspaceDirectory(
        writeState.workspaceRoot || writeState.defaultWorkspaceRoot || workspaceRoot || undefined
      )
      if (!picked.canceled && picked.path) {
        await useWriteWorkspaceStore.getState().addWriteWorkspace(picked.path)
        if (runtimeConnection === 'ready') void ensureWriteThreadForWorkspace(picked.path)
      }
    } catch (error) {
      useWriteWorkspaceStore.getState().setFileError(formatWorkspacePickerError(error))
    }
  }, [ensureWriteThreadForWorkspace, runtimeConnection, workspaceRoot])

  return {
    closeRightPanel,
    exploreSddRequirementInDesign,
    openCodeMode,
    openPluginsView,
    openExtensionsView,
    openScheduleView,
    openThread,
    openWorkflowView,
    openWriteMode,
    pickWriteAssistantWorkspace,
    sidebarView,
    startNewChat,
    startNewChatInWorkspace,
    startNewConversation,
    startNewWriteAssistantConversation,
    toggleConnectPhone
  }
}
