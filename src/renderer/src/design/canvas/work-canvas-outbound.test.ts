import { describe, expect, it, vi } from 'vitest'
import type { CanvasSnapshot } from './canvas-snapshot'
import { createEmptyDocument } from './canvas-types'
import { createEmptyDesignSystem } from './design-system-types'
import { buildWorkCanvasOutboundText } from './work-canvas-outbound'
import { snapshotWorkCanvasForPrompt } from './work-canvas'

const snapshot: CanvasSnapshot = {
  shapeCount: 1,
  shapes: [{
    id: 'shape-1', name: 'Selected slide', type: 'frame',
    x: 0, y: 0, w: 480, h: 318, parentName: null, selected: true
  }]
}

describe('Work canvas outbound prompt', () => {
  it('adds general ShapeOps snapshot, scoped feedback, and Work semantics', async () => {
    const snapshotForPrompt = vi.fn(async (
      _options: Parameters<typeof snapshotWorkCanvasForPrompt>[0]
    ) => snapshot)
    const loadDesignSystemForPrompt = vi.fn(async () => createEmptyDesignSystem())
    const takeLastErrors = vi.fn(() => [{
      code: 'SHAPE_NOT_FOUND' as const,
      message: 'Missing slide'
    }])

    const outbound = await buildWorkCanvasOutboundText({
      baseText: 'Modify this slide',
      canvasBrief: 'Modify this slide',
      workspaceRoot: '/work',
      boardId: 'board-1',
      currentDocument: createEmptyDocument(),
      currentDocumentKey: 'document-key',
      selectedIds: new Set(['shape-1']),
      viewBox: { x: 0, y: 0, width: 1200, height: 800 },
      designContext: { designTarget: 'web' },
      snapshotForPrompt,
      loadDesignSystemForPrompt,
      takeLastErrors
    })

    expect(outbound.startsWith('Modify this slide\n\n')).toBe(true)
    expect(outbound).toContain('Work central whiteboard override:')
    expect(outbound).toContain('SHAPE_NOT_FOUND')
    expect(snapshotForPrompt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/work', boardId: 'board-1', selectedIds: new Set(['shape-1'])
    }))
    expect(loadDesignSystemForPrompt).toHaveBeenCalledWith(
      '/work', '.kun-write/whiteboards/board-1'
    )
    expect(takeLastErrors).toHaveBeenCalledWith('work-canvas:board-1')
  })
})
