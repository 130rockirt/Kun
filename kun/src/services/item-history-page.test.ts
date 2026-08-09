import { describe, expect, it } from 'vitest'
import { makeToolResultItem, makeUserItem } from '../domain/item.js'
import type { TurnItem } from '../contracts/items.js'
import { buildPublicItemHistoryPage } from './item-history-page.js'

describe('buildPublicItemHistoryPage', () => {
  it('returns chronological pages from the newest items with a stable older cursor', () => {
    const items = Array.from({ length: 350 }, (_, index) => makeUserItem({
      id: `item_${String(index).padStart(3, '0')}`,
      threadId: 'thr_page',
      turnId: `turn_${Math.floor(index / 2)}`,
      text: `message ${index}`
    }))

    const latest = buildPublicItemHistoryPage(items, {
      maxItems: 300,
      maxBytes: 4 * 1024 * 1024
    })
    expect(latest.items).toHaveLength(300)
    expect(latest.items[0]?.id).toBe('item_050')
    expect(latest.items.at(-1)?.id).toBe('item_349')
    expect(latest).toMatchObject({ hasMore: true, nextCursor: 'item_050' })

    const older = buildPublicItemHistoryPage(items, {
      before: latest.nextCursor,
      maxItems: 300,
      maxBytes: 4 * 1024 * 1024
    })
    expect(older.items.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `item_${String(index).padStart(3, '0')}`)
    )
    expect(older).toMatchObject({ hasMore: false })
  })

  it('replaces an oversized tool payload with a bounded preview', () => {
    const page = buildPublicItemHistoryPage([
      makeToolResultItem({
        id: 'item_large',
        threadId: 'thr_large',
        turnId: 'turn_large',
        callId: 'call_large',
        toolName: 'bash',
        output: { text: 'x'.repeat(5 * 1024 * 1024) },
        status: 'completed'
      })
    ], {
      maxItems: 300,
      maxBytes: 4 * 1024 * 1024
    })

    expect(page.items).toHaveLength(1)
    expect(page.itemBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(page.items[0]).toMatchObject({
      id: 'item_large',
      kind: 'tool_result',
      output: { __timelineTruncated: true }
    })
  })

  it.each([
    {
      id: 'item_large_input',
      threadId: 'thr_large',
      turnId: 'turn_large',
      role: 'system',
      status: 'submitted',
      createdAt: '2026-08-09T00:00:00.000Z',
      kind: 'user_input',
      inputId: 'input_large',
      prompt: 'choose',
      questions: [],
      answers: [{ id: 'answer', label: 'x'.repeat(5 * 1024 * 1024), value: '' }]
    },
    {
      id: 'item_large_review',
      threadId: 'thr_large',
      turnId: 'turn_large',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-08-09T00:00:00.000Z',
      kind: 'review',
      target: { kind: 'custom', instructions: 'x'.repeat(5 * 1024 * 1024) },
      title: 'Review',
      reviewText: 'done'
    }
  ] satisfies TurnItem[])('enforces the byte postcondition for $kind metadata', (item) => {
    const page = buildPublicItemHistoryPage([item], {
      maxItems: 300,
      maxBytes: 4 * 1024 * 1024
    })

    expect(page.items).toHaveLength(1)
    expect(page.itemBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(page.items[0]).toMatchObject({ id: item.id, kind: item.kind })
  })
})
