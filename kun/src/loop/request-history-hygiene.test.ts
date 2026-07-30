import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import { applyRequestHistoryHygiene } from './request-history-hygiene.js'

function toolResult(id: string, output: unknown, isError = false): TurnItem {
  return {
    id: `item_${id}`,
    turnId: 'turn_1',
    threadId: 'thread_1',
    role: 'tool',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    toolName: 'read',
    callId: id,
    toolKind: 'tool_call',
    output,
    isError
  } as TurnItem
}

function toolCall(id: string, argument: string): TurnItem {
  return {
    id: `call_${id}`,
    turnId: 'turn_1',
    threadId: 'thread_1',
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'tool_call',
    toolName: 'design_component',
    callId: id,
    toolKind: 'file_change',
    arguments: { html: argument }
  } as TurnItem
}

describe('applyRequestHistoryHygiene cumulative tool-result budget', () => {
  it('preserves the current source page atomically', () => {
    const source = toolResult('read', {
      content: 'x'.repeat(10_000),
      start_line: 1,
      end_line: 2,
      total_lines: 2
    }) as Extract<TurnItem, { kind: 'tool_result' }>
    source.toolName = 'read'
    const out = applyRequestHistoryHygiene([source], { maxToolResultBytes: 512, maxToolResultTokens: 128 })
    expect(out[0]).toEqual(source)
  })

  it('does not treat unstructured read output as an atomic source page', () => {
    const source = toolResult('read', { content: '汉'.repeat(9_000) })
    const out = applyRequestHistoryHygiene([source], {
      maxToolResultBytes: 32 * 1024,
      maxToolResultTokens: 4_000
    })
    expect(out[0]).not.toBe(source)
    expect(out[0]?.kind === 'tool_result'
      ? String((out[0].output as { content?: string }).content)
      : '').toContain('cache hygiene')
  })
  it('collapses older tool results once the cumulative budget is exhausted', () => {
    // Each result is ~250 ASCII tokens (1000 chars / 4). With a 600-token
    // budget and keepRecent=1, only the most recent couple should survive
    // verbatim; older ones become a one-line digest.
    const big = 'x'.repeat(1000)
    const items = [
      toolResult('a', big),
      toolResult('b', big),
      toolResult('c', big),
      toolResult('d', big)
    ]
    const out = applyRequestHistoryHygiene(items, {
      maxCumulativeToolResultTokens: 600,
      keepRecentToolResults: 1,
      // Keep per-result limits high so only the cumulative pass acts here.
      maxToolResultTokens: 100_000,
      maxToolResultBytes: 10_000_000,
      maxToolResultLines: 100_000
    })
    const outputs = out.map((item) => (item.kind === 'tool_result' ? String(item.output) : ''))
    // Newest (d) is always kept verbatim.
    expect(outputs[3]).toBe(big)
    // Oldest (a) must be collapsed to a digest marker.
    expect(outputs[0]).toContain('cache hygiene')
    expect(outputs[0]).not.toBe(big)
  })

  it('keeps everything when under budget', () => {
    const small = 'hello world'
    const items = [toolResult('a', small), toolResult('b', small)]
    const out = applyRequestHistoryHygiene(items, {
      maxCumulativeToolResultTokens: 100_000,
      keepRecentToolResults: 4
    })
    expect(out).toBe(items)
  })

  it('does nothing when no cumulative cap is configured', () => {
    const big = 'y'.repeat(5000)
    const items = [toolResult('a', big), toolResult('b', big)]
    const out = applyRequestHistoryHygiene(items, {
      maxCumulativeToolResultTokens: 0,
      maxToolResultTokens: 100_000,
      maxToolResultBytes: 10_000_000,
      maxToolResultLines: 100_000
    })
    expect(out).toBe(items)
  })

  it('preserves large arguments for failed tool calls so the next model step can repair them', () => {
    const html = `<!doctype html>${'x'.repeat(12_000)}`
    const items = [
      toolCall('failed', html),
      toolResult('failed', 'component prototype is invalid', true)
    ]

    const out = applyRequestHistoryHygiene(items, {
      maxToolArgumentStringBytes: 512,
      maxToolArgumentStringTokens: 128
    })

    expect(out[0]?.kind === 'tool_call' ? out[0].arguments.html : '').toBe(html)
  })

  it('compacts failed shell transcripts when the error result carries repair evidence', () => {
    const items = [
      {
        ...toolCall('failed-shell', 'ignored'),
        toolName: 'bash',
        arguments: { command: 'npm test', transcript: 'x'.repeat(12_000) }
      } as TurnItem,
      {
        ...toolResult('failed-shell', 'ERROR test failed', true),
        toolName: 'bash'
      } as TurnItem
    ]
    const out = applyRequestHistoryHygiene(items)
    expect(out[0]?.kind === 'tool_call' ? out[0].arguments.transcript : '')
      .toContain('cache hygiene')
  })

  it('still compacts large arguments after a successful tool result', () => {
    const html = `<!doctype html>${'x'.repeat(12_000)}`
    const items = [
      toolCall('completed', html),
      toolResult('completed', 'published')
    ]

    const out = applyRequestHistoryHygiene(items, {
      maxToolArgumentStringBytes: 512,
      maxToolArgumentStringTokens: 128
    })

    expect(out[0]?.kind === 'tool_call' ? out[0].arguments.html : '')
      .toContain('cache hygiene: omitted completed design_component.html argument')
  })
})
