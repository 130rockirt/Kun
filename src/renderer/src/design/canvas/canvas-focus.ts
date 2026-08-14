import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasViewportStore } from './canvas-viewport-store'
import { shapeGeometry } from './canvas-types'
import { getSelectionBounds } from './canvas-hit-test'
import { filterEditableRootShapeIds } from './canvas-editability'
import { getCanvasDocumentContentBounds } from './canvas-placement'

/**
 * Pan/zoom the viewport to frame the given shapes — but only when they aren't
 * already fully visible, so a small in-view tweak never yanks the camera. Used
 * after the AI applies ShapeOps so the user sees what changed instead of an
 * edit happening off-screen. Shared by the live AI-Rail apply path and the
 * legacy design-assistant path.
 */
export function focusViewportOnIds(ids: string[]): void {
  if (ids.length === 0) return
  const doc = useCanvasShapeStore.getState().document
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const id of ids) {
    const s = doc.objects[id]
    if (!s) continue
    found = true
    const sel = shapeGeometry(s).selrect
    if (sel.x < minX) minX = sel.x
    if (sel.y < minY) minY = sel.y
    if (sel.x + sel.width > maxX) maxX = sel.x + sel.width
    if (sel.y + sel.height > maxY) maxY = sel.y + sel.height
  }
  if (!found) return

  const bounds = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  }
  const vp = useCanvasViewportStore.getState()
  const v = vp.vbox
  const inside =
    bounds.x >= v.x &&
    bounds.y >= v.y &&
    bounds.x + bounds.width <= v.x + v.width &&
    bounds.y + bounds.height <= v.y + v.height
  if (!inside) vp.zoomToFit(bounds, 80, { maxZoom: 1, minZoom: 0.04 })
}

export function zoomCanvasToContent(padding = 40): boolean {
  const doc = useCanvasShapeStore.getState().document
  const bounds = getCanvasDocumentContentBounds(doc)
  if (!bounds) return false
  useCanvasViewportStore.getState().zoomToFit(bounds, padding)
  return true
}

export function zoomCanvasToEditableSelection(padding = 60): boolean {
  const doc = useCanvasShapeStore.getState().document
  const ids = filterEditableRootShapeIds(doc, useCanvasSelectionStore.getState().selectedIds)
  if (ids.length === 0) return false
  const bounds = getSelectionBounds(doc.objects, new Set(ids))
  if (!bounds) return false
  useCanvasViewportStore.getState().zoomToFit(bounds, padding)
  return true
}
