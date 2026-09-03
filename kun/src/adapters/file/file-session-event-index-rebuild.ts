import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { isSafeThreadId } from '../../contracts/thread-id.js'
import {
  EVENT_INDEX_BYTE_STEP,
  EVENT_INDEX_RECORD_BYTES,
  EVENT_INDEX_SEQ_STEP,
  encodeEventIndexEntry,
  eventIndexIsValid,
  eventIndexPaths,
  readEventIndexState,
  type FileSessionEventIndex
} from './file-session-event-index.js'
import { atomicWriteFile, renameFileWithRetry } from './atomic-write.js'
import { parseReplayEventRecord } from './file-session-jsonl.js'
import { listThreadDirs } from './file-session-usage-read.js'
import type { JsonlFileAccessCoordinator } from './jsonl-file-access.js'

/**
 * Byte/event budget per slice. The byte budget bounds disk I/O while the
 * event budget bounds parse cost; the shared maintenance lane also enforces
 * a 50ms wall-clock ceiling that matches `MAINTENANCE_SLICE_MAX_MS`.
 */
export const EVENT_INDEX_REBUILD_SLICE_MAX_BYTES = 2 * 1024 * 1024
export const EVENT_INDEX_REBUILD_SLICE_MAX_EVENTS = 4096
const DEFAULT_REBUILD_SLICE_MAX_MS = 50
const SCAN_CHUNK_BYTES = 64 * 1024

const RebuildStateSchema = z.object({
  version: z.literal(1),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  byteCursor: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  lastOffset: z.number().int().nonnegative()
}).strict()

type RebuildState = z.infer<typeof RebuildStateSchema>

const SweepStateSchema = z.object({
  version: z.literal(1),
  generation: z.number().int().nonnegative(),
  cursor: z.string().optional(),
  inProgress: z.string().optional(),
  inProgressSource: z.enum(['priority', 'sequential']).optional()
}).strict()

type SweepState = z.infer<typeof SweepStateSchema>

export type EventIndexRebuildStats = {
  slices: number
  published: number
  skippedValid: number
  abandoned: number
  eventsScanned: number
  bytesScanned: number
  lastError?: string
}

/**
 * Low-priority, resumable rebuild of `events-index.bin` for threads that
 * predate the sparse index or whose index was invalidated. It is driven one
 * bounded slice at a time from the shared maintenance lane; foreground reads
 * never wait for it and keep falling back to a byte-zero full scan.
 */
export class FileSessionEventIndexRebuild {
  private readonly priority = new Set<string>()
  private wake: (() => void) | undefined
  private sweepPromise: Promise<SweepState> | undefined
  private slices = 0
  private published = 0
  private skippedValid = 0
  private abandoned = 0
  private eventsScanned = 0
  private bytesScanned = 0
  private lastError: string | undefined

  constructor(private readonly options: {
    threadsDir: string
    eventsPathFor: (threadId: string) => string
    fileAccess: JsonlFileAccessCoordinator
    index: FileSessionEventIndex
    maxRecordBytes: number
    limits?: { maxBytes?: number; maxEvents?: number; maxMs?: number }
  }) {}

  /** Hint that a thread should be rebuilt first; fires the idle wake when set. */
  request(threadId: string): void {
    if (!isSafeThreadId(threadId)) return
    this.priority.add(threadId)
    this.wake?.()
  }

  setWake(wake: () => void): void {
    this.wake = wake
  }

