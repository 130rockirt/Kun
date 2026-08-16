import { describe, expect, it, vi } from 'vitest'
import type { TurnItem } from '../../contracts/items.js'
import { createThreadRecord } from '../../domain/thread.js'
import { makeUserItem } from '../../domain/item.js'
import type { ThreadService } from '../../services/thread-service.js'
import {
  contentSearchThreads,
  snippetAroundMatch,
  THREAD_CONTENT_SEARCH_BUDGET_MS
} from './thread-content-search.js'

describe('contentSearchThreads', () => {
  it('returns one snippet per matching conversation, most recently updated first', async () => {
    const newer = createThreadRecord({
      id: 'thr_newer', title: 'Payment gateway', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    const older = createThreadRecord({
      id: 'thr_older', title: 'Docs rewrite', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    const none = createThreadRecord({
      id: 'thr_none', title: 'Nothing', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    const archived = createThreadRecord({
      id: 'thr_archived', title: 'Archived hit', workspace: '/tmp', model: 'deepseek-chat', status: 'archived'
    })
    newer.updatedAt = '2026-08-15T03:00:00.000Z'
    older.updatedAt = '2026-08-15T02:00:00.000Z'
    none.updatedAt = '2026-08-15T01:00:00.000Z'
    archived.updatedAt = '2026-08-15T04:00:00.000Z'
    const service = { list: async () => [none, archived, older, newer] } as unknown as ThreadService
    const sessionStore = {
      searchItemText: async (threadId: string): Promise<string | null> => {
        if (threadId === 'thr_newer') return 'Let us redesign the checkout flow end to end.'
        if (threadId === 'thr_older') return 'checkout must be faster'
        if (threadId === 'thr_archived') return 'checkout checkout checkout'
        return null
      }
    }
    const response = await contentSearchThreads(
      service,
      sessionStore,
      new Request('http://kun.local/v1/threads/content-search?q=checkout')
    )
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as {
      matches: Array<{ threadId: string; title: string; workspace: string; snippet: string }>
    }
    expect(body.matches.map((match) => match.threadId)).toEqual(['thr_newer', 'thr_older'])
    expect(body.matches[0]).toMatchObject({ title: 'Payment gateway', workspace: '/tmp' })
    expect(body.matches[0].snippet.toLowerCase()).toContain('checkout')
  })

  it('never drives the blocking loadItems path', async () => {
    const thread = createThreadRecord({
      id: 'thr_only', title: 'Only', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    const service = { list: async () => [thread] } as unknown as ThreadService
    const loadItems = vi.fn(async (): Promise<TurnItem[]> => [
      makeUserItem({ id: 'i0', turnId: 't0', threadId: 'thr_only', text: 'checkout' })
    ])
    const response = await contentSearchThreads(
      service,
      { loadItems } as unknown as Parameters<typeof contentSearchThreads>[1],
      new Request('http://kun.local/v1/threads/content-search?q=checkout')
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ matches: [] })
    expect(loadItems).not.toHaveBeenCalled()
  })

  it('searches every project and reports which one each match came from', async () => {
    const here = createThreadRecord({
      id: 'thr_here', title: 'This project', workspace: '/repo/app', model: 'deepseek-chat', status: 'idle'
    })
    const elsewhere = createThreadRecord({
      id: 'thr_elsewhere', title: 'Other project', workspace: '/repo/other', model: 'deepseek-chat', status: 'idle'
    })
    here.updatedAt = '2026-08-15T02:00:00.000Z'
    elsewhere.updatedAt = '2026-08-15T03:00:00.000Z'
    const service = { list: async () => [here, elsewhere] } as unknown as ThreadService
    const response = await contentSearchThreads(
      service,
      { searchItemText: async (): Promise<string | null> => 'checkout here' },
      new Request('http://kun.local/v1/threads/content-search?q=checkout')
    )
    const body = JSON.parse(response.body) as { matches: Array<{ threadId: string; workspace: string }> }
    expect(body.matches.map((match) => match.threadId)).toEqual(['thr_elsewhere', 'thr_here'])
    expect(body.matches.map((match) => match.workspace)).toEqual(['/repo/other', '/repo/app'])
  })

  it('stops scanning once the time budget is spent', async () => {
    const threads = Array.from({ length: 10 }, (_, index) => {
      const record = createThreadRecord({
        id: 'thr_' + index, title: 'T' + index, workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
      })
      record.updatedAt = '2026-08-15T0' + index + ':00:00.000Z'
      return record
    })
    const service = { list: async () => threads } as unknown as ThreadService
    let currentTime = 0
    const searchItemText = vi.fn(async (): Promise<string | null> => {
      currentTime = THREAD_CONTENT_SEARCH_BUDGET_MS + 1
      return 'checkout'
    })
    const response = await contentSearchThreads(
      service,
      { searchItemText },
      new Request('http://kun.local/v1/threads/content-search?q=checkout'),
      () => currentTime
    )
    expect((JSON.parse(response.body) as { matches: unknown[] }).matches).toHaveLength(1)
    expect(searchItemText).toHaveBeenCalledTimes(1)
  })

  it('returns when an individual store scan exceeds the wall-clock budget', async () => {
    vi.useFakeTimers()
    try {
      const thread = createThreadRecord({
        id: 'thr_hung', title: 'Hung', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
      })
      const service = { list: async () => [thread] } as unknown as ThreadService
      const searchItemText = vi.fn(() => new Promise<string | null>(() => undefined))
      const responsePromise = contentSearchThreads(
        service,
        { searchItemText },
        new Request('http://kun.local/v1/threads/content-search?q=checkout')
      )
      await vi.advanceTimersByTimeAsync(THREAD_CONTENT_SEARCH_BUDGET_MS)
      expect(JSON.parse((await responsePromise).body)).toEqual({ matches: [] })
      expect(searchItemText).toHaveBeenCalledWith(
        'thr_hung',
        'checkout',
        { deadlineAtMs: expect.any(Number) }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects empty and oversized queries with 400', async () => {
    const service = { list: async () => [] } as unknown as ThreadService
    const sessionStore = { searchItemText: async () => null }
    const empty = await contentSearchThreads(
      service, sessionStore, new Request('http://kun.local/v1/threads/content-search')
    )
    expect(empty.status).toBe(400)
    const oversized = await contentSearchThreads(
      service,
      sessionStore,
      new Request('http://kun.local/v1/threads/content-search?q=' + 'x'.repeat(257))
    )
    expect(oversized.status).toBe(400)
  })

  it('tolerates threads whose items cannot be scanned', async () => {
    const broken = createThreadRecord({
      id: 'thr_broken', title: 'Broken', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    const fine = createThreadRecord({
      id: 'thr_fine', title: 'Fine', workspace: '/tmp', model: 'deepseek-chat', status: 'idle'
    })
    broken.updatedAt = '2026-08-15T03:00:00.000Z'
    fine.updatedAt = '2026-08-15T02:00:00.000Z'
    const service = { list: async () => [broken, fine] } as unknown as ThreadService
    const response = await contentSearchThreads(
      service,
      {
        searchItemText: async (threadId: string): Promise<string | null> => {
          if (threadId === 'thr_broken') throw new Error('corrupt')
          return 'checkout once more'
        }
      },
      new Request('http://kun.local/v1/threads/content-search?q=checkout')
    )
    const body = JSON.parse(response.body) as { matches: Array<{ threadId: string }> }
    expect(body.matches.map((match) => match.threadId)).toEqual(['thr_fine'])
  })
})

describe('snippetAroundMatch', () => {
  it('windows the snippet around the first match and elides the edges', () => {
    const text = 'a'.repeat(300) + ' checkout ' + 'b'.repeat(300)
    const snippet = snippetAroundMatch(text, 'checkout')
    expect(snippet).toContain('checkout')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThan(180)
  })

  it('returns the head of the text when nothing matches', () => {
    expect(snippetAroundMatch('plain text without match', 'zzz')).toBe('plain text without match')
  })
})
