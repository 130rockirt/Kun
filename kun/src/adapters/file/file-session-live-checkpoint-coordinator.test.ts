import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAssistantReasoningItem } from '../../domain/item.js'
import { FileSessionStore } from './file-session-store.js'
import {
  LIVE_ITEM_CHECKPOINT_MAX_AGE_MS,
  LIVE_ITEM_CHECKPOINT_MAX_EVENTS
} from './file-session-live-checkpoint-coordinator.js'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function representedSeq(text: string): number {
  return JSON.parse(text).entries[0].representedSeq as number
}

describe('FileSession live checkpoint coordination', () => {
  it('flushes by event count without entering the durable path for every delta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-live-checkpoint-events-'))
    roots.push(root)
    const store = new FileSessionStore({ dataDir: root })
    const path = join(root, 'threads', 'thread-live', 'live-items.json')
    const item = (seq: number) => makeAssistantReasoningItem({
      id: 'reasoning', threadId: 'thread-live', turnId: 'turn-live',
      status: 'running', text: `reasoning-${seq}`
    })
    await store.checkpointLiveItem('thread-live', item(0), 0)
    for (let seq = 1; seq < LIVE_ITEM_CHECKPOINT_MAX_EVENTS; seq += 1) {
      await store.checkpointLiveItem('thread-live', item(seq), seq)
    }
    expect(representedSeq(await readFile(path, 'utf8'))).toBe(0)
    await store.checkpointLiveItem(
      'thread-live', item(LIVE_ITEM_CHECKPOINT_MAX_EVENTS), LIVE_ITEM_CHECKPOINT_MAX_EVENTS
    )
    expect(representedSeq(await readFile(path, 'utf8'))).toBe(LIVE_ITEM_CHECKPOINT_MAX_EVENTS)
    await store.close()
  })

  it('flushes a low-volume checkpoint by age and on shutdown', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'kun-live-checkpoint-age-'))
    roots.push(root)
    const store = new FileSessionStore({ dataDir: root })
    const path = join(root, 'threads', 'thread-age', 'live-items.json')
    const item = (text: string) => makeAssistantReasoningItem({
      id: 'reasoning', threadId: 'thread-age', turnId: 'turn-age', status: 'running', text
    })
    await store.checkpointLiveItem('thread-age', item('a'), 0)
    await store.checkpointLiveItem('thread-age', item('ab'), 1)
    await vi.advanceTimersByTimeAsync(LIVE_ITEM_CHECKPOINT_MAX_AGE_MS)
    await store.checkpointLiveItem('thread-age', item('ab'), 1)
    expect(representedSeq(await readFile(path, 'utf8'))).toBe(1)
    await store.checkpointLiveItem('thread-age', item('abc'), 2)
    await store.close()
    expect(representedSeq(await readFile(path, 'utf8'))).toBe(2)
  })
})
