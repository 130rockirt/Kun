import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread, ThreadGoal, ThreadGoalStatus } from '../agent/types'
import type {
  ChatState,
  ChatStoreGet,
  ChatStoreSet,
  CreateDesignThreadOptions,
  SendMessageOverrides
} from './chat-store-types'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  emptyDesignThreadRegistry,
  isDesignThreadId,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry
} from '../design/design-thread-registry'
import { clearDesignChatHistoryMutationsForTests } from '../design/design-chat-transcript'

const registryMock = vi.hoisted(() => ({
  getProvider: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

import {
  createMaintenanceActions,
  type MaintenanceActionDependencies
} from './chat-store-maintenance-actions'

type GoalPatch = {
  objective?: string
  status?: ThreadGoalStatus
  tokenBudget?: number | null
}

type Harness = {
  actions: ReturnType<typeof createMaintenanceActions>
  createDesignThread: ReturnType<typeof vi.fn>
  createThread: ReturnType<typeof vi.fn>
  drainQueuedMessages: ReturnType<typeof vi.fn>
  get: ChatStoreGet
  provider: {
    deleteThread: ReturnType<typeof vi.fn>
    getThreadDetail: ReturnType<typeof vi.fn>
    setThreadGoal: ReturnType<typeof vi.fn>
    clearThreadGoal: ReturnType<typeof vi.fn>
    interruptTurn: ReturnType<typeof vi.fn>
    submitApprovalDecision: ReturnType<typeof vi.fn>
    forkThread: ReturnType<typeof vi.fn>
    rewindThread: ReturnType<typeof vi.fn>
  }
  recoverActiveTurn: ReturnType<typeof vi.fn>
  refreshThreads: ReturnType<typeof vi.fn>
  selectThread: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  state: ChatState
}

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function thread(id: string, goal: ThreadGoal | null = null): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-06-04T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace: '/workspace/deepseek-gui',
    status: 'idle',
    goal
  }
}

function goal(
  threadId: string,
  objective = 'ship goal mode',
  status: ThreadGoalStatus = 'active'
): ThreadGoal {
  return {
    threadId,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:01:00.000Z'
  }
}

function buildHarness(options: {
  activeThreadId?: string | null
  createDesignThreadSucceeds?: boolean
  createThreadSucceeds?: boolean
  initialGoal?: ThreadGoal | null
  maintenanceDependencies?: MaintenanceActionDependencies
} = {}): Harness {
  const activeThreadId = options.activeThreadId === undefined ? 'thr_existing' : options.activeThreadId
  const createThreadSucceeds = options.createThreadSucceeds ?? true
  const createDesignThreadSucceeds = options.createDesignThreadSucceeds ?? true
  const initialGoal = options.initialGoal ?? null
  let state: ChatState

  const provider = {
    deleteThread: vi.fn(async (_threadId: string) => undefined),
    getThreadDetail: vi.fn(async (threadId: string) => ({
      thread: thread(threadId),
      blocks: [],
      threadStatus: 'idle'
    })),
    setThreadGoal: vi.fn(async (threadId: string, patch: GoalPatch) =>
      goal(
        threadId,
        patch.objective ?? state.activeThreadGoal?.objective ?? initialGoal?.objective ?? 'ship goal mode',
        patch.status ?? state.activeThreadGoal?.status ?? initialGoal?.status ?? 'active'
      )
    ),
    clearThreadGoal: vi.fn(async () => true),
    interruptTurn: vi.fn(async () => undefined),
    submitApprovalDecision: vi.fn(async () => 'submitted' as const),
    rewindThread: vi.fn(async () => undefined),
    forkThread: vi.fn(async (
      threadId: string,
      options?: { turnId?: string }
    ) => ({
      ...thread('thr_forked'),
      title: 'Forked',
      forkedFromThreadId: threadId,
      forkedFromTitle: 'Parent',
      forkedAt: '2026-06-04T00:02:00.000Z',
      forkedFromTurnCount: options?.turnId ? 1 : 2
    }))
  }
  registryMock.getProvider.mockReturnValue(provider)

  const createThread = vi.fn(async () => {
    if (!createThreadSucceeds) return
    const created = thread('thr_created')
    state.activeThreadId = created.id
    state.threads = [created, ...state.threads]
  })
  const createDesignThread = vi.fn(async (
    workspaceRoot?: string,
    docId?: string,
    createOptions?: CreateDesignThreadOptions
  ) => {
    if (!createDesignThreadSucceeds) return null
    const created = thread('thr_design_recreated')
    saveDesignThreadRegistry(markDesignThread(
      workspaceRoot ?? state.workspaceRoot,
      docId ?? '',
      created.id
    ))
    if (createOptions?.activate !== false) state.activeThreadId = created.id
    state.threads = [created, ...state.threads]
    return created.id
  })
  const refreshThreads = vi.fn(async () => undefined)
  const selectThread = vi.fn(async (id: string) => {
    state.activeThreadId = id
  })
  const drainQueuedMessages = vi.fn(async () => undefined)
  const recoverActiveTurn = vi.fn(async () => false)
  const sendMessage = vi.fn(async (
    _text: string,
    _mode?: string,
    _overrides?: SendMessageOverrides
  ) => true)

  state = {
    activeThreadGoal: initialGoal,
    activeThreadId,
    createDesignThread,
    createThread,
    error: null,
    drainQueuedMessages,
    recoverActiveTurn,
    refreshThreads,
    selectThread,
    runtimeConnection: 'ready',
    sendMessage,
    settingsSection: 'general',
    workspaceRoot: '/workspace/deepseek-gui',
    threads: activeThreadId ? [thread(activeThreadId, initialGoal)] : []
  } as unknown as ChatState

  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, update)
  }
  const get: ChatStoreGet = () => state
  const actions = createMaintenanceActions({
    set,
    get,
    sseAbortRef: { current: null }
  }, options.maintenanceDependencies)

  return {
    actions,
    createDesignThread,
    createThread,
    drainQueuedMessages,
    get,
    provider,
    recoverActiveTurn,
    refreshThreads,
    selectThread,
    sendMessage,
    state
  }
}

