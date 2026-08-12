import { rendererRuntimeClient } from '../agent/runtime-client'
import i18n from '../i18n'
import { describeRuntimeError, formatRuntimeError, getRuntimeErrorCode } from '../lib/format-runtime-error'
import { shouldAutoTitleThread } from '../lib/thread-title'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import { buildClawRuntimePrompt, buildCodeRuntimePrompt } from '@shared/app-settings'
import { saveQueuedMessagesForThread } from './queued-message-persistence'
import { currentTurnStartGeneration } from './turn-start-fence'
import {
  activeClawChannel,
  rememberCodeWorkspaceRoots,
  rememberThreadComposerSelection,
  rememberTurnModel
} from './chat-store-helpers'
import { findReusableEmptyThreadId, reconcileOptimisticUserBlock } from './chat-store-runtime-helpers'
import { clearBusyWatchdog, resetBusyRecoveryAttempts } from './chat-store-schedulers'
import {
  armBusyWatchdog,
  buildThreadEventSink,
  isCodeThread,
  looksLikeActiveTurnError,
  rememberPendingClawFeishuMirror,
  runtimeErrorDetail,
  runtimeStreamRecoveringMessage,
  shouldOpenSettingsForError
} from './chat-store-runtime'
import { ensureRuntimeProviderForSend, subscribeThreadEventsWithRecovery } from './chat-store-thread-action-helpers'
import { readDesignThreadRegistry } from '../design/design-thread-registry'
import {
  createWorkspaceCheckpointRequestId,
  localConversationErrorBlock,
  pendingQueuedMessage,
  startingQueuedSubmission,
  settleRuntimeTurnAdmission,
  threadActionSharedState,
  turnAdmissionOutcomeMayBeUnknown,
  upsertQueuedSubmission,
  withoutConsumedComposerContexts
} from './chat-store-thread-actions-support'
import type { PreparedThreadSend } from './chat-store-thread-send-direct-types'

export function runtimePromptForSurface(input: {
  channel: ReturnType<typeof activeClawChannel>
  requestedAgentSurface: PreparedThreadSend['requestedAgentSurface']
  writeContext: PreparedThreadSend['writeContext']
  settings: Parameters<typeof buildClawRuntimePrompt>[0] & Parameters<typeof buildCodeRuntimePrompt>[0]
  prompt: string
}): string {
  if (input.channel) {
    return buildClawRuntimePrompt(input.settings, input.prompt, { channel: input.channel })
  }
  if (input.requestedAgentSurface === 'write' || input.writeContext) return input.prompt
  return buildCodeRuntimePrompt(input.settings, input.prompt)
}

