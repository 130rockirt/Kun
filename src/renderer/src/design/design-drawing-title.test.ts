import { describe, expect, it } from 'vitest'
import {
  deriveDrawingTitleFromBlocks,
  deriveDrawingTitleFromPrompt,
  displayDrawingTitle,
  drawingTitleNeedsBackfill
} from './design-drawing-title'

describe('design drawing titles', () => {
  it('uses the same concise prompt rule as Code threads', () => {
    expect(deriveDrawingTitleFromPrompt('  Create a warm travel dashboard  '))
      .toBe('Create a warm travel dashboard')
  })

  it('leaves attachment-only drawings untitled', () => {
    expect(deriveDrawingTitleFromPrompt('   ')).toBe('')
  })

  it('prefers the first user display text when backfilling from history', () => {
    expect(deriveDrawingTitleFromBlocks([
      {
        kind: 'user',
        id: 'user-1',
        text: 'hidden expanded runtime prompt',
        meta: { displayText: '画一个旅行计划首页' }
      },
      { kind: 'assistant', id: 'assistant-1', text: '好的。' }
    ])).toBe('画一个旅行计划首页')
  })

  it('hides ids and legacy defaults behind the untitled placeholder', () => {
    expect(drawingTitleNeedsBackfill({ id: 'doc_ab12', title: 'doc_ab12' })).toBe(true)
    expect(drawingTitleNeedsBackfill({ id: 'doc_ab12', title: '我的设计' })).toBe(true)
    expect(displayDrawingTitle(
      { id: 'doc_ab12', title: 'doc_ab12' },
      '未命名绘画'
    )).toBe('未命名绘画')
  })

  it('keeps a user-renamed drawing title', () => {
    expect(drawingTitleNeedsBackfill({ id: 'doc_ab12', title: '北欧家居商店' })).toBe(false)
    expect(displayDrawingTitle(
      { id: 'doc_ab12', title: '北欧家居商店' },
      '未命名绘画'
    )).toBe('北欧家居商店')
    expect(drawingTitleNeedsBackfill({
      id: 'doc_ab12',
      title: '我的设计',
      titleOrigin: 'user'
    })).toBe(false)
  })
})
