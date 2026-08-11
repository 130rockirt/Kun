import { describe, expect, it } from 'vitest'
import { createPptGeometryQaReport } from '../../ppt/ppt-geometry-qa-report.js'
import { reviewBundleContractError } from './ppt-agent-output-contracts.js'

const expected = {
  childId: 'child',
  workflowId: 'workflow',
  projectDir: '.kun/ppt/workflow',
  previewMode: 'image-first' as const
}

function reviewBundle(
  phase: 'awaiting_review' | 'failed_recoverable' | 'completed',
  includeQa = true,
  severity: 'error' | 'warning' = phase === 'completed' ? 'warning' : 'error'
) {
  const issue = createPptGeometryQaReport({
    slideCount: 1,
    issues: [{
      rule: 'text.minimum_font_size', severity, slideIndex: 0, shapeId: 'shape-1',
      rect: { x: 0, y: 0, width: 0.2, height: 0.1 },
      message: 'Text is below the minimum', repairHint: 'Increase the font size'
    }]
  }).issues[0]
  return {
    workflowId: expected.workflowId,
    childId: expected.childId,
    manifestPath: `${expected.projectDir}/.kun-ppt-review/manifest.json`,
    previewMode: expected.previewMode,
    deckTitle: 'QA deck',
    styleFingerprint: 'style',
    phase,
    slides: [{
      slideId: 'slide-1', index: 0, title: 'Slide 1', revision: 1, status: 'failed',
      error: 'preview unavailable', ...(includeQa ? { qaIssues: [issue] } : {})
    }]
  }
}

describe('PPT review output contract', () => {
  it('accepts bound recoverable and completed QA projections, but not an ordinary completed bundle', () => {
    expect(reviewBundleContractError(
      reviewBundle('failed_recoverable'), expected.childId, expected.workflowId,
      expected.projectDir, expected.previewMode
    )).toBe('')
    expect(reviewBundleContractError(
      reviewBundle('completed'), expected.childId, expected.workflowId,
      expected.projectDir, expected.previewMode
    )).toBe('')
    expect(reviewBundleContractError(
      reviewBundle('completed', false), expected.childId, expected.workflowId,
      expected.projectDir, expected.previewMode
    )).toContain('completed QA projection')
    expect(reviewBundleContractError(
      reviewBundle('completed', true, 'error'), expected.childId, expected.workflowId,
      expected.projectDir, expected.previewMode
    )).toContain('completed QA projection')
  })
})
