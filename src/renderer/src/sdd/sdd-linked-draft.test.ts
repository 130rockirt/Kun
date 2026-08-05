import { describe, expect, it } from 'vitest'
import type { GuiPlanArtifact } from '../plan/plan-store'
import { resolveLinkedSddDraft } from './sdd-linked-draft'

const DRAFT_ID = '123e4567-e89b-12d3-a456-426614174000'

function plan(relativePath: string): GuiPlanArtifact {
  return {
    id: `plan:${relativePath}`,
    workspaceRoot: '/tmp/app',
    threadId: 'thread-1',
    featureName: 'Checkout',
    relativePath,
    sourceRequest: 'Build checkout',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T01:00:00.000Z'
  }
}

describe('resolveLinkedSddDraft', () => {
  it('prefers the current Session requirement over an SDD implementation plan', () => {
    expect(resolveLinkedSddDraft({
      plan: plan(`.kunsdd/plan/sdd-${DRAFT_ID}.md`),
      threadDraftRef: {
        workspaceRoot: '/tmp/app',
        draftRelativePath: '.kunsdd/requirements/draft-1/requirement.md'
      }
    })?.relativePath).toBe('.kunsdd/requirements/draft-1/requirement.md')
  })

  it('resolves a requirement from its active implementation plan when the thread has none', () => {
    expect(resolveLinkedSddDraft({
      plan: plan(`.kunsdd/plan/sdd-${DRAFT_ID}.md`),
      threadDraftRef: null
    })?.relativePath).toBe(`.kunsdd/requirements/${DRAFT_ID}/requirement.md`)
  })

  it('falls back to the current Session requirement when no plan is loaded', () => {
    expect(resolveLinkedSddDraft({
      plan: null,
      threadDraftRef: {
        workspaceRoot: '/tmp/app',
        draftRelativePath: '.kunsdd/requirements/draft-1/requirement.md'
      }
    })?.relativePath).toBe('.kunsdd/requirements/draft-1/requirement.md')
  })

  it('falls back to the Session when the active plan is not an SDD plan', () => {
    expect(resolveLinkedSddDraft({
      plan: plan('.kun/plans/general.md'),
      threadDraftRef: {
        workspaceRoot: '/tmp/app',
        draftRelativePath: '.kunsdd/requirements/draft-2/requirement.md'
      }
    })?.relativePath).toBe('.kunsdd/requirements/draft-2/requirement.md')
  })

  it('returns null when neither the thread nor the plan carries a requirement', () => {
    expect(resolveLinkedSddDraft({
      plan: plan('.kun/plans/general.md'),
      threadDraftRef: null
    })).toBeNull()
  })
})
