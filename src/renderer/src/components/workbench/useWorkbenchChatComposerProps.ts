import { useMemo, type Dispatch, type SetStateAction } from 'react'
import type { QueuedUserMessage } from '../../store/chat-store-types'
import { canGuideQueuedMessage } from '../../store/queued-message-guidance'
import type { WorkbenchChatStageProps } from './WorkbenchChatStage'

type ComposerProps = WorkbenchChatStageProps['composerProps']

type UseWorkbenchChatComposerPropsInput = {
  input: string
  setInput: ComposerProps['setInput']
  composerMode: ComposerProps['mode']
  setComposerMode: ComposerProps['setMode']
  composerOrchestration: NonNullable<ComposerProps['orchestration']>
  graphEnabled: boolean
  setComposerOrchestration: NonNullable<ComposerProps['onOrchestrationChange']>
  openGraph: NonNullable<ComposerProps['onOpenGraph']>
  openGraphChild: NonNullable<ComposerProps['onOpenGraphChild']>
  busy: boolean
  currentTurnOrchestration: ComposerProps['currentTurnOrchestration']
  route: string
  runtimeReady: boolean
  activeThreadId: string | null
  activeClawChannelId: string | null
  activeClawChannelModel: string | undefined
  composerModel: string
  composerProviderId: string | undefined
  composerPickList: ComposerProps['composerPickList']
  composerModelGroups: ComposerProps['composerModelGroups']
  composerReasoningEffort: ComposerProps['composerReasoningEffort']
  composerFastMode: NonNullable<ComposerProps['composerFastMode']>
  composerPersonaId: NonNullable<ComposerProps['composerPersonaId']>
  codeAgentPresets: NonNullable<ComposerProps['codeAgentPresets']>
  setComposerPersonaId: NonNullable<ComposerProps['onComposerPersonaChange']>
  setComposerReasoningEffort: ComposerProps['onComposerReasoningEffortChange']
  setComposerFastMode: NonNullable<ComposerProps['onComposerFastModeChange']>
  setClawChannelModel: (channelId: string, modelId: string, providerId?: string) => void | Promise<unknown>
  setComposerModel: (modelId: string, providerId?: string) => void
  openProvidersSettings: () => void
  handleSend: ComposerProps['onSend']
  composerAttachments: ComposerProps['attachments']
  contextChips: ComposerProps['contextChips']
  removeContextChip: ComposerProps['onRemoveContextChip']
  attachmentUploadEnabled: boolean
  attachmentUploadBusy: boolean
  attachmentUploadError: string | null
  activeSddDraft: boolean
  composerFileReferences: ComposerProps['fileReferences']
  extraFileMentionCandidates: ComposerProps['extraFileMentionCandidates']
  webAccessAvailable: boolean
  composerExecutionSettings: ComposerProps['executionSettings']
  composerExecutionApplying: boolean
  runtimeSkills: ComposerProps['skillCommands']
  disabledSkillIds: ComposerProps['disabledSkillIds']
  handlePickAttachments: NonNullable<ComposerProps['onPickAttachments']>
  handlePasteClipboardImage: NonNullable<ComposerProps['onPasteClipboardImage']>
  removeComposerAttachment: ComposerProps['onRemoveAttachment']
  addComposerFileReference: NonNullable<ComposerProps['onAddFileReference']>
  pickComposerFileReferences: () => void | Promise<unknown>
  openFileTreeSidePanel: () => void
  openDesignFileTreeSidePanel: () => void
  removeComposerFileReference: NonNullable<ComposerProps['onRemoveFileReference']>
  queuedMessages: QueuedUserMessage[]
  removeQueuedMessage: ComposerProps['onRemoveQueuedMessage']
  guideQueuedMessage: NonNullable<ComposerProps['onGuideQueuedMessage']>
  interrupt: ComposerProps['onInterrupt']
  handleGuiPlanCommand: () => void | Promise<unknown>
  useWorktreePool: boolean
  worktreeBranch: string
  setWorktreeBranch: Dispatch<SetStateAction<string>>
  setUseWorktreePool: Dispatch<SetStateAction<boolean>>
  createThread: (options: { workspaceRoot?: string; forceNew?: boolean }) => void | Promise<unknown>
  activeSkillWorkspace: string
  reviewActiveThread: NonNullable<ComposerProps['onReviewCommand']>
  updateComposerExecutionSettings: NonNullable<ComposerProps['onExecutionSettingsChange']>
  spawnSideConversation: (seedText: string) => void | Promise<unknown>
  openSideConversationDraft: () => void
}

