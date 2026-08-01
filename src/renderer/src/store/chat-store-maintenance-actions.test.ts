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

describe('chat-store-maintenance-actions fork actions', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('forks the active thread from a specific turn and selects the new thread', async () => {
    const { actions, provider, refreshThreads, selectThread, state } = buildHarness()
    state.blocks = [
      { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'question' },
      { kind: 'assistant', id: 'assistant_1', turnId: 'turn_1', text: 'answer' },
      { kind: 'user', id: 'user_2', turnId: 'turn_2', text: 'later question' }
    ]

    await actions.forkThreadFromTurn(' turn_1 ')

    expect(provider.forkThread).toHaveBeenCalledWith('thr_existing', { turnId: 'turn_1' })
    expect(refreshThreads).toHaveBeenCalledTimes(1)
    expect(selectThread).toHaveBeenCalledWith('thr_forked')
    expect(state.activeThreadId).toBe('thr_forked')
  })
})

describe('chat-store-maintenance-actions compaction', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('does not mutate cumulative usage to simulate a smaller context', async () => {
    const { actions, provider, state } = buildHarness()
    const usage = {
      threadId: 'thr_existing',
      snapshot: {
        inputTokens: 120_000,
        outputTokens: 5_000,
        reasoningTokens: 0,
        cachedTokens: 80_000,
        cacheMissTokens: 40_000,
        cacheHitRate: 2 / 3,
        totalTokens: 125_000,
        costUsd: 1,
        costCny: null,
        tokenEconomySavingsTokens: 0,
        turns: 4
      }
    }
    Object.assign(provider, {
      compactThread: vi.fn(async () => ({ replacedTokens: 50_000 }))
    })
    Object.assign(state, {
      busy: false,
      lastTurnUsage: usage,
      usageRefreshKey: 7
    })

    await actions.compactActiveThread()

    expect(state.lastTurnUsage).toBe(usage)
    expect(state.usageRefreshKey).toBe(7)
  })
})

describe('chat-store-maintenance-actions delete actions', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('removes deleted design threads from the design registry', async () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread(
        '/workspace/deepseek-gui',
        'login',
        'thr_design',
        emptyDesignThreadRegistry()
      ),
      storage
    )
    vi.stubGlobal('window', { localStorage: storage })
    const { actions, provider, refreshThreads, state } = buildHarness({ activeThreadId: 'thr_design' })
    state.threads = [thread('thr_design')]
    state.watchTurnCompletion = { thr_design: true }
    state.unreadThreadIds = { thr_design: true }

    await actions.deleteThread(' thr_design ')

    expect(provider.deleteThread).toHaveBeenCalledWith('thr_design')
    expect(isDesignThreadId('thr_design', readDesignThreadRegistry(storage))).toBe(false)
    expect(state.threads).toEqual([])
    expect(state.activeThreadId).toBeNull()
    expect(refreshThreads).toHaveBeenCalledTimes(1)
  })
})

