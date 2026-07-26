import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type i18next from 'i18next'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import {
  fallbackComposerModel,
  mergeComposerPickList,
  persistComposerMode,
  persistComposerModel,
  persistComposerReasoningEffort,
  rememberThreadComposerMode,
  readStoredComposerModel,
  readStoredComposerReasoningEffort
} from './chat-store-helpers'
import { createAppActions } from './chat-store-app-actions'

const COMPOSER_MODEL_STORAGE_KEY = 'kun.composerModel'
const COMPOSER_PROVIDER_STORAGE_KEY = 'kun.composerProviderId'
const THREAD_COMPOSER_SELECTION_STORAGE_KEY = 'kun.threadComposerSelection.v1'
const THREAD_COMPOSER_MODE_STORAGE_KEY = 'kun.threadComposerMode.v1'
const COMPOSER_MODE_STORAGE_KEY = 'kun.composerMode'
const LEGACY_GRAPH_ORCHESTRATION_STORAGE_KEY = 'kun.graphOrchestration.v1'

function createMemoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, value)
    }
  }
}

type FetchModelsResult =
  | {
      ok: true
      modelIds: string[]
      defaultModelId?: string
      defaultModel?: { providerId: string; modelId: string }
      modelGroups?: ChatState['composerModelGroups']
    }
  | { ok: false; message: string }

