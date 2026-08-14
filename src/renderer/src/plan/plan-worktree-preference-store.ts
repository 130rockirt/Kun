import { create } from 'zustand'

export type PlanWorktreePreference = {
  initialized: boolean
  featureEnabled: boolean
  usePromptWorktree: boolean
  branchPrefix: string
}

type PlanWorktreePreferenceState = {
  plans: Record<string, PlanWorktreePreference>
  initializePlan: (planId: string, featureEnabled: boolean, branchPrefix: string) => void
  syncSettings: (featureEnabled: boolean, branchPrefix: string) => void
  setUsePromptWorktree: (planId: string, enabled: boolean) => void
}

function initialPreference(
  featureEnabled = false,
  branchPrefix = 'codex/'
): PlanWorktreePreference {
  return {
    initialized: false,
    featureEnabled,
    usePromptWorktree: featureEnabled,
    branchPrefix
  }
}

export const usePlanWorktreePreferenceStore = create<PlanWorktreePreferenceState>((set) => ({
  plans: {},

  initializePlan: (planId, featureEnabled, branchPrefix) => {
    set((state) => {
      if (state.plans[planId]?.initialized) return state
      return {
        plans: {
          ...state.plans,
          [planId]: {
            ...initialPreference(featureEnabled, branchPrefix),
            initialized: true
          }
        }
      }
    })
  },

  syncSettings: (featureEnabled, branchPrefix) => {
    set((state) => ({
      plans: Object.fromEntries(Object.entries(state.plans).map(([planId, current]) => {
        const featureChanged = current.featureEnabled !== featureEnabled
        return [planId, {
          ...current,
          featureEnabled,
          branchPrefix,
          usePromptWorktree: featureChanged ? featureEnabled : current.usePromptWorktree
        }]
      }))
    }))
  },

  setUsePromptWorktree: (planId, enabled) => {
    set((state) => {
      const current = state.plans[planId] ?? initialPreference()
      return {
        plans: {
          ...state.plans,
          [planId]: {
            ...current,
            initialized: true,
            usePromptWorktree: current.featureEnabled && enabled
          }
        }
      }
    })
  }
}))

export function resetPlanWorktreePreferenceStoreForTests(): void {
  usePlanWorktreePreferenceStore.setState({ plans: {} })
}
