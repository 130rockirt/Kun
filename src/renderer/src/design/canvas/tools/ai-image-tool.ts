import { useCanvasSelectionStore } from '../canvas-selection-store'
import { useCanvasShapeStore } from '../canvas-shape-store'
import { useCanvasViewportStore } from '../canvas-viewport-store'
import { createDefaultShape } from '../canvas-types'
import { useDesignWorkspaceStore } from '../../design-workspace-store'
import type { CanvasPointerEvent, CanvasToolHandler } from './tool-types'
import { computeSnappedCreateShapeBounds } from './create-shape-bounds'
import { addShapeForCreation, commitCreatedShapeUndo, type CreatedShapeUndo } from './creation-undo'

const DEFAULT_AI_IMAGE_WIDTH = 320
const DEFAULT_AI_IMAGE_HEIGHT = 220

type AiImageToolOptions = {
  openAssistant?: boolean
  onRequestAssistant?: () => void
}

export function createAiImageTool(options: AiImageToolOptions = {}): CanvasToolHandler {
  const openAssistant = options.openAssistant ?? true
  let drawing = false
  let startX = 0
  let startY = 0
  let previewId: string | null = null
  let creationUndo: CreatedShapeUndo | null = null

  return {
    cursor: 'crosshair',

    onPointerDown(e: CanvasPointerEvent) {
      drawing = true
      startX = e.canvasX
      startY = e.canvasY

      const shape = createDefaultShape('image', e.canvasX, e.canvasY)
      shape.name = 'AI Image'
      shape.width = 0
      shape.height = 0
      shape.aiImageHolder = true
      previewId = shape.id
      creationUndo = addShapeForCreation(shape)
      useCanvasSelectionStore.getState().select([shape.id])
    },

    onPointerMove(e: CanvasPointerEvent) {
      if (!drawing || !previewId) return
      const bounds = computeSnappedCreateShapeBounds(startX, startY, e, previewId, {
        allowSnap: !e.shiftKey,
        constrainSquare: e.shiftKey
      })
      useCanvasShapeStore.getState().updateShape(previewId, bounds, true)
    },

    onPointerUp() {
      if (!drawing || !previewId) return
      drawing = false

      const shape = useCanvasShapeStore.getState().getShape(previewId)
      if (shape && shape.width < 2 && shape.height < 2) {
        useCanvasShapeStore
          .getState()
          .updateShape(previewId, { width: DEFAULT_AI_IMAGE_WIDTH, height: DEFAULT_AI_IMAGE_HEIGHT }, true)
      }

      useCanvasViewportStore.getState().setActiveTool('select')
      useCanvasSelectionStore.getState().setSnapGuides([])
      if (options.onRequestAssistant) options.onRequestAssistant()
      else if (openAssistant) useDesignWorkspaceStore.getState().setCanvasAssistantOpen(true)
      commitCreatedShapeUndo(creationUndo, 'create-ai-image')
      previewId = null
      creationUndo = null
    }
  }
}
