import { describe, expect, test } from 'vitest'
import type { TurnItem } from '../../contracts/items.js'
import {
  buildHistoryTranscript,
  composeSdkPromptText,
  SDK_HISTORY_OMISSION_MARKER
} from './sdk-context-assembler.js'

function userMsg(turnId: string, text: string): TurnItem {
  return {
    id: `item_${turnId}_${text}`,
    threadId: 'th',
    turnId,
    kind: 'user_message',
    status: 'completed',
    text
  } as unknown as TurnItem
}

function assistantMsg(turnId: string, text: string): TurnItem {
  return {
    id: `item_${turnId}_a`,
    threadId: 'th',
    turnId,
    kind: 'assistant_text',
    status: 'completed',
    text
  } as unknown as TurnItem
}

function compaction(turnId: string, summary: string): TurnItem {
  return {
    id: `item_${turnId}_compact`,
    threadId: 'th',
    turnId,
    kind: 'compaction',
    role: 'system',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary,
    replacedTokens: 10_000,
    pinnedConstraints: []
  } as TurnItem
}

function toolPair(turnId: string, callId: string, text: string): TurnItem[] {
  return [{
    id: `item_${callId}`,
    threadId: 'th',
    turnId,
    kind: 'tool_call',
    role: 'assistant',
    status: 'completed',
    toolName: 'read',
    toolKind: 'tool_call',
    callId,
    arguments: { path: text }
  }, {
    id: `result_${callId}`,
    threadId: 'th',
    turnId,
    kind: 'tool_result',
    role: 'tool',
    status: 'completed',
    toolName: 'read',
    toolKind: 'tool_call',
    callId,
    output: text,
    isError: false
  }] as TurnItem[]
}

describe('buildHistoryTranscript', () => {
  test('returns empty string when there is no prior history', () => {
    const items = [userMsg('t2', 'only the current turn')]
    expect(buildHistoryTranscript(items, 't2')).toBe('')
  })

  test('excludes the current turn and renders prior turns as a transcript', () => {
    const items = [
      userMsg('t1', 'first question'),
      assistantMsg('t1', 'first answer'),
      userMsg('t2', 'current question')
    ]
    const transcript = buildHistoryTranscript(items, 't2')
    expect(transcript).toContain('[user] first question')
    expect(transcript).toContain('[assistant] first answer')
    // the live turn's own user text must NOT leak into the replayed history
    expect(transcript).not.toContain('current question')
  })

  test('keeps newest history and marks omitted older history at the byte limit', () => {
    const items = [
      userMsg('t1', `oldest-${'a'.repeat(1_800)}`),
      assistantMsg('t1', `old-answer-${'b'.repeat(1_800)}`),
      userMsg('t2', `recent-${'c'.repeat(900)}`),
      assistantMsg('t2', `latest-answer-${'d'.repeat(900)}`),
      userMsg('t3', 'current')
    ]
    const transcript = buildHistoryTranscript(items, 't3', 2_400)
    expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(2_400)
    expect(transcript).toContain(SDK_HISTORY_OMISSION_MARKER)
    expect(transcript).toContain('latest-answer')
    expect(transcript).not.toContain('oldest-')
    expect(transcript).not.toContain('current')
  })

  test('keeps the labeled tail of one oversized newest item instead of backfilling older text', () => {
    const transcript = buildHistoryTranscript([
      userMsg('t1', 'older-small-message-that-must-not-return'),
      assistantMsg('t2', `latest-start-${'x'.repeat(3_000)}-LATEST-END`),
      userMsg('t3', 'current')
    ], 't3', 1_024)
    expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(1_024)
    expect(transcript).toContain(SDK_HISTORY_OMISSION_MARKER)
    expect(transcript).toContain('[assistant] … ')
    expect(transcript).not.toContain('older-small-message-that-must-not-return')
  })

  test('pins the latest compaction summary and excludes replaced source history', () => {
    const items = [
      userMsg('t0', 'replaced source'),
      compaction('t1', 'authoritative compacted state'),
      userMsg('t2', 'recent decision'),
      assistantMsg('t2', 'recent outcome'),
      userMsg('t3', 'current')
    ]
    const transcript = buildHistoryTranscript(items, 't3', 2_048)
    expect(transcript).toContain('[earlier summary] authoritative compacted state')
    expect(transcript).toContain('recent decision')
    expect(transcript).not.toContain('replaced source')
  })

  test('keeps an oversized compaction summary byte-safe with an omission marker', () => {
    const transcript = buildHistoryTranscript([
      compaction('t1', `summary-${'界'.repeat(2_000)}`),
      userMsg('t2', 'current')
    ], 't2', 1_024)
    expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(1_024)
    expect(transcript).toContain('[earlier summary]')
    expect(transcript).toContain(SDK_HISTORY_OMISSION_MARKER)
  })

  test('never retains a tool result without its matching call', () => {
    const pair = toolPair('t2', 'call_recent', `recent-tool-${'x'.repeat(500)}`)
    const orphan: TurnItem = {
      ...(pair[1] as Extract<TurnItem, { kind: 'tool_result' }>),
      id: 'orphan_result',
      callId: 'missing_call',
      output: 'orphan-output'
    }
    const transcript = buildHistoryTranscript([
      userMsg('t1', `older-${'o'.repeat(1_800)}`),
      ...pair,
      orphan,
      userMsg('t3', 'current')
    ], 't3', 2_048)
    expect(transcript).toContain('[tool_call:read]')
    expect(transcript).toContain('[tool_result:read]')
    expect(transcript).not.toContain('orphan-output')
  })
})

describe('composeSdkPromptText', () => {
  test('collapses to the plain user text when there is no history or instructions', () => {
    expect(composeSdkPromptText({ userText: 'hello' })).toBe('hello')
  })

  test('wraps history, instructions, then the live request last', () => {
    const out = composeSdkPromptText({
      historyTranscript: '[user] earlier\n[assistant] reply',
      userText: 'do the thing',
      instructionBlocks: ['SKILLS: a, b', 'MEMORY: x']
    })
    expect(out).toContain('<prior_conversation>')
    expect(out).toContain('[assistant] reply')
    expect(out).toContain('SKILLS: a, b')
    expect(out).toContain('MEMORY: x')
    expect(out).toContain('Current request:\ndo the thing')
    // history precedes instructions, which precede the live request
    expect(out.indexOf('<prior_conversation>')).toBeLessThan(out.indexOf('SKILLS: a, b'))
    expect(out.indexOf('SKILLS: a, b')).toBeLessThan(out.indexOf('Current request:'))
  })

  test('omits empty sections and skips blank instruction blocks', () => {
    const out = composeSdkPromptText({
      userText: 'hi',
      instructionBlocks: ['', '   ', 'real block']
    })
    expect(out).toContain('real block')
    expect(out).toContain('Current request:\nhi')
    expect(out).not.toContain('<prior_conversation>')
  })
})
