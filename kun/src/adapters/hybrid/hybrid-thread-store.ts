import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { ThreadRecord, ThreadSummary } from '../../contracts/threads.js'
import type { RuntimeEvent } from '../../contracts/events.js'
import type { TurnItem } from '../../contracts/items.js'
import type { ThreadStore, ThreadStoreListOptions } from '../../ports/thread-store.js'
import type { SessionLatestUsageSnapshot, SessionUsageRecord } from '../../ports/session-store.js'
import { toThreadSummary } from '../../domain/thread.js'
import { assertSafeThreadId, isSafeThreadId } from '../../contracts/thread-id.js'
import { readJsonl } from '../file/file-thread-store.js'
import {
  emptyUsageSnapshot,
  UsageSnapshotSchema,
  type UsageSnapshot
} from '../../contracts/usage.js'
import { stripThreadItemBodies, type ThreadMetadataLine } from './hybrid-thread-projection.js'
import { HybridThreadDocumentRepository } from './hybrid-thread-documents.js'
import {
  filterThreadSummaries,
  summaryFromRow,
  type ThreadIndexRecord,
  type ThreadRow
} from './hybrid-thread-index-mapping.js'
import { HybridThreadIndexRepository } from './hybrid-thread-index.js'
import { HybridThreadBackfillCoordinator } from './hybrid-thread-backfill.js'

type UsageRuntimeEvent = Extract<RuntimeEvent, { kind: 'usage' }>

type UsageRow = {
  thread_id: string
  seq: number
  timestamp: string
  turn_id: string | null
  model: string | null
  usage_json: string
}

/**
 * Hybrid store inspired by Codex: JSONL files are canonical and SQLite
 * is a rebuildable index. SQLite writes always happen after metadata
 * JSONL has been appended.
 */
export class HybridThreadStore implements ThreadStore {
  private readonly dataDir: string
  private readonly sqlitePath: string
  private readonly nowIso: () => string
  private readonly readyPromise: Promise<void>
  private readonly metadataQueues = new Map<string, Promise<void>>()
  private backfill: HybridThreadBackfillCoordinator<UsageRuntimeEvent> | null = null
  private db: BetterSqliteDatabase | null = null
  private index: HybridThreadIndexRepository | null = null
  // Prepared-statement cache for the per-event hot paths; better-sqlite3
  // re-compiles the SQL on every prepare() call otherwise.
  private readonly statementCache = new Map<string, Statement>()
  private readonly documents: HybridThreadDocumentRepository
  // Per-thread floor that keeps metadata compaction from re-running on every
  // append when a single snapshot is already larger than the threshold.
  private readonly metadataCompactFloor = new Map<string, number>()

