import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetPlanWorktreePreferenceStoreForTests,
  usePlanWorktreePreferenceStore
} from './plan-worktree-preference-store'

describe('plan worktree preference store', () => {
  beforeEach(() => resetPlanWorktreePreferenceStoreForTests())

  it('defaults each plan to the Laboratory feature value', () => {
    const store = usePlanWorktreePreferenceStore.getState()
    store.initializePlan('disabled', false, 'codex/')
    store.initializePlan('enabled', true, 'kun/')

    expect(usePlanWorktreePreferenceStore.getState().plans).toMatchObject({
      disabled: { featureEnabled: false, usePromptWorktree: false, branchPrefix: 'codex/' },
      enabled: { featureEnabled: true, usePromptWorktree: true, branchPrefix: 'kun/' }
    })
  })

  it('shares a per-plan override and preserves it while the feature stays enabled', () => {
    const store = usePlanWorktreePreferenceStore.getState()
    store.initializePlan('plan', true, 'codex/')
    store.setUsePromptWorktree('plan', false)
    store.syncSettings(true, 'team/')

    expect(usePlanWorktreePreferenceStore.getState().plans.plan).toMatchObject({
      featureEnabled: true,
      usePromptWorktree: false,
      branchPrefix: 'team/'
    })
  })

  it('turns the choice off with the experiment and defaults it on when re-enabled', () => {
    const store = usePlanWorktreePreferenceStore.getState()
    store.initializePlan('plan', true, 'codex/')
    store.syncSettings(false, 'codex/')
    expect(usePlanWorktreePreferenceStore.getState().plans.plan?.usePromptWorktree).toBe(false)

    usePlanWorktreePreferenceStore.getState().syncSettings(true, 'codex/')
    expect(usePlanWorktreePreferenceStore.getState().plans.plan?.usePromptWorktree).toBe(true)
  })
})
