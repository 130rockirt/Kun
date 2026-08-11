import { PptReviewBundleV1 } from '../ppt/ppt-review-manifest.js'
import { PptDirectionBundleV1, pptDirectionSlidesFingerprint } from '../ppt/ppt-direction-workflow.js'

export function validPptDirectionBundle(childId = 'child_ppt') {
  const slides = [{ slideId: 'slide-1', index: 0, title: 'Opening', promptHash: 'a'.repeat(64) }]
  return PptDirectionBundleV1.parse({
    schemaVersion: 1, workflowId: 'ppt_workflow', childId,
    manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
    previewMode: 'image-first', deckTitle: 'Direction deck', phase: 'awaiting_direction',
    recommendedDirectionId: 'direction-1', slidesFingerprint: pptDirectionSlidesFingerprint(slides), slides,
    directions: [1, 2, 3].map((index) => ({
      directionId: `direction-${index}`, name: `Direction ${index}`,
      rationale: `A materially distinct visual direction number ${index}`,
      revision: 1, recommended: index === 1,
      planFingerprint: String(index).repeat(64), candidateFingerprint: String(index + 3).repeat(64),
      fonts: [`Display ${index}`, `Body ${index}`],
      colors: ['#112233', '#445566', '#778899', '#AABBCC'],
      layout: `Layout ${index}`, background: `Background ${index}`, imagery: `Imagery ${index}`,
      previews: ['cover', 'representative', 'complex'].map((role, roleIndex) => ({
        role, imagePath: `.kun/images/direction-${index}-${role}.png`,
        sha256: `${index}${roleIndex + 1}`.repeat(32), width: 1600, height: 900
      }))
    }))
  })
}

export function validPptReviewBundle(childId = 'child_ppt') {
  return PptReviewBundleV1.parse({
    workflowId: 'ppt_workflow', childId,
    manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
    previewMode: 'image-first', deckTitle: 'Review deck', styleFingerprint: 'style',
    phase: 'awaiting_review',
    slides: [{
      slideId: 'slide-1', index: 0, title: 'Opening',
      previewPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/previews/slide-1.png',
      revision: 1, status: 'ready'
    }]
  })
}
