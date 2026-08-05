import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import { rendererRuntimeClient } from '../agent/runtime-client'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  emptyDesignThreadRegistry,
  markDesignThread,
  readDesignThreadRegistry,
  saveDesignThreadRegistry
} from '../design/design-thread-registry'
import {
  activeWriteThreadForWorkspace,
  emptyWriteThreadRegistry,
  markWriteThread,
  readWriteThreadRegistry,
  saveWriteThreadRegistry
} from '../write/write-thread-registry'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import {
  isSddAssistantThread,
  markSddAssistantThread,
  readSddThreadRegistry,
  releaseSddAssistantThread,
  showSddAssistantThreadInSidebar
} from '../sdd/sdd-thread-registry'
import type { SddDraft } from '../sdd/sdd-draft-store'

const registryMock = vi.hoisted(() => ({
  getProvider: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

const applyThemeLibMock = vi.hoisted(() => ({
  applyCursorSpotlight: vi.fn(),
  applyCursorSpotlightColor: vi.fn(),
  applyTheme: vi.fn(),
  applyUiFontScale: vi.fn(),
  applyChatContentMaxWidth: vi.fn(),
  applyDocumentLocale: vi.fn()
}))

vi.mock('../lib/apply-theme', () => applyThemeLibMock)

import {
  createNavigationActions
} from './chat-store-navigation-actions'

function thread(overrides: Partial<NormalizedThread> & Pick<NormalizedThread, 'id' | 'workspace'>): NormalizedThread {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? '2026-06-12T00:00:00.000Z',
    model: overrides.model ?? 'deepseek-v4-pro',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace,
    ...(overrides.agentSurface ? { agentSurface: overrides.agentSurface } : {}),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.archived !== undefined ? { archived: overrides.archived } : {})
  }
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
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('requirement session lifecycle', () => {
  const draft: SddDraft = {
    id: 'draft-1',
    workspaceRoot: '/tmp/app',
    relativePath: '.kunsdd/requirements/draft-1/requirement.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const requirementThread = thread({
    id: 'thread-sdd-1',
    title: 'Requirement draft',
    workspace: '/tmp/app'
  })

  it('stays bound to its draft until released into Code', () => {
    const storage = new MemoryStorage()
    markSddAssistantThread(draft, requirementThread.id, storage)

    let registry = readSddThreadRegistry(storage)
    expect(isSddAssistantThread(requirementThread, registry)).toBe(true)

    showSddAssistantThreadInSidebar(requirementThread.id, storage)
    registry = readSddThreadRegistry(storage)
    expect(isSddAssistantThread(requirementThread, registry)).toBe(true)

    releaseSddAssistantThread(requirementThread.id, storage)
    registry = readSddThreadRegistry(storage)
    expect(isSddAssistantThread(requirementThread, registry)).toBe(false)
  })
})

function buildHarness(overrides?: {
  subscribeThreadEventsLive?: ReturnType<typeof vi.fn>
  recoverActiveTurn?: ReturnType<typeof vi.fn>
  applyI18nFromSettings?: ReturnType<typeof vi.fn>
  probeRuntime?: ReturnType<typeof vi.fn>
  loadComposerModels?: ReturnType<typeof vi.fn>
}): {
  actions: ReturnType<typeof createNavigationActions>
  state: ChatState
  createThread: ReturnType<typeof vi.fn>
  refreshThreads: ReturnType<typeof vi.fn>
  selectThread: ReturnType<typeof vi.fn>
  subscribeThreadEventsLive: ReturnType<typeof vi.fn>
  recoverActiveTurn: ReturnType<typeof vi.fn>
} {
  const createThread = vi.fn(async () => undefined)
  const refreshThreads = vi.fn(async () => undefined)
  const selectThread = vi.fn(async () => undefined)
  const subscribeThreadEventsLive = overrides?.subscribeThreadEventsLive ?? vi.fn(async () => undefined)
  const recoverActiveTurn = overrides?.recoverActiveTurn ?? vi.fn(async () => true)
  const applyI18nFromSettings = overrides?.applyI18nFromSettings ?? vi.fn(async () => undefined)
  const probeRuntime = overrides?.probeRuntime ?? vi.fn(async () => undefined)
  const loadComposerModels = overrides?.loadComposerModels ?? vi.fn(async () => undefined)
  let state = {
    activeThreadId: 'thr_default',
    applyI18nFromSettings,
    busy: false,
    clawChannels: [],
    codeWorkspaceRoots: ['~/.kun/default_workspace'],
    composerPickList: [],
    createThread,
    currentTurnId: null,
    currentTurnUserId: null,
    error: null,
    loadComposerModels,
    openWrite: vi.fn(async () => undefined),
    probeRuntime,
    refreshThreads,
    route: 'chat',
    runtimeConnection: 'ready',
    selectThread,
    subscribeThreadEventsLive,
    recoverActiveTurn,
    threads: [
      thread({
        id: 'thr_default',
        title: 'Only default thread',
        workspace: '~/.kun/default_workspace'
      })
    ],
    unreadThreadIds: {},
    watchTurnCompletion: {},
    workspaceLabel: 'default_workspace',
    workspaceRoot: '~/.kun/default_workspace'
  } as unknown as ChatState

  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...update }
  }
  const get: ChatStoreGet = () => state
  return {
    actions: createNavigationActions({
      set,
      get,
      sseAbortRef: { current: null }
    }),
    get state() {
      return state
    },
    createThread,
    refreshThreads,
    selectThread,
    subscribeThreadEventsLive,
    recoverActiveTurn
  }
}

