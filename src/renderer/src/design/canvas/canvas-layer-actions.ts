import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasUndoStore } from './canvas-undo-store'
import { ROOT_SHAPE_ID, type CanvasShape } from './canvas-types'

/**
 * Explicit, undoable canvas-layer deletion used by both the layers panel trash
 * button and the Delete/Backspace shortcut.
 *
 * Unlike editability-filtered shortcuts (move/copy/duplicate), this action is
 * allowed to remove locked or hidden layers: the lock/eye toggles protect
 * against accidental geometry edits, not against deliberately removing a layer
 * from the board. Every deletion is wrapped in one undo transaction and the
 * selection is pruned to the layers that still exist so undo/redo restores a
 * consistent selection.
 */

function topLevelDeleteTargets(
  objects: Record<string, CanvasShape>,
  ids: Iterable<string>
): string[] {
  const candidates = [...new Set(ids)].filter((id) => id !== ROOT_SHAPE_ID && Boolean(objects[id]))
  const selected = new Set(candidates)
  // Deleting a parent already removes its descendants, so drop any id whose
  // ancestor is also being deleted to avoid duplicate deleteShape calls.
  return candidates.filter((id) => {
    let parentId = objects[id]?.parentId ?? null
    while (parentId) {
      if (selected.has(parentId)) return false
      parentId = objects[parentId]?.parentId ?? null
    }
    return true
  })
}

/** Delete the given canvas layers (undoable). Returns the ids actually removed. */
export function deleteCanvasLayers(ids: Iterable<string>): string[] {
  const objects = useCanvasShapeStore.getState().document.objects
  const targets = topLevelDeleteTargets(objects, ids)
  if (targets.length === 0) return []

  const deleted = new Set<string>()
  useCanvasUndoStore.getState().withGroup('delete-layers', () => {
    const store = useCanvasShapeStore.getState()
    for (const id of targets) {
      if (!store.document.objects[id]) continue
      store.deleteShape(id)
      deleted.add(id)
    }
    // Prune selection inside the group so the recorded selectionAfter (redo
    // target) never references shapes that no longer exist. Non-deleted
    // selection members are preserved.
    const selection = useCanvasSelectionStore.getState()
    const remaining = [...selection.selectedIds].filter((id) => !deleted.has(id))
    const hover = selection.hoverTargetId && deleted.has(selection.hoverTargetId)
      ? null
      : selection.hoverTargetId
    if (remaining.length !== selection.selectedIds.size || hover !== selection.hoverTargetId) {
      selection.select(remaining)
      selection.setHoverTarget(hover)
    }
  })
  return [...deleted]
}
