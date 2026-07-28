import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeToolCallItem } from '../../domain/item.js'
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
})
