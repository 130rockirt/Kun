import i18n from '../i18n'
import { formatRuntimeError } from '../lib/format-runtime-error'
import {
  markThreadFork,
  readThreadForkRegistry,
  saveThreadForkRegistry
} from '../lib/thread-fork-registry'
import {
  markThreadWorktree,
  readThreadWorktreeRegistry,
  saveThreadWorktreeRegistry
} from '../lib/thread-worktree-registry'
import type { PlanWorktreeApi, PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type {
  ChatState,
  ChatStoreGet,
  ChatStoreSet,
  IsolatedPlanBuildRequest,
  IsolatedPlanBuildResult
} from './chat-store-types'

export type PlanWorktreeActionDependencies = {
  getApi?: () => PlanWorktreeApi
}

function hostApi(): PlanWorktreeApi {
  const api = window.kunGui?.planWorktree
  if (!api) throw new Error('Plan worktree host API is unavailable.')
  return api
}

function failure(
  message: string,
  run?: PlanWorktreeRunRecord,
  executionThreadId?: string
): IsolatedPlanBuildResult {
  return {
    ok: false,
    message,
    ...(run ? { run } : {}),
    ...(executionThreadId ? { executionThreadId } : {})
  }
}

/**
 * Own the renderer half of one isolated build transaction. The operation map
 * prevents a double click from repeating the host-owned atomic prepare and
 * execution-thread binding transaction.
 */
export function createPlanWorktreeActions(
  { set, get }: { set: ChatStoreSet; get: ChatStoreGet },
  dependencies: PlanWorktreeActionDependencies = {}
): Pick<ChatState, 'startIsolatedPlanBuild'> {
  const inFlight = new Map<string, Promise<IsolatedPlanBuildResult>>()
  const apiForBuild = dependencies.getApi ?? hostApi

  const execute = async (input: IsolatedPlanBuildRequest): Promise<IsolatedPlanBuildResult> => {
    let run: PlanWorktreeRunRecord | undefined
    let executionThreadId: string | undefined
    try {
      const state = get()
      if (state.runtimeConnection !== 'ready') {
        throw new Error(i18n.t('common:runtimeActionNeedsConnection'))
      }
      if (state.activeThreadId !== input.sourceThreadId) {
        throw new Error(i18n.t('common:planWorktreeSourceThreadChanged'))
      }
      const api = apiForBuild()
      run = await api.prepare({
        operationId: input.operationId,
        planId: input.planId,
        planRelativePath: input.planRelativePath,
        planTitle: input.planTitle,
        goalObjective: input.goalObjective,
        executionPrompt: input.prompt,
        executionDisplayText: input.displayText,
        sourceThreadId: input.sourceThreadId,
        sourceWorkspaceRoot: input.sourceWorkspaceRoot,
        orchestration: input.orchestration,
        ...(input.branchPrefix ? { branchPrefix: input.branchPrefix } : {})
      })
      // Main creates and binds the execution fork before prepare resolves.
      // A needs_attention prepare is Main's durable failure verdict: the
      // record carries the first failure (attentionMessage). Reconciling here
      // would only re-project the recovered thread and hide that original
      // error, so surface it immediately.
      if (!run.executionThreadId && run.status === 'needs_attention') {
        throw new Error(
          run.attentionMessage
            || run.attentionReason
            || 'The isolated plan-build preparation failed.'
        )
      }
      // Reconcile recovers a response-loss replay without exposing a renderer
      // fallback that could start a foreign first turn.
      run = await api.reconcile({ runId: run.runId })
      executionThreadId = run.executionThreadId
      if (!executionThreadId) {
        throw new Error('Main did not durably bind the isolated execution thread.')
      }
      const linkedThreadId = executionThreadId

      const parent = state.threads.find((thread) => thread.id === input.sourceThreadId) ?? {
        id: input.sourceThreadId,
        title: input.planTitle
      }
      saveThreadForkRegistry(markThreadFork(
        linkedThreadId,
        parent,
        { createdAt: run.createdAt },
        readThreadForkRegistry()
      ))
      saveThreadWorktreeRegistry(markThreadWorktree(
        linkedThreadId,
        {
          projectPath: run.primaryRepositoryRoot,
          worktreePath: run.worktreePath,
          branch: run.executionBranch,
          createdAt: run.createdAt
        },
        readThreadWorktreeRegistry()
      ))

      // Reconciliation may also recover the immutable origin turn. Never
      // create a second implementation turn for the same plan-build run.
      if (run.executionTurnId) {
        await get().refreshThreads()
        await get().openCode()
        await get().selectThread(linkedThreadId)
        set({ error: null })
        return { ok: true, run, executionThreadId: linkedThreadId }
      }

      // Main owns the exact durable goal+turn admission. Its retry-stable
      // clientRequestId makes a commit-then-response-loss replay return the
      // immutable origin instead of creating another implementation turn.
      run = await api.resumeAdmission({ runId: run.runId })
      if (!run.executionTurnId) throw new Error('Kun did not durably admit the execution turn.')
      await get().refreshThreads()
      await get().openCode()
      await get().selectThread(linkedThreadId)
      set({ error: null })
      return { ok: true, run, executionThreadId: linkedThreadId }
    } catch (error) {
      const message = formatRuntimeError(error)
      set({ error: message })
      return failure(message, run, executionThreadId)
    }
  }

  return {
    startIsolatedPlanBuild: (input) => {
      const key = input.operationId.trim()
      const existing = inFlight.get(key)
      if (existing) return existing
      const task = execute(input).finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key)
      })
      inFlight.set(key, task)
      return task
    }
  }
}
