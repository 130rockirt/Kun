import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAssistantTextItem } from '../../domain/item.js'
import { createThreadRecord } from '../../domain/thread.js'
import { appendTurnItem, createTurnRecord } from '../../domain/turn.js'
import { stripThreadItemBodies } from './hybrid-thread-projection.js'
import { HybridThreadDocumentRepository } from './hybrid-thread-documents.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('HybridThreadDocumentRepository cache budget', () => {
  it('hydrates an oversized record without retaining it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-cache-budget-'))
    roots.push(root)
    const threadId = 'thread_cache_budget'
    const dir = join(root, 'threads', threadId)
    await mkdir(dir, { recursive: true })
    const item = makeAssistantTextItem({
      id: 'assistant_large',
      threadId,
      turnId: 'turn_1',
      text: 'x'.repeat(4_096),
      status: 'completed'
    })
    const thread = {
      ...createThreadRecord({
        id: threadId,
        title: 'Cache budget',
        workspace: '/tmp/workspace',
        model: 'test'
      }),
      turns: [appendTurnItem(createTurnRecord({
        id: 'turn_1',
        threadId,
        prompt: 'test',
        status: 'completed'
      }), item)]
    }
    await writeFile(join(dir, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata',
      version: 1,
      timestamp: thread.updatedAt,
      thread: stripThreadItemBodies(thread)
    })}\n`)
    await writeFile(join(dir, 'messages.jsonl'), `${JSON.stringify(item)}\n`)
    const documents = new HybridThreadDocumentRepository(root, { cacheMaxBytes: 1_024 })

    expect(await documents.readThread(threadId)).toMatchObject({
      id: threadId,
      turns: [{ items: [{ id: item.id, text: 'x'.repeat(4_096) }] }]
    })
    expect(documents.cacheStats()).toEqual({
      entries: 0,
      bytes: 0,
      maxBytes: 1_024
    })
  })
})
