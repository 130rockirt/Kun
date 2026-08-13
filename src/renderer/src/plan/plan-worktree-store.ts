import { create } from 'zustand'
import type {
  PlanWorktreePreflightResult,
  PlanWorktreeRunRecord
} from '@shared/plan-worktree'
import {
  forgetThreadWorktree,
  readThreadWorktreeRegistry,
  saveThreadWorktreeRegistry
} from '../lib/thread-worktree-registry'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'

export type PlanWorktreePreflightState =
  | { status: 'idle'; contextKey: string }
  | { status: 'loading'; contextKey: string; requestId: string }
  | {
      status: 'ready'
      contextKey: string
      requestId: string
      result: PlanWorktreePreflightResult
    }
  | { status: 'error'; contextKey: string; requestId: string; message: string }

export type PlanWorktreePlanState = {
  initialized: boolean
  recoveryChecked: boolean
  useWorktree: boolean
  branchPrefix?: string
  preflight: PlanWorktreePreflightState
  building: boolean
  operationId?: string
  buildError?: string
  run?: PlanWorktreeRunRecord
}

type PlanWorktreeUiState = {
  plans: Record<string, PlanWorktreePlanState>
  initializePlan: (planId: string, useWorktree: boolean, branchPrefix?: string) => void
  setUseWorktree: (planId: string, useWorktree: boolean) => void
  retryPreflight: (planId: string) => void
  completeRecovery: (planId: string, run?: PlanWorktreeRunRecord) => void
  beginPreflight: (planId: string, contextKey: string, requestId: string) => void
  resolvePreflight: (
    planId: string,
    contextKey: string,
    requestId: string,
    result: PlanWorktreePreflightResult
  ) => void
  rejectPreflight: (
    planId: string,
    contextKey: string,
    requestId: string,
    message: string
  ) => void
  beginBuild: (planId: string) => string | null
  finishBuild: (planId: string, operationId: string, run: PlanWorktreeRunRecord) => void
  failBuild: (
    planId: string,
    operationId: string,
    message: string,
    run?: PlanWorktreeRunRecord
  ) => void
  upsertRun: (run: PlanWorktreeRunRecord) => void
}

let operationSequence = 0

function emptyPlanState(): PlanWorktreePlanState {
  return {
    initialized: false,
    recoveryChecked: false,
    useWorktree: true,
    preflight: { status: 'idle', contextKey: '' },
    building: false
  }
}

function operationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return `plan-build-${randomId}`
  operationSequence += 1
  return `plan-build-${Date.now().toString(36)}-${operationSequence.toString(36)}`
}

export function planWorktreeRunIsTerminal(run: PlanWorktreeRunRecord | undefined): boolean {
  return run?.status === 'completed' || run?.status === 'cancelled'
}

function updatePlan(
  plans: Record<string, PlanWorktreePlanState>,
  planId: string,
  updater: (current: PlanWorktreePlanState) => PlanWorktreePlanState
): Record<string, PlanWorktreePlanState> {
  return { ...plans, [planId]: updater(plans[planId] ?? emptyPlanState()) }
}

function clearTerminalExecutionWorktree(run: PlanWorktreeRunRecord): void {
  if (!planWorktreeRunIsTerminal(run) || !run.executionThreadId) return
  saveThreadWorktreeRegistry(forgetThreadWorktree(
    run.executionThreadId,
    readThreadWorktreeRegistry()
  ))
}

export function planWorktreeGuiPlanIdForRun(run: PlanWorktreeRunRecord): string {
  return `${normalizeWorkspaceRoot(run.sourceWorkspaceRoot)}:${run.planRelativePath.replaceAll('\\', '/')}`
}

function updateCanonicalRun(
  plans: Record<string, PlanWorktreePlanState>,
  planId: string,
  run: PlanWorktreeRunRecord,
  updater: (current: PlanWorktreePlanState) => PlanWorktreePlanState
): Record<string, PlanWorktreePlanState> {
  const next = { ...plans }
  for (const [key, current] of Object.entries(next)) {
    if (key !== planId && current.run?.runId === run.runId) delete next[key]
  }
  next[planId] = updater(next[planId] ?? emptyPlanState())
  return next
}

