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

export const threadServiceGoalsOperations = {
async getGoal(this: ThreadService, threadId: string): Promise<ThreadGoal | null> {
    const current = await this['threadStore'].get(threadId)
    if (!current) throw new Error(`thread not found: ${threadId}`)
    return current.goal ?? null
  },

async setGoal(this: ThreadService, threadId: string, request: SetThreadGoalRequest): Promise<ThreadGoal> {
    const goal = await this['withThreadMutation'](threadId, async () => {
      const current = await this['threadStore'].get(threadId)
      if (!current) throw new Error(`thread not found: ${threadId}`)
      if (!current.goal && !request.objective) {
        throw new Error(`cannot update goal for thread ${threadId}: no goal exists`)
      }

      const now = this['nowIso']()
      const existing = current.goal
      const objective = request.objective?.trim()
      const next: ThreadGoal = {
        threadId,
        objective: objective ?? existing?.objective ?? '',
        status: request.status ?? (objective ? 'active' : existing?.status ?? 'active'),
        ...(request.tokenBudget !== undefined
          ? request.tokenBudget === null
            ? {}
            : { tokenBudget: request.tokenBudget }
          : existing?.tokenBudget !== undefined
            ? { tokenBudget: existing.tokenBudget }
            : {}),
        tokensUsed: existing?.tokensUsed ?? 0,
        timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }

      await this['threadStore'].upsert(touchThread({ ...current, goal: next }, now))
      return next
    })
    await this['events'].record({
      kind: 'goal_updated',
      threadId,
      goal
    })
    return goal
  },

/** Add provider-reported token usage to an active goal and enforce its cap. */
async recordGoalUsage(this: ThreadService, threadId: string, tokenDelta: number): Promise<ThreadGoal | null> {
    const delta = Math.max(0, Math.floor(tokenDelta))
    if (delta === 0) return this.getGoal(threadId)
    const goal = await this['withThreadMutation'](threadId, async () => {
      const current = await this['threadStore'].get(threadId)
      if (!current?.goal || current.goal.status !== 'active') return current?.goal ?? null
      const nextTokens = current.goal.tokensUsed + delta
      const next: ThreadGoal = {
        ...current.goal,
        tokensUsed: nextTokens,
        status: current.goal.tokenBudget !== undefined && current.goal.tokenBudget !== null && nextTokens >= current.goal.tokenBudget
          ? 'usageLimited'
          : current.goal.status,
        updatedAt: this['nowIso']()
      }
      await this['threadStore'].upsert(touchThread({ ...current, goal: next }, next.updatedAt))
      return next
    })
    if (!goal) return null
    await this['events'].record({ kind: 'goal_updated', threadId, goal })
    return goal
  },

async clearGoal(this: ThreadService, threadId: string): Promise<boolean> {
    const cleared = await this['withThreadMutation'](threadId, async () => {
      const current = await this['threadStore'].get(threadId)
      if (!current) throw new Error(`thread not found: ${threadId}`)
      if (!current.goal) return false
      const updated = touchThread({ ...current }, this['nowIso']())
      delete (updated as { goal?: ThreadGoal }).goal
      await this['threadStore'].upsert(updated)
      return true
    })
    if (!cleared) return false
    await this['events'].record({
      kind: 'goal_cleared',
      threadId,
      cleared: true
    })
    return true
  },
}
