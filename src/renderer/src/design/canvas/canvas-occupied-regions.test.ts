import { beforeEach, describe, expect, it } from 'vitest'
import { parseProjectDesignMd } from '../design-md/design-md-adapter'
import { canvasOccupiedRects, designSystemBoardPlacementRegion } from './canvas-occupied-regions'
import { resetDesignSystemBoardLayoutForTests, setDesignSystemBoardRect } from './design-system-board-layout'
import { useProjectDesignSystemStore } from './project-design-system-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape, createEmptyDocument } from './canvas-types'

const documentKey = '/workspace\0.kun-design/document/board/canvas.json'
const viewBox = { x: 0, y: 0, width: 1600, height: 1000 }

beforeEach(() => {
  resetDesignSystemBoardLayoutForTests()
  useProjectDesignSystemStore.getState().activateWorkspace('/workspace')
  useProjectDesignSystemStore.getState().setMissing()
  useProjectDesignSystemStore.getState().setReady(parseProjectDesignMd(`---
name: Occupied test
colors:
  primary: '#3366ff'
---
# Design
`).document!)
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), documentKey)
  setDesignSystemBoardRect(documentKey, { x: 100, y: 120, width: 1240, height: 700 }, { persist: false })
})

describe('canvas occupied regions', () => {
  it('combines root shapes with the draggable design-system projection', () => {
    const shape = createDefaultShape('rect', 1500, 200)
    shape.width = 200
    shape.height = 100
    useCanvasShapeStore.getState().addShape(shape)
    const document = useCanvasShapeStore.getState().document

    expect(canvasOccupiedRects(document, documentKey, viewBox)).toEqual([
      { x: 100, y: 120, width: 1240, height: 700 },
      expect.objectContaining({ x: 1500, y: 200, width: 200, height: 100 })
    ])
  })

  it('exposes the projection to the Agent placement snapshot', () => {
    expect(designSystemBoardPlacementRegion(
      useCanvasShapeStore.getState().document,
      documentKey,
      viewBox
    )).toEqual({
      id: 'project-design-system-board',
      name: 'Project design-system board',
      regionKind: 'design-system',
      x: 100,
      y: 120,
      w: 1240,
      h: 700
    })
  })
})
