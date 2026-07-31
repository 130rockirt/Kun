import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import type {
  ItemHistoryCompactionResult,
  ItemHistoryCommit,
  ItemHistorySnapshot,
  SessionStore
} from '../../ports/session-store.js'
import type { RuntimeEvent } from '../../contracts/events.js'
import type { TurnItem } from '../../contracts/items.js'
import { assertSafeThreadId, isSafeThreadId } from '../../contracts/thread-id.js'
import type { AgentSession } from '../../domain/session.js'
import { readJsonl } from './file-thread-store.js'
import { atomicWriteFile } from './atomic-write.js'
import { isPathBelowDirectory } from './path-containment.js'

const DEFAULT_USAGE_EVENT_COMPACTION_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_USAGE_EVENT_RETENTION_DAYS = 365
const MS_PER_DAY = 86_400_000
/** Log a warning when a cold loadItems read blocks the loop for at least this long (#621). */
const SLOW_LOAD_ITEMS_LOG_MS = 1_000

/**
 * The agent loop reloads the full item history on every model step, so
 * keep the deduped array for recently touched threads in memory instead
 * of re-reading and re-parsing messages.jsonl each time.
 */
const ITEMS_CACHE_MAX_THREADS = 4
const DEFAULT_ITEMS_CACHE_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_ITEM_HISTORY_COMPACTION_MIN_BYTES = 4 * 1024 * 1024
const DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES = 16 * 1024 * 1024
const HIGHEST_SEQ_CACHE_MAX_THREADS = 256
const ITEM_HISTORY_REVISION_MAX_THREADS = 512
// A model tool argument may contain 1 MiB of raw JSON. Invalid JSON is kept in
// a `__raw` string for safe tool failure, whose escaping can nearly double the
// persisted item event. Keep replay finite while allowing that valid envelope.
export const DEFAULT_EVENT_REPLAY_MAX_RECORD_BYTES = 4 * 1024 * 1024

/**
 * File-backed session store. Appends events and items to per-thread
 * JSONL files and keeps the canonical session snapshot in a small
 * JSON file. Replay reads the JSONL files end-to-end.
 */
export class FileSessionStore implements SessionStore {
  private readonly dataDir: string
  private readonly usageEventCompaction: {
    maxBytes: number
    retentionDays: number
    nowIso: () => string
  }
  private readonly itemsCache = new Map<string, TurnItem[]>()
  private readonly itemsCacheBytes = new Map<string, number>()
  private readonly itemsCacheMaxBytes: number
  private readonly itemHistoryCompactionMinBytes: number
  private readonly itemsCacheVersion = new Map<string, number>()
  /** Opaque revisions used to fence stale read-compute-rewrite snapshots. */
  private readonly itemHistoryRevisions = new Map<string, number>()
  private nextItemHistoryRevision = 0
  private readonly highestSeqCache = new Map<string, { seq: number; size: number; mtimeMs: number }>()
  private readonly writeQueues = new Map<string, Promise<unknown>>()

  constructor(options: {
    dataDir: string
    usageEventCompaction?: {
      maxBytes?: number
      retentionDays?: number
      nowIso?: () => string
    }
    itemsCacheMaxBytes?: number
    itemHistoryCompactionMinBytes?: number
  }) {
    this.dataDir = resolve(options.dataDir, 'threads')
    this.itemsCacheMaxBytes = Math.max(
      1,
      Math.floor(options.itemsCacheMaxBytes ?? DEFAULT_ITEMS_CACHE_MAX_BYTES)
    )
    this.itemHistoryCompactionMinBytes = Math.max(
      1,
      Math.floor(
        options.itemHistoryCompactionMinBytes ?? DEFAULT_ITEM_HISTORY_COMPACTION_MIN_BYTES
      )
    )
    this.usageEventCompaction = {
      maxBytes: Math.max(
        1,
        Math.floor(options.usageEventCompaction?.maxBytes ?? DEFAULT_USAGE_EVENT_COMPACTION_MAX_BYTES)
      ),
      retentionDays: Math.max(
        1,
        Math.floor(options.usageEventCompaction?.retentionDays ?? DEFAULT_USAGE_EVENT_RETENTION_DAYS)
      ),
      nowIso: options.usageEventCompaction?.nowIso ?? (() => new Date().toISOString())
    }
  }