describe('chat-store-maintenance-actions design history', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  function rememberDesignThreads(storage: MemoryStorage): void {
    saveDesignThreadRegistry(
      markDesignThread(
        '/workspace/deepseek-gui',
        'login',
        'thr_design_new',
        markDesignThread(
          '/workspace/deepseek-gui',
          'login',
          'thr_design_old',
          emptyDesignThreadRegistry()
        )
      ),
      storage
    )
  }

  it('refuses to delete a registered running thread missing from the renderer snapshot', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness({ activeThreadId: null })
    harness.state.threads = []
    harness.provider.getThreadDetail.mockResolvedValue({
      thread: thread('thr_design_new'),
      blocks: [],
      threadStatus: 'running'
    })

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login'
    )

    expect(result).toMatchObject({
      cleared: false,
      deletedThreadIds: [],
      retainedThreadIds: ['thr_design_new', 'thr_design_old']
    })
    expect(harness.provider.deleteThread).not.toHaveBeenCalled()
    expect(harness.createDesignThread).not.toHaveBeenCalled()
  })

  it('deletes every remembered thread and creates one empty replacement', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const deleteDesignChatDirForDoc = vi.fn(async () => true)
    const deleteDesignChatTranscriptForThread = vi.fn(async () => true)
    const persistDesignChatMetaForDoc = vi.fn(async () => true)
    const flushDesignPersistenceQueue = vi.fn(async () => undefined)
    const harness = buildHarness({
      activeThreadId: 'thr_design_new',
      maintenanceDependencies: {
        deleteDesignChatDirForDoc,
        deleteDesignChatTranscriptForThread,
        persistDesignChatMetaForDoc,
        flushDesignPersistenceQueue
      }
    })
    harness.state.threads = [thread('thr_design_new'), thread('thr_design_old')]

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login'
    )

    expect(harness.provider.deleteThread.mock.calls.map(([id]) => id).sort()).toEqual([
      'thr_design_new',
      'thr_design_old'
    ])
    expect(flushDesignPersistenceQueue).toHaveBeenCalledWith('/workspace/deepseek-gui')
    expect(deleteDesignChatDirForDoc).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      docId: 'login'
    })
    expect(deleteDesignChatTranscriptForThread).not.toHaveBeenCalled()
    expect(persistDesignChatMetaForDoc).not.toHaveBeenCalled()
    expect(harness.createDesignThread).toHaveBeenCalledWith(
      '/workspace/deepseek-gui',
      'login',
      { activate: false, suppressSettingsRedirect: true }
    )
    expect(result).toEqual({
      cleared: true,
      deletedThreadIds: ['thr_design_new', 'thr_design_old'],
      retainedThreadIds: [],
      recreatedThreadId: 'thr_design_recreated'
    })
    expect(harness.state.activeThreadId).toBeNull()
    expect(
      readDesignThreadRegistry(storage).workspaces['/workspace/deepseek-gui\u0000login']
    ).toEqual({
      activeThreadId: 'thr_design_recreated',
      threadIds: ['thr_design_recreated']
    })
  })

  it('cleans an orphan local mirror while offline when no runtime thread is registered', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const deleteDesignChatDirForDoc = vi.fn(async () => true)
    const harness = buildHarness({
      activeThreadId: null,
      maintenanceDependencies: {
        deleteDesignChatDirForDoc,
        deleteDesignChatTranscriptForThread: vi.fn(async () => true),
        persistDesignChatMetaForDoc: vi.fn(async () => true),
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })
    harness.state.runtimeConnection = 'offline'

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login',
      { recreate: false }
    )

    expect(result).toEqual({
      cleared: true,
      deletedThreadIds: [],
      retainedThreadIds: [],
      recreatedThreadId: null
    })
    expect(deleteDesignChatDirForDoc).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      docId: 'login'
    })
    expect(harness.provider.deleteThread).not.toHaveBeenCalled()
  })

  it('deletes a provisional thread even when its registry write was lost', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const deleteDesignChatDirForDoc = vi.fn(async () => true)
    const harness = buildHarness({
      activeThreadId: 'thr_provisional',
      maintenanceDependencies: {
        deleteDesignChatDirForDoc,
        deleteDesignChatTranscriptForThread: vi.fn(async () => true),
        persistDesignChatMetaForDoc: vi.fn(async () => true),
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'new-drawing',
      { recreate: false, includeThreadIds: ['thr_provisional'] }
    )

    expect(harness.provider.deleteThread).toHaveBeenCalledWith('thr_provisional')
    expect(deleteDesignChatDirForDoc).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      docId: 'new-drawing'
    })
    expect(result).toMatchObject({
      cleared: true,
      deletedThreadIds: ['thr_provisional'],
      retainedThreadIds: []
    })
  })

  it('keeps failed runtime threads and their mirrors while removing successful history', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const deleteDesignChatTranscriptForThread = vi.fn(async () => true)
    const persistDesignChatMetaForDoc = vi.fn(async () => true)
    const harness = buildHarness({
      activeThreadId: 'thr_design_new',
      maintenanceDependencies: {
        deleteDesignChatDirForDoc: vi.fn(async () => true),
        deleteDesignChatTranscriptForThread,
        persistDesignChatMetaForDoc,
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })
    harness.state.threads = [thread('thr_design_new'), thread('thr_design_old')]
    harness.provider.deleteThread.mockImplementation(async (threadId: string) => {
      if (threadId === 'thr_design_old') {
        throw new Error(JSON.stringify({ code: 'internal_error', message: 'delete failed' }))
      }
    })

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login'
    )

    expect(deleteDesignChatTranscriptForThread).toHaveBeenCalledTimes(1)
    expect(deleteDesignChatTranscriptForThread).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      docId: 'login',
      threadId: 'thr_design_new'
    })
    expect(persistDesignChatMetaForDoc).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/workspace/deepseek-gui',
      docId: 'login'
    }))
    expect(harness.createDesignThread).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      cleared: false,
      deletedThreadIds: ['thr_design_new'],
      retainedThreadIds: ['thr_design_old'],
      recreatedThreadId: null
    })
    expect(
      readDesignThreadRegistry(storage).workspaces['/workspace/deepseek-gui\u0000login']
    ).toEqual({
      activeThreadId: 'thr_design_old',
      threadIds: ['thr_design_old']
    })
    expect(harness.state.error).toContain('partially cleared')
  })

  it('restores the old registry as a retry journal when local directory deletion fails', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness({
      activeThreadId: 'thr_design_new',
      maintenanceDependencies: {
        deleteDesignChatDirForDoc: vi.fn(async () => false),
        deleteDesignChatTranscriptForThread: vi.fn(async () => true),
        persistDesignChatMetaForDoc: vi.fn(async () => true),
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })
    harness.state.threads = [thread('thr_design_new'), thread('thr_design_old')]

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login'
    )

    expect(result.cleared).toBe(false)
    expect(result.deletedThreadIds).toEqual(['thr_design_new', 'thr_design_old'])
    expect(result.retainedThreadIds).toEqual(['thr_design_new', 'thr_design_old'])
    expect(harness.createDesignThread).not.toHaveBeenCalled()
    expect(
      readDesignThreadRegistry(storage).workspaces['/workspace/deepseek-gui\u0000login']
    ).toEqual({
      activeThreadId: 'thr_design_new',
      threadIds: ['thr_design_new', 'thr_design_old']
    })
  })

  it('can delete drawing history without recreating a conversation', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness({
      activeThreadId: 'thr_design_new',
      maintenanceDependencies: {
        deleteDesignChatDirForDoc: vi.fn(async () => true),
        deleteDesignChatTranscriptForThread: vi.fn(async () => true),
        persistDesignChatMetaForDoc: vi.fn(async () => true),
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })
    harness.state.threads = [thread('thr_design_new'), thread('thr_design_old')]

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login',
      { recreate: false }
    )

    expect(result).toMatchObject({ cleared: true, recreatedThreadId: null })
    expect(harness.createDesignThread).not.toHaveBeenCalled()
    expect(
      readDesignThreadRegistry(storage).workspaces['/workspace/deepseek-gui\u0000login']
    ).toBeUndefined()
  })

  it('keeps the drawing usable when replacement-thread creation fails', async () => {
    const storage = new MemoryStorage()
    rememberDesignThreads(storage)
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness({
      activeThreadId: 'thr_design_new',
      createDesignThreadSucceeds: false,
      maintenanceDependencies: {
        deleteDesignChatDirForDoc: vi.fn(async () => true),
        deleteDesignChatTranscriptForThread: vi.fn(async () => true),
        persistDesignChatMetaForDoc: vi.fn(async () => true),
        flushDesignPersistenceQueue: vi.fn(async () => undefined)
      }
    })
    harness.state.threads = [thread('thr_design_new'), thread('thr_design_old')]

    const result = await harness.actions.clearDesignHistory(
      '/workspace/deepseek-gui',
      'login'
    )

    expect(result).toMatchObject({
      cleared: true,
      retainedThreadIds: [],
      recreatedThreadId: null
    })
    expect(
      readDesignThreadRegistry(storage).workspaces['/workspace/deepseek-gui\u0000login']
    ).toBeUndefined()
    expect(harness.state.error).toContain('new conversation could not be created')
  })
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

