import { describe, expect, it } from 'vitest'
import {
  applyCanvasOpBlocks,
  extractCanvasOpBlocksFromValue,
  isDesignCanvasToolName
} from './apply-shape-ops'
import { useCanvasShapeStore } from './canvas-shape-store'

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

  it('applies a ppt_to_board result through the canvas op application path', () => {
    const blocks = extractCanvasOpBlocksFromValue({
      ops: [
        { op: 'add-screen', name: 'P1 Cover', x: 0, y: 0, width: 960, height: 540 },
        {
          op: 'add',
          shape: {
            type: 'text',
            x: 60,
            y: 150,
            width: 660,
            height: 130,
            textContent: 'Cover title',
            fontSize: 42,
            fontColor: '#FFFFFF'
          }
        },
        {
          op: 'add',
          shape: {
            type: 'image',
            x: 720,
            y: 60,
            width: 180,
            height: 180,
            imageUrl: '.deepseekgui-images/cover.png'
          }
        }
      ]
    })

    const result = applyCanvasOpBlocks(blocks, 'ppt-board-apply', {
      // Test isolation has no screen artifact factory; fall back to plain
      // frames like the renderer does for non-registered creation paths.
      screenFallback: 'plain-frame'
    })

    expect(result.errors).toEqual([])
    expect(result.batchCount).toBe(1)
    expect(result.affectedIds).toHaveLength(3)
    const objects = result.affectedIds.map((id) => useCanvasShapeStore.getState().document.objects[id])
    expect(objects.map((shape) => shape?.type)).toEqual(['frame', 'text', 'image'])
    expect(objects[2]?.imageUrl).toBe('.deepseekgui-images/cover.png')
  })
})
