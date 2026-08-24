import { appendFile, mkdir, rename } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { UsageEvent } from '../../contracts/events.js'
import { emptyUsageSnapshot, UsageSnapshotSchema, type UsageSnapshot } from '../../contracts/usage.js'
import { diffUsage, hasUsage } from '../../domain/usage.js'
import type {
  SessionLatestUsageSnapshot,
  SessionUsageQueryOptions,
  SessionUsageRecord
} from '../../ports/session-store.js'

const DEFAULT_INDEX_MAX_RECORD_BYTES = 4 * 1024 * 1024

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

type UsageEventSource = (threadId: string, sinceSeq: number) => AsyncIterable<UsageEvent>

export function emptyUsageIndexState(): UsageIndexState {
  return { lastSeq: 0, cumulative: emptyUsageSnapshot(), lastDay: '' }
}

/**
 * Append-only per-thread usage index (`usage-index.jsonl`). events.jsonl
 * stays the source of truth; the index is derived data that self-heals from
 * the event tail when it lags, and rebuilds from seq 0 when its own log is
 * unusable. Ranged usage queries read this small file instead of replaying
 * the whole event history.
 */
export class FileSessionUsageIndex {
  private readonly states = new Map<string, UsageIndexState>()
  private readonly ensureQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly threadsDir: string,
    private readonly eventsSince: UsageEventSource
  ) {}

  /**
   * Record one usage event. Must run inside the caller's per-thread write
   * queue so appends never interleave.
   */
  async recordUsage(threadId: string, event: UsageEvent): Promise<void> {
    await this.ensureCurrent(threadId)
    const state = this.states.get(threadId) ?? emptyUsageIndexState()
    // Out-of-order or duplicate event: already covered by the indexed
    // cumulative snapshot, so only refresh the in-memory high-water mark.
    if (event.seq <= state.lastSeq) {
      this.states.set(threadId, {
        lastSeq: state.lastSeq,
        cumulative: event.usage,
        lastDay: utcDayOf(event.timestamp) || state.lastDay
      })
      return
    }
    const day = utcDayOf(event.timestamp)
    const delta = diffUsage(event.usage, state.cumulative)
    const lines: string[] = []
    if (state.lastSeq > 0 && day && day !== state.lastDay) {
      lines.push(JSON.stringify({
        type: 'checkpoint',
        date: state.lastDay,
        seq: state.lastSeq,
        timestamp: state.lastDay,
        cumulative: state.cumulative
      } satisfies UsageIndexRow))
    }
    lines.push(JSON.stringify({
      type: 'delta',
      seq: event.seq,
      timestamp: event.timestamp,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.providerId ? { providerId: event.providerId } : {}),
      usage: delta,
      cumulative: event.usage
    } satisfies UsageIndexRow))
    if (lines.length > 0) {
      await mkdir(this.indexDir(threadId), { recursive: true, mode: 0o700 })
      await appendFile(this.indexPath(threadId), `${lines.join('\n')}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      })
    }
    this.states.set(threadId, {
      lastSeq: Math.max(state.lastSeq, event.seq),
      cumulative: event.usage,
      lastDay: day || state.lastDay
    })
  }

  async loadUsageRecords(
    threadId: string,
    options: SessionUsageQueryOptions = {}
  ): Promise<SessionUsageRecord[]> {
    await this.ensureCurrent(threadId)
    const rows = await this.readIndexRows(threadId)
    const fromMs = options.fromInclusive ? Date.parse(options.fromInclusive) : undefined
    const toMs = options.toExclusive ? Date.parse(options.toExclusive) : undefined
    const records: SessionUsageRecord[] = []
    for (const row of rows) {
      if (row.type !== 'delta') continue
      if (!hasUsage(row.usage)) continue
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
    await this.ensureCurrent(threadId)
    const state = await this.loadStateFromIndex(threadId)
    if (!state || state.lastSeq <= 0) return null
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

  /**
   * Bring the index up to date with events.jsonl. Missing or lagging index
   * files are backfilled from the durable event tail; an index whose own log
   * is unreadable is rebuilt from seq 0. Serialized per thread so concurrent
   * readers do not race a rebuild against an append.
   */
  private ensureCurrent(threadId: string): Promise<void> {
    const queued = this.ensureQueues.get(threadId) ?? Promise.resolve()
    const run = queued.catch(() => undefined).then(() => this.ensureCurrentUnlocked(threadId))
    const guard = run.then(() => undefined, () => undefined)
    this.ensureQueues.set(threadId, guard)
    return run.finally(() => {
      if (this.ensureQueues.get(threadId) === guard) this.ensureQueues.delete(threadId)
    })
  }

  private async ensureCurrentUnlocked(threadId: string): Promise<void> {
    // In-memory state is only valid while the on-disk index still exists;
    // an external removal (or a fresh process after a crash between the
    // events.jsonl append and the index write) must trigger a rebuild.
    let indexed = this.states.get(threadId) ?? null
    if (!indexed) {
      indexed = await this.loadStateFromIndex(threadId)
    } else {
      const onDisk = await this.loadStateFromIndex(threadId)
      if (!onDisk || onDisk.lastSeq !== indexed.lastSeq) indexed = onDisk
    }
    const lastSeq = indexed?.lastSeq ?? 0
    const cumulative = indexed?.cumulative ?? emptyUsageSnapshot()
    const pending: UsageIndexRow[] = []
    let latest = cumulative
    let highestSeen = lastSeq
    let lastDay = indexed?.lastDay ?? ''
    for await (const event of this.eventsSince(threadId, lastSeq)) {
      const day = utcDayOf(event.timestamp)
      // Persist the day-boundary checkpoint that incremental recordUsage would
      // have written, so a backfilled index keeps the same anchors.
      if (highestSeen > 0 && day && day !== lastDay) {
        pending.push({
          type: 'checkpoint',
          date: lastDay,
          seq: highestSeen,
          timestamp: lastDay,
          cumulative: latest
        })
      }
      const delta = diffUsage(event.usage, latest)
      pending.push({
        type: 'delta',
        seq: event.seq,
        timestamp: event.timestamp,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.providerId ? { providerId: event.providerId } : {}),
        usage: delta,
        cumulative: event.usage
      })
      latest = event.usage
      highestSeen = Math.max(highestSeen, event.seq)
      if (day) lastDay = day
    }
    if (pending.length > 0) {
      await mkdir(this.indexDir(threadId), { recursive: true, mode: 0o700 })
      const body = pending.map((row) => JSON.stringify(row)).join('\n')
      await appendFile(this.indexPath(threadId), `${body}\n`, { encoding: 'utf-8', mode: 0o600 })
    }
    this.states.set(threadId, { lastSeq: highestSeen, cumulative: latest, lastDay })
  }

  /**
   * Read only the index tail state. A truncated or corrupt file yields null
   * so the caller rebuilds from the durable event log.
   */
  private async loadStateFromIndex(threadId: string): Promise<UsageIndexState | null> {
    const rows = await this.readIndexRows(threadId)
    if (rows.length === 0) return null
    let state: UsageIndexState = { lastSeq: 0, cumulative: emptyUsageSnapshot(), lastDay: '' }
    let seen = false
    for (const row of rows) {
      seen = true
      if (row.type === 'delta' && row.seq >= state.lastSeq) {
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
    return seen ? state : null
  }

  private async readIndexRows(threadId: string): Promise<UsageIndexRow[]> {
    const path = this.indexPath(threadId)
    const rows: UsageIndexRow[] = []
    let remainder = ''
    try {
      const stream = createReadStream(path, { encoding: 'utf-8', highWaterMark: 64 * 1024 })
      for await (const chunk of stream) {
        remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        let newline = remainder.indexOf('\n')
        while (newline >= 0) {
          const line = remainder.slice(0, newline)
          remainder = remainder.slice(newline + 1)
          const row = parseUsageIndexRow(line)
          if (row) rows.push(row)
          newline = remainder.indexOf('\n')
        }
        if (Buffer.byteLength(remainder, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) {
          throw new Error(`usage index record exceeds ${DEFAULT_INDEX_MAX_RECORD_BYTES} bytes`)
        }
      }
      if (remainder.trim()) {
        const row = parseUsageIndexRow(remainder)
        if (row) rows.push(row)
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
    return rows
  }
}

export function parseUsageIndexRow(line: string): UsageIndexRow | null {
  if (!line.trim()) return null
  if (Buffer.byteLength(line, 'utf-8') > DEFAULT_INDEX_MAX_RECORD_BYTES) return null
  try {
    const parsed = UsageIndexRowSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function utcDayOf(timestamp: string): string {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}
