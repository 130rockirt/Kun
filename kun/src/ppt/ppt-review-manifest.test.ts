import { describe, expect, it } from 'vitest'
import { PptReviewBundleV1 } from './ppt-review-manifest.js'

const bundle = {
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
    previewPath: 'deck/.kun-ppt-review/previews/opening.png',
    revision: 1,
    status: 'ready'
  }]
}

describe('PptReviewBundleV1', () => {
  it('accepts only contiguous slide indexes and workspace-relative paths', () => {
    expect(PptReviewBundleV1.safeParse(bundle).success).toBe(true)
    expect(PptReviewBundleV1.safeParse({
      ...bundle,
      manifestPath: 'https://example.com/manifest.json'
    }).success).toBe(false)
    expect(PptReviewBundleV1.safeParse({
      ...bundle,
      slides: [{ ...bundle.slides[0], index: 1 }]
    }).success).toBe(false)
  })
})
