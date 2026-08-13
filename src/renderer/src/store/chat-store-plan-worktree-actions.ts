import type { AgentProvider } from '../agent/provider-types'
import { getProvider } from '../agent/registry'
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

type PlanBuildProvider = Pick<
  AgentProvider,
  'forkThread'
>

export type PlanWorktreeActionDependencies = {
  getProvider?: () => PlanBuildProvider
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
 * prevents a double click from forking two execution threads after the host's
 * idempotent prepare call returns the same durable run.
 */
export function createPlanWorktreeActions(
  { set, get }: { set: ChatStoreSet; get: ChatStoreGet },
  dependencies: PlanWorktreeActionDependencies = {}
): Pick<ChatState, 'startIsolatedPlanBuild'> {
  const inFlight = new Map<string, Promise<IsolatedPlanBuildResult>>()
  const providerForBuild = dependencies.getProvider ?? getProvider
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
      const provider = providerForBuild()
      if (typeof provider.forkThread !== 'function') {
        throw new Error(i18n.t('common:runtimeFeatureUnsupported'))
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
      // A prior request may have committed the deterministic Kun fork before
      // its HTTP response or renderer attachment was observed. Let the host
      // discover and verify that link before asking Kun to fork again.
      run = await api.reconcile({ runId: run.runId })
      if (run.executionThreadId) {
        executionThreadId = run.executionThreadId
      } else {
        const forked = await provider.forkThread(input.sourceThreadId, {
          relation: 'side',
          workspace: run.executionWorkspace ?? run.worktreePath,
          planBuildRunId: run.runId,
          planBuildAgentSurface: 'code'
        })
        executionThreadId = forked.id

        // Persist the minimum recovery link immediately after the fork succeeds.
        // A renderer/app crash during goal creation or admission must still leave
        // a host-authoritative path back to the execution thread and worktree.
        run = await api.attachThread({
          runId: run.runId,
          executionThreadId: forked.id
        })
      }

      const linkedThreadId = executionThreadId
      if (!linkedThreadId) throw new Error('Kun did not return an execution thread.')

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
      await get().selectThread(linkedThreadId)
      set({ error: null })
      return { ok: true, run, executionThreadId: linkedThreadId }
    } catch (error) {
      const message = formatRuntimeError(error)
      // A fork can exist even when goal creation, selection, or admission
      // failed. Link it after the failed admission path whenever possible so
      // the retained worktree remains recoverable without starting a fallback
      // turn in the source checkout.
      if (run && executionThreadId && !run.executionThreadId) {
        try {
          run = await apiForBuild().attachThread({
            runId: run.runId,
            executionThreadId
          })
        } catch {
          // The durable preparing/executing record is still the authority.
        }
      }
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