function buildHarness(fetchModelsResult: FetchModelsResult): {
  actions: ReturnType<typeof createAppActions>
  state: ChatState
  fetchUpstreamModels: ReturnType<typeof vi.fn>
} {
  let state = {
    activeThreadId: null,
    blocks: [],
    threads: [],
    composerMode: 'agent',
    composerModel: '',
    composerProviderId: '',
    composerReasoningEffort: 'max',
    composerPickList: mergeComposerPickList(false, []),
    composerModelGroups: []
  } as unknown as ChatState
  let loadPromise: Promise<void> | null = null
  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, update)
  }
  const get: ChatStoreGet = () => state

  const fetchUpstreamModels = vi.fn(async () => fetchModelsResult)
  vi.stubGlobal('window', {
    kunGui: {
      fetchUpstreamModels,
      saveSettingsSilent: vi.fn(async () => state)
    }
  })

  const actions = createAppActions({
    set,
    get,
    i18n: { t: (key: string) => key, changeLanguage: vi.fn(async () => undefined) } as unknown as typeof i18next,
    persistComposerModel,
    persistComposerMode,
    persistComposerReasoningEffort,
    rememberThreadComposerMode,
    readStoredComposerModel,
    mergeComposerPickList,
    fallbackComposerModel,
    getComposerModelLoadPromise: () => loadPromise,
    setComposerModelLoadPromise: (promise) => {
      loadPromise = promise
    },
    applyTheme: () => undefined,
    applyUiFontScale: () => undefined,
    applyChatContentMaxWidth: () => undefined,
    applyCursorSpotlight: () => undefined,
    applyCursorSpotlightColor: () => undefined,
    applyWriteTypography: () => undefined,
    applyDocumentLocale: () => undefined,
    workspaceLabelFromPath: (workspaceRoot) => workspaceRoot,
    normalizeWorkspaceRoot: (workspaceRoot) => workspaceRoot?.trim() ?? ''
  })
  Object.assign(state, actions)

  return {
    state,
    fetchUpstreamModels,
    actions
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('chat-store app actions composer model loading', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers the configured default model over a stale global composer model', async () => {
    localStorage.setItem(COMPOSER_MODEL_STORAGE_KEY, 'MiniMax-M2')
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['MiniMax-M2']
      }]
    })

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('deepseek-v4-pro')
    expect(state.composerProviderId).toBe('')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBe('MiniMax-M2')
    expect(localStorage.getItem(COMPOSER_PROVIDER_STORAGE_KEY)).toBeNull()
  })

  it('uses the configured provider when the default model id exists in multiple groups', async () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['shared-model'],
      defaultModelId: 'shared-model',
      defaultModel: { providerId: 'provider-b', modelId: 'shared-model' },
      modelGroups: [
        {
          providerId: 'provider-a',
          label: 'Provider A',
          modelIds: ['shared-model']
        },
        {
          providerId: 'provider-b',
          label: 'Provider B',
          modelIds: ['shared-model']
        }
      ]
    })

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('shared-model')
    expect(state.composerProviderId).toBe('provider-b')
  })

  it('reloads the composer list after settings change during an in-flight model read', async () => {
    const firstRead = deferred<FetchModelsResult>()
    const { actions, state, fetchUpstreamModels } = buildHarness({
      ok: true,
      modelIds: ['gemini-3.1-pro'],
      modelGroups: [{
        providerId: 'gemini-subscription',
        label: 'Gemini subscription',
        modelIds: ['gemini-3.1-pro']
      }]
    })
    fetchUpstreamModels
      .mockImplementationOnce(async () => firstRead.promise)
      .mockResolvedValueOnce({
        ok: true,
        modelIds: ['gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.6-flash'],
        modelGroups: [{
          providerId: 'gemini-subscription',
          label: 'Gemini subscription',
          modelIds: ['gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.6-flash']
        }]
      })

    const initialLoad = actions.loadComposerModels()
    const refreshAfterSettingsSave = actions.loadComposerModels()
    firstRead.resolve({
      ok: true,
      modelIds: ['gemini-3.1-pro'],
      modelGroups: [{
        providerId: 'gemini-subscription',
        label: 'Gemini subscription',
        modelIds: ['gemini-3.1-pro']
      }]
    })

    await Promise.all([initialLoad, refreshAfterSettingsSave])

    expect(fetchUpstreamModels).toHaveBeenCalledTimes(2)
    expect(state.composerModelGroups).toEqual([{
      providerId: 'gemini-subscription',
      label: 'Gemini subscription',
      modelIds: ['gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.6-flash']
    }])
  })

  it('updates the composer provider when the picker supplies a provider id', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['MiniMax-M2']
      }]
    })
    state.composerModelGroups = [{
      providerId: 'minimax',
      label: 'MiniMax',
      modelIds: ['MiniMax-M2']
    }]

    actions.setComposerModel('MiniMax-M2', 'minimax')

    expect(state.composerModel).toBe('MiniMax-M2')
    expect(state.composerProviderId).toBe('minimax')
    expect(localStorage.getItem(COMPOSER_PROVIDER_STORAGE_KEY)).toBe('minimax')
    expect(window.kunGui.saveSettingsSilent).toHaveBeenCalledWith({
      agents: { kun: { model: 'MiniMax-M2', providerId: 'minimax' } }
    })
  })

  it('restores and updates reasoning preferences independently for each model', async () => {
    persistComposerReasoningEffort('model-a', 'provider-a', 'off')
    persistComposerReasoningEffort('model-b', 'provider-b', 'low')
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['model-a', 'model-b'],
      defaultModelId: 'model-a',
      modelGroups: [
        {
          providerId: 'provider-a',
          label: 'Provider A',
          modelIds: ['model-a']
        },
        {
          providerId: 'provider-b',
          label: 'Provider B',
          modelIds: ['model-b']
        }
      ]
    })

    await actions.loadComposerModels()
    expect(state.composerModel).toBe('model-a')
    expect(state.composerReasoningEffort).toBe('off')

    actions.setComposerModel('model-b', 'provider-b')
    expect(state.composerReasoningEffort).toBe('low')
    actions.setComposerReasoningEffort('high')
    expect(readStoredComposerReasoningEffort('model-b', 'provider-b')).toBe('high')
    expect(readStoredComposerReasoningEffort('model-a', 'provider-a')).toBe('off')

    actions.setComposerModel('model-a', 'provider-a')
    expect(state.composerReasoningEffort).toBe('off')
  })

  it('keeps active-thread plan mode changes out of the global composer default', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: []
    })
    state.activeThreadId = 'thread-a'

    actions.setComposerMode('plan')

    expect(state.composerMode).toBe('plan')
    expect(localStorage.getItem(COMPOSER_MODE_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(THREAD_COMPOSER_MODE_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-a': 'plan'
    })
  })

  it('keeps Graph selection session-local instead of restoring it as a default', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['deepseek-v4-pro'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: []
    })

    actions.setComposerOrchestration('graph')

    expect(state.composerOrchestration).toBe('graph')
    expect(localStorage.getItem(LEGACY_GRAPH_ORCHESTRATION_STORAGE_KEY)).toBeNull()
  })

  it('keeps active-thread model changes out of the global Kun default', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['MiniMax-M2']
      }]
    })
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: 'Thread A',
      workspace: '/tmp/project',
      model: 'deepseek-v4-pro',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }]
    state.composerModelGroups = [{
      providerId: 'minimax',
      label: 'MiniMax',
      modelIds: ['MiniMax-M2']
    }]

    actions.setComposerModel('MiniMax-M2', 'minimax')

    expect(state.composerModel).toBe('MiniMax-M2')
    expect(state.composerProviderId).toBe('minimax')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(COMPOSER_PROVIDER_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(THREAD_COMPOSER_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-a': { model: 'MiniMax-M2', providerId: 'minimax', source: 'user' }
    })
    expect(window.kunGui.saveSettingsSilent).not.toHaveBeenCalled()
  })

  it('restores a model selection from the active thread instead of the global picker', async () => {
    localStorage.setItem(COMPOSER_MODEL_STORAGE_KEY, 'deepseek-v4-flash')
    localStorage.setItem(
      THREAD_COMPOSER_SELECTION_STORAGE_KEY,
      JSON.stringify({
        'thread-a': { model: 'MiniMax-M2', providerId: 'minimax', source: 'user' }
      })
    )
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['MiniMax-M2']
      }]
    })
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: 'Thread A',
      workspace: '/tmp/project',
      model: 'deepseek-v4-pro',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }]

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('MiniMax-M2')
    expect(state.composerProviderId).toBe('minimax')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBe('deepseek-v4-flash')
  })

  it('migrates a legacy empty-thread selection to the configured runtime default', async () => {
    localStorage.setItem(
      THREAD_COMPOSER_SELECTION_STORAGE_KEY,
      JSON.stringify({
        'thread-a': { model: 'deepseek-v4-flash', providerId: 'deepseek' }
      })
    )
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['deepseek-v4-flash', 'gemini-2.5-flash'],
      defaultModelId: 'gemini-2.5-flash',
      modelGroups: [
        {
          providerId: 'deepseek',
          label: 'DeepSeek',
          modelIds: ['deepseek-v4-flash']
        },
        {
          providerId: 'gemini-cli-subscription',
          label: 'Gemini CLI',
          modelIds: ['gemini-2.5-flash']
        }
      ]
    })
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: '新会话',
      workspace: '/tmp/project',
      model: 'deepseek-v4-flash',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-07-25T00:00:00.000Z'
    }]

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('gemini-2.5-flash')
    expect(state.composerProviderId).toBe('gemini-cli-subscription')
    expect(JSON.parse(localStorage.getItem(THREAD_COMPOSER_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-a': {
        model: 'gemini-2.5-flash',
        providerId: 'gemini-cli-subscription',
        source: 'default'
      }
    })
  })

  it('keeps the thread model for a conversation with history and no cached selection', async () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['deepseek-v4-flash', 'gemini-2.5-flash'],
      defaultModelId: 'gemini-2.5-flash',
      modelGroups: [
        {
          providerId: 'deepseek',
          label: 'DeepSeek',
          modelIds: ['deepseek-v4-flash']
        },
        {
          providerId: 'gemini-cli-subscription',
          label: 'Gemini CLI',
          modelIds: ['gemini-2.5-flash']
        }
      ]
    })
    state.activeThreadId = 'thread-a'
    state.blocks = [{ kind: 'user', id: 'user-1', text: 'hello' }]
    state.threads = [{
      id: 'thread-a',
      title: 'Existing conversation',
      workspace: '/tmp/project',
      model: 'deepseek-v4-flash',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-07-25T00:00:00.000Z'
    }]

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('deepseek-v4-flash')
    expect(state.composerProviderId).toBe('deepseek')
  })

  it('does not restore a per-thread selection filtered out of the composer menu', async () => {
    localStorage.setItem(
      THREAD_COMPOSER_SELECTION_STORAGE_KEY,
      JSON.stringify({ 'thread-a': { model: 'Kwai-Kolors/Kolors', providerId: 'minimax' } })
    )
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['Kwai-Kolors/Kolors'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['Kwai-Kolors/Kolors'],
        modelProfiles: {
          'kwai-kolors/kolors': {
            inputModalities: ['text'],
            outputModalities: ['image'],
            supportsToolCalling: false,
            messageParts: ['text']
          }
        }
      }]
    })
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: 'Thread A',
      workspace: '/tmp/project',
      model: 'deepseek-v4-pro',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }]

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('deepseek-v4-pro')
    expect(state.composerProviderId).toBe('')
  })

  it('falls back to the configured runtime default when a thread selection was removed', async () => {
    localStorage.setItem(
      THREAD_COMPOSER_SELECTION_STORAGE_KEY,
      JSON.stringify({ 'thread-a': { model: 'deleted-model', providerId: 'old-provider' } })
    )
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['MiniMax-M3', 'MiniMax-M2'],
      defaultModelId: 'deepseek-v4-pro',
      modelGroups: [{
        providerId: 'minimax',
        label: 'MiniMax',
        modelIds: ['MiniMax-M3', 'MiniMax-M2']
      }]
    })
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: 'Thread A',
      workspace: '/tmp/project',
      model: 'deleted-model',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }]

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('deepseek-v4-pro')
    expect(state.composerProviderId).toBe('')
    expect(JSON.parse(localStorage.getItem(THREAD_COMPOSER_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-a': { model: 'deepseek-v4-pro', providerId: '', source: 'default' }
    })
  })

  it('allows switching a chat with image history from vision to text-only', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['vision-model', 'text-model'],
      defaultModelId: 'vision-model',
      modelGroups: []
    })
    state.route = 'chat'
    state.blocks = [{
      kind: 'user',
      id: 'user-1',
      text: 'describe this',
      meta: { attachments: [{ id: 'att-1', kind: 'image' }] }
    }] as ChatState['blocks']
    state.activeThreadId = 'thread-a'
    state.threads = [{
      id: 'thread-a',
      title: 'Thread A',
      workspace: '/tmp/project',
      model: 'vision-model',
      status: 'idle',
      mode: 'agent',
      updatedAt: '2026-06-01T00:00:00.000Z'
    }]
    state.composerModel = 'vision-model'
    state.composerProviderId = 'test-provider'
    state.composerModelGroups = [{
      providerId: 'test-provider',
      label: 'Test',
      modelIds: ['vision-model', 'text-model'],
      modelProfiles: {
        'vision-model': {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        },
        'text-model': {
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text']
        }
      }
    }]

    actions.setComposerModel('text-model', 'test-provider')

    expect(state.composerModel).toBe('text-model')
    expect(state.composerProviderId).toBe('test-provider')
    expect(JSON.parse(localStorage.getItem(THREAD_COMPOSER_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      'thread-a': { model: 'text-model', providerId: 'test-provider', source: 'user' }
    })
    expect(window.kunGui.saveSettingsSilent).not.toHaveBeenCalled()
  })

  it('allows switching a text-only chat from vision to text-only (issue #579)', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['vision-model', 'text-model'],
      defaultModelId: 'vision-model',
      modelGroups: []
    })
    state.route = 'chat'
    // A plain text conversation must not pin the picker to vision models.
    state.blocks = [
      { kind: 'user', id: 'user-1', text: 'hello' },
      { kind: 'assistant', id: 'assistant-1', text: 'hi there' }
    ] as ChatState['blocks']
    state.composerModel = 'vision-model'
    state.composerProviderId = 'test-provider'
    state.composerModelGroups = [{
      providerId: 'test-provider',
      label: 'Test',
      modelIds: ['vision-model', 'text-model'],
      modelProfiles: {
        'vision-model': {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        },
        'text-model': {
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text']
        }
      }
    }]

    actions.setComposerModel('text-model', 'test-provider')

    expect(state.composerModel).toBe('text-model')
    expect(state.composerProviderId).toBe('test-provider')
  })

  it('allows switching a document-only chat from vision to text-only', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['vision-model', 'text-model'],
      defaultModelId: 'vision-model',
      modelGroups: []
    })
    state.route = 'chat'
    // Documents are text-extracted, so they don't require a vision model.
    state.blocks = [{
      kind: 'user',
      id: 'user-1',
      text: 'summarize',
      meta: { attachments: [{ id: 'doc-1', kind: 'document' }] }
    }] as ChatState['blocks']
    state.composerModel = 'vision-model'
    state.composerProviderId = 'test-provider'
    state.composerModelGroups = [{
      providerId: 'test-provider',
      label: 'Test',
      modelIds: ['vision-model', 'text-model'],
      modelProfiles: {
        'vision-model': {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        },
        'text-model': {
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text']
        }
      }
    }]

    actions.setComposerModel('text-model', 'test-provider')

    expect(state.composerModel).toBe('text-model')
  })

  it('allows switching an empty chat from vision to text-only', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['vision-model', 'text-model'],
      defaultModelId: 'vision-model',
      modelGroups: []
    })
    state.route = 'chat'
    state.blocks = []
    state.composerModel = 'vision-model'
    state.composerProviderId = 'test-provider'
    state.composerModelGroups = [{
      providerId: 'test-provider',
      label: 'Test',
      modelIds: ['vision-model', 'text-model'],
      modelProfiles: {
        'vision-model': {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        },
        'text-model': {
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text']
        }
      }
    }]

    actions.setComposerModel('text-model', 'test-provider')

    expect(state.composerModel).toBe('text-model')
    expect(state.composerProviderId).toBe('test-provider')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBe('text-model')
    expect(window.kunGui.saveSettingsSilent).toHaveBeenCalledWith({
      agents: { kun: { model: 'text-model', providerId: 'test-provider' } }
    })
  })

  it('keeps an extension provider binding out of legacy built-in provider settings', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['extension-model'],
      defaultModelId: 'extension-model',
      modelGroups: []
    })
    state.activeThreadId = null
    state.blocks = []
    state.composerModelGroups = [{
      providerId: 'ext-provider-runtime-id',
      label: 'Extension Provider',
      modelIds: ['extension-model'],
      accountId: 'account-extension-1',
      extensionProvider: {
        extensionId: 'acme.models',
        extensionVersion: '1.0.0',
        localProviderId: 'models'
      }
    }]

    actions.setComposerModel('extension-model', 'ext-provider-runtime-id')

    expect(state.composerModel).toBe('extension-model')
    expect(state.composerProviderId).toBe('ext-provider-runtime-id')
    expect(window.kunGui.saveSettingsSilent).not.toHaveBeenCalled()
  })

  it('allows switching an active chat from text-only to vision', () => {
    const { actions, state } = buildHarness({
      ok: true,
      modelIds: ['vision-model', 'text-model'],
      defaultModelId: 'text-model',
      modelGroups: []
    })
    state.route = 'chat'
    state.blocks = [{ kind: 'user', id: 'user-1', text: 'hello' }] as ChatState['blocks']
    state.composerModel = 'text-model'
    state.composerProviderId = 'test-provider'
    state.composerModelGroups = [{
      providerId: 'test-provider',
      label: 'Test',
      modelIds: ['vision-model', 'text-model'],
      modelProfiles: {
        'vision-model': {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        },
        'text-model': {
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text']
        }
      }
    }]

    actions.setComposerModel('vision-model', 'test-provider')

    expect(state.composerModel).toBe('vision-model')
    expect(state.composerProviderId).toBe('test-provider')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBe('vision-model')
  })

  it('does not overwrite a stored custom model when only fallback models are available', async () => {
    localStorage.setItem(COMPOSER_MODEL_STORAGE_KEY, 'MiniMax-M2')
    const { actions, state } = buildHarness({
      ok: false,
      message: 'upstream unavailable'
    })

    await actions.loadComposerModels()

    expect(state.composerModel).toBe('deepseek-v4-pro')
    expect(localStorage.getItem(COMPOSER_MODEL_STORAGE_KEY)).toBe('MiniMax-M2')
  })
})
