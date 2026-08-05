import { beforeEach, describe, expect, it } from 'vitest'
import { deleteCanvasLayers } from './canvas-layer-actions'
import { createEmptyDocument } from './canvas-types'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasUndoStore } from './canvas-undo-store'
import { useCanvasViewportStore } from './canvas-viewport-store'
import { executeOps } from './shape-ops'

beforeEach(() => {
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument())
  useCanvasUndoStore.getState().clear()
  useCanvasSelectionStore.getState().clearSelection()
  useCanvasViewportStore.getState().setContainerSize(1000, 500)
  useCanvasViewportStore.getState().resetView()
})

function addRect(x: number, patch: { locked?: boolean; visible?: boolean } = {}): string {
  const id = executeOps([
    { op: 'add', shape: { type: 'rect', x, y: 0, width: 80, height: 80 } }
  ]).affectedIds[0]
  if (patch.locked !== undefined || patch.visible !== undefined) {
    useCanvasShapeStore.getState().updateShape(id, {
      locked: patch.locked ?? false,
      visible: patch.visible ?? true
    })
  }
  return id
}

function addFrameWithChild(): { frameId: string; childId: string } {
  const frameId = executeOps([
    { op: 'add', shape: { type: 'frame', x: 0, y: 0, width: 200, height: 160 } }
  ]).affectedIds[0]
  const childId = executeOps([
    {
      op: 'add',
      parentId: frameId,
      shape: { type: 'rect', x: 24, y: 24, width: 80, height: 44 }
    }
  ]).affectedIds[0]
  return { frameId, childId }
}

describe('deleteCanvasLayers', () => {
  it('explicitly deletes normal, locked, and hidden layers', () => {
    const normal = addRect(0)
    const locked = addRect(120, { locked: true })
    const hidden = addRect(240, { visible: false })

    const deleted = deleteCanvasLayers([normal, locked, hidden])

    expect([...deleted].sort()).toEqual([normal, locked, hidden].sort())
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[normal]).toBeUndefined()
    expect(doc.objects[locked]).toBeUndefined()
    expect(doc.objects[hidden]).toBeUndefined()
  })

  it('deletes a selected parent subtree only once when the child is also selected', () => {
    const { frameId, childId } = addFrameWithChild()
    useCanvasSelectionStore.getState().select([frameId, childId])
    useCanvasUndoStore.getState().clear()

    const deleted = deleteCanvasLayers([frameId, childId])

    expect(deleted).toEqual([frameId])
    const doc = useCanvasShapeStore.getState().document
    expect(doc.objects[frameId]).toBeUndefined()
    expect(doc.objects[childId]).toBeUndefined()
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(1)
  })

  it('wraps multi-select deletion in one undo transaction and prunes selection', () => {
    const a = addRect(0)
    const b = addRect(120)
    const c = addRect(240)
    useCanvasSelectionStore.getState().select([a, b, c])
    useCanvasUndoStore.getState().clear()

    const deleted = deleteCanvasLayers([a, b])

    expect([...deleted].sort()).toEqual([a, b].sort())
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(1)
    expect(Array.from(useCanvasSelectionStore.getState().selectedIds)).toEqual([c])

    useCanvasShapeStore.getState().undo()
    let doc = useCanvasShapeStore.getState().document
    expect(doc.objects[a]).toBeDefined()
    expect(doc.objects[b]).toBeDefined()
    expect(Array.from(useCanvasSelectionStore.getState().selectedIds)).toEqual([a, b, c])

    useCanvasShapeStore.getState().redo()
    doc = useCanvasShapeStore.getState().document
    expect(doc.objects[a]).toBeUndefined()
    expect(doc.objects[b]).toBeUndefined()
    expect(Array.from(useCanvasSelectionStore.getState().selectedIds)).toEqual([c])
  })

  it('never deletes the canvas root', () => {
    const doc = useCanvasShapeStore.getState().document
    const rootId = doc.rootId

    expect(deleteCanvasLayers([rootId])).toEqual([])
    expect(useCanvasShapeStore.getState().document.objects[rootId]).toBeDefined()
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
  })

  it('does not push an undo change when nothing is deletable', () => {
    expect(deleteCanvasLayers([])).toEqual([])
    expect(deleteCanvasLayers(['missing-id'])).toEqual([])
    expect(useCanvasUndoStore.getState().undoStack).toHaveLength(0)
  })
})
