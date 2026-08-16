import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeBrowserStorageItem } from '../lib/browser-storage'
import type { PaletteRecentIdentity } from './palette-model'
import {
  PALETTE_RECENTS_BOUND,
  PALETTE_RECENTS_SCOPE_BOUND,
  PALETTE_RECENTS_STORAGE_KEY,
  normalizeStoredPaletteRecents,
  readPaletteRecents,
  recordPaletteRecent
} from './palette-recents'

const SCOPE_A = '/Users/demo/project'
const SCOPE_B = '/Users/demo/other'

function recent(source: PaletteRecentIdentity['source'], id: string): PaletteRecentIdentity {
  return { source, id }
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

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeStoredPaletteRecents', () => {
  it('yields an empty registry for absent, unparsable, or unversioned values', () => {
    expect(normalizeStoredPaletteRecents(null)).toEqual({ version: 2, workspaces: {} })
    expect(normalizeStoredPaletteRecents(undefined)).toEqual({ version: 2, workspaces: {} })
    expect(normalizeStoredPaletteRecents('garbage')).toEqual({ version: 2, workspaces: {} })
    expect(normalizeStoredPaletteRecents({ version: 9, workspaces: {} })).toEqual({
      version: 2,
      workspaces: {}
    })
    expect(normalizeStoredPaletteRecents({ version: 1 })).toEqual({ version: 2, workspaces: {} })
  })

  it('drops invalid identities and duplicates and enforces the retention bound', () => {
    const value = {
      version: 1,
      workspaces: {
        [SCOPE_A]: [
          recent('route', 'route:chat'),
          { source: 'unknown', id: 'route:x' },
          { source: 'route', id: '' },
          42,
          recent('route', 'route:chat'),
          ...Array.from({ length: PALETTE_RECENTS_BOUND + 5 }, (_, index) =>
            recent('thread', 'thread:' + index)
          )
        ]
      }
    }
    const normalized = normalizeStoredPaletteRecents(value)
    expect(normalized.workspaces[SCOPE_A]).toHaveLength(PALETTE_RECENTS_BOUND)
    expect(normalized.workspaces[SCOPE_A][0]).toMatchObject(recent('route', 'route:chat'))
    expect(normalized.workspaces[SCOPE_A][0]).not.toEqual(
      normalized.workspaces[SCOPE_A][1]
    )
  })
})

describe('recordPaletteRecent', () => {
  it('records the most recent selection first and moves duplicates to the front', () => {
    recordPaletteRecent(SCOPE_A, recent('route', 'route:chat'))
    const after = recordPaletteRecent(SCOPE_A, recent('settings', 'settings:providers'))
    expect(after).toEqual([
      recent('settings', 'settings:providers'),
      recent('route', 'route:chat')
    ])

    const deduped = recordPaletteRecent(SCOPE_A, recent('route', 'route:chat'))
    expect(deduped).toEqual([
      recent('route', 'route:chat'),
      recent('settings', 'settings:providers')
    ])
  })

  it('keeps recents workspace-scoped', () => {
    recordPaletteRecent(SCOPE_A, recent('route', 'route:chat'))
    expect(readPaletteRecents(SCOPE_A)).toEqual([recent('route', 'route:chat')])
    expect(readPaletteRecents(SCOPE_B)).toEqual([])
  })

  it('retains only the newest entries up to the bound', () => {
    for (let index = 0; index < PALETTE_RECENTS_BOUND + 6; index += 1) {
      recordPaletteRecent(SCOPE_A, recent('thread', 'thread:' + index))
    }
    const stored = readPaletteRecents(SCOPE_A)
    expect(stored).toHaveLength(PALETTE_RECENTS_BOUND)
    expect(stored[0].id).toBe('thread:' + (PALETTE_RECENTS_BOUND + 5))
    expect(stored.some((entry) => entry.id === 'thread:0')).toBe(false)
  })

  it('bounds the number of stored workspace scopes, evicting the oldest', () => {
    for (let index = 0; index < PALETTE_RECENTS_SCOPE_BOUND + 5; index += 1) {
      recordPaletteRecent('/scope/' + index, recent('route', 'route:chat'))
    }
    const stored = JSON.parse(
      localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY) ?? '{}'
    ) as { workspaces: Record<string, unknown> }
    const scopes = Object.keys(stored.workspaces)
    expect(scopes).toHaveLength(PALETTE_RECENTS_SCOPE_BOUND)
    // The five oldest scopes were dropped; the newest survived.
    expect(scopes).not.toContain('/scope/0')
    expect(scopes).toContain('/scope/' + (PALETTE_RECENTS_SCOPE_BOUND + 4))
  })

  it('keeps a re-used scope alive by refreshing its position', () => {
    recordPaletteRecent(SCOPE_A, recent('route', 'route:chat'))
    for (let index = 0; index < PALETTE_RECENTS_SCOPE_BOUND - 1; index += 1) {
      recordPaletteRecent('/filler/' + index, recent('route', 'route:chat'))
    }
    // Touching the oldest scope moves it to the front of the eviction order.
    recordPaletteRecent(SCOPE_A, recent('route', 'route:write'))
    recordPaletteRecent('/filler/overflow', recent('route', 'route:chat'))
    expect(readPaletteRecents(SCOPE_A).map((entry) => entry.id)).toEqual([
      'route:write', 'route:chat'
    ])
  })

  it('ranks a frequently used entry above a merely newer one', () => {
    const day = 24 * 60 * 60 * 1000
    const base = 1_800_000_000_000
    // Used often, but not today.
    for (let index = 0; index < 6; index += 1) {
      recordPaletteRecent(SCOPE_A, recent('route', 'route:write'), base + index)
    }
    // Used once, just now. Pure recency would put this first.
    recordPaletteRecent(SCOPE_A, recent('route', 'route:design'), base + day)

    expect(readPaletteRecents(SCOPE_A, base + day).map((entry) => entry.id))
      .toEqual(['route:write', 'route:design'])
  })

  it('lets an old habit decay below a fresh one', () => {
    const base = 1_800_000_000_000
    const longAfter = base + 120 * 24 * 60 * 60 * 1000
    for (let index = 0; index < 6; index += 1) {
      recordPaletteRecent(SCOPE_A, recent('route', 'route:write'), base + index)
    }
    recordPaletteRecent(SCOPE_A, recent('route', 'route:design'), longAfter)

    expect(readPaletteRecents(SCOPE_A, longAfter).map((entry) => entry.id))
      .toEqual(['route:design', 'route:write'])
  })

  it('migrates a version 1 payload without reshuffling its order', () => {
    writeBrowserStorageItem(PALETTE_RECENTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      workspaces: {
        [SCOPE_A]: [
          recent('route', 'route:write'),
          recent('route', 'route:design'),
          recent('settings', 'settings:providers')
        ]
      }
    }))
    expect(readPaletteRecents(SCOPE_A).map((entry) => entry.id))
      .toEqual(['route:write', 'route:design', 'settings:providers'])
  })

  it('falls back to an empty list when stored values are unparsable', () => {
    writeBrowserStorageItem(PALETTE_RECENTS_STORAGE_KEY, '{not json')
    expect(readPaletteRecents(SCOPE_A)).toEqual([])
  })
})
