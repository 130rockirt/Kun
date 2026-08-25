import { appendFile, mkdir } from 'node:fs/promises'
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
 * was computed at append time, so a ranged read never has to replay the
 * events.jsonl backlog to derive cumulative diffs.
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
  /** UTC day (YYYY-MM-DD) of the latest indexed event; drives checkpoint rows. */
  lastDay: string
}

type UsageIndexSnapshot = {
  rows: UsageIndexRow[]
  state: UsageIndexState
  incompleteTrailingRecord: boolean
}

type UsageEventSource = (threadId: string, sinceSeq: number) => AsyncIterable<UsageEvent>

export function emptyUsageIndexState(): UsageIndexState {
  return { lastSeq: 0, cumulative: emptyUsageSnapshot(), lastDay: '' }
}

/**
 * Append-only per-thread usage index (`usage-index.jsonl`). events.jsonl stays
 * the source of truth. A healthy index is backfilled from the event tail; an
 * unterminated EOF tail is ignored until a later rewrite; any malformed
 * newline-terminated record triggers a full atomic rebuild from seq 0.
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
    await this.appendRows(threadId, next.rows)
    this.states.set(threadId, next.state)
  }

  async loadUsageRecords(
    threadId: string,
    options: SessionUsageQueryOptions = {}
  ): Promise<SessionUsageRecord[]> {
    const { rows } = await this.ensureCurrent(threadId)
    const fromMs = options.fromInclusive ? Date.parse(options.fromInclusive) : undefined
    const toMs = options.toExclusive ? Date.parse(options.toExclusive) : undefined
    const records: SessionUsageRecord[] = []
    for (const row of rows) {
      if (row.type !== 'delta' || !hasUsage(row.usage)) continue
      const atMs = Date.parse(row.timestamp)
      if (!Number.isFinite(atMs)) continue
      if (fromMs !== undefined && atMs < fromMs) continue
      if (toMs !== undefined && atMs >= toMs) continue
      records.push({
        threadId,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.providerId ? { providerId: row.providerId } : {}),
        completedAt: row.timestamp,
        usage: row.usage
      })
    }
    return records
  }

  async loadLatestUsageSnapshot(threadId: string): Promise<SessionLatestUsageSnapshot | null> {
    const { state } = await this.ensureCurrent(threadId)
    if (state.lastSeq <= 0) return null
    return { threadId, seq: state.lastSeq, usage: state.cumulative }
  }

  /** Drop in-memory state; the on-disk index is derived data and stays. */
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
      const rebuilt = await this.buildRowsFromEvents(threadId, emptyUsageIndexState())
      await this.replaceRows(threadId, rebuilt.rows)
      this.states.set(threadId, rebuilt.state)
      return { ...rebuilt, incompleteTrailingRecord: false }
    }

    const backfilled = await this.buildRowsFromEvents(threadId, snapshot.state)
    if (backfilled.rows.length === 0) {
      if (snapshot.incompleteTrailingRecord) {
        await this.replaceRows(threadId, snapshot.rows)
        snapshot = { ...snapshot, incompleteTrailingRecord: false }
      }
      this.states.set(threadId, snapshot.state)
      return snapshot
    }
    const rows = [...snapshot.rows, ...backfilled.rows]
    if (snapshot.incompleteTrailingRecord) {
      await this.replaceRows(threadId, rows)
    } else {
      await this.appendRows(threadId, backfilled.rows)
    }
    const current = { rows, state: backfilled.state, incompleteTrailingRecord: false }
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

  private async rebuildFromEvents(threadId: string): Promise<void> {
    const rebuilt = await this.buildRowsFromEvents(threadId, emptyUsageIndexState())
    await this.replaceRows(threadId, rebuilt.rows)
    this.states.set(threadId, rebuilt.state)
  }

  private async appendRows(threadId: string, rows: UsageIndexRow[]): Promise<void> {
    if (rows.length === 0) return
    await mkdir(this.indexDir(threadId), { recursive: true, mode: 0o700 })
    await appendFile(this.indexPath(threadId), `${serializeRows(rows)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
  }

  private async replaceRows(threadId: string, rows: UsageIndexRow[]): Promise<void> {
    await atomicWriteFile(
      this.indexPath(threadId),
      rows.length > 0 ? `${serializeRows(rows)}\n` : '',
      { allowDirectWriteFallback: false }
    )
  }

  private async readIndexSnapshot(threadId: string): Promise<UsageIndexSnapshot> {
    const path = this.indexPath(threadId)
    const rows: UsageIndexRow[] = []
    let remainder = ''
    let overflowedTrailingRecord = false
    let line = 0
    try {
      const stream = createReadStream(path, { encoding: 'utf-8', highWaterMark: 64 * 1024 })
      for await (const chunk of stream) {
        let input = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        if (overflowedTrailingRecord) {
          const newline = input.indexOf('\n')
          if (newline < 0) continue
          throw new UsageIndexCorruptionError(path, line + 1, 'record-too-large', 'record exceeds limit')
        }
        remainder += input
        let newline = remainder.indexOf('\n')
        while (newline >= 0) {
          const record = remainder.slice(0, newline)
          remainder = remainder.slice(newline + 1)
          line += 1
          rows.push(parseUsageIndexRow(record, { path, line }))
          newline = remainder.indexOf('\n')
        }
        if (Buffer.byteLength(remainder, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) {
          // Do not retain an unbounded in-flight tail. If it is eventually
          // newline-terminated, the next chunk marks it corrupt; EOF ignores it.
          remainder = ''
          overflowedTrailingRecord = true
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return { rows: [], state: emptyUsageIndexState(), incompleteTrailingRecord: false }
      }
      throw error
    }
    return {
      rows,
      state: stateFromRows(rows),
      incompleteTrailingRecord: overflowedTrailingRecord || remainder.length > 0
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

function stateFromRows(rows: UsageIndexRow[]): UsageIndexState {
  let state = emptyUsageIndexState()
  for (const row of rows) {
    if (row.type === 'delta' && row.seq > state.lastSeq) {
      state = {
        lastSeq: row.seq,
        cumulative: row.cumulative,
        lastDay: utcDayOf(row.timestamp) || state.lastDay
      }
    } else if (row.type === 'checkpoint' && row.seq > state.lastSeq) {
      state = {
        lastSeq: row.seq,
        cumulative: row.cumulative,
        lastDay: row.date || state.lastDay
      }
    }
  }
  return state
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