  async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    assertSafeThreadId(threadId)
    await this.withThreadWrite(threadId, async () => {
      await this.ensureDir(this.threadDir(threadId))
      const path = this.eventsPath(threadId)
      await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf-8', mode: 0o600 })
      const info = await stat(path)
      this.cacheHighestSeq(threadId, event.seq, info, { preserveHigher: true })
      if (event.kind === 'usage') {
        await this.compactUsageEventsIfLarge(threadId).catch((error) => {
          warnUsageCompaction(threadId, error)
        })
      }
    })
  }

  async appendItem(threadId: string, item: TurnItem): Promise<void> {
    assertSafeThreadId(threadId)
    await this.withThreadWrite(threadId, async () => {
      await this.ensureDir(this.threadDir(threadId))
      const path = this.messagesPath(threadId)
      await appendFile(path, `${JSON.stringify(item)}\n`, { encoding: 'utf-8', mode: 0o600 })
      this.bumpItemsVersion(threadId)
      this.applyItemToCache(threadId, item)
      this.bumpItemHistoryRevision(threadId)
    })
  }

  async rewriteItems(threadId: string, items: TurnItem[]): Promise<void> {
    assertSafeThreadId(threadId)
    await this.withThreadWrite(threadId, async () => {
      await this.ensureDir(this.threadDir(threadId))
      const contents = items.map((item) => JSON.stringify(item)).join('\n')
      await this.atomicWrite(this.messagesPath(threadId), contents ? `${contents}\n` : '')
      this.bumpItemsVersion(threadId)
      this.cacheItems(threadId, [...items])
      this.bumpItemHistoryRevision(threadId)
    })
  }

  async loadItemSnapshot(threadId: string): Promise<ItemHistorySnapshot> {
    if (!isSafeThreadId(threadId)) return { revision: 0, items: [] }
    return this.withThreadWrite(threadId, async () => ({
      revision: this.itemHistoryRevision(threadId),
      items: await this.loadItemsUnlocked(threadId)
    }))
  }

  async rewriteItemsIfRevision(
    threadId: string,
    expectedRevision: number,
    items: TurnItem[]
  ): Promise<ItemHistoryCommit> {
    assertSafeThreadId(threadId)
    return this.withThreadWrite(threadId, async () => {
      const revision = this.itemHistoryRevision(threadId)
      if (revision !== expectedRevision) {
        return { applied: false, reason: 'conflict', revision }
      }
      await this.ensureDir(this.threadDir(threadId))
      const contents = items.map((item) => JSON.stringify(item)).join('\n')
      await this.atomicWrite(this.messagesPath(threadId), contents ? `${contents}\n` : '')
      this.bumpItemsVersion(threadId)
      this.cacheItems(threadId, [...items])
      return { applied: true, revision: this.bumpItemHistoryRevision(threadId) }
    })
  }

  async updateItem(threadId: string, itemId: string, patch: Partial<TurnItem>): Promise<TurnItem | null> {
    assertSafeThreadId(threadId)
    return this.withThreadWrite(threadId, async () => {
      const items = await this.loadItemsUnlocked(threadId)
      const current = items.find((item) => item.id === itemId)
      if (!current) return null
      const updated = { ...current, ...patch } as TurnItem
      await this.ensureDir(this.threadDir(threadId))
      await appendFile(this.messagesPath(threadId), `${JSON.stringify(updated)}\n`, { encoding: 'utf-8', mode: 0o600 })
      this.bumpItemsVersion(threadId)
      this.applyItemToCache(threadId, updated)
      this.bumpItemHistoryRevision(threadId)
      return updated
    })
  }

  async compactItems(
    threadId: string,
    options: { force?: boolean } = {}
  ): Promise<ItemHistoryCompactionResult> {
    assertSafeThreadId(threadId)
    return this.withThreadWrite(threadId, () =>
      this.compactItemsUnlocked(threadId, options)
    )
  }

  async loadEventsSince(threadId: string, sinceSeq: number): Promise<RuntimeEvent[]> {
    if (!isSafeThreadId(threadId)) return []
    const all = await readJsonl<RuntimeEvent>(this.eventsPath(threadId))
    return all
      .filter((event) => event.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
  }

  async *iterateEventsSince(
    threadId: string,
    sinceSeq: number,
    options: { maxRecordBytes?: number } = {}
  ): AsyncIterable<RuntimeEvent> {
    if (!isSafeThreadId(threadId)) return
    const maxRecordBytes = Math.max(
      1,
      Math.floor(options.maxRecordBytes ?? DEFAULT_EVENT_REPLAY_MAX_RECORD_BYTES)
    )
    let remainder = ''
    try {
      const stream = createReadStream(this.eventsPath(threadId), {
        encoding: 'utf-8',
        // Keep the raw chunk well below one record budget. A malformed line
        // without a newline therefore cannot force a whole-log allocation.
        highWaterMark: Math.min(maxRecordBytes, 64 * 1024)
      })
      for await (const chunk of stream) {
        remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        let newline = remainder.indexOf('\n')
        while (newline >= 0) {
          const line = remainder.slice(0, newline)
          remainder = remainder.slice(newline + 1)
          const event = parseReplayEventRecord(line, maxRecordBytes)
          if (event && event.seq > sinceSeq) yield event
          newline = remainder.indexOf('\n')
        }
        if (Buffer.byteLength(remainder, 'utf-8') > maxRecordBytes) {
          throw new Error(`event replay record exceeds ${maxRecordBytes} bytes`)
        }
      }
      const trailing = parseReplayEventRecord(remainder, maxRecordBytes)
      if (trailing && trailing.seq > sinceSeq) yield trailing
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
  }

  async loadItems(threadId: string): Promise<TurnItem[]> {
    if (!isSafeThreadId(threadId)) return []
    return this.withThreadWrite(threadId, () => this.loadItemsUnlocked(threadId))
  }

  private async loadItemsUnlocked(threadId: string): Promise<TurnItem[]> {
    const cached = this.itemsCache.get(threadId)
    if (cached) {
      this.cacheItems(threadId, cached)
      return [...cached]
    }
    const info = await stat(this.messagesPath(threadId)).catch(() => null)
    if (info && info.size >= this.itemHistoryCompactionMinBytes) {
      await this.compactItemsUnlocked(threadId).catch((error) => {
        console.warn(
          `[kun] item history compaction skipped for ${threadId}; keeping source log: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
      const compactedCache = this.itemsCache.get(threadId)
      if (compactedCache) return [...compactedCache]
    }
    const startedAt = performance.now()
    const { items: ordered, rawCount } = await readLatestItemsFromJsonl(
      this.messagesPath(threadId)
    )
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs >= SLOW_LOAD_ITEMS_LOG_MS) {
      // A slow cold read points at an oversized thread log as the likely
      // event-loop staller behind a watchdog restart (#621); the counts say
      // how bloated messages.jsonl has become.
      console.warn(
        `[kun] loadItems(${threadId}) took ${Math.round(elapsedMs)}ms ` +
          `for ${rawCount} raw → ${ordered.length} items`
      )
    }
    this.cacheItems(threadId, ordered)
    return [...ordered]
  }

  async loadSession(threadId: string): Promise<AgentSession | null> {
    try {
      const raw = await readFile(this.sessionPath(threadId), 'utf-8')
      return JSON.parse(raw) as AgentSession
    } catch {
      return null
    }
  }

  async upsertSession(session: AgentSession): Promise<void> {
    assertSafeThreadId(session.threadId)
    await this.withThreadWrite(session.threadId, async () => {
      await this.ensureDir(this.threadDir(session.threadId))
      await this.atomicWrite(this.sessionPath(session.threadId), JSON.stringify(session))
    })
  }

  async highestSeq(threadId: string): Promise<number> {
    if (!isSafeThreadId(threadId)) return 0
    const path = this.eventsPath(threadId)
    const info = await stat(path).catch(() => null)
    if (!info) {
      this.highestSeqCache.delete(threadId)
      return 0
    }
    const cached = this.highestSeqCache.get(threadId)
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      this.cacheHighestSeq(threadId, cached.seq, info)
      return cached.seq
    }
    const events = await readJsonl<RuntimeEvent>(path)
    const highest = events.reduce((max, event) => Math.max(max, event.seq), 0)
    this.cacheHighestSeq(threadId, highest, await stat(path).catch(() => info))
    return highest
  }

  async resetMemory(): Promise<void> {
    this.itemsCache.clear()
    this.itemsCacheBytes.clear()
    this.itemsCacheVersion.clear()
    this.itemHistoryRevisions.clear()
    this.highestSeqCache.clear()
  }

  clearThreadMemory(threadId: string): void {
    this.removeCachedItems(threadId)
    this.itemsCacheVersion.delete(threadId)
    this.itemHistoryRevisions.delete(threadId)
    this.highestSeqCache.delete(threadId)
  }

  itemCacheStats(): { entries: number; bytes: number; maxBytes: number } {
    return {
      entries: this.itemsCache.size,
      bytes: this.cachedItemsBytes(),
      maxBytes: this.itemsCacheMaxBytes
    }
  }

  private itemsVersionOf(threadId: string): number {
    return this.itemsCacheVersion.get(threadId) ?? 0
  }

  private bumpItemsVersion(threadId: string): void {
    this.itemsCacheVersion.set(threadId, this.itemsVersionOf(threadId) + 1)
  }

  private itemHistoryRevision(threadId: string): number {
    const revision = this.itemHistoryRevisions.get(threadId)
    if (revision === undefined) return this.bumpItemHistoryRevision(threadId)
    this.itemHistoryRevisions.delete(threadId)
    this.itemHistoryRevisions.set(threadId, revision)
    return revision
  }

  private bumpItemHistoryRevision(threadId: string): number {
    this.nextItemHistoryRevision += 1
    this.itemHistoryRevisions.delete(threadId)
    this.itemHistoryRevisions.set(threadId, this.nextItemHistoryRevision)
    while (this.itemHistoryRevisions.size > ITEM_HISTORY_REVISION_MAX_THREADS) {
      const oldest = this.itemHistoryRevisions.keys().next().value
      if (oldest === undefined) break
      this.itemHistoryRevisions.delete(oldest)
    }
    return this.nextItemHistoryRevision
  }

  private cacheItems(threadId: string, items: TurnItem[]): void {
    this.removeCachedItems(threadId)
    const bytes = serializedBytes(items)
    if (bytes > this.itemsCacheMaxBytes / 2 || bytes > this.itemsCacheMaxBytes) return
    this.itemsCache.set(threadId, items)
    this.itemsCacheBytes.set(threadId, bytes)
    while (
      this.itemsCache.size > ITEMS_CACHE_MAX_THREADS ||
      this.cachedItemsBytes() > this.itemsCacheMaxBytes
    ) {
      const oldest = this.itemsCache.keys().next().value
      if (oldest === undefined) break
      this.removeCachedItems(oldest)
    }
  }

  private cacheHighestSeq(
    threadId: string,
    seq: number,
    info: { size: number; mtimeMs: number },
    options: { preserveHigher?: boolean } = {}
  ): void {
    const current = this.highestSeqCache.get(threadId)?.seq ?? 0
    this.highestSeqCache.delete(threadId)
    this.highestSeqCache.set(threadId, {
      seq: options.preserveHigher ? Math.max(current, seq) : seq,
      size: info.size,
      mtimeMs: info.mtimeMs
    })
    while (this.highestSeqCache.size > HIGHEST_SEQ_CACHE_MAX_THREADS) {
      const oldest = this.highestSeqCache.keys().next().value
      if (oldest === undefined) return
      this.highestSeqCache.delete(oldest)
    }
  }

  private applyItemToCache(threadId: string, item: TurnItem): void {
    const cached = this.itemsCache.get(threadId)
    if (!cached) return
    const index = cached.findIndex((existing) => existing.id === item.id)
    const previousBytes = this.itemsCacheBytes.get(threadId) ?? 0
    const nextBytes = index >= 0
      ? previousBytes - serializedBytes(cached[index]) + serializedBytes(item)
      : previousBytes + serializedBytes(item)
    if (nextBytes > this.itemsCacheMaxBytes / 2 || nextBytes > this.itemsCacheMaxBytes) {
      this.removeCachedItems(threadId)
      return
    }
    if (index >= 0) cached[index] = item
    else cached.push(item)
    this.itemsCache.delete(threadId)
    this.itemsCache.set(threadId, cached)
    this.itemsCacheBytes.delete(threadId)
    this.itemsCacheBytes.set(threadId, nextBytes)
    while (
      this.itemsCache.size > ITEMS_CACHE_MAX_THREADS ||
      this.cachedItemsBytes() > this.itemsCacheMaxBytes
    ) {
      const oldest = this.itemsCache.keys().next().value
      if (oldest === undefined) break
      this.removeCachedItems(oldest)
    }
  }

  private removeCachedItems(threadId: string): void {
    this.itemsCache.delete(threadId)
    this.itemsCacheBytes.delete(threadId)
  }

  private cachedItemsBytes(): number {
    let total = 0
    for (const bytes of this.itemsCacheBytes.values()) total += bytes
    return total
  }

  private async compactItemsUnlocked(
    threadId: string,
    options: { force?: boolean } = {}
  ): Promise<ItemHistoryCompactionResult> {
    const path = this.messagesPath(threadId)
    const info = await stat(path).catch(() => null)
    if (!info) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, itemCount: 0 }
    }
    if (!options.force && info.size < this.itemHistoryCompactionMinBytes) {
      return {
        compacted: false,
        beforeBytes: info.size,
        afterBytes: info.size,
        itemCount: this.itemsCache.get(threadId)?.length ?? 0
      }
    }
    const parsed = await readLatestItemsFromJsonl(path, { rejectMalformed: true })
    const contents = parsed.items.map((item) => JSON.stringify(item)).join('\n')
    const output = contents ? `${contents}\n` : ''
    const afterBytes = Buffer.byteLength(output, 'utf-8')
    this.cacheItems(threadId, parsed.items)
    if (afterBytes >= info.size) {
      return {
        compacted: false,
        beforeBytes: info.size,
        afterBytes: info.size,
        itemCount: parsed.items.length
      }
    }
    await this.atomicWrite(path, output)
    this.bumpItemsVersion(threadId)
    this.bumpItemHistoryRevision(threadId)
    return {
      compacted: true,
      beforeBytes: info.size,
      afterBytes,
      itemCount: parsed.items.length
    }
  }

  private threadDir(threadId: string): string {
    assertSafeThreadId(threadId)
    const path = resolve(this.dataDir, threadId)
    if (!isPathBelowDirectory(this.dataDir, path)) {
      throw new Error(`thread path escapes data directory: ${threadId}`)
    }
    return path
  }

  private async withThreadWrite<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(threadId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const guard = run.then(() => undefined, () => undefined)
    this.writeQueues.set(threadId, guard)
    try {
      return await run
    } finally {
      if (this.writeQueues.get(threadId) === guard) this.writeQueues.delete(threadId)
    }
  }

  private eventsPath(threadId: string): string {
    return join(this.threadDir(threadId), 'events.jsonl')
  }

  private messagesPath(threadId: string): string {
    return join(this.threadDir(threadId), 'messages.jsonl')
  }

  private sessionPath(threadId: string): string {
    return join(this.threadDir(threadId), 'session.json')
  }

  private async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    await atomicWriteFile(path, contents)
  }

  private async compactUsageEventsIfLarge(threadId: string): Promise<void> {
    const path = this.eventsPath(threadId)
    const info = await stat(path).catch(() => null)
    if (!info || info.size <= this.usageEventCompaction.maxBytes) return
    const events = await readJsonl<RuntimeEvent>(path)
    const compacted = compactUsageEvents(events, {
      nowIso: this.usageEventCompaction.nowIso(),
      retentionDays: this.usageEventCompaction.retentionDays
    })
    if (compacted.length >= events.length) return
    const contents = compacted.map((event) => JSON.stringify(event)).join('\n')
    await this.atomicWrite(path, contents ? `${contents}\n` : '')
  }

  /** Used by the loop during shutdown to verify the file actually exists. */
  async exists(threadId: string): Promise<boolean> {
    try {
      await stat(this.threadDir(threadId))
      return true
    } catch {
      return false
    }
  }
}

function compactUsageEvents(
  events: RuntimeEvent[],
  options: { nowIso: string; retentionDays: number }
): RuntimeEvent[] {
  const cutoffMs = Date.parse(options.nowIso) - options.retentionDays * MS_PER_DAY
  if (!Number.isFinite(cutoffMs)) return events

  let latestUsageIndex = -1
  let latestBeforeCutoffIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.kind !== 'usage') continue
    latestUsageIndex = index
    const timestamp = Date.parse(event.timestamp)
    if (Number.isFinite(timestamp) && timestamp < cutoffMs) {
      latestBeforeCutoffIndex = index
    }
  }
  if (latestUsageIndex < 0) return events

  const keep = new Set<number>()
  const latestUsageIndexByBucket = new Map<string, number>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind !== 'usage') {
      keep.add(index)
      continue
    }
    if (!shouldRetainUsageEvent(event, index, {
      cutoffMs,
      latestUsageIndex,
      latestBeforeCutoffIndex
    })) {
      continue
    }
    const bucket = usageCoalescingBucket(event)
    const previous = latestUsageIndexByBucket.get(bucket)
    if (previous !== undefined && previous !== latestBeforeCutoffIndex) {
      keep.delete(previous)
    }
    keep.add(index)
    latestUsageIndexByBucket.set(bucket, index)
  }

  return events.filter((_event, index) => keep.has(index))
}

function shouldRetainUsageEvent(
  event: RuntimeEvent,
  index: number,
  options: { cutoffMs: number; latestUsageIndex: number; latestBeforeCutoffIndex: number }
): boolean {
  if (event.kind !== 'usage') return true
  if (index === options.latestUsageIndex || index === options.latestBeforeCutoffIndex) return true
  const timestamp = Date.parse(event.timestamp)
  if (!Number.isFinite(timestamp)) return true
  return timestamp >= options.cutoffMs
}

function usageCoalescingBucket(event: RuntimeEvent): string {
  if (event.kind !== 'usage') return ''
  const day = Number.isFinite(Date.parse(event.timestamp))
    ? new Date(event.timestamp).toISOString().slice(0, 10)
    : event.timestamp
  return `${day}:${event.model ?? ''}`
}

function parseReplayEventRecord(line: string, maxRecordBytes: number): RuntimeEvent | null {
  if (!line.trim()) return null
  if (Buffer.byteLength(line, 'utf-8') > maxRecordBytes) {
    throw new Error(`event replay record exceeds ${maxRecordBytes} bytes`)
  }
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object') return null
    const event = value as RuntimeEvent
    return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event : null
  } catch {
    // Keep the existing JSONL tolerance: one corrupt historical record must
    // not poison replay of the rest of the thread.
    return null
  }
}

function warnUsageCompaction(threadId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[kun] usage event compaction failed for ${threadId}; keeping append-only log: ${message}`)
}

export async function readLatestItemsFromJsonl(
  path: string,
  options: {
    maxRecordBytes?: number
    rejectMalformed?: boolean
  } = {}
): Promise<{ items: TurnItem[]; rawCount: number; malformedCount: number }> {
  const maxRecordBytes = Math.max(
    1,
    Math.floor(options.maxRecordBytes ?? DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES)
  )
  const latestById = new Map<string, TurnItem>()
  const firstSeenIds: string[] = []
  let remainder = ''
  let rawCount = 0
  let malformedCount = 0

  const acceptLine = (line: string): void => {
    if (!line.trim()) return
    if (Buffer.byteLength(line, 'utf-8') > maxRecordBytes) {
      throw new Error(`item history record exceeds ${maxRecordBytes} bytes`)
    }
    try {
      const item = JSON.parse(line) as TurnItem
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
        malformedCount += 1
        return
      }
      rawCount += 1
      if (!latestById.has(item.id)) firstSeenIds.push(item.id)
      latestById.set(item.id, item)
    } catch {
      malformedCount += 1
    }
  }

  try {
    const stream = createReadStream(path, {
      encoding: 'utf-8',
      highWaterMark: Math.min(maxRecordBytes, 64 * 1024)
    })
    for await (const chunk of stream) {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      let newline = remainder.indexOf('\n')
      while (newline >= 0) {
        acceptLine(remainder.slice(0, newline))
        remainder = remainder.slice(newline + 1)
        newline = remainder.indexOf('\n')
      }
      if (Buffer.byteLength(remainder, 'utf-8') > maxRecordBytes) {
        throw new Error(`item history record exceeds ${maxRecordBytes} bytes`)
      }
    }
    acceptLine(remainder)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }

  if (options.rejectMalformed && malformedCount > 0) {
    throw new Error(`item history contains ${malformedCount} malformed record(s)`)
  }
  return {
    items: firstSeenIds.map((id) => latestById.get(id)!),
    rawCount,
    malformedCount
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8')
}
