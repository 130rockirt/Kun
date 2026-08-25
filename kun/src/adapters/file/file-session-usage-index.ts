import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { UsageEvent } from '../../contracts/events.js'
import { emptyUsageSnapshot, UsageSnapshotSchema, type UsageSnapshot } from '../../contracts/usage.js'
import { diffUsage, hasUsage } from '../../domain/usage.js'
import type {
  SessionLatestUsageSnapshot,
  SessionUsageQueryOptions,
  SessionUsageRecord
} from '../../ports/session-store.js'
import { atomicWriteFile } from './atomic-write.js'

const DEFAULT_INDEX_MAX_RECORD_BYTES = 4 * 1024 * 1024
const USAGE_INDEX_STATE_VERSION = 1

type UsageIndexCorruptionKind = 'invalid-json' | 'invalid-schema' | 'record-too-large'

class UsageIndexCorruptionError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    readonly kind: UsageIndexCorruptionKind,
    detail: string
  ) {
    super(`usage index ${kind} at ${path}:${line}: ${detail}`)
    this.name = 'UsageIndexCorruptionError'
  }
}

/**
 * Per-thread usage index row. Delta rows carry the differential usage that
 * was computed at append time, so a ranged read never replays events.jsonl.
 */
const UsageIndexRowSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta'),
    seq: z.number().int().nonnegative(),
    timestamp: z.string(),
    turnId: z.string().optional(),
    model: z.string().optional(),
    providerId: z.string().optional(),
    usage: UsageSnapshotSchema,
    cumulative: UsageSnapshotSchema
  }),
  z.object({
    type: z.literal('checkpoint'),
    date: z.string(),
    seq: z.number().int().nonnegative(),
    timestamp: z.string(),
    cumulative: UsageSnapshotSchema
  })
])
export type UsageIndexRow = z.infer<typeof UsageIndexRowSchema>

export type UsageIndexState = {
  lastSeq: number
  cumulative: UsageSnapshot
  /** UTC day (YYYY-MM-DD) of the latest indexed event; drives checkpoints. */
  lastDay: string
}

type UsageIndexMetadata = {
  indexedBytes: number
  days: Record<string, number>
  monotonicTimestamps: boolean
  lastTimestamp: string
  sha256: string
}

type UsageIndexSidecar = UsageIndexMetadata & {
  version: typeof USAGE_INDEX_STATE_VERSION
  state: UsageIndexState
}

type UsageIndexSnapshot = {
  state: UsageIndexState
  metadata: UsageIndexMetadata
}

type UsageEventSource = (threadId: string, sinceSeq: number) => AsyncIterable<UsageEvent>

export function emptyUsageIndexState(): UsageIndexState {
  return { lastSeq: 0, cumulative: emptyUsageSnapshot(), lastDay: '' }
}

/**
 * Append-only per-thread usage index (`usage-index.jsonl`). The sidecar is a
 * derived cursor, never a source of truth: events.jsonl remains authoritative.
 */
