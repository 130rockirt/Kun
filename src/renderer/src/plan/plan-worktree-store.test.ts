import { beforeEach, describe, expect, it } from 'vitest'
import {
  planWorktreeGuiPlanIdForRun,
  planWorktreeHostPlanId,
  resetPlanWorktreeStoreForTests,
  usePlanWorktreeStore
} from './plan-worktree-store'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'

const eligible = {
  eligible: true,
  sourceWorkspaceRoot: '/repo',
  sourceCheckoutRoot: '/repo',
  primaryRepositoryRoot: '/repo',
  repositoryIdentity: '/repo/.git',
  targetBranch: 'feature/source',
  baseCommit: 'a'.repeat(40),
  sourceIsLinkedWorktree: false,
  checkedAt: '2026-08-12T00:00:00.000Z'
} as const

function run(status: PlanWorktreeRunRecord['status']): PlanWorktreeRunRecord {
  return {
    version: 1, runId: 'run-a', operationId: 'operation-a', planId: 'plan-a',
    planRelativePath: '.kunsdd/plan/demo.md', planTitle: 'Demo', goalObjective: 'Build Demo',
    sourceThreadId: 'thread-a', orchestration: 'direct', sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo', primaryRepositoryRoot: '/repo', repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source', baseCommit: 'a'.repeat(40), executionBranch: 'codex/demo',
    worktreePath: '/managed/demo/repo', status,
    cleanup: { threadRebound: false, worktreeRemoved: false, branchDeleted: false, metadataPruned: false },
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

describe('plan worktree UI state', () => {
  beforeEach(() => resetPlanWorktreeStoreForTests())

  it('initializes once from the default and shares the per-plan override', () => {
    const state = usePlanWorktreeStore.getState()
    state.initializePlan('plan-a', true, 'codex/')
    state.setUseWorktree('plan-a', false)
    state.initializePlan('plan-a', true, 'other/')
    state.initializePlan('plan-b', true, 'codex/')

    expect(usePlanWorktreeStore.getState().plans).toMatchObject({
      'plan-a': { initialized: true, featureEnabled: true, useWorktree: false, branchPrefix: 'codex/' },
      'plan-b': { initialized: true, featureEnabled: true, useWorktree: true }
    })
  })

  it('forces isolation off with the experiment and restores it only on explicit opt-in', () => {
    const state = usePlanWorktreeStore.getState()
    state.initializePlan('plan-a', true, 'codex/')
    state.setUseWorktree('plan-a', false)

    state.syncFeatureEnabled(true)
    expect(usePlanWorktreeStore.getState().plans['plan-a']?.useWorktree).toBe(false)

    state.syncFeatureEnabled(false)
    expect(usePlanWorktreeStore.getState().plans['plan-a']).toMatchObject({
      featureEnabled: false,
      useWorktree: false,
      preflight: { status: 'idle' }
    })
    expect(usePlanWorktreeStore.getState().beginBuild('plan-a')).toBeNull()

    state.syncFeatureEnabled(true)
    expect(usePlanWorktreeStore.getState().plans['plan-a']).toMatchObject({
      featureEnabled: true,
      useWorktree: true
    })
  })

  it('drops a stale preflight response after the plan/thread context changes', () => {
    const state = usePlanWorktreeStore.getState()
    state.initializePlan('plan-a', true)
    state.beginPreflight('plan-a', 'plan-a\u0000/repo\u0000thread-a', 'request-a')
    state.beginPreflight('plan-a', 'plan-a\u0000/repo\u0000thread-b', 'request-b')
    state.resolvePreflight(
      'plan-a',
      'plan-a\u0000/repo\u0000thread-a',
      'request-a',
      eligible
    )

    expect(usePlanWorktreeStore.getState().plans['plan-a']?.preflight).toMatchObject({
      status: 'loading',
      contextKey: 'plan-a\u0000/repo\u0000thread-b',
      requestId: 'request-b'
    })
  })

  it('creates a bounded stable host id for path-shaped GUI plan identities', () => {
    const source = '/very/long/repo:.kunsdd/plan/checkout.md'
    expect(planWorktreeHostPlanId(source)).toMatch(/^gui-plan-[0-9a-f]{8}$/)
    expect(planWorktreeHostPlanId(source)).toBe(planWorktreeHostPlanId(source))
    expect(planWorktreeHostPlanId(`${source}-other`)).not.toBe(planWorktreeHostPlanId(source))
  })

  it('blocks a second build for a nonterminal run and allocates a new operation after terminal recovery', () => {
    const state = usePlanWorktreeStore.getState()
    const guiPlanId = planWorktreeGuiPlanIdForRun(run('executing'))
    state.initializePlan(guiPlanId, true)
    const firstOperation = state.beginBuild(guiPlanId)!
    state.failBuild(guiPlanId, firstOperation, 'admission failed', run('executing'))
    expect(usePlanWorktreeStore.getState().beginBuild(guiPlanId)).toBeNull()

    usePlanWorktreeStore.getState().upsertRun(run('completed'))
    const restarted = usePlanWorktreeStore.getState().beginBuild(guiPlanId)
    expect(restarted).toBeTruthy()
    expect(restarted).not.toBe(firstOperation)
  })

  it('keeps one canonical GUI key when global recovery first creates a host-id alias', () => {
    const recovered = run('executing')
    const guiPlanId = planWorktreeGuiPlanIdForRun(recovered)
    usePlanWorktreeStore.setState({
      plans: {
        [recovered.planId]: {
          initialized: false, recoveryChecked: true, featureEnabled: true,
          useWorktree: true, building: false,
          preflight: { status: 'idle', contextKey: '' }, run: recovered
        },
        [guiPlanId]: {
          initialized: true, recoveryChecked: false, featureEnabled: true,
          useWorktree: true, building: false,
          preflight: { status: 'idle', contextKey: '' }
        }
      }
    })

    usePlanWorktreeStore.getState().upsertRun(recovered)

    expect(Object.keys(usePlanWorktreeStore.getState().plans)).toEqual([guiPlanId])
    expect(usePlanWorktreeStore.getState().plans[guiPlanId]?.run?.runId).toBe(recovered.runId)
  })
})
