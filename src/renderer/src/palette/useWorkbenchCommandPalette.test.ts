import { createElement, type ReactElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { resolveKeyboardShortcutBindings } from '@shared/keyboard-shortcuts'
import type { PaletteEntry } from './palette-model'
import { DEFAULT_PALETTE_ENTRY_IDS } from './palette-model'
import { PALETTE_RECENTS_STORAGE_KEY } from './palette-recents'
import type { PaletteSourcesInput, PaletteThreadLike } from './palette-sources'
import { useCommandPaletteStore } from './palette-store'
import {
  useWorkbenchCommandPalette,
  type PaletteActivationHandlers,
  type PaletteContentSearch,
  type PaletteResultGroup
} from './useWorkbenchCommandPalette'

const t = ((key: string): string => key) as TFunction
const tSettings = (key: string): string => key

function thread(id: string, title: string, updatedAt: string): PaletteThreadLike {
  return { id, title, updatedAt, archived: false }
}

function baseInput(overrides: Partial<PaletteSourcesInput> = {}): PaletteSourcesInput {
  return {
    t,
    tSettings,
    route: 'chat',
    workspaceRoot: '/Users/demo/project',
    threads: [
      thread('thr_a', 'Alpha billing', '2026-08-14T10:00:00.000Z'),
      thread('thr_b', 'Beta checkout', '2026-08-13T10:00:00.000Z')
    ],
    codeWorkspaceRoots: ['/Users/demo/project'],
    runtimeReady: true,
    busy: false,
    activeThreadId: 'thr_a',
    activeThreadArchived: false,
    canOpenGoalPanel: true,
    canCreateNewThread: true,
    hasPlanCommand: true,
    hasBtwCommand: true,
    hideBtwCommand: false,
    hasReviewCommand: true,
    skillCommands: [],
    disabledSkillIds: [],
    extensionRightRailItems: [],
    shortcutBindings: resolveKeyboardShortcutBindings(null, 'darwin'),
    hasComposerDraft: false,
    composerModel: 'deepseek-v4-flash',
    composerModelGroups: [
      { providerId: 'deepseek', label: 'DeepSeek', modelIds: ['deepseek-v4-flash', 'deepseek-v4'] },
      { providerId: 'anthropic', label: 'Anthropic', modelIds: ['claude-sonnet-5'] }
    ],
    activeThreadPinned: false,
    ...overrides
  }
}

type PaletteApi = ReturnType<typeof useWorkbenchCommandPalette>

function noopHandlers(): PaletteActivationHandlers {
  return {
    route: vi.fn(),
    settings: vi.fn(),
    thread: vi.fn(),
    workspace: vi.fn(),
    'shortcut-command': vi.fn(),
    'slash-command': vi.fn(),
    'extension-view': vi.fn(() => true),
    compose: vi.fn(),
    'select-model': vi.fn(),
    'thread-action': vi.fn(),
    unavailable: vi.fn()
  }
}

async function mountPalette(options: {
  handlers?: PaletteActivationHandlers
  sources?: Partial<PaletteSourcesInput>
  searchThreadContent?: PaletteContentSearch
} = {}): Promise<{ current: () => PaletteApi }> {
  let latest!: PaletteApi
  function Probe(): ReactElement | null {
    latest = useWorkbenchCommandPalette({
      ...baseInput(options.sources),
      handlers: options.handlers ?? noopHandlers(),
      ...(options.searchThreadContent
        ? { searchThreadContent: options.searchThreadContent }
        : {})
    })
    return null
  }
  await act(async () => {
    createRenderer(createElement(Probe))
  })
  return { current: () => latest }
}

function allRenderedIds(api: PaletteApi): string[] {
  // Mirrors how the overlay concatenates: results first, then groups.
  const groupEntries = (api.groups ?? []).flatMap((group: PaletteResultGroup) => group.entries)
  return [...api.results, ...groupEntries].map((entry: PaletteEntry) => entry.id)
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, String(value))
    }
  }
}

let storage: Storage

