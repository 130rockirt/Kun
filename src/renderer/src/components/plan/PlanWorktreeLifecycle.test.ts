import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import i18n from '../../i18n'
import {
  resetPlanWorktreeStoreForTests,
  usePlanWorktreeStore
} from '../../plan/plan-worktree-store'
import { useChatStore } from '../../store/chat-store'
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
      executionTurnId: undefined,
      executionPrompt: 'Execute the embedded plan in this workspace.'
    }))
    expect(text).toContain('Cancel if unchanged')
    expect(text).toContain('Build in the current workspace')
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
    expect(text).not.toContain('Continue implementation')
    expect(text).not.toContain('Open conversation')
  })

  it('runs the durable prompt in the source workspace when no execution thread bound', async () => {
    const openCode = vi.fn(async () => undefined)
    const selectThread = vi.fn(async () => {
      useChatStore.setState({ activeThreadId: 'thread-source' })
    })
    const sendMessage = vi.fn(async () => true)
    useChatStore.setState({ openCode, selectThread, sendMessage, activeThreadId: null })
    const run = record('needs_attention', {
      executionThreadId: undefined,
      executionTurnId: undefined,
      executionPrompt: 'Execute the embedded plan in this workspace.',
      executionDisplayText: 'Build Demo'
    })
    await renderRun(run)
    const button = renderer!.root.findAllByType('button').find((candidate) =>
      candidate.children.includes('Build in the current workspace')
    )
    if (!button) throw new Error('Current-workspace fallback button is missing.')

    await act(async () => {
      button.props.onClick()
    })

    expect(openCode).toHaveBeenCalledOnce()
    expect(selectThread).toHaveBeenCalledWith('thread-source')
    expect(sendMessage).toHaveBeenCalledWith(run.executionPrompt, 'agent', {
      displayText: 'Build Demo',
      orchestration: 'direct'
    })
    expect(usePlanWorktreeStore.getState().plans[run.planId]?.useWorktree).toBe(false)
  })
})
