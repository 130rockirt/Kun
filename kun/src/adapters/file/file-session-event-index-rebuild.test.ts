import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionEventIndex, eventIndexPaths } from './file-session-event-index.js'
import { FileSessionEventIndexRebuild } from './file-session-event-index-rebuild.js'
import { iterateRuntimeEventsJsonl } from './file-session-jsonl.js'
import { JsonlFileAccessCoordinator } from './jsonl-file-access.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function record(threadId: string, seq: number): string {
  return `${JSON.stringify({
    kind: 'heartbeat', seq, threadId, timestamp: '2026-09-03T00:00:00.000Z'
  })}\n`
}

async function writeEvents(threadDir: string, threadId: string, count: number): Promise<string> {
  const path = join(threadDir, 'events.jsonl')
  await mkdir(threadDir, { recursive: true, mode: 0o700 })
  await writeFile(path, '')
  for (let seq = 1; seq <= count; seq += 1) {
    await appendFile(path, record(threadId, seq))
  }
  return path
}

async function newRebuild(threadsDir: string, index: FileSessionEventIndex, limits: {
  maxBytes?: number
  maxEvents?: number
}): Promise<FileSessionEventIndexRebuild> {
  return new FileSessionEventIndexRebuild({
    threadsDir,
    eventsPathFor: (threadId) => join(threadsDir, threadId, 'events.jsonl'),
    fileAccess: new JsonlFileAccessCoordinator(),
    index,
    maxRecordBytes: 4 * 1024 * 1024,
    limits
  })
}

async function runToCompletion(rebuild: FileSessionEventIndexRebuild): Promise<void> {
  for (let index = 0; index < 2000; index += 1) {
    if (await rebuild.runSlice()) return
  }
  throw new Error('rebuild did not complete within slice budget')
}

describe('FileSessionEventIndexRebuild', () => {
  it('rebuilds a sparse index across slices and publishes atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-rebuild'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 600)

    const index = new FileSessionEventIndex()
    const rebuild = await newRebuild(threadsDir, index, { maxEvents: 100 })

    // Midway, the foreground read must still fall back safely.
    await rebuild.runSlice()
    expect(await index.startOffset(threadId, eventsPath, 590)).toBe(0)
    const fallbackEvents: number[] = []
    for await (const event of iterateRuntimeEventsJsonl(eventsPath, 590, 1024 * 1024, 0)) {
      fallbackEvents.push(event.seq)
    }
    expect(fallbackEvents).toEqual([591, 592, 593, 594, 595, 596, 597, 598, 599, 600])

    await runToCompletion(rebuild)

    const offset = await index.startOffset(threadId, eventsPath, 590)
    expect(offset).toBeGreaterThan(0)
    const events: number[] = []
    for await (const event of iterateRuntimeEventsJsonl(eventsPath, 590, 1024 * 1024, offset)) {
      events.push(event.seq)
    }
    expect(events).toEqual([591, 592, 593, 594, 595, 596, 597, 598, 599, 600])

    // Staging files are removed; the source log is untouched.
    const paths = eventIndexPaths(eventsPath)
    await expect(stat(paths.rebuildBin)).rejects.toThrow()
    await expect(stat(paths.rebuildState)).rejects.toThrow()
    await expect(stat(paths.bin)).resolves.toBeTruthy()
    await expect(stat(paths.state)).resolves.toBeTruthy()
    expect(await stat(eventsPath)).toBeTruthy()
  })

  it('resumes a partial rebuild after restart from the persisted cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-resume-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-resume'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 600)

    const index = new FileSessionEventIndex()
    const first = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await first.runSlice()

    const paths = eventIndexPaths(eventsPath)
    const persisted = JSON.parse(await readFile(paths.rebuildState, 'utf8')) as { byteCursor: number }
    expect(persisted.byteCursor).toBeGreaterThan(0)

    // Simulate a runtime restart with a fresh coordinator over the same files.
    const resumed = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await runToCompletion(resumed)

    expect(await index.startOffset(threadId, eventsPath, 590)).toBeGreaterThan(0)
  })

  it('discards staging and rebuilds when the source file identity changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-identity-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-identity'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 600)

    const index = new FileSessionEventIndex()
    const rebuild = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await rebuild.runSlice()

    // Replace events.jsonl with a shorter file (new inode).
    const replaced = join(threadDir, 'events.replacement.jsonl')
    await writeFile(replaced, '')
    for (let seq = 1; seq <= 40; seq += 1) await appendFile(replaced, record(threadId, seq))
    await rename(replaced, eventsPath)

    await runToCompletion(rebuild)

    // The new 40-event file must be indexed, not the replaced 600-event one.
    const offset = await index.startOffset(threadId, eventsPath, 30)
    const events: number[] = []
    for await (const event of iterateRuntimeEventsJsonl(eventsPath, 30, 1024 * 1024, offset)) {
      events.push(event.seq)
    }
    expect(events).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40])
  })

  it('keeps extending the index after a rebuild-time append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-append-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-append'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 600)

    const index = new FileSessionEventIndex()
    const rebuild = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await runToCompletion(rebuild)

    // Append one more event through the normal recordAppend path.
    await appendFile(eventsPath, record(threadId, 601))
    const info = await stat(eventsPath)
    await index.recordAppend({
      threadId,
      sourcePath: eventsPath,
      seq: 601,
      recordOffset: info.size - Buffer.byteLength(record(threadId, 601)),
      sourceSize: info.size,
      dev: info.dev,
      ino: info.ino
    })

    expect(await index.startOffset(threadId, eventsPath, 600)).toBeGreaterThan(0)
  })

  it('skips a thread that already has a valid index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-skip-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-skip'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 40)

    const index = new FileSessionEventIndex()
    // Build a valid index the normal way.
    for (let seq = 1; seq <= 40; seq += 1) {
      const recordBytes = Buffer.byteLength(record(threadId, seq))
      const info = await stat(eventsPath)
      await index.recordAppend({
        threadId,
        sourcePath: eventsPath,
        seq,
        recordOffset: info.size - recordBytes,
        sourceSize: info.size,
        dev: info.dev,
        ino: info.ino
      })
    }
    const binBefore = (await stat(eventIndexPaths(eventsPath).bin)).mtimeMs

    const rebuild = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await runToCompletion(rebuild)

    expect((await stat(eventIndexPaths(eventsPath).bin)).mtimeMs).toBe(binBefore)
    expect(rebuild.stats()).toMatchObject({ skippedValid: 1, published: 0 })
  })

  it('invalidating the index also removes in-progress staging files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-event-rebuild-invalidate-'))
    roots.push(root)
    const threadsDir = join(root, 'threads')
    const threadId = 'thread-invalidate'
    const threadDir = join(threadsDir, threadId)
    const eventsPath = await writeEvents(threadDir, threadId, 600)

    const index = new FileSessionEventIndex()
    const rebuild = await newRebuild(threadsDir, index, { maxEvents: 100 })
    await rebuild.runSlice()

    await index.invalidate(threadId, eventsPath)
    const paths = eventIndexPaths(eventsPath)
    await expect(stat(paths.rebuildBin)).rejects.toThrow()
    await expect(stat(paths.rebuildState)).rejects.toThrow()
  })
})