export function useWorkbenchChatComposerProps({
  input,
  setInput,
  composerMode,
  setComposerMode,
  composerOrchestration,
  graphEnabled,
  setComposerOrchestration,
  openGraph,
  openGraphChild,
  busy,
  currentTurnOrchestration,
  route,
  runtimeReady,
  activeThreadId,
  activeClawChannelId,
  activeClawChannelModel,
  composerModel,
  composerProviderId,
  composerPickList,
  composerModelGroups,
  composerReasoningEffort,
  composerFastMode,
  composerPersonaId,
  codeAgentPresets,
  setComposerPersonaId,
  setComposerReasoningEffort,
  setComposerFastMode,
  setClawChannelModel,
  setComposerModel,
  openProvidersSettings,
  handleSend,
  composerAttachments,
  contextChips,
  removeContextChip,
  attachmentUploadEnabled,
  attachmentUploadBusy,
  attachmentUploadError,
  activeSddDraft,
  composerFileReferences,
  extraFileMentionCandidates,
  webAccessAvailable,
  composerExecutionSettings,
  composerExecutionApplying,
  runtimeSkills,
  disabledSkillIds,
  handlePickAttachments,
  handlePasteClipboardImage,
  removeComposerAttachment,
  addComposerFileReference,
  pickComposerFileReferences,
  openFileTreeSidePanel,
  openDesignFileTreeSidePanel,
  removeComposerFileReference,
  queuedMessages,
  removeQueuedMessage,
  guideQueuedMessage,
  interrupt,
  handleGuiPlanCommand,
  useWorktreePool,
  worktreeBranch,
  setWorktreeBranch,
  setUseWorktreePool,
  createThread,
  activeSkillWorkspace,
  reviewActiveThread,
  updateComposerExecutionSettings,
  spawnSideConversation,
  openSideConversationDraft
}: UseWorkbenchChatComposerPropsInput): ComposerProps {
  return useMemo(() => ({
    input,
    setInput,
    mode: composerMode,
    setMode: setComposerMode,
    orchestration: composerOrchestration,
    graphEnabled,
    onOrchestrationChange: setComposerOrchestration,
    onOpenGraph: openGraph,
    onOpenGraphChild: openGraphChild,
    busy,
    currentTurnOrchestration,
    runtimeReady,
    hasActiveThread: Boolean(activeThreadId),
    composerModel: route === 'claw' ? activeClawChannelModel ?? 'auto' : composerModel,
    composerProviderId: route === 'chat' ? composerProviderId : undefined,
    composerPickList,
    composerModelGroups,
    composerReasoningEffort: route === 'chat' || route === 'claw' ? composerReasoningEffort : undefined,
    composerFastMode: route === 'chat' && !activeSddDraft ? composerFastMode : undefined,
    modelControlVariant: route === 'chat' && !activeSddDraft ? 'split' : 'combined',
    onComposerModelChange: (modelId, providerId) => {
      if (route === 'claw' && activeClawChannelId) {
        void setClawChannelModel(activeClawChannelId, modelId, providerId)
        return
      }
      setComposerModel(modelId, providerId)
    },
    onComposerReasoningEffortChange: route === 'chat' || route === 'claw'
      ? setComposerReasoningEffort
      : undefined,
    onComposerFastModeChange: route === 'chat' && !activeSddDraft
      ? setComposerFastMode
      : undefined,
    onConfigureProviders: openProvidersSettings,
    onSend: handleSend,
    attachments: composerAttachments,
    contextChips,
    onRemoveContextChip: removeContextChip,
    attachmentUploadEnabled,
    attachmentUploadBusy,
    attachmentUploadError,
    fileReferenceEnabled: route === 'chat' && !activeSddDraft,
    fileReferences: composerFileReferences,
    extraFileMentionCandidates,
    webAccessAvailable,
    executionSettings: composerExecutionSettings,
    executionSettingsApplying: composerExecutionApplying,
    skillCommands: runtimeSkills,
    disabledSkillIds,
    onPickAttachments: (files) => void handlePickAttachments(files),
    onPasteClipboardImage: (options) => void handlePasteClipboardImage(options),
    onRemoveAttachment: removeComposerAttachment,
    onAddFileReference: addComposerFileReference,
    onPickFileReferences: () => void pickComposerFileReferences(),
    onOpenFileReferencePicker: openFileTreeSidePanel,
    onOpenDesignReferencePicker: openDesignFileTreeSidePanel,
    onRemoveFileReference: removeComposerFileReference,
    queuedMessages: queuedMessages.map((message) => ({
      id: message.id,
      text: message.text,
      ...(message.deliveryState ? { deliveryState: message.deliveryState } : {}),
      ...(message.deliveryTurnId ? { deliveryTurnId: message.deliveryTurnId } : {}),
      ...(message.displayText ? { displayText: message.displayText } : {}),
      guidanceEligible: canGuideQueuedMessage(message)
    })),
    onRemoveQueuedMessage: removeQueuedMessage,
    onGuideQueuedMessage: guideQueuedMessage,
    onInterrupt: (options) => void interrupt(options),
    onPlanCommand: () => void handleGuiPlanCommand(),
    useWorktreePool,
    worktreeBranch,
    onWorktreeBranchChange: setWorktreeBranch,
    onToggleWorktreeMode: () => setUseWorktreePool((value) => !value),
    onNewCommand: () => void createThread({ workspaceRoot: activeSkillWorkspace, forceNew: true }),
    onReviewCommand: reviewActiveThread,
    onExecutionSettingsChange: updateComposerExecutionSettings,
    // Personas are Code-mode only: Write has its own agent presets, and SDD
    // drafts run a fixed prompt contract.
    composerPersonaId: route === 'chat' && !activeSddDraft ? composerPersonaId : undefined,
    codeAgentPresets: route === 'chat' && !activeSddDraft ? codeAgentPresets : undefined,
    onComposerPersonaChange:
      route === 'chat' && !activeSddDraft ? setComposerPersonaId : undefined,
    onBtwCommand: (seedText) => {
      if (seedText?.trim()) {
        void spawnSideConversation(seedText)
        return
      }
      openSideConversationDraft()
    }
  }), [
    activeClawChannelId,
    codeAgentPresets,
    composerPersonaId,
    setComposerPersonaId,
    activeClawChannelModel,
    activeSddDraft,
    activeSkillWorkspace,
    activeThreadId,
    addComposerFileReference,
    attachmentUploadBusy,
    attachmentUploadEnabled,
    attachmentUploadError,
    busy,
    composerAttachments,
    contextChips,
    composerExecutionApplying,
    composerExecutionSettings,
    extraFileMentionCandidates,
    composerFileReferences,
    composerMode,
    composerOrchestration,
    composerModel,
    composerModelGroups,
    composerPickList,
    composerProviderId,
    composerReasoningEffort,
    composerFastMode,
    createThread,
    currentTurnOrchestration,
    disabledSkillIds,
    handleGuiPlanCommand,
    handlePasteClipboardImage,
    handlePickAttachments,
    handleSend,
    guideQueuedMessage,
    graphEnabled,
    input,
    interrupt,
    openDesignFileTreeSidePanel,
    openFileTreeSidePanel,
    openGraph,
    openGraphChild,
    openProvidersSettings,
    openSideConversationDraft,
    pickComposerFileReferences,
    queuedMessages,
    removeComposerAttachment,
    removeContextChip,
    removeComposerFileReference,
    removeQueuedMessage,
    reviewActiveThread,
    route,
    runtimeReady,
    runtimeSkills,
    setClawChannelModel,
    setComposerMode,
    setComposerOrchestration,
    setComposerModel,
    setComposerReasoningEffort,
    setComposerFastMode,
    setInput,
    setUseWorktreePool,
    setWorktreeBranch,
    spawnSideConversation,
    updateComposerExecutionSettings,
    useWorktreePool,
    webAccessAvailable,
    worktreeBranch
  ])
}