describe('useWorkbenchCommandPalette', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    // Timer calls delegate at call time so `vi.useFakeTimers` still applies.
    vi.stubGlobal('window', {
      localStorage: storage,
      setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id)
    })
    act(() => {
      useCommandPaletteStore.setState({ open: true })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('browses the whole capability surface on the empty query, without repeats', async () => {
    const palette = await mountPalette()
    const api = palette.current()

    // The catalog is rendered as grouped sections, never as a flat list
    // duplicated beneath them — that duplication was the original bug.
    expect(api.results).toEqual([])
    expect((api.groups ?? []).map((group) => group.key)).toEqual([
      'default',
      'browse:actions',
      'browse:commands',
      'browse:navigation',
      'browse:settings',
      'browse:models',
      'browse:conversations',
      'browse:projects'
    ])

    const rendered = allRenderedIds(api)
    expect(new Set(rendered).size).toBe(rendered.length)
    // Quick actions stay first, and every one of them appears exactly once.
    expect((api.groups ?? [])[0].entries.map((entry) => entry.id))
      .toEqual(DEFAULT_PALETTE_ENTRY_IDS.filter((id) => rendered.includes(id)))
  })

  it('lists every command, route, setting and model in the browse sections', async () => {
    const palette = await mountPalette()
    const api = palette.current()
    const rendered = new Set(allRenderedIds(api))

    // Nothing in the catalog is unreachable from the opening view.
    const missing = api.results.length === 0
      ? [...new Set(
          (api.groups ?? []).flatMap((group) => group.entries).map((entry) => entry.source)
        )]
      : []
    expect(missing).toContain('settings')
    expect(rendered.has('route:write')).toBe(true)
    expect(rendered.has('settings:providers')).toBe(true)
    expect(rendered.has('model:anthropic:claude-sonnet-5')).toBe(true)
    expect(rendered.has('cmd:toggle-terminal')).toBe(true)
  })

  it('previews conversations rather than listing every one', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      thread('thr_' + index, 'Conversation ' + index, '2026-08-1' + (index % 5) + 'T10:00:00.000Z'))
    const palette = await mountPalette({ sources: { threads: many } })
    const conversations = (palette.current().groups ?? [])
      .find((group) => group.key === 'browse:conversations')
    // Content, not capability: the rest are one keystroke away.
    expect(conversations?.entries.length).toBe(8)
  })

  it('lists recents ahead of defaults and never twice', async () => {
    storage.setItem(PALETTE_RECENTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      workspaces: {
        '/Users/demo/project': [
          { source: 'route', id: 'route:write' },
          { source: 'settings', id: 'settings:providers' }
        ]
      }
    }))
    const palette = await mountPalette()
    const api = palette.current()

    const groups = api.groups ?? []
    // Recents lead, quick actions follow, then the browsable catalog.
    expect(groups.slice(0, 2).map((group) => group.key)).toEqual(['recent', 'default'])
    expect(groups[0].entries.map((entry) => entry.id)).toEqual([
      'route:write', 'settings:providers'
    ])
    // A promoted entry must not also appear in its browse section.
    const rendered = allRenderedIds(api)
    expect(new Set(rendered).size).toBe(rendered.length)
    expect(rendered.filter((id) => id === 'route:write')).toHaveLength(1)
    expect(rendered.filter((id) => id === 'settings:providers')).toHaveLength(1)
  })

  it('ranks the catalog once a query is typed', async () => {
    const palette = await mountPalette()
    await act(async () => {
      palette.current().setQuery('billing')
    })
    const api = palette.current()
    expect(api.results.some((entry) => entry.id === 'thread:thr_a')).toBe(true)
    expect(api.results.some((entry) => entry.id === 'thread:thr_b')).toBe(false)
    // No curated groups compete with a real query.
    expect(api.groups).toBeNull()
  })

  it('searches every project and skips short queries', async () => {
    vi.useFakeTimers()
    try {
      const searchThreadContent = vi.fn<PaletteContentSearch>(async () => [])
      const palette = await mountPalette({
        searchThreadContent,
        sources: { workspaceRoot: '/Users/demo/project' }
      })

      // Set the query and advance in separate acts: effects only flush when
      // act exits, so the debounce timer does not exist until then.
      await act(async () => {
        palette.current().setQuery('x')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(searchThreadContent).not.toHaveBeenCalled()

      await act(async () => {
        palette.current().setQuery('checkout')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      // No workspace is sent: recalling a discussion rarely comes with
      // recalling which project it happened in.
      expect(searchThreadContent).toHaveBeenCalledWith('checkout', { limit: 8 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports pending from the keystroke until the search settles', async () => {
    vi.useFakeTimers()
    try {
      let release: (value: never[]) => void = () => {}
      const searchThreadContent = vi.fn<PaletteContentSearch>(
        () => new Promise((resolve) => { release = resolve })
      )
      const palette = await mountPalette({ searchThreadContent })
      expect(palette.current().contentSearchPending).toBe(false)

      await act(async () => {
        palette.current().setQuery('checkout')
      })
      // Pending covers the debounce window, before any request exists.
      expect(searchThreadContent).not.toHaveBeenCalled()
      expect(palette.current().contentSearchPending).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(searchThreadContent).toHaveBeenCalled()
      expect(palette.current().contentSearchPending).toBe(true)

      await act(async () => {
        release([])
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(palette.current().contentSearchPending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears pending when a search fails', async () => {
    vi.useFakeTimers()
    try {
      const searchThreadContent = vi.fn<PaletteContentSearch>(
        async () => { throw new Error('runtime unavailable') }
      )
      const palette = await mountPalette({ searchThreadContent })
      await act(async () => {
        palette.current().setQuery('checkout')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(palette.current().contentSearchPending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not pending for queries that never reach deep search', async () => {
    vi.useFakeTimers()
    try {
      const palette = await mountPalette({ searchThreadContent: async () => [] })
      for (const query of ['x', '>terminal', '#media']) {
        await act(async () => {
          palette.current().setQuery(query)
        })
        expect(palette.current().contentSearchPending).toBe(false)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not run deep search for command or settings scopes', async () => {
    vi.useFakeTimers()
    try {
      const searchThreadContent = vi.fn<PaletteContentSearch>(async () => [])
      const palette = await mountPalette({ searchThreadContent })
      await act(async () => {
        palette.current().setQuery('>terminal')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(searchThreadContent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers to turn an unmatched query into a prompt instead of dead-ending', async () => {
    vi.useFakeTimers()
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers, searchThreadContent: async () => [] })
    await act(async () => {
      palette.current().setQuery('zzzz nothing matches this zzzz')
    })
    // The offer waits for deep search to settle, so it can never appear while
    // a conversation match might still arrive.
    expect(palette.current().groups).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    vi.useRealTimers()
    const api = palette.current()
    expect(api.results).toEqual([])
    const compose = (api.groups ?? []).find((group) => group.key === 'compose')
    expect(compose?.entries[0]?.id).toBe('compose:new-chat')

    await act(async () => {
      palette.current().activate(compose!.entries[0]!)
    })
    expect(handlers.compose).toHaveBeenCalledWith('zzzz nothing matches this zzzz')
  })

  it('never offers the compose fallback over a pending draft', async () => {
    vi.useFakeTimers()
    try {
      const palette = await mountPalette({
        sources: { hasComposerDraft: true },
        searchThreadContent: async () => []
      })
      await act(async () => {
        palette.current().setQuery('zzzz nothing matches this zzzz')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(palette.current().groups).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not offer the compose fallback when real results matched', async () => {
    const palette = await mountPalette()
    await act(async () => {
      palette.current().setQuery('billing')
    })
    const api = palette.current()
    expect(api.results.length).toBeGreaterThan(0)
    expect((api.groups ?? []).some((group) => group.key === 'compose')).toBe(false)
  })

  it('reports an unavailable target instead of navigating to a stale thread', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers })
    const stale: PaletteEntry = {
      id: 'thread:gone',
      source: 'thread',
      title: 'Gone',
      keywords: [],
      activation: { kind: 'thread', threadId: 'gone' }
    }
    await act(async () => {
      palette.current().activate(stale)
    })
    expect(handlers.thread).not.toHaveBeenCalled()
    expect(handlers.unavailable).toHaveBeenCalledTimes(1)
    expect(storage.getItem(PALETTE_RECENTS_STORAGE_KEY)).toBeNull()
  })

  it('switches the composer model from a model row', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers })
    await act(async () => {
      palette.current().setQuery('claude-sonnet-5')
    })
    const row = palette.current().results.find((entry) => entry.source === 'model')
    expect(row).toBeDefined()
    await act(async () => {
      palette.current().activate(row!)
    })
    expect(handlers['select-model']).toHaveBeenCalledWith('claude-sonnet-5', 'anthropic')
  })

  it('applies a conversation action to the active thread', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({
      handlers,
      // The action targets thr_a, which is present in the thread list.
      sources: { activeThreadId: 'thr_a' }
    })
    await act(async () => {
      palette.current().setQuery('pin')
    })
    const row = palette.current().results.find((entry) => entry.id === 'action:pin')
    expect(row).toBeDefined()
    await act(async () => {
      palette.current().activate(row!)
    })
    expect(handlers['thread-action']).toHaveBeenCalledWith('pin', 'thr_a')
  })

  it('reports unavailable when the action targets a thread that is gone', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers })
    const stale: PaletteEntry = {
      id: 'action:pin',
      source: 'action',
      title: 'Pin',
      keywords: [],
      activation: { kind: 'thread-action', action: 'pin', threadId: 'gone' }
    }
    await act(async () => {
      palette.current().activate(stale)
    })
    expect(handlers['thread-action']).not.toHaveBeenCalled()
    expect(handlers.unavailable).toHaveBeenCalledTimes(1)
  })

  it('leaves disabled entries inert', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers })
    const disabled: PaletteEntry = {
      id: 'route:write',
      source: 'route',
      title: 'Write',
      keywords: [],
      disabled: true,
      activation: { kind: 'route', route: 'write' }
    }
    await act(async () => {
      palette.current().activate(disabled)
    })
    expect(handlers.route).not.toHaveBeenCalled()
    expect(handlers.unavailable).not.toHaveBeenCalled()
  })

  it('records a recent only for an activation that resolved', async () => {
    const handlers = noopHandlers()
    const palette = await mountPalette({ handlers })
    const entry = palette.current().results.find(() => true)
      ?? (palette.current().groups ?? [])[0]?.entries[0]
    expect(entry).toBeDefined()
    await act(async () => {
      palette.current().activate(entry!)
    })
    const stored = JSON.parse(storage.getItem(PALETTE_RECENTS_STORAGE_KEY) ?? '{}')
    expect(stored.workspaces['/Users/demo/project'][0].id).toBe(entry!.id)
  })
})
