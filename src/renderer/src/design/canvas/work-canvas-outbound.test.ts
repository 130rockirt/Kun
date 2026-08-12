import { describe, expect, it, vi } from 'vitest'
import { ComposerContextAttachmentSchema } from '@kun/extension-api'
import type { CanvasSnapshot } from './canvas-snapshot'
import { createEmptyDocument } from './canvas-types'
import { buildWorkCanvasReferenceContext } from './work-canvas-outbound'
import { snapshotWorkCanvasForPrompt } from './work-canvas'

const snapshot: CanvasSnapshot = {
  shapeCount: 1,
  shapes: [{
    id: 'shape-1', name: 'Selected slide', type: 'frame',
    x: 0, y: 0, w: 480, h: 318, parentName: null, selected: true
  }]
}

describe('Work canvas outbound prompt', () => {
  it('emits bounded whiteboard state as a composer reference', async () => {
    const snapshotForPrompt = vi.fn(async (
      _options: Parameters<typeof snapshotWorkCanvasForPrompt>[0]
    ) => snapshot)
    const takeLastErrors = vi.fn(() => [{
      code: 'SHAPE_NOT_FOUND' as const,
      message: 'Missing slide'
    }])

    const context = await buildWorkCanvasReferenceContext({
      workspaceRoot: '/work',
      boardId: 'board-1',
      boardRevision: 7,
      currentDocument: createEmptyDocument(),
      currentDocumentKey: 'document-key',
      selectedIds: new Set(['shape-1']),
      viewBox: { x: 0, y: 0, width: 1200, height: 800 },
      designContext: { designTarget: 'web' },
      snapshotForPrompt,
      takeLastErrors
    })

    expect(context).toMatchObject({
      title: 'Current Work whiteboard',
      revision: 7,
      reference: {
        kind: 'work-reference-whiteboard',
        boardId: 'board-1',
        designTarget: 'web',
        snapshot: {
          shapeCount: 1,
          includedShapeCount: 1,
          shapes: [{ id: 'shape-1', selected: true }]
        },
        previousErrors: [{ code: 'SHAPE_NOT_FOUND', message: 'Missing slide' }]
      }
    })
    expect(JSON.stringify(context)).not.toContain('Kun is asking you')
    expect(JSON.stringify(context)).not.toContain('/work')
    expect(snapshotForPrompt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/work', boardId: 'board-1', selectedIds: new Set(['shape-1'])
    }))
    expect(takeLastErrors).toHaveBeenCalledWith('work-canvas:board-1')
  })

  it('shrinks a dense snapshot to the largest schema-valid reference', async () => {
    const shapes = Array.from({ length: 180 }, (_, index) => ({
      id: `shape-${index}`,
      name: `Shape ${index} ${'n'.repeat(200)}`,
      type: 'text' as const,
      x: index * 10,
      y: index * 5,
      w: 240,
      h: 80,
      parentName: null,
      textContent: `Content ${index} ${'x'.repeat(1_000)}`,
      imageUrl: `images/reference-${index}-${'y'.repeat(500)}.png`,
      selected: index === 0
    }))
    const context = await buildWorkCanvasReferenceContext({
      workspaceRoot: '/work',
      boardId: 'board-dense',
      boardRevision: 9,
      currentDocument: createEmptyDocument(),
      selectedIds: new Set(['shape-0']),
      viewBox: { x: 0, y: 0, width: 1200, height: 800 },
      designContext: { designTarget: 'web' },
      snapshotForPrompt: async () => ({ shapeCount: shapes.length, shapes }),
      takeLastErrors: () => []
    })

    expect(ComposerContextAttachmentSchema.parse(context)).toEqual(context)
    expect(context.reference.snapshot).toMatchObject({ shapeCount: 180 })
    const included = (context.reference.snapshot as { includedShapeCount?: number }).includedShapeCount
    expect(included).toBeGreaterThan(0)
    expect(included).toBeLessThanOrEqual(18)
    expect(new TextEncoder().encode(JSON.stringify(context.reference)).byteLength)
      .toBeLessThanOrEqual(16 * 1_024)
  })
})
