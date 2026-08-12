import { beforeEach, describe, expect, it } from 'vitest'
import { validateCanvasDocumentGraph } from './canvas-persistence'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape, createEmptyDocument, ROOT_SHAPE_ID } from './canvas-types'
import { useCanvasUndoStore } from './canvas-undo-store'

beforeEach(() => {
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
})

function addShape(type: 'frame' | 'group' | 'rect', parentId?: string): string {
  const shape = createDefaultShape(type, 0, 0)
  useCanvasShapeStore.getState().addShape(shape, parentId, { skipUndo: true })
  return shape.id
}

describe('canvas shape tree integrity', () => {
  it('keeps a same-parent reparent idempotent instead of duplicating the child', () => {
    const parentId = addShape('frame')
    const firstId = addShape('rect', parentId)
    const secondId = addShape('rect', parentId)

    expect(useCanvasShapeStore.getState().reparentShape(firstId, parentId)).toBe(true)

    const document = useCanvasShapeStore.getState().document
    expect(document.objects[parentId].children).toEqual([firstId, secondId])
    expect(document.objects[parentId].children.filter((id) => id === firstId)).toHaveLength(1)
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
    expect(validateCanvasDocumentGraph(document.objects, document.rootId)).toBe(true)
  })

  it('reorders within one parent once and keeps the change undoable', () => {
    const parentId = addShape('frame')
    const firstId = addShape('rect', parentId)
    const secondId = addShape('rect', parentId)
    const thirdId = addShape('rect', parentId)

    expect(useCanvasShapeStore.getState().reparentShape(firstId, parentId, 2)).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[parentId].children).toEqual([
      secondId,
      thirdId,
      firstId
    ])
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(1)

    useCanvasShapeStore.getState().undo()
    expect(useCanvasShapeStore.getState().document.objects[parentId].children).toEqual([
      firstId,
      secondId,
      thirdId
    ])
  })

  it('keeps root artifact portals after ordinary shapes during reparent reorder', () => {
    const normalId = addShape('rect')
    const portal = createDefaultShape('frame', 0, 0)
    portal.htmlArtifactId = 'prototype-html'
    useCanvasShapeStore.getState().addShape(portal, ROOT_SHAPE_ID, { skipUndo: true })

    expect(useCanvasShapeStore.getState().reparentShape(portal.id, ROOT_SHAPE_ID, 0)).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[ROOT_SHAPE_ID].children).toEqual([
      normalId,
      portal.id
    ])

    const frameId = addShape('frame')
    const nestedId = addShape('rect', frameId)
    expect(useCanvasShapeStore.getState().reparentShape(nestedId, ROOT_SHAPE_ID, 99)).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[ROOT_SHAPE_ID].children).toEqual([
      normalId,
      frameId,
      nestedId,
      portal.id
    ])
  })

  it('rejects moving an ancestor below its descendant without recording undo', () => {
    const frameId = addShape('frame')
    const groupId = addShape('group', frameId)

    expect(useCanvasShapeStore.getState().reparentShape(frameId, groupId)).toBe(false)

    const document = useCanvasShapeStore.getState().document
    expect(document.objects[frameId].parentId).toBe(document.rootId)
    expect(document.objects[groupId].parentId).toBe(frameId)
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
    expect(validateCanvasDocumentGraph(document.objects, document.rootId)).toBe(true)
  })

  it('rejects a non-container parent without detaching the shape', () => {
    const frameId = addShape('frame')
    const childId = addShape('rect', frameId)
    const invalidParentId = addShape('rect')

    expect(useCanvasShapeStore.getState().reparentShape(childId, invalidParentId)).toBe(false)

    const document = useCanvasShapeStore.getState().document
    expect(document.objects[childId].parentId).toBe(frameId)
    expect(document.objects[frameId].children).toContain(childId)
    expect(document.objects[invalidParentId].children).toEqual([])
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
  })

  it('updates owning frame ids throughout a subtree when moving across frames', () => {
    const firstFrameId = addShape('frame')
    const secondFrameId = addShape('frame')
    const groupId = addShape('group', firstFrameId)
    const childId = addShape('rect', groupId)

    expect(useCanvasShapeStore.getState().document.objects[groupId].frameId).toBe(firstFrameId)
    expect(useCanvasShapeStore.getState().document.objects[childId].frameId).toBe(firstFrameId)
    expect(useCanvasShapeStore.getState().reparentShape(groupId, secondFrameId)).toBe(true)

    let document = useCanvasShapeStore.getState().document
    expect(document.objects[groupId]).toMatchObject({
      parentId: secondFrameId,
      frameId: secondFrameId
    })
    expect(document.objects[childId].frameId).toBe(secondFrameId)

    useCanvasShapeStore.getState().undo()
    document = useCanvasShapeStore.getState().document
    expect(document.objects[groupId]).toMatchObject({
      parentId: firstFrameId,
      frameId: firstFrameId
    })
    expect(document.objects[childId].frameId).toBe(firstFrameId)
  })
})

describe('canvas document hydration undo history', () => {
  it('preserves undo entries when a same-key background load replaces the document', () => {
    const key = 'workspace-a\0design-a'
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), key)
    const shape = createDefaultShape('rect', 0, 0)
    useCanvasShapeStore.getState().addShape(shape)
    const hydrated = useCanvasShapeStore.getState().document

    useCanvasShapeStore.getState().loadDocument(hydrated, key, { preserveUndo: true })

    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(1)
    useCanvasShapeStore.getState().undo()
    expect(useCanvasShapeStore.getState().document.objects[shape.id]).toBeUndefined()
  })

  it('clears stale undo entries for an ordinary same-key document replacement', () => {
    const key = 'workspace-a\0design-a'
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), key)
    useCanvasShapeStore.getState().addShape(createDefaultShape('rect', 0, 0))

    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), key)

    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
  })

  it('clears undo entries when switching to a different document key', () => {
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'workspace-a\0design-a')
    useCanvasShapeStore.getState().addShape(createDefaultShape('rect', 0, 0))
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(1)

    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'workspace-a\0design-b')

    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
    expect(useCanvasUndoStore.getState().redoStack).toHaveLength(0)
  })
})