  /**
   * Process at most one bounded unit of work. Returns `false` while any
   * thread remains partially rebuilt (retry soon) and `true` once the current
   * sweep generation has visited every thread directory.
   */
  async runSlice(): Promise<boolean> {
    this.slices += 1
    const startedAt = Date.now()
    try {
      const sweep = await this.readSweep()
      const threads = await listThreadDirs(this.options.threadsDir)

      for (;;) {
        if (Date.now() - startedAt >= this.maxMs()) {
          await this.saveSweep(sweep)
          return false
        }
        let target: string | undefined
        let source: 'priority' | 'sequential'
        if (sweep.inProgress) {
          target = sweep.inProgress
          source = sweep.inProgressSource ?? 'priority'
        } else {
          target = this.takePriority(threads)
          if (target) {
            source = 'priority'
          } else {
            target = nextAfter(threads, sweep.cursor)
            source = 'sequential'
          }
        }
        if (!target) {
          sweep.generation += 1
          sweep.cursor = undefined
          sweep.inProgress = undefined
          sweep.inProgressSource = undefined
          await this.saveSweep(sweep)
          return true
        }
        const outcome = await this.processThread(target, startedAt)
        if (outcome === 'pending') {
          sweep.inProgress = target
          sweep.inProgressSource = source
          await this.saveSweep(sweep)
          return false
        }
        sweep.inProgress = undefined
        sweep.inProgressSource = undefined
        if (source === 'sequential' && (!sweep.cursor || target > sweep.cursor)) {
          sweep.cursor = target
        }
        await this.saveSweep(sweep)
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  stats(): EventIndexRebuildStats {
    return {
      slices: this.slices,
      published: this.published,
      skippedValid: this.skippedValid,
      abandoned: this.abandoned,
      eventsScanned: this.eventsScanned,
      bytesScanned: this.bytesScanned,
      ...(this.lastError ? { lastError: this.lastError } : {})
    }
  }

  private maxMs(): number {
    return Math.max(1, Math.floor(this.options.limits?.maxMs ?? DEFAULT_REBUILD_SLICE_MAX_MS))
  }

  private maxBytes(): number {
    return Math.max(1, Math.floor(
      this.options.limits?.maxBytes ?? EVENT_INDEX_REBUILD_SLICE_MAX_BYTES
    ))
  }

  private maxEvents(): number {
    return Math.max(1, Math.floor(
      this.options.limits?.maxEvents ?? EVENT_INDEX_REBUILD_SLICE_MAX_EVENTS
    ))
  }

  private takePriority(threads: string[]): string | undefined {
    if (this.priority.size === 0) return undefined
    for (const id of [...this.priority]) {
      if (!threads.includes(id)) {
        this.priority.delete(id)
        continue
      }
      this.priority.delete(id)
      return id
    }
    return undefined
  }

  private async processThread(
    threadId: string,
    startedAt: number
  ): Promise<'pending' | 'done' | 'skipped'> {
    const eventsPath = this.options.eventsPathFor(threadId)
    const release = await this.options.fileAccess.acquireRead(eventsPath)
    try {
      const info = await stat(eventsPath).catch((error) =>
        (error as { code?: string }).code === 'ENOENT' ? null : Promise.reject(error)
      )
      if (!info || info.size === 0) {
        await this.discardStaging(eventsPath)
        if (info) this.abandoned += 1
        return 'done'
      }

      const existingBinBytes = await binBytes(eventsPath)
      if (eventIndexIsValid(await readEventIndexState(eventsPath), info, existingBinBytes)) {
        await this.discardStaging(eventsPath)
        this.skippedValid += 1
        return 'skipped'
      }

      const staging = await this.loadOrResetStaging(eventsPath, info)
      const result = await this.grind(eventsPath, staging, startedAt)
      if (!result.streamEnded) {
        await this.persistStaging(eventsPath, result.staging)
        return 'pending'
      }

      const after = await stat(eventsPath).catch(() => null)
      const identityChanged = !after || after.dev !== staging.dev || after.ino !== staging.ino
      if (identityChanged || result.staging.byteCursor < (after?.size ?? 0)) {
        await this.persistStaging(eventsPath, result.staging)
        return 'pending'
      }

      await this.publish(threadId, eventsPath, result.staging)
      return 'done'
    } finally {
      release()
    }
  }

  private async grind(
    eventsPath: string,
    staging: RebuildState,
    startedAt: number
  ): Promise<{ staging: RebuildState; streamEnded: boolean }> {
    const entries: Buffer[] = []
    let remainder = Buffer.alloc(0)
    let nextOffset = staging.byteCursor
    let scannedEvents = 0
    let scannedBytes = 0
    let streamEnded = false

    const stream = createReadStream(eventsPath, { start: staging.byteCursor, highWaterMark: SCAN_CHUNK_BYTES })
    for await (const chunk of stream) {
      remainder = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk])
      let newline = remainder.indexOf(0x0a)
      while (newline >= 0) {
        const line = remainder.subarray(0, newline)
        const recordOffset = nextOffset
        nextOffset += newline + 1
        remainder = remainder.subarray(newline + 1)
        scannedBytes += newline + 1
        scannedEvents += 1
        const seq = extractSeq(line, this.options.maxRecordBytes)
        if (seq !== null && seq >= staging.lastSeq) {
          const due = staging.entryCount === 0 ||
            seq - staging.lastSeq >= EVENT_INDEX_SEQ_STEP ||
            recordOffset - staging.lastOffset >= EVENT_INDEX_BYTE_STEP
          if (due) {
            entries.push(encodeEventIndexEntry(seq, recordOffset))
            staging.lastSeq = seq
            staging.lastOffset = recordOffset
            staging.entryCount += 1
          }
        }
        newline = remainder.indexOf(0x0a)
        if (scannedBytes >= this.maxBytes() ||
          scannedEvents >= this.maxEvents() ||
          (Date.now() - startedAt >= this.maxMs() && scannedEvents > 0)) {
          staging.byteCursor = nextOffset
          await this.appendEntries(eventsPath, entries)
          this.eventsScanned += scannedEvents
          this.bytesScanned += scannedBytes
          return { staging, streamEnded: false }
        }
      }
    }
    streamEnded = true
    staging.byteCursor = nextOffset
    await this.appendEntries(eventsPath, entries)
    this.eventsScanned += scannedEvents
    this.bytesScanned += scannedBytes
    return { staging, streamEnded }
  }

  private async appendEntries(eventsPath: string, entries: Buffer[]): Promise<void> {
    if (entries.length === 0) return
    const bin = eventIndexPaths(eventsPath).rebuildBin
    await mkdir(dirname(bin), { recursive: true, mode: 0o700 })
    await appendFile(bin, Buffer.concat(entries), { mode: 0o600 })
  }

  private async loadOrResetStaging(
    eventsPath: string,
    info: { dev: number; ino: number; size: number }
  ): Promise<RebuildState> {
    const paths = eventIndexPaths(eventsPath)
    const state = await readRebuildState(paths.rebuildState)
    const stagingBinBytes = await binBytes(eventsPath, paths.rebuildBin)
    const valid = state && state.dev === info.dev && state.ino === info.ino &&
      stagingBinBytes === state.entryCount * EVENT_INDEX_RECORD_BYTES
    if (valid) return state
    await this.discardStaging(eventsPath)
    return {
      version: 1,
      dev: info.dev,
      ino: info.ino,
      byteCursor: 0,
      entryCount: 0,
      lastSeq: 0,
      lastOffset: 0
    }
  }

  private async persistStaging(eventsPath: string, staging: RebuildState): Promise<void> {
    const paths = eventIndexPaths(eventsPath)
    await mkdir(dirname(paths.rebuildState), { recursive: true, mode: 0o700 })
    await atomicWriteFile(paths.rebuildState, JSON.stringify(staging))
  }

  private async discardStaging(eventsPath: string): Promise<void> {
    const paths = eventIndexPaths(eventsPath)
    await Promise.all([
      rm(paths.rebuildBin, { force: true }),
      rm(paths.rebuildState, { force: true })
    ])
  }

  private async publish(
    threadId: string,
    eventsPath: string,
    staging: RebuildState
  ): Promise<void> {
    const paths = eventIndexPaths(eventsPath)
    await mkdir(dirname(paths.bin), { recursive: true, mode: 0o700 })
    await renameFileWithRetry(paths.rebuildBin, paths.bin)
    const prior = await readEventIndexState(eventsPath)
    await atomicWriteFile(paths.state, JSON.stringify({
      version: 2,
      generation: (prior?.generation ?? 0) + 1,
      dev: staging.dev,
      ino: staging.ino,
      indexedBytes: staging.byteCursor,
      entryCount: staging.entryCount,
      lastIndexedSeq: staging.lastSeq,
      lastIndexedOffset: staging.lastOffset
    }))
    await rm(paths.rebuildState, { force: true }).catch(() => undefined)
    this.options.index.clearMemory(threadId)
    this.published += 1
  }

  private async readSweep(): Promise<SweepState> {
    if (!this.sweepPromise) {
      this.sweepPromise = readFile(this.sweepPath(), 'utf8')
        .then((text) => SweepStateSchema.parse(JSON.parse(text)))
        .catch(() => freshSweep())
    }
    return this.sweepPromise
  }

  private saveSweep(sweep: SweepState): Promise<void> {
    const saved = atomicWriteFile(this.sweepPath(), JSON.stringify(sweep)).then(() => undefined)
    this.sweepPromise = saved.then(() => sweep)
    return saved
  }

  private sweepPath(): string {
    return join(this.options.threadsDir, 'event-index-rebuild.sweep.json')
  }
}

function freshSweep(): SweepState {
  return { version: 1, generation: 0 }
}

function nextAfter(threads: string[], cursor: string | undefined): string | undefined {
  if (!cursor) return threads[0]
  return threads.find((id) => id > cursor)
}

function extractSeq(line: Buffer, maxRecordBytes: number): number | null {
  if (line.length === 0 || line.length > maxRecordBytes) return null
  const event = parseReplayEventRecord(line.toString('utf8'), maxRecordBytes)
  return event ? event.seq : null
}

async function readRebuildState(path: string): Promise<RebuildState | undefined> {
  try {
    const parsed = RebuildStateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function binBytes(eventsPath: string, explicitPath?: string): Promise<number> {
  const path = explicitPath ?? eventIndexPaths(eventsPath).bin
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 0
    throw error
  }
}
