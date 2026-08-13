import { useEffect } from 'react'
import { DEFAULT_GIT_BRANCH_PREFIX, type AppSettingsV1 } from '@shared/app-settings'
import { getKunRuntimeSettings } from '../../../shared/app-settings-kun-defaults'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { SETTINGS_CHANGED_EVENT } from '../lib/keyboard-shortcut-settings'
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
    if (typeof window.addEventListener !== 'function') return
    const onSettingsChanged = (event: Event): void => {
      const settings = (event as CustomEvent<AppSettingsV1>).detail
      if (!settings) return
      const kun = getKunRuntimeSettings(settings)
      usePlanWorktreeStore.getState().syncFeatureEnabled(
        kun.lab.planWorktree.enabled,
        settings.gitBranchPrefix || DEFAULT_GIT_BRANCH_PREFIX
      )
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
  }, [])

  useEffect(() => {
    if (!plan) return
    let cancelled = false
    void rendererRuntimeClient.getSettings().then((settings) => {
      if (cancelled) return
      const kun = getKunRuntimeSettings(settings)
      const store = usePlanWorktreeStore.getState()
      const branchPrefix = settings.gitBranchPrefix || DEFAULT_GIT_BRANCH_PREFIX
      if (store.plans[plan.id]?.initialized) {
        store.syncFeatureEnabled(kun.lab.planWorktree.enabled, branchPrefix)
      } else {
        store.initializePlan(plan.id, kun.lab.planWorktree.enabled, branchPrefix)
      }
    }).catch(() => {
      if (cancelled) return
      // Keep current-workspace execution as the product default when settings
      // cannot be loaded; isolation can still be enabled explicitly afterward.
      const store = usePlanWorktreeStore.getState()
      if (!store.plans[plan.id]?.initialized) {
        store.initializePlan(plan.id, false, DEFAULT_GIT_BRANCH_PREFIX)
      }
    })
    return () => { cancelled = true }
  }, [plan])

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
    if (!plan || !state?.initialized || !state.featureEnabled || !state.useWorktree) return
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
  }, [
    plan,
    sourceThreadId,
    state?.branchPrefix,
    state?.featureEnabled,
    state?.initialized,
    state?.preflight,
    state?.useWorktree
  ])

  return state
}

export function resetPlanPreflightSequenceForTests(): void {
  preflightSequence = 0
}
