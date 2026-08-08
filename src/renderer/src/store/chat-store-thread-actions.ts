import type { ChatBlock, ReviewTarget } from '../agent/types'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import {
  showWorkspaceMissingDialog,
  workspaceDirectoryExists,
  workspaceMissingError
} from '../lib/workspace-availability'
import i18n from '../i18n'
import { applyTheme, applyUiFontScale } from '../lib/apply-theme'
import { formatWorkspacePickerError } from '../lib/format-workspace-picker-error'
import { describeRuntimeError, formatRuntimeError, getRuntimeErrorCode } from '../lib/format-runtime-error'
import {
  deriveThreadTitleFromPrompt,
  getDefaultThreadTitle,
  shouldAutoTitleThread
} from '../lib/thread-title'
import { filterThreadsForSidebar } from '../lib/thread-sidebar-visibility'
import {
  enrichThreadsWithForkInfo,
  forgetThreadFork,
  hydrateThreadForkRegistry,
  markThreadFork,
  readThreadForkRegistry,
  saveThreadForkRegistry
} from '../lib/thread-fork-registry'
import {
  markThreadWorktree,
  saveThreadWorktreeRegistry
} from '../lib/thread-worktree-registry'
import { workspaceLabelFromPath } from '../lib/workspace-label'
import {
  isInternalTemporaryWorkspace,
  normalizeWorkspaceRoot,
  workspaceRootScopeKey
} from '../lib/workspace-path'
import {
  buildClawRuntimePrompt,
  buildCodeRuntimePrompt,
  getActiveAgentApiKey,
  getKunRuntimeSettings
} from '@shared/app-settings'
import type {
  ChatState,
  ChatStoreGet,
  ChatStoreSet,
  WriteAssistantMessageContext
} from './chat-store-types'
import { queuedMessageGuidancePayload } from './queued-message-guidance'
import { currentTurnStartGeneration } from './turn-start-fence'
import {
  isPendingQueuedMessage,
  queuedMessagesForThread,
  reconcileQueuedMessages,
  saveQueuedMessagesForThread
} from './queued-message-persistence'
import {
  accountIdForComposerSelection,
  activeClawChannel,
  compactCodeWorkspaceRoots,
  composerReasoningEffortForSelection,
  forgetCodeWorkspaceRoot,
  hydrateBlockModelLabels,
  isClawThread,
  optimisticUserModelLabel,
  readCodeWorkspaceRoots,
  composerModeForThread,
  readThreadComposerMode,
  rememberCodeWorkspaceRoots,
  rememberThreadComposerSelection,
  rememberTurnModel
} from './chat-store-helpers'
import {
  clearedThreadSelection,
  collectAssistantTextForTurn,
  findLatestUserBlockId,
  findReusableEmptyThreadId,
  reconcileOptimisticUserBlock,
  settlePendingRuntimeWorkAfterInterrupt,
  threadHasPendingRuntimeWork,
  threadSnapshotLooksRunning,
  threadBelongsToWorkspace
} from './chat-store-runtime-helpers'
import {
  WRITE_ASSISTANT_THREAD_TITLE,
  activeWriteThreadForWorkspace,
  forgetWriteThread,
  hydrateWriteThreadRegistry,
  isWriteThreadId,
  markWriteThread,
  pruneWriteThreadRegistry,
  readWriteThreadRegistry,
  saveWriteThreadRegistry,
  writeFileKey,
  writeThreadBelongsToWorkspace,
  writeWorkspaceForThreadId
} from '../write/write-thread-registry'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import { useGraphStore } from '../graph/graph-store'
import {
  clearBusyWatchdog,
  resetBusyRecoveryAttempts,
  scheduleStartupRuntimeProbe,
  stopTurnCompletionPoll
} from './chat-store-schedulers'
import {
  armBusyWatchdog,
  buildFollowupMessageFromUserInput,
  buildThreadEventSink,
  clearWatchedCompletionNotification,
  finalizeTurnTiming,
  flushLiveBlocks,
  forkedMessageCount,
  forkedTurnCount,
  isCodeSidebarThread,
  isCodeThread,
  latestThread,
  looksLikeActiveTurnError,
  readActiveWriteWorkspace,
  readWriteWorkspaceRoots,
  rememberPendingClawFeishuMirror,
  runtimeErrorDetail,
  runtimeStreamRecoveringMessage,
  shouldOpenSettingsForError,
  syncTurnCompletionPoll,
  turnCompleteNotificationSource,
  watchTurnCompletionNotification
} from './chat-store-runtime'
import {
  getThreadSnapshot,
  invalidateThreadSnapshot,
  snapshotThreadProjection
} from './thread-snapshot-cache'
import {
  composerSelectionForThread,
  ensureRuntimeProviderForSend,
  fallbackComposerProviderIdForSend,
  subscribeThreadEventsWithRecovery
} from './chat-store-thread-action-helpers'
import { GitCheckpointAvailabilityCache } from '../lib/git-checkpoint-availability'
import { readDesignThreadRegistry } from '../design/design-thread-registry'
import { readSddThreadRegistry } from '../sdd/sdd-thread-registry'
import type { ComposerContextAttachment } from '@kun/extension-api'

const GUIDED_MESSAGE_RACE_WINDOW_MS = 5_000

function hasRuntimeUserBlockForGuidance(
  blocks: ChatBlock[],
  message: { text: string; displayText?: string },
  turnId: string,
  requestStartedAt: number,
  requestCompletedAt: number
): boolean {
  const expectedTexts = new Set(
    [message.text, message.displayText]
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text))
  )
  return blocks.some((block) => {
    if (
      block.kind !== 'user' ||
      block.id.startsWith('q-') ||
      block.id.startsWith('graph-steering-')
    ) return false
    const blockTurnId = block.turnId?.trim() || block.meta?.turnId?.trim()
    if (blockTurnId !== turnId) return false
    const blockTexts = [block.text, block.meta?.displayText]
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text))
    if (!blockTexts.some((text) => expectedTexts.has(text))) return false
    const createdAt = block.createdAt ? Date.parse(block.createdAt) : Number.NaN
    return Number.isFinite(createdAt) &&
      createdAt >= requestStartedAt - GUIDED_MESSAGE_RACE_WINDOW_MS &&
      createdAt <= requestCompletedAt + GUIDED_MESSAGE_RACE_WINDOW_MS
  })
}

type SseAbortRef = { current: AbortController | null }

type StoreActionContext = {
  set: ChatStoreSet
  get: ChatStoreGet
  sseAbortRef: SseAbortRef
}

let drainingQueuedMessages = false
const guidingQueuedMessageIds = new Set<string>()
const checkpointGitAvailability = new GitCheckpointAvailabilityCache()

function createWorkspaceCheckpointRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  return `gcp_${Date.now()}_${random}`
}

function localConversationErrorBlock(error: unknown, id: string): Extract<ChatBlock, { kind: 'system' }> {
  const view = describeRuntimeError(error)
  return {
    kind: 'system',
    id,
    createdAt: new Date().toISOString(),
    text: view.message,
    ...(view.code ? { code: view.code } : {}),
    ...(view.detail ? { detail: view.detail } : {}),
    severity: 'error',
    runtimeError: true
  }
}

function activeChatWorkspaceRoot(state: ChatState): string {
  const activeThread = state.activeThreadId
    ? state.threads.find((thread) => thread.id === state.activeThreadId)
    : undefined
  return activeThread?.workspace?.trim() || state.workspaceRoot?.trim() || ''
}

