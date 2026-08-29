import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { makeToolResultItem } from '../domain/item.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'

describe('RuntimeEventRecorder transient events', () => {
  it('publishes live and persists only a private cursor checkpoint', async () => {
    const eventBus = new InMemoryEventBus()
    const sessionStore = new InMemorySessionStore()
    const recorder = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-07-31T00:00:00.000Z'
    })
    const item = makeToolResultItem({
      id: 'result_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'bash',
      output: { partial: true },
      status: 'running'
    })
    const observed: number[] = []
    eventBus.subscribe('thread_1', (event) => observed.push(event.seq))

    const transient = await recorder.publishTransient({
      kind: 'item_updated',
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: item.id,
      item
    })
    const durable = await recorder.record({
      kind: 'item_created',
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: item.id,
      item
    })

    expect(observed).toEqual([transient.seq, durable.seq])
    expect(durable.seq).toBeGreaterThan(transient.seq)
    const replay = await sessionStore.loadEventsSince('thread_1', 0)
    expect(replay).toEqual([durable])
    expect(await sessionStore.highestSeq('thread_1')).toBe(durable.seq)
  })

  it('does not reuse a transient sequence after the recorder restarts', async () => {
    const sessionStore = new InMemorySessionStore()
    const firstBus = new InMemoryEventBus()
    const first = new RuntimeEventRecorder({
      eventBus: firstBus,
      sessionStore,
      allocateSeq: (threadId) => firstBus.allocateSeq(threadId),
      nowIso: () => '2026-07-31T00:00:00.000Z'
    })
    const transient = await first.publishTransient({
      kind: 'error',
      threadId: 'thread_restart',
      message: 'live only'
    })

    const restartedBus = new InMemoryEventBus()
    const restarted = new RuntimeEventRecorder({
      eventBus: restartedBus,
      sessionStore,
      allocateSeq: (threadId) => restartedBus.allocateSeq(threadId),
      nowIso: () => '2026-07-31T00:00:01.000Z'
    })
    const durable = await restarted.record({
      kind: 'error',
      threadId: 'thread_restart',
      message: 'durable'
    })

    expect(durable.seq).toBeGreaterThan(transient.seq)
  })
})
