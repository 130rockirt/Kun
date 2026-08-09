import type { ReactElement } from 'react'
import { BUILTIN_RIGHT_PANEL_IDS } from '../../extensions/contribution-ids'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import { useWorkbenchChatComposerProps } from './useWorkbenchChatComposerProps'
import { buildWorkbenchRightPanelSharedProps } from './useWorkbenchRightPanelSharedProps'
import { useWorkbenchRuntimeBanners } from './useWorkbenchRuntimeBanners'
import { useWorkbenchPlanPanelRuntime } from './useWorkbenchPlanPanelRuntime'
import { useWorkbenchRightPanelElement } from './useWorkbenchRightPanelElement'
import { WorkbenchImageAnnotationHost } from './WorkbenchImageAnnotationHost'

const FILE_TREE_SIDEBAR_WIDTH = 320

type Context = Record<string, any>

export function useWorkbenchShellRuntime(context: Context): {
  chatComposerProps: any
  conversationRuntimeBanner: ReactElement | null
  imageAnnotationHost: ReactElement
  planOverlay: ReactElement | null
  rightPanel: ReactElement | null
  rightPanelSharedProps: any
  writeRuntimeBanner: ReactElement | null
} {
  const {
    input, setInput, composerMode, setComposerMode, composerOrchestration, graphEnabled,
    setComposerOrchestration, openComposerGraph, openComposerGraphChild, busy,
    currentTurnOrchestration, route, runtimeConnection, activeThreadId, activeClawChannelId,
    activeClawChannel, composerModel, composerProviderId, composerPickList, composerModelGroups,
    composerReasoningEffort, composerFastMode, setComposerReasoningEffort, setComposerFastMode,
    setClawChannelModel, setComposerModel, openSettings, handleSend, composerAttachments,
    extensionComposerContextChips, removeComposerContextWithLinkedImage, attachmentUploadEnabled,
    attachmentUploadBusy, attachmentUploadError, activeSddDraft, composerFileReferences,
    designDocumentFileMentionCandidates, webAccessAvailable, composerExecutionSettings,
    composerExecutionApplying, runtimeSkills, disabledSkillIds, handlePickAttachments,
    handlePasteClipboardImage, removeComposerAttachment, addComposerFileReference,
    pickComposerFileReferences, openWorkspaceFileTreeTab, openDesignFileTreeTab,
    removeComposerFileReference, queuedMessages, removeQueuedMessage, guideQueuedMessage,
    interrupt, handleGuiPlanCommand, useWorktreePool, worktreeBranch, setWorktreeBranch,
    setUseWorktreePool, createThread, activeSkillWorkspace, reviewActiveThread,
    updateComposerExecutionSettings, spawnSideConversation, openSideConversationDraft,
    blocks, liveReasoning, liveAssistant, probeRuntime, runtimeStatus, runtimeLogPath,
    error, runtimeErrorDetail, stageInsetClass, t, rightPanelMode, closeRightPanelTab,
    closeRightPanel, buildGuiPlan, verifyGuiPlan, replanChangedRequirements, setRightPanelMode,
    rightPanelVisible, rightSidebarWidth, beginRightResize, writeAssistantOpen,
    collapseRightPanel, designImplementOpen, designAssistantOpen, designImplementTitle,
    workspaceRoot, designAssistantModel, resolvedDesignAssistantProviderId,
    designAssistantPickList, setDesignAssistantModel, designComposerReasoningEffort,
    setDesignComposerReasoningEffort, designContextChips, removeDesignContextChip,
    sendDesignPrompt, designDrawingTitle, clearActiveDrawingHistory, designHasRegisteredHistory,
    designThreads, designHistoryThreadIds, switchDesignThread, writeAssistantModel,
    resolvedWriteAssistantProviderId, writeAssistantPickList, setWriteAssistantModel,
    startNewWriteAssistantConversation, pickWriteAssistantWorkspace, applySddFramework,
    startNewSddAssistantConversation, devPreviewBlocks, latestDevPreviewUrl,
    extensionWorkspaceRoot, selectedPreviewElementCount, selectedModelSupportsImageInput,
    attachDevPreviewContext, clearDevPreviewContexts, activeCodeCanvasWorkspace,
    filePreviewTarget, openFilePreviewTargets, openWorkspaceFilePreviewTarget,
    closeWorkspaceFilePreviewTarget, pinnedFilePreviewTargetKeys, preserveFilePreviewTargets,
    togglePinnedFilePreviewTarget, closeOtherFilePreviewTargets, togglePreserveFilePreviewTargets,
    activeExtensionRightPanel, codeRightTabs, currentSideConversations, currentSideRunningCount,
    runtimeInfo, fileTreeSidePanelOpen, fileTreeSidePanelView, fileTreeWorkspaceRoot,
    designWorkspaceRoot, designDocuments, designActiveDocumentId, setFileTreeSidePanelView,
    previewWorkspaceFileFromSidebar, addWorkspaceReferenceFromSidebar,
    openDesignDocumentInWhiteboard, extensionRightRailItems, extensionRightPanelItems,
    openRightPanelTab, activateRightPanelTab, closeCodeRightTool, toggleFileTreeSidePanel,
    setError, canvasDocumentKey, canvasDocument, sendCodeCanvasPrompt
  } = context
  const chatComposerProps = useWorkbenchChatComposerProps({
    input, setInput, composerMode, setComposerMode, composerOrchestration, graphEnabled,
    setComposerOrchestration,
    openGraph: openComposerGraph,
    openGraphChild: openComposerGraphChild,
    busy, currentTurnOrchestration, route, runtimeReady: runtimeConnection === 'ready',
    activeThreadId, activeClawChannelId,
    activeClawChannelModel: activeClawChannel?.model, composerModel, composerProviderId, composerPickList,
    composerModelGroups, composerReasoningEffort, composerFastMode,
    setComposerReasoningEffort, setComposerFastMode,
    setClawChannelModel, setComposerModel, openProvidersSettings: () => openSettings('providers'), handleSend,
    composerAttachments,
    contextChips: extensionComposerContextChips,
    removeContextChip: removeComposerContextWithLinkedImage,
    attachmentUploadEnabled, attachmentUploadBusy, attachmentUploadError,
    activeSddDraft: Boolean(activeSddDraft), composerFileReferences,
    extraFileMentionCandidates: designDocumentFileMentionCandidates, webAccessAvailable,
    composerExecutionSettings, composerExecutionApplying, runtimeSkills, disabledSkillIds,
    handlePickAttachments, handlePasteClipboardImage, removeComposerAttachment, addComposerFileReference,
    pickComposerFileReferences, openFileTreeSidePanel: openWorkspaceFileTreeTab,
    openDesignFileTreeSidePanel: openDesignFileTreeTab,
    removeComposerFileReference, queuedMessages,
    removeQueuedMessage, guideQueuedMessage, interrupt, handleGuiPlanCommand, useWorktreePool, worktreeBranch, setWorktreeBranch,
    setUseWorktreePool, createThread, activeSkillWorkspace, reviewActiveThread, updateComposerExecutionSettings,
    spawnSideConversation, openSideConversationDraft
  })
  const rightPanelSharedProps = buildWorkbenchRightPanelSharedProps({
    input, setInput, mode: composerMode, setMode: setComposerMode, busy, runtimeConnection,
    activeThreadId, blocks, liveReasoning, liveAssistant, composerModelGroups, composerReasoningEffort,
    setComposerReasoningEffort,
    queuedMessages, removeQueuedMessage, guideQueuedMessage,
    attachments: composerAttachments,
    attachmentUploadEnabled, attachmentUploadBusy, attachmentUploadError,
    onPickAttachments: (files) => void handlePickAttachments(files),
    onPasteClipboardImage: (options) => void handlePasteClipboardImage(options),
    onRemoveAttachment: removeComposerAttachment,
    onInterrupt: (options) => void interrupt(options),
    onRetryConnection: () => void probeRuntime('user', { restart: true }),
    onConfigureProviders: () => openSettings('providers')
  })

  const { writeRuntimeBanner, conversationRuntimeBanner } = useWorkbenchRuntimeBanners({
    runtimeStatus,
    runtimeConnection,
    runtimeLogPath,
    runtimeError: error,
    runtimeErrorDetail,
    activeThreadId,
    stageInsetClass,
    runtimeActionNeedsConnection: t('runtimeActionNeedsConnection'),
    t,
    onOpenSettings: () => openSettings('agents'),
    onRetryConnection: () => void probeRuntime('user', { restart: true })
  })
  const { planPanelInOverlay, planPanelProps, planOverlay } = useWorkbenchPlanPanelRuntime({
    route,
    activeSddDraft: Boolean(activeSddDraft),
    rightPanelMode,
    activeSkillWorkspace,
    activeThreadId,
    runtimeReady: runtimeConnection === 'ready',
    graphEnabled,
    busy,
    title: t('planPanelTitle'),
    cancelLabel: t('cancel'),
    onClose: route === 'chat'
      ? () => closeRightPanelTab(BUILTIN_RIGHT_PANEL_IDS.plan)
      : closeRightPanel,
    onBuildPlan: (orchestration) => void buildGuiPlan(orchestration),
    onVerifyPlan: () => void verifyGuiPlan(),
    onReplanChanged: (ids) => void replanChangedRequirements(ids),
    setRightPanelMode
  })
  const rightPanelDockedVisible = rightPanelVisible && !planPanelInOverlay

  const imageAnnotationHost = (
    <WorkbenchImageAnnotationHost
      route={route}
      activeSddDraft={Boolean(activeSddDraft)}
      canvasDocumentKey={canvasDocumentKey}
      canvasDocument={canvasDocument}
      activeCodeCanvasWorkspace={activeCodeCanvasWorkspace}
      designWorkspaceRoot={designWorkspaceRoot}
      fallbackWorkspaceRoot={workspaceRoot}
      setError={setError}
      sendCodeCanvasPrompt={sendCodeCanvasPrompt}
      sendDesignPrompt={sendDesignPrompt}
    />
  )

  const rightPanel = useWorkbenchRightPanelElement({
    visible: rightPanelDockedVisible,
    width: rightSidebarWidth,
    route,
    rightPanelMode,
    graphEnabled,
    onBeginResize: beginRightResize,
    writeAssistantOpen,
    shared: rightPanelSharedProps,
    planPanelProps,
    onCollapse: route === 'chat' ? collapseRightPanel : closeRightPanel,
    openSettings,
    onSend: handleSend,
    design: {
      implementOpen: designImplementOpen,
      assistantOpen: designAssistantOpen,
      implementTitle: designImplementTitle,
      implementationWorkspaceRoot: workspaceRoot,
      implementationComposer: {
        composerModel,
        composerProviderId,
        composerPickList,
        setComposerModel
      },
      assistantComposer: {
        composerModel: designAssistantModel,
        composerProviderId: resolvedDesignAssistantProviderId,
        composerPickList: designAssistantPickList,
        setComposerModel: setDesignAssistantModel,
        composerReasoningEffort: designComposerReasoningEffort,
        composerFastMode,
        setComposerReasoningEffort: setDesignComposerReasoningEffort,
        setComposerFastMode
      },
      contextChips: designContextChips,
      input,
      onRemoveContextChip: removeDesignContextChip,
      onSendPrompt: sendDesignPrompt,
      drawingTitle: designDrawingTitle,
      onClearHistory: clearActiveDrawingHistory,
      hasRegisteredHistory: designHasRegisteredHistory,
      threads: designThreads,
      historyThreadIds: designHistoryThreadIds,
      onSwitchThread: switchDesignThread
    },
    write: {
      composerModel: writeAssistantModel,
      composerProviderId: resolvedWriteAssistantProviderId,
      composerPickList: writeAssistantPickList,
      skillCommands: runtimeSkills,
      disabledSkillIds,
      composerFastMode,
      setComposerModel: setWriteAssistantModel,
      setComposerFastMode,
      onNewConversation: startNewWriteAssistantConversation,
      onPickWorkspace: () => void pickWriteAssistantWorkspace()
    },
    sdd: {
      draft: activeSddDraft,
      composerModel: writeAssistantModel,
      composerProviderId: resolvedWriteAssistantProviderId,
      composerPickList: writeAssistantPickList,
      composerFastMode,
      setComposerModel: setWriteAssistantModel,
      setComposerFastMode,
      onApplyFramework: applySddFramework,
      onNewConversation: () => {
        if (!activeSddDraft) return
        startNewSddAssistantConversation()
      }
    },
    changes: { blocks },
    browser: {
      blocks: devPreviewBlocks,
      preferredUrl: latestDevPreviewUrl,
      workspaceRoot: extensionWorkspaceRoot,
      activeThreadId,
      selectedElementCount: selectedPreviewElementCount,
      supportsImageCapture: selectedModelSupportsImageInput && attachmentUploadEnabled,
      onAttachContext: attachDevPreviewContext,
      onDocumentChange: clearDevPreviewContexts
    },
    canvas: { workspaceRoot: activeCodeCanvasWorkspace, activeThreadId },
    file: {
      target: filePreviewTarget,
      openTargets: openFilePreviewTargets,
      workspaceRoot,
      onSelectTarget: openWorkspaceFilePreviewTarget,
      onCloseTarget: closeWorkspaceFilePreviewTarget,
      pinnedTargetKeys: pinnedFilePreviewTargetKeys,
      preserveAcrossThreads: preserveFilePreviewTargets,
      onTogglePinnedTarget: togglePinnedFilePreviewTarget,
      onCloseOtherTargets: closeOtherFilePreviewTargets,
      onTogglePreserveAcrossThreads: togglePreserveFilePreviewTargets
    },
    extensionView: activeExtensionRightPanel,
    code: {
      state: codeRightTabs,
      activeThreadId,
      threadRunning: busy,
      sideConversationCount: currentSideConversations.length,
      sideConversationRunningCount: currentSideRunningCount,
      sideAttachmentStoreAvailable: runtimeInfo?.capabilities.attachments.available === true,
      sideDefaultModelSupportsImageInput:
        runtimeInfo?.capabilities.model.inputModalities.includes('image') === true,
      files: {
        open: fileTreeSidePanelOpen,
        view: fileTreeSidePanelView,
        width: FILE_TREE_SIDEBAR_WIDTH,
        workspaceRoot: fileTreeWorkspaceRoot,
        designWorkspaceRoot: normalizeWorkspaceRoot(designWorkspaceRoot || workspaceRoot),
        designDocuments,
        activeDesignDocumentId: designActiveDocumentId,
        selectedTarget: filePreviewTarget,
        onViewChange: setFileTreeSidePanelView,
        onPreviewFile: previewWorkspaceFileFromSidebar,
        onAddReference: addWorkspaceReferenceFromSidebar,
        onOpenDesignInWhiteboard: openDesignDocumentInWhiteboard
      },
      extensionItems: extensionRightRailItems,
      extensionViews: extensionRightPanelItems,
      onOpen: openRightPanelTab,
      onActivate: activateRightPanelTab,
      onClose: closeCodeRightTool,
      onToggleFiles: toggleFileTreeSidePanel,
      onNewSideConversation: openSideConversationDraft
    },
    workspaceRoot: extensionWorkspaceRoot
  })


  return {
    chatComposerProps,
    conversationRuntimeBanner,
    imageAnnotationHost,
    planOverlay,
    rightPanel,
    rightPanelSharedProps,
    writeRuntimeBanner
  }
}