export async function performPreparedThreadSend(input: PreparedThreadSend): Promise<boolean> {
  let {
    activeThreadId,
    shouldRenameThreadAfterSend
  } = input
  const {
    context,
    runtime,
    provider: p,
    trimmedText,
    mode,
    overrides,
    queued,
    clientRequestId,
    expectedThreadId,
    requestedAgentSurface,
    designProfile,
    designDocumentTarget,
    designImagePlacementTarget,
    messageSource,
    expectedThreadStillActive,
    writeContext,
    now,
    userBlockId,
    attachmentIds,
    attachments,
    fileReferences,
    composerContexts,
    displayText,
    userDisplayText,
    generatedTitle,
    shouldAutoRenameForRoute,
    composerModel,
    composerProviderId,
    composerAccountId,
    reasoningEffort,
    serviceTier,
    guiDesignCanvas,
    guiDesignMode,
    persona,
    orchestration,
    userModelChip,
    submittedMessageForQueue
  } = input
  const { set, get, sseAbortRef } = context
    const previousBlocks = get().blocks
    const previousActiveThreadId = get().activeThreadId
    const previousLastSeq = get().lastSeq
    const previousCurrentTurnId = get().currentTurnId
    const previousCurrentTurnOrchestration = get().currentTurnOrchestration
    const previousCurrentTurnUserId = get().currentTurnUserId
    const previousLiveReasoning = get().liveReasoning
    const previousLiveAssistant = get().liveAssistant
    const previousTurnStartedAtByUserId = get().turnStartedAtByUserId
    const previousTurnDurationByUserId = get().turnDurationByUserId
    const previousTurnReasoningFirstAtByUserId = get().turnReasoningFirstAtByUserId
    const previousTurnReasoningLastAtByUserId = get().turnReasoningLastAtByUserId
    const previousQueuedMessages = get().queuedMessages
    resetBusyRecoveryAttempts()
    // Fence stale detail hydration before publishing the optimistic turn.
    runtime.threadSelectionGeneration += 1
    set((s) => ({
      busy: true,
      blocks: [
        ...s.blocks,
        {
          kind: 'user' as const,
          id: userBlockId,
          createdAt: new Date(now).toISOString(),
          text: displayText,
          ...(userModelChip ? { modelLabel: userModelChip } : {}),
          ...((requestedAgentSurface || writeContext || guiDesignMode) || userDisplayText || messageSource || guiDesignCanvas || designProfile || designDocumentTarget || designImagePlacementTarget || attachmentIds.length || attachments.length || fileReferences.length || composerContexts.length
            ? {
                meta: {
                  agentSurface: requestedAgentSurface ??
                    (writeContext ? 'write' : guiDesignMode ? 'design' : 'code'),
                  ...(userDisplayText ? { displayText: userDisplayText } : {}),
                  ...(messageSource ? { messageSource } : {}),
                  ...(guiDesignCanvas ? { guiDesignCanvas: true } : {}),
                  ...(guiDesignMode ? { guiDesignMode: true } : {}),
                  ...(designProfile ? { designProfile } : {}),
                  ...(designDocumentTarget ? { designDocumentTarget } : {}),
                  ...(designImagePlacementTarget ? { designImagePlacementTarget } : {}),
                  ...(attachmentIds.length ? { attachmentIds } : {}),
                  ...(attachments.length ? { attachments } : {}),
                  ...(fileReferences.length ? { fileReferences } : {}),
                  ...(composerContexts.length ? { composerContexts } : {})
                }
              }
            : {})
        }
      ],
      liveReasoning: '',
      liveAssistant: '',
      error: null,
      currentTurnOrchestration: orchestration,
      currentTurnUserId: userBlockId,
      turnStartedAtByUserId: { ...s.turnStartedAtByUserId, [userBlockId]: now },
      queuedMessages: queued
        ? s.queuedMessages.map((message) => message.id === queued.id
            ? { ...message, deliveryState: 'starting' as const }
            : message)
        : s.queuedMessages
    }))
    if (queued) runtime.persistActiveQueuedMessages()
    if (!activeThreadId) {
      try {
        const settings = await rendererRuntimeClient.getSettings()
        const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot)
        if (!workspaceRoot) {
          set({
            blocks: previousBlocks,
            busy: false,
            currentTurnId: previousCurrentTurnId,
            currentTurnOrchestration: previousCurrentTurnOrchestration,
            currentTurnUserId: previousCurrentTurnUserId,
            turnStartedAtByUserId: previousTurnStartedAtByUserId,
            turnDurationByUserId: previousTurnDurationByUserId,
            turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
            turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
            queuedMessages: previousQueuedMessages,
            error: i18n.t('common:workspaceRequiredToCreateThread')
          })
          runtime.persistActiveQueuedMessages()
          return false
        }
        const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
        set({ codeWorkspaceRoots })
        const reusableThreadId = await findReusableEmptyThreadId(
          get(),
          p,
          workspaceRoot,
          (thread) => isCodeThread(
            thread,
            get().clawChannels,
            undefined,
            readDesignThreadRegistry()
          )
        )
        const reusableThread = reusableThreadId
          ? get().threads.find((thread) => thread.id === reusableThreadId) ?? null
          : null
        shouldRenameThreadAfterSend =
          shouldAutoRenameForRoute &&
          reusableThreadId != null && shouldAutoTitleThread(reusableThread)
        const createdThread =
          reusableThreadId == null
            ? await p.createThread({
                workspace: workspaceRoot,
                title: generatedTitle,
                titleAuto: true,
                ...(composerModel ? { model: composerModel } : {}),
                ...(composerProviderId ? { providerId: composerProviderId } : {}),
                ...(composerAccountId ? { accountId: composerAccountId } : {}),
                // Design is turn intent; workbench thread ownership stays Code.
                agentSurface: requestedAgentSurface === 'write' ? 'write' : 'code',
                mode: mode ?? 'agent'
              })
            : null
        const threadId = reusableThreadId ?? createdThread?.id ?? null
        if (!threadId) {
          throw new Error('Failed to resolve target thread id.')
        }
        activeThreadId = threadId
        if (composerModel) {
          rememberThreadComposerSelection(threadId, composerModel, composerProviderId)
        }
        set((s) => ({
          activeThreadId: threadId,
          // Freshly created threads are always primary — clear any side-session
          // relation carried over from the previously active thread.
          activeThreadRelation: 'primary',
          activeThreadParentId: null,
          codeWorkspaceRoots: rememberCodeWorkspaceRoots(s.codeWorkspaceRoots, [workspaceRoot, createdThread?.workspace]),
          lastSeq: 0,
          inspectorSelectedId: null,
          threads:
            createdThread && !s.threads.some((thread) => thread.id === createdThread.id)
              ? [createdThread, ...s.threads]
              : s.threads
        }))
        void get().refreshThreads()
      } catch (e) {
        void window.kunGui.logError('create-thread', 'Failed to create thread', {
          message: e instanceof Error ? e.message : String(e)
        }).catch(() => undefined)
        set({
          activeThreadId: previousActiveThreadId,
          blocks: previousBlocks,
          lastSeq: previousLastSeq,
          busy: false,
          currentTurnId: previousCurrentTurnId,
          currentTurnOrchestration: previousCurrentTurnOrchestration,
          currentTurnUserId: previousCurrentTurnUserId,
          turnStartedAtByUserId: previousTurnStartedAtByUserId,
          turnDurationByUserId: previousTurnDurationByUserId,
          turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
          turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
          queuedMessages: previousQueuedMessages,
          error: formatRuntimeError(e),
          ...(shouldOpenSettingsForError(e)
            ? { route: 'settings' as const, settingsSection: 'agents' as const }
            : {})
        })
        runtime.persistActiveQueuedMessages()
        return false
      }
    }
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    clearBusyWatchdog()
    let runtimeTurnAccepted = false
    try {
      const seqAtSend = get().lastSeq
      const channel = get().route === 'claw' ? activeClawChannel(get()) : null
      if (!channel && composerModel) {
        rememberThreadComposerSelection(activeThreadId, composerModel, composerProviderId)
      }
      await ensureRuntimeProviderForSend({
        providerId: channel ? undefined : composerProviderId,
        model: composerModel
      })
      const settings = await rendererRuntimeClient.getSettings()
      let workspaceCheckpointRequestId: string | undefined
      const checkpointThread = get().threads.find((thread) => thread.id === activeThreadId)
      const checkpointWorkspaceRoot = normalizeWorkspaceRoot(checkpointThread?.workspace) || normalizeWorkspaceRoot(settings.workspaceRoot)
      const checkpointWorkspaceKey = checkpointWorkspaceRoot.replaceAll('\\', '/').toLowerCase()
      if (
        settings.checkpointCleanup?.createEnabled &&
        checkpointWorkspaceRoot &&
        threadActionSharedState.checkpointGitAvailability.canAttempt(checkpointWorkspaceKey) &&
        typeof window.kunGui.createGitCheckpoint === 'function'
      ) {
        workspaceCheckpointRequestId = createWorkspaceCheckpointRequestId()
        const checkpoint = window.kunGui.createGitCheckpoint({
          workspaceRoot: checkpointWorkspaceRoot,
          threadId: activeThreadId,
          checkpointId: workspaceCheckpointRequestId
        }).catch((error) => ({
          ok: false as const,
          reason: 'error' as const,
          message: error instanceof Error ? error.message : String(error)
        }))
        void checkpoint.then((result) => {
          if (
            result.ok ||
            result.reason === 'not_git_repo' ||
            result.reason === 'no_workspace' ||
            result.reason === 'disabled'
          ) return
          if (result.reason === 'git_unavailable') {
            threadActionSharedState.checkpointGitAvailability.markUnavailable(checkpointWorkspaceKey)
          }
          void window.kunGui.logError(
            'git-checkpoint',
            result.reason === 'git_unavailable'
              ? 'Git checkpoint disabled for this workspace because Git was not found'
              : 'Failed to create Git checkpoint',
            {
              message: result.message,
              reason: result.reason,
              workspaceRoot: checkpointWorkspaceRoot
            }
          ).catch(() => undefined)
        })
      }
      const runtimeText = runtimePromptForSurface({
        channel,
        requestedAgentSurface,
        writeContext,
        settings,
        prompt: trimmedText
      })
      const runtimeDisplayText = channel ? displayText : (userDisplayText ?? trimmedText)
      if (!expectedThreadStillActive()) {
        const current = get()
        if (current.activeThreadId === activeThreadId) {
          set({
            blocks: previousBlocks,
            lastSeq: previousLastSeq,
            busy: false,
            liveReasoning: previousLiveReasoning,
            liveAssistant: previousLiveAssistant,
            currentTurnId: previousCurrentTurnId,
            currentTurnOrchestration: previousCurrentTurnOrchestration,
            currentTurnUserId: previousCurrentTurnUserId,
            turnStartedAtByUserId: previousTurnStartedAtByUserId,
            turnDurationByUserId: previousTurnDurationByUserId,
            turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
            turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
            queuedMessages: previousQueuedMessages,
            error: i18n.t('common:designThreadChangedBeforeSend')
          })
          runtime.persistActiveQueuedMessages()
        } else {
          set({ error: i18n.t('common:designThreadChangedBeforeSend') })
        }
        return false
      }
      // Persist the idempotency key before the POST. If the runtime accepts the
      // turn but the response is lost (or the app exits), recovery retries the
      // exact same admission instead of creating a duplicate turn.
      saveQueuedMessagesForThread(
        activeThreadId,
        startingQueuedSubmission(get().queuedMessages, submittedMessageForQueue)
      )
      const sendGeneration = currentTurnStartGeneration()
      const {
        turnId,
        userMessageItemId,
        threadAgentSurface: acceptedThreadAgentSurface,
        designProfile: acceptedDesignProfile
      } = await p.sendUserMessage(activeThreadId, runtimeText, {
        clientRequestId,
        mode,
        orchestration,
        agentSurface: requestedAgentSurface ??
          (writeContext || get().route === 'write' ? 'write' : guiDesignMode || get().route === 'design' ? 'design' : 'code'),
        ...(composerModel ? { model: composerModel } : {}),
        ...(!channel && composerProviderId ? { providerId: composerProviderId } : {}),
        ...(!channel && composerAccountId ? { accountId: composerAccountId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(!channel && serviceTier ? { serviceTier } : {}),
        ...((queued?.subagentResume ?? overrides?.subagentResume)
          ? { subagentResume: queued?.subagentResume ?? overrides?.subagentResume }
          : {}),
        ...(messageSource ? { messageSource } : {}),
        ...(runtimeDisplayText ? { displayText: runtimeDisplayText } : {}),
        ...((queued?.guiPlan ?? overrides?.guiPlan) ? { guiPlan: queued?.guiPlan ?? overrides?.guiPlan } : {}),
        ...(guiDesignCanvas ? { guiDesignCanvas: true } : {}),
        ...(guiDesignMode ? { guiDesignMode: true } : {}),
        ...(designProfile ? { designProfile } : {}),
        ...(designDocumentTarget ? { designDocumentTarget } : {}),
        ...(designImagePlacementTarget ? { designImagePlacementTarget } : {}),
        ...(persona ? { persona } : {}),
        ...((queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact)
          ? { guiDesignArtifact: queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact }
          : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(workspaceCheckpointRequestId ? { workspaceCheckpointRequestId } : {}),
        ...(fileReferences.length ? { fileReferences } : {}),
        ...(composerContexts.length ? { composerContexts } : {})
      })
      runtimeTurnAccepted = true
      if (submittedMessageForQueue.waitForRuntimeAdmission) settleRuntimeTurnAdmission(clientRequestId, true)
      set((state) => ({
        threads: state.threads.map((thread) => thread.id === activeThreadId
          ? {
              ...thread,
              latestTurnId: turnId,
              latestTurnStatus: 'running',
              ...(acceptedThreadAgentSurface
                ? { agentSurface: acceptedThreadAgentSurface }
                : {}),
              ...(acceptedDesignProfile ? { designProfile: acceptedDesignProfile } : {})
            }
          : thread)
      }))
      if (!queued) saveQueuedMessagesForThread(activeThreadId, get().queuedMessages)
      if (currentTurnStartGeneration() !== sendGeneration) {
        // Stop was pressed while the POST was still pending. The accepted turn
        // is real, but must not revive this renderer projection or its queue.
        void p.interruptTurn(activeThreadId, turnId, { discard: false }).catch(() => undefined)
        return true
      }
      // The runtime accepted this scoped turn, but the user may have switched
      // threads while the provider request was in flight. Leave the accepted
      // turn on its original thread and let persistence/reload surface it later;
      // never project its busy state, blocks, or SSE into the newly active view.
      if (expectedThreadId && get().activeThreadId !== activeThreadId) {
        if (userMessageItemId && userModelChip) {
          rememberTurnModel(activeThreadId, userMessageItemId, userModelChip)
        }
        void get().refreshThreads()
        return true
      }
      if (queued) {
        set((state) => ({
          queuedMessages: state.queuedMessages.map((message) => message.id === queued.id
            ? {
                ...message,
                deliveryState: 'in_flight' as const,
                deliveryTurnId: turnId,
                deliveryUserMessageItemId: userMessageItemId ?? userBlockId
              }
            : message)
        }))
        runtime.persistActiveQueuedMessages()
      }
      if (!queued && composerContexts.length > 0) {
        set((state) => ({
          extensionComposerContexts: withoutConsumedComposerContexts(state, composerContexts)
        }))
      }
      // Mirror the composer model selection against the runtime's stable
      // user_message item id so the badge survives page refresh / thread
      // re-selection. The runtime itself doesn't persist per-turn metadata.
      if (userMessageItemId && userModelChip) {
        rememberTurnModel(activeThreadId, userMessageItemId, userModelChip)
      }
      if (userMessageItemId && userMessageItemId !== userBlockId) {
        set((s) => ({
          blocks: reconcileOptimisticUserBlock(
            s.blocks,
            userBlockId,
            userMessageItemId,
            displayText,
            userModelChip
          ).map((block) =>
            block.kind === 'user' && block.id === userMessageItemId
              ? {
                  ...block,
                  meta: {
                    ...(block.meta ?? {}),
                    turnId
                  }
                }
              : block
          ),
          currentTurnUserId: s.currentTurnUserId === userBlockId ? userMessageItemId : s.currentTurnUserId,
          turnStartedAtByUserId: (() => {
            if (s.turnStartedAtByUserId[userBlockId] === undefined) return s.turnStartedAtByUserId
            const next = { ...s.turnStartedAtByUserId, [userMessageItemId]: s.turnStartedAtByUserId[userBlockId] }
            delete next[userBlockId]
            return next
          })(),
          turnDurationByUserId: (() => {
            if (s.turnDurationByUserId[userBlockId] === undefined) return s.turnDurationByUserId
            const next = { ...s.turnDurationByUserId, [userMessageItemId]: s.turnDurationByUserId[userBlockId] }
            delete next[userBlockId]
            return next
          })(),
          turnReasoningFirstAtByUserId: (() => {
            if (s.turnReasoningFirstAtByUserId[userBlockId] === undefined) return s.turnReasoningFirstAtByUserId
            const next = {
              ...s.turnReasoningFirstAtByUserId,
              [userMessageItemId]: s.turnReasoningFirstAtByUserId[userBlockId]
            }
            delete next[userBlockId]
            return next
          })(),
          turnReasoningLastAtByUserId: (() => {
            if (s.turnReasoningLastAtByUserId[userBlockId] === undefined) return s.turnReasoningLastAtByUserId
            const next = {
              ...s.turnReasoningLastAtByUserId,
              [userMessageItemId]: s.turnReasoningLastAtByUserId[userBlockId]
            }
            delete next[userBlockId]
            return next
          })()
        }))
      }
      if (channel && typeof window.kunGui?.mirrorClawChannelMessage === 'function') {
        const userMirror = await window.kunGui.mirrorClawChannelMessage(
          activeThreadId,
          trimmedText,
          'user'
        )
        if (userMirror.ok) {
          rememberPendingClawFeishuMirror(turnId, {
            threadId: activeThreadId,
            userBlockId: userMessageItemId ?? userBlockId,
            userText: trimmedText
          })
        }
      }
      // Re-baseline the shared delta floor to this send's since_seq right before
      // the sink opens, so a replayed backlog can't re-append text. Subscribe to the
      // turn's event stream BEFORE the cosmetic title rename so a slow/blocked title
      // write never delays the conversation. Project the accepted turn onto the
      // sidebar immediately so a stale summary for the previous turn cannot make
      // this thread look idle or completed while the new turn streams.
      set((s) => ({
        currentTurnId: turnId,
        liveDeltaSeqFloor: seqAtSend,
        threads: s.threads.map((thread) => thread.id === activeThreadId
          ? {
              ...thread,
              status: thread.archived ? thread.status : 'running',
              latestTurnId: turnId,
              latestTurnStatus: 'running'
            }
          : thread)
      }))
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: activeThreadId, signal: ac.signal, sinceSeq: seqAtSend })
      subscribeThreadEventsWithRecovery(p, activeThreadId, seqAtSend, sink, ac.signal, get)
      armBusyWatchdog(set, get)
      if (shouldRenameThreadAfterSend) {
        // Provisional first-message title; the backend LLM titler upgrades it
        // later (fire-and-forget on the runtime). Awaited here only to land the
        // title before refreshThreads re-reads the list — never blocks the stream.
        const renamed = await p.renameThread(activeThreadId, generatedTitle, true).then(() => true).catch(() => {
          /* keep message delivery successful even if auto-title update fails */
          return false
        })
        if (renamed) {
          set((s) => ({
            threads: s.threads.map((thread) =>
              thread.id === activeThreadId ? { ...thread, title: generatedTitle, titleAuto: true } : thread
            )
          }))
        }
      }
      if ((queued?.agentSurface ?? overrides?.agentSurface) === 'design') {
        void get().refreshThreads()
      } else {
        await get().refreshThreads()
      }
      return true
    } catch (e) {
      clearBusyWatchdog()
      void window.kunGui.logError('send-message', 'Failed to send message', {
        message: e instanceof Error ? e.message : String(e),
        threadId: activeThreadId
      }).catch(() => undefined)
      const runtimeErrorCode = getRuntimeErrorCode(e)
      if (runtimeErrorCode === 'thread_busy' || looksLikeActiveTurnError(e)) {
        set((state) => ({
          blocks: previousBlocks,
          busy: true,
          currentTurnId: previousCurrentTurnId,
          currentTurnOrchestration: previousCurrentTurnOrchestration,
          currentTurnUserId: previousCurrentTurnUserId,
          turnStartedAtByUserId: previousTurnStartedAtByUserId,
          turnDurationByUserId: previousTurnDurationByUserId,
          turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
          turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
          queuedMessages: upsertQueuedSubmission(
            previousQueuedMessages,
            submittedMessageForQueue
          ),
          extensionComposerContexts: withoutConsumedComposerContexts(state, composerContexts),
          threads: state.threads.map((thread) => thread.id === activeThreadId
            ? {
                ...thread,
                status: thread.archived ? thread.status : 'running'
              }
            : thread),
          error: i18n.t('common:runtimeThreadBusyQueued'),
          runtimeErrorDetail: null
        }))
        runtime.persistActiveQueuedMessages()
        await get().recoverActiveTurn()
        if (
          get().activeThreadId === activeThreadId &&
          get().busy &&
          (
            get().error === null ||
            get().error === runtimeStreamRecoveringMessage() ||
            get().error === i18n.t('common:runtimeThreadBusyQueued')
          )
        ) {
          set({ error: i18n.t('common:runtimeThreadBusyQueued') })
        }
        await get().refreshThreads()
        return true
      }
      if (turnAdmissionOutcomeMayBeUnknown(e)) {
        const view = describeRuntimeError(e)
        set((state) => ({
          blocks: previousBlocks,
          busy: false,
          currentTurnId: previousCurrentTurnId,
          currentTurnOrchestration: previousCurrentTurnOrchestration,
          currentTurnUserId: previousCurrentTurnUserId,
          queuedMessages: startingQueuedSubmission(
            previousQueuedMessages,
            submittedMessageForQueue
          ),
          extensionComposerContexts: withoutConsumedComposerContexts(state, composerContexts),
          error: view.summary,
          runtimeErrorDetail: null
        }))
        runtime.persistActiveQueuedMessages()
        const recovered = await get().recoverActiveTurn()
        if (recovered && submittedMessageForQueue.waitForRuntimeAdmission) {
          settleRuntimeTurnAdmission(clientRequestId, true)
        }
        if (!recovered && get().activeThreadId === activeThreadId) {
          set((state) => ({
            queuedMessages: state.queuedMessages.map((message) =>
              message.id === submittedMessageForQueue.id
                ? pendingQueuedMessage(message)
                : message
            ),
            error: view.summary
          }))
          runtime.persistActiveQueuedMessages()
        }
        await get().refreshThreads()
        return true
      }
      const view = describeRuntimeError(e)
      if (submittedMessageForQueue.waitForRuntimeAdmission) settleRuntimeTurnAdmission(clientRequestId, false)
      set((state) => ({
        blocks: runtimeTurnAccepted
          ? state.blocks
          : [...state.blocks, localConversationErrorBlock(e, `local_error_${userBlockId}`)],
        error: view.summary,
        busy: false,
        currentTurnId: null,
        currentTurnOrchestration: null,
        queuedMessages: submittedMessageForQueue.waitForRuntimeAdmission
          ? previousQueuedMessages.filter((message) => message.id !== submittedMessageForQueue.id)
          : previousQueuedMessages,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      }))
      runtime.persistActiveQueuedMessages()
      await get().refreshThreads()
      return false
    }
}
