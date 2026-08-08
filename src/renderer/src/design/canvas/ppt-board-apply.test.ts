import { describe, expect, it } from 'vitest'
import {
  extractCanvasOpBlocksFromValue,
  isDesignCanvasToolName
} from './apply-shape-ops'
import { executeOps } from './shape-ops'

describe('ppt_to_board renderer application', () => {
  it('recognizes ppt_to_board as a design canvas tool name', () => {
    expect(isDesignCanvasToolName('ppt_to_board')).toBe(true)
    expect(isDesignCanvasToolName('design_update_shapes')).toBe(true)
    expect(isDesignCanvasToolName('unknown_tool')).toBe(false)
  })

  it('extracts ops from a ppt_to_board tool result payload', () => {
    const blocks = extractCanvasOpBlocksFromValue({
      ops: [
        { op: 'add-screen', name: 'P1 封面', x: 0, y: 0, width: 960, height: 540 },
        {
          op: 'add',
          shape: {
            type: 'text',
            x: 60,
            y: 150,
            width: 660,
            height: 130,
            textContent: '封面标题',
            fontSize: 42,
            fontColor: '#FFFFFF'
          }
        }
      ],
      boardTitle: '测试（1 页）',
      pageCount: 1,
      batch: 0,
      batchCount: 1,
      more: false
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toHaveLength(2)
  })

  it('applies ppt_to_board ops through executeOps', () => {
    const result = executeOps(
      [
        { op: 'add-screen', name: 'P1 封面', x: 0, y: 0, width: 960, height: 540 },
        {
          op: 'add',
          shape: {
            type: 'text',
            x: 60,
            y: 150,
            width: 660,
            height: 130,
            textContent: '封面标题',
            fontSize: 42,
            fontColor: '#FFFFFF'
          }
        },
        {
          op: 'add',
          shape: {
            type: 'rect',
            x: 60,
            y: 300,
            width: 300,
            height: 180,
            fills: [{ type: 'solid', color: '#FF6900', opacity: 1 }]
          }
        }
      ],
      'ppt-board-apply',
      // Test isolation has no screen artifact factory; fall back to plain
      // frames like the renderer does for non-registered creation paths.
      { screenFallback: 'plain-frame' }
    )
    expect(result.ok).toBe(true)
    expect(result.affectedIds.length).toBeGreaterThan(0)
  })
})
