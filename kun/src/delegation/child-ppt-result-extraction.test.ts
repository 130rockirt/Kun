import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import { makeToolCallItem, makeToolResultItem } from '../domain/item.js'
import { createPptGeometryQaReport } from '../ppt/ppt-geometry-qa-report.js'
import { validPptDirectionBundle, validPptReviewBundle } from './child-ppt-test-fixtures.js'
import {
  childDeckArtifact,
  childDirectionBundle,
  childReviewBundle
} from './child-ppt-result-extraction.js'

const turnId = 'turn_ppt'
const threadId = 'child_ppt'

function toolPair(
  toolName: string,
  callId: string,
  output: unknown,
  isError = false
): TurnItem[] {
  return [
    makeToolCallItem({
      id: `item_${callId}_call`, turnId, threadId, callId, toolName, arguments: {}
    }),
    makeToolResultItem({
      id: `item_${callId}_result`, turnId, threadId, callId, toolName, output, isError
    })
  ]
}

describe('PPT child result extraction', () => {
  it('extracts directions independently before any governed design-plan mutation', () => {
    const direction = toolPair('ppt_create_direction_bundle', 'call_direction', {
      directionBundle: validPptDirectionBundle(threadId)
    })
    expect(childDirectionBundle(direction, turnId)).toMatchObject({
      workflowId: 'ppt_workflow', phase: 'awaiting_direction'
    })
    expect(childReviewBundle(direction, turnId)).toBeUndefined()
  })

  it('does not reuse directions that precede a successful governed plan submission', () => {
    const direction = toolPair('ppt_create_direction_bundle', 'call_direction', {
      directionBundle: validPptDirectionBundle(threadId)
    })
    const plan = toolPair('ppt_submit_design_plan', 'call_plan', { validated: true })
    expect(childDirectionBundle([...direction, ...plan], turnId)).toBeUndefined()
  })

  it('accepts only a review produced after the latest successful design plan', () => {
    const plan = toolPair('ppt_submit_design_plan', 'call_plan', { validated: true })
    const review = toolPair('ppt_create_review_bundle', 'call_review', {
      reviewBundle: validPptReviewBundle(threadId)
    })

    expect(childReviewBundle([...plan, ...review], turnId)).toMatchObject({
      workflowId: 'ppt_workflow', phase: 'awaiting_review'
    })
    expect(childReviewBundle([...review, ...plan], turnId)).toBeUndefined()
  })

  it('does not invalidate a review when a later plan submission failed without mutation', () => {
    const review = toolPair('ppt_generate_previews', 'call_review', {
      reviewBundle: validPptReviewBundle(threadId)
    })
    const failedPlan = toolPair(
      'ppt_submit_design_plan',
      'call_plan',
      { error: 'invalid design plan' },
      true
    )

    expect(childReviewBundle([...review, ...failedPlan], turnId)).toMatchObject({
      workflowId: 'ppt_workflow'
    })
  })

  it('rejects forged direction and review payloads even after successful named tool calls', () => {
    const forgedDirection = toolPair('ppt_create_direction_bundle', 'call_direction', {
      directionBundle: { workflowId: 'ppt_workflow', phase: 'awaiting_direction' }
    })
    const forgedReview = toolPair('ppt_create_review_bundle', 'call_review', {
      reviewBundle: { workflowId: 'ppt_workflow', phase: 'awaiting_review' }
    })
    expect(childDirectionBundle(forgedDirection, turnId)).toBeUndefined()
    expect(childReviewBundle(forgedReview, turnId)).toBeUndefined()
  })

  it('rejects an exported artifact followed by a successful plan mutation', () => {
    const exported = toolPair('ppt_export', 'call_export', {
      output: 'presentations/deck.pptx', validated: true
    })
    const plan = toolPair('ppt_submit_design_plan', 'call_plan', { validated: true })

    expect(childDeckArtifact([...exported, ...plan], turnId)).toBeUndefined()
  })

  it('accepts only a schema-valid failed-recoverable review from an errored export', () => {
    const issue = createPptGeometryQaReport({
      attempt: 2,
      slideCount: 1,
      issues: [{
        rule: 'bounds.out_of_slide', severity: 'error', slideIndex: 0, shapeId: 'shape-1',
        rect: { x: 0.9, y: 0, width: 0.1, height: 0.2 },
        message: 'Shape leaves the slide', repairHint: 'Move the shape inward'
      }]
    }).issues[0]
    const reviewBundle = {
      workflowId: 'ppt_workflow', childId: threadId,
      manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
      previewMode: 'image-first', deckTitle: 'QA deck', styleFingerprint: 'style',
      phase: 'failed_recoverable',
      slides: [{
        slideId: 'slide-1', index: 0, title: 'Slide 1', revision: 1,
        status: 'failed', error: 'preview unavailable', qaIssues: [issue]
      }]
    }
    const recoverable = toolPair('ppt_export', 'call_export', {
      phase: 'failed_recoverable', reviewBundle
    }, true)
    expect(childReviewBundle(recoverable, turnId)).toEqual(reviewBundle)

    const forged = toolPair('ppt_export', 'call_forged', {
      phase: 'failed_recoverable', reviewBundle: { workflowId: 'ppt_workflow' }
    }, true)
    expect(childReviewBundle(forged, turnId)).toBeUndefined()
    expect(childReviewBundle(toolPair('ppt_export', 'call_phase_mismatch', {
      phase: 'failed_recoverable', reviewBundle: { ...reviewBundle, phase: 'completed' }
    }, true), turnId)).toBeUndefined()
  })

  it('extracts a completed QA projection only from a successful validated export', () => {
    const issue = createPptGeometryQaReport({
      slideCount: 1,
      issues: [{
        rule: 'text.minimum_font_size', severity: 'warning', slideIndex: 0, shapeId: 'shape-1',
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        message: 'Caption is small', repairHint: 'Increase the caption size'
      }]
    }).issues[0]
    const reviewBundle = {
      workflowId: 'ppt_workflow', childId: threadId,
      manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
      previewMode: 'image-first', deckTitle: 'QA deck', styleFingerprint: 'style', phase: 'completed',
      slides: [{
        slideId: 'slide-1', index: 0, title: 'Slide 1', revision: 1,
        status: 'failed', error: 'preview unavailable', qaIssues: [issue]
      }]
    }
    const exported = toolPair('ppt_export', 'call_export', {
      phase: 'completed', validated: true, reviewBundle
    })
    expect(childReviewBundle(exported, turnId)).toEqual(reviewBundle)
    expect(childReviewBundle(toolPair('ppt_export', 'call_invalid', {
      phase: 'completed', validated: false, reviewBundle
    }), turnId)).toBeUndefined()
    expect(childReviewBundle(toolPair('ppt_export', 'call_blocking', {
      phase: 'completed', validated: true,
      reviewBundle: {
        ...reviewBundle,
        slides: reviewBundle.slides.map((slide) => ({
          ...slide, qaIssues: slide.qaIssues.map((qaIssue) => ({ ...qaIssue, severity: 'error' }))
        }))
      }
    }), turnId)).toBeUndefined()
  })
})
