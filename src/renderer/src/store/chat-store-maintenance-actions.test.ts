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
import type { DesignTaskProfile } from '../agent/design-task-profile'
import {
  emptyDesignThreadRegistry,
  isDesignThreadId,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry
} from '../design/design-thread-registry'
import { clearDesignChatHistoryMutationsForTests } from '../design/design-chat-transcript'
import { maintenanceTestGoal as goal } from './chat-store-maintenance-test-support'

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
    listThreads: ReturnType<typeof vi.fn>
    getResumeSessionMetadata: ReturnType<typeof vi.fn>
    resumeSession: ReturnType<typeof vi.fn>
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
    listThreads: vi.fn(async () => state.threads),
    getResumeSessionMetadata: vi.fn(async (sessionId: string) => ({
      sessionId,
      sourceAgentSurface: 'code' as const,
      requiresIndependentDesignTarget: false
    })),
    resumeSession: vi.fn(async (sessionId: string) => ({
      threadId: 'thr_resumed',
      sessionId
    })),
    forkThread: vi.fn(async (
      threadId: string,
      options?: {
        turnId?: string
        designDocumentTarget?: { documentId: string; boardArtifactId: string }
      }
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

  it('clones a locked Design document and sends the independent target to the fork', async () => {
    const cleanup = vi.fn(async () => undefined)
    const cloneDesignDocumentForFork = vi.fn(async () => ({
      designDocumentTarget: { documentId: 'doc_fork', boardArtifactId: 'board_main' },
      operationId: 'design-clone-fork-test',
      cleanup
    }))
    const { actions, provider, refreshThreads, selectThread, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForFork }
    })
    const designProfile: DesignTaskProfile = {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      outputMedium: 'html',
      target: 'web',
      preset: 'none',
      context: { tone: [] },
      lockedAtTurnId: 'turn_1'
    }
    state.threads = [{
      ...thread('thr_existing'),
      agentSurface: 'design',
      designProfile
    }]
    state.blocks = []

    await actions.forkActiveThread()

    expect(cloneDesignDocumentForFork).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      sourceTarget: designProfile.documentTarget,
      operation: { kind: 'fork', sourceId: 'thr_existing', relation: 'fork' }
    })
    expect(provider.forkThread).toHaveBeenCalledWith('thr_existing', {
      designDocumentTarget: { documentId: 'doc_fork', boardArtifactId: 'board_main' },
      designCloneOperationId: 'design-clone-fork-test'
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(refreshThreads).toHaveBeenCalledTimes(1)
    expect(selectThread).toHaveBeenCalledWith('thr_forked')
  })

  it('rejects a historical Design fork before cloning the latest whiteboard', async () => {
    const cloneDesignDocumentForFork = vi.fn()
    const { actions, provider, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForFork }
    })
    state.threads = [{
      ...thread('thr_existing'),
      agentSurface: 'design',
      designProfile: {
        version: 1,
        documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
        outputMedium: 'html',
        target: 'web',
        preset: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn_1'
      }
    }]

    await actions.forkThreadFromTurn('turn_1')

    expect(state.error).toContain('historical whiteboard snapshots are unavailable')
    expect(cloneDesignDocumentForFork).not.toHaveBeenCalled()
    expect(provider.forkThread).not.toHaveBeenCalled()
  })

  it('cleans the cloned Design document when the runtime rejects the fork', async () => {
    const cleanup = vi.fn(async () => undefined)
    const cloneDesignDocumentForFork = vi.fn(async () => ({
      designDocumentTarget: { documentId: 'doc_fork', boardArtifactId: 'board_main' },
      cleanup
    }))
    const { actions, provider, refreshThreads, selectThread, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForFork }
    })
    state.threads = [{
      ...thread('thr_existing'),
      agentSurface: 'design',
      designProfile: {
        version: 1,
        documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
        outputMedium: 'image',
        target: 'app',
        preset: 'ios',
        context: { tone: ['calm'] },
        lockedAtTurnId: 'turn_1'
      }
    }]
    provider.forkThread.mockRejectedValueOnce(new Error('HTTP 409 fork rejected'))

    await actions.forkActiveThread()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(refreshThreads).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
    expect(state.error).toContain('fork rejected')
  })

  it('retains and recovers a Design fork when the committed response is lost', async () => {
    const cleanup = vi.fn(async () => undefined)
    const commit = vi.fn(async () => undefined)
    const clonedTarget = { documentId: 'doc_fork_recovered', boardArtifactId: 'board_main' }
    const cloneDesignDocumentForFork = vi.fn(async () => ({
      designDocumentTarget: clonedTarget, cleanup, commit
    }))
    const { actions, provider, selectThread, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForFork }
    })
    const designProfile: DesignTaskProfile = {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      outputMedium: 'html', target: 'web', preset: 'none', context: { tone: [] },
      lockedAtTurnId: 'turn_1'
    }
    state.threads = [{ ...thread('thr_existing'), agentSurface: 'code', designProfile }]
    state.blocks = []
    provider.forkThread.mockImplementationOnce(async () => {
      state.threads.push({
        ...thread('thr_fork_recovered'),
        forkedFromThreadId: 'thr_existing',
        designProfile: { ...designProfile, documentTarget: clonedTarget }
      })
      throw new Error('Failed to fetch after commit')
    })

    await actions.forkActiveThread()

    expect(provider.listThreads).toHaveBeenCalledWith({
      includeArchived: true, includeSide: true
    })
    expect(commit).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    expect(selectThread).toHaveBeenCalledWith('thr_fork_recovered')
  })

  it('does not delete a Design clone when timeout lookup precedes a late commit', async () => {
    const cleanup = vi.fn(async () => undefined)
    const markRuntimeRequestStarted = vi.fn(async () => undefined)
    const clonedTarget = { documentId: 'doc_fork_late', boardArtifactId: 'board_main' }
    const cloneDesignDocumentForFork = vi.fn(async () => ({
      designDocumentTarget: clonedTarget, cleanup, markRuntimeRequestStarted
    }))
    const { actions, provider, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForFork }
    })
    const designProfile: DesignTaskProfile = {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      outputMedium: 'html', target: 'web', preset: 'none', context: { tone: [] },
      lockedAtTurnId: 'turn_1'
    }
    state.threads = [{ ...thread('thr_existing'), agentSurface: 'code', designProfile }]
    state.blocks = []
    provider.forkThread.mockRejectedValueOnce(new Error('network timeout after request'))
    provider.listThreads.mockResolvedValueOnce([])

    await actions.forkActiveThread()
    state.threads.push({
      ...thread('thr_fork_late'),
      designProfile: { ...designProfile, documentTarget: clonedTarget }
    })

    expect(markRuntimeRequestStarted).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    expect(state.threads.some((candidate) =>
      candidate.designProfile?.documentTarget.documentId === 'doc_fork_late'
    )).toBe(true)
  })
})

