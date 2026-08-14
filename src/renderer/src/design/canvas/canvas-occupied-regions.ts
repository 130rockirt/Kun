import { shapeGeometry, type CanvasDocument, type Rect, type ViewBox } from './canvas-types'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasViewportStore } from './canvas-viewport-store'
import {
  DESIGN_SYSTEM_BOARD_REGION_ID,
  visibleDesignSystemBoardRect
} from './design-system-board-layout'
import type { CanvasPlacementFrame } from './canvas-snapshot'

/** Root-level shapes and virtual projections that reserve space on the whiteboard. */
export function canvasOccupiedRects(
  document: CanvasDocument,
  documentKey: string | null | undefined,
  viewBox: ViewBox,
  options?: { excludeIds?: ReadonlySet<string> }
): Rect[] {
  const root = document.objects[document.rootId]
  const shapes = (root?.children ?? [])
    .filter((id) => !options?.excludeIds?.has(id))
    .map((id) => document.objects[id])
    .filter((shape) => Boolean(shape) && shape.visible !== false)
    .map((shape) => shapeGeometry(shape!).selrect)
    .filter((rect) => rect.width > 0 && rect.height > 0)
  const designSystemRect = visibleDesignSystemBoardRect(documentKey, document, viewBox)
  return designSystemRect ? [designSystemRect, ...shapes] : shapes
}

export function currentCanvasOccupiedRects(excludeIds?: ReadonlySet<string>): Rect[] {
  const state = useCanvasShapeStore.getState()
  return canvasOccupiedRects(
    state.document,
    state.documentKey,
    useCanvasViewportStore.getState().vbox,
    { excludeIds }
  )
}

export function designSystemBoardPlacementRegion(
  document: CanvasDocument,
  documentKey: string | null | undefined,
  viewBox: ViewBox | undefined
): CanvasPlacementFrame | null {
  if (!viewBox) return null
  const rect = visibleDesignSystemBoardRect(documentKey, document, viewBox)
  if (!rect) return null
  return {
    id: DESIGN_SYSTEM_BOARD_REGION_ID,
    name: 'Project design-system board',
    regionKind: 'design-system',
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height
  }
}
