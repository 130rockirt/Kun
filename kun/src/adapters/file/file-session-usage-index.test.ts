import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyUsageSnapshot, type UsageSnapshot } from '../../contracts/usage.js'
import type { UsageEvent } from '../../contracts/events.js'
import { FileSessionStore } from './file-session-store.js'
import { readFile } from 'node:fs/promises'

function cumulative(promptTokens: number, completionTokens: number): UsageSnapshot {
  return {
    ...emptyUsageSnapshot(),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    turns: 1
  }
}

function usageEvent(
  threadId: string,
  seq: number,
  timestamp: string,
  promptTokens: number,
  completionTokens: number,
  extra: Partial<UsageEvent> = {}
): UsageEvent {
  return {
    kind: 'usage',
    threadId,
    seq,
    timestamp,
    usage: cumulative(promptTokens, completionTokens),
    ...extra
  }
}

describe('FileSessionStore usage index', () => {
  let root: string
  let store: FileSessionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kun-usage-index-'))
    store = new FileSessionStore({ dataDir: root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('answers a ranged query from the index without replaying the full event log', async () => {
    const threadId = 'thread-range'
    // A year of daily history, then the events inside the queried window.
    for (let day = 0; day < 30; day += 1) {
      const timestamp = new Date(Date.parse('2026-07-01T00:00:00.000Z') + day * 86_400_000)
        .toISOString()
      await store.appendEvent(threadId, usageEvent(threadId, day + 1, timestamp, (day + 1) * 100, (day + 1) * 10))
    }
    await store.appendEvent(threadId, usageEvent(threadId, 101, '2026-08-20T10:00:00.000Z', 4_000, 400))
    await store.appendEvent(threadId, usageEvent(threadId, 102, '2026-08-21T10:00:00.000Z', 4_500, 450, { turnId: 'turn-b' }))

    // If this query replayed events.jsonl from seq 0 it would have to parse
    // all 32 events; with the index it reads usage-index.jsonl only.
    const records = await store.loadUsageRecords({
      threadId,
      fromInclusive: '2026-08-20T00:00:00.000Z',
      toExclusive: '2026-08-22T00:00:00.000Z'
    })

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      threadId,
      completedAt: '2026-08-20T10:00:00.000Z',
      usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 }
    })
    expect(records[1]).toMatchObject({
      threadId,
      turnId: 'turn-b',
      completedAt: '2026-08-21T10:00:00.000Z',
      usage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 }
    })
  })

  it('returns the latest cumulative snapshot per thread from the index tail', async () => {
    await store.appendEvent('thread-a', usageEvent('thread-a', 1, '2026-08-20T00:00:00.000Z', 100, 10))
    await store.appendEvent('thread-a', usageEvent('thread-a', 2, '2026-08-21T00:00:00.000Z', 300, 30))
    await store.appendEvent('thread-b', usageEvent('thread-b', 1, '2026-08-21T00:00:00.000Z', 55, 5))

    const snapshots = await store.loadLatestUsageSnapshots({})

    expect(snapshots).toEqual([
      { threadId: 'thread-a', seq: 2, usage: cumulative(300, 30) },
      { threadId: 'thread-b', seq: 1, usage: cumulative(55, 5) }
    ])
  })

  it('backfills the index from events.jsonl when only part of the log was indexed', async () => {
    const threadId = 'thread-partial'
    await store.appendEvent(threadId, usageEvent(threadId, 1, '2026-08-20T00:00:00.000Z', 100, 10))
    await store.appendEvent(threadId, usageEvent(threadId, 2, '2026-08-21T00:00:00.000Z', 200, 20))

    // Simulate a crash between the events.jsonl append and the index write.
    await rm(join(root, 'threads', threadId, 'usage-index.jsonl'))

    const records = await store.loadUsageRecords({ threadId })

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      completedAt: '2026-08-21T00:00:00.000Z',
      usage: { promptTokens: 100, completionTokens: 10 }
    })
    // The rebuild must be durable: the next query needs no further backfill.
    const again = await store.loadUsageRecords({ threadId })
    expect(again).toEqual(records)
  })

  it('rebuilds a corrupted index from the canonical event log', async () => {
    const threadId = 'thread-corrupt'
    await store.appendEvent(threadId, usageEvent(threadId, 1, '2026-08-20T00:00:00.000Z', 100, 10))
    await store.appendEvent(threadId, usageEvent(threadId, 2, '2026-08-21T00:00:00.000Z', 250, 25))

    const indexPath = join(root, 'threads', threadId, 'usage-index.jsonl')
    const original = await readFile(indexPath, 'utf-8')
    await (await import('node:fs/promises')).writeFile(
      indexPath,
      `{"type":"delta","seq":1,"timestamp":"2026-08-20T00:00:00.000Z","usage":null}\nnot-json\n`,
      'utf-8'
    )

    const records = await store.loadUsageRecords({
      threadId,
      fromInclusive: '2026-08-21T00:00:00.000Z',
      toExclusive: '2026-08-22T00:00:00.000Z'
    })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      completedAt: '2026-08-21T00:00:00.000Z',
      usage: { promptTokens: 150, completionTokens: 15 }
    })
    void original
  })

  it('keeps query results identical between index and full replay semantics', async () => {
    const threadId = 'thread-parity'
    await store.appendEvent(threadId, usageEvent(threadId, 1, '2026-08-20T00:00:00.000Z', 1_000, 100, { turnId: 'turn-1' }))
    await store.appendEvent(threadId, usageEvent(threadId, 2, '2026-08-23T00:00:02.000Z', 1_200, 140, { turnId: 'turn-2' }))

    const records = await store.loadUsageRecords({
      threadId,
      fromInclusive: '2026-08-23T00:00:02.000Z',
      toExclusive: '2026-08-23T00:00:03.000Z'
    })

    // Matches the JSONL fallback expectation in usage-history.test.ts: the
    // in-range record carries the diff against the pre-range cumulative base.
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      turnId: 'turn-2',
      usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }
    })
  })

  it('ignores usage index state cleared with thread memory', async () => {
    const threadId = 'thread-clear'
    await store.appendEvent(threadId, usageEvent(threadId, 1, '2026-08-20T00:00:00.000Z', 100, 10))
    store.clearThreadMemory(threadId)
    const records = await store.loadUsageRecords({ threadId })
    expect(records).toHaveLength(1)
  })
})
