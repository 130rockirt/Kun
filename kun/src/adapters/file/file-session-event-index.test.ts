import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionEventIndex } from './file-session-event-index.js'
import { iterateRuntimeEventsJsonl } from './file-session-jsonl.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileSessionEventIndex', () => {
  it('seeks near the tail while JSONL remains authoritative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-index-'))
    roots.push(root)
    const threadId = 'thread-indexed'
    const sourcePath = join(root, 'events.jsonl')
    const index = new FileSessionEventIndex()
    await writeFile(sourcePath, '')
    for (let seq = 1; seq <= 600; seq += 1) {
      const record = `${JSON.stringify({
        kind: 'heartbeat', seq, threadId, timestamp: '2026-09-03T00:00:00.000Z'
      })}\n`
      await appendFile(sourcePath, record)
      const info = await stat(sourcePath)
      await index.recordAppend({
        threadId,
        sourcePath,
        seq,
        recordOffset: info.size - Buffer.byteLength(record),
        sourceSize: info.size,
        dev: info.dev,
        ino: info.ino
      })
    }

    const offset = await index.startOffset(threadId, sourcePath, 590)
    expect(offset).toBeGreaterThan(0)
    const events = []
    for await (const event of iterateRuntimeEventsJsonl(sourcePath, 590, 1024 * 1024, offset)) {
      events.push(event.seq)
    }
    expect(events).toEqual([591, 592, 593, 594, 595, 596, 597, 598, 599, 600])
  })

  it('falls back safely for corrupt state and removes only sidecars on invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-index-corrupt-'))
    roots.push(root)
    const threadId = 'thread-corrupt'
    const sourcePath = join(root, 'events.jsonl')
    const record = `${JSON.stringify({
      kind: 'heartbeat', seq: 1, threadId, timestamp: '2026-09-03T00:00:00.000Z'
    })}\n`
    await writeFile(sourcePath, record)
    const info = await stat(sourcePath)
    const index = new FileSessionEventIndex()
    await index.recordAppend({
      threadId, sourcePath, seq: 1, recordOffset: 0,
      sourceSize: info.size, dev: info.dev, ino: info.ino
    })
    await writeFile(join(root, 'events-index.state.json'), '{broken')
    index.clearMemory(threadId)

    await expect(index.startOffset(threadId, sourcePath, 1)).resolves.toBe(0)
    await index.invalidate(threadId, sourcePath)
    expect(await readFile(sourcePath, 'utf8')).toBe(record)
    await expect(stat(join(root, 'events-index.bin'))).rejects.toThrow()
  })
})
