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

export const threadServiceMetadataOperations = {
updateRuntimeDefaults(this: ThreadService, input: {
    approvalPolicy: ApprovalPolicy
    sandboxMode: SandboxMode
    approvalReviewer: ApprovalReviewer
    modelRequestCaptureEnabled: boolean
  }): void {
    this['defaultApprovalPolicy'] = input.approvalPolicy
    this['defaultSandboxMode'] = input.sandboxMode
    this['defaultApprovalReviewer'] = input.approvalReviewer
    this['defaultModelRequestCaptureEnabled'] = input.modelRequestCaptureEnabled
  },

async list(this: ThreadService, options: ListThreadsOptions = {}): Promise<ThreadSummary[]> {
    const query = options.search?.trim().toLowerCase()
    let threads = await this['threadStore'].list(options)
    if (options.archivedOnly) {
      threads = threads.filter((thread) => thread.status === 'archived')
    } else if (!options.includeArchived) {
      threads = threads.filter((thread) => thread.status !== 'archived' && thread.status !== 'deleted')
    }
    if (!options.includeSide) {
      threads = threads.filter((thread) => (thread.relation ?? 'primary') !== 'side')
    }
    if (query) {
      threads = threads.filter((thread) => matchesThreadSearch(thread, query))
    }
    return typeof options.limit === 'number' ? threads.slice(0, options.limit) : threads
  },

async get(this: ThreadService, threadId: string): Promise<ThreadRecord | null> {
    return this['threadStore'].get(threadId)
  },

/**
   * Read the thread/turn metadata without hydrating the item history when the
   * backing store supports it. File/hybrid stores use this on detail and
   * status routes so the session items are loaded exactly once.
   */
async getMetadata(this: ThreadService, threadId: string): Promise<ThreadRecord | null> {
    return this['threadStore'].getMetadata
      ? this['threadStore'].getMetadata(threadId)
      : this['threadStore'].get(threadId)
  },

async create(this: ThreadService,
    request: CreateThreadRequest,
    options: {
      id?: string
      title?: string
      status?: ThreadStatus
      /** Relationship to a parent thread; `side` threads are hidden from the default list. */
      relation?: ThreadRelation
      /** Parent thread this thread branches from (used by `side`/`fork` relations). */
      parentThreadId?: string
      /** Broker-derived metadata. Never populated from the public thread request body. */
      extensionMetadata?: ExtensionThreadMetadata
    } = {}
  ): Promise<ThreadRecord> {
    // Always advance the id generator so externally-supplied ids
    // don't collide with later allocations from `fork`/etc.
    const generated = this['ids'].next('thr')
    const id = options.id ?? generated
    const thread = createThreadRecord({
      id,
      title: options.title ?? (request.title?.trim() || 'New chat'),
      ...(request.titleAuto !== undefined ? { titleAuto: request.titleAuto } : {}),
      workspace: request.workspace,
      additionalWorkspaces: request.additionalWorkspaces,
      model: request.model,
      ...(request.agentSurface ? { agentSurface: request.agentSurface } : {}),
      ...(request.providerId?.trim() ? { providerId: request.providerId.trim() } : {}),
      ...(request.accountId?.trim() ? { accountId: request.accountId.trim() } : {}),
      ...(options.extensionMetadata ?? {}),
      ...(request.agentId?.trim() ? { agentId: request.agentId.trim() } : {}),
      ...(request.systemPrompt?.trim() ? { systemPrompt: request.systemPrompt.trim() } : {}),
      mode: request.mode,
      approvalPolicy: request.approvalPolicy ?? this['defaultApprovalPolicy'],
      sandboxMode: request.sandboxMode ?? this['defaultSandboxMode'],
      approvalReviewer: request.approvalReviewer ?? this['defaultApprovalReviewer'],
      modelRequestCaptureEnabled:
        request.modelRequestCaptureEnabled ?? this['defaultModelRequestCaptureEnabled'],
      ...(request.costBudgetUsd !== undefined ? { costBudgetUsd: request.costBudgetUsd } : {}),
      ...(options.relation ? { relation: options.relation } : {}),
      ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      status: options.status
    })
    // `create` and destructive delete use the same per-thread mutation queue.
    // Without this, a same-id create could reopen the fence just before a
    // concurrent delete performs raw rm(), losing the new lifetime.
    await this['withThreadMutation'](thread.id, async () => {
      // A user-visible create is the only operation allowed to reactivate an
      // id after deletion. It deliberately starts a fresh generation so
      // delayed writes captured by the previous lifetime remain stale.
      this['lifecycleFence']?.reopen(id)
      await this['threadStore'].upsert(thread)
    })
    await this['events'].record({
      kind: 'thread_created',
      threadId: thread.id,
      title: thread.title,
      approvalPolicy: thread.approvalPolicy,
      sandboxMode: thread.sandboxMode,
      approvalReviewer: thread.approvalReviewer
    })
    return thread
  },

async update(this: ThreadService, threadId: string, patch: {
    title?: string
    titleAuto?: boolean
    summary?: string
    workspace?: string
    additionalWorkspaces?: string[]
    mode?: ThreadMode
    /** Archive or unarchive only; execution and deletion states are internal. */
    status?: ThreadUpdateStatus
    approvalPolicy?: ApprovalPolicy
    sandboxMode?: SandboxMode
    approvalReviewer?: ApprovalReviewer
    modelRequestCaptureEnabled?: boolean
    pinned?: boolean
    costBudgetUsd?: number | null
    costBudgetWarningSent?: boolean
    relation?: ThreadRelation
  }): Promise<ThreadRecord> {
    const updated = await this['withThreadMutation'](threadId, async () => {
      const current = await this['threadStore'].get(threadId)
      if (!current) throw new Error(`thread not found: ${threadId}`)
      // Keep this runtime check in addition to the request schema/type. The
      // service is also used directly by internal callers, and accepting an
      // arbitrary status here could desynchronise durable turn state from the
      // thread's lifecycle marker.
      if (patch.status !== undefined && patch.status !== 'idle' && patch.status !== 'archived') {
        throw new Error(`thread status is managed by the runtime: ${patch.status}`)
      }
      const { costBudgetUsd, costBudgetWarningSent, status, ...standardPatch } = patch
      if (standardPatch.additionalWorkspaces) {
        standardPatch.additionalWorkspaces = [...new Set(
          standardPatch.additionalWorkspaces.map((entry) => entry.trim()).filter(Boolean)
        )].filter((entry) => entry !== (standardPatch.workspace ?? current.workspace))
      }
      const merged: ThreadRecord = { ...current, ...standardPatch }
      if (status === 'archived') {
        // Archival is a visibility overlay: an already-active turn can settle
        // but no new turn may be admitted until the thread is restored.
        merged.status = 'archived'
      } else if (status === 'idle') {
        // Restoring an archived thread must not lie about a concurrently
        // active turn. The per-thread mutation queue serializes this with
        // TurnService transitions, so the current turns are authoritative.
        merged.status = threadStatusFromTurns(current.turns)
      }
      if (costBudgetUsd === null) {
        delete (merged as { costBudgetUsd?: number }).costBudgetUsd
        delete (merged as { costBudgetWarningSent?: boolean }).costBudgetWarningSent
      } else if (costBudgetUsd !== undefined) {
        merged.costBudgetUsd = costBudgetUsd
        merged.costBudgetWarningSent = false
      } else if (costBudgetWarningSent !== undefined) {
        merged.costBudgetWarningSent = costBudgetWarningSent
      }
      if (patch.relation !== undefined && patch.relation !== 'side') {
        // Promoting a side thread clears the parent link so the thread
        // surfaces in the default list as a standalone primary thread.
        delete (merged as { parentThreadId?: string }).parentThreadId
      }
      const next = touchThread(merged, this['nowIso']())
      await this['threadStore'].upsert(next)
      return next
    })
    await this['events'].record({
      kind: 'thread_updated',
      threadId,
      title: updated.title,
      ...(updated.titleAuto !== undefined ? { titleAuto: updated.titleAuto } : {}),
      status: updated.status,
      mode: updated.mode,
      workspace: updated.workspace,
      additionalWorkspaces: updated.additionalWorkspaces,
      approvalPolicy: updated.approvalPolicy,
      sandboxMode: updated.sandboxMode,
      approvalReviewer: updated.approvalReviewer,
      modelRequestCaptureEnabled: updated.modelRequestCaptureEnabled
    })
    await this['onStatusChanged']?.(threadId, updated.status)
    return updated
  },
}
