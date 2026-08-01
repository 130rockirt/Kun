import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  activeDesignThreadForWorkspace,
  designDocKey,
  designDocRefForThreadId,
  emptyDesignThreadRegistry,
  forgetDesignThread,
  isDesignThreadId,
  markDesignThread,
  normalizeDesignThreadRegistry,
  readDesignThreadRegistry,
  replaceDesignThreadsForDocument,
  saveDesignThreadRegistry,
  splitDesignDocKey
} from './design-thread-registry'

class MemoryStorage implements BrowserStorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function thread(id: string, workspace = '/Users/zxy/project'): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-06-01T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace
  }
}

describe('design-thread-registry', () => {
  it('saves and restores design thread records by workspace and design document', () => {
    const storage = new MemoryStorage()
    const registry = markDesignThread(
      '/Users/zxy/project',
      'login',
      'thread-design-1',
      emptyDesignThreadRegistry()
    )
    saveDesignThreadRegistry(registry, storage)

    const restored = readDesignThreadRegistry(storage)

    expect(isDesignThreadId('thread-design-1', restored)).toBe(true)
    expect(
      activeDesignThreadForWorkspace(
        '/Users/zxy/project',
        'login',
        [thread('thread-design-1')],
        restored
      )?.id
    ).toBe('thread-design-1')
  })

  it('recognizes legacy design assistant thread records', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'kun.design-assistant.threadRegistry.v1',
      JSON.stringify({ '/Users/zxy/project': 'thread-legacy-design' })
    )

    const restored = readDesignThreadRegistry(storage)

    expect(isDesignThreadId('thread-legacy-design', restored)).toBe(true)
    expect(
      activeDesignThreadForWorkspace(
        '/Users/zxy/project',
        '',
        [thread('thread-legacy-design')],
        restored
      )?.id
    ).toBe('thread-legacy-design')
    expect(storage.getItem('kun.design-assistant.threadRegistry.v1')).toBeNull()
  })

  it('migrates a valid legacy binding when the current registry JSON is corrupt', () => {
    const storage = new MemoryStorage()
    storage.setItem('kun.design.threadRegistry.v1', '{not valid json')
    storage.setItem(
      'kun.design-assistant.threadRegistry.v1',
      JSON.stringify({ '/Users/zxy/project': 'thread-legacy-design' })
    )

    const restored = readDesignThreadRegistry(storage)

    expect(isDesignThreadId('thread-legacy-design', restored)).toBe(true)
    expect(restored.workspaces['/Users/zxy/project']).toEqual({
      activeThreadId: 'thread-legacy-design',
      threadIds: ['thread-legacy-design']
    })
    expect(storage.getItem('kun.design-assistant.threadRegistry.v1')).toBeNull()
    expect(() => JSON.parse(storage.getItem('kun.design.threadRegistry.v1') ?? '')).not.toThrow()
  })

  it('does not resurrect a consumed legacy thread after the migrated record is cleared', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      'kun.design-assistant.threadRegistry.v1',
      JSON.stringify({ '/Users/zxy/project': 'thread-legacy-design' })
    )

    const migrated = readDesignThreadRegistry(storage)
    saveDesignThreadRegistry(forgetDesignThread('thread-legacy-design', migrated), storage)

    expect(isDesignThreadId('thread-legacy-design', readDesignThreadRegistry(storage))).toBe(false)
  })

  it('keeps design documents in the same workspace scoped to separate conversations', () => {
    const registry = markDesignThread(
      '/Users/zxy/project',
      'settings',
      'thread-settings',
      markDesignThread(
        '/Users/zxy/project',
        'login',
        'thread-login',
        emptyDesignThreadRegistry()
      )
    )

    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'login')]?.threadIds)
      .toEqual(['thread-login'])
    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'settings')]?.threadIds)
      .toEqual(['thread-settings'])
  })

  it('moves a design thread between documents instead of sharing it across whiteboards', () => {
    const registry = markDesignThread(
      '/Users/zxy/project',
      'settings',
      'thread-design',
      markDesignThread(
        '/Users/zxy/project',
        'login',
        'thread-design',
        emptyDesignThreadRegistry()
      )
    )

    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'login')]).toBeUndefined()
    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'settings')]?.threadIds)
      .toEqual(['thread-design'])
  })

  it('normalizes duplicate historical thread ownership to a single document scope', () => {
    const registry = normalizeDesignThreadRegistry({
      workspaces: {
        [designDocKey('/Users/zxy/project', 'login')]: {
          activeThreadId: 'thread-design',
          threadIds: ['thread-design']
        },
        [designDocKey('/Users/zxy/project', 'settings')]: {
          activeThreadId: 'thread-design',
          threadIds: ['thread-design']
        }
      }
    })

    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'login')]?.threadIds)
      .toEqual(['thread-design'])
    expect(registry.workspaces[designDocKey('/Users/zxy/project', 'settings')]).toBeUndefined()
  })

  it('does not let stale legacy workspace records steal an existing document-scoped thread', () => {
    const storage = new MemoryStorage()
    saveDesignThreadRegistry(
      markDesignThread('/Users/zxy/project', 'login', 'thread-design', emptyDesignThreadRegistry()),
      storage
    )
    storage.setItem(
      'kun.design-assistant.threadRegistry.v1',
      JSON.stringify({ '/Users/zxy/project': 'thread-design' })
    )

    const restored = readDesignThreadRegistry(storage)

    expect(restored.workspaces[designDocKey('/Users/zxy/project', 'login')]?.threadIds)
      .toEqual(['thread-design'])
    expect(activeDesignThreadForWorkspace(
      '/Users/zxy/project',
      '',
      [thread('thread-design')],
      restored
    )).toBeNull()
  })

  it('resolves a thread id back to its design document directory scope', () => {
    const registry = markDesignThread(
      '/Users/zxy/project',
      'login',
      'thread-login',
      emptyDesignThreadRegistry()
    )
    const key = designDocKey('/Users/zxy/project', 'login')

    expect(splitDesignDocKey(key)).toEqual({ workspaceRoot: '/Users/zxy/project', docId: 'login' })
    expect(designDocRefForThreadId(' thread-login ', registry)).toEqual({
      workspaceRoot: '/Users/zxy/project',
      docId: 'login'
    })
  })

  it('forgets deleted design threads across scopes and falls back to the next remembered thread', () => {
    const registry = markDesignThread(
      '/Users/zxy/project',
      'login',
      'thread-newer',
      markDesignThread(
        '/Users/zxy/project',
        'login',
        'thread-older',
        markDesignThread(
          '/Users/zxy/project',
          'settings',
          'thread-newer',
          emptyDesignThreadRegistry()
        )
      )
    )

    const next = forgetDesignThread('thread-newer', registry)

    expect(isDesignThreadId('thread-newer', next)).toBe(false)
    expect(next.workspaces[designDocKey('/Users/zxy/project', 'settings')]).toBeUndefined()
    expect(next.workspaces[designDocKey('/Users/zxy/project', 'login')]?.activeThreadId)
      .toBe('thread-older')
    expect(next.workspaces[designDocKey('/Users/zxy/project', 'login')]?.threadIds)
      .toEqual(['thread-older'])
  })

  it('replaces one document thread set without disturbing another document', () => {
    const registry = markDesignThread(
      '/Users/zxy/project',
      'settings',
      'thread-settings',
      markDesignThread(
        '/Users/zxy/project',
        'login',
        'thread-login-new',
        markDesignThread(
          '/Users/zxy/project',
          'login',
          'thread-login-old',
          emptyDesignThreadRegistry()
        )
      )
    )

    const retained = replaceDesignThreadsForDocument(
      '/Users/zxy/project',
      'login',
      ['thread-login-old'],
      'thread-login-old',
      registry
    )

    expect(retained.workspaces[designDocKey('/Users/zxy/project', 'login')]).toEqual({
      activeThreadId: 'thread-login-old',
      threadIds: ['thread-login-old']
    })
    expect(retained.workspaces[designDocKey('/Users/zxy/project', 'settings')]).toEqual({
      activeThreadId: 'thread-settings',
      threadIds: ['thread-settings']
    })
    expect(
      replaceDesignThreadsForDocument('/Users/zxy/project', 'login', [], null, retained)
        .workspaces[designDocKey('/Users/zxy/project', 'login')]
    ).toBeUndefined()
  })
})
