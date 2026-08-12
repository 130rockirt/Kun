import { afterEach, describe, expect, it } from 'vitest'
import { useCanvasShapeStore } from '../../design/canvas/canvas-shape-store'
import { createDefaultShape, createEmptyDocument, type CanvasShape } from '../../design/canvas/canvas-types'
import { useCanvasSelectionStore } from '../../design/canvas/canvas-selection-store'
import { activePptReviewComposerContexts } from './workbench-ppt-review-context'

function reviewShape(workflowId: string, childId: string, slideId: string): CanvasShape {
  return {
    ...createDefaultShape('frame', 0, 0),
    id: `${workflowId}-frame`,
    pptReviewRef: {
      workflowId,
      childId,
      slideId,
      revision: 2,
      parentThreadId: 'thread-a',
      role: 'slide-frame'
    }
  }
}

function loadReviewDocument(documentKey: string): void {
  const document = createEmptyDocument()
  const workflowA = reviewShape('workflow-a', 'child-a', 'slide-a')
  const workflowB = reviewShape('workflow-b', 'child-b', 'slide-b')
  useCanvasShapeStore.getState().loadDocument({
    ...document,
    objects: {
      ...document.objects,
      [workflowA.id]: workflowA,
      [workflowB.id]: workflowB
    }
  }, documentKey)
}

afterEach(() => {
  useCanvasShapeStore.getState().resetDocument()
  useCanvasSelectionStore.getState().clearSelection()
})

describe('active Work PPT composer contexts', () => {
  it('returns no context when the active canvas document changed before send', async () => {
    loadReviewDocument('work-board-a')

    await expect(activePptReviewComposerContexts('/work', 'thread-a', {
      expectedDocumentKey: 'work-board-b',
      workflowId: 'workflow-a'
    })).resolves.toEqual([])
  })

  it('admits only the active board workflow from a shared thread', async () => {
    loadReviewDocument('work-board-a')

    const contexts = await activePptReviewComposerContexts('/work', 'thread-a', {
      expectedDocumentKey: 'work-board-a',
      workflowId: 'workflow-b'
    })

    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.reference).toMatchObject({
      kind: 'ppt-review',
      workflowId: 'workflow-b',
      childId: 'child-b',
      slides: [{ slideId: 'slide-b', revision: 2 }]
    })
  })
})