describe('chat-store-maintenance-actions rewind and resend', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('rebuilds canvas context and preserves tool routing for edited architecture prompts', async () => {
    const prepareCodeCanvasResend = vi.fn(async () => ({
      text: 'architecture prompt with live canvas snapshot',
      displayText: '\u7ed9\u6211\u8bbe\u8ba1\u4e00\u4e2a\u5f53\u524d\u76ee\u5f55\u7684\u67b6\u6784\u56fe',
      guiDesignCanvas: true as const
    }))
    const requestCodeCanvasPanelOpen = vi.fn()
    const { actions, provider, sendMessage, state } = buildHarness({
      maintenanceDependencies: {
        prepareCodeCanvasResend,
        requestCodeCanvasPanelOpen
      }
    })
    Object.assign(state, {
      route: 'chat',
      busy: false,
      blocks: [
        {
          kind: 'user',
          id: 'user_1',
          text: 'old prompt',
          meta: { turnId: 'turn_1', guiDesignCanvas: true }
        },
        { kind: 'assistant', id: 'assistant_1', text: 'old answer' }
      ],
      queuedMessages: [],
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    })

    await actions.rewindAndResend(
      'user_1',
      '  \u7ed9\u6211\u8bbe\u8ba1\u4e00\u4e2a\u5f53\u524d\u76ee\u5f55\u7684\u67b6\u6784\u56fe  '
    )

    expect(prepareCodeCanvasResend).toHaveBeenCalledWith({
      route: 'chat',
      text: '\u7ed9\u6211\u8bbe\u8ba1\u4e00\u4e2a\u5f53\u524d\u76ee\u5f55\u7684\u67b6\u6784\u56fe',
      previousCanvasTurn: true,
      fallbackWorkspaceRoot: '/workspace/deepseek-gui',
      threadWorkspaceRoot: '/workspace/deepseek-gui',
      threadId: 'thr_existing'
    })
    expect(provider.rewindThread).toHaveBeenCalledWith('thr_existing', 'turn_1')
    expect(requestCodeCanvasPanelOpen).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'architecture prompt with live canvas snapshot',
      'agent',
      {
        displayText: '\u7ed9\u6211\u8bbe\u8ba1\u4e00\u4e2a\u5f53\u524d\u76ee\u5f55\u7684\u67b6\u6784\u56fe',
        guiDesignCanvas: true
      }
    )
  })

  it('keeps non-canvas edited prompts on the existing resend path', async () => {
    const prepareCodeCanvasResend = vi.fn(async () => null)
    const requestCodeCanvasPanelOpen = vi.fn()
    const { actions, provider, sendMessage, state } = buildHarness({
      maintenanceDependencies: {
        prepareCodeCanvasResend,
        requestCodeCanvasPanelOpen
      }
    })
    Object.assign(state, {
      route: 'chat',
      busy: false,
      blocks: [
        {
          kind: 'user',
          id: 'user_1',
          text: 'old prompt',
          meta: { turnId: 'turn_1' }
        },
        { kind: 'assistant', id: 'assistant_1', text: 'old answer' }
      ],
      queuedMessages: [],
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    })

    await actions.rewindAndResend('user_1', '  Refactor this module  ')

    expect(provider.rewindThread).toHaveBeenCalledWith('thr_existing', 'turn_1')
    expect(requestCodeCanvasPanelOpen).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith('Refactor this module')
  })

  it('restores checkpoints against the thread workspace when resending under another global picker root', async () => {
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
      kunGui: {
        restoreGitCheckpoint
      }
    }
    try {
      const prepareCodeCanvasResend = vi.fn(async () => null)
      const { actions, provider, sendMessage, state } = buildHarness({
        maintenanceDependencies: {
          prepareCodeCanvasResend
        }
      })
      Object.assign(state, {
        route: 'chat',
        busy: false,
        workspaceRoot: '/workspace/kun-ui-extend',
        blocks: [
          {
            kind: 'user',
            id: 'user_1',
            text: 'old prompt',
            meta: { turnId: 'turn_1', workspaceCheckpointId: 'gcp_1' }
          },
          { kind: 'assistant', id: 'assistant_1', text: 'old answer' }
        ],
        queuedMessages: [],
        turnStartedAtByUserId: {},
        turnDurationByUserId: {},
        turnReasoningFirstAtByUserId: {},
        turnReasoningLastAtByUserId: {}
      })

      await actions.rewindAndResend('user_1', '  Retry release review  ')

      expect(restoreGitCheckpoint).toHaveBeenCalledWith({
        checkpointId: 'gcp_1',
        expectedThreadId: 'thr_existing',
        expectedWorkspaceRoot: '/workspace/deepseek-gui'
      })
      expect(provider.rewindThread).toHaveBeenCalledWith('thr_existing', 'turn_1')
      expect(sendMessage).toHaveBeenCalledWith('Retry release review')
      expect(state.error).toBeNull()
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})

