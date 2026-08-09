import { describe, expect, it } from 'vitest'
import { createDefaultShape, type CanvasShape } from './canvas-types'
import {
  pptReviewBoardOps,
  serializeActivePptReviewContexts,
  type PptReviewBundle
} from './ppt-review-board'

const bundle: PptReviewBundle = {
  workflowId: 'ppt_workflow',
  childId: 'child_ppt',
  manifestPath: 'deck/.kun-ppt-review/manifest.json',
  deckTitle: 'Review deck',
  styleFingerprint: 'style-1',
  phase: 'awaiting_review',
  slides: [{
    slideId: 'slide-1',
    index: 0,
    title: 'Opening',
    previewPath: '.kun/images/opening.png',
    revision: 1,
    status: 'ready'
  }]
}

function shape(type: CanvasShape['type'], name: string, id: string): CanvasShape {
  return { ...createDefaultShape(type, 0, 0), id, name }
}

describe('PPT review board', () => {
  it('adds stable review cards and updates them in place for a new revision', () => {
    const created = pptReviewBoardOps(bundle, [], 'thread-a') as Array<{ op: string; shape?: Partial<CanvasShape> }>
    expect(created).toHaveLength(4)
    const frameSpec = created[0].shape!
    const previewSpec = created[1].shape!
    const frame = { ...shape('frame', frameSpec.name!, 'frame-1'), ...frameSpec } as CanvasShape
    const preview = { ...shape('image', previewSpec.name!, 'preview-1'), ...previewSpec } as CanvasShape
    const title = shape('text', 'ppt-review:ppt_workflow:slide-1:title', 'title-1')
    const status = shape('text', 'ppt-review:ppt_workflow:slide-1:status', 'status-1')

    const revisedBundle = {
      ...bundle,
      slides: [{ ...bundle.slides[0], previewPath: '.kun/images/opening-v2.png', revision: 2 }]
    }
    const revised = pptReviewBoardOps(revisedBundle, [frame, preview, title, status], 'thread-a') as Array<{
      op: string
      id?: string
      patch?: Partial<CanvasShape>
    }>
    expect(revised.every((op) => op.op === 'update')).toBe(true)
    expect(revised.map((op) => op.id)).toEqual(['frame-1', 'preview-1', 'title-1', 'status-1'])
    expect(revised[1].patch).toMatchObject({
      imageUrl: '.kun/images/opening-v2.png',
      pptReviewRef: { workflowId: 'ppt_workflow', childId: 'child_ppt', slideId: 'slide-1', revision: 2 }
    })
  })

  it('serializes slide ids, revisions, images, and user text inside each card', () => {
    const frame = {
      ...shape('frame', 'ppt-review:ppt_workflow:slide-1:frame', 'frame-1'),
      x: 0,
      y: 0,
      width: 480,
      height: 318,
      pptReviewRef: { workflowId: 'ppt_workflow', childId: 'child_ppt', slideId: 'slide-1', revision: 2, parentThreadId: 'thread-a', role: 'slide-frame' as const }
    }
    const preview = {
      ...shape('image', 'ppt-review:ppt_workflow:slide-1:preview', 'preview-1'),
      imageUrl: '.kun/images/opening-v2.png',
      pptReviewRef: { workflowId: 'ppt_workflow', childId: 'child_ppt', slideId: 'slide-1', revision: 2, parentThreadId: 'thread-a', role: 'preview-image' as const }
    }
    const annotation = {
      ...shape('text', 'User note', 'note-1'),
      x: 20,
      y: 20,
      width: 180,
      height: 40,
      textContent: 'Make the headline larger'
    }

    expect(serializeActivePptReviewContexts([frame, preview, annotation], 'thread-b')).toEqual([])
    expect(serializeActivePptReviewContexts([frame, preview, annotation], 'thread-a')).toEqual([{
      workflowId: 'ppt_workflow',
      childId: 'child_ppt',
      slides: [{
        slideId: 'slide-1',
        revision: 2,
        imagePath: '.kun/images/opening-v2.png',
        annotations: ['Make the headline larger']
      }]
    }])
  })
})
