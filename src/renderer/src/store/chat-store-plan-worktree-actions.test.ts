import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import type { ChatState, ChatStoreSet } from './chat-store-types'
import { createPlanWorktreeActions } from './chat-store-plan-worktree-actions'

function runRecord(): PlanWorktreeRunRecord {
  return {
    version: 1,
    runId: 'run-1',
    operationId: 'operation-1',
    planId: 'gui-plan-aabbccdd',
    planRelativePath: '.kunsdd/plan/checkout.md',
    planTitle: 'Checkout',
    goalObjective: 'Implement and validate Checkout',
    executionPrompt: 'EXACT EMBEDDED PLAN',
    executionDisplayText: 'Direct build',
    executionPromptSha256: 'a'.repeat(64),
    admissionClientRequestId: 'plan-build:run-1',
    sourceThreadId: 'thread-source',
    executionThreadId: 'thread-execution',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/checkout-run-1',
    worktreePath: '/managed/run-1/repo',
    status: 'executing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

function request() {
  return {
    operationId: 'operation-1',
    planId: 'gui-plan-aabbccdd',
    planRelativePath: '.kunsdd/plan/checkout.md',
    planTitle: 'Checkout',
    sourceThreadId: 'thread-source',
    sourceWorkspaceRoot: '/repo',
    orchestration: 'direct' as const,
    prompt: 'EXACT EMBEDDED PLAN',
    displayText: 'Direct build',
    goalObjective: 'Implement and validate Checkout'
  }
}

describe('isolated plan build renderer transaction', () => {
  let state: ChatState
  let order: string[]
  let api: {
    prepare: ReturnType<typeof vi.fn>
    reconcile: ReturnType<typeof vi.fn>
    resumeAdmission: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    order = []
    state = {
      activeThreadId: 'thread-source',
      runtimeConnection: 'ready',
      threads: [{
        id: 'thread-source',
        title: 'Source',
        updatedAt: '2026-08-12T00:00:00.000Z',
        model: 'model',
        mode: 'agent',
        workspace: '/repo'
      }],
      refreshThreads: vi.fn(async () => { order.push('refresh') }),
      selectThread: vi.fn(async (threadId: string) => {
        order.push('select')
        state.activeThreadId = threadId
      }),
      sendMessage: vi.fn(async () => {
        order.push('source-send')
        return true
      }),
      error: null
    } as unknown as ChatState
    api = {
      prepare: vi.fn(async () => {
        order.push('prepare')
        return runRecord()
      }),
      reconcile: vi.fn(async () => {
        order.push('reconcile')
        return runRecord()
      }),
      resumeAdmission: vi.fn(async () => {
        order.push('resume-admission')
        return { ...runRecord(), executionTurnId: 'turn-execution' }
      })
    }
  })

  function actions() {
    const set: ChatStoreSet = (patch) => {
      const next = typeof patch === 'function' ? patch(state) : patch
      Object.assign(state, next)
    }
    return createPlanWorktreeActions(
      { set, get: () => state },
      { getApi: () => api as never }
    )
  }

  it('uses the Main-bound execution thread, then admits the exact prompt', async () => {
    const result = await actions().startIsolatedPlanBuild(request())

    expect(result).toMatchObject({
      ok: true,
      executionThreadId: 'thread-execution',
      run: { executionTurnId: 'turn-execution' }
    })
    expect(order).toEqual([
      'prepare',
      'reconcile',
      'resume-admission',
      'refresh',
      'select'
    ])
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({
      executionPrompt: 'EXACT EMBEDDED PLAN',
      executionDisplayText: 'Direct build'
    }))
    expect(state.sendMessage).not.toHaveBeenCalled()
  })

  it('retains the Main-bound thread and never falls back when admission fails', async () => {
    api.resumeAdmission.mockImplementationOnce(async () => {
      order.push('resume-admission')
      throw new Error('goal failed')
    })

    const result = await actions().startIsolatedPlanBuild(request())

    expect(result).toMatchObject({
      ok: false,
      executionThreadId: 'thread-execution',
      run: { executionThreadId: 'thread-execution' }
    })
    expect(order).toEqual(['prepare', 'reconcile', 'resume-admission'])
    expect(state.sendMessage).not.toHaveBeenCalled()
    expect(state.activeThreadId).toBe('thread-source')
  })

  it('fails closed when Main does not return a durable execution-thread binding', async () => {
    api.reconcile.mockImplementationOnce(async () => {
      order.push('reconcile')
      return { ...runRecord(), executionThreadId: undefined }
    })

    const result = await actions().startIsolatedPlanBuild(request())

    expect(result).toMatchObject({ ok: false, run: { runId: 'run-1' } })
    if (!result.ok) expect(result.message).toContain('durably bind')
    expect(order).toEqual(['prepare', 'reconcile'])
    expect(api.resumeAdmission).not.toHaveBeenCalled()
    expect(state.sendMessage).not.toHaveBeenCalled()
  })

  it('adopts a Main-recovered origin turn without requesting a second admission', async () => {
    api.reconcile.mockImplementationOnce(async () => {
      order.push('reconcile')
      return {
        ...runRecord(),
        executionThreadId: 'thread-recovered',
        executionTurnId: 'turn-recovered'
      }
    })

    const result = await actions().startIsolatedPlanBuild(request())

    expect(result).toMatchObject({
      ok: true,
      executionThreadId: 'thread-recovered',
      run: { executionTurnId: 'turn-recovered' }
    })
    expect(order).toEqual(['prepare', 'reconcile', 'refresh', 'select'])
    expect(api.resumeAdmission).not.toHaveBeenCalled()
    expect(state.sendMessage).not.toHaveBeenCalled()
  })
})
