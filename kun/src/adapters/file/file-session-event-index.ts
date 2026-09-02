import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from './atomic-write.js'

export const EVENT_INDEX_RECORD_BYTES = 16
export const EVENT_INDEX_SEQ_STEP = 256
export const EVENT_INDEX_BYTE_STEP = 1024 * 1024

const EventIndexStateSchema = z.object({
  version: z.literal(1),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  indexedBytes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  lastIndexedSeq: z.number().int().nonnegative(),
  lastIndexedOffset: z.number().int().nonnegative()
}).strict()

type EventIndexState = z.infer<typeof EventIndexStateSchema>

export type EventIndexStats = {
  seeks: number
  fallbacks: number
  appendedEntries: number
  lastStartOffset: number
}

export class FileSessionEventIndex {
  private readonly stateCache = new Map<string, EventIndexState>()
  private seeks = 0
  private fallbacks = 0
  private appendedEntries = 0
  private lastStartOffset = 0

  async recordAppend(input: {
    threadId: string
    sourcePath: string
    seq: number
    recordOffset: number
    sourceSize: number
    dev: number
    ino: number
  }): Promise<void> {
    let state = this.stateCache.get(input.threadId)
    if (!state) state = await this.readState(input.threadId, input.sourcePath)
    const validState = state && state.dev === input.dev && state.ino === input.ino &&
      state.indexedBytes <= input.recordOffset && state.lastIndexedOffset <= input.recordOffset &&
      state.lastIndexedSeq <= input.seq ? state : undefined
    const due = !validState || input.seq - validState.lastIndexedSeq >= EVENT_INDEX_SEQ_STEP ||
      input.recordOffset - validState.lastIndexedOffset >= EVENT_INDEX_BYTE_STEP
    if (!due) return

    const indexPath = eventIndexPath(input.sourcePath)
    const entry = encodeEntry(input.seq, input.recordOffset)
    await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 })
    if (validState) await appendFile(indexPath, entry, { mode: 0o600 })
    else await writeFile(indexPath, entry, { mode: 0o600 })
    const next: EventIndexState = {
      version: 1,
      dev: input.dev,
      ino: input.ino,
      indexedBytes: input.sourceSize,
      entryCount: validState ? validState.entryCount + 1 : 1,
      lastIndexedSeq: input.seq,
      lastIndexedOffset: input.recordOffset
    }
    await atomicWriteFile(eventIndexStatePath(input.sourcePath), JSON.stringify(next))
    this.stateCache.set(input.threadId, next)
    this.appendedEntries += 1
  }

  async startOffset(threadId: string, sourcePath: string, sinceSeq: number): Promise<number> {
    if (sinceSeq <= 0) return 0
    try {
      const [source, state, bytes] = await Promise.all([
        stat(sourcePath),
        this.readState(threadId, sourcePath),
        readFile(eventIndexPath(sourcePath))
      ])
      if (!state || state.dev !== source.dev || state.ino !== source.ino ||
        state.indexedBytes > source.size || state.entryCount <= 0 ||
        bytes.length < state.entryCount * EVENT_INDEX_RECORD_BYTES) {
        this.fallbacks += 1
        return 0
      }
      const view = bytes.subarray(0, state.entryCount * EVENT_INDEX_RECORD_BYTES)
      const offset = indexedOffset(view, sinceSeq, source.size)
      if (offset === null) {
        this.fallbacks += 1
        return 0
      }
      this.seeks += 1
      this.lastStartOffset = offset
      return offset
    } catch {
      this.fallbacks += 1
      return 0
    }
  }

  async invalidate(threadId: string, sourcePath: string): Promise<void> {
    this.stateCache.delete(threadId)
    await Promise.all([
      rm(eventIndexPath(sourcePath), { force: true }),
      rm(eventIndexStatePath(sourcePath), { force: true })
    ])
  }

  clearMemory(threadId?: string): void {
    if (threadId) this.stateCache.delete(threadId)
    else this.stateCache.clear()
  }

  stats(): EventIndexStats {
    return {
      seeks: this.seeks,
      fallbacks: this.fallbacks,
      appendedEntries: this.appendedEntries,
      lastStartOffset: this.lastStartOffset
    }
  }

  private async readState(threadId: string, sourcePath: string): Promise<EventIndexState | undefined> {
    const cached = this.stateCache.get(threadId)
    if (cached) return cached
    try {
      const parsed = EventIndexStateSchema.safeParse(
        JSON.parse(await readFile(eventIndexStatePath(sourcePath), 'utf8'))
      )
      if (!parsed.success) return undefined
      this.stateCache.set(threadId, parsed.data)
      return parsed.data
    } catch {
      return undefined
    }
  }
}

function eventIndexPath(sourcePath: string): string {
  return join(dirname(sourcePath), 'events-index.bin')
}

function eventIndexStatePath(sourcePath: string): string {
  return join(dirname(sourcePath), 'events-index.state.json')
}

function encodeEntry(seq: number, offset: number): Buffer {
  const entry = Buffer.allocUnsafe(EVENT_INDEX_RECORD_BYTES)
  entry.writeBigUInt64LE(BigInt(seq), 0)
  entry.writeBigUInt64LE(BigInt(offset), 8)
  return entry
}

function indexedOffset(bytes: Buffer, sinceSeq: number, sourceSize: number): number | null {
  const entries = bytes.length / EVENT_INDEX_RECORD_BYTES
  let low = 0
  let high = entries - 1
  let match = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const seq = Number(bytes.readBigUInt64LE(middle * EVENT_INDEX_RECORD_BYTES))
    if (!Number.isSafeInteger(seq)) return null
    if (seq <= sinceSeq) {
      match = middle
      low = middle + 1
    } else high = middle - 1
  }
  if (match < 0) return 0
  const offset = Number(bytes.readBigUInt64LE(match * EVENT_INDEX_RECORD_BYTES + 8))
  return Number.isSafeInteger(offset) && offset >= 0 && offset < sourceSize ? offset : null
}
