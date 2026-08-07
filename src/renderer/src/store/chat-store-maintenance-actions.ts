import type { ThreadGoal, ThreadGoalStatus, ThreadTodoList, ThreadTodoStatus } from '../agent/types'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import i18n from '../i18n'
import { applyTheme, applyUiFontScale } from '../lib/apply-theme'
import { confirmDialog } from '../lib/confirm-dialog'
import { formatWorkspacePickerError } from '../lib/format-workspace-picker-error'
import { formatRuntimeError, getRuntimeErrorCode } from '../lib/format-runtime-error'
import { requestCodeCanvasPanelOpen } from '../lib/code-canvas-panel-event'
import {
  prepareCodeCanvasResend,
  type PrepareCodeCanvasResendOptions,
  type PreparedCodeCanvasResend
} from '../design/canvas/code-canvas-resend'
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
  forgetThreadWorktree,
  readThreadWorktreeRegistry,
  saveThreadWorktreeRegistry
} from '../lib/thread-worktree-registry'
import {
  forgetQueuedMessagesForThread,
  saveQueuedMessagesForThread
} from './queued-message-persistence'
import { invalidateThreadSnapshot } from './thread-snapshot-cache'

/**
 * Release the worktree pool slot owned by a thread when the task completes
 * or is interrupted. Fire-and-forget — a failure must not block the UI.
 */
function releaseThreadWorktreeIfNeeded(threadId: string | null): void {
  if (!threadId || typeof window === 'undefined') return
  if (typeof window.kunGui?.releaseWorktree !== 'function') return
  const record = readThreadWorktreeRegistry().worktrees[threadId]
  if (!record) return
  if (record.poolIndex === undefined) return
  void window.kunGui
    .releaseWorktree({
      projectPath: record.projectPath,
      poolIndex: record.poolIndex
    })
    .catch(() => undefined)
  saveThreadWorktreeRegistry(forgetThreadWorktree(threadId))
}

import { workspaceLabelFromPath } from '../lib/workspace-label'
import { isInternalTemporaryWorkspace, normalizeWorkspaceRoot } from '../lib/workspace-path'
import { buildClawRuntimePrompt, getActiveAgentApiKey } from '@shared/app-settings'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import {
  activeClawChannel,
  compactCodeWorkspaceRoots,
  forgetCodeWorkspaceRoot,
  hydrateBlockModelLabels,
  isClawThread,
  optimisticUserModelLabel,
  readCodeWorkspaceRoots,
  readStoredComposerModel,
  rememberCodeWorkspaceRoots,
  rememberTurnModel
} from './chat-store-helpers'
import {
  clearedThreadSelection,
  collectAssistantTextForTurn,
  findLatestUserBlockId,
  findReusableEmptyThreadId,
  reconcileOptimisticUserBlock,
  settlePendingRuntimeWorkAfterInterrupt,
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
  writeThreadBelongsToWorkspace,
  writeWorkspaceForThreadId
} from '../write/write-thread-registry'
import {
  designDocKey,
  forgetDesignThread,
  readDesignThreadRegistry,
  replaceDesignThreadsForDocument,
  saveDesignThreadRegistry
} from '../design/design-thread-registry'
import {
  beginDesignChatHistoryMutation,
  deleteDesignChatDirForDoc,
  deleteDesignChatTranscriptForThread,
  endDesignChatHistoryMutation,
  persistDesignChatMetaForDoc
} from '../design/design-chat-transcript'
import { flushDesignPersistenceQueue } from '../design/design-persistence-coordinator'
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
  watchTurnCompletionNotification
} from './chat-store-runtime'
import {
  extractPlanTodos,
  mergePlanTodosForRenderer,
  sameTodoWriteItems,
  threadTodoWriteItems
} from '../plan/plan-todo-sync'

type SseAbortRef = { current: AbortController | null }

type StoreActionContext = {
  set: ChatStoreSet
  get: ChatStoreGet
  sseAbortRef: SseAbortRef
}

function applyGoalSnapshot(
  set: ChatStoreSet,
  threadId: string,
  goal: ThreadGoal | null,
  updatedAt = new Date().toISOString()
): void {
  set((s) => ({
    activeThreadGoal: s.activeThreadId === threadId ? goal : s.activeThreadGoal,
    threads: s.threads.map((thread) =>
      thread.id === threadId
        ? { ...thread, goal, updatedAt: goal?.updatedAt ?? updatedAt }
        : thread
    )
  }))
}

function applyTodosSnapshot(
  set: ChatStoreSet,
  threadId: string,
  todos: ThreadTodoList | null,
  updatedAt = new Date().toISOString()
): void {
  set((s) => ({
    activeThreadTodos: s.activeThreadId === threadId ? todos : s.activeThreadTodos,
    threads: s.threads.map((thread) =>
      thread.id === threadId
        ? { ...thread, todos, updatedAt: todos?.updatedAt ?? updatedAt }
        : thread
    )
  }))
}

function settleInterruptedTurn(set: ChatStoreSet, get: ChatStoreGet): void {
  resetBusyRecoveryAttempts()
  clearBusyWatchdog()
  const threadId = get().activeThreadId
  set((s) => {
    const out = flushLiveBlocks(s, {
      ...finalizeTurnTiming(s),
      busy: false,
      currentTurnId: null,
      currentTurnOrchestration: null,
      currentTurnUserId: null,
      error: null
    })
    const blocks = settlePendingRuntimeWorkAfterInterrupt(out.blocks ?? s.blocks)
    return { ...out, blocks }
  })
  // Release worktree slot when user manually stops the agent (unless queued
  // follow-ups will restart the turn in the same thread).
  if (threadId && get().queuedMessages.length === 0) {
    releaseThreadWorktreeIfNeeded(threadId)
  }
}

