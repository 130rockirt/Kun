import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import { makeToolCallItem, makeToolResultItem } from '../domain/item.js'
import {
  childDeckArtifact,
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
  it('accepts only a review produced after the latest successful design plan', () => {
    const plan = toolPair('ppt_submit_design_plan', 'call_plan', { validated: true })
    const review = toolPair('ppt_create_review_bundle', 'call_review', {
      reviewBundle: { workflowId: 'ppt_workflow', phase: 'awaiting_review' }
    })

    expect(childReviewBundle([...plan, ...review], turnId)).toMatchObject({
      workflowId: 'ppt_workflow', phase: 'awaiting_review'
    })
    expect(childReviewBundle([...review, ...plan], turnId)).toBeUndefined()
  })

  it('does not invalidate a review when a later plan submission failed without mutation', () => {
    const review = toolPair('ppt_generate_previews', 'call_review', {
      reviewBundle: { workflowId: 'ppt_workflow', phase: 'awaiting_review' }
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

  it('rejects an exported artifact followed by a successful plan mutation', () => {
    const exported = toolPair('ppt_export', 'call_export', {
      output: 'presentations/deck.pptx', validated: true
    })
    const plan = toolPair('ppt_submit_design_plan', 'call_plan', { validated: true })

    expect(childDeckArtifact([...exported, ...plan], turnId)).toBeUndefined()
  })
})
