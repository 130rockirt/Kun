import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import { repairModelHistoryItems } from './model-history-repair.js'

const CREATED_AT = '2026-08-06T00:00:00.000Z'

function assistant(id: string, kind: 'assistant_text' | 'assistant_reasoning' = 'assistant_text'): TurnItem {
  return {
    id,
    kind,
    turnId: 'turn-1',
    threadId: 'thread-1',
    role: 'assistant',
    status: 'completed',
    createdAt: CREATED_AT,
    text: kind === 'assistant_text' ? 'I will use the tool.' : 'private reasoning'
  }
}

function call(id: string, callId: string, patch: Partial<TurnItem> = {}): TurnItem {
  return {
    id,
    kind: 'tool_call',
    turnId: 'turn-1',
    threadId: 'thread-1',
    role: 'assistant',
    status: 'completed',
    createdAt: CREATED_AT,
    toolName: 'read_file',
    toolKind: 'tool_call',
    callId,
    arguments: {},
    ...patch
  } as TurnItem
}

function result(id: string, callId: string, patch: Partial<TurnItem> = {}): TurnItem {
  return {
    id,
    kind: 'tool_result',
    turnId: 'turn-1',
    threadId: 'thread-1',
    role: 'tool',
    status: 'completed',
    createdAt: CREATED_AT,
    toolName: 'read_file',
    toolKind: 'tool_call',
    callId,
    output: 'ok',
    isError: false,
    ...patch
  } as TurnItem
}

describe('repairModelHistoryItems', () => {
  it('drops an entire assistant tool-call round when one result is missing', () => {
    const repaired = repairModelHistoryItems([
      assistant('reasoning', 'assistant_reasoning'),
      assistant('text'),
      call('call-a', 'a'),
      call('call-b', 'b'),
      result('result-a', 'a')
    ])

    expect(repaired).toEqual([])
  })

  it.each([
    ['duplicate result', [call('call-a', 'a'), result('result-a', 'a'), result('result-a-2', 'a')]],
    ['cross-turn result', [call('call-a', 'a'), result('result-a', 'a', { turnId: 'turn-2' })]],
    ['aborted call', [call('call-a', 'a', { status: 'aborted' }), result('result-a', 'a')]],
    ['running result', [call('call-a', 'a'), result('result-a', 'a', { status: 'running' })]],
    ['failed result without an error marker', [
      call('call-a', 'a', { status: 'failed' }),
      result('result-a', 'a', { status: 'failed', isError: false })
    ]]
  ])('drops a group with a %s', (_label, items) => {
    expect(repairModelHistoryItems(items)).toEqual([])
  })

  it('retains a complete failed call and error result as a valid pair', () => {
    const items = [
      call('call-a', 'a', { status: 'failed' }),
      result('result-a', 'a', { status: 'failed', isError: true })
    ]

    expect(repairModelHistoryItems(items)).toBe(items)
  })

  it('does not scan through a record after results to rescue a later result', () => {
    const items = [
      call('call-a', 'a'),
      call('call-b', 'b'),
      result('result-a', 'a'),
      { ...assistant('intervening'), turnId: 'turn-1' },
      result('result-b', 'b')
    ]

    expect(repairModelHistoryItems(items)).toEqual([items[3]])
  })

  it('repairs a long complete history in a single forward pass', () => {
    const items: TurnItem[] = []
    for (let index = 0; index < 20_000; index += 1) {
      items.push(call(`call-${index}`, `call-${index}`), result(`result-${index}`, `call-${index}`))
    }

    expect(repairModelHistoryItems(items)).toBe(items)
  })
})