function pendingComposerContexts(state: ChatState): ComposerContextAttachment[] {
  if (state.route !== 'chat') return []
  const workspaceRoot = activeChatWorkspaceRoot(state)
  return state.extensionComposerContexts
    .filter((event) => workspaceRootScopeKey(event.workspaceRoot) === workspaceRootScopeKey(workspaceRoot))
    .map((event) => event.attachment)
}

function withoutConsumedComposerContexts(
  state: ChatState,
  consumed: readonly ComposerContextAttachment[]
): ChatState['extensionComposerContexts'] {
  if (consumed.length === 0) return state.extensionComposerContexts
  const consumedRevisions = new Set(consumed.map((attachment) => [
    attachment.attachmentId,
    attachment.revision,
    attachment.generation
  ].join(':')))
  return state.extensionComposerContexts.filter((event) => !consumedRevisions.has([
    event.attachment.attachmentId,
    event.attachment.revision,
    event.attachment.generation
  ].join(':')))
}

function activeWriteMessageContextMatches(context: WriteAssistantMessageContext): boolean {
  const state = useWriteWorkspaceStore.getState()
  return (
    writeFileKey(state.workspaceRoot) === writeFileKey(context.workspaceRoot) &&
    writeFileKey(state.activeFilePath) === writeFileKey(context.activeFilePath) &&
    state.documentEpoch === context.documentEpoch &&
    state.contentRevision === context.contentRevision &&
    state.saveStatus === 'saved' &&
    state.fileContent === state.persistedContent &&
    state.pendingAgentReview === null &&
    !state.reviewActive
  )
}

