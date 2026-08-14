import { describe, expect, it } from 'vitest'
import { createPptGeometryQaReport, type PptGeometryQaIssueDraft } from '../../ppt/ppt-geometry-qa-report.js'
import { PptReviewManifestV1, createPptReviewManifest, toPptReviewBundle } from '../../ppt/ppt-review-manifest.js'
import {
  nextPptGeometryQaAttempt,
  pptGeometryQaFailureOutput,
  projectPptGeometryQaReport
} from './ppt-agent-export-qa.js'

function manifest() {
  const created = createPptReviewManifest({
    workflowId: 'ppt_qa',
    parentThreadId: 'parent',
    childId: 'child',
    projectDir: 'deck',
    deckTitle: 'QA deck',
    styleSpec: {
      fingerprint: 'style',
      fonts: [],
      colorTokens: {},
      typeScale: {},
      spacingScale: [],
      backgroundLanguage: '',
      imageTreatment: '',
      chartTreatment: ''
    },
    slides: [
      { slideId: 'slide-a', title: 'A', prompt: 'A' },
      { slideId: 'slide-b', title: 'B', prompt: 'B' }
    ]
  })
  return PptReviewManifestV1.parse({
    ...created,
    phase: 'awaiting_review',
    slides: created.slides.map((slide, index) => ({
      ...slide,
      previewPath: `deck/.kun-ppt-review/previews/slide-${index + 1}.png`,
      revision: 1,
      status: 'ready'
    }))
  })
}

function issue(slideIndex = 0, severity: 'error' | 'warning' = 'error'): PptGeometryQaIssueDraft {
  return {
    rule: 'bounds.out_of_slide',
    severity,
    slideIndex,
    shapeId: `shape-${slideIndex}`,
    rect: { x: 0.9, y: 0.1, width: 0.1, height: 0.2 },
    message: 'Shape leaves the slide',
    repairHint: 'Move the shape inward'
  }
}

describe('PPT export geometry QA projection', () => {
  it('persists slide-local issues and exposes two bounded repair retries', () => {
    const initial = projectPptGeometryQaReport(manifest(), createPptGeometryQaReport({
      attempt: 0,
      slideCount: 2,
      issues: [issue(1)]
    }))
    expect(initial).toMatchObject({
      blocked: true,
      exhausted: false,
      repairAttemptsRemaining: 2,
      projection: { reportPath: '.kun-ppt-review/qa.json', attempt: 0, counts: { errors: 1 } },
      manifest: { phase: 'validating_deck' }
    })
    expect(initial.manifest.slides[0].qaIssues).toEqual([])
    expect(initial.manifest.slides[1].qaIssues).toEqual([
      expect.objectContaining({ slideIndex: 1, shapeId: 'shape-1' })
    ])
    expect(nextPptGeometryQaAttempt(initial.manifest)).toBe(1)

    const second = projectPptGeometryQaReport(initial.manifest, createPptGeometryQaReport({
      attempt: 1,
      slideCount: 2,
      issues: [issue()]
    }))
    expect(second.repairAttemptsRemaining).toBe(1)
    expect(nextPptGeometryQaAttempt(second.manifest)).toBe(2)

    const exhausted = projectPptGeometryQaReport(second.manifest, createPptGeometryQaReport({
      attempt: 2,
      slideCount: 2,
      issues: [issue()]
    }))
    expect(exhausted).toMatchObject({
      blocked: true,
      exhausted: true,
      repairAttemptsRemaining: 0,
      manifest: { phase: 'failed_recoverable' }
    })
    expect(nextPptGeometryQaAttempt(exhausted.manifest)).toBeUndefined()
  })

  it('replaces stale markers and permits warning-only output', () => {
    const failed = projectPptGeometryQaReport(manifest(), createPptGeometryQaReport({
      slideCount: 2,
      issues: [issue()]
    }))
    const warning = createPptGeometryQaReport({
      attempt: 1,
      slideCount: 2,
      issues: [issue(1, 'warning')]
    })
    const recovered = projectPptGeometryQaReport(failed.manifest, warning)

    expect(recovered.blocked).toBe(false)
    expect(recovered.manifest.slides[0].qaIssues).toEqual([])
    expect(recovered.manifest.slides[1].qaIssues).toEqual([
      expect.objectContaining({ severity: 'warning' })
    ])
    expect(PptReviewManifestV1.safeParse({
      ...recovered.manifest,
      phase: 'completed',
      validatedExport: {
        output: 'presentations/deck.pptx',
        planFingerprint: 'a'.repeat(64),
        slides: 2,
        qa: recovered.projection
      }
    }).success).toBe(true)
  })

  it('returns a fresh failed-recoverable review bundle after exhaustion', () => {
    const report = createPptGeometryQaReport({ attempt: 2, slideCount: 2, issues: [issue()] })
    const disposition = projectPptGeometryQaReport(manifest(), report)
    const reviewBundle = toPptReviewBundle(disposition.manifest, 'deck/.kun-ppt-review/manifest.json')
    const failure = pptGeometryQaFailureOutput({ report, disposition, reviewBundle })

    expect(failure).toMatchObject({
      validated: false,
      phase: 'failed_recoverable',
      repairAttemptsRemaining: 0,
      reviewBundle: {
        phase: 'failed_recoverable',
        slides: [
          { qaIssues: [expect.objectContaining({ shapeId: 'shape-0' })] },
          { qaIssues: [] }
        ]
      }
    })
  })

  it('rejects validated artifacts whose projected QA still has errors', () => {
    const failed = projectPptGeometryQaReport(manifest(), createPptGeometryQaReport({
      slideCount: 2,
      issues: [issue()]
    }))
    expect(PptReviewManifestV1.safeParse({
      ...failed.manifest,
      phase: 'completed',
      validatedExport: {
        output: 'presentations/deck.pptx',
        planFingerprint: 'a'.repeat(64),
        slides: 2,
        qa: failed.projection
      }
    }).success).toBe(false)
  })
})
