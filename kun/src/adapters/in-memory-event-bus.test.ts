import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../contracts/events.js'
import { InMemoryEventBus } from './in-memory-event-bus.js'

function event(threadId: string, seq: number, message: string): RuntimeEvent {
  return {
    kind: 'error',
    threadId,
    seq,
    timestamp: '2026-07-31T00:00:00.000Z',
    message,
    code: 'test',
    severity: 'warning'
  }
}

describe('InMemoryEventBus retention budget', () => {
  it('publishes oversized events live without retaining them', () => {
    const bus = new InMemoryEventBus({ maxRetainedBytes: 256 })
    const observed: RuntimeEvent[] = []
    bus.subscribe('thread_1', (value) => observed.push(value))
    const large = event('thread_1', 1, 'x'.repeat(512))

    bus.publish(large)

    expect(observed).toEqual([large])
    expect(bus.snapshotSince('thread_1', 0)).toEqual([])
    expect(bus.highestSeq('thread_1')).toBe(1)
  })

  it('evicts globally when aggregate retained bytes exceed the budget', () => {
    const bus = new InMemoryEventBus({ maxRetainedBytes: 600 })
    bus.publish(event('thread_1', 1, 'a'.repeat(100)))
    bus.publish(event('thread_2', 1, 'b'.repeat(100)))
    bus.publish(event('thread_3', 1, 'c'.repeat(100)))
    bus.publish(event('thread_4', 1, 'd'.repeat(100)))

    expect(bus.snapshotSince('thread_1', 0)).toEqual([])
    expect(
      ['thread_2', 'thread_3', 'thread_4']
        .flatMap((threadId) => bus.snapshotSince(threadId, 0))
        .length
    ).toBeGreaterThan(0)
  })
})
