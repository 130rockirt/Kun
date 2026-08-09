import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ThreadStore, ThreadStoreListOptions } from '../ports/thread-store.js'
import type { SessionStore } from '../ports/session-store.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type {
  CreateThreadRequest,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  ThreadGoal,
  ThreadMode,
  ThreadRecord,
  ThreadRelation,
  ThreadStatus,
  ThreadUpdateStatus,
  ThreadTodoItem,
  ThreadTodoList,
  ThreadTodoSource,
  ThreadTodoStatus,
  ThreadSummary
} from '../contracts/threads.js'
import type { ExtensionThreadMetadata } from '../contracts/threads.js'
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  SandboxMode
} from '../contracts/policy.js'
import type { Turn } from '../contracts/turns.js'
import { isPublicTurnItem, type TurnItem } from '../contracts/items.js'
import {
  createThreadRecord,
  resolveThreadAgentSurface,
  toThreadSummary,
  touchThread
} from '../domain/thread.js'
import type { AgentSession } from '../domain/session.js'
import { repairModelHistoryItems } from '../domain/model-history-repair.js'
import type { RuntimeEventRecorder } from './runtime-event-recorder.js'
import type { ThreadLifecycleFence } from './thread-lifecycle-fence.js'
import { withFileMutationQueue } from '../adapters/tool/file-mutation-queue.js'
import { withThreadStoreMutation } from './thread-mutation-coordinator.js'
import { DEFAULT_KUN_MODEL } from '../config/kun-config.js'
import { isGuiPlanRelativePath } from '../shared/gui-plan.js'
import {
  extractPlanTodos,
  mergePlanTodos,
  normalizePlanRelativePath,
  normalizeTodoContent,
  patchPlanTodoStatus,
  todoContentHash
} from '../shared/todos.js'
import { type ThreadService, type ThreadServiceOptions, type ListThreadsOptions, type ForkThreadOptions, type ResumeSessionOptions, type ResumeSessionResult, type SyncPlanTodosOptions, cloneTurnForThread, normalizeTodoItems, preserveToolTodoSources, normalizeTodoStatus, normalizeTodoSource, findExistingTodoForRaw, sameTodoSource, uniqueTodoId, cloneTodoListForThread, resolveWorkspaceRelativePath, cloneTurnForFork, cloneItemForThread, cloneSessionItemsForThread, matchesThreadSearch, threadStatusFromTurns, rebuildTurnsFromItems, attachmentIdsFromItems, toSessionSnapshot } from './thread-service-core.js'