describe('chat-store navigation workspace selection', () => {
  beforeEach(() => {
    rendererRuntimeClient.invalidateSettings()
    registryMock.getProvider.mockReset()
  })

  afterEach(() => {
    rendererRuntimeClient.invalidateSettings()
    vi.unstubAllGlobals()
  })

  it('does not move the only default thread into a newly picked empty workspace', async () => {
    const provider = {
      updateThreadWorkspace: vi.fn(async () => undefined)
    }
    registryMock.getProvider.mockReturnValue(provider)
    const pickWorkspaceDirectory = vi.fn(async () => ({
      canceled: false,
      path: '/Users/zxy/new-project'
    }))
    const setSettings = vi.fn(async () => ({
      workspaceRoot: '/Users/zxy/new-project'
    }))
    vi.stubGlobal('window', {
      kunGui: {
        pickWorkspaceDirectory,
        setSettings
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.chooseWorkspace()).resolves.toBe('/Users/zxy/new-project')

    expect(pickWorkspaceDirectory).toHaveBeenCalledWith('~/.kun/default_workspace')
    expect(setSettings).toHaveBeenCalledWith({ workspaceRoot: '/Users/zxy/new-project' })
    expect(provider.updateThreadWorkspace).not.toHaveBeenCalled()
    expect(harness.state.threads.find((item) => item.id === 'thr_default')?.workspace)
      .toBe('~/.kun/default_workspace')
    expect(harness.createThread).toHaveBeenCalledWith({ workspaceRoot: '/Users/zxy/new-project' })
    expect(harness.selectThread).not.toHaveBeenCalled()
  })

  it('selectWorkspaceRoot persists the directory and lands on a clean new conversation', async () => {
    const setSettings = vi.fn(async () => ({ workspaceRoot: '/Users/zxy/new-project' }))
    vi.stubGlobal('window', { kunGui: { setSettings } })
    const harness = buildHarness()

    await expect(harness.actions.selectWorkspaceRoot('/Users/zxy/new-project'))
      .resolves.toBe('/Users/zxy/new-project')

    expect(setSettings).toHaveBeenCalledWith({ workspaceRoot: '/Users/zxy/new-project' })
    expect(harness.state.workspaceRoot).toBe('/Users/zxy/new-project')
    expect(harness.state.workspaceLabel).toBe('new-project')
    // Clean empty-hero state so typing starts a fresh thread in the new directory.
    expect(harness.state.activeThreadId).toBeNull()
    expect(harness.state.blocks).toEqual([])
    expect(harness.state.codeWorkspaceRoots).toContain('/Users/zxy/new-project')
    expect(harness.refreshThreads).toHaveBeenCalled()
    // The default thread is preserved in the listing, just not active.
    expect(harness.selectThread).not.toHaveBeenCalled()
    expect(harness.createThread).not.toHaveBeenCalled()
  })

  it('selectWorkspaceRoot ignores an empty path', async () => {
    const setSettings = vi.fn(async () => ({ workspaceRoot: '' }))
    vi.stubGlobal('window', { kunGui: { setSettings } })
    const harness = buildHarness()

    await expect(harness.actions.selectWorkspaceRoot('   ')).resolves.toBeNull()
    expect(setSettings).not.toHaveBeenCalled()
    expect(harness.state.activeThreadId).toBe('thr_default')
  })

  it('selectWorkspaceRoot does not warn before the user sends a message', async () => {
    const setSettings = vi.fn(async () => ({ workspaceRoot: '/Volumes/missing/project' }))
    const alertDialog = vi.fn(async () => undefined)
    const workspaceDirectoryExists = vi.fn(async () => false)
    vi.stubGlobal('window', {
      kunGui: {
        setSettings,
        workspaceDirectoryExists,
        alertDialog
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.selectWorkspaceRoot('/Volumes/missing/project'))
      .resolves.toBe('/Volumes/missing/project')

    expect(setSettings).toHaveBeenCalledOnce()
    expect(workspaceDirectoryExists).not.toHaveBeenCalled()
    expect(alertDialog).not.toHaveBeenCalled()
    expect(harness.state.workspaceRoot).toBe('/Volumes/missing/project')
  })

  it('keeps a missing current workspace without warning during boot', async () => {
    const alertDialog = vi.fn(async () => undefined)
    const workspaceDirectoryExists = vi.fn(async () => false)
    const setSettings = vi.fn()
    vi.stubGlobal('window', {
      kunGui: {
        getSettings: vi.fn(async () => ({
          workspaceRoot: 'E:\\missing-project',
          write: {
            defaultWorkspaceRoot: '~/.kun/write_workspace',
            activeWorkspaceRoot: '~/.kun/write_workspace',
            workspaces: []
          },
          claw: { channels: [] },
          theme: 'dark',
          uiFontScale: 1,
          chatContentMaxWidthPx: 896,
          composerSendKey: 'enter',
          locale: 'en',
          agents: { kun: { apiKey: 'test-key', model: 'deepseek-v4-pro', baseUrl: '' } },
          disabledSkillIds: []
        })),
        setSettings,
        workspaceDirectoryExists,
        alertDialog
      }
    })
    const harness = buildHarness()

    await harness.actions.boot()

    expect(harness.state.workspaceRoot).toBe('E:\\missing-project')
    expect(setSettings).not.toHaveBeenCalled()
    expect(workspaceDirectoryExists).not.toHaveBeenCalled()
    expect(alertDialog).not.toHaveBeenCalled()
    expect(harness.state.error).toBeNull()
  })

  it('starts Kun without reopening completed onboarding when the active provider has no API key', async () => {
    vi.useFakeTimers()
    try {
      const probeRuntime = vi.fn(async () => undefined)
      vi.stubGlobal('window', {
        kunGui: {
          getSettings: vi.fn(async () => ({
            version: 1,
            initialSetupCompleted: true,
            workspaceRoot: '~/.kun/default_workspace',
            conversationWorkspaceRoot: '~/Documents/Kun',
            write: {
              defaultWorkspaceRoot: '~/.kun/write_workspace',
              activeWorkspaceRoot: '~/.kun/write_workspace',
              workspaces: []
            },
            claw: { channels: [] },
            theme: 'dark',
            uiFontScale: 1,
            chatContentMaxWidthPx: 896,
            locale: 'en',
            agents: {
              kun: {
                apiKey: '',
                providerId: 'gemini-subscription',
                model: 'auto',
                baseUrl: ''
              }
            },
            disabledSkillIds: []
          }))
        }
      })
      const harness = buildHarness({ probeRuntime })

      await harness.actions.boot()
      expect(harness.state.initialSetupOpen).not.toBe(true)

      await vi.advanceTimersByTimeAsync(900)
      expect(probeRuntime).toHaveBeenCalledWith('user')
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrates Graph availability during boot but starts the composer in Direct mode', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('window', {
        kunGui: {
          getSettings: vi.fn(async () => ({
            version: 1,
            initialSetupCompleted: true,
            workspaceRoot: '~/.kun/default_workspace',
            conversationWorkspaceRoot: '~/Documents/Kun',
            write: {
              defaultWorkspaceRoot: '~/.kun/write_workspace',
              activeWorkspaceRoot: '~/.kun/write_workspace',
              workspaces: []
            },
            claw: { channels: [] },
            theme: 'dark',
            uiFontScale: 1,
            chatContentMaxWidthPx: 896,
            locale: 'en',
            agents: {
              kun: {
                apiKey: 'test-key',
                model: 'deepseek-v4-pro',
                baseUrl: '',
                graph: {
                  enabled: true,
                  defaultStrategy: 'graph'
                }
              }
            },
            disabledSkillIds: []
          }))
        }
      })
      const harness = buildHarness()
      harness.state.composerOrchestration = 'graph'

      await harness.actions.boot()

      expect(harness.state.graphEnabled).toBe(true)
      expect(harness.state.composerOrchestration).toBe('direct')
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns when creating Write or Design threads for a missing workspace', async () => {
    const alertDialog = vi.fn(async () => undefined)
    vi.stubGlobal('window', {
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => false),
        alertDialog
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.createWriteThread('/Volumes/missing/project')).resolves.toBeNull()
    await expect(harness.actions.createDesignThread('/Volumes/missing/project', 'screen-1')).resolves.toBeNull()

    expect(alertDialog).toHaveBeenCalledTimes(2)
    expect(harness.state.error).toBeTruthy()
  })

  it('can create a replacement Design thread without stealing route or selection', async () => {
    const storage = new MemoryStorage()
    const created = thread({
      id: 'thr_design_replacement',
      title: 'Design Assistant',
      workspace: '/Users/zxy/project'
    })
    registryMock.getProvider.mockReturnValue({
      createThread: vi.fn(async () => created)
    })
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => ({
          ok: true as const,
          path: payload.path,
          size: payload.content.length
        }))
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.createDesignThread(
      '/Users/zxy/project',
      'drawing-1',
      { activate: false, suppressSettingsRedirect: true }
    )).resolves.toBe('thr_design_replacement')

    expect(harness.state.route).toBe('chat')
    expect(harness.state.activeThreadId).toBe('thr_default')
    expect(harness.selectThread).not.toHaveBeenCalled()
    expect(harness.state.threads.some((item) => item.id === created.id)).toBe(true)
  })

  it('waits for the initial Design directory binding before exposing a created thread', async () => {
    const storage = new MemoryStorage()
    const created = thread({
      id: 'thr_design_waiting',
      title: 'Design Assistant',
      workspace: '/Users/zxy/project'
    })
    const pendingWrite = deferred<{
      ok: true
      path: string
      size: number
    }>()
    const writeStarted = deferred<void>()
    registryMock.getProvider.mockReturnValue({
      createThread: vi.fn(async () => created),
      deleteThread: vi.fn(async () => undefined)
    })
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(() => {
          writeStarted.resolve()
          return pendingWrite.promise
        })
      }
    })
    const harness = buildHarness()
    let settled = false

    const creation = harness.actions.createDesignThread('/Users/zxy/project', 'drawing-waiting')
      .then((result) => {
        settled = true
        return result
      })
    await writeStarted.promise

    expect(settled).toBe(false)
    expect(harness.state.activeThreadId).toBe('thr_default')
    expect(harness.state.threads.some((item) => item.id === created.id)).toBe(false)

    pendingWrite.resolve({
      ok: true,
      path: '.kun-design/drawing-waiting/chat/meta.json',
      size: 1
    })
    await expect(creation).resolves.toBe('thr_design_waiting')
    expect(harness.state.activeThreadId).toBe('thr_design_waiting')
  })

  it('rejects and cleans up a new Design thread when its initial directory binding fails', async () => {
    const storage = new MemoryStorage()
    const created = thread({
      id: 'thr_design_unbound',
      title: 'Design Assistant',
      workspace: '/Users/zxy/project'
    })
    const deleteThread = vi.fn(async () => undefined)
    registryMock.getProvider.mockReturnValue({
      createThread: vi.fn(async () => created),
      deleteThread
    })
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async () => ({
          ok: false as const,
          message: 'disk full'
        }))
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.createDesignThread(
      '/Users/zxy/project',
      'drawing-unbound'
    )).resolves.toBeNull()

    expect(deleteThread).toHaveBeenCalledWith('thr_design_unbound')
    expect(readDesignThreadRegistry(storage).workspaces[
      `/Users/zxy/project${String.fromCharCode(0)}drawing-unbound`
    ]).toBeUndefined()
    expect(harness.state.activeThreadId).toBe('thr_default')
    expect(harness.state.threads.some((item) => item.id === created.id)).toBe(false)
    expect(harness.state.error).toContain('Design drawing conversation binding')
  })

  it('retains a recoverable registry binding when failed initial persistence cannot delete the thread', async () => {
    const storage = new MemoryStorage()
    const created = thread({
      id: 'thr_design_retry_cleanup',
      title: 'Design Assistant',
      workspace: '/Users/zxy/project'
    })
    registryMock.getProvider.mockReturnValue({
      createThread: vi.fn(async () => created),
      deleteThread: vi.fn(async () => {
        throw new Error('runtime unavailable')
      })
    })
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async () => ({
          ok: false as const,
          message: 'disk full'
        }))
      }
    })
    const harness = buildHarness()

    await expect(harness.actions.createDesignThread(
      '/Users/zxy/project',
      'drawing-retry-cleanup'
    )).resolves.toBeNull()

    expect(readDesignThreadRegistry(storage).workspaces[
      `/Users/zxy/project${String.fromCharCode(0)}drawing-retry-cleanup`
    ]).toEqual({
      activeThreadId: 'thr_design_retry_cleanup',
      threadIds: ['thr_design_retry_cleanup']
    })
    expect(harness.state.error).toContain('Runtime cleanup also failed')
  })

  it('atomically activates a new Design thread and snapshots the selected Agent persona', async () => {
    const storage = new MemoryStorage()
    const created = thread({
      id: 'thr_design_new',
      title: 'Design Assistant',
      workspace: '/Users/zxy/project'
    })
    const createThread = vi.fn(async () => created)
    registryMock.getProvider.mockReturnValue({ createThread })
    vi.stubGlobal('window', {
      localStorage: storage,
      kunGui: {
        workspaceDirectoryExists: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(async () => ({ ok: false as const, error: 'missing' })),
        writeWorkspaceFile: vi.fn(async (payload: { path: string; content: string }) => ({
          ok: true as const,
          path: payload.path,
          size: payload.content.length
        })),
        getSettings: vi.fn(async () => ({
          agents: {
            kun: {
              subagents: {
                profiles: [{
                  id: 'codex-primary',
                  name: 'Codex',
                  enabled: true,
                  mode: 'primary',
                  providerId: 'codex',
                  model: 'gpt-5.6-luna',
                  systemPrompt: 'Design with Codex.'
                }]
              }
            }
          }
        }))
      }
    })
    const harness = buildHarness()
    harness.state.composerAgentId = 'codex-primary'
    harness.state.blocks = [{ kind: 'user', id: 'u-old', text: 'old conversation' }]
    harness.state.busy = true

    await expect(harness.actions.createDesignThread(
      '/Users/zxy/project',
      'drawing-new'
    )).resolves.toBe('thr_design_new')

    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/Users/zxy/project',
      agentSurface: 'design',
      agentId: 'codex-primary',
      providerId: 'codex',
      model: 'gpt-5.6-luna',
      systemPrompt: 'Design with Codex.'
    }))
    expect(harness.state.activeThreadId).toBe('thr_design_new')
    expect(harness.state.route).toBe('design')
    expect(harness.state.blocks).toEqual([])
    expect(harness.state.busy).toBe(false)
    expect(harness.selectThread).not.toHaveBeenCalled()
    expect(harness.refreshThreads).not.toHaveBeenCalled()
    expect(readDesignThreadRegistry(storage).workspaces[
      `/Users/zxy/project${String.fromCharCode(0)}drawing-new`
    ]?.activeThreadId).toBe('thr_design_new')
  })

  it('openCode does not keep a registered design thread active in Code mode', async () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread(
        '/Users/zxy/project',
        'login',
        'thr_design',
        emptyDesignThreadRegistry()
      ),
      storage
    )
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_design'
    harness.state.workspaceRoot = '/Users/zxy/project'
    harness.state.threads = [
      thread({
        id: 'thr_design',
        title: 'Design Assistant',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T10:00:00.000Z'
      }),
      thread({
        id: 'thr_code',
        title: 'Code task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T09:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_code')
  })

  it('openCode does not keep a durably classified Design thread active without a registry', async () => {
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_design_durable'
    harness.state.workspaceRoot = '/Users/zxy/project'
    harness.state.threads = [
      thread({
        id: 'thr_design_durable',
        title: 'Renamed drawing conversation',
        workspace: '/Users/zxy/project',
        agentSurface: 'design',
        updatedAt: '2026-08-01T10:00:00.000Z'
      }),
      thread({
        id: 'thr_code',
        title: 'Code task',
        workspace: '/Users/zxy/project',
        agentSurface: 'code',
        updatedAt: '2026-08-01T09:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_code')
  })

  it('openCode does not keep a legacy design assistant thread active in Code mode', async () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'kun.design-assistant.threadRegistry.v1',
      JSON.stringify({ '/Users/zxy/project': 'thr_legacy_design' })
    )
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_legacy_design'
    harness.state.workspaceRoot = '/Users/zxy/project'
    harness.state.threads = [
      thread({
        id: 'thr_legacy_design',
        title: 'Design Assistant',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T10:00:00.000Z'
      }),
      thread({
        id: 'thr_code',
        title: 'Code task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T09:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_code')
  })

  it('openCode clears an internal design workspace thread when no Code thread is available', async () => {
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_design'
    harness.state.workspaceRoot = '/Users/zxy/project'
    harness.state.blocks = [
      { kind: 'user', id: 'u1', text: 'design this' },
      { kind: 'assistant', id: 'a1', text: 'Done' }
    ]
    harness.state.threads = [
      thread({
        id: 'thr_design',
        title: 'Design Assistant',
        workspace: '/Users/zxy/.kun/design-workspace',
        updatedAt: '2026-06-12T10:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.state.activeThreadId).toBeNull()
    expect(harness.state.blocks).toEqual([])
    expect(harness.selectThread).not.toHaveBeenCalled()
  })

  it('openCode restores the last selected Code thread instead of the newest one', async () => {
    const harness = buildHarness()
    harness.state.activeThreadId = null
    harness.state.lastCodeThreadId = 'thr_older'
    harness.state.threads = [
      thread({
        id: 'thr_newer',
        title: 'Newer task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-08-01T10:00:00.000Z'
      }),
      thread({
        id: 'thr_older',
        title: 'Older task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T10:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_older')
  })

  it('openCode restores a requirement AI session as the Code return target', async () => {
    const storage = new MemoryStorage()
    markSddAssistantThread(
      {
        id: 'draft-1',
        workspaceRoot: '/Users/zxy/project',
        relativePath: '.kunsdd/requirements/draft-1/requirement.md'
      },
      'thr_sdd',
      storage
    )
    showSddAssistantThreadInSidebar('thr_sdd', storage)
    vi.stubGlobal('window', { localStorage: storage })
    const harness = buildHarness()
    harness.state.activeThreadId = null
    harness.state.lastCodeThreadId = 'thr_sdd'
    harness.state.workspaceRoot = '/Users/zxy/project'
    harness.state.threads = [
      thread({
        id: 'thr_sdd',
        title: 'Requirement session',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-08-01T10:00:00.000Z'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_sdd')
  })

  it('openCode falls back to the newest Code thread when the remembered one is archived', async () => {
    const harness = buildHarness()
    harness.state.activeThreadId = null
    harness.state.lastCodeThreadId = 'thr_archived'
    harness.state.threads = [
      thread({
        id: 'thr_newer',
        title: 'Newer task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-08-01T10:00:00.000Z'
      }),
      thread({
        id: 'thr_archived',
        title: 'Archived task',
        workspace: '/Users/zxy/project',
        updatedAt: '2026-06-12T10:00:00.000Z',
        archived: true
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_newer')
  })

  it('openCode falls back to a Code thread when the remembered thread no longer exists', async () => {
    const harness = buildHarness()
    harness.state.activeThreadId = null
    harness.state.lastCodeThreadId = 'thr_gone'
    harness.state.threads = [
      thread({
        id: 'thr_only',
        title: 'Only task',
        workspace: '/Users/zxy/project'
      })
    ]

    await harness.actions.openCode()

    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_only')
  })

  it('refreshThreads clears Code session memory when the remembered thread disappears', async () => {
    const provider = {
      listThreads: vi.fn(async () => []),
      getThreadDetail: vi.fn(async () => ({ blocks: [] }))
    }
    registryMock.getProvider.mockReturnValue(provider)
    vi.stubGlobal('window', {
      localStorage: new MemoryStorage(),
      kunGui: {
        getSettings: vi.fn(async () => ({
          write: {
            defaultWorkspaceRoot: '~/.kun/write_workspace',
            activeWorkspaceRoot: '~/.kun/write_workspace',
            workspaces: []
          }
        }))
      }
    })
    const harness = buildHarness()
    harness.state.lastCodeThreadId = 'thr_gone'
    harness.state.threads = []

    await harness.actions.refreshThreads()

    expect(harness.state.lastCodeThreadId).toBeNull()
  })

  it('openDesign does not keep a code thread active in Design mode', () => {
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_code'
    harness.state.route = 'chat'
    harness.state.busy = true
    harness.state.blocks = [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'assistant', id: 'a1', text: 'How can I help?' }
    ]
    harness.state.threads = [
      thread({
        id: 'thr_code',
        title: 'Code task',
        workspace: '/Users/zxy/project'
      })
    ]

    harness.actions.openDesign()

    expect(harness.state.route).toBe('design')
    expect(harness.state.activeThreadId).toBeNull()
    expect(harness.state.blocks).toEqual([])
    expect(harness.state.busy).toBe(false)
    expect(harness.state.watchTurnCompletion).toEqual({ thr_code: true })
    expect(harness.selectThread).not.toHaveBeenCalled()
  })

  it('clearActiveThreadSelection clears stale blocks and watches a running thread', () => {
    const harness = buildHarness()
    harness.state.activeThreadId = 'thr_old_design'
    harness.state.busy = true
    harness.state.blocks = [
      { kind: 'user', id: 'u1', text: 'old design request' },
      { kind: 'assistant', id: 'a1', text: 'old design answer' }
    ]

    harness.actions.clearActiveThreadSelection()

    expect(harness.state.activeThreadId).toBeNull()
    expect(harness.state.blocks).toEqual([])
    expect(harness.state.busy).toBe(false)
    expect(harness.state.watchTurnCompletion).toEqual({ thr_old_design: true })
  })
})

describe('write assistant file conversation selection', () => {
  beforeEach(() => {
    rendererRuntimeClient.invalidateSettings()
    registryMock.getProvider.mockReset()
  })

  afterEach(() => {
    useWriteWorkspaceStore.getState().resetWorkspace()
    rendererRuntimeClient.invalidateSettings()
    vi.unstubAllGlobals()
  })

  it('selects the conversation mapped to the active file', async () => {
    const storage = new MemoryStorage()
    const workspace = '/Users/zxy/write'
    const registry = markWriteThread(
      workspace,
      'thr_b',
      markWriteThread(workspace, 'thr_a', emptyWriteThreadRegistry(), `${workspace}/a.md`),
      `${workspace}/b.md`
    )
    saveWriteThreadRegistry(registry, storage)
    vi.stubGlobal('window', { localStorage: storage })
    useWriteWorkspaceStore.setState({
      workspaceRoot: workspace,
      activeFilePath: `${workspace}/b.md`,
      activeFileKind: 'text'
    })
    const harness = buildHarness()
    Object.assign(harness.state, harness.actions)
    harness.state.activeThreadId = 'thr_a'
    harness.state.workspaceRoot = workspace
    harness.state.threads = [
      thread({ id: 'thr_a', workspace }),
      thread({ id: 'thr_b', workspace })
    ]

    await expect(harness.actions.ensureWriteThreadForWorkspace(workspace)).resolves.toBe('thr_b')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_b')
  })

  it('creates and records a fresh conversation for an unmapped file', async () => {
    const storage = new MemoryStorage()
    const workspace = '/Users/zxy/write'
    const activeFilePath = `${workspace}/new.md`
    vi.stubGlobal('window', { localStorage: storage })
    useWriteWorkspaceStore.setState({
      workspaceRoot: workspace,
      activeFilePath,
      activeFileKind: 'text'
    })
    const created = thread({ id: 'thr_new', workspace, title: 'Write Assistant' })
    const createThread = vi.fn(async () => created)
    registryMock.getProvider.mockReturnValue({ createThread })
    const harness = buildHarness()
    Object.assign(harness.state, harness.actions)
    harness.state.activeThreadId = null
    harness.state.workspaceRoot = workspace
    harness.state.threads = []

    await expect(harness.actions.ensureWriteThreadForWorkspace(workspace)).resolves.toBe('thr_new')

    const registry = readWriteThreadRegistry(storage)
    expect(createThread).toHaveBeenCalledWith({
      workspace,
      title: 'Write Assistant',
      mode: 'agent',
      agentSurface: 'write'
    })
    expect(activeWriteThreadForWorkspace(
      workspace,
      [created],
      registry,
      activeFilePath
    )?.id).toBe('thr_new')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_new')
  })
})

describe('onClawChannelActivity routes through subscribeThreadEventsLive (not selectThread)', () => {
  beforeEach(() => {
    rendererRuntimeClient.invalidateSettings()
    registryMock.getProvider.mockReset()
  })

  afterEach(() => {
    rendererRuntimeClient.invalidateSettings()
    vi.unstubAllGlobals()
  })

  it('calls subscribeThreadEventsLive when activeThreadId differs from the bot thread', async () => {
    const subscribeThreadEventsLive = vi.fn(async () => undefined)
    const selectThread = vi.fn(async () => undefined)
    const recoverActiveTurn = vi.fn(async () => true)

    // Capture the callback registered via window.kunGui.onClawChannelActivity
    let capturedClawActivityCallback: ((payload: { channelId: string; threadId: string }) => void) | null = null
    const onClawChannelActivity = vi.fn((cb: (payload: { channelId: string; threadId: string }) => void) => {
      capturedClawActivityCallback = cb
      return () => {}
    })
    const onRuntimeStatus = vi.fn(() => () => {})
    let capturedTrayActionCallback: ((payload: { type: 'new-chat' } | { type: 'open-thread'; threadId: string }) => void) | null = null
    const onTrayAction = vi.fn((cb: typeof capturedTrayActionCallback) => {
      capturedTrayActionCallback = cb
      return () => {}
    })
    const getSettings = vi.fn(async () => ({
      workspaceRoot: '~/.kun/default_workspace',
      write: {
        defaultWorkspaceRoot: '~/.kun/default_workspace',
        activeWorkspaceRoot: '~/.kun/default_workspace',
        workspaces: []
      },
      claw: {
        channels: [
          { id: 'ch_1', enabled: true, label: 'Feishu Agent01', provider: 'feishu' }
        ]
      },
      theme: 'dark',
      uiFontScale: 1,
      chatContentMaxWidthPx: 896,
      composerSendKey: 'enter',
      locale: 'en',
      agents: { kun: { apiKey: 'test-key', model: 'deepseek-v4-pro', baseUrl: '' } },
      disabledSkillIds: []
    }))
    vi.stubGlobal('window', {
      kunGui: {
        getSettings,
        onClawChannelActivity,
        onTrayAction,
        onRuntimeStatus
      }
    })

    const harness = buildHarness({ subscribeThreadEventsLive, recoverActiveTurn })
    await harness.actions.boot()
    expect(typeof capturedClawActivityCallback).toBe('function')
    expect(onClawChannelActivity).toHaveBeenCalledTimes(1)
    expect(onTrayAction).toHaveBeenCalledTimes(1)

    harness.state.route = 'settings'
    capturedTrayActionCallback!({ type: 'open-thread', threadId: 'thr_recent' })
    expect(harness.state.route).toBe('chat')
    expect(harness.selectThread).toHaveBeenCalledWith('thr_recent')

    harness.state.route = 'settings'
    capturedTrayActionCallback!({ type: 'new-chat' })
    expect(harness.state.route).toBe('chat')
    expect(harness.createThread).toHaveBeenCalledWith({ forceNew: true })

    // Set state conditions AFTER boot so they survive the boot's set() calls:
    // route is claw, activeClawChannelId matches incoming channelId,
    // activeThreadId differs from incoming threadId — so we should auto-switch.
    harness.state.route = 'claw'
    harness.state.activeClawChannelId = 'ch_1'
    harness.state.activeThreadId = 'thr_default'

    // Trigger the captured callback with a Feishu bot event.
    await capturedClawActivityCallback!({ channelId: 'ch_1', threadId: 'thr_bot' })
    // Allow the void(async()) microtask inside the callback to flush.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(subscribeThreadEventsLive).toHaveBeenCalledWith('thr_bot')
    expect(selectThread).not.toHaveBeenCalled()
  })
})
