import { describe, expect, it } from 'vitest'
import {
  ToolCancellationRegistry,
  ToolExecutionCancelledError
} from './tool-cancellation-registry.js'

describe('ToolCancellationRegistry', () => {
  it('isolates a child cancellation from the parent and sibling tools', () => {
    const registry = new ToolCancellationRegistry()
    const parent = new AbortController()
    const first = registry.register(
      { threadId: 'thread', turnId: 'turn', callId: 'first' },
      parent.signal
    )
    const second = registry.register(
      { threadId: 'thread', turnId: 'turn', callId: 'second' },
      parent.signal
    )

    expect(registry.request(
      { threadId: 'thread', turnId: 'turn', callId: 'first' },
      '2026-08-07T00:00:00.000Z'
    )).toBe('cancellation_requested')
    expect(first.signal.aborted).toBe(true)
    expect(first.wasCancelledByUser()).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(registry.request(
      { threadId: 'thread', turnId: 'turn', callId: 'first' },
      '2026-08-07T00:00:01.000Z'
    )).toBe('already_requested')
  })

  it('propagates a parent turn abort without treating it as a user tool cancel', () => {
    const registry = new ToolCancellationRegistry()
    const parent = new AbortController()
    const child = registry.register(
      { threadId: 'thread', turnId: 'turn', callId: 'call' },
      parent.signal
    )

    parent.abort(new Error('turn interrupted'))

    expect(child.signal.aborted).toBe(true)
    expect(child.wasCancelledByUser()).toBe(false)
    expect(registry.request(
      { threadId: 'thread', turnId: 'turn', callId: 'call' },
      '2026-08-07T00:00:00.000Z'
    )).toBe('turn_aborted')
    expect(ToolExecutionCancelledError).toBeDefined()
  })

  it('removes handles when a tool settles', () => {
    const registry = new ToolCancellationRegistry()
    const registration = registry.register(
      { threadId: 'thread', turnId: 'turn', callId: 'call' },
      new AbortController().signal
    )
    registration.dispose()
    expect(registry.has({ threadId: 'thread', turnId: 'turn', callId: 'call' })).toBe(false)
    expect(registry.list()).toEqual([])
  })
})
