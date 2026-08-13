import { useEffect } from 'react'
import { DEFAULT_GIT_BRANCH_PREFIX } from '@shared/app-settings'
import { getKunRuntimeSettings } from '../../../shared/app-settings-kun-defaults'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type { GuiPlanArtifact } from './plan-store'
import {
  planWorktreeContextKey,
  planWorktreeHostPlanId,
  usePlanWorktreeStore,
  type PlanWorktreePlanState
} from './plan-worktree-store'

let preflightSequence = 0

function requestId(): string {
  preflightSequence += 1
  return `plan-preflight-${Date.now().toString(36)}-${preflightSequence.toString(36)}`
}

export function planWorktreeRunMatchesPlanContext(
  run: PlanWorktreeRunRecord,
  plan: GuiPlanArtifact,
  sourceThreadId: string | null
): boolean {
  return Boolean(sourceThreadId) &&
    run.planId === planWorktreeHostPlanId(plan.id) &&
    run.sourceThreadId === sourceThreadId &&
    normalizeWorkspaceRoot(run.sourceWorkspaceRoot) === normalizeWorkspaceRoot(plan.workspaceRoot) &&
    run.planRelativePath.replaceAll('\\', '/') === plan.relativePath.replaceAll('\\', '/')
}

export function usePlanWorktreePreflight(
  plan: GuiPlanArtifact | null,
  sourceThreadId: string | null
): PlanWorktreePlanState | undefined {
  const planId = plan?.id ?? ''
  const state = usePlanWorktreeStore((store) => planId ? store.plans[planId] : undefined)

  useEffect(() => {
    if (!plan || state?.initialized) return
    let cancelled = false
    void rendererRuntimeClient.getSettings().then((settings) => {
      if (cancelled) return
      const kun = getKunRuntimeSettings(settings)
      usePlanWorktreeStore.getState().initializePlan(
        plan.id,
        kun.planExecution?.useWorktreeByDefault ?? true,
        settings.gitBranchPrefix || DEFAULT_GIT_BRANCH_PREFIX
      )
    }).catch((error) => {
      if (cancelled) return
      // The normalized product default is enabled even when settings cannot
      // be loaded. Preflight remains fail-closed and will explain host errors.
      usePlanWorktreeStore.getState().initializePlan(
        plan.id,
        true,
        DEFAULT_GIT_BRANCH_PREFIX
      )
      usePlanWorktreeStore.getState().rejectPreflight(
        plan.id,
        planWorktreeContextKey({
          planId: plan.id,
          workspaceRoot: plan.workspaceRoot,
          sourceThreadId
        }),
        'settings-load',
        error instanceof Error ? error.message : String(error)
      )
    })
    return () => { cancelled = true }
  }, [plan, sourceThreadId, state?.initialized])

  useEffect(() => {
    if (!plan || !state?.initialized || state.recoveryChecked) return
    const api = window.kunGui?.planWorktree
    if (!api) {
      usePlanWorktreeStore.getState().completeRecovery(plan.id)
      return
    }
    let cancelled = false
    void api.list({ includeCompleted: true }).then((runs) => {
      if (cancelled) return
      const hostPlanId = planWorktreeHostPlanId(plan.id)
      const latest = runs
        .filter((run) => run.planId === hostPlanId &&
          planWorktreeRunMatchesPlanContext(run, plan, sourceThreadId))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
      usePlanWorktreeStore.getState().completeRecovery(plan.id, latest)
    }).catch(() => {
      if (!cancelled) usePlanWorktreeStore.getState().completeRecovery(plan.id)
    })
    return () => { cancelled = true }
  }, [plan, sourceThreadId, state?.initialized, state?.recoveryChecked])

  useEffect(() => {
    if (!plan || !state?.initialized || !state.useWorktree) return
    const contextKey = planWorktreeContextKey({
      planId: plan.id,
      workspaceRoot: plan.workspaceRoot,
      sourceThreadId
    })
    const current = state.preflight
    if (current.contextKey === contextKey && current.status !== 'idle') return
    const nextRequestId = requestId()
    const store = usePlanWorktreeStore.getState()
    store.beginPreflight(plan.id, contextKey, nextRequestId)
    const api = window.kunGui?.planWorktree
    if (!api) {
      store.rejectPreflight(
        plan.id,
        contextKey,
        nextRequestId,
        'Plan worktree host API is unavailable.'
      )
      return
    }
    void api.preflight({
      workspaceRoot: plan.workspaceRoot,
      ...(state.branchPrefix ? { branchPrefix: state.branchPrefix } : {})
    }).then((result) => {
      usePlanWorktreeStore.getState().resolvePreflight(
        plan.id,
        contextKey,
        nextRequestId,
        result
      )
    }).catch((error) => {
      usePlanWorktreeStore.getState().rejectPreflight(
        plan.id,
        contextKey,
        nextRequestId,
        error instanceof Error ? error.message : String(error)
      )
    })
  }, [plan, sourceThreadId, state?.branchPrefix, state?.initialized, state?.preflight, state?.useWorktree])

  return state
}

export function resetPlanPreflightSequenceForTests(): void {
  preflightSequence = 0
}