export type MaintenanceActionDependencies = {
  prepareCodeCanvasResend?: (
    options: PrepareCodeCanvasResendOptions
  ) => Promise<PreparedCodeCanvasResend | null>
  requestCodeCanvasPanelOpen?: () => void
  deleteDesignChatDirForDoc?: typeof deleteDesignChatDirForDoc
  deleteDesignChatTranscriptForThread?: typeof deleteDesignChatTranscriptForThread
  persistDesignChatMetaForDoc?: typeof persistDesignChatMetaForDoc
  flushDesignPersistenceQueue?: typeof flushDesignPersistenceQueue
}

/**
 * Checkpoint create/restore identity must follow the thread workspace, not the
 * currently selected global workspace picker. Multi-project sidebars can keep
 * one thread open under DeepSeek-GUI while `workspaceRoot` still points at
 * another project (e.g. KunUIExtend).
 */
function resolveCheckpointExpectedWorkspaceRoot(state: {
  activeThreadId: string | null
  threads: Array<{ id: string; workspace?: string | null }>
  workspaceRoot: string
}): string {
  const threadWorkspace = state.threads.find((thread) => thread.id === state.activeThreadId)?.workspace
  return normalizeWorkspaceRoot(threadWorkspace) || normalizeWorkspaceRoot(state.workspaceRoot)
}

