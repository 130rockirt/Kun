import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'
import {
  resetPlanWorktreeStoreForTests,
  usePlanWorktreeStore
} from '../plan/plan-worktree-store'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { createThreadQueueActions } from './chat-store-thread-queue-actions'

function pendingRun(): PlanWorktreeRunRecord {
  return {
    version: 1,
    runId: 'run-pending-origin',
    operationId: 'operation-pending-origin',
    planId: 'plan-pending-origin',
    planRelativePath: '.kunsdd/plan/pending.md',
    planTitle: 'Pending origin',
    goalObjective: 'Implement pending origin',
    sourceThreadId: 'source-thread',
    executionThreadId: 'execution-thread',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source',
    baseCommit: 'a'.repeat(40),
    executionBranch: 'codex/pending-origin',
    worktreePath: '/managed/run/repo',
    executionWorkspace: '/managed/run/repo',
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

describe('isolated plan worktree queued input', () => {
  beforeEach(() => resetPlanWorktreeStoreForTests())

  it('does not drain before durable admission when the side-thread summary is missing', async () => {
    usePlanWorktreeStore.getState().upsertRun(pendingRun())
    const sendMessage = vi.fn(async () => true)
    let state = {
      activeThreadId: 'execution-thread',
      blocks: [],
      busy: false,
      currentTurnId: null,
      queuedMessages: [{ id: 'queued-foreign', text: 'send too early', mode: 'agent' }],
      sendMessage,
      threads: []
    } as unknown as ChatState
    const set: ChatStoreSet = (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    }
    const get: ChatStoreGet = () => state
    const actions = createThreadQueueActions(
      { set, get, sseAbortRef: { current: null } },
      { persistActiveQueuedMessages: vi.fn() } as never
    )

    await actions.drainQueuedMessages()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ id: 'queued-foreign', text: 'send too early' })
    ])
  })

  it('drains normally after durable admission when the side-thread summary is missing', async () => {
    usePlanWorktreeStore.getState().upsertRun({
      ...pendingRun(),
      executionTurnId: 'turn-origin'
    })
    let state = {
      activeThreadId: 'execution-thread',
      blocks: [],
      busy: false,
      currentTurnId: null,
      queuedMessages: [{ id: 'queued-follow-up', text: 'continue safely', mode: 'agent' }],
      threads: []
    } as unknown as ChatState
    const sendMessage = vi.fn(async (_text, _mode, overrides) => {
      state.queuedMessages = state.queuedMessages.filter(
        (message) => message.id !== overrides?.queued?.id
      )
      return true
    })
    state.sendMessage = sendMessage as ChatState['sendMessage']
    const set: ChatStoreSet = (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    }
    const get: ChatStoreGet = () => state
    const actions = createThreadQueueActions(
      { set, get, sseAbortRef: { current: null } },
      { persistActiveQueuedMessages: vi.fn() } as never
    )

    await actions.drainQueuedMessages()

    expect(sendMessage).toHaveBeenCalledWith('continue safely', 'agent', {
      queued: expect.objectContaining({ id: 'queued-follow-up' })
    })
    expect(state.queuedMessages).toEqual([])
  })
})
