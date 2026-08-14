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
