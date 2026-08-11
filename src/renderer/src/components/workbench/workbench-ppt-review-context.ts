import { serializeActivePptReviewContexts } from '../../design/canvas/ppt-review-board'
import { createPptReviewComposerContextAttachments } from '../../design/canvas/ppt-review-composer-context'
import { useCanvasShapeStore } from '../../design/canvas/canvas-shape-store'

export async function activePptReviewComposerContexts(
  workspaceRoot: string,
  threadId: string | null
) {
  if (!threadId) return []
  const workflows = serializeActivePptReviewContexts(
    Object.values(useCanvasShapeStore.getState().document.objects),
    threadId
  )
  return createPptReviewComposerContextAttachments({ workspaceRoot, threadId, workflows })
}
