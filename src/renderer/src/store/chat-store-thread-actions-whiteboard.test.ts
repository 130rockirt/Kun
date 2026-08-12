import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const registryMock = vi.hoisted(() => ({ getProvider: vi.fn() }))

vi.mock('../agent/registry', () => ({ getProvider: registryMock.getProvider }))

import { createThreadActions } from './chat-store-thread-actions'

function thread(id: string): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-08-13T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace: '/workspace/deepseek-gui',
    status: 'running'
  }
}

function buildHarness(): {
  actions: ReturnType<typeof createThreadActions>
  state: ChatState
} {
  let state: ChatState
  state = {
    activeThreadId: 'thr_existing',
    blocks: [],
    busy: false,
    clawChannels: [],
    codeWorkspaceRoots: [],
    composerModel: '',
    composerMode: 'agent',
    composerOrchestration: 'direct',
    composerProviderId: '',
    currentTurnId: null,
    currentTurnOrchestration: null,
    currentTurnUserId: null,
    error: null,
    extensionComposerContexts: [],
    lastSeq: 0,
    loadComposerModels: vi.fn(async () => undefined),
    queuedMessages: [],
    recoverActiveTurn: vi.fn(async () => true),
    refreshThreads: vi.fn(async () => undefined),
    route: 'write',
    runtimeConnection: 'ready',
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    turnStartedAtByUserId: {},
    threads: [thread('thr_existing')]
  } as unknown as ChatState
  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, update)
  }
  const get: ChatStoreGet = () => state
  const actions = createThreadActions({ set, get, sseAbortRef: { current: null } })
  state.sendMessage = actions.sendMessage
  return { actions, state }
}

function activateWhiteboard(): void {
  const now = '2026-08-13T00:00:00.000Z'
  useWriteWorkspaceStore.setState({
    workspaceRoot: '/workspace/deepseek-gui',
    activeFilePath: null,
    activeFileKind: null,
    activeWhiteboardId: 'board-a',
    documentEpoch: 4,
    contentRevision: 0,
    fileContent: '',
    persistedContent: '',
    saveStatus: 'saved',
    whiteboards: {
      'board-a': {
        id: 'board-a', title: 'PPT review', workspaceRoot: '/workspace/deepseek-gui',
        threadId: 'thr_existing', workflowId: 'workflow-a', childId: 'child-a',
        phase: 'review', revision: 3, createdAt: now, updatedAt: now
      }
    }
  })
}

describe('chat-store Work whiteboard thread fence', () => {
  beforeEach(() => {
    rendererRuntimeClient.invalidateSettings()
    registryMock.getProvider.mockReset()
    registryMock.getProvider.mockReturnValue({})
    activateWhiteboard()
  })

  afterEach(() => {
    useWriteWorkspaceStore.getState().resetWorkspace()
    rendererRuntimeClient.invalidateSettings()
    vi.unstubAllGlobals()
  })

  it('sends on the exact bound thread without resolving a workspace thread', async () => {
    const provider = {
      sendUserMessage: vi.fn(async () => ({
        threadId: 'thr_existing', turnId: 'turn_board', userMessageItemId: 'user_board'
      })),
      subscribeThreadEvents: vi.fn(async () => undefined)
    }
    registryMock.getProvider.mockReturnValue(provider)
    vi.stubGlobal('window', {
      kunGui: {
        getSettings: vi.fn(async () => ({ workspaceRoot: '/workspace/deepseek-gui' })),
        logError: vi.fn(async () => undefined)
      }
    })
    const { actions, state } = buildHarness()
    const ensureWriteThreadForWorkspace = vi.fn(async () => 'thr_workspace')
    state.ensureWriteThreadForWorkspace = ensureWriteThreadForWorkspace as ChatState['ensureWriteThreadForWorkspace']

    await expect(actions.sendMessage('批准当前版本', 'agent', {
      writeContext: {
        workspaceRoot: '/workspace/deepseek-gui', activeFilePath: null,
        documentEpoch: 4, contentRevision: 0,
        whiteboardId: 'board-a', whiteboardRevision: 3, threadId: 'thr_existing'
      }
    })).resolves.toBe(true)

    expect(ensureWriteThreadForWorkspace).not.toHaveBeenCalled()
    expect(provider.sendUserMessage).toHaveBeenCalledWith(
      'thr_existing', expect.stringContaining('批准当前版本'), expect.any(Object)
    )
  })

  it.each([
    ['board', { whiteboardId: 'board-other', whiteboardRevision: 3, threadId: 'thr_existing' }],
    ['revision', { whiteboardId: 'board-a', whiteboardRevision: 2, threadId: 'thr_existing' }],
    ['thread', { whiteboardId: 'board-a', whiteboardRevision: 3, threadId: 'thr_other' }]
  ])('rejects a stale %s fence', async (_label, fence) => {
    vi.stubGlobal('window', { kunGui: {} })
    const { actions, state } = buildHarness()
    const ensureWriteThreadForWorkspace = vi.fn(async () => 'thr_workspace')
    state.ensureWriteThreadForWorkspace = ensureWriteThreadForWorkspace as ChatState['ensureWriteThreadForWorkspace']

    await expect(actions.sendMessage('批准当前版本', 'agent', {
      writeContext: {
        workspaceRoot: '/workspace/deepseek-gui', activeFilePath: null,
        documentEpoch: 4, contentRevision: 0, ...fence
      }
    })).resolves.toBe(false)

    expect(ensureWriteThreadForWorkspace).not.toHaveBeenCalled()
  })
})