export function createThreadActions(
  { set, get, sseAbortRef }: StoreActionContext
): Pick<ChatState, 'createThread' | 'createConversation' | 'recoverActiveTurn' | 'selectThread' | 'subscribeThreadEventsLive' | 'drainQueuedMessages' | 'removeQueuedMessage' | 'reorderQueuedMessage' | 'guideQueuedMessage' | 'sendMessage' | 'reviewActiveThread'> {
  let threadSelectionGeneration = 0
  const persistActiveQueuedMessages = (): void => {
    const state = get()
    if (state.activeThreadId) {
      saveQueuedMessagesForThread(state.activeThreadId, state.queuedMessages)
    }
  }

  return {
  createThread: async (options = {}) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return null
    }
    try {
      const p = getProvider()
      const settings = await rendererRuntimeClient.getSettings()
      const runtime = getKunRuntimeSettings(settings)
      const activeThread = get().activeThreadId
        ? get().threads.find((thread) => thread.id === get().activeThreadId)
        : null
      const pickedAgentId = options.agentId?.trim() || get().composerAgentId?.trim() || ''
      const personaProfile = pickedAgentId
        ? settings.agents?.kun?.subagents?.profiles?.find(
          (profile) => profile.id === pickedAgentId &&
            profile.enabled &&
            (profile.mode === 'primary' || profile.mode === 'all')
        )
        : undefined
      const initialModel = personaProfile?.model?.trim() || runtime.model.trim()
      const initialProviderId = personaProfile?.providerId?.trim() ||
        (personaProfile?.model?.trim() ? '' : runtime.providerId.trim())
      const initialSelectionSource = personaProfile ? 'user' as const : 'default' as const

      // 对话会话:不绑定项目文件夹,在 conversationWorkspaceRoot 下自动创建
      // 一个时间戳子目录作为工作目录(主进程负责实际建目录)。
      if (options.conversation) {
        if (typeof window.kunGui === 'undefined' || typeof window.kunGui.createConversationWorkspace !== 'function') {
          set({ error: i18n.t('common:workspacePickerUnavailable') })
          return null
        }
        const created = await window.kunGui.createConversationWorkspace(
          settings.conversationWorkspaceRoot || undefined
        )
        if (!created.ok || !created.path) {
          set({ error: created.error || i18n.t('common:worktreeAcquireFailed') })
          return null
        }
        const t = await p.createThread({
          workspace: created.path,
          title: getDefaultThreadTitle(),
          mode: 'agent',
          ...(initialProviderId ? { providerId: initialProviderId } : {}),
          ...(initialModel ? { model: initialModel } : {}),
          ...(personaProfile ? {
            agentId: personaProfile.id,
            ...(personaProfile.systemPrompt ? { systemPrompt: personaProfile.systemPrompt } : {})
          } : {})
        })
        if (initialModel) {
          rememberThreadComposerSelection(
            t.id,
            initialModel,
            initialProviderId,
            initialSelectionSource
          )
        }
        set((s) => ({
          activeThreadId: t.id,
          threads: s.threads.some((thread) => thread.id === t.id) ? s.threads : [t, ...s.threads]
        }))
        await get().selectThread(t.id)
        await get().refreshThreads()
        return t.id
      }

      let workspaceRoot =
        normalizeWorkspaceRoot(options.workspaceRoot) ||
        (activeThread && !isInternalTemporaryWorkspace(activeThread.workspace)
          ? normalizeWorkspaceRoot(activeThread.workspace)
          : '') ||
        normalizeWorkspaceRoot(settings.workspaceRoot)
      if (!workspaceRoot) {
        await get().chooseWorkspace({ createThreadAfter: true })
        return null
      }
      if (!(await workspaceDirectoryExists(workspaceRoot))) {
        set({ error: workspaceMissingError() })
        await showWorkspaceMissingDialog(workspaceRoot)
        return null
      }
      const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
      set({ codeWorkspaceRoots })
      // Worktree pool mode always needs a fresh thread bound to a fresh pool
      // slot, so never reuse an existing main-workspace thread in that case.
      const reusableThreadId = options.forceNew || options.useWorktreePool || personaProfile
        ? null
        : await findReusableEmptyThreadId(
            get(),
            p,
            workspaceRoot,
            (thread) => isCodeThread(thread, get().clawChannels)
          )
      if (reusableThreadId) {
        if (initialModel) {
          rememberThreadComposerSelection(
            reusableThreadId,
            initialModel,
            initialProviderId,
            'default'
          )
        }
        if (get().activeThreadId !== reusableThreadId) {
          await get().selectThread(reusableThreadId)
        } else {
          set({
            error: null,
            ...(initialModel
              ? {
                  composerModel: initialModel,
                  composerProviderId: initialProviderId,
                  composerReasoningEffort: composerReasoningEffortForSelection(
                    get().composerModelGroups,
                    initialModel,
                    initialProviderId
                  )
                }
              : {})
          })
        }
        return reusableThreadId
      }
      // Worktree mode: checkout the selected branch into an isolated worktree
      // and bind the new thread to that workspace.
      let acquiredWorktree: { projectPath: string; path: string; branch: string } | null = null
      if (options.useWorktreePool) {
        try {
          let branch = options.worktreeBranch?.trim() ?? ''
          if (!branch) {
            const branches = await window.kunGui.getGitBranches(workspaceRoot)
            if (branches.ok) branch = branches.currentBranch ?? ''
          }
          if (!branch) {
            throw new Error(i18n.t('common:worktreeBranchRequired'))
          }
          const wt = await window.kunGui.checkoutGitBranchWorktree(workspaceRoot, branch)
          if (!wt.ok) {
            throw new Error(wt.message)
          }
          acquiredWorktree = {
            projectPath: wt.sourceRepositoryRoot,
            path: wt.worktreePath,
            branch: wt.currentBranch ?? branch
          }
          workspaceRoot = wt.worktreePath
        } catch (err) {
          set({ error: err instanceof Error ? err.message : i18n.t('common:worktreeAcquireFailed') })
          return null
        }
      }
      // Primary-agent persona snapshot: bind this thread to the picked
      // subagent profile and freeze its providerId / model / systemPrompt
      // at create time so later agent edits don't drift the thread.
      const t = await p.createThread({
        workspace: workspaceRoot,
        title: getDefaultThreadTitle(),
        mode: 'agent',
        ...(initialProviderId ? { providerId: initialProviderId } : {}),
        ...(initialModel ? { model: initialModel } : {}),
        ...(personaProfile ? {
          agentId: personaProfile.id,
          ...(personaProfile.systemPrompt ? { systemPrompt: personaProfile.systemPrompt } : {})
        } : {})
      })
      if (initialModel) {
        rememberThreadComposerSelection(
          t.id,
          initialModel,
          initialProviderId,
          initialSelectionSource
        )
      }
      // Register + activate optimistically before refreshing. A freshly created
      // Kun thread may not be listed until the first message is written.
      // Setting it active first lets refreshThreads preserve it in the sidebar.
      set((s) => ({
        activeThreadId: t.id,
        codeWorkspaceRoots: rememberCodeWorkspaceRoots(
          s.codeWorkspaceRoots,
          [acquiredWorktree?.projectPath ?? workspaceRoot]
        ),
        threads: s.threads.some((thread) => thread.id === t.id) ? s.threads : [t, ...s.threads]
      }))
      await get().selectThread(t.id)
      if (acquiredWorktree) {
        saveThreadWorktreeRegistry(
          markThreadWorktree(t.id, {
            projectPath: acquiredWorktree.projectPath,
            worktreePath: acquiredWorktree.path,
            branch: acquiredWorktree.branch,
            createdAt: new Date().toISOString()
          })
        )
      }
      await get().refreshThreads()
      return t.id
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return null
    }
  },

  createConversation: async () => {
    await get().createThread({ conversation: true })
  },

  recoverActiveTurn: async () => {
    const state = get()
    if (!state.activeThreadId) return false
    const { activeThreadId } = state
    // Recovery results are bound to the thread selected when the request
    // started. If the user switches to another thread or starts a newer turn
    // while the detail is in flight, never commit this stale projection.
    const recoveryGeneration = ++threadSelectionGeneration
    const recoveryStillCurrent = (): boolean =>
      recoveryGeneration === threadSelectionGeneration &&
      get().activeThreadId === activeThreadId
    const p = getProvider()
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    clearBusyWatchdog()
    set({ error: runtimeStreamRecoveringMessage() })
    try {
      const {
        blocks: rawBlocks,
        latestSeq,
        threadStatus,
        latestTurnId,
        latestTurnStatus,
        latestTurnOrchestration,
        latestUserMessageId,
        turnDurationByUserId = {},
        goal,
        todos
      } = await p.getThreadDetail(activeThreadId)
      if (!recoveryStillCurrent()) return state.busy
      const loaded = hydrateBlockModelLabels(activeThreadId, rawBlocks)
      const busy = threadSnapshotLooksRunning(loaded, threadStatus, latestTurnStatus)
      // The server has settled but a tool/approval/user_input block may still be
      // open (e.g. a delegate_task interrupted by a runtime restart). Settle it,
      // otherwise threadHasPendingRuntimeWork stays true and the queued message
      // we are recovering re-queues forever instead of draining (KunAgent/Kun#621).
      const blocks = busy ? loaded : settlePendingRuntimeWorkAfterInterrupt(loaded)
      const currentTurnUserId = busy
        ? state.currentTurnUserId ?? latestUserMessageId ?? findLatestUserBlockId(blocks)
        : null
      // The detail response is authoritative for the running turn; a stale local
      // currentTurnId from a previous recovery attempt must not win over it.
      const currentTurnId = busy ? latestTurnId ?? state.currentTurnId ?? null : null
      const durableQueuedMessages = queuedMessagesForThread(activeThreadId)
      const queuedMessages = reconcileQueuedMessages(
        state.queuedMessages.length > 0 ? state.queuedMessages : durableQueuedMessages,
        { busy, turnId: currentTurnId, blocks }
      )

      set((snapshot) => {
        const watchTurnCompletion = { ...(snapshot.watchTurnCompletion ?? {}) }
        if (!busy) {
          delete watchTurnCompletion[activeThreadId]
          clearWatchedCompletionNotification(activeThreadId)
          invalidateThreadSnapshot(activeThreadId)
        }
        return {
          activeThreadId,
          activeThreadGoal: goal ?? null,
          activeThreadTodos: todos ?? null,
          blocks,
          lastSeq: latestSeq,
          // Re-baseline the shared delta floor to this subscription's since_seq,
          // in lockstep with the liveAssistant reset below.
          liveDeltaSeqFloor: latestSeq,
          liveReasoning: '',
          liveAssistant: '',
          error: busy ? runtimeStreamRecoveringMessage() : null,
          busy,
          currentTurnId,
          currentTurnOrchestration: busy ? latestTurnOrchestration ?? 'direct' : null,
          currentTurnUserId,
          turnDurationByUserId,
          queuedMessages,
          watchTurnCompletion,
          threads: snapshot.threads.map((thread) => thread.id === activeThreadId
            ? {
                ...thread,
                status: thread.archived ? thread.status : busy ? 'running' : 'idle',
                ...(latestTurnId ? { latestTurnId } : {}),
                ...(latestTurnStatus ? { latestTurnStatus } : {})
              }
            : thread)
        }
      })
      saveQueuedMessagesForThread(activeThreadId, queuedMessages)

      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: activeThreadId, signal: ac.signal, sinceSeq: latestSeq })
      subscribeThreadEventsWithRecovery(p, activeThreadId, latestSeq, sink, ac.signal, get)
      if (busy) {
        armBusyWatchdog(set, get)
      } else {
        resetBusyRecoveryAttempts()
        if (get().queuedMessages.length > 0) {
          void get().drainQueuedMessages()
        }
      }
      return busy
    } catch (e) {
      if (!recoveryStillCurrent()) return state.busy
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      if (state.busy) armBusyWatchdog(set, get)
      return state.busy
    }
  },

  selectThread: async (id) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const selectionGeneration = ++threadSelectionGeneration
    const previousState = get()
    const prevId = previousState.activeThreadId
    const prevBusy = previousState.busy
    const selectionStillCurrent = (): boolean => {
      if (selectionGeneration !== threadSelectionGeneration) return false
      return get().activeThreadId === id
    }
    let nextWatch = { ...get().watchTurnCompletion }
    delete nextWatch[id]
    clearWatchedCompletionNotification(id)
    if (prevId && prevId !== id && prevBusy) {
      nextWatch[prevId] = true
      watchTurnCompletionNotification(
        prevId,
        Date.now(),
        turnCompleteNotificationSource(prevId, previousState)
      )
    }
    const nextUnread = { ...get().unreadThreadIds }
    delete nextUnread[id]

    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    const p = getProvider()
    const durableQueuedMessages = queuedMessagesForThread(id)
    // Park the outgoing renderer projection before its state is replaced. This
    // is intentionally O(1): blocks stay immutable while another thread is
    // active, so no expensive JSON serialization runs on the click path.
    if (prevId && prevId !== id) snapshotThreadProjection(previousState)
    // Re-selecting the active conversation is an explicit refresh (and is
    // used by recovery paths to pick up durable queues), so only cross-thread
    // navigation may consume an in-memory snapshot.
    const cached = prevId !== id ? getThreadSnapshot(id) : null
    const targetThread = get().threads.find((thread) => thread.id === id) ?? null
    resetBusyRecoveryAttempts()
    clearBusyWatchdog()
    if (cached) {
      const queuedMessages = reconcileQueuedMessages(cached.queuedMessages, {
        busy: cached.busy,
        turnId: cached.currentTurnId ?? undefined,
        blocks: cached.blocks
      })
      const remembersCodeThread = targetThread != null &&
        targetThread.archived !== true &&
        isCodeSidebarThread(
          targetThread,
          get().clawChannels,
          readWriteThreadRegistry(),
          readDesignThreadRegistry(),
          readSddThreadRegistry()
        )
      set((state) => ({
        watchTurnCompletion: nextWatch,
        unreadThreadIds: nextUnread,
        activeThreadId: id,
        threadLoadingId: null,
        activeThreadRelation: cached.activeThreadRelation ?? 'primary',
        activeThreadParentId: cached.activeThreadParentId,
        activeThreadGoal: cached.activeThreadGoal,
        activeThreadTodos: cached.activeThreadTodos,
        blocks: cached.blocks,
        lastSeq: cached.lastSeq,
        liveDeltaSeqFloor: cached.liveDeltaSeqFloor,
        liveReasoning: cached.liveReasoning,
        liveAssistant: cached.liveAssistant,
        error: null,
        busy: cached.busy,
        currentTurnId: cached.currentTurnId,
        currentTurnOrchestration: cached.currentTurnOrchestration,
        currentTurnUserId: cached.currentTurnUserId,
        turnStartedAtByUserId: cached.turnStartedAtByUserId,
        turnDurationByUserId: cached.turnDurationByUserId,
        turnReasoningFirstAtByUserId: cached.turnReasoningFirstAtByUserId,
        turnReasoningLastAtByUserId: cached.turnReasoningLastAtByUserId,
        inspectorSelectedId: null,
        queuedMessages,
        composerMode: cached.composerMode,
        composerModel: cached.composerModel,
        composerProviderId: cached.composerProviderId,
        composerReasoningEffort: cached.composerReasoningEffort,
        threads: state.threads.map((thread) => thread.id === id
          ? { ...thread, status: cached.busy ? 'running' : 'idle' }
          : thread),
        ...(remembersCodeThread ? { lastCodeThreadId: id } : {})
      }))
      saveQueuedMessagesForThread(id, queuedMessages)
      syncTurnCompletionPoll(set, get)
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: id, signal: ac.signal, sinceSeq: cached.lastSeq })
      subscribeThreadEventsWithRecovery(p, id, cached.lastSeq, sink, ac.signal, get)
      if (cached.busy) armBusyWatchdog(set, get)
      else if (queuedMessages.some(isPendingQueuedMessage)) void get().drainQueuedMessages()
      return
    }
    // Give the sidebar its selected state in this render frame. The timeline
    // shows a skeleton and the composer is disabled until detail hydration
    // commits, preventing sends against an unhydrated thread.
    set({
      watchTurnCompletion: nextWatch,
      unreadThreadIds: nextUnread,
      activeThreadId: id,
      threadLoadingId: id,
      activeThreadRelation: targetThread?.relation ?? 'primary',
      activeThreadParentId: targetThread?.parentThreadId ?? null,
      activeThreadGoal: targetThread?.goal ?? null,
      activeThreadTodos: targetThread?.todos ?? null,
      blocks: [],
      lastSeq: 0,
      liveDeltaSeqFloor: 0,
      liveReasoning: '',
      liveAssistant: '',
      busy: false,
      currentTurnId: null,
      currentTurnOrchestration: null,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      inspectorSelectedId: null,
      queuedMessages: [],
      error: null
    })
    try {
      const {
        blocks: rawBlocks,
        latestSeq,
        threadStatus,
        latestTurnId,
        latestTurnStatus,
        latestTurnOrchestration,
        latestUserMessageId,
        turnDurationByUserId = {},
        usage: threadUsage,
        relation: threadRelation,
        parentThreadId: threadParentId,
        model: threadModel,
        goal,
        todos,
        payloadBytes
      } = await p.getThreadDetail(id)
      if (!selectionStillCurrent()) return
      // A subagent's `side` thread has no locally-stored per-turn model labels
      // (it was never sent through the composer). Backfill the user blocks with
      // the child thread's resolved model so the session shows "which model",
      // matching the main conversation. Safe: a child runs on a single model.
      const labeledBlocks =
        threadRelation === 'side' && threadModel
          ? rawBlocks.map((block) =>
              block.kind === 'user' && !block.modelLabel
                ? { ...block, modelLabel: threadModel }
                : block
            )
          : rawBlocks
      const loaded = hydrateBlockModelLabels(id, labeledBlocks)
      const busy = threadSnapshotLooksRunning(loaded, threadStatus, latestTurnStatus)
      // Settle blocks left open by an interrupted turn when the server has
      // already settled, so selecting the thread doesn't keep it wedged (#621).
      const blocks = busy ? loaded : settlePendingRuntimeWorkAfterInterrupt(loaded)
      const currentTurnUserId = busy
        ? latestUserMessageId ?? findLatestUserBlockId(blocks)
        : null
      const threadSnap = get().threads.find((thread) => thread.id === id) ?? null
      // Code 工作台返回记忆:记录最近一次在 chat 路由选中的 Code/需求 AI 会话,
      // 供从设置、Write/Design 或 Connect Phone 返回时恢复。Write/Design/Claw
      // 会话以及已归档会话不写入记忆。
      const remembersCodeThread = threadSnap != null &&
        threadSnap.archived !== true &&
        isCodeSidebarThread(
          threadSnap,
          get().clawChannels,
          readWriteThreadRegistry(),
          readDesignThreadRegistry(),
          readSddThreadRegistry()
        )
      const composerSelection = composerSelectionForThread(get(), threadSnap, {
        hasUserMessages: rawBlocks.some((block) => block.kind === 'user'),
        runtimeModel: threadModel
      })
      const composerMode = composerModeForThread(threadSnap, readThreadComposerMode(id))
      const queuedMessages = reconcileQueuedMessages(durableQueuedMessages, {
        busy,
        turnId: latestTurnId,
        blocks
      })
      set({
        watchTurnCompletion: nextWatch,
        unreadThreadIds: nextUnread,
        activeThreadId: id,
        threadLoadingId: null,
        activeThreadRelation: threadRelation ?? 'primary',
        activeThreadParentId: threadParentId ?? null,
        activeThreadGoal: goal ?? null,
        activeThreadTodos: todos ?? null,
        blocks,
        lastSeq: latestSeq,
        liveDeltaSeqFloor: latestSeq,
        liveReasoning: '',
        liveAssistant: '',
        error: null,
        busy,
        currentTurnId: busy ? latestTurnId ?? null : null,
        currentTurnOrchestration: busy ? latestTurnOrchestration ?? 'direct' : null,
        currentTurnUserId,
        turnStartedAtByUserId: {},
        turnDurationByUserId,
        turnReasoningFirstAtByUserId: {},
        turnReasoningLastAtByUserId: {},
        inspectorSelectedId: null,
        queuedMessages,
        composerMode,
        threads: get().threads.map((thread) => thread.id === id
          ? {
              ...thread,
              status: thread.archived ? thread.status : (busy ? 'running' : 'idle'),
              ...(latestTurnStatus ? { latestTurnStatus } : {})
            }
          : thread),
        ...(remembersCodeThread ? { lastCodeThreadId: id } : {}),
        ...(composerSelection
          ? {
              composerModel: composerSelection.model,
              composerProviderId: composerSelection.providerId,
              composerReasoningEffort: composerReasoningEffortForSelection(
                get().composerModelGroups,
                composerSelection.model,
                composerSelection.providerId
              )
            }
          : {})
      })
      snapshotThreadProjection(get(), payloadBytes)
      saveQueuedMessagesForThread(id, queuedMessages)
      syncTurnCompletionPoll(set, get)
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: id, signal: ac.signal, sinceSeq: latestSeq })
      subscribeThreadEventsWithRecovery(p, id, latestSeq, sink, ac.signal, get)
      if (busy) {
        armBusyWatchdog(set, get)
      } else if (queuedMessages.some(isPendingQueuedMessage)) {
        void get().drainQueuedMessages()
      }
    } catch (e) {
      if (!selectionStillCurrent()) return
      set({
        threadLoadingId: null,
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  subscribeThreadEventsLive: async (threadId) => {
    if (get().runtimeConnection !== 'ready') return
    const targetThreadId = threadId.trim()
    if (!targetThreadId) return
    threadSelectionGeneration += 1
    // Live-only entry point for claw channel events (e.g. Feishu / Lark bot
    // replies). Hydrate the canonical persisted snapshot first, then subscribe
    // from exactly that snapshot's latestSeq. Events committed after the HTTP
    // snapshot are replayed by the persisted SSE route, closing the hydrate /
    // subscribe window without replaying historical non-delta lifecycle events
    // over terminal snapshot state.
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    const p = getProvider()
    const prevState = get()
    // Same-thread fallback retains a projection that matches its cursor if the
    // snapshot request fails. Cross-thread fallback starts from an empty
    // projection/cursor and can safely replay from zero.
    const keepExistingBlocks = prevState.activeThreadId === targetThreadId
    const fallbackSinceSeq = keepExistingBlocks ? prevState.lastSeq : 0
    resetBusyRecoveryAttempts()
    clearBusyWatchdog()
    set({
      activeThreadId: targetThreadId,
      threadLoadingId: null,
      blocks: keepExistingBlocks ? prevState.blocks : [],
      lastSeq: fallbackSinceSeq,
      liveDeltaSeqFloor: fallbackSinceSeq,
      liveReasoning: '',
      liveAssistant: '',
      unreadThreadIds: { ...prevState.unreadThreadIds, [targetThreadId]: false },
      busy: true,
      currentTurnId: null,
      currentTurnOrchestration:
        keepExistingBlocks && prevState.busy ? prevState.currentTurnOrchestration : null,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      inspectorSelectedId: null,
      queuedMessages: keepExistingBlocks
        ? prevState.queuedMessages
        : queuedMessagesForThread(targetThreadId)
    })
    const ac = new AbortController()
    sseAbortRef.current = ac
    const subscribeFrom = (sinceSeq: number): void => {
      const sink = buildThreadEventSink(set, get, {
        threadId: targetThreadId,
        signal: ac.signal,
        sinceSeq
      })
      subscribeThreadEventsWithRecovery(p, targetThreadId, sinceSeq, sink, ac.signal, get)
    }
    try {
      const {
        blocks: rawBlocks,
        latestSeq,
        threadStatus,
        latestTurnId,
        latestTurnStatus,
        latestTurnOrchestration,
        latestUserMessageId,
        turnDurationByUserId = {},
        goal,
        todos
      } = await p.getThreadDetail(targetThreadId)
      if (ac.signal.aborted) return
      const loaded = hydrateBlockModelLabels(targetThreadId, rawBlocks)
      const busy = threadSnapshotLooksRunning(loaded, threadStatus, latestTurnStatus)
      // Settle blocks left open by an interrupted turn when the server has
      // already settled, so the thread doesn't stay wedged on load (#621).
      const blocks = busy ? loaded : settlePendingRuntimeWorkAfterInterrupt(loaded)
      const currentTurnUserId = busy
        ? latestUserMessageId ?? findLatestUserBlockId(blocks)
        : null
      const queuedMessages = reconcileQueuedMessages(get().queuedMessages, {
        busy,
        turnId: latestTurnId,
        blocks
      })
      set({
        activeThreadGoal: goal ?? null,
        activeThreadTodos: todos ?? null,
        blocks,
        lastSeq: latestSeq,
        liveDeltaSeqFloor: latestSeq,
        busy,
        currentTurnId: busy ? latestTurnId ?? null : null,
        currentTurnOrchestration: busy ? latestTurnOrchestration ?? 'direct' : null,
        currentTurnUserId,
        turnDurationByUserId,
        queuedMessages,
        threads: get().threads.map((thread) => thread.id === targetThreadId
          ? {
              ...thread,
              status: thread.archived ? thread.status : busy ? 'running' : 'idle',
              ...(latestTurnId ? { latestTurnId } : {}),
              ...(latestTurnStatus ? { latestTurnStatus } : {})
            }
          : thread)
      })
      saveQueuedMessagesForThread(targetThreadId, queuedMessages)
      // The server replays every event persisted after latestSeq, including
      // events committed while getThreadDetail was in flight.
      subscribeFrom(latestSeq)
      if (busy) armBusyWatchdog(set, get)
      if (!busy && queuedMessages.some(isPendingQueuedMessage)) {
        void get().drainQueuedMessages()
      }
    } catch (e) {
      if (ac.signal.aborted) return
      // The fallback cursor matches the projection installed above, so this
      // cannot replay older lifecycle records over newer on-screen state.
      subscribeFrom(fallbackSinceSeq)
      if (get().busy) armBusyWatchdog(set, get)
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  drainQueuedMessages: async () => {
    if (drainingQueuedMessages) return
    drainingQueuedMessages = true
    try {
      while (true) {
        let state = get()
        const queuedMessages = reconcileQueuedMessages(state.queuedMessages, {
          busy: state.busy,
          turnId: state.currentTurnId,
          blocks: state.blocks
        })
        const queueChanged =
          queuedMessages.length !== state.queuedMessages.length ||
          queuedMessages.some((message, index) => message !== state.queuedMessages[index])
        if (queueChanged) {
          set({ queuedMessages })
          persistActiveQueuedMessages()
          state = get()
        }
        const next = queuedMessages.find(isPendingQueuedMessage)
        if (!next || state.busy) return
        const started = await get().sendMessage(next.text, next.mode, { queued: next })
        if (!started) return
      }
    } finally {
      drainingQueuedMessages = false
    }
  },

  removeQueuedMessage: (id) => {
    set((s) => ({
      queuedMessages: s.queuedMessages.filter((message) => message.id !== id)
    }))
    persistActiveQueuedMessages()
  },

  reorderQueuedMessage: (id, targetId, position) => {
    set((state) => {
      if (id === targetId) return {}
      const sourceIndex = state.queuedMessages.findIndex((message) => message.id === id)
      const targetIndex = state.queuedMessages.findIndex((message) => message.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return {}

      const queuedMessages = [...state.queuedMessages]
      const [message] = queuedMessages.splice(sourceIndex, 1)
      if (!message) return {}
      const remainingTargetIndex = queuedMessages.findIndex((candidate) => candidate.id === targetId)
      const insertionIndex = remainingTargetIndex + (position === 'after' ? 1 : 0)
      queuedMessages.splice(insertionIndex, 0, message)
      if (queuedMessages.every((candidate, index) => candidate === state.queuedMessages[index])) {
        return {}
      }
      return { queuedMessages }
    })
    persistActiveQueuedMessages()
  },

  guideQueuedMessage: async (id) => {
    if (guidingQueuedMessageIds.has(id)) return false
    const state = get()
    const message = state.queuedMessages.find((candidate) => candidate.id === id)
    if (!message) return false
    if (message.deliveryState === 'paused') {
      if (state.busy) return false
      set((current) => ({
        queuedMessages: current.queuedMessages.map((candidate) => candidate.id === id
          ? { ...candidate, deliveryState: 'pending' as const }
          : candidate)
      }))
      persistActiveQueuedMessages()
      await get().drainQueuedMessages()
      return true
    }
    const guidance = queuedMessageGuidancePayload(message)
    if (!guidance) {
      set({ error: i18n.t('common:guideQueuedMessageTextOnly') })
      return false
    }
    if (!state.busy || !state.activeThreadId || !state.currentTurnId) {
      set({ error: i18n.t('common:guideQueuedMessageNoActiveTurn') })
      if (!state.busy) void get().drainQueuedMessages()
      return false
    }
    const guidanceThreadId = state.activeThreadId
    const guidanceTurnId = state.currentTurnId
    const guidingGraphTurn = state.currentTurnOrchestration === 'graph'
    const delegated = state.lastDelegatedRuntimeState
    if (
      !guidingGraphTurn &&
      delegated?.threadId === guidanceThreadId &&
      delegated.turnId === guidanceTurnId &&
      delegated.capabilities.liveSteering === false
    ) {
      set({ error: i18n.t('common:guideQueuedMessageUnsupported') })
      return false
    }
    const provider = getProvider()
    if (!guidingGraphTurn && typeof provider.steerUserMessage !== 'function') {
      set({ error: i18n.t('common:guideQueuedMessageUnsupported') })
      return false
    }

    guidingQueuedMessageIds.add(id)
    const requestStartedAt = Date.now()
    try {
      const graphSteered = guidingGraphTurn
        ? await useGraphStore.getState().steerSourceTurn(
            guidanceThreadId,
            guidanceTurnId,
            guidance.text
          )
        : false
      if (!graphSteered) {
        if (typeof provider.steerUserMessage !== 'function') {
          set({ error: i18n.t('common:guideQueuedMessageUnsupported') })
          return false
        }
        await provider.steerUserMessage(
          guidanceThreadId,
          guidanceTurnId,
          guidance.text,
          guidance.displayText ? { displayText: guidance.displayText } : undefined
        )
      }
      const requestCompletedAt = Date.now()
      if (get().activeThreadId !== guidanceThreadId) {
        const durableQueuedMessages = queuedMessagesForThread(guidanceThreadId)
        saveQueuedMessagesForThread(
          guidanceThreadId,
          (durableQueuedMessages.length > 0
            ? durableQueuedMessages
            : state.queuedMessages
          ).filter((candidate) => candidate.id !== id)
        )
        return true
      }
      set((current) => {
        const stillQueued = current.queuedMessages.some((candidate) => candidate.id === id)
        if (!stillQueued) return { error: null }
        const runtimeMessageAlreadyVisible = hasRuntimeUserBlockForGuidance(
          current.blocks,
          guidance,
          guidanceTurnId,
          requestStartedAt,
          requestCompletedAt
        )
        const displayText = guidance.displayText ?? guidance.text
        return {
          queuedMessages: current.queuedMessages.filter((candidate) => candidate.id !== id),
          blocks: runtimeMessageAlreadyVisible
            ? current.blocks
            : [
                ...current.blocks,
                {
                  kind: 'user' as const,
                  id: message.id,
                  turnId: guidanceTurnId,
                  createdAt: new Date(requestCompletedAt).toISOString(),
                  text: displayText,
                  ...(message.modelLabel ? { modelLabel: message.modelLabel } : {}),
                  ...(guidance.displayText && guidance.displayText !== guidance.text
                    ? { meta: { displayText: guidance.displayText } }
                    : {})
                }
              ],
          error: null
        }
      })
      persistActiveQueuedMessages()
      return true
    } catch (error) {
      const messageText = formatRuntimeError(error)
      set({
        error: i18n.t('common:guideQueuedMessageFailed', { message: messageText })
      })
      if (!get().busy) void get().drainQueuedMessages()
      return false
    } finally {
      guidingQueuedMessageIds.delete(id)
    }
  },

  sendMessage: async (text, mode, overrides) => {
    const trimmedText = text.trim()
    if (!trimmedText) return false
    const queued = overrides?.queued
    const expectedThreadId = (queued?.expectedThreadId ?? overrides?.expectedThreadId ?? '').trim()
    const requestedAgentSurface = queued?.agentSurface ?? overrides?.agentSurface
    const expectedThreadStillActive = (): boolean => Boolean(
      !expectedThreadId ||
      (
        get().activeThreadId === expectedThreadId &&
        (requestedAgentSurface !== 'design' || get().route === 'design')
      )
    )
    let writeContext = queued?.writeContext ?? overrides?.writeContext
    const requireActiveWriteContext = Boolean(writeContext && !queued)
    const activeWriteContextIsValid = (): boolean => Boolean(
      !writeContext ||
      !requireActiveWriteContext ||
      (get().route === 'write' && activeWriteMessageContextMatches(writeContext))
    )
    if (!activeWriteContextIsValid()) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    if (!expectedThreadStillActive()) {
      set({
        error: i18n.t('common:designThreadChangedBeforeSend')
      })
      return false
    }
    if (get().route !== 'claw') {
      const state = get()
      const activeThread = state.activeThreadId
        ? state.threads.find((thread) => thread.id === state.activeThreadId) ?? null
        : null
      let workspaceRoot = writeContext
        ? normalizeWorkspaceRoot(writeContext.workspaceRoot)
        : state.route === 'write'
          ? await readActiveWriteWorkspace(state.workspaceRoot)
          : normalizeWorkspaceRoot(activeThread?.workspace)
      if (!activeWriteContextIsValid()) return false
      if (!workspaceRoot) {
        workspaceRoot = normalizeWorkspaceRoot((await rendererRuntimeClient.getSettings()).workspaceRoot)
        if (!activeWriteContextIsValid()) return false
      }
      if (workspaceRoot && !(await workspaceDirectoryExists(workspaceRoot))) {
        set({ error: workspaceMissingError() })
        await showWorkspaceMissingDialog(workspaceRoot)
        return false
      }
      if (!activeWriteContextIsValid()) return false
    }
    const p = getProvider()
    if (writeContext || get().route === 'write') {
      const writeThreadId = await get().ensureWriteThreadForWorkspace(
        writeContext?.workspaceRoot,
        writeContext ? writeContext.activeFilePath ?? '' : undefined
      )
      if (!writeThreadId) return false
      if (writeContext?.threadId && writeThreadId !== writeContext.threadId) return false
      // ensureWriteThreadForWorkspace may await selectThread. If the user
      // selects another conversation before it resolves, never fall through to
      // the provider with that newer activeThreadId.
      if (get().activeThreadId !== writeThreadId) return false
      if (writeContext && !writeContext.threadId) {
        writeContext = { ...writeContext, threadId: writeThreadId }
      }
      if (!activeWriteContextIsValid()) return false
    }
    const hasPendingActiveTurn = threadHasPendingRuntimeWork(get().blocks)
    if (get().busy || hasPendingActiveTurn) {
      const state = get()
      // Write keeps a file-identity contract that cannot safely survive a
      // deferred queue. Plan turns may queue like normal chat messages.
      if (writeContext) {
        set({ error: i18n.t('common:composerQueuePlaceholder') })
        return false
      }
      const now = Date.now()
      const activeThreadId = state.activeThreadId
      const threadSnap = activeThreadId
        ? state.threads.find((thread) => thread.id === activeThreadId)
        : undefined
      const clawModel = activeClawChannel(state)?.model
      const overrideModel = overrides?.model?.trim()
      const composerModel =
        overrideModel ?? (state.route === 'claw' && clawModel ? clawModel : state.composerModel.trim())
      const composerProviderId =
        overrides?.providerId?.trim() || fallbackComposerProviderIdForSend(state)
      const composerAccountId = overrides?.accountId?.trim() || accountIdForComposerSelection(
        state.composerModelGroups,
        composerProviderId,
        composerModel
      )
      const userModelChip =
        overrides?.modelLabel ?? optimisticUserModelLabel(composerModel, threadSnap?.model)
      const displayText = overrides?.displayText?.trim()
      const reasoningEffort = overrides?.reasoningEffort?.trim()
      const serviceTier = overrides?.serviceTier === 'priority' ? 'priority' as const : undefined
      const attachmentIds = overrides?.attachmentIds?.filter((id) => id.trim().length > 0)
      const attachments = overrides?.attachments?.filter((attachment) => attachment.id.trim().length > 0)
      const fileReferences = overrides?.fileReferences?.filter((reference) =>
        reference.path.trim().length > 0 &&
        reference.relativePath.trim().length > 0 &&
        reference.name.trim().length > 0
      )
      const composerContexts = state.route === 'chat'
        ? overrides?.composerContexts ?? pendingComposerContexts(state)
        : []
      const orchestration = overrides?.orchestration ??
        (mode === 'agent' && state.route === 'chat' && state.graphEnabled
          ? state.composerOrchestration
          : 'direct')
      set((s) => ({
        queuedMessages: [
          ...s.queuedMessages,
          {
            id: `q-${now}-${s.queuedMessages.length}`,
            text: trimmedText,
            deliveryState: 'pending' as const,
            ...(displayText ? { displayText } : {}),
            ...(mode ? { mode } : {}),
            orchestration,
            ...(composerModel ? { model: composerModel } : {}),
            ...(composerProviderId ? { providerId: composerProviderId } : {}),
            ...(composerAccountId ? { accountId: composerAccountId } : {}),
            ...(userModelChip ? { modelLabel: userModelChip } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(serviceTier ? { serviceTier } : {}),
            ...(expectedThreadId ? { expectedThreadId } : {}),
            ...(overrides?.guiPlan ? { guiPlan: overrides.guiPlan } : {}),
            ...(overrides?.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
            ...(overrides?.guiDesignMode ? { guiDesignMode: true } : {}),
            ...(overrides?.agentSurface ? { agentSurface: overrides.agentSurface } : {}),
            ...(overrides?.guiDesignArtifact ? { guiDesignArtifact: overrides.guiDesignArtifact } : {}),
            ...(writeContext ? { writeContext } : {}),
            ...(attachmentIds?.length ? { attachmentIds } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(fileReferences?.length ? { fileReferences } : {}),
            ...(composerContexts.length ? { composerContexts } : {})
          }
        ],
        extensionComposerContexts: withoutConsumedComposerContexts(s, composerContexts),
        error: null
      }))
      persistActiveQueuedMessages()
      // UI/runtime can briefly drift (busy=false while runtime still has an active turn).
      // Kick recovery so queued input drains as soon as the in-flight turn settles.
      if (!get().busy && hasPendingActiveTurn) {
        void get().recoverActiveTurn()
      }
      return true
    }
    const now = Date.now()
    const userBlockId = queued?.id ?? `u-${now}`
    const attachmentIds =
      queued?.attachmentIds ??
      overrides?.attachmentIds?.filter((id) => id.trim().length > 0) ??
      []
    const attachments =
      queued?.attachments ??
      overrides?.attachments?.filter((attachment) => attachment.id.trim().length > 0) ??
      []
    const fileReferences =
      queued?.fileReferences ??
      overrides?.fileReferences?.filter((reference) =>
        reference.path.trim().length > 0 &&
        reference.relativePath.trim().length > 0 &&
        reference.name.trim().length > 0
      ) ??
      []
    const composerContexts = queued?.composerContexts ?? (get().route === 'chat'
      ? overrides?.composerContexts ?? pendingComposerContexts(get())
      : [])
    let activeThreadId = get().activeThreadId
    if (!expectedThreadStillActive()) {
      set({
        error: i18n.t('common:designThreadChangedBeforeSend')
      })
      return false
    }
    const displayText = queued?.displayText ?? overrides?.displayText?.trim() ?? trimmedText
    const userDisplayText = displayText !== trimmedText ? displayText : undefined
    const generatedTitle = deriveThreadTitleFromPrompt(displayText)
    const shouldAutoRenameForRoute = get().route === 'chat'
    const activeThread = activeThreadId
      ? get().threads.find((thread) => thread.id === activeThreadId) ?? null
      : null
    let shouldRenameThreadAfterSend =
      shouldAutoRenameForRoute &&
      !!activeThreadId &&
      get().blocks.every((block) => block.kind !== 'user') &&
      shouldAutoTitleThread(activeThread)
    const threadSnap = get().threads.find((thread) => thread.id === activeThreadId)
    const clawModel = activeClawChannel(get())?.model
    const overrideModel = overrides?.model?.trim()
    const composerModel =
      queued?.model ?? overrideModel ?? (get().route === 'claw' && clawModel ? clawModel : get().composerModel.trim())
    const composerProviderId =
      queued?.providerId ?? overrides?.providerId?.trim() ?? fallbackComposerProviderIdForSend(get())
    const composerAccountId =
      queued?.accountId ??
      overrides?.accountId?.trim() ??
      accountIdForComposerSelection(get().composerModelGroups, composerProviderId, composerModel)
    const reasoningEffort = queued?.reasoningEffort ?? overrides?.reasoningEffort?.trim()
    const serviceTier =
      (queued?.serviceTier ?? overrides?.serviceTier) === 'priority'
        ? 'priority' as const
        : undefined
    const guiDesignCanvas = (queued?.guiDesignCanvas ?? overrides?.guiDesignCanvas) === true
    const guiDesignMode = (queued?.guiDesignMode ?? overrides?.guiDesignMode) === true
    const orchestration = queued?.orchestration ??
      overrides?.orchestration ??
      (mode === 'agent' && get().route === 'chat' && get().graphEnabled
        ? get().composerOrchestration
        : 'direct')
    const userModelChip =
      queued?.modelLabel ?? overrides?.modelLabel ?? optimisticUserModelLabel(composerModel, threadSnap?.model)
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
    // Any thread-detail request that started before this send is now stale. It
    // must not replace the optimistic user block or the live turn state.
    threadSelectionGeneration += 1
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
          ...(userDisplayText || guiDesignCanvas || guiDesignMode || attachmentIds.length || attachments.length || fileReferences.length || composerContexts.length
            ? {
                meta: {
                  ...(userDisplayText ? { displayText: userDisplayText } : {}),
                  ...(guiDesignCanvas ? { guiDesignCanvas: true } : {}),
                  ...(guiDesignMode ? { guiDesignMode: true } : {}),
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
    if (queued) persistActiveQueuedMessages()
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
          persistActiveQueuedMessages()
          return false
        }
        const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
        set({ codeWorkspaceRoots })
        const reusableThreadId = await findReusableEmptyThreadId(
          get(),
          p,
          workspaceRoot,
          (thread) => isCodeThread(thread, get().clawChannels)
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
                // Provisional first-message title; let the backend LLM titler upgrade it.
                titleAuto: true,
                ...(composerModel ? { model: composerModel } : {}),
                ...(composerProviderId ? { providerId: composerProviderId } : {}),
                ...(composerAccountId ? { accountId: composerAccountId } : {}),
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
        persistActiveQueuedMessages()
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
        checkpointGitAvailability.canAttempt(checkpointWorkspaceKey) &&
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
            checkpointGitAvailability.markUnavailable(checkpointWorkspaceKey)
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
      let runtimeText: string
      if (channel) {
        runtimeText = buildClawRuntimePrompt(settings, trimmedText, { channel })
      } else {
        runtimeText = buildCodeRuntimePrompt(settings, trimmedText)
      }
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
          persistActiveQueuedMessages()
        } else {
          set({ error: i18n.t('common:designThreadChangedBeforeSend') })
        }
        return false
      }
      const sendGeneration = currentTurnStartGeneration()
      const { turnId, userMessageItemId } = await p.sendUserMessage(activeThreadId, runtimeText, {
        mode,
        orchestration,
        agentSurface: requestedAgentSurface ??
          (writeContext || get().route === 'write' ? 'write' : guiDesignMode || get().route === 'design' ? 'design' : 'code'),
        ...(composerModel ? { model: composerModel } : {}),
        ...(!channel && composerProviderId ? { providerId: composerProviderId } : {}),
        ...(!channel && composerAccountId ? { accountId: composerAccountId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(!channel && serviceTier ? { serviceTier } : {}),
        ...(runtimeDisplayText ? { displayText: runtimeDisplayText } : {}),
        ...((queued?.guiPlan ?? overrides?.guiPlan) ? { guiPlan: queued?.guiPlan ?? overrides?.guiPlan } : {}),
        ...(guiDesignCanvas ? { guiDesignCanvas: true } : {}),
        ...(guiDesignMode ? { guiDesignMode: true } : {}),
        ...((queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact)
          ? { guiDesignArtifact: queued?.guiDesignArtifact ?? overrides?.guiDesignArtifact }
          : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(workspaceCheckpointRequestId ? { workspaceCheckpointRequestId } : {}),
        ...(fileReferences.length ? { fileReferences } : {}),
        ...(composerContexts.length ? { composerContexts } : {})
      })
      runtimeTurnAccepted = true
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
        persistActiveQueuedMessages()
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
      if (looksLikeActiveTurnError(e)) {
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
          error: i18n.t('common:runtimeActiveTurn')
        })
        persistActiveQueuedMessages()
        await get().recoverActiveTurn()
        await get().refreshThreads()
        return false
      }
      const view = describeRuntimeError(e)
      set((state) => ({
        blocks: runtimeTurnAccepted
          ? state.blocks
          : [...state.blocks, localConversationErrorBlock(e, `local_error_${userBlockId}`)],
        error: view.summary,
        busy: false,
        currentTurnId: null,
        currentTurnOrchestration: null,
        queuedMessages: previousQueuedMessages,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      }))
      persistActiveQueuedMessages()
      await get().refreshThreads()
      return false
    }
  },

  reviewActiveThread: async (target: ReviewTarget) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.reviewThread !== 'function') {
      set({ error: i18n.t('common:reviewUnavailable') })
      return false
    }
    if (get().busy || threadHasPendingRuntimeWork(get().blocks)) {
      set({ error: i18n.t('common:composerQueuePlaceholder') })
      return false
    }
    const composerModel = get().composerModel.trim()
    const composerProviderId = get().composerProviderId.trim()
    const composerAccountId = accountIdForComposerSelection(
      get().composerModelGroups,
      composerProviderId,
      composerModel
    )
    let activeThreadId = get().activeThreadId
    try {
      if (!activeThreadId) {
        const settings = await rendererRuntimeClient.getSettings()
        const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot)
        if (!workspaceRoot) {
          set({ error: i18n.t('common:workspaceRequiredToCreateThread') })
          return false
        }
        const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
        set({ codeWorkspaceRoots })
        const reusableThreadId = await findReusableEmptyThreadId(
          get(),
          p,
          workspaceRoot,
          (thread) => isCodeThread(thread, get().clawChannels)
        )
        const createdThread =
          reusableThreadId == null
            ? await p.createThread({
                workspace: workspaceRoot,
                title: i18n.t('common:slashCommandReviewTitle'),
                ...(composerModel ? { model: composerModel } : {}),
                ...(composerProviderId ? { providerId: composerProviderId } : {}),
                ...(composerAccountId ? { accountId: composerAccountId } : {}),
                mode: 'agent'
              })
            : null
        activeThreadId = reusableThreadId ?? createdThread?.id ?? null
        if (!activeThreadId) throw new Error('Failed to resolve target thread id.')
        set((s) => ({
          activeThreadId,
          codeWorkspaceRoots: rememberCodeWorkspaceRoots(s.codeWorkspaceRoots, [workspaceRoot, createdThread?.workspace]),
          lastSeq: 0,
          inspectorSelectedId: null,
          threads:
            createdThread && !s.threads.some((thread) => thread.id === createdThread.id)
              ? [createdThread, ...s.threads]
              : s.threads
        }))
      }
      const threadSnap = get().threads.find((thread) => thread.id === activeThreadId)
      const userModelChip = optimisticUserModelLabel(composerModel, threadSnap?.model)
      const seqAtSend = get().lastSeq
      resetBusyRecoveryAttempts()
      sseAbortRef.current?.abort()
      sseAbortRef.current = null
      clearBusyWatchdog()
      set({
        busy: true,
        liveReasoning: '',
        liveAssistant: '',
        error: null,
        currentTurnId: null,
        currentTurnOrchestration: 'direct',
        currentTurnUserId: null
      })
      await ensureRuntimeProviderForSend({
        providerId: composerProviderId,
        model: composerModel
      })
      const { turnId, userMessageItemId } = await p.reviewThread(activeThreadId, target, {
        ...(composerModel ? { model: composerModel } : {}),
        ...(composerProviderId ? { providerId: composerProviderId } : {}),
        ...(composerAccountId ? { accountId: composerAccountId } : {})
      })
      if (userMessageItemId && userModelChip) {
        rememberTurnModel(activeThreadId, userMessageItemId, userModelChip)
      }
      // Re-baseline the shared delta floor to this send's since_seq right
      // before the sink opens, so a replayed backlog can't re-append text.
      // Project the accepted review turn so a stale previous-turn summary
      // cannot make this thread look idle/completed while it streams.
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
      await get().refreshThreads()
      return true
    } catch (e) {
      clearBusyWatchdog()
      set({
        error: formatRuntimeError(e),
        busy: false,
        currentTurnId: null,
        currentTurnOrchestration: null,
        currentTurnUserId: null,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      await get().refreshThreads()
      return false
    }
  },
  }
}
