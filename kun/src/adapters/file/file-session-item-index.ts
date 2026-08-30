import { createReadStream } from 'node:fs'
import { appendFile, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises'
import { TurnItem as TurnItemSchema, isPublicTurnItem, type TurnItem } from '../../contracts/items.js'
import type { ItemHistoryPage, ItemHistoryPageOptions } from '../../ports/session-store.js'
import { timelineSafeItem } from '../../services/item-history-page.js'
import { atomicWriteFile } from './atomic-write.js'
import { ITEM_HISTORY_MAX_RECORD_BYTES } from './file-session-live-items.js'
import { ensureItemTailReady } from './file-session-item-tail.js'

const INDEX_VERSION = 3
const INDEX_MAX_BYTES = 32 * 1024 * 1024
const SCAN_CHUNK_BYTES = 64 * 1024

type ItemIndexRow = {
  itemId: string
  turnId: string
  kind: TurnItem['kind']
  isPublic: boolean
  baseline: boolean
  offset: number
  recordBytes: number
}

type ItemIndexState = {
  version: 3
  tailReady: true
  sourceBytes: number
  sourceMtimeMs: number
  sourceDev: number
  sourceIno: number
  rowCount: number
  kindCounts: Record<string, number>
  baselineCount: number
}

export class FileSessionItemIndex {
  private readonly rebuilds = new Map<string, Promise<void>>()
  private readonly verifiedItemTails = new Set<string>()

  async append(input: {
    sourcePath: string
    indexPath: string
    statePath: string
    threadId: string
    evidencePath: string
    item: TurnItem
    record: string
  }): Promise<void> {
    await ensureItemTailReady({
      verified: this.verifiedItemTails,
      threadId: input.threadId,
      path: input.sourcePath,
      evidencePath: input.evidencePath
    })
    const before = await stat(input.sourcePath).catch(() => null)
    const offset = before?.size ?? 0
    await appendFile(input.sourcePath, `${input.record}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      const state = await readIndexState(input.statePath)
      const canExtend = offset === 0
        ? !state || state.sourceBytes === 0
        : Boolean(state && state.sourceBytes === offset && sourceMatches(before, state))
      if (!canExtend) {
        await this.invalidate(input.indexPath, input.statePath)
        return
      }
      const row = rowForItem(input.item, offset, Buffer.byteLength(input.record, 'utf8'))
      await appendFile(input.indexPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 })
      const after = await stat(input.sourcePath)
      await atomicWriteFile(input.statePath, JSON.stringify({
        version: INDEX_VERSION,
        tailReady: true,
        sourceBytes: after.size,
        sourceMtimeMs: after.mtimeMs,
        sourceDev: after.dev,
        sourceIno: after.ino,
        rowCount: (state?.rowCount ?? 0) + 1,
        kindCounts: {
          ...(state?.kindCounts ?? {}),
          [input.item.kind]: (state?.kindCounts[input.item.kind] ?? 0) + 1
        },
        baselineCount: (state?.baselineCount ?? 0) + (isBaselineItem(input.item) ? 1 : 0)
      } satisfies ItemIndexState))
    } catch (error) {
      await this.invalidate(input.indexPath, input.statePath)
      console.warn(`[kun] item history index append deferred: ${errorMessage(error)}`)
    }
  }

  async loadPage(input: {
    sourcePath: string
    indexPath: string
    statePath: string
    options: ItemHistoryPageOptions
  }): Promise<ItemHistoryPage | null> {
    const source = await stat(input.sourcePath).catch(() => null)
    if (!source) return { items: [], hasMore: false, itemBytes: 0 }
    const state = await readIndexState(input.statePath)
    if (!state || !sourceMatches(source, state)) return null
    const rows = await readIndexRows(input.indexPath, state.rowCount)
    if (!rows || rows.length !== state.rowCount) return null
    return readIndexedPage(input.sourcePath, rows, input.options)
  }

  async rebuild(input: {
    sourcePath: string
    indexPath: string
    statePath: string
    threadId: string
    evidencePath: string
  }): Promise<{ rawCount: number; uniqueCount: number; canonicalBytes: number }> {
    await ensureItemTailReady({
      verified: this.verifiedItemTails,
      threadId: input.threadId,
      path: input.sourcePath,
      evidencePath: input.evidencePath
    })
    const before = await stat(input.sourcePath).catch(() => null)
    if (!before) {
      await this.invalidate(input.indexPath, input.statePath)
      return { rawCount: 0, uniqueCount: 0, canonicalBytes: 0 }
    }
    const rows: ItemIndexRow[] = []
    const latest = new Map<string, number>()
    let canonicalBytes = 0
    for await (const record of scanItemRecords(input.sourcePath)) {
      rows.push(rowForItem(record.item, record.offset, record.recordBytes))
      latest.set(record.item.id, record.recordBytes)
    }
    for (const bytes of latest.values()) canonicalBytes += bytes + 1
    const after = await stat(input.sourcePath).catch(() => null)
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('item history changed during index rebuild')
    }
    await writeIndexFiles(input.indexPath, input.statePath, rows, after)
    return { rawCount: rows.length, uniqueCount: latest.size, canonicalBytes }
  }

  scheduleRebuild(input: {
    sourcePath: string
    indexPath: string
    statePath: string
    threadId: string
    evidencePath: string
  }): void {
    if (this.rebuilds.has(input.sourcePath)) return
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.rebuild(input))
      .then(() => undefined)
      .catch((error) => {
        console.warn(`[kun] item history index rebuild deferred: ${errorMessage(error)}`)
      })
      .finally(() => this.rebuilds.delete(input.sourcePath))
    this.rebuilds.set(input.sourcePath, run)
  }

  async flushRebuilds(): Promise<void> {
    await Promise.all([...this.rebuilds.values()])
  }

  clear(): void {
    this.rebuilds.clear()
    this.verifiedItemTails.clear()
  }

  async replaceForItems(input: {
    sourcePath: string
    indexPath: string
    statePath: string
    items: readonly TurnItem[]
  }): Promise<void> {
    const source = await stat(input.sourcePath).catch(() => null)
    if (!source) {
      await this.invalidate(input.indexPath, input.statePath)
      return
    }
    let offset = 0
    const rows = input.items.map((item) => {
      const recordBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
      const row = rowForItem(item, offset, recordBytes)
      offset += recordBytes + 1
      return row
    })
    if (offset !== source.size) {
      await this.invalidate(input.indexPath, input.statePath)
      return
    }
    await writeIndexFiles(input.indexPath, input.statePath, rows, source)
  }

  invalidate(indexPath: string, statePath: string): Promise<void> {
    return Promise.all([
      rm(indexPath, { force: true }),
      rm(statePath, { force: true })
    ]).then(() => undefined)
  }
}

async function readIndexedPage(
  sourcePath: string,
  rows: readonly ItemIndexRow[],
  options: ItemHistoryPageOptions
): Promise<ItemHistoryPage> {
  const latest = new Map<string, ItemIndexRow>()
  const order: string[] = []
  for (const row of rows) {
    if (!latest.has(row.itemId)) order.push(row.itemId)
    latest.set(row.itemId, row)
  }
  const publicRows = order.map((id) => latest.get(id)!).filter((row) => row.isPublic)
  const cursorIndex = options.before
    ? publicRows.findIndex((row) => row.itemId === options.before)
    : publicRows.length
  const endExclusive = cursorIndex >= 0 ? cursorIndex : publicRows.length
  const selected: Array<{ item: TurnItem; index: number; bytes: number }> = []
  let itemBytes = 0
  let windowStartIndex = endExclusive
  const handle = await open(sourcePath, 'r')
  try {
    for (let index = endExclusive - 1; index >= 0 && selected.length < options.maxItems; index -= 1) {
      const item = timelineSafeItem(await readIndexedItem(handle, publicRows[index]!), options.maxBytes)
      const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
      if (selected.length > 0 && itemBytes + bytes > options.maxBytes) break
      selected.push({ item, index, bytes })
      itemBytes += bytes
      windowStartIndex = index
    }
    selected.reverse()

    let anchorIndex = -1
    if (!options.before && options.anchorTurnId) {
      anchorIndex = publicRows.findIndex(
        (row) => row.turnId === options.anchorTurnId && row.kind === 'user_message'
      )
      if (anchorIndex >= 0 && anchorIndex < windowStartIndex) {
        const item = timelineSafeItem(await readIndexedItem(handle, publicRows[anchorIndex]!), options.maxBytes)
        const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
        while (
          selected.length > 0 &&
          (selected.length + 1 > options.maxItems || itemBytes + bytes > options.maxBytes)
        ) {
          itemBytes -= selected.shift()!.bytes
          windowStartIndex += 1
        }
        selected.unshift({ item, index: anchorIndex, bytes })
        itemBytes += bytes
      } else {
        anchorIndex = -1
      }
    }
    const anchored = anchorIndex >= 0
    const cursorItem = anchored && selected.length > 1 ? selected[1] : selected[0]
    const boundaryIndex = anchored && selected.length > 1
      ? windowStartIndex
      : (anchored ? anchorIndex : windowStartIndex)
    const hasMore = boundaryIndex > 0
    return {
      items: selected.map((entry) => entry.item),
      ...(hasMore && cursorItem ? { nextCursor: cursorItem.item.id } : {}),
      hasMore,
      itemBytes
    }
  } finally {
    await handle.close()
  }
}

async function readIndexedItem(handle: FileHandle, row: ItemIndexRow): Promise<TurnItem> {
  if (row.recordBytes <= 0 || row.recordBytes > ITEM_HISTORY_MAX_RECORD_BYTES) {
    throw new Error(`invalid indexed item record length: ${row.recordBytes}`)
  }
  const buffer = Buffer.alloc(row.recordBytes)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, row.offset)
  if (bytesRead !== buffer.length) throw new Error('indexed item record is truncated')
  return TurnItemSchema.parse(JSON.parse(buffer.toString('utf8')))
}

async function readIndexRows(path: string, expectedRows: number): Promise<ItemIndexRow[] | null> {
  const info = await stat(path).catch(() => null)
  if (!info || info.size > INDEX_MAX_BYTES) return null
  try {
    const rows = (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => parseIndexRow(JSON.parse(line)))
    return rows.length === expectedRows && rows.every(Boolean)
      ? rows as ItemIndexRow[]
      : null
  } catch {
    return null
  }
}

async function readIndexState(path: string): Promise<ItemIndexState | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ItemIndexState>
    if (
      value.version !== INDEX_VERSION ||
      value.tailReady !== true ||
      !Number.isSafeInteger(value.sourceBytes) ||
      !Number.isFinite(value.sourceMtimeMs) ||
      !Number.isSafeInteger(value.sourceDev) ||
      !Number.isSafeInteger(value.sourceIno) ||
      !Number.isSafeInteger(value.rowCount)
    ) return null
    return {
      ...(value as ItemIndexState),
      kindCounts: value.kindCounts && typeof value.kindCounts === 'object'
        ? value.kindCounts
        : {},
      baselineCount: Number.isSafeInteger(value.baselineCount) ? value.baselineCount! : 0
    }
  } catch {
    return null
  }
}

async function writeIndexFiles(
  indexPath: string,
  statePath: string,
  rows: readonly ItemIndexRow[],
  source: { size: number; mtimeMs: number; dev: number; ino: number }
): Promise<void> {
  const contents = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''
  await atomicWriteFile(indexPath, contents)
  await atomicWriteFile(statePath, JSON.stringify({
    version: INDEX_VERSION,
    tailReady: true,
    sourceBytes: source.size,
    sourceMtimeMs: source.mtimeMs,
    sourceDev: source.dev,
    sourceIno: source.ino,
    rowCount: rows.length,
    kindCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.kind] = (counts[row.kind] ?? 0) + 1
      return counts
    }, {}),
    baselineCount: rows.filter((row) => row.baseline).length
  } satisfies ItemIndexState))
}

async function* scanItemRecords(path: string): AsyncIterable<{
  item: TurnItem
  offset: number
  recordBytes: number
}> {
  let pending = Buffer.alloc(0)
  let pendingOffset = 0
  for await (const raw of createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    let newline = pending.indexOf(0x0a)
    while (newline >= 0) {
      const line = pending.subarray(0, newline)
      if (line.length > ITEM_HISTORY_MAX_RECORD_BYTES) {
        throw new Error(`item history record exceeds ${ITEM_HISTORY_MAX_RECORD_BYTES} bytes`)
      }
      if (line.length > 0) {
        const item = TurnItemSchema.parse(JSON.parse(line.toString('utf8')))
        yield { item, offset: pendingOffset, recordBytes: line.length }
      }
      pending = pending.subarray(newline + 1)
      pendingOffset += newline + 1
      newline = pending.indexOf(0x0a)
    }
    if (pending.length > ITEM_HISTORY_MAX_RECORD_BYTES) {
      throw new Error(`item history record exceeds ${ITEM_HISTORY_MAX_RECORD_BYTES} bytes`)
    }
  }
  if (pending.length > 0) throw new Error('item history has an unterminated trailing record')
}

function rowForItem(item: TurnItem, offset: number, recordBytes: number): ItemIndexRow {
  return {
    itemId: item.id,
    turnId: item.turnId,
    kind: item.kind,
    isPublic: isPublicTurnItem(item),
    baseline: isBaselineItem(item),
    offset,
    recordBytes
  }
}

function parseIndexRow(value: unknown): ItemIndexRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Partial<ItemIndexRow>
  if (
    typeof row.itemId !== 'string' ||
    typeof row.turnId !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.isPublic !== 'boolean' ||
    !Number.isSafeInteger(row.offset) ||
    !Number.isSafeInteger(row.recordBytes)
  ) return null
  return { ...(row as ItemIndexRow), baseline: row.baseline === true }
}

function sourceMatches(
  source: { size: number; mtimeMs: number; dev: number; ino: number } | null,
  state: ItemIndexState
): boolean {
  return Boolean(
    source &&
    source.size === state.sourceBytes &&
    source.mtimeMs === state.sourceMtimeMs &&
    source.dev === state.sourceDev &&
    source.ino === state.sourceIno
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isBaselineItem(item: TurnItem): boolean {
  return item.kind === 'model_context' && 'baseline' in item && item.baseline === true
}