  constructor(options: { dataDir: string; sqlitePath?: string; nowIso?: () => string }) {
    this.dataDir = resolve(options.dataDir, 'threads')
    this.documents = new HybridThreadDocumentRepository(options.dataDir)
    this.sqlitePath = resolve(options.sqlitePath ?? join(options.dataDir, 'index.sqlite3'))
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.readyPromise = this.initialize()
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  close(): void {
    this.backfill?.stop()
    try {
      this.db?.close()
    } finally {
      this.db = null
      this.index = null
      this.statementCache.clear()
    }
  }

  async shutdown(): Promise<void> {
    await this.ready()
    this.backfill?.stop()
    await this.backfill?.wait()
    this.close()
  }

  async waitForBackfill(): Promise<void> {
    await this.ready()
    await this.backfill?.wait()
  }

  async list(options: ThreadStoreListOptions = {}): Promise<ThreadSummary[]> {
    await this.ready()
    // Missing or intentionally discarded SQLite indexes are rebuilt from the
    // canonical JSONL metadata before the first list response. Usage/event
    // backfill remains in the background so large histories stay responsive.
    await this.backfill?.waitForIndex()
    if (this.db) {
      try {
        const rows = this.queryThreadRows(options)
        const summaries: ThreadSummary[] = []
        for (const row of rows) {
          if (await this.rowHasReadableJsonl(row)) {
            summaries.push(summaryFromRow(row))
          } else {
            this.deleteIndexRow(row.id)
          }
        }
        return summaries
      } catch (error) {
        warnSqlite('list', error)
      }
    }
    return filterThreadSummaries(await this.listFromFilesystem(), options)
  }

  async get(threadId: string): Promise<ThreadRecord | null> {
    if (!isSafeThreadId(threadId)) return null
    await this.ready()
    if (this.db) {
      const row = this.findRow(threadId)
      if (row && !(await this.rowHasReadableJsonl(row))) {
        this.deleteIndexRow(threadId)
      }
    }

    const thread = await this.readThreadFromDisk(threadId)
    if (thread && this.db) {
      this.upsertIndexBestEffort(this.indexRecordForThread(thread))
    }
    return thread
  }

  async upsert(thread: ThreadRecord): Promise<ThreadRecord> {
    assertSafeThreadId(thread.id)
    await this.ready()
    await this.appendMetadata(thread)
    if (this.db) {
      this.upsertIndexBestEffort(this.indexRecordForThread(thread))
    }
    return thread
  }

  async delete(threadId: string): Promise<boolean> {
    if (!isSafeThreadId(threadId)) return false
    await this.ready()
    const dir = this.threadDir(threadId)
    const existed = await pathExists(dir)
    if (!existed) {
      this.deleteIndexRow(threadId)
      return false
    }
    await rm(dir, { recursive: true, force: true })
    this.deleteIndexRow(threadId)
    this.documents.invalidate(threadId)
    this.metadataCompactFloor.delete(threadId)
    return true
  }

  async noteEventSeq(threadId: string, seq: number): Promise<void> {
    await this.noteEventHighWater(threadId, seq)
  }

  async noteEvent(event: RuntimeEvent): Promise<void> {
    await this.ready()
    if (!this.db) return
    this.noteEventHighWaterSync(event.threadId, event.seq)
    if (event.kind !== 'usage') return
    try {
      this.cachedStatement(`
        INSERT INTO usage_events (
          thread_id, seq, timestamp, turn_id, model, usage_json
        )
        VALUES (
          @thread_id, @seq, @timestamp, @turn_id, @model, @usage_json
        )
        ON CONFLICT(thread_id, seq) DO UPDATE SET
          timestamp = excluded.timestamp,
          turn_id = excluded.turn_id,
          model = excluded.model,
          usage_json = excluded.usage_json
      `).run(usageRowFromEvent(event))
    } catch (error) {
      warnSqlite('record usage event', error)
    }
  }

  async getEventSeqHighWater(threadId: string): Promise<number | null> {
    await this.ready()
    if (!this.db) return null
    try {
      const row = this.db
        .prepare('SELECT event_seq_high_water FROM threads WHERE id = ?')
        .get(threadId) as { event_seq_high_water?: number } | undefined
      return typeof row?.event_seq_high_water === 'number' ? row.event_seq_high_water : null
    } catch (error) {
      warnSqlite('read event high water', error)
      return null
    }
  }

  async loadUsageRecords(options: { threadId?: string } = {}): Promise<SessionUsageRecord[]> {
    await this.ready()
    if (!this.db) throw new Error('hybrid sqlite unavailable')
    try {
      const threadId = options.threadId?.trim()
      const rows = threadId
        ? this.db
            .prepare(`
              SELECT * FROM usage_events
              WHERE thread_id = @thread_id
              ORDER BY thread_id ASC, seq ASC
            `)
            .all({ thread_id: threadId }) as UsageRow[]
        : this.db
            .prepare('SELECT * FROM usage_events ORDER BY thread_id ASC, seq ASC')
            .all() as UsageRow[]
      return usageRecordsFromRows(rows)
    } catch (error) {
      warnSqlite('load usage records', error)
      throw error
    }
  }

  async loadLatestUsageSnapshots(options: { threadIds?: string[] } = {}): Promise<SessionLatestUsageSnapshot[]> {
    await this.ready()
    if (!this.db) throw new Error('hybrid sqlite unavailable')
    try {
      const threadIds = [...new Set((options.threadIds ?? []).map((id) => id.trim()).filter(Boolean))]
      if (threadIds.length > 0) {
        const placeholders = threadIds.map((_id, index) => `@id${index}`).join(', ')
        const params = Object.fromEntries(threadIds.map((id, index) => [`id${index}`, id]))
        const rows = this.db
          .prepare(`
            SELECT u.*
            FROM usage_events u
            JOIN (
              SELECT thread_id, MAX(seq) AS seq
              FROM usage_events
              WHERE thread_id IN (${placeholders})
              GROUP BY thread_id
            ) latest
              ON latest.thread_id = u.thread_id AND latest.seq = u.seq
            ORDER BY u.thread_id ASC
          `)
          .all(params) as UsageRow[]
        return latestUsageSnapshotsFromRows(rows)
      }
      const rows = this.db
        .prepare(`
          SELECT u.*
          FROM usage_events u
          JOIN (
            SELECT thread_id, MAX(seq) AS seq
            FROM usage_events
            GROUP BY thread_id
          ) latest
            ON latest.thread_id = u.thread_id AND latest.seq = u.seq
          ORDER BY u.thread_id ASC
        `)
        .all() as UsageRow[]
      return latestUsageSnapshotsFromRows(rows)
    } catch (error) {
      warnSqlite('load latest usage snapshots', error)
      throw error
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(dirname(this.sqlitePath), { recursive: true })
    try {
      const sqlite = await import('better-sqlite3')
      const Database = sqlite.default
      this.db = new Database(this.sqlitePath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('foreign_keys = ON')
      this.migrate()
      this.index = new HybridThreadIndexRepository(this.db, (threadId) => ({
        metadataPath: this.metadataPath(threadId), messagesPath: this.messagesPath(threadId),
        eventsPath: this.eventsPath(threadId)
      }), warnSqlite)
      this.backfill = new HybridThreadBackfillCoordinator({
        indexedRows: () => this.db!.prepare('SELECT id, usage_backfilled FROM threads').all() as Array<{ id: string; usage_backfilled?: number }>,
        filesystemThreadIds: () => this.threadIdsFromFilesystem(),
        readMissingThread: async (threadId) => Boolean(await this.readThreadFromDisk(threadId)),
        scanEvents: (threadId) => this.scanEventsForBackfill(threadId),
        upsertMissing: async (threadId, highWater) => {
          const thread = await this.readThreadFromDisk(threadId)
          if (thread) this.upsertIndexBestEffort({ ...this.indexRecordForThread(thread), eventSeqHighWater: highWater })
        },
        noteExistingHighWater: (threadId, highWater) => this.noteEventHighWaterSync(threadId, highWater),
        insertUsage: (threadId, usage) => this.insertUsageEventsChunked(threadId, usage),
        markUsageBackfilled: (threadId) => this.markUsageBackfilled(threadId),
        threadDirectoryExists: (threadId) => pathExists(this.threadDir(threadId)),
        deleteIndexRow: (threadId) => this.deleteIndexRow(threadId),
        yieldToEventLoop,
        warn: warnSqlite
      })
      this.backfill.start()
    } catch (error) {
      warnSqlite('initialize', error)
      try {
        this.db?.close()
      } catch {
        // Ignore close errors while falling back to JSONL scanning.
      }
      this.db = null
      this.index = null
      this.backfill = null
    }
  }

  private migrate(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL,
        model_request_capture_enabled INTEGER NOT NULL DEFAULT 0,
        cost_budget_usd REAL,
        cost_budget_warning_sent INTEGER,
        relation TEXT NOT NULL,
        parent_thread_id TEXT,
        forked_from_thread_id TEXT,
        forked_from_title TEXT,
        forked_at TEXT,
        forked_from_message_count INTEGER,
        forked_from_turn_count INTEGER,
        goal_json TEXT,
        todos_json TEXT,
        extension_metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        preview TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_seq_high_water INTEGER NOT NULL DEFAULT 0,
        metadata_path TEXT NOT NULL,
        messages_path TEXT NOT NULL,
        events_path TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_updated_idx
        ON threads(updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_workspace_updated_idx
        ON threads(workspace, updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_status_updated_idx
        ON threads(status, updated_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_relation_updated_idx
        ON threads(relation, updated_at_ms DESC, id DESC);
      CREATE TABLE IF NOT EXISTS usage_events (
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        turn_id TEXT,
        model TEXT,
        usage_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS usage_events_thread_seq_idx
        ON usage_events(thread_id, seq);
      CREATE INDEX IF NOT EXISTS usage_events_timestamp_idx
        ON usage_events(timestamp);
    `)
    addColumnIfMissing(this.db, 'threads', 'todos_json TEXT')
    addColumnIfMissing(this.db, 'threads', 'extension_metadata_json TEXT')
    addColumnIfMissing(this.db, 'threads', 'model_request_capture_enabled INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(this.db, 'threads', 'usage_backfilled INTEGER NOT NULL DEFAULT 0')
  }

  private cachedStatement(sql: string): Statement {
    if (!this.db) throw new Error('sqlite unavailable')
    let statement = this.statementCache.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statementCache.set(sql, statement)
    }
    return statement
  }

  /** Single pass over events.jsonl: high-water mark plus usage events. */
  private async scanEventsForBackfill(
    threadId: string
  ): Promise<{ highWater: number; usage: UsageRuntimeEvent[] }> {
    let highWater = 0
    const usage: UsageRuntimeEvent[] = []
    try {
      for (const event of await readJsonl<RuntimeEvent>(this.eventsPath(threadId))) {
        if (event.seq > highWater) highWater = event.seq
        if (event.kind === 'usage') usage.push(event)
      }
    } catch (error) {
      warnSqlite(`scan events for ${threadId}`, error)
    }
    return { highWater, usage }
  }

  /**
   * Inserts usage rows in small transactions, yielding between chunks.
   * better-sqlite3 is synchronous: unchunked backfill of a large history
   * starved the event loop long enough that the HTTP server never reported
   * ready within the GUI's startup timeout.
   */
  private async insertUsageEventsChunked(threadId: string, events: UsageRuntimeEvent[]): Promise<void> {
    if (!this.db || events.length === 0) return
    const insert = this.cachedStatement(`
      INSERT OR REPLACE INTO usage_events (
        thread_id, seq, timestamp, turn_id, model, usage_json
      )
      VALUES (
        @thread_id, @seq, @timestamp, @turn_id, @model, @usage_json
      )
    `)
    const insertChunk = this.db.transaction((chunk: UsageRow[]) => {
      for (const row of chunk) insert.run(row)
    })
    const chunkSize = 200
    for (let start = 0; start < events.length; start += chunkSize) {
      const chunk = events.slice(start, start + chunkSize).map(usageRowFromEvent)
      try {
        insertChunk(chunk)
      } catch (error) {
        warnSqlite(`backfill usage events for ${threadId}`, error)
        return
      }
      await yieldToEventLoop()
    }
  }

  private markUsageBackfilled(threadId: string): void {
    if (!this.db) return
    try {
      this.db.prepare('UPDATE threads SET usage_backfilled = 1 WHERE id = ?').run(threadId)
    } catch (error) {
      warnSqlite('mark usage backfilled', error)
    }
  }

  private queryThreadRows(options: ThreadStoreListOptions): ThreadRow[] {
    return this.index?.query(options) ?? []
  }

  private findRow(threadId: string): ThreadRow | null {
    return this.index?.find(threadId) ?? null
  }

  private upsertIndexBestEffort(record: ThreadIndexRecord): void {
    this.index?.upsert(record)
  }

  private deleteIndexRow(threadId: string): void {
    this.index?.delete(threadId)
  }

  private async appendMetadata(thread: ThreadRecord): Promise<void> {
    const previous = this.metadataQueues.get(thread.id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      await mkdir(this.threadDir(thread.id), { recursive: true })
      const line: ThreadMetadataLine = {
        kind: 'thread_metadata',
        version: 1,
        timestamp: this.nowIso(),
        thread: stripThreadItemBodies(thread)
      }
      await appendJsonlLine(this.metadataPath(thread.id), line)
      await this.maybeCompactMetadata(thread.id)
    })
    const guard = run.then(() => undefined, () => undefined)
    this.metadataQueues.set(thread.id, guard)
    try {
      await run
    } finally {
      if (this.metadataQueues.get(thread.id) === guard) {
        this.metadataQueues.delete(thread.id)
      }
    }
  }

  /**
   * Every upsert appends a full thread snapshot, so metadata.jsonl grows
   * quadratically with turn activity (observed: 4.2MB for an 8-turn thread
   * whose latest snapshot is 6KB). Once the file passes the threshold it is
   * rewritten as a single normalized snapshot. Runs inside the per-thread
   * metadata queue, so no append can interleave with the rewrite.
   */
  private async maybeCompactMetadata(threadId: string): Promise<void> {
    const path = this.metadataPath(threadId)
    const tmpPath = `${path}.compact.tmp`
    try {
      const stats = await stat(path)
      const floor = this.metadataCompactFloor.get(threadId) ?? METADATA_COMPACT_MIN_BYTES
      if (stats.size < floor) return
      const record = await this.readLatestMetadata(threadId)
      if (!record) return
      const line: ThreadMetadataLine = {
        kind: 'thread_metadata',
        version: 1,
        timestamp: this.nowIso(),
        thread: stripThreadItemBodies(record)
      }
      const handle = await open(tmpPath, 'w')
      try {
        await handle.writeFile(`${JSON.stringify(line)}\n`, 'utf-8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmpPath, path)
      const compacted = await stat(path)
      this.metadataCompactFloor.set(
        threadId,
        Math.max(METADATA_COMPACT_MIN_BYTES, compacted.size * 4)
      )
    } catch (error) {
      // On Windows the atomic rename can fail with EPERM while another
      // handle has the file open; the next append over the threshold simply
      // retries. Drop the temp file so failures do not accumulate litter.
      await rm(tmpPath, { force: true }).catch(() => undefined)
      console.warn(
        `[kun] metadata compaction skipped for ${threadId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private indexRecordForThread(thread: ThreadRecord): ThreadIndexRecord {
    const itemSource = thread.turns.flatMap((turn) => turn.items)
    return {
      thread,
      messageCount: itemSource.length,
      eventSeqHighWater: 0,
      preview: previewFromItems(itemSource)
    }
  }

  private async readThreadFromDisk(threadId: string): Promise<ThreadRecord | null> {
    return this.documents.readThread(threadId)
  }

  private async readLatestMetadata(threadId: string): Promise<ThreadRecord | null> {
    return this.documents.readLatestMetadata(threadId)
  }

  private async noteEventHighWater(threadId: string, seq: number): Promise<void> {
    await this.ready()
    this.noteEventHighWaterSync(threadId, seq)
  }

  private noteEventHighWaterSync(threadId: string, seq: number): void {
    if (!this.db) return
    try {
      this.cachedStatement(`
        UPDATE threads
        SET event_seq_high_water = CASE
          WHEN event_seq_high_water > @seq THEN event_seq_high_water
          ELSE @seq
        END
        WHERE id = @id
      `).run({ id: threadId, seq })
    } catch (error) {
      warnSqlite('note event seq', error)
    }
  }

  private async listFromFilesystem(): Promise<ThreadSummary[]> {
    const summaries: ThreadSummary[] = []
    for (const threadId of await this.threadIdsFromFilesystem()) {
      const thread = await this.readThreadFromDisk(threadId)
      if (thread) summaries.push(toThreadSummary(thread))
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private async threadIdsFromFilesystem(): Promise<string[]> {
    try {
      const entries = await readdir(this.dataDir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory() && isSafeThreadId(entry.name)).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private async rowHasReadableJsonl(row: ThreadRow): Promise<boolean> {
    if (!isSafeThreadId(row.id)) return false
    if (!(await pathExists(this.threadDir(row.id)))) return false
    const readable =
      (await pathExists(this.metadataPath(row.id))) ||
      (await pathExists(this.legacyThreadPath(row.id)))
    if (!readable) return false
    if (
      row.metadata_path !== this.metadataPath(row.id) ||
      row.messages_path !== this.messagesPath(row.id) ||
      row.events_path !== this.eventsPath(row.id)
    ) {
      // JSONL is canonical and the SQLite paths are derived. Moving a Runtime
      // data directory (including the GUI's legacy migration) must not make a
      // valid thread disappear merely because its cached absolute paths still
      // point at the previous root.
      this.index?.repairPaths(row.id)
    }
    return true
  }

  private threadDir(threadId: string): string {
    assertSafeThreadId(threadId)
    return this.documents.threadDir(threadId)
  }

  private metadataPath(threadId: string): string {
    return this.documents.metadataPath(threadId)
  }

  private legacyThreadPath(threadId: string): string {
    return this.documents.legacyThreadPath(threadId)
  }

  private messagesPath(threadId: string): string {
    return this.documents.messagesPath(threadId)
  }

  private eventsPath(threadId: string): string {
    return this.documents.eventsPath(threadId)
  }
}

function previewFromItems(items: TurnItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item) continue
    if (item.kind === 'user_message' || item.kind === 'assistant_text') {
      return item.text.slice(0, 500)
    }
    if (item.kind === 'error') return item.message.slice(0, 500)
    if (item.kind === 'tool_call') return (item.summary ?? item.toolName).slice(0, 500)
  }
  return ''
}

function usageRowFromEvent(event: RuntimeEvent & { kind: 'usage' }): UsageRow {
  return {
    thread_id: event.threadId,
    seq: event.seq,
    timestamp: event.timestamp,
    turn_id: event.turnId ?? null,
    model: event.model ?? null,
    usage_json: JSON.stringify(event.usage)
  }
}

function usageRecordsFromRows(rows: UsageRow[]): SessionUsageRecord[] {
  const previousByThread = new Map<string, UsageSnapshot>()
  const records: SessionUsageRecord[] = []
  for (const row of rows) {
    const usage = parseUsageSnapshot(row.usage_json)
    if (!usage) continue
    const previous = previousByThread.get(row.thread_id) ?? emptyUsageSnapshot()
    const delta = diffUsage(usage, previous)
    previousByThread.set(row.thread_id, usage)
    if (!hasUsage(delta)) continue
    records.push({
      threadId: row.thread_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      completedAt: row.timestamp,
      usage: delta
    })
  }
  return records
}

function latestUsageSnapshotsFromRows(rows: UsageRow[]): SessionLatestUsageSnapshot[] {
  return rows.flatMap((row) => {
    const usage = parseUsageSnapshot(row.usage_json)
    if (!usage) return []
    return [{
      threadId: row.thread_id,
      seq: row.seq,
      usage
    }]
  })
}

function parseUsageSnapshot(raw: string): UsageSnapshot | null {
  try {
    const parsed = UsageSnapshotSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function diffUsage(current: UsageSnapshot, previous: UsageSnapshot): UsageSnapshot {
  const promptTokens = diffNumber(current.promptTokens, previous.promptTokens)
  const completionTokens = diffNumber(current.completionTokens, previous.completionTokens)
  const reportedTotal = diffNumber(current.totalTokens, previous.totalTokens)
  const totalTokens = reportedTotal || promptTokens + completionTokens
  const cachedTokens = diffOptionalNumber(current.cachedTokens, previous.cachedTokens)
  const cacheHitTokens = diffOptionalNumber(current.cacheHitTokens, previous.cacheHitTokens)
  const cacheMissTokens = diffOptionalNumber(current.cacheMissTokens, previous.cacheMissTokens)
  const cacheTotal = (cacheHitTokens ?? 0) + (cacheMissTokens ?? 0)
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
    cacheHitRate: cacheHitTokens !== undefined && cacheTotal > 0 ? cacheHitTokens / cacheTotal : null,
    ...(current.cacheableTokenHitRate !== undefined
      ? { cacheableTokenHitRate: current.cacheableTokenHitRate }
      : {}),
    ...(current.totalInputTokenHitRate !== undefined
      ? { totalInputTokenHitRate: current.totalInputTokenHitRate }
      : {}),
    ...(current.cacheMissReasons ? { cacheMissReasons: [...current.cacheMissReasons] } : {}),
    ...(current.cacheSuggestions ? { cacheSuggestions: [...current.cacheSuggestions] } : {}),
    turns: diffNumber(current.turns, previous.turns),
    ...(current.costUsd !== undefined || previous.costUsd !== undefined
      ? { costUsd: diffNumber(current.costUsd ?? 0, previous.costUsd ?? 0) }
      : {}),
    ...(current.costCny !== undefined || previous.costCny !== undefined
      ? { costCny: diffNumber(current.costCny ?? 0, previous.costCny ?? 0) }
      : {}),
    ...(current.cacheSavingsUsd !== undefined || previous.cacheSavingsUsd !== undefined
      ? { cacheSavingsUsd: diffNumber(current.cacheSavingsUsd ?? 0, previous.cacheSavingsUsd ?? 0) }
      : {}),
    ...(current.cacheSavingsCny !== undefined || previous.cacheSavingsCny !== undefined
      ? { cacheSavingsCny: diffNumber(current.cacheSavingsCny ?? 0, previous.cacheSavingsCny ?? 0) }
      : {}),
    ...(current.tokenEconomySavingsTokens !== undefined || previous.tokenEconomySavingsTokens !== undefined
      ? {
          tokenEconomySavingsTokens: diffNumber(
            current.tokenEconomySavingsTokens ?? 0,
            previous.tokenEconomySavingsTokens ?? 0
          )
        }
      : {}),
    ...(current.tokenEconomySavingsUsd !== undefined || previous.tokenEconomySavingsUsd !== undefined
      ? {
          tokenEconomySavingsUsd: diffNumber(
            current.tokenEconomySavingsUsd ?? 0,
            previous.tokenEconomySavingsUsd ?? 0
          )
        }
      : {}),
    ...(current.tokenEconomySavingsCny !== undefined || previous.tokenEconomySavingsCny !== undefined
      ? {
          tokenEconomySavingsCny: diffNumber(
            current.tokenEconomySavingsCny ?? 0,
            previous.tokenEconomySavingsCny ?? 0
          )
        }
      : {}),
    ...(current.hasError ? { hasError: true } : {})
  }
}

function diffNumber(current: number, previous: number): number {
  return Math.max(0, current - previous)
}

function diffOptionalNumber(current?: number, previous?: number): number | undefined {
  if (current === undefined && previous === undefined) return undefined
  return Math.max(0, (current ?? 0) - (previous ?? 0))
}

function hasUsage(usage: UsageSnapshot): boolean {
  return usage.promptTokens > 0
    || usage.completionTokens > 0
    || usage.totalTokens > 0
    || (usage.cachedTokens ?? 0) > 0
    || (usage.cacheHitTokens ?? 0) > 0
    || (usage.cacheMissTokens ?? 0) > 0
    || usage.turns > 0
    || (usage.costUsd ?? 0) > 0
    || (usage.costCny ?? 0) > 0
    || (usage.cacheSavingsUsd ?? 0) > 0
    || (usage.cacheSavingsCny ?? 0) > 0
    || (usage.tokenEconomySavingsTokens ?? 0) > 0
    || (usage.tokenEconomySavingsUsd ?? 0) > 0
    || (usage.tokenEconomySavingsCny ?? 0) > 0
}

function addColumnIfMissing(db: BetterSqliteDatabase, table: string, columnSql: string): void {
  const column = columnSql.trim().split(/\s+/)[0]
  if (!column) return
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (rows.some((row) => row.name === column)) return
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`)
  } catch (error) {
    warnSqlite(`add column ${column}`, error)
  }
}

const METADATA_COMPACT_MIN_BYTES = 1_000_000

async function appendJsonlLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function warnSqlite(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[kun] hybrid sqlite ${action} failed; using JSONL fallback: ${message}`)
}
