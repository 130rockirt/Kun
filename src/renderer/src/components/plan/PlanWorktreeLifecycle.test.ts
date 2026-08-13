import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import i18n from '../../i18n'
import { resetPlanWorktreeStoreForTests } from '../../plan/plan-worktree-store'
import { PlanWorktreeLifecycle } from './PlanWorktreeLifecycle'

function record(
  status: PlanWorktreeRunRecord['status'],
  patch: Partial<PlanWorktreeRunRecord> = {}
): PlanWorktreeRunRecord {
  return {
    version: 1,
    runId: `run-${status}`,
    operationId: `operation-${status}`,
    planId: 'gui-plan-aabbccdd',
    planRelativePath: '.kunsdd/plan/demo.md',
    planTitle: 'Demo',
    goalObjective: 'Implement and validate Demo',
    sourceThreadId: 'thread-source',
    executionThreadId: 'thread-execution',
    executionTurnId: 'turn-execution',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/demo-run',
    worktreePath: '/managed/demo/repo',
    status,
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...patch
  }
}

describe('plan worktree lifecycle recovery actions', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(async () => {
    resetPlanWorktreeStoreForTests()
    await i18n.changeLanguage('en')
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      kunGui: {
        planWorktree: { get: vi.fn(async () => null) }
      }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  async function renderRun(run: PlanWorktreeRunRecord): Promise<string> {
    await act(async () => {
      renderer = create(createElement(PlanWorktreeLifecycle, {
        planId: run.planId,
        runRecord: run
      }))
    })
    return JSON.stringify(renderer!.toJSON())
  }

  it('offers conflict containment and integration recovery without hiding the retained worktree', async () => {
    const text = await renderRun(record('needs_attention', {
      attentionReason: 'rebase_conflict',
      attentionMessage: 'Resolve conflicts in the isolated worktree.'
    }))
    expect(text).toContain('Open source plan')
    expect(text).toContain('Open conversation')
    expect(text).toContain('Open worktree')
    expect(text).toContain('Retry integration')
    expect(text).toContain('Continue rebase')
    expect(text).toContain('Abort rebase')
    expect(text).toContain('Retain for manual recovery')
    expect(text).toContain('Discard retained work')
  })

  it('offers safe cancellation before a fork exists and cleanup retry after integration', async () => {
    let text = await renderRun(record('executing', {
      executionThreadId: undefined,
      executionTurnId: undefined
    }))
    expect(text).toContain('Cancel if unchanged')
    act(() => renderer!.unmount())
    renderer = null
    text = await renderRun(record('cleanup_pending', {
      attentionReason: 'cleanup_failed'
    }))
    expect(text).toContain('Retry cleanup')
  })

  it('offers exact admission recovery after the execution thread was attached', async () => {
    const text = await renderRun(record('executing', { executionTurnId: undefined }))
    expect(text).toContain('Resume execution')
  })
})