export const usePlanWorktreeStore = create<PlanWorktreeUiState>((set, get) => ({
  plans: {},

  initializePlan: (planId, useWorktree, branchPrefix) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => current.initialized
        ? current
        : {
            ...current,
            initialized: true,
            useWorktree,
            ...(branchPrefix?.trim() ? { branchPrefix: branchPrefix.trim() } : {})
          })
    }))
  },

  setUseWorktree: (planId, useWorktree) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => ({
        ...current,
        initialized: true,
        useWorktree,
        buildError: undefined,
        ...(!useWorktree ? { preflight: { status: 'idle' as const, contextKey: '' } } : {})
      }))
    }))
  },

  retryPreflight: (planId) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => ({
        ...current,
        buildError: undefined,
        preflight: { status: 'idle', contextKey: '' }
      }))
    }))
  },

  completeRecovery: (planId, run) => {
    set((state) => ({
      plans: run
        ? updateCanonicalRun(state.plans, planId, run, (current) => ({
            ...current,
            recoveryChecked: true,
            run
          }))
        : updatePlan(state.plans, planId, (current) => ({
            ...current,
            recoveryChecked: true
          }))
    }))
  },

  beginPreflight: (planId, contextKey, requestId) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => ({
        ...current,
        preflight: { status: 'loading', contextKey, requestId }
      }))
    }))
  },

  resolvePreflight: (planId, contextKey, requestId, result) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => {
        const pending = current.preflight
        if (
          pending.status !== 'loading' ||
          pending.contextKey !== contextKey ||
          pending.requestId !== requestId
        ) return current
        return {
          ...current,
          preflight: { status: 'ready', contextKey, requestId, result }
        }
      })
    }))
  },

  rejectPreflight: (planId, contextKey, requestId, message) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) => {
        const pending = current.preflight
        if (
          pending.status !== 'loading' ||
          pending.contextKey !== contextKey ||
          pending.requestId !== requestId
        ) return current
        return {
          ...current,
          preflight: { status: 'error', contextKey, requestId, message }
        }
      })
    }))
  },

  beginBuild: (planId) => {
    const current = get().plans[planId]
    if (
      !current?.initialized || current.building ||
      (current.run !== undefined && !planWorktreeRunIsTerminal(current.run))
    ) return null
    const nextOperationId = planWorktreeRunIsTerminal(current.run)
      ? operationId()
      : current.operationId ?? operationId()
    set((state) => ({
      plans: updatePlan(state.plans, planId, (entry) => ({
        ...entry,
        building: true,
        operationId: nextOperationId,
        buildError: undefined
      }))
    }))
    return nextOperationId
  },

  finishBuild: (planId, expectedOperationId, run) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) =>
        current.operationId !== expectedOperationId
          ? current
          : {
              ...current,
              building: false,
              operationId: undefined,
              buildError: undefined,
              run
            })
    }))
  },

  failBuild: (planId, expectedOperationId, message, run) => {
    set((state) => ({
      plans: updatePlan(state.plans, planId, (current) =>
        current.operationId !== expectedOperationId
          ? current
          : {
              ...current,
              building: false,
              buildError: message,
              ...(run ? { run, operationId: expectedOperationId } : {})
            })
    }))
  },

  upsertRun: (run) => {
    clearTerminalExecutionWorktree(run)
    set((state) => ({
      plans: updateCanonicalRun(
        state.plans,
        planWorktreeGuiPlanIdForRun(run),
        run,
        (current) => ({
          ...current,
          run,
          building: current.building && run.status === 'preparing',
          ...(planWorktreeRunIsTerminal(run) ? { operationId: undefined } : {})
        })
      )
    }))
  }
}))

export function planWorktreeContextKey(input: {
  planId: string
  workspaceRoot: string
  sourceThreadId: string | null
}): string {
  return [input.planId, input.workspaceRoot.trim(), input.sourceThreadId?.trim() ?? ''].join('\u0000')
}

/** Convert path-shaped GUI plan ids into the bounded identifier accepted by
 * the host coordinator without persisting or exposing the source path. */
export function planWorktreeHostPlanId(planId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < planId.length; index += 1) {
    hash ^= planId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `gui-plan-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function resetPlanWorktreeStoreForTests(): void {
  operationSequence = 0
  usePlanWorktreeStore.setState({ plans: {} })
}
