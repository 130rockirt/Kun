import { describe, expect, it } from 'vitest'
import { createDefaultShape, createEmptyDocument } from '../../../design/canvas/canvas-types'
import {
  defaultDesignSystemBoardRect,
  translateDesignSystemBoardRect
} from '../../../design/canvas/design-system-board-layout'
import { shouldRenderDesignSystemBoard } from './DesignSystemBoardOverlay'

describe('DesignSystemBoardOverlay', () => {
  it('does not create a canvas board when the workspace has no design-system file', () => {
    expect(shouldRenderDesignSystemBoard('loading')).toBe(false)
    expect(shouldRenderDesignSystemBoard('missing')).toBe(false)
  })

  it('renders persisted and invalid design-system files', () => {
    expect(shouldRenderDesignSystemBoard('ready')).toBe(true)
    expect(shouldRenderDesignSystemBoard('invalid')).toBe(true)
    expect(shouldRenderDesignSystemBoard('dirty')).toBe(true)
    expect(shouldRenderDesignSystemBoard('saving')).toBe(true)
    expect(shouldRenderDesignSystemBoard('conflict')).toBe(true)
  })

  it('places the projection beside existing content by default', () => {
    const document = createEmptyDocument()
    const root = document.objects[document.rootId]
    const frame = createDefaultShape('frame', 1500, 300)
    frame.width = 800
    frame.height = 600
    document.objects[frame.id] = { ...frame, parentId: document.rootId }
    document.objects[document.rootId] = { ...root, children: [frame.id] }

    expect(defaultDesignSystemBoardRect(document, { x: 0, y: 0, width: 1600, height: 1000 })).toEqual({
      x: 140,
      y: 300,
      width: 1240,
      height: 700
    })
  })

  it('translates drag movement using the current SVG scale', () => {
    expect(translateDesignSystemBoardRect(
      { x: 100, y: 200, width: 1240, height: 700 },
      { x: 50, y: -20 },
      { x: 2, y: 1.5 }
    )).toEqual({ x: 200, y: 170, width: 1240, height: 700 })
  })
})
