import { useCallback, useEffect, type RefObject } from 'react'
import { BUILTIN_RIGHT_PANEL_IDS, type RightPanelContributionId } from '../../extensions/contribution-ids'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import { useCodeCanvasDesignSurface } from '../../design/code-canvas-design-surface'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'

type Params = {
  input: string
  inputRef: RefObject<string>
  prevThreadId: RefObject<string | null>
  activeThreadId: string | null
  activeGuiPlan: unknown
  sidePanel: { open: boolean }
  currentSideConversations: Array<{ threadId: string }>
  designWorkspaceRoot: string
  workspaceRoot: string
  fileTreeWorkspaceRoot: string
  filePreviewTarget: unknown
  codeRightTabs: { expanded: boolean; tabs: RightPanelContributionId[] }
  openSideConversationDraft: () => void
  selectSideConversation: (threadId: string) => void
  setSidePanelOpen: (open: boolean) => void
  openFileTreeSidePanel: () => void
  openDesignFileTreeSidePanel: () => void
  openRightPanelTab: (id: RightPanelContributionId) => void
  closeRightPanelTab: (id: RightPanelContributionId) => void
  toggleTerminal: () => void
  collapseRightPanel: () => void
  expandRightPanel: () => void
}

export function useWorkbenchRightTools({
  input,
  inputRef,
  prevThreadId,
  activeThreadId,
  activeGuiPlan,
  sidePanel,
  currentSideConversations,
  designWorkspaceRoot,
  workspaceRoot,
  fileTreeWorkspaceRoot,
  filePreviewTarget,
  codeRightTabs,
  openSideConversationDraft,
  selectSideConversation,
  setSidePanelOpen,
  openFileTreeSidePanel,
  openDesignFileTreeSidePanel,
  openRightPanelTab,
  closeRightPanelTab,
  toggleTerminal,
  collapseRightPanel,
  expandRightPanel
}: Params) {
  useEffect(() => {
    inputRef.current = input
  }, [input, inputRef])

  useEffect(() => {
    const previousThreadId = prevThreadId.current
    prevThreadId.current = activeThreadId
    if (previousThreadId !== null && previousThreadId !== activeThreadId && sidePanel.open) {
      setSidePanelOpen(false)
    }
  }, [activeThreadId, prevThreadId, setSidePanelOpen, sidePanel.open])

  const openSideChat = useCallback((): void => {
    const latestSide = currentSideConversations.at(-1)
    if (latestSide) selectSideConversation(latestSide.threadId)
    else openSideConversationDraft()
  }, [currentSideConversations, openSideConversationDraft, selectSideConversation])

  const openWorkspaceFileTreeTab = useCallback((): void => {
    openFileTreeSidePanel()
    openRightPanelTab(BUILTIN_RIGHT_PANEL_IDS.files)
  }, [openFileTreeSidePanel, openRightPanelTab])

  const openDesignFileTreeTab = useCallback((): void => {
    openDesignFileTreeSidePanel()
    openRightPanelTab(BUILTIN_RIGHT_PANEL_IDS.files)
  }, [openDesignFileTreeSidePanel, openRightPanelTab])

  const openDesignDocumentInWhiteboard = useCallback((documentId: string): void => {
    const root = normalizeWorkspaceRoot(designWorkspaceRoot || workspaceRoot)
    if (!activeThreadId || !root) return
    useCodeCanvasDesignSurface.getState().showDesignDocument(activeThreadId, root, documentId)
    requestCodeCanvasPanelOpen()
  }, [activeThreadId, designWorkspaceRoot, workspaceRoot])

  const openCodeRightTool = useCallback((id: RightPanelContributionId): void => {
    if (id === BUILTIN_RIGHT_PANEL_IDS.terminal) {
      toggleTerminal()
      return
    }
    if (id === BUILTIN_RIGHT_PANEL_IDS.sideConversations) openSideChat()
    if (id === BUILTIN_RIGHT_PANEL_IDS.files) openFileTreeSidePanel()
    openRightPanelTab(id)
  }, [openFileTreeSidePanel, openRightPanelTab, openSideChat, toggleTerminal])

  const closeCodeRightTool = useCallback((id: RightPanelContributionId): void => {
    if (id === BUILTIN_RIGHT_PANEL_IDS.sideConversations) setSidePanelOpen(false)
    closeRightPanelTab(id)
  }, [closeRightPanelTab, setSidePanelOpen])

  const toggleCodeRightWorkspace = useCallback((): void => {
    if (codeRightTabs.expanded) collapseRightPanel()
    else expandRightPanel()
  }, [codeRightTabs.expanded, collapseRightPanel, expandRightPanel])

  useEffect(() => {
    const unavailable: RightPanelContributionId[] = []
    if (!activeGuiPlan) unavailable.push(BUILTIN_RIGHT_PANEL_IDS.plan)
    if (!fileTreeWorkspaceRoot) unavailable.push(BUILTIN_RIGHT_PANEL_IDS.files)
    if (!filePreviewTarget) unavailable.push(BUILTIN_RIGHT_PANEL_IDS.file)
    if (!activeThreadId) {
      unavailable.push(BUILTIN_RIGHT_PANEL_IDS.sideConversations)
      unavailable.push(BUILTIN_RIGHT_PANEL_IDS.agentPerspective)
    }
    for (const id of unavailable) {
      if (codeRightTabs.tabs.includes(id)) closeRightPanelTab(id)
    }
  }, [
    activeGuiPlan,
    activeThreadId,
    closeRightPanelTab,
    codeRightTabs.tabs,
    filePreviewTarget,
    fileTreeWorkspaceRoot
  ])

  return {
    closeCodeRightTool,
    openCodeRightTool,
    openDesignDocumentInWhiteboard,
    openDesignFileTreeTab,
    openSideChat,
    openWorkspaceFileTreeTab,
    toggleCodeRightWorkspace
  }
}
