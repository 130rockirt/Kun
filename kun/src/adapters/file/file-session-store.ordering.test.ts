import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../../domain/item.js'
import { FileSessionStore } from './file-session-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileSessionStore item ordering', () => {
  it('keeps an updated item in its original timeline slot after a cold reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-session-order-'))
    roots.push(root)
    const store = new FileSessionStore({ dataDir: root })
    const threadId = 'thread_order'
    const assistant = makeAssistantTextItem({
      id: 'assistant_1',
      turnId: 'turn_1',
      threadId,
      text: 'before',
      status: 'running',
      createdAt: '2026-07-28T00:00:00.000Z'
    })
    const tool = makeToolCallItem({
      id: 'tool_1',
      turnId: 'turn_1',
      threadId,
      callId: 'call_1',
      toolName: 'read',
      arguments: {}
    })

    await store.appendItem(threadId, assistant)
    await store.appendItem(threadId, tool)
    await store.appendItem(threadId, makeAssistantTextItem({
      id: assistant.id,
      turnId: assistant.turnId,
      threadId: assistant.threadId,
      text: 'before tool',
      status: 'completed',
      createdAt: assistant.createdAt
    }))
    store.clearThreadMemory(threadId)

    const reloaded = await store.loadItems(threadId)
    expect(reloaded.map((item) => item.id)).toEqual(['assistant_1', 'tool_1'])
    expect(reloaded[0]).toMatchObject({
      text: 'before tool',
      status: 'completed'
    })
  })

  it('atomically compacts repeated updates to the latest item state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-session-compact-'))
    roots.push(root)
    const store = new FileSessionStore({
      dataDir: root,
      itemHistoryCompactionMinBytes: 1
    })
    const threadId = 'thread_compact'
    for (let index = 0; index < 40; index += 1) {
      await store.appendItem(threadId, makeToolResultItem({
        id: 'result_1',
        threadId,
        turnId: 'turn_1',
        callId: 'call_1',
        toolName: 'bash',
        output: { text: `snapshot-${index}-${'x'.repeat(4_096)}` },
        status: index === 39 ? 'completed' : 'running'
      }))
    }
    const path = join(root, 'threads', threadId, 'messages.jsonl')
    const before = (await stat(path)).size

    const result = await store.compactItems(threadId, { force: true })
    const after = (await stat(path)).size
    store.clearThreadMemory(threadId)

    expect(result).toMatchObject({ compacted: true, itemCount: 1 })
    expect(after).toBeLessThan(before / 10)
    expect(await store.loadItems(threadId)).toMatchObject([
      { id: 'result_1', status: 'completed', output: { text: expect.stringContaining('snapshot-39') } }
    ])
    expect((await readFile(path, 'utf-8')).trim().split('\n')).toHaveLength(1)
  })

  it('serializes compaction with a queued append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-session-compact-race-'))
    roots.push(root)
    const store = new FileSessionStore({
      dataDir: root,
      itemHistoryCompactionMinBytes: 1
    })
    const threadId = 'thread_compact_race'
    const first = makeAssistantTextItem({
      id: 'assistant_1',
      threadId,
      turnId: 'turn_1',
      text: 'first'
    })
    const second = makeAssistantTextItem({
      id: 'assistant_2',
      threadId,
      turnId: 'turn_1',
      text: 'second'
    })
    await store.appendItem(threadId, first)

    await Promise.all([
      store.compactItems(threadId, { force: true }),
      store.appendItem(threadId, second)
    ])
    store.clearThreadMemory(threadId)

    expect((await store.loadItems(threadId)).map((item) => item.id))
      .toEqual(['assistant_1', 'assistant_2'])
  })

  it('preserves a malformed source file when compaction fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-session-compact-invalid-'))
    roots.push(root)
    const store = new FileSessionStore({
      dataDir: root,
      itemHistoryCompactionMinBytes: 1
    })
    const threadId = 'thread_compact_invalid'
    await store.appendItem(threadId, makeAssistantTextItem({
      id: 'assistant_1',
      threadId,
      turnId: 'turn_1',
      text: 'valid'
    }))
    const path = join(root, 'threads', threadId, 'messages.jsonl')
    await appendFile(path, '{broken-json\n')
    const before = await readFile(path, 'utf-8')

    await expect(store.compactItems(threadId, { force: true }))
      .rejects.toThrow('malformed record')
    expect(await readFile(path, 'utf-8')).toBe(before)
  })

  it('does not retain a Session item array that exceeds its byte admission limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-session-cache-budget-'))
    roots.push(root)
    const store = new FileSessionStore({
      dataDir: root,
      itemsCacheMaxBytes: 1_024
    })
    const threadId = 'thread_cache_budget'
    await store.appendItem(threadId, makeAssistantTextItem({
      id: 'assistant_large',
      threadId,
      turnId: 'turn_1',
      text: 'x'.repeat(4_096),
      status: 'completed'
    }))

    expect(await store.loadItems(threadId)).toHaveLength(1)
    expect(store.itemCacheStats()).toMatchObject({
      entries: 0,
      bytes: 0,
      maxBytes: 1_024
    })
  })
})