export const threadServiceLifecycleOperations = {
async delete(this: ThreadService, threadId: string): Promise<boolean> {
    let rawDeleteCommitted = false
    try {
      return await this['withThreadMutation'](threadId, async () => {
        // A concurrent delete that arrives after this service already removed
        // the thread must not reopen its fence on a raw false result.
        if (this['lifecycleFence']?.isDeleted(threadId)) return false

        this['lifecycleFence']?.beginClose(threadId)
        // Stop only this thread's live work. We intentionally do not settle
        // the turn record here: any late lifecycle writes are now fenced off
        // and the canonical record is about to be removed.
        await this['onDeleting']?.(threadId)
        await this['lifecycleFence']?.drain(threadId)
        // Never route deletion through the fenced facade: it is the terminal
        // raw operation after all old-generation writes have drained.
        const ok = await this['deleteThreadStore'].delete(threadId)
        if (!ok) {
          // A failed/no-op deletion must not leave a still-visible thread
          // permanently unwritable. Existing leases remain invalid because
          // this is nevertheless a fresh generation.
          this['lifecycleFence']?.reopen(threadId)
          return false
        }
        rawDeleteCommitted = true
        this['lifecycleFence']?.markDeleted(threadId)
        this['sessionStore'].clearThreadMemory(threadId)
        await this['onDeleted']?.(threadId)
        return true
      })
    } catch (error) {
      // Once raw deletion succeeds, keep the fence closed even when a
      // best-effort cleanup callback fails; reopening here would let a later
      // delayed write recreate the directory that was just removed.
      if (!rawDeleteCommitted) this['lifecycleFence']?.reopen(threadId)
      throw error
    }
  },

async fork(this: ThreadService, threadId: string, options: ForkThreadOptions = {}): Promise<ThreadRecord> {
    const current = await this['threadStore'].get(threadId)
    if (!current) throw new Error(`thread not found: ${threadId}`)
    if (
      options.approvalReviewer !== undefined &&
      options.approvalReviewer !== current.approvalReviewer
    ) {
      throw new Error('fork approval reviewer must inherit the source thread')
    }
    const now = this['nowIso']()
    const forkId = this['ids'].next('thr')
    const relation: ThreadRelation = options.relation ?? 'fork'
    const targetTurnId = options.turnId?.trim()
    const targetTurnIndex = targetTurnId
      ? current.turns.findIndex((turn) => turn.id === targetTurnId)
      : -1
    if (targetTurnId && targetTurnIndex < 0) {
      throw new Error(`turn not found: ${targetTurnId}`)
    }
    const sourceTurns = targetTurnId
      ? current.turns.slice(0, targetTurnIndex + (options.beforeTurn ? 0 : 1))
      : current.turns
    // Snapshot semantics: clone each turn as it stands now. The parent
    // loop keeps mutating its own record; we copy, never borrow.
    const clonedTurns = sourceTurns.map((turn) =>
      cloneTurnForFork(turn, forkId, now, { relation })
    )
    const clonedPublicItems = clonedTurns.flatMap((turn) => turn.items)
    const persistedItems = await this['sessionStore'].loadItems(threadId)
    const clonedSessionItems = cloneSessionItemsForThread({
      // A pre-boundary FileThreadStore can contain a complete legacy mirror
      // while its canonical stream is absent. Preserve the internal item in
      // that recovery path too; cloneTurnForThread above still strips it from
      // the new ThreadRecord mirror.
      sourceItems: persistedItems.length > 0
        ? persistedItems
        : sourceTurns.flatMap((turn) => turn.items),
      clonedTurns,
      threadId: forkId,
      now
    })
    const defaultTitle = relation === 'side' ? `${current.title} · side` : `${current.title} fork`
    const forkIncludesLatestTurn = !targetTurnId || clonedTurns.length === current.turns.length
    const fork = createThreadRecord({
      id: forkId,
      title: options.title?.trim() || defaultTitle,
      workspace: current.workspace,
      additionalWorkspaces: current.additionalWorkspaces,
      model: current.model,
      agentSurface: resolveThreadAgentSurface(current),
      ...(current.providerId ? { providerId: current.providerId } : {}),
      ...(current.accountId ? { accountId: current.accountId } : {}),
      ...(current.agentId ? { agentId: current.agentId } : {}),
      ...(current.systemPrompt ? { systemPrompt: current.systemPrompt } : {}),
      // A fork is a fresh conversation branch, not a continuation of the
      // parent's plan workflow — the plan artifact and its workspace belong to
      // the source thread. Inheriting `mode: 'plan'` made a forked "new
      // conversation" run as a plan turn bound to a stale plan context, which
      // hard-failed create_plan (workspace mismatch) and produced malformed
      // plan-mode model requests. Default forks to agent; the user can re-enter
      // plan mode in the fork if they want a fresh plan.
      mode: 'agent',
      status: 'idle',
      approvalPolicy: current.approvalPolicy,
      sandboxMode: current.sandboxMode,
      approvalReviewer: current.approvalReviewer,
      modelRequestCaptureEnabled: this['defaultModelRequestCaptureEnabled'],
      relation,
      parentThreadId: current.id,
      forkedFromThreadId: current.id,
      forkedFromTitle: current.title,
      forkedAt: now,
      forkedFromMessageCount: clonedPublicItems.filter((item) => item.kind === 'user_message').length,
      forkedFromTurnCount: clonedTurns.length,
      ...(forkIncludesLatestTurn && current.todos ? { todos: cloneTodoListForThread(current.todos, forkId, now) } : {}),
      createdAt: now
    })
    const record: ThreadRecord = {
      ...fork,
      updatedAt: now,
      turns: clonedTurns
    }
    for (const item of clonedSessionItems) {
      await this['sessionStore'].appendItem(record.id, item)
    }
    await this['threadStore'].upsert(record)
    await this['events'].record({
      kind: 'thread_created',
      threadId: record.id,
      title: record.title,
      approvalPolicy: record.approvalPolicy,
      sandboxMode: record.sandboxMode,
      approvalReviewer: record.approvalReviewer
    })
    await this['onForked']?.(threadId, record.id)
    return record
  },

async resumeSession(this: ThreadService,
    sessionId: string,
    options: ResumeSessionOptions = {}
  ): Promise<ResumeSessionResult> {
    const sourceThread = await this['threadStore'].get(sessionId)
    const sourceSession = await this['sessionStore'].loadSession(sessionId)
    const persistedItems = await this['sessionStore'].loadItems(sessionId)
    const sourceSessionItems = persistedItems.length > 0
      ? persistedItems
      : sourceSession?.items.length
        ? sourceSession.items
        : sourceThread?.turns.flatMap((turn) => turn.items) ?? []
    if (!sourceThread && !sourceSession && sourceSessionItems.length === 0) {
      throw new Error(`session not found: ${sessionId}`)
    }
    if (
      sourceThread &&
      options.approvalReviewer !== undefined &&
      options.approvalReviewer !== sourceThread.approvalReviewer
    ) {
      throw new Error('resumed approval reviewer must inherit the source thread')
    }

    const now = this['nowIso']()
    const threadId = this['ids'].next('thr')
    const sourceTurns = sourceThread
      ? sourceThread.turns
      : rebuildTurnsFromItems({
          // Reconstructed public turns intentionally exclude internal model
          // context; the full ordered stream is cloned separately below.
          items: sourceSessionItems.filter(isPublicTurnItem),
          threadId,
          fallbackTurnId: sourceSession?.turnId || sourceSessionItems[0]?.turnId || this['ids'].next('turn'),
          fallbackPrompt: `Resumed session ${sessionId.slice(0, 8)}`,
          now
        })
    const clonedTurns = sourceTurns.map((turn) => cloneTurnForThread(turn, threadId, now))
    const clonedPublicItems = clonedTurns.flatMap((turn) => turn.items)
    const clonedSessionItems = cloneSessionItemsForThread({
      sourceItems: sourceSessionItems,
      clonedTurns,
      threadId,
      now
    })
    const sourceTitle = sourceThread?.title ?? `Session ${sessionId.slice(0, 8)}`
    const record = createThreadRecord({
      id: threadId,
      title: `${sourceTitle} resumed`,
      workspace: options.workspace ?? sourceThread?.workspace ?? '~',
      model: options.model ?? sourceThread?.model ?? DEFAULT_KUN_MODEL,
      agentSurface: sourceThread
        ? resolveThreadAgentSurface(sourceThread)
        : resolveThreadAgentSurface({ turns: sourceTurns }),
      mode: options.mode ?? sourceThread?.mode ?? 'agent',
      status: 'idle',
      approvalPolicy: sourceThread?.approvalPolicy,
      sandboxMode: sourceThread?.sandboxMode,
      approvalReviewer: sourceThread?.approvalReviewer ?? options.approvalReviewer,
      modelRequestCaptureEnabled: this['defaultModelRequestCaptureEnabled'],
      forkedFromThreadId: sourceThread?.id,
      forkedFromTitle: sourceThread?.title,
      forkedAt: now,
      forkedFromMessageCount: clonedPublicItems.filter((item) => item.kind === 'user_message').length,
      forkedFromTurnCount: clonedTurns.length,
      ...(sourceThread?.todos ? { todos: cloneTodoListForThread(sourceThread.todos, threadId, now) } : {}),
      createdAt: now
    })
    const resumed: ThreadRecord = {
      ...record,
      updatedAt: now,
      turns: clonedTurns
    }
    for (const item of clonedSessionItems) {
      await this['sessionStore'].appendItem(resumed.id, item)
    }
    await this['threadStore'].upsert(resumed)
    await this['sessionStore'].upsertSession(toSessionSnapshot(resumed, now, clonedSessionItems))
    await this['events'].record({
      kind: 'thread_created',
      threadId: resumed.id,
      title: resumed.title,
      approvalPolicy: resumed.approvalPolicy,
      sandboxMode: resumed.sandboxMode,
      approvalReviewer: resumed.approvalReviewer
    })
    return { thread: resumed, sessionId, messageCount: clonedPublicItems.length }
  },

toSummary(this: ThreadService, thread: ThreadRecord): ThreadSummary {
    return toThreadSummary(thread)
  },
}