describe('chat-store-maintenance-actions goal actions', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('sets a goal on the active thread, syncs snapshots, and starts the goal turn', async () => {
    const { actions, provider, refreshThreads, sendMessage, state } = buildHarness()

    const result = await actions.setActiveThreadGoal('  ship goal mode  ')

    expect(result).toBe(true)
    expect(provider.setThreadGoal).toHaveBeenCalledWith('thr_existing', {
      objective: 'ship goal mode',
      status: 'active'
    })
    expect(state.activeThreadGoal).toMatchObject({
      threadId: 'thr_existing',
      objective: 'ship goal mode',
      status: 'active'
    })
    expect(state.threads[0]?.goal).toMatchObject({
      threadId: 'thr_existing',
      objective: 'ship goal mode',
      status: 'active'
    })
    expect(refreshThreads).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'ship goal mode',
      'agent',
      expect.objectContaining({
        displayText: expect.stringContaining('ship goal mode')
      })
    )
  })

  it('creates a thread before setting the first goal when no thread is active', async () => {
    const { actions, createThread, provider, sendMessage, state } = buildHarness({
      activeThreadId: null
    })

    const result = await actions.setActiveThreadGoal('ship goal mode')

    expect(result).toBe(true)
    expect(createThread).toHaveBeenCalledTimes(1)
    expect(provider.setThreadGoal).toHaveBeenCalledWith('thr_created', {
      objective: 'ship goal mode',
      status: 'active'
    })
    expect(createThread.mock.invocationCallOrder[0]).toBeLessThan(
      provider.setThreadGoal.mock.invocationCallOrder[0]
    )
    expect(state.activeThreadId).toBe('thr_created')
    expect(state.activeThreadGoal?.threadId).toBe('thr_created')
    expect(state.threads[0]?.goal?.objective).toBe('ship goal mode')
    expect(sendMessage).toHaveBeenCalledWith(
      'ship goal mode',
      'agent',
      expect.objectContaining({
        displayText: expect.stringContaining('ship goal mode')
      })
    )
  })

  it('does not call goal APIs when a new thread cannot be created', async () => {
    const { actions, createThread, provider, sendMessage, state } = buildHarness({
      activeThreadId: null,
      createThreadSucceeds: false
    })

    const result = await actions.setActiveThreadGoal('ship goal mode')

    expect(result).toBe(false)
    expect(createThread).toHaveBeenCalledTimes(1)
    expect(provider.setThreadGoal).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(state.activeThreadGoal).toBeNull()
  })

  it('updates active goal status and keeps the thread snapshot in sync', async () => {
    const initialGoal = goal('thr_existing', 'finish testing', 'active')
    const { actions, provider, refreshThreads, state } = buildHarness({ initialGoal })

    const result = await actions.setActiveThreadGoalStatus('paused')

    expect(result).toBe(true)
    expect(provider.setThreadGoal).toHaveBeenCalledWith('thr_existing', { status: 'paused' })
    expect(state.activeThreadGoal).toMatchObject({
      threadId: 'thr_existing',
      objective: 'finish testing',
      status: 'paused'
    })
    expect(state.threads[0]?.goal).toMatchObject({
      threadId: 'thr_existing',
      objective: 'finish testing',
      status: 'paused'
    })
    expect(refreshThreads).toHaveBeenCalledTimes(1)
  })

  it('clears the active goal and removes it from the thread snapshot', async () => {
    const initialGoal = goal('thr_existing', 'finish testing', 'active')
    const { actions, provider, refreshThreads, state } = buildHarness({ initialGoal })

    const result = await actions.clearActiveThreadGoal()

    expect(result).toBe(true)
    expect(provider.clearThreadGoal).toHaveBeenCalledWith('thr_existing')
    expect(state.activeThreadGoal).toBeNull()
    expect(state.threads[0]?.goal).toBeNull()
    expect(refreshThreads).toHaveBeenCalledTimes(1)
  })

  it('restores a pending approval when the protected native prompt is cancelled', async () => {
    const { actions, provider, state } = buildHarness()
    provider.submitApprovalDecision.mockResolvedValueOnce('cancelled')
    state.blocks = [{
      kind: 'approval',
      id: 'approval-cancelled',
      approvalId: 'appr_cancelled',
      summary: 'Approve command',
      status: 'pending'
    }]

    await actions.resolveApproval('approval-cancelled', 'allow')

    expect(provider.submitApprovalDecision).toHaveBeenCalledWith(
      'appr_cancelled',
      'allow',
      true
    )
    expect(state.blocks[0]).toMatchObject({ status: 'pending' })
  })

  it('does not overwrite an SSE-expired approval when submission resolves later', async () => {
    const submission = deferred<'submitted' | 'cancelled'>()
    const { actions, provider, state } = buildHarness()
    provider.submitApprovalDecision.mockReturnValueOnce(submission.promise)
    state.blocks = [{
      kind: 'approval',
      id: 'approval-expired',
      approvalId: 'appr_expired',
      summary: 'Approve command',
      status: 'pending'
    }]

    const resolving = actions.resolveApproval('approval-expired', 'allow')
    await vi.waitFor(() => expect(state.blocks[0]).toMatchObject({ status: 'submitting' }))

    state.blocks = state.blocks.map((block) =>
      block.id === 'approval-expired' && block.kind === 'approval'
        ? {
            ...block,
            status: 'expired',
            errorMessage: 'turn aborted while awaiting approval'
          }
        : block
    )
    submission.resolve('submitted')
    await resolving

    expect(state.blocks[0]).toMatchObject({
      status: 'expired',
      errorMessage: 'turn aborted while awaiting approval'
    })
  })

  it('settles local runtime work before the backend interrupt resolves', async () => {
    const { actions, provider, recoverActiveTurn, refreshThreads, state } = buildHarness()
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user-1', text: 'run command' },
      {
        kind: 'tool',
        id: 'tool-1',
        summary: 'Running command',
        status: 'running',
        toolKind: 'command_execution'
      },
      {
        kind: 'approval',
        id: 'approval-1',
        approvalId: 'approval-1',
        summary: 'Approve command',
        status: 'pending'
      },
      {
        kind: 'user_input',
        id: 'input-1',
        requestId: 'input-1',
        questions: [],
        status: 'pending'
      }
    ]
    Object.assign(state, {
      blocks,
      busy: true,
      currentTurnId: 'turn-1',
      currentTurnOrchestration: 'graph',
      currentTurnUserId: 'user-1',
      liveAssistant: 'partial answer',
      liveReasoning: '',
      queuedMessages: [],
      turnStartedAtByUserId: { 'user-1': Date.now() - 1000 },
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    })
    let busyWhenBackendCalled: boolean | null = null
    provider.interruptTurn.mockImplementation(async () => {
      busyWhenBackendCalled = state.busy
    })

    await actions.interrupt()

    expect(provider.interruptTurn).toHaveBeenCalledWith('thr_existing', 'turn-1', { discard: false })
    expect(busyWhenBackendCalled).toBe(false)
    expect(state.busy).toBe(false)
    expect(state.currentTurnId).toBeNull()
    expect(state.currentTurnOrchestration).toBeNull()
    expect(state.currentTurnUserId).toBeNull()
    expect(state.liveAssistant).toBe('')
    expect(state.blocks.map((block) => ('status' in block ? block.status : block.kind))).toEqual([
      'user',
      'error',
      'error',
      'cancelled',
      'assistant'
    ])
    expect(refreshThreads).toHaveBeenCalledTimes(1)
    expect(recoverActiveTurn).toHaveBeenCalledTimes(1)
  })

  it('keeps the turn settled when the backend interrupt fails', async () => {
    ;(globalThis as { window?: unknown }).window = {
      kunGui: {
        logError: vi.fn(async () => undefined)
      }
    }
    try {
      const { actions, provider, recoverActiveTurn, state } = buildHarness()
      Object.assign(state, {
        blocks: [{ kind: 'user', id: 'user-1', text: 'run command' }],
        busy: true,
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
        liveAssistant: '',
        liveReasoning: '',
        queuedMessages: [],
        turnStartedAtByUserId: {},
        turnDurationByUserId: {},
        turnReasoningFirstAtByUserId: {},
        turnReasoningLastAtByUserId: {}
      })
      provider.interruptTurn.mockRejectedValueOnce(new Error('runtime timeout'))

      await actions.interrupt()

      expect(state.busy).toBe(false)
      expect(state.currentTurnId).toBeNull()
      expect(state.error).toBe('runtime timeout')
      expect(recoverActiveTurn).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
