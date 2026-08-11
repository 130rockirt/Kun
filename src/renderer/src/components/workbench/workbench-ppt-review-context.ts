import { serializeActivePptReviewContexts } from '../../design/canvas/ppt-review-board'
import { createPptReviewComposerContextAttachments } from '../../design/canvas/ppt-review-composer-context'
import { useCanvasShapeStore } from '../../design/canvas/canvas-shape-store'
import { useCanvasSelectionStore } from '../../design/canvas/canvas-selection-store'
import { serializeActivePptDirectionContexts } from '../../design/canvas/ppt-direction-board'
import { createPptDirectionComposerContextAttachments } from '../../design/canvas/ppt-direction-composer-context'

export async function activePptReviewComposerContexts(
  workspaceRoot: string,
  threadId: string | null
) {
  if (!threadId) return []
  const shapes = Object.values(useCanvasShapeStore.getState().document.objects)
  const reviews = serializeActivePptReviewContexts(shapes, threadId)
  const directions = serializeActivePptDirectionContexts(
    shapes, useCanvasSelectionStore.getState().selectedIds, threadId)
  const [reviewContexts, directionContexts] = await Promise.all([
    createPptReviewComposerContextAttachments({ workspaceRoot, threadId, workflows: reviews }),
    createPptDirectionComposerContextAttachments({ workspaceRoot, threadId, workflows: directions })
  ])
  return [...reviewContexts, ...directionContexts]
}
