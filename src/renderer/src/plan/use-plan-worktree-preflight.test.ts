import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  normalizeAppSettings,
  type AppSettingsV1
} from '@shared/app-settings'
import type { PlanWorktreePreflightResult, PlanWorktreeRunRecord } from '@shared/plan-worktree'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { createGuiPlanArtifact } from './plan-store'
import {
  planWorktreeHostPlanId,
  resetPlanWorktreeStoreForTests,
  usePlanWorktreeStore
} from './plan-worktree-store'
import {
  planWorktreeRunMatchesPlanContext,
  usePlanWorktreePreflight
} from './use-plan-worktree-preflight'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function result(branch: string): PlanWorktreePreflightResult {
  return {
    eligible: true,
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: branch,
    baseCommit: 'a'.repeat(40),
    sourceIsLinkedWorktree: false,
    checkedAt: '2026-08-12T00:00:00.000Z'
  }
}

function recoveredRun(planId: string): PlanWorktreeRunRecord {
  return {
    version: 1, runId: 'run-a', operationId: 'operation-a', planId,
    planRelativePath: '.kunsdd/plan/demo.md', planTitle: 'Demo', goalObjective: 'Build Demo',
    sourceThreadId: 'thread-a', orchestration: 'direct', sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo', primaryRepositoryRoot: '/repo', repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source', baseCommit: 'a'.repeat(40), executionBranch: 'codex/demo',
    worktreePath: '/managed/run/repo', status: 'executing',
    cleanup: { threadRebound: false, worktreeRemoved: false, branchDeleted: false, metadataPruned: false },
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

describe('plan worktree preflight hook', () => {
  afterEach(() => {
    rendererRuntimeClient.invalidateSettings()
    resetPlanWorktreeStoreForTests()
    vi.unstubAllGlobals()
  })

  it('keeps isolation off when legacy settings omit the preference', async () => {
    const preflight = vi.fn()
    const legacyKun = defaultKunRuntimeSettings() as Partial<ReturnType<typeof defaultKunRuntimeSettings>>
    delete legacyKun.planExecution
    const settings = normalizeAppSettings({
      version: 1,
      agents: { kun: legacyKun }
    } as unknown as AppSettingsV1)
    vi.stubGlobal('window', {
      kunGui: {
        getSettings: vi.fn(async () => settings),
        planWorktree: {
          preflight,
          list: vi.fn(async () => [])
        }
      }
    })
    const plan = createGuiPlanArtifact({
      workspaceRoot: '/repo',
      threadId: 'thread-a',
      relativePath: '.kunsdd/plan/demo.md',
      sourceRequest: 'Demo'
    })
    let renderer: ReactTestRenderer
    function Harness(): null {
      usePlanWorktreePreflight(plan, 'thread-a')
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })

    expect(usePlanWorktreeStore.getState().plans[plan.id]).toMatchObject({
      initialized: true,
      useWorktree: false,
      preflight: { status: 'idle' }
    })
    expect(preflight).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })

  it('ignores the older response after the source thread context changes', async () => {
    const first = deferred<PlanWorktreePreflightResult>()
    const second = deferred<PlanWorktreePreflightResult>()
    const preflight = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    vi.stubGlobal('window', {
      kunGui: {
        planWorktree: {
          preflight,
          list: vi.fn(async () => [])
        }
      }
    })
    const plan = createGuiPlanArtifact({
      workspaceRoot: '/repo',
      threadId: 'thread-a',
      relativePath: '.kunsdd/plan/demo.md',
      sourceRequest: 'Demo'
    })
    usePlanWorktreeStore.getState().initializePlan(plan.id, true, 'codex/')
    let renderer: ReactTestRenderer
    function Harness({ threadId }: { threadId: string }): null {
      usePlanWorktreePreflight(plan, threadId)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { threadId: 'thread-a' }))
    })
    await act(async () => {
      renderer!.update(createElement(Harness, { threadId: 'thread-b' }))
    })
    await act(async () => { first.resolve(result('branch-a')) })
    expect(usePlanWorktreeStore.getState().plans[plan.id]?.preflight).toMatchObject({
      status: 'loading'
    })
    await act(async () => { second.resolve(result('branch-b')) })
    expect(usePlanWorktreeStore.getState().plans[plan.id]?.preflight).toMatchObject({
      status: 'ready',
      result: { targetBranch: 'branch-b' }
    })
    expect(preflight).toHaveBeenCalledTimes(2)
    act(() => renderer!.unmount())
  })

  it('requires thread, workspace, and relative path in addition to the host hash', () => {
    const plan = createGuiPlanArtifact({
      workspaceRoot: '/repo', threadId: 'thread-a',
      relativePath: '.kunsdd/plan/demo.md', sourceRequest: 'Demo'
    })
    const candidate = recoveredRun(planWorktreeHostPlanId(plan.id))

    expect(planWorktreeRunMatchesPlanContext(candidate, plan, 'thread-a')).toBe(true)
    expect(planWorktreeRunMatchesPlanContext(
      { ...candidate, sourceThreadId: 'thread-b' }, plan, 'thread-a'
    )).toBe(false)
    expect(planWorktreeRunMatchesPlanContext(
      { ...candidate, sourceWorkspaceRoot: '/other' }, plan, 'thread-a'
    )).toBe(false)
    expect(planWorktreeRunMatchesPlanContext(
      { ...candidate, planRelativePath: '.kunsdd/plan/other.md' }, plan, 'thread-a'
    )).toBe(false)
  })
})
