import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  cacheEntriesToThreads,
  loadThreadListCache,
  saveThreadListCache,
  type CacheThreadEntry
} from './thread-list-cache'
import type { NormalizedThread } from '../agent/types'

const THREAD_LIST_CACHE_KEY = 'kun.sidebar.threadCache.v1'

function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size }
  }
}

function makeThread(overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id: 'thread-1',
    title: 'Example',
    mode: 'direct',
    model: 'deepseek-v4-pro',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('thread-list-cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips lean summary entries through browser storage', () => {
    const storage = makeStorage()
    vi.stubGlobal('localStorage', storage)
    const threads = [
      makeThread({ id: 'a', workspace: '/work/a', pinned: true, status: 'idle', relation: 'primary', planBuildRunId: 'run-1' }),
      makeThread({ id: 'b', workspace: '/work/b', archived: true })
    ]
    saveThreadListCache(threads)
    const loaded = loadThreadListCache()
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toMatchObject({
      id: 'a',
      workspace: '/work/a',
      pinned: true,
      status: 'idle',
      relation: 'primary',
      planBuildRunId: 'run-1',
      model: 'deepseek-v4-pro',
      mode: 'direct'
    })
    expect(loaded[1]).toMatchObject({ id: 'b', archived: true })
  })

  it('drops invalid payloads (wrong version or non-array threads)', () => {
    vi.stubGlobal('localStorage', makeStorage({
      [THREAD_LIST_CACHE_KEY]: JSON.stringify({ version: 999, threads: [{ id: 'x', title: 't', model: 'm', updatedAt: 'u' }] })
    }))
    expect(loadThreadListCache()).toEqual([])
  })

  it('tolerates corrupt JSON', () => {
    vi.stubGlobal('localStorage', makeStorage({ [THREAD_LIST_CACHE_KEY]: '{not-json' }))
    expect(loadThreadListCache()).toEqual([])
  })

  it('converts cache entries back into sidebar threads', () => {
    const entries: CacheThreadEntry[] = [{
      id: 'a',
      title: 'A',
      workspace: '/work',
      model: 'm',
      mode: 'direct',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      pinned: true
    }]
    const threads = cacheEntriesToThreads(entries)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      id: 'a',
      title: 'A',
      workspace: '/work',
      model: 'm',
      mode: 'direct',
      status: 'running',
      pinned: true
    })
  })
})