export class FileSessionUsageIndex {
  private readonly states = new Map<string, UsageIndexState>()
  private readonly ensureQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly threadsDir: string,
    private readonly eventsSince: UsageEventSource
  ) {}

  /** Record one usage event inside the caller's per-thread write queue. */
  async recordUsage(threadId: string, event: UsageEvent): Promise<void> {
    const snapshot = await this.ensureCurrent(threadId)
    const state = snapshot.state
    if (event.seq < state.lastSeq) return
    if (event.seq === state.lastSeq) {
      if (!sameUsageSnapshot(event.usage, state.cumulative)) {
        console.error(`[kun] usage index cumulative mismatch for ${threadId} at seq ${event.seq}; rebuilding from events.jsonl`)
        await this.rebuildFromEvents(threadId)
      }
      return
    }
    const next = appendRowsForEvent(event, state)
    await this.appendRows(threadId, next.rows, next.state, snapshot.metadata)
    this.states.set(threadId, next.state)
  }

  async loadUsageRecords(
    threadId: string,
    options: SessionUsageQueryOptions = {}
  ): Promise<SessionUsageRecord[]> {
    const snapshot = await this.ensureCurrent(threadId)
    const fromMs = options.fromInclusive ? Date.parse(options.fromInclusive) : undefined
    const toMs = options.toExclusive ? Date.parse(options.toExclusive) : undefined
    if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) return []
    const start = canUseSparseStart(snapshot.metadata, fromMs)
      ? offsetForDay(snapshot.metadata.days, utcDayFromMs(fromMs!))
      : 0
    const records: SessionUsageRecord[] = []
    await this.streamRows(threadId, start, (row) => {
      if (row.type !== 'delta') return
      const atMs = Date.parse(row.timestamp)
      if (!Number.isFinite(atMs)) return
      if (fromMs !== undefined && atMs < fromMs) return
      if (toMs !== undefined && atMs >= toMs) {
        if (snapshot.metadata.monotonicTimestamps) return 'stop'
        return
      }
      if (!hasUsage(row.usage)) return
      records.push({
        threadId,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.providerId ? { providerId: row.providerId } : {}),
        completedAt: row.timestamp,
        usage: row.usage
      })
    })
    return records
  }

  async loadLatestUsageSnapshot(threadId: string): Promise<SessionLatestUsageSnapshot | null> {
    const { state } = await this.ensureCurrent(threadId)
    if (state.lastSeq <= 0) return null
    return { threadId, seq: state.lastSeq, usage: state.cumulative }
  }

  /** Drop in-memory state; the on-disk index and sidecar remain derived data. */
  clearThreadMemory(threadId: string): void {
    this.states.delete(threadId)
    this.ensureQueues.delete(threadId)
  }

  resetMemory(): void {
    this.states.clear()
    this.ensureQueues.clear()
  }

  private indexDir(threadId: string): string {
    return join(this.threadsDir, threadId)
  }

  private indexPath(threadId: string): string {
    return join(this.indexDir(threadId), 'usage-index.jsonl')
  }

  private statePath(threadId: string): string {
    return join(this.indexDir(threadId), 'usage-index.state.json')
  }

  /** Serialize readers, rebuilds, and tail repairs for one thread. */
  private ensureCurrent(threadId: string): Promise<UsageIndexSnapshot> {
    const queued = this.ensureQueues.get(threadId) ?? Promise.resolve()
    const run = queued.catch(() => undefined).then(() => this.ensureCurrentUnlocked(threadId))
    const guard = run.then(() => undefined, () => undefined)
    this.ensureQueues.set(threadId, guard)
    return run.finally(() => {
      if (this.ensureQueues.get(threadId) === guard) this.ensureQueues.delete(threadId)
    })
  }

  private async ensureCurrentUnlocked(threadId: string): Promise<UsageIndexSnapshot> {
    let snapshot: UsageIndexSnapshot
    try {
      snapshot = await this.readIndexSnapshot(threadId)
    } catch (error) {
      if (!(error instanceof UsageIndexCorruptionError)) throw error
      console.warn(
        `[kun] rebuilding corrupt usage index for ${threadId} from events.jsonl ` +
        `(line ${error.line}, ${error.kind})`
      )
      return this.rebuildFromEvents(threadId)
    }

    const backfilled = await this.buildRowsFromEvents(threadId, snapshot.state)
    if (backfilled.rows.length === 0) {
      this.states.set(threadId, snapshot.state)
      return snapshot
    }
    const rows = serializeRows(backfilled.rows)
    const nextMetadata = metadataAfterAppend(snapshot.metadata, backfilled.rows, `${rows}\n`)
    await this.appendRowsAndState(threadId, rows, backfilled.state, nextMetadata)
    const current = { state: backfilled.state, metadata: nextMetadata }
    this.states.set(threadId, current.state)
    return current
  }

  private async buildRowsFromEvents(
    threadId: string,
    initial: UsageIndexState
  ): Promise<{ rows: UsageIndexRow[]; state: UsageIndexState }> {
    const rows: UsageIndexRow[] = []
    let state = initial
    for await (const event of this.eventsSince(threadId, initial.lastSeq)) {
      const appended = appendRowsForEvent(event, state)
      rows.push(...appended.rows)
      state = appended.state
    }
    return { rows, state }
  }

  private async rebuildFromEvents(threadId: string): Promise<UsageIndexSnapshot> {
    const rebuilt = await this.buildRowsFromEvents(threadId, emptyUsageIndexState())
    const metadata = metadataFromRows(rebuilt.rows)
    await this.replaceRowsAndState(threadId, rebuilt.rows, rebuilt.state, metadata)
    this.states.set(threadId, rebuilt.state)
    return { state: rebuilt.state, metadata }
  }

  private async appendRows(
    threadId: string,
    rows: UsageIndexRow[],
    state: UsageIndexState,
    metadata: UsageIndexMetadata
  ): Promise<void> {
    if (rows.length === 0) return
    const serialized = serializeRows(rows)
    const nextMetadata = metadataAfterAppend(metadata, rows, `${serialized}\n`)
    await this.appendRowsAndState(threadId, serialized, state, nextMetadata)
  }

  private async appendRowsAndState(
    threadId: string,
    serialized: string,
    state: UsageIndexState,
    metadata: UsageIndexMetadata
  ): Promise<void> {
    await mkdir(this.indexDir(threadId), { recursive: true, mode: 0o700 })
    await appendFile(this.indexPath(threadId), `${serialized}\n`, { encoding: 'utf-8', mode: 0o600 })
    const completeMetadata = { ...metadata, sha256: await sha256File(this.indexPath(threadId)) }
    await writeSidecar(this.statePath(threadId), { ...completeMetadata, state, version: USAGE_INDEX_STATE_VERSION })
  }

  private async replaceRowsAndState(
    threadId: string,
    rows: UsageIndexRow[],
    state: UsageIndexState,
    metadata: UsageIndexMetadata
  ): Promise<void> {
    await atomicWriteFile(this.indexPath(threadId), rows.length > 0 ? `${serializeRows(rows)}\n` : '', {
      allowDirectWriteFallback: false
    })
    const completeMetadata = { ...metadata, sha256: await sha256File(this.indexPath(threadId)) }
    await writeSidecar(this.statePath(threadId), { ...completeMetadata, state, version: USAGE_INDEX_STATE_VERSION })
  }

  private async readIndexSnapshot(threadId: string): Promise<UsageIndexSnapshot> {
    const path = this.indexPath(threadId)
    let fileBytes = 0
    try {
      fileBytes = (await stat(path)).size
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        const empty = { state: emptyUsageIndexState(), metadata: emptyMetadata() }
        return empty
      }
      throw error
    }

    const sidecar = await readSidecar(this.statePath(threadId))
    if (sidecar && sidecar.indexedBytes > fileBytes) {
      throw new UsageIndexCorruptionError(path, 0, 'invalid-schema', 'sidecar points past truncated index')
    }
    if (sidecar && sidecar.indexedBytes <= fileBytes && sidecar.sha256) {
      if (await sha256File(path, sidecar.indexedBytes) !== sidecar.sha256) {
        throw new UsageIndexCorruptionError(path, 0, 'invalid-schema', 'sidecar prefix hash does not match index')
      }
    }
    if (sidecar && sidecar.indexedBytes === fileBytes && sidecar.sha256) {
      if (await sha256File(path) !== sidecar.sha256) {
        throw new UsageIndexCorruptionError(path, 0, 'invalid-schema', 'sidecar hash does not match index')
      }
      return { state: sidecar.state, metadata: sidecar }
    }

    // A missing/older sidecar is upgraded by one bounded full validation pass.
    // A sidecar behind the file only parses the appended tail.
    const start = sidecar?.indexedBytes ?? 0
    const parsed = await readRows(path, start)
    if (parsed.incompleteTrailingRecord) {
      throw new UsageIndexCorruptionError(path, parsed.line + 1, 'invalid-json', 'unterminated record')
    }
    const metadata = sidecar && start > 0
      ? metadataAfterAppend(sidecar, parsed.rows, parsed.serialized)
      : metadataFromRows(parsed.rows)
    const state = sidecar && start > 0 ? stateFromRows(parsed.rows, sidecar.state) : stateFromRows(parsed.rows)
    const snapshot = { state, metadata }
    const completeMetadata = { ...metadata, sha256: await sha256File(path) }
    await writeSidecar(this.statePath(threadId), { ...completeMetadata, state, version: USAGE_INDEX_STATE_VERSION })
    return snapshot
  }

  private async streamRows(
    threadId: string,
    start: number,
    onRow: (row: UsageIndexRow) => void | 'stop'
  ): Promise<void> {
    const path = this.indexPath(threadId)
    let remainder = ''
    try {
      const stream = createReadStream(path, { encoding: 'utf-8', start, highWaterMark: 64 * 1024 })
      for await (const chunk of stream) {
        remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        let newline = remainder.indexOf('\n')
        while (newline >= 0) {
          const record = remainder.slice(0, newline)
          remainder = remainder.slice(newline + 1)
          const result = onRow(parseUsageIndexRow(record, { path, line: 0 }))
          if (result === 'stop') {
            stream.destroy()
            return
          }
          newline = remainder.indexOf('\n')
        }
        if (Buffer.byteLength(remainder, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) {
          throw new UsageIndexCorruptionError(path, 0, 'record-too-large', 'record exceeds limit')
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
  }
}

export function parseUsageIndexRow(
  line: string,
  context: { path?: string; line?: number } = {}
): UsageIndexRow {
  const path = context.path ?? 'usage-index.jsonl'
  const lineNumber = context.line ?? 0
  if (Buffer.byteLength(line, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) {
    throw new UsageIndexCorruptionError(path, lineNumber, 'record-too-large', 'record exceeds limit')
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new UsageIndexCorruptionError(path, lineNumber, 'invalid-json', 'cannot parse JSON')
  }
  const parsed = UsageIndexRowSchema.safeParse(value)
  if (!parsed.success) {
    throw new UsageIndexCorruptionError(path, lineNumber, 'invalid-schema', 'does not match usage index schema')
  }
  return parsed.data
}

function appendRowsForEvent(
  event: UsageEvent,
  state: UsageIndexState
): { rows: UsageIndexRow[]; state: UsageIndexState } {
  if (event.seq <= state.lastSeq) return { rows: [], state }
  const day = utcDayOf(event.timestamp)
  const rows: UsageIndexRow[] = []
  if (state.lastSeq > 0 && day && day !== state.lastDay) {
    rows.push({
      type: 'checkpoint',
      date: state.lastDay,
      seq: state.lastSeq,
      timestamp: state.lastDay,
      cumulative: state.cumulative
    })
  }
  rows.push({
    type: 'delta',
    seq: event.seq,
    timestamp: event.timestamp,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    usage: diffUsage(event.usage, state.cumulative),
    cumulative: event.usage
  })
  return {
    rows,
    state: {
      lastSeq: event.seq,
      cumulative: event.usage,
      lastDay: day || state.lastDay
    }
  }
}

function stateFromRows(rows: UsageIndexRow[], initial: UsageIndexState = emptyUsageIndexState()): UsageIndexState {
  let state = initial
  for (const row of rows) {
    if (row.type === 'delta' && row.seq > state.lastSeq) {
      state = {
        lastSeq: row.seq,
        cumulative: row.cumulative,
        lastDay: utcDayOf(row.timestamp) || state.lastDay
      }
    } else if (row.type === 'checkpoint' && row.seq > state.lastSeq) {
      state = { lastSeq: row.seq, cumulative: row.cumulative, lastDay: row.date || state.lastDay }
    }
  }
  return state
}

function emptyMetadata(): UsageIndexMetadata {
  return { indexedBytes: 0, days: {}, monotonicTimestamps: true, lastTimestamp: '', sha256: '' }
}

function metadataFromRows(rows: UsageIndexRow[]): UsageIndexMetadata {
  let metadata = emptyMetadata()
  let offset = 0
  for (const row of rows) {
    const serialized = `${JSON.stringify(row)}\n`
    metadata = metadataAfterAppend(metadata, [row], serialized, offset)
    offset += Buffer.byteLength(serialized, 'utf-8')
  }
  return metadata
}

function metadataAfterAppend(
  metadata: UsageIndexMetadata,
  rows: UsageIndexRow[],
  serialized: string,
  startOffset = metadata.indexedBytes
): UsageIndexMetadata {
  const days = { ...metadata.days }
  let monotonicTimestamps = metadata.monotonicTimestamps
  let lastTimestamp = metadata.lastTimestamp
  let offset = startOffset
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`
    if (row.type === 'delta') {
      const day = utcDayOf(row.timestamp)
      if (day && days[day] === undefined) days[day] = offset
      const currentMs = Date.parse(row.timestamp)
      const previousMs = Date.parse(lastTimestamp)
      if (!Number.isFinite(currentMs) || (lastTimestamp && (!Number.isFinite(previousMs) || currentMs < previousMs))) {
        monotonicTimestamps = false
      }
      lastTimestamp = row.timestamp
    }
    offset += Buffer.byteLength(line, 'utf-8')
  }
  return {
    indexedBytes: startOffset + Buffer.byteLength(serialized, 'utf-8'),
    days,
    monotonicTimestamps,
    lastTimestamp,
    sha256: ''
  }
}

function sameUsageSnapshot(left: UsageSnapshot, right: UsageSnapshot): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))
}

function serializeRows(rows: UsageIndexRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

function utcDayOf(timestamp: string): string {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function canUseSparseStart(metadata: UsageIndexMetadata, fromMs: number | undefined): boolean {
  return fromMs !== undefined && metadata.monotonicTimestamps && Object.keys(metadata.days).length > 0
}

function offsetForDay(days: Record<string, number>, day: string): number {
  let best = 0
  for (const [candidate, offset] of Object.entries(days)) {
    if (candidate <= day && offset >= best) best = offset
  }
  return best
}

async function readRows(path: string, start: number): Promise<{
  rows: UsageIndexRow[]
  serialized: string
  incompleteTrailingRecord: boolean
  line: number
}> {
  const rows: UsageIndexRow[] = []
  let serialized = ''
  let remainder = ''
  let line = 0
  const stream = createReadStream(path, { encoding: 'utf-8', start, highWaterMark: 64 * 1024 })
  for await (const chunk of stream) {
    remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    let newline = remainder.indexOf('\n')
    while (newline >= 0) {
      const record = remainder.slice(0, newline)
      remainder = remainder.slice(newline + 1)
      const full = `${record}\n`
      rows.push(parseUsageIndexRow(record, { path, line: line + 1 }))
      serialized += full
      line += 1
      newline = remainder.indexOf('\n')
    }
    if (Buffer.byteLength(remainder, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) {
      throw new UsageIndexCorruptionError(path, line + 1, 'record-too-large', 'record exceeds limit')
    }
  }
  return { rows, serialized, incompleteTrailingRecord: remainder.length > 0, line }
}

async function readSidecar(path: string): Promise<UsageIndexSidecar | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
  try {
    const value = JSON.parse(raw) as UsageIndexSidecar
    if (
      value.version !== USAGE_INDEX_STATE_VERSION ||
      !Number.isSafeInteger(value.indexedBytes) || value.indexedBytes < 0 ||
      !value.state || !Number.isSafeInteger(value.state.lastSeq) ||
      !UsageSnapshotSchema.safeParse(value.state.cumulative).success ||
      typeof value.state.lastDay !== 'string' || typeof value.days !== 'object' ||
      Object.values(value.days).some((offset) => !Number.isSafeInteger(offset) || offset < 0) ||
      (value.sha256 !== undefined && typeof value.sha256 !== 'string')
    ) return null
    return value
  } catch {
    return null
  }
}

async function sha256File(path: string, bytes?: number): Promise<string> {
  const hash = createHash('sha256')
  if (bytes === 0) return hash.digest('hex')
  const stream = createReadStream(path, { start: 0, end: bytes === undefined ? undefined : bytes - 1 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function writeSidecar(path: string, state: UsageIndexSidecar): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(state)}\n`, { allowDirectWriteFallback: false })
}
