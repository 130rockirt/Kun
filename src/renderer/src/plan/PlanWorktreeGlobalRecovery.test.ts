import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import { PlanWorktreeGlobalRecovery } from './PlanWorktreeGlobalRecovery'
import {
  planWorktreeGuiPlanIdForRun,
  resetPlanWorktreeStoreForTests,
  usePlanWorktreeStore
} from './plan-worktree-store'

const run = {
  runId: 'run-recovery',
  planId: 'plan-recovery',
  sourceWorkspaceRoot: '/workspace',
  planRelativePath: 'plans/recovery.md',
  status: 'executing'
} as PlanWorktreeRunRecord

describe('global plan-worktree recovery', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    resetPlanWorktreeStoreForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('discovers and reconciles unfinished runs without opening their plan or thread', async () => {
    const list = vi.fn(async () => [run])
    const reconcile = vi.fn(async () => ({ ...run, status: 'completed' as const }))
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      kunGui: { planWorktree: { list, reconcile } }
    })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(PlanWorktreeGlobalRecovery, { runtimeReady: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(list).toHaveBeenCalledWith({ includeCompleted: false })
    expect(reconcile).toHaveBeenCalledWith({ runId: run.runId })
    expect(usePlanWorktreeStore.getState().plans[planWorktreeGuiPlanIdForRun(run)]?.run?.status)
      .toBe('completed')
    act(() => renderer?.unmount())
  })

  it('waits until the runtime is ready', async () => {
    const list = vi.fn(async () => [])
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      kunGui: { planWorktree: { list, reconcile: vi.fn() } }
    })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(PlanWorktreeGlobalRecovery, { runtimeReady: false }))
      await Promise.resolve()
    })
    expect(list).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
  })

  it('resumes exact durable admission after a crash between thread attach and turn admission', async () => {
    const attached = {
      ...run,
      executionThreadId: 'thread-execution',
      executionPrompt: 'EXACT DURABLE PLAN',
      executionDisplayText: 'Build durable plan'
    }
    const resumeAdmission = vi.fn(async () => ({
      ...attached, executionTurnId: 'turn-execution'
    }))
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      kunGui: {
        planWorktree: {
          list: vi.fn(async () => [attached]),
          reconcile: vi.fn(async () => attached),
          resumeAdmission
        }
      }
    })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(PlanWorktreeGlobalRecovery, { runtimeReady: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resumeAdmission).toHaveBeenCalledWith({ runId: run.runId })
    expect(usePlanWorktreeStore.getState().plans[planWorktreeGuiPlanIdForRun(run)]?.run?.executionTurnId)
      .toBe('turn-execution')
    act(() => renderer?.unmount())
  })
})