describe('chat-store-maintenance-actions Design resume', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('clones a locked document and supplies the independent target to resume', async () => {
    const cleanup = vi.fn(async () => undefined)
    const cloneDesignDocumentForResume = vi.fn(async () => ({
      designDocumentTarget: { documentId: 'doc_resumed', boardArtifactId: 'board_main' },
      operationId: 'design-clone-resume-test',
      cleanup
    }))
    const { actions, provider, refreshThreads, selectThread, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForResume }
    })
    const designProfile: DesignTaskProfile = {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      outputMedium: 'html',
      target: 'app',
      preset: 'ios',
      presetSource: 'explicit',
      context: { tone: ['precise'] },
      lockedAtTurnId: 'turn_lock'
    }
    state.threads = [{
      ...thread('thr_existing'),
      agentSurface: 'design',
      designProfile
    }]

    await expect(actions.resumeSessionIntoThread('thr_existing', {
      model: 'deepseek-chat'
    })).resolves.toBe('thr_resumed')

    expect(cloneDesignDocumentForResume).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/deepseek-gui',
      sourceTarget: designProfile.documentTarget,
      operation: { kind: 'resume', sourceId: 'thr_existing', relation: 'resume' }
    })
    expect(provider.resumeSession).toHaveBeenCalledWith('thr_existing', {
      model: 'deepseek-chat',
      workspace: '/workspace/deepseek-gui',
      designDocumentTarget: { documentId: 'doc_resumed', boardArtifactId: 'board_main' },
      designCloneOperationId: 'design-clone-resume-test'
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(refreshThreads).toHaveBeenCalledOnce()
    expect(selectThread).toHaveBeenCalledWith('thr_resumed')
  })

  it('cleans the prepared resume clone when runtime admission fails', async () => {
    const cleanup = vi.fn(async () => undefined)
    const cloneDesignDocumentForResume = vi.fn(async () => ({
      designDocumentTarget: { documentId: 'doc_resumed', boardArtifactId: 'board_main' },
      cleanup
    }))
    const { actions, provider, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForResume }
    })
    state.threads = [{
      ...thread('thr_existing'),
      agentSurface: 'design',
      designProfile: {
        version: 1,
        documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
        outputMedium: 'image',
        target: 'web',
        preset: 'none',
        presetSource: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn_lock'
      }
    }]
    provider.resumeSession.mockRejectedValueOnce(new Error('HTTP 409 resume rejected'))

    await expect(actions.resumeSessionIntoThread('thr_existing')).resolves.toBeNull()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(state.error).toContain('resume rejected')
  })

  it('recovers a committed Design resume after its HTTP response is lost', async () => {
    const cleanup = vi.fn(async () => undefined)
    const commit = vi.fn(async () => undefined)
    const clonedTarget = { documentId: 'doc_resumed_recovered', boardArtifactId: 'board_main' }
    const cloneDesignDocumentForResume = vi.fn(async () => ({
      designDocumentTarget: clonedTarget, cleanup, commit
    }))
    const { actions, provider, selectThread, state } = buildHarness({
      maintenanceDependencies: { cloneDesignDocumentForResume }
    })
    const designProfile: DesignTaskProfile = {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_main' },
      outputMedium: 'html', target: 'web', preset: 'none', context: { tone: [] },
      lockedAtTurnId: 'turn_source'
    }
    state.threads = [{ ...thread('thr_existing'), agentSurface: 'code', designProfile }]
    provider.resumeSession.mockImplementationOnce(async () => {
      state.threads.push({
        ...thread('thr_resume_recovered'),
        designProfile: { ...designProfile, documentTarget: clonedTarget }
      })
      throw new Error('network connection closed after commit')
    })

    await expect(actions.resumeSessionIntoThread('thr_existing'))
      .resolves.toBe('thr_resume_recovered')

    expect(commit).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    expect(selectThread).toHaveBeenCalledWith('thr_resume_recovered')
  })

  it('uses session-only Design metadata to clone an independent resume target', async () => {
    const cleanup = vi.fn(async () => undefined)
    const cloneDesignDocumentForResume = vi.fn(async () => ({
      designDocumentTarget: { documentId: 'doc_session_clone', boardArtifactId: 'board_session' },
      operationId: 'design-clone-session-test',
      cleanup
    }))
    const { actions, provider, state } = buildHarness({
      activeThreadId: null,
      maintenanceDependencies: { cloneDesignDocumentForResume }
    })
    state.threads = []
    provider.getResumeSessionMetadata.mockResolvedValueOnce({
      sessionId: 'session-only-design',
      sourceAgentSurface: 'design',
      workspace: '/workspace/session-only',
      sourceDesignProfile: {
        version: 1,
        documentTarget: { documentId: 'doc_session', boardArtifactId: 'board_session' },
        outputMedium: 'html',
        target: 'web',
        preset: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn_session'
      },
      sourceDesignDocumentTarget: {
        documentId: 'doc_session',
        boardArtifactId: 'board_session'
      },
      requiresIndependentDesignTarget: true
    })

    await expect(actions.resumeSessionIntoThread('session-only-design'))
      .resolves.toBe('thr_resumed')

    expect(provider.getResumeSessionMetadata).toHaveBeenCalledWith('session-only-design')
    expect(cloneDesignDocumentForResume).toHaveBeenCalledWith({
      workspaceRoot: '/workspace/session-only',
      sourceTarget: { documentId: 'doc_session', boardArtifactId: 'board_session' },
      operation: { kind: 'resume', sourceId: 'session-only-design', relation: 'resume' }
    })
    expect(provider.resumeSession).toHaveBeenCalledWith('session-only-design', {
      workspace: '/workspace/session-only',
      designDocumentTarget: {
        documentId: 'doc_session_clone',
        boardArtifactId: 'board_session'
      },
      designCloneOperationId: 'design-clone-session-test'
    })
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('fails closed when session-only Design metadata has no source workspace', async () => {
    const cloneDesignDocumentForResume = vi.fn()
    const { actions, provider, state } = buildHarness({
      activeThreadId: null,
      maintenanceDependencies: { cloneDesignDocumentForResume }
    })
    state.workspaceRoot = '/workspace/current-project'
    state.threads = []
    provider.getResumeSessionMetadata.mockResolvedValueOnce({
      sessionId: 'session-design-missing-workspace',
      sourceAgentSurface: 'code',
      sourceDesignDocumentTarget: {
        documentId: 'doc_session',
        boardArtifactId: 'board_session'
      },
      requiresIndependentDesignTarget: true
    })

    await expect(actions.resumeSessionIntoThread('session-design-missing-workspace'))
      .resolves.toBeNull()

    expect(cloneDesignDocumentForResume).not.toHaveBeenCalled()
    expect(provider.resumeSession).not.toHaveBeenCalled()
    expect(state.error).toContain('source workspace is unavailable')
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
