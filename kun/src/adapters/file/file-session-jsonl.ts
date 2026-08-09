import { createReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { RuntimeEvent } from '../../contracts/events.js'
import { isPublicTurnItem, type TurnItem } from '../../contracts/items.js'
import type { ItemHistoryPage, ItemHistoryPageOptions } from '../../ports/session-store.js'
import { buildPublicItemHistoryPage, timelineSafeItem } from '../../services/item-history-page.js'

const MS_PER_DAY = 86_400_000
const DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES = 16 * 1024 * 1024

export function compactUsageEvents(
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

export function parseReplayEventRecord(line: string, maxRecordBytes: number): RuntimeEvent | null {
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

export function warnUsageCompaction(threadId: string, error: unknown): void {
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

/**
 * Scan an append-only item log without retaining every item payload. A set of
 * stable ids preserves first-seen ordering, while each rolling window keeps at
 * most one page plus a sentinel used to derive `hasMore`.
 */
export async function readItemPageFromJsonl(
  handle: FileHandle,
  sourceBytes: number,
  options: ItemHistoryPageOptions
): Promise<ItemHistoryPage> {
  const maxItems = Math.max(1, Math.floor(options.maxItems))
  const maxBytes = Math.max(1, Math.floor(options.maxBytes))
  const seenIds = new Set<string>()
  const latestWindow = createItemPageWindow()
  const beforeWindow = createItemPageWindow()
  let beforeFound = options.before === undefined
  let remainder = ''

  const acceptLine = (line: string): void => {
    if (!line.trim()) return
    if (Buffer.byteLength(line, 'utf-8') > DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES) {
      throw new Error(`item history record exceeds ${DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES} bytes`)
    }
    let item: TurnItem
    try {
      item = JSON.parse(line) as TurnItem
    } catch {
      return
    }
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) return

    const safeItem = isPublicTurnItem(item) ? timelineSafeItem(item, maxBytes) : item
    const firstSeen = !seenIds.has(item.id)
    if (firstSeen) {
      seenIds.add(item.id)
      if (isPublicTurnItem(item)) {
        appendPageWindowItem(latestWindow, safeItem, maxItems, maxBytes)
      }
      if (!beforeFound && item.id === options.before) {
        beforeFound = true
      } else if (!beforeFound && isPublicTurnItem(item)) {
        appendPageWindowItem(beforeWindow, safeItem, maxItems, maxBytes)
      }
      return
    }

    // Updates are appended after the original record. Refresh a retained
    // candidate in place so terminal state is current without moving its
    // original timeline position.
    if (isPublicTurnItem(item)) {
      updatePageWindowItem(latestWindow, safeItem, maxItems, maxBytes)
      updatePageWindowItem(beforeWindow, safeItem, maxItems, maxBytes)
    }
  }

  try {
    const stream = handle.createReadStream({
      encoding: 'utf-8',
      start: 0,
      end: sourceBytes - 1,
      autoClose: true,
      highWaterMark: 64 * 1024
    })
    for await (const chunk of stream) {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      let newline = remainder.indexOf('\n')
      while (newline >= 0) {
        acceptLine(remainder.slice(0, newline))
        remainder = remainder.slice(newline + 1)
        newline = remainder.indexOf('\n')
      }
      if (Buffer.byteLength(remainder, 'utf-8') > DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES) {
        throw new Error(`item history record exceeds ${DEFAULT_ITEM_HISTORY_MAX_RECORD_BYTES} bytes`)
      }
    }
    acceptLine(remainder)
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }

  const selectedWindow = options.before && beforeFound ? beforeWindow : latestWindow
  const page = buildPublicItemHistoryPage(
    selectedWindow.ids.flatMap((id) => {
      const item = selectedWindow.items.get(id)
      return item ? [item] : []
    }),
    { maxItems, maxBytes }
  )
  if (selectedWindow.droppedBefore && page.items[0]) {
    return { ...page, nextCursor: page.items[0].id, hasMore: true }
  }
  return page
}

type ItemPageWindow = {
  ids: string[]
  items: Map<string, TurnItem>
  itemBytes: number
  droppedBefore: boolean
}

function createItemPageWindow(): ItemPageWindow {
  return { ids: [], items: new Map(), itemBytes: 0, droppedBefore: false }
}

function appendPageWindowItem(
  window: ItemPageWindow,
  item: TurnItem,
  maxItems: number,
  maxBytes: number
): void {
  window.ids.push(item.id)
  window.items.set(item.id, item)
  window.itemBytes += serializedBytes(item)
  trimPageWindow(window, maxItems, maxBytes)
}

function updatePageWindowItem(
  window: ItemPageWindow,
  item: TurnItem,
  maxItems: number,
  maxBytes: number
): void {
  const previous = window.items.get(item.id)
  if (!previous) return
  window.items.set(item.id, item)
  window.itemBytes += serializedBytes(item) - serializedBytes(previous)
  trimPageWindow(window, maxItems, maxBytes)
}

function trimPageWindow(
  window: ItemPageWindow,
  maxItems: number,
  maxBytes: number
): void {
  while (
    window.ids.length > maxItems ||
    (window.itemBytes > maxBytes && window.ids.length > 1)
  ) {
    const removed = window.ids.shift()
    if (!removed) break
    const removedItem = window.items.get(removed)
    if (removedItem) window.itemBytes -= serializedBytes(removedItem)
    window.items.delete(removed)
    window.droppedBefore = true
  }
}

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8')
}
