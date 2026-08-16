import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeToolResultItem, makeUserItem } from '../../domain/item.js'
import { FileSessionStore } from './file-session-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function newStore(options: { itemHistoryCompactionMinBytes?: number } = {}): Promise<{
  store: FileSessionStore
  root: string
  messagesPath: (threadId: string) => string
}> {
  const root = await mkdtemp(join(tmpdir(), 'kun-session-search-'))
  roots.push(root)
  return {
    store: new FileSessionStore({ dataDir: root, ...options }),
    root,
    messagesPath: (threadId) => join(root, 'threads', threadId, 'messages.jsonl')
  }
}

describe('FileSessionStore.searchItemText', () => {
  it('finds user and assistant text and returns the matching item text', async () => {
    const { store } = await newStore()
    const threadId = 'thread_search'
    await store.appendItem(threadId, makeUserItem({
      id: 'i1', turnId: 't1', threadId, text: 'Please rework the checkout flow.'
    }))
    await store.appendItem(threadId, makeAssistantTextItem({
      id: 'i2', turnId: 't1', threadId, text: 'Rewriting the billing module now.'
    }))

    await expect(store.searchItemText(threadId, 'checkout'))
      .resolves.toBe('Please rework the checkout flow.')
    await expect(store.searchItemText(threadId, 'BILLING'))
      .resolves.toBe('Rewriting the billing module now.')
    await expect(store.searchItemText(threadId, 'absent')).resolves.toBeNull()
  })

  it('ignores tool payloads so search never surfaces raw tool output', async () => {
    const { store } = await newStore()
    const threadId = 'thread_tools'
    await store.appendItem(threadId, makeToolResultItem({
      id: 'i1', turnId: 't1', threadId, callId: 'c1', toolName: 'read', output: { text: 'secret-token' }
    }))
    await expect(store.searchItemText(threadId, 'secret-token')).resolves.toBeNull()
  })

  it('does not match on record metadata that only looks like a hit', async () => {
    const { store } = await newStore()
    const threadId = 'thread_meta'
    await store.appendItem(threadId, makeUserItem({
      id: 'i1', turnId: 't1', threadId, text: 'unrelated body'
    }))
    // 'assistant_text' and the thread id appear in the raw JSON of every
    // record; only real item text may produce a match.
    await expect(store.searchItemText(threadId, 'user_message')).resolves.toBeNull()
    await expect(store.searchItemText(threadId, 'thread_meta')).resolves.toBeNull()
  })

  it('never schedules a rewrite the way loadItems does', async () => {
    // A one-byte threshold makes every log "oversized".
    const { store, messagesPath } = await newStore({ itemHistoryCompactionMinBytes: 1 })
    const threadId = 'thread_big'
    await store.appendItem(threadId, makeUserItem({
      id: 'i1', turnId: 't1', threadId, text: 'first checkout note'
    }))
    await store.appendItem(threadId, makeUserItem({
      id: 'i1', turnId: 't1', threadId, text: 'second checkout note'
    }))
    await store.resetMemory()
    const path = messagesPath(threadId)
    const before = (await stat(path)).size

    // Searching leaves the log untouched, and queues no deferred rewrite.
    await expect(store.searchItemText(threadId, 'checkout')).resolves.toContain('checkout')
    await store.flushScheduledCompaction(threadId)
    expect((await stat(path)).size).toBe(before)

    // The blocking path schedules the rewrite; this documents the contrast.
    await store.loadItems(threadId)
    await store.flushScheduledCompaction(threadId)
    expect((await stat(path)).size).toBeLessThan(before)
  })

  it('reads the tail when a log exceeds the scan window', async () => {
    const { store } = await newStore()
    const threadId = 'thread_tail'
    const filler = 'x'.repeat(4_000)
    await store.appendItem(threadId, makeUserItem({
      id: 'oldest', turnId: 't0', threadId, text: 'oldest-marker ' + filler
    }))
    for (let index = 0; index < 40; index += 1) {
      await store.appendItem(threadId, makeUserItem({
        id: 'mid_' + index, turnId: 't1', threadId, text: 'filler ' + filler
      }))
    }
    await store.appendItem(threadId, makeUserItem({
      id: 'recent', turnId: 't2', threadId, text: 'recent-marker at the end'
    }))
    await store.resetMemory()

    await expect(store.searchItemText(threadId, 'recent-marker', { maxBytes: 8_000 }))
      .resolves.toBe('recent-marker at the end')
    // Content older than the tail window is outside the bound by design.
    await expect(store.searchItemText(threadId, 'oldest-marker', { maxBytes: 8_000 }))
      .resolves.toBeNull()
    // Widening the window brings it back into range.
    await expect(store.searchItemText(threadId, 'oldest-marker', { maxBytes: 4_000_000 }))
      .resolves.toContain('oldest-marker')
  })

  it('returns null for unsafe thread ids and empty queries', async () => {
    const { store } = await newStore()
    await expect(store.searchItemText('../escape', 'anything')).resolves.toBeNull()
    await expect(store.searchItemText('thread_ok', '')).resolves.toBeNull()
  })

  it('does not start or return a scan after its deadline', async () => {
    const { store } = await newStore()
    const threadId = 'thread_expired'
    await store.appendItem(threadId, makeUserItem({
      id: 'i1', turnId: 't1', threadId, text: 'checkout after deadline'
    }))
    await expect(store.searchItemText(threadId, 'checkout', { deadlineAtMs: Date.now() - 1 }))
      .resolves.toBeNull()
  })
})