afterEach(() => {
  clearDesignChatHistoryMutationsForTests()
  vi.unstubAllGlobals()
})

describe('chat-store-maintenance-actions workspace rollback', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('restores the workspace checkpoint without rewinding or resending the conversation', async () => {
    const previousWindow = globalThis.window
    const restoreGitCheckpoint = vi.fn(async () => ({
      ok: true,
      checkpointId: 'gcp_1',
      repositoryRoot: '/workspace/deepseek-gui',
      head: 'abc123',
      currentBranch: 'develop',
      rescueCheckpointId: 'gcp_rescue'
    }))
    ;(globalThis as { window?: unknown }).window = {
      confirm: vi.fn(() => true),
      kunGui: {
        restoreGitCheckpoint
      }
    }
    try {
      const { actions, provider, sendMessage, state } = buildHarness()
      state.blocks = [
        { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'question', meta: { workspaceCheckpointId: 'gcp_1' } },
        { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'answer' }
      ]

      await actions.rollbackWorkspaceToCheckpoint(' gcp_1 ')

      expect(restoreGitCheckpoint).toHaveBeenCalledWith({
        checkpointId: 'gcp_1',
        expectedThreadId: 'thr_existing',
        expectedWorkspaceRoot: '/workspace/deepseek-gui'
      })
      expect(provider.rewindThread).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
      expect(state.blocks).toHaveLength(2)
      expect(state.error).toBeNull()
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('validates restore against the thread workspace when the global picker points elsewhere', async () => {
    const previousWindow = globalThis.window
    const restoreGitCheckpoint = vi.fn(async () => ({
      ok: true,
      checkpointId: 'gcp_1',
      repositoryRoot: '/workspace/deepseek-gui',
      head: 'abc123',
      currentBranch: 'develop',
      rescueCheckpointId: 'gcp_rescue'
    }))
    ;(globalThis as { window?: unknown }).window = {
      confirm: vi.fn(() => true),
      kunGui: {
        restoreGitCheckpoint
      }
    }
    try {
      const { actions, state } = buildHarness()
      state.workspaceRoot = '/workspace/kun-ui-extend'
      state.blocks = [
        { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'question', meta: { workspaceCheckpointId: 'gcp_1' } },
        { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'answer' }
      ]

      await actions.rollbackWorkspaceToCheckpoint('gcp_1')

      expect(restoreGitCheckpoint).toHaveBeenCalledWith({
        checkpointId: 'gcp_1',
        expectedThreadId: 'thr_existing',
        expectedWorkspaceRoot: '/workspace/deepseek-gui'
      })
      expect(state.error).toBeNull()
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('uses a checkpoint-specific error when rollback has no checkpoint id', async () => {
    const previousWindow = globalThis.window
    const restoreGitCheckpoint = vi.fn(async () => ({
      ok: true,
      checkpointId: 'gcp_1',
      repositoryRoot: '/workspace/deepseek-gui',
      head: 'abc123',
      currentBranch: 'develop',
      rescueCheckpointId: null
    }))
    ;(globalThis as { window?: unknown }).window = {
      confirm: vi.fn(() => true),
      kunGui: {
        restoreGitCheckpoint
      }
    }
    try {
      const { actions, state } = buildHarness()

      await actions.rollbackWorkspaceToCheckpoint('   ')

      expect(restoreGitCheckpoint).not.toHaveBeenCalled()
      expect(state.error).toBe('This turn has no file-change checkpoint to roll back.')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('short-circuits without restoring when busy flips after the confirm dialog resolves', async () => {
    const previousWindow = globalThis.window
    const restoreGitCheckpoint = vi.fn(async () => ({
      ok: true,
      checkpointId: 'gcp_1',
      repositoryRoot: '/workspace/deepseek-gui',
      head: 'abc123',
      currentBranch: 'develop',
      rescueCheckpointId: 'gcp_rescue'
    }))
    const { actions, state } = buildHarness()
    let confirmCalls = 0
    ;(globalThis as { window?: unknown }).window = {
      confirm: vi.fn(() => {
        confirmCalls += 1
        // Simulate the user typing+sending a new turn while the confirm
        // dialog is still open: by the time confirm() resolves, the store
        // is busy again. The action must NOT proceed to git reset --hard.
        state.busy = true
        return true
      }),
      kunGui: {
        restoreGitCheckpoint
      }
    }
    try {
      state.blocks = [
        { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'question', meta: { workspaceCheckpointId: 'gcp_1' } },
        { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'answer' }
      ]
      state.busy = false

      await actions.rollbackWorkspaceToCheckpoint('gcp_1')

      expect(confirmCalls).toBe(1)
      expect(restoreGitCheckpoint).not.toHaveBeenCalled()
      expect(state.error).toBe('Cannot roll back the workspace while the agent is running.')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('surfaces the rescue checkpoint id after a successful restore', async () => {
    const previousWindow = globalThis.window
    const previousConsoleInfo = console.info
    const restoreGitCheckpoint = vi.fn(async () => ({
      ok: true,
      checkpointId: 'gcp_1',
      repositoryRoot: '/workspace/deepseek-gui',
      head: 'abc123',
      currentBranch: 'develop',
      rescueCheckpointId: 'gcp_rescue_xyz'
    }))
    ;(globalThis as { window?: unknown }).window = {
      confirm: vi.fn(() => true),
      kunGui: {
        restoreGitCheckpoint
      }
    }
    const consoleInfo = vi.fn()
    console.info = consoleInfo
    try {
      const { actions, state } = buildHarness()
      state.blocks = [
        { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'question', meta: { workspaceCheckpointId: 'gcp_1' } },
        { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'answer' }
      ]

      await actions.rollbackWorkspaceToCheckpoint('gcp_1')

      expect(restoreGitCheckpoint).toHaveBeenCalledWith({
        checkpointId: 'gcp_1',
        expectedThreadId: 'thr_existing',
        expectedWorkspaceRoot: '/workspace/deepseek-gui'
      })
      expect(consoleInfo).toHaveBeenCalledTimes(1)
      const logArgs = consoleInfo.mock.calls[0]
      expect(logArgs[0]).toBe('[rollback] rescue checkpoint:')
      expect(logArgs[1]).toBe('gcp_rescue_xyz')
      expect(logArgs[2]).toBe('workspace:')
      expect(logArgs[4]).toBe('thread:')
      expect(logArgs[5]).toBe('thr_existing')
      expect(state.error).toBeNull()
    } finally {
      console.info = previousConsoleInfo
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})