export function createMaintenanceActions(
  { set, get, sseAbortRef }: StoreActionContext,
  dependencies: MaintenanceActionDependencies = {}
): Pick<ChatState, 'renameActiveThread' | 'renameThread' | 'pinThread' | 'archiveThread' | 'compactActiveThread' | 'forkActiveThread' | 'forkThreadFromTurn' | 'setActiveThreadGoal' | 'setActiveThreadGoalStatus' | 'clearActiveThreadGoal' | 'setActiveThreadTodoStatus' | 'clearActiveThreadTodos' | 'syncPlanTodosFromMarkdown' | 'resumeSessionIntoThread' | 'deleteThread' | 'clearDesignHistory' | 'rewindAndResend' | 'rollbackWorkspaceToCheckpoint' | 'resolveApproval' | 'resolveUserInput' | 'interrupt'> {
  const prepareCanvasResend = dependencies.prepareCodeCanvasResend ?? prepareCodeCanvasResend
  const openCodeCanvasPanel =
    dependencies.requestCodeCanvasPanelOpen ?? requestCodeCanvasPanelOpen
  const deleteDesignChatDir =
    dependencies.deleteDesignChatDirForDoc ?? deleteDesignChatDirForDoc
  const deleteDesignChatTranscript =
    dependencies.deleteDesignChatTranscriptForThread ?? deleteDesignChatTranscriptForThread
  const persistDesignChatMeta =
    dependencies.persistDesignChatMetaForDoc ?? persistDesignChatMetaForDoc
  const flushDesignPersistence =
    dependencies.flushDesignPersistenceQueue ?? flushDesignPersistenceQueue
  const forkActiveThreadWithOptions = async (options: { turnId?: string } = {}): Promise<void> => {
    const { activeThreadId, busy, blocks } = get()
    if (!activeThreadId) return
    if (busy) {
      set({ error: i18n.t('common:threadActionBusy') })
      return
    }
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const p = getProvider()
    if (typeof p.forkThread !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    const turnId = options.turnId?.trim()
    try {
      const parentThread =
        get().threads.find((thread) => thread.id === activeThreadId) ?? {
          id: activeThreadId,
          title: activeThreadId.slice(0, 8)
        }
      const forked = await p.forkThread(activeThreadId, turnId ? { turnId } : undefined)
      saveThreadForkRegistry(
        markThreadFork(
          forked.id,
          parentThread,
          {
            createdAt: forked.forkedAt ?? new Date().toISOString(),
            forkedFromMessageCount: forked.forkedFromMessageCount ?? forkedMessageCount(blocks),
            forkedFromTurnCount: forked.forkedFromTurnCount ?? forkedTurnCount(blocks)
          },
          readThreadForkRegistry()
        )
      )
      await get().refreshThreads()
      await get().selectThread(forked.id)
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  }

  return {
  renameActiveThread: async (title) => {
    const { activeThreadId } = get()
    if (!activeThreadId) return
    await get().renameThread(activeThreadId, title)
  },

  renameThread: async (threadId, title) => {
    const targetId = threadId.trim()
    const nextTitle = title.trim()
    if (!targetId || !nextTitle) return
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const p = getProvider()
    try {
      // Manual rename → lock the title so the backend LLM titler won't overwrite it.
      await p.renameThread(targetId, nextTitle, false)
      set((s) => ({
        threads: s.threads.map((thread) =>
          thread.id === targetId ? { ...thread, title: nextTitle, titleAuto: false } : thread
        ),
        error: null
      }))
      await get().refreshThreads()
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  pinThread: async (threadId, pinned) => {
    const targetId = threadId.trim()
    if (!targetId) return
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const p = getProvider()
    if (typeof p.updateThreadPinned !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    try {
      await p.updateThreadPinned(targetId, pinned)
      set((s) => ({
        threads: s.threads.map((thread) =>
          thread.id === targetId ? { ...thread, pinned } : thread
        ),
        error: null
      }))
      await get().refreshThreads()
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  archiveThread: async (threadId, archived) => {
    const targetId = threadId.trim()
    if (!targetId) return
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const { activeThreadId } = get()
    const p = getProvider()
    const archivingActive = archived && activeThreadId === targetId
    try {
      if (typeof p.archiveThread === 'function') {
        await p.archiveThread(targetId, archived)
      } else if (archived) {
        await p.deleteThread(targetId)
      } else {
        throw new Error(i18n.t('common:runtimeFeatureUnsupported'))
      }
      // An archived/unarchived projection can differ from the one currently
      // parked in memory; force a fresh durable snapshot next time.
      invalidateThreadSnapshot(targetId)
      if (archivingActive) {
        sseAbortRef.current?.abort()
        sseAbortRef.current = null
        clearBusyWatchdog()
      }
      set((s) => {
        const w = { ...s.watchTurnCompletion }
        const u = { ...s.unreadThreadIds }
        if (archived) {
          delete w[targetId]
          delete u[targetId]
          clearWatchedCompletionNotification(targetId)
        }
        return {
          threads: s.threads.map((thread) =>
            thread.id === targetId ? { ...thread, archived } : thread
          ),
          watchTurnCompletion: w,
          unreadThreadIds: u,
          ...(archivingActive ? clearedThreadSelection() : {}),
          error: null
        }
      })
      await get().refreshThreads()
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  compactActiveThread: async (reason) => {
    const { activeThreadId, busy } = get()
    if (!activeThreadId) return
    if (busy) {
      set({ error: i18n.t('common:threadActionBusy') })
      return
    }
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const p = getProvider()
    if (typeof p.compactThread !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    try {
      const result = await p.compactThread(activeThreadId, reason)
      await get().refreshThreads()
      await get().selectThread(activeThreadId)
      const replacedTokens = result && typeof result.replacedTokens === 'number' ? result.replacedTokens : 0
      if (replacedTokens <= 0) {
        // Nothing was folded (e.g. a near-empty thread). The compaction emits no
        // timeline row in that case, so surface a transient notice instead of
        // leaving the command silently doing nothing.
        set({ error: i18n.t('common:compactionNothingToCompact') })
      }
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  forkActiveThread: async () => {
    await forkActiveThreadWithOptions()
  },

  forkThreadFromTurn: async (turnId) => {
    const targetTurnId = turnId.trim()
    if (!targetTurnId) return
    await forkActiveThreadWithOptions({ turnId: targetTurnId })
  },

  setActiveThreadGoal: async (objective) => {
    const trimmed = objective.trim()
    if (!trimmed) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    let { activeThreadId } = get()
    if (!activeThreadId) {
      await get().createThread()
      activeThreadId = get().activeThreadId
    }
    if (!activeThreadId) return false
    const p = getProvider()
    if (typeof p.setThreadGoal !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return false
    }
    try {
      const goal = await p.setThreadGoal(activeThreadId, {
        objective: trimmed,
        status: 'active'
      })
      applyGoalSnapshot(set, activeThreadId, goal)
      await get().refreshThreads()
      return get().sendMessage(goal.objective, 'agent', {
        displayText: i18n.t('common:goalUserMessage', { objective: goal.objective })
      })
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  setActiveThreadGoalStatus: async (status: ThreadGoalStatus) => {
    const { activeThreadId } = get()
    if (!activeThreadId) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.setThreadGoal !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return false
    }
    try {
      const goal = await p.setThreadGoal(activeThreadId, { status })
      applyGoalSnapshot(set, activeThreadId, goal)
      await get().refreshThreads()
      return true
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  clearActiveThreadGoal: async () => {
    const { activeThreadId } = get()
    if (!activeThreadId) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.clearThreadGoal !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return false
    }
    try {
      const cleared = await p.clearThreadGoal(activeThreadId)
      if (cleared) {
        applyGoalSnapshot(set, activeThreadId, null)
      }
      await get().refreshThreads()
      return cleared
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  setActiveThreadTodoStatus: async (todoId: string, status: ThreadTodoStatus) => {
    const { activeThreadId, activeThreadTodos } = get()
    if (!activeThreadId || !activeThreadTodos) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.setThreadTodos !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return false
    }
    try {
      const nextItems = activeThreadTodos.items.map((item) => {
        if (item.id === todoId) return { ...item, status }
        if (status === 'in_progress' && item.status === 'in_progress') {
          return { ...item, status: 'pending' as const }
        }
        return item
      })
      const todos = await p.setThreadTodos(activeThreadId, threadTodoWriteItems({
        ...activeThreadTodos,
        items: nextItems
      }))
      applyTodosSnapshot(set, activeThreadId, todos)
      return true
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  clearActiveThreadTodos: async () => {
    const { activeThreadId } = get()
    if (!activeThreadId) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.clearThreadTodos !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return false
    }
    try {
      const cleared = await p.clearThreadTodos(activeThreadId)
      if (cleared) applyTodosSnapshot(set, activeThreadId, null)
      return cleared
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  syncPlanTodosFromMarkdown: async (plan, markdown) => {
    const { activeThreadId, activeThreadTodos } = get()
    if (!activeThreadId) return false
    if (get().runtimeConnection !== 'ready') return false
    const p = getProvider()
    if (typeof p.setThreadTodos !== 'function') return false
    const now = new Date().toISOString()
    const planItems = extractPlanTodos({
      markdown,
      threadId: activeThreadId,
      planId: plan.id,
      relativePath: plan.relativePath,
      now
    })
    const nextTodos = mergePlanTodosForRenderer({
      threadId: activeThreadId,
      existing: activeThreadTodos,
      planItems,
      now
    })
    const currentWriteItems = activeThreadTodos ? threadTodoWriteItems(activeThreadTodos) : []
    const nextWriteItems = threadTodoWriteItems(nextTodos)
    if (sameTodoWriteItems(currentWriteItems, nextWriteItems)) return true
    try {
      const todos = await p.setThreadTodos(activeThreadId, nextWriteItems)
      applyTodosSnapshot(set, activeThreadId, todos)
      return true
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      return false
    }
  },

  resumeSessionIntoThread: async (sessionId, options) => {
    const id = sessionId.trim()
    if (!id) return null
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return null
    }
    const p = getProvider()
    if (typeof p.resumeSession !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return null
    }
    try {
      const result = await p.resumeSession(id, options)
      await get().refreshThreads()
      await get().selectThread(result.threadId)
      return result.threadId
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

  clearDesignHistory: async (workspaceRoot, docId, options = {}) => {
    const targetWorkspace = normalizeWorkspaceRoot(workspaceRoot)
    const targetDoc = docId.trim()
    const emptyResult = {
      cleared: false,
      deletedThreadIds: [] as string[],
      retainedThreadIds: [] as string[],
      recreatedThreadId: null as string | null
    }
    if (!targetWorkspace || !targetDoc) {
      set({ error: i18n.t('common:workspaceRequiredToCreateThread') })
      return emptyResult
    }
    const registry = readDesignThreadRegistry()
    const originalRecord = registry.workspaces[designDocKey(targetWorkspace, targetDoc)]
    const originalThreadIds = [...new Set([
      ...(originalRecord?.threadIds ?? []),
      ...(options.includeThreadIds ?? []).map((threadId) => threadId.trim()).filter(Boolean)
    ])]
    const replaceRememberedThreads = (
      threadIds: readonly string[],
      preferredActiveThreadId?: string | null
    ): void => {
      saveDesignThreadRegistry(replaceDesignThreadsForDocument(
        targetWorkspace,
        targetDoc,
        threadIds,
        preferredActiveThreadId,
        readDesignThreadRegistry()
      ))
    }
    const restoreOriginalRecord = (): void => {
      replaceRememberedThreads(originalThreadIds, originalRecord?.activeThreadId)
    }
    const fail = (
      message: string,
      retainedThreadIds: string[],
      deletedThreadIds = originalThreadIds.filter((id) => !retainedThreadIds.includes(id))
    ) => {
      set({ error: message })
      return {
        ...emptyResult,
        deletedThreadIds,
        retainedThreadIds
      }
    }

    const historyMutationToken = beginDesignChatHistoryMutation(targetWorkspace, targetDoc)
    if (!historyMutationToken) {
      return fail(i18n.t('common:designAgentBusy'), originalThreadIds, [])
    }
    let historyMutationReleased = false
    const releaseHistoryMutation = (): void => {
      if (historyMutationReleased) return
      historyMutationReleased = true
      endDesignChatHistoryMutation(historyMutationToken)
    }

    try {
      // An empty registry can still have a stale local mirror after an earlier
      // interrupted cleanup. Make the operation idempotently finish that work,
      // but do not create a brand-new conversation when there was no history.
      if (originalThreadIds.length === 0) {
        await flushDesignPersistence(targetWorkspace)
        const mirrorDeleted = await deleteDesignChatDir({
          workspaceRoot: targetWorkspace,
          docId: targetDoc
        })
        if (!mirrorDeleted) {
          return fail('Failed to delete the local design conversation history.', [])
        }
        set({ error: null })
        return { ...emptyResult, cleared: true }
      }

      if (get().runtimeConnection !== 'ready') {
        return fail(
          i18n.t('common:runtimeActionNeedsConnection'),
          originalThreadIds,
          []
        )
      }

    const provider = getProvider()
    // A registered thread can be absent from the renderer's paged snapshot.
    // Ask Kun before deleting so an unloaded/racing active turn is treated as
    // busy instead of being destroyed underneath the agent.
    for (const threadId of originalThreadIds) {
      const localThread = get().threads.find((thread) => thread.id === threadId)
      if (
        localThread && (
          threadSnapshotLooksRunning([], localThread.status) ||
          threadSnapshotLooksRunning([], localThread.latestTurnStatus)
        )
      ) {
        return fail(i18n.t('common:designAgentBusy'), originalThreadIds, [])
      }
      try {
        const detail = await provider.getThreadDetail(threadId)
        if (threadSnapshotLooksRunning(detail.blocks, detail.threadStatus)) {
          return fail(i18n.t('common:designAgentBusy'), originalThreadIds, [])
        }
      } catch (error) {
        if (getRuntimeErrorCode(error) !== 'not_found') {
          return fail(formatRuntimeError(error), originalThreadIds, [])
        }
      }
    }
    const runtimeDeletedIds: string[] = []
    const runtimeFailedIds: string[] = []
    const failureMessages: string[] = []
    await Promise.all(originalThreadIds.map(async (threadId) => {
      try {
        await provider.deleteThread(threadId)
        invalidateThreadSnapshot(threadId)
        runtimeDeletedIds.push(threadId)
      } catch (error) {
        // A retry after an interrupted local cleanup commonly reaches a thread
        // already removed from Kun. That is success for this idempotent action.
        if (getRuntimeErrorCode(error) === 'not_found') {
          invalidateThreadSnapshot(threadId)
          runtimeDeletedIds.push(threadId)
          return
        }
        runtimeFailedIds.push(threadId)
        failureMessages.push(`${threadId}: ${formatRuntimeError(error)}`)
      }
    }))

    const runtimeDeletedSet = new Set(runtimeDeletedIds)
    const orderedRuntimeDeletedIds = originalThreadIds.filter((id) => runtimeDeletedSet.has(id))
    const orderedRuntimeFailedIds = originalThreadIds.filter((id) => runtimeFailedIds.includes(id))
    const preferredRetainedActive = originalRecord?.activeThreadId &&
      orderedRuntimeFailedIds.includes(originalRecord.activeThreadId)
      ? originalRecord.activeThreadId
      : orderedRuntimeFailedIds[0]
    // Removing successful ids before flushing prevents an in-flight transcript
    // refresh from enqueueing a new mirror after cleanup begins.
    replaceRememberedThreads(orderedRuntimeFailedIds, preferredRetainedActive)

    for (const threadId of orderedRuntimeDeletedIds) {
      forgetQueuedMessagesForThread(threadId)
      saveWriteThreadRegistry(forgetWriteThread(threadId))
      saveThreadForkRegistry(forgetThreadFork(threadId))
      releaseThreadWorktreeIfNeeded(threadId)
    }

    const deletingActive = Boolean(get().activeThreadId && runtimeDeletedSet.has(get().activeThreadId!))
    if (deletingActive) {
      sseAbortRef.current?.abort()
      sseAbortRef.current = null
      clearBusyWatchdog()
    }
    set((state) => {
      const watchTurnCompletion = { ...state.watchTurnCompletion }
      const unreadThreadIds = { ...state.unreadThreadIds }
      for (const threadId of orderedRuntimeDeletedIds) {
        delete watchTurnCompletion[threadId]
        delete unreadThreadIds[threadId]
        clearWatchedCompletionNotification(threadId)
      }
      return {
        threads: state.threads.filter((thread) => !runtimeDeletedSet.has(thread.id)),
        watchTurnCompletion,
        unreadThreadIds,
        ...(deletingActive ? clearedThreadSelection() : {}),
        error: null
      }
    })

    await flushDesignPersistence(targetWorkspace)

    if (orderedRuntimeFailedIds.length === 0) {
      const mirrorDeleted = await deleteDesignChatDir({
        workspaceRoot: targetWorkspace,
        docId: targetDoc
      })
      if (!mirrorDeleted) {
        // Keep the old ids as a durable retry journal. The next attempt treats
        // Kun's not_found response as success and retries only local cleanup.
        restoreOriginalRecord()
        return fail(
          'The conversations were deleted from Kun, but the local design history could not be removed.',
          originalThreadIds,
          orderedRuntimeDeletedIds
        )
      }

      if (options.recreate === false) {
        await get().refreshThreads()
        set({ error: null })
        return {
          cleared: true,
          deletedThreadIds: originalThreadIds,
          retainedThreadIds: [],
          recreatedThreadId: null
        }
      }

      set({ error: null })
      // The mirror directory is now gone and every older hydrate/persist read
      // carries a stale epoch, so replacement-thread persistence can resume.
      releaseHistoryMutation()
      const recreatedThreadId = await get().createDesignThread(
        targetWorkspace,
        targetDoc,
        { activate: false, suppressSettingsRedirect: true }
      )
      if (!recreatedThreadId && !get().error) {
        set({ error: 'Design history was cleared, but a new conversation could not be created.' })
      }
      return {
        cleared: true,
        deletedThreadIds: originalThreadIds,
        retainedThreadIds: [],
        recreatedThreadId
      }
    }

    // Runtime partial failure: preserve failed threads and their mirrors, while
    // permanently removing mirrors belonging to successfully deleted threads.
    if (orderedRuntimeDeletedIds.length === 0) {
      await get().refreshThreads()
      return fail(
        `Design history could not be cleared: ${failureMessages.join('; ')}`,
        originalThreadIds,
        []
      )
    }
    const mirrorDeleteResults = await Promise.all(orderedRuntimeDeletedIds.map(async (threadId) => ({
      threadId,
      deleted: await deleteDesignChatTranscript({
        workspaceRoot: targetWorkspace,
        docId: targetDoc,
        threadId
      })
    })))
    const mirrorFailedIds = mirrorDeleteResults
      .filter((result) => !result.deleted)
      .map((result) => result.threadId)
    for (const threadId of mirrorFailedIds) {
      failureMessages.push(`${threadId}: failed to delete the local transcript`)
    }
    const retainedSet = new Set([...orderedRuntimeFailedIds, ...mirrorFailedIds])
    const retainedThreadIds = originalThreadIds.filter((id) => retainedSet.has(id))
    const preferredActive = originalRecord?.activeThreadId && retainedSet.has(originalRecord.activeThreadId)
      ? originalRecord.activeThreadId
      : retainedThreadIds[0]
    replaceRememberedThreads(retainedThreadIds, preferredActive)

    const metaPersisted = await persistDesignChatMeta({
      workspaceRoot: targetWorkspace,
      docId: targetDoc,
      mutationToken: historyMutationToken
    })
    if (!metaPersisted) {
      restoreOriginalRecord()
      failureMessages.push('failed to update the local design conversation index')
      await get().refreshThreads()
      return fail(
        `Design history was only partially cleared: ${failureMessages.join('; ')}`,
        originalThreadIds,
        orderedRuntimeDeletedIds
      )
    }

    await get().refreshThreads()
    return fail(
      `Design history was only partially cleared: ${failureMessages.join('; ')}`,
      retainedThreadIds,
      orderedRuntimeDeletedIds
    )
    } finally {
      releaseHistoryMutation()
    }
  },

  deleteThread: async (threadId) => {
    const targetId = threadId.trim()
    if (!targetId) return
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const { activeThreadId } = get()
    const p = getProvider()
    const deletingActive = activeThreadId === targetId
    // Release the worktree pool slot if this thread owned one. Best-effort:
    // a failure to release must not block thread deletion.
    const wtRecord = readThreadWorktreeRegistry().worktrees[targetId]
    if (wtRecord?.poolIndex !== undefined) {
      try {
        await window.kunGui.releaseWorktree({
          projectPath: wtRecord.projectPath,
          poolIndex: wtRecord.poolIndex
        })
      } catch {
        /* best-effort; the slot can be reclaimed later via Settings */
      }
    }
    try {
      await p.deleteThread(targetId)
      invalidateThreadSnapshot(targetId)
      forgetQueuedMessagesForThread(targetId)
      saveWriteThreadRegistry(forgetWriteThread(targetId))
      saveDesignThreadRegistry(forgetDesignThread(targetId))
      saveThreadForkRegistry(forgetThreadFork(targetId))
      if (wtRecord) saveThreadWorktreeRegistry(forgetThreadWorktree(targetId))
      if (deletingActive) {
        sseAbortRef.current?.abort()
        sseAbortRef.current = null
        clearBusyWatchdog()
      }
      set((s) => {
        const w = { ...s.watchTurnCompletion }
        delete w[targetId]
        clearWatchedCompletionNotification(targetId)
        const u = { ...s.unreadThreadIds }
        delete u[targetId]
        return {
          threads: s.threads.filter((thread) => thread.id !== targetId),
          watchTurnCompletion: w,
          unreadThreadIds: u,
          ...(deletingActive ? clearedThreadSelection() : {}),
          error: null
        }
      })
      await get().refreshThreads()
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  rewindAndResend: async (userBlockId, newText) => {
    const trimmed = newText.trim()
    if (!trimmed) return
    const state = get()
    if (state.busy) {
      set({ error: i18n.t('common:rewindBusyError') })
      return
    }
    const idx = state.blocks.findIndex((b) => b.id === userBlockId && b.kind === 'user')
    if (idx < 0) return
    const targetBlock = state.blocks[idx]
    if (targetBlock?.kind !== 'user') return
    const turnId = targetBlock.meta?.turnId
    if (!state.activeThreadId || !turnId) {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    const p = getProvider()
    if (typeof p.rewindThread !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    const checkpointId = targetBlock.meta?.workspaceCheckpointId
    if (checkpointId) {
      const expectedWorkspaceRoot = resolveCheckpointExpectedWorkspaceRoot(state)
      const restored = await window.kunGui.restoreGitCheckpoint({
        checkpointId,
        ...(state.activeThreadId ? { expectedThreadId: state.activeThreadId } : {}),
        ...(expectedWorkspaceRoot ? { expectedWorkspaceRoot } : {})
      }).catch((error) => ({
        ok: false as const,
        reason: 'error' as const,
        message: error instanceof Error ? error.message : String(error)
      }))
      if (!restored.ok) {
        set({ error: restored.message })
        return
      }
    }

    const trimmedBlocks = state.blocks.slice(0, idx)
    const attachmentIds = [...new Set([
      ...(targetBlock.meta?.attachmentIds ?? []),
      ...(targetBlock.meta?.attachments ?? []).map((attachment) => attachment.id)
    ].map((id) => id.trim()).filter(Boolean))]
    const attachments = (targetBlock.meta?.attachments ?? []).filter((attachment) =>
      attachment.id.trim().length > 0
    )
    const attachmentOverrides = {
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(attachments.length ? { attachments } : {})
    }

    const droppedUserIds = state.blocks
      .slice(idx)
      .filter((b) => b.kind === 'user')
      .map((b) => b.id)
    const turnStartedAtByUserId = { ...state.turnStartedAtByUserId }
    const turnDurationByUserId = { ...state.turnDurationByUserId }
    const turnReasoningFirstAtByUserId = { ...state.turnReasoningFirstAtByUserId }
    const turnReasoningLastAtByUserId = { ...state.turnReasoningLastAtByUserId }
    for (const id of droppedUserIds) {
      delete turnStartedAtByUserId[id]
      delete turnDurationByUserId[id]
      delete turnReasoningFirstAtByUserId[id]
      delete turnReasoningLastAtByUserId[id]
    }

    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    clearBusyWatchdog()

    try {
      const canvasResend = await prepareCanvasResend({
        route: state.route,
        text: trimmed,
        previousCanvasTurn: targetBlock.meta?.guiDesignCanvas === true,
        fallbackWorkspaceRoot: state.workspaceRoot,
        threadWorkspaceRoot: state.threads.find(
          (thread) => thread.id === state.activeThreadId
        )?.workspace,
        threadId: state.activeThreadId
      })
      if (canvasResend) openCodeCanvasPanel()
      await p.rewindThread(state.activeThreadId, turnId)
      invalidateThreadSnapshot(state.activeThreadId)
      set({
        blocks: trimmedBlocks,
        liveReasoning: '',
        liveAssistant: '',
        currentTurnId: null,
        currentTurnOrchestration: null,
        currentTurnUserId: null,
        turnStartedAtByUserId,
        turnDurationByUserId,
        turnReasoningFirstAtByUserId,
        turnReasoningLastAtByUserId,
        error: null
      })
      if (canvasResend) {
        await get().sendMessage(canvasResend.text, 'agent', {
          displayText: canvasResend.displayText,
          guiDesignCanvas: true,
          ...attachmentOverrides
        })
      } else if (attachmentIds.length > 0) {
        await get().sendMessage(trimmed, undefined, attachmentOverrides)
      } else {
        await get().sendMessage(trimmed)
      }
    } catch (e) {
      set({ error: formatRuntimeError(e) })
    }
  },

  rollbackWorkspaceToCheckpoint: async (checkpointId) => {
    const targetCheckpointId = checkpointId.trim()
    if (!targetCheckpointId) {
      set({ error: i18n.t('common:rollbackWorkspaceMissingCheckpoint') })
      return
    }
    if (get().busy) {
      set({ error: i18n.t('common:rollbackWorkspaceBusyError') })
      return
    }
    const confirmed = await confirmDialog(
      i18n.t('common:rollbackWorkspaceConfirm'),
      i18n.t('common:rollbackWorkspaceConfirmDetail')
    )
    if (!confirmed) return
    // Re-check busy: the user may have typed and sent a new turn while the
    // confirm dialog was open. Running `git reset --hard` mid-turn would
    // wipe files the running agent is actively editing.
    if (get().busy) {
      set({ error: i18n.t('common:rollbackWorkspaceBusyError') })
      return
    }
    const state = get()
    const { activeThreadId } = state
    const expectedWorkspaceRoot = resolveCheckpointExpectedWorkspaceRoot(state)
    let restored = await window.kunGui.restoreGitCheckpoint({
      checkpointId: targetCheckpointId,
      ...(activeThreadId ? { expectedThreadId: activeThreadId } : {}),
      ...(expectedWorkspaceRoot ? { expectedWorkspaceRoot } : {})
    }).catch((error) => ({
      ok: false as const,
      reason: 'error' as const,
      message: error instanceof Error ? error.message : String(error)
    }))
    // A partial checkpoint skipped some untracked files (too large to capture).
    // Restoring would delete them, so the main process refuses unless the user
    // opts in. Surface the at-risk files and, on confirmation, retry with the
    // opt-in (the main process then takes a full rescue checkpoint first).
    if (!restored.ok && restored.reason === 'partial') {
      const skipped = 'skippedUntracked' in restored && Array.isArray(restored.skippedUntracked)
        ? restored.skippedUntracked
        : []
      const preview = skipped.slice(0, 10).join(', ') + (skipped.length > 10 ? ` … (+${skipped.length - 10})` : '')
      const proceed = await confirmDialog(
        i18n.t('common:rollbackWorkspacePartialConfirm'),
        i18n.t('common:rollbackWorkspacePartialConfirmDetail', { files: preview })
      )
      if (!proceed) {
        set({ error: null })
        return
      }
      if (get().busy) {
        set({ error: i18n.t('common:rollbackWorkspaceBusyError') })
        return
      }
      restored = await window.kunGui
        .restoreGitCheckpoint({
          checkpointId: targetCheckpointId,
          allowPartialRestore: true,
          ...(activeThreadId ? { expectedThreadId: activeThreadId } : {}),
          ...(expectedWorkspaceRoot ? { expectedWorkspaceRoot } : {})
        })
        .catch((error) => ({
          ok: false as const,
          reason: 'error' as const,
          message: error instanceof Error ? error.message : String(error)
        }))
    }
    if (!restored.ok) {
      set({ error: restored.message })
      return
    }
    // Surface the rescue checkpoint id so the user can `git stash apply` it
    // (or hand-copy from the data dir) if the rollback turns out to have
    // been a mistake. The destructive ops above already happened.
    const rescueId =
      'rescueCheckpointId' in restored && typeof restored.rescueCheckpointId === 'string'
        ? restored.rescueCheckpointId
        : null
    console.info(
      '[rollback] rescue checkpoint:',
      rescueId,
      'workspace:',
      expectedWorkspaceRoot,
      'thread:',
      activeThreadId
    )
    set({ error: null })
  },

  resolveApproval: async (blockId, decision) => {
    const { blocks } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block || block.kind !== 'approval' || block.status !== 'pending') return
    const p = getProvider()
    if (typeof p.submitApprovalDecision !== 'function') {
      set({ error: i18n.t('common:runtimeFeatureUnsupported') })
      return
    }
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.id === blockId && b.kind === 'approval' && b.status === 'pending'
          ? { ...b, status: 'submitting' as const, errorMessage: undefined }
          : b
      )
    }))
    try {
      const outcome = await p.submitApprovalDecision(
        block.approvalId,
        decision === 'allow' ? 'allow' : 'deny',
        true
      )
      if (outcome === 'cancelled') {
        set((s) => ({
          blocks: s.blocks.map((b) =>
            b.id === blockId && b.kind === 'approval' && b.status === 'submitting'
              ? {
                  ...b,
                  status: 'pending' as const,
                  errorMessage: i18n.t('common:approvalNativeConfirmationCancelled')
                }
              : b
          )
        }))
        return
      }
      set((s) => ({
        blocks: s.blocks.map((b) =>
          b.id === blockId && b.kind === 'approval' && b.status === 'submitting'
            ? { ...b, status: decision === 'allow' ? ('allowed' as const) : ('denied' as const) }
            : b
        )
      }))
    } catch (e) {
      const stillSubmitting = get().blocks.some((b) =>
        b.id === blockId && b.kind === 'approval' && b.status === 'submitting'
      )
      if (!stillSubmitting) return
      const msg = formatRuntimeError(e)
      void window.kunGui.logError('approval', 'Failed to submit approval decision', {
        message: msg,
        blockId
      }).catch(() => undefined)
      set((s) => ({
        error: msg,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {}),
        blocks: s.blocks.map((b) =>
          b.id === blockId && b.kind === 'approval' && b.status === 'submitting'
            ? { ...b, status: 'error' as const, errorMessage: msg }
            : b
        )
      }))
    }
  },

  resolveUserInput: async (blockId, action) => {
    const { blocks } = get()
    const block = blocks.find((b) => b.id === blockId)
    if (!block || block.kind !== 'user_input' || block.status !== 'pending') return
    const p = getProvider()
    try {
      if (action.kind === 'submit') {
        const state = get()
        if (typeof p.submitUserInputResponse !== 'function') {
          throw new Error(i18n.t('common:runtimeUserInputUnsupported'))
        }
        try {
          await p.submitUserInputResponse(block.requestId, action.answers)
        } catch (fallbackErr) {
          const activeThreadId = state.activeThreadId
          const currentTurnId = state.currentTurnId
          if (
            getRuntimeErrorCode(fallbackErr) === 'runtime_request_user_input_unsupported' &&
            typeof p.interruptTurn === 'function' &&
            activeThreadId &&
            currentTurnId
          ) {
            const followupText = buildFollowupMessageFromUserInput(block.questions, action.answers)
            set((s) => ({
              queuedMessages: [
                ...s.queuedMessages,
                {
                  id: `q-${Date.now()}-${s.queuedMessages.length}`,
                  text: followupText,
                  deliveryState: 'pending' as const
                }
              ],
              blocks: s.blocks.map((b) =>
                b.id === blockId && b.kind === 'user_input'
                  ? { ...b, status: 'submitted' as const, answers: action.answers }
                  : b
              )
            }))
            saveQueuedMessagesForThread(activeThreadId, get().queuedMessages)
            await p.interruptTurn(activeThreadId, currentTurnId)
            settleInterruptedTurn(set, get)
            void get().refreshThreads()
            void get().drainQueuedMessages()
            return
          }
          throw fallbackErr
        }
        if (get().busy) armBusyWatchdog(set, get)
        set((s) => ({
          blocks: s.blocks.map((b) =>
            b.id === blockId && b.kind === 'user_input'
              ? { ...b, status: 'submitted' as const, answers: action.answers }
              : b
          )
        }))
        return
      }

      if (typeof p.cancelUserInput !== 'function') {
        throw new Error(i18n.t('common:runtimeUserInputUnsupported'))
      }
      await p.cancelUserInput(block.requestId)
      set((s) => ({
        blocks: s.blocks.map((b) =>
          b.id === blockId && b.kind === 'user_input'
            ? { ...b, status: 'cancelled' as const }
            : b
        )
      }))
    } catch (e) {
      const msg = formatRuntimeError(e)
      void window.kunGui.logError('user-input', 'Failed to resolve user input', {
        message: msg,
        blockId
      }).catch(() => undefined)
      set((s) => ({
        error: msg,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {}),
        blocks: s.blocks.map((b) =>
          b.id === blockId && b.kind === 'user_input'
            ? {
                ...b,
                status: 'error' as const,
                errorMessage: msg,
                // Keep the chosen answers on the record so the read-only bubble
                // still echoes what the user picked when a submit RPC fails,
                // mirroring the success / interrupt-fallback paths above.
                ...(action.kind === 'submit' ? { answers: action.answers } : {})
              }
            : b
        )
      }))
    }
  },

  interrupt: async (options) => {
    const { activeThreadId, currentTurnId } = get()
    if (!activeThreadId || !currentTurnId) return
    const p = getProvider()
    // Settle the UI before notifying the runtime: a slow or hung
    // interruptTurn must not keep the stop button unresponsive. The event
    // stream is aborted first because onDeltas/onTool flip `busy` back on
    // while the backend turn is still streaming.
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    settleInterruptedTurn(set, get)
    try {
      await p.interruptTurn(activeThreadId, currentTurnId, { discard: options?.discard === true })
    } catch (e) {
      const msg = formatRuntimeError(e)
      void window.kunGui.logError('interrupt', 'Failed to interrupt turn', { message: msg }).catch(() => undefined)
      set({
        error: msg,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
    void get().refreshThreads()
    // Re-sync from the runtime snapshot and re-subscribe the event stream
    // aborted above; recoverActiveTurn also drains queued messages once the
    // thread is idle. Skip when the user already moved on to another thread
    // or a newer stream owns the subscription.
    if (get().activeThreadId === activeThreadId && sseAbortRef.current === null) {
      await get().recoverActiveTurn()
    }
  }
  }
}
