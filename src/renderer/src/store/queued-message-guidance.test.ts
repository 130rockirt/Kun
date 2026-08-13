import { describe, expect, it } from 'vitest'
import {
  canGuideQueuedMessage,
  queuedMessageGuidancePayload,
  queuedMessageMatchesRunningTurn
} from './queued-message-guidance'

describe('canGuideQueuedMessage', () => {
  it('requires queued and admitted turn surfaces to match in both directions', () => {
    expect(queuedMessageMatchesRunningTurn(
      { id: 'q-design', text: 'design', agentSurface: 'design' },
      { agentSurface: 'code' }
    )).toBe(false)
    expect(queuedMessageMatchesRunningTurn(
      { id: 'q-code', text: 'code', agentSurface: 'code' },
      { agentSurface: 'design' }
    )).toBe(false)
  })

  it('allows Design guidance only for the same frozen profile and target', () => {
    const target = { documentId: 'doc_a', boardArtifactId: 'board_a' }
    const profile = {
      version: 1 as const, documentTarget: target, outputMedium: 'html' as const,
      target: 'web' as const, preset: 'none' as const, context: { tone: [] }
    }
    const queued = {
      id: 'q-design-same', text: 'refine', agentSurface: 'design' as const,
      designProfile: profile, designDocumentTarget: target
    }
    expect(queuedMessageMatchesRunningTurn(queued, {
      agentSurface: 'design', designProfile: profile, designDocumentTarget: target
    })).toBe(true)
    expect(queuedMessageMatchesRunningTurn(queued, {
      agentSurface: 'design', designProfile: profile,
      designDocumentTarget: { ...target, documentId: 'doc_b' }
    })).toBe(false)
  })

  it('allows plain text queued during a plan-mode turn', () => {
    expect(canGuideQueuedMessage({
      id: 'q-plan-text',
      text: 'Also follow the hasconfig rules',
      mode: 'plan'
    })).toBe(true)
  })

  it('keeps a queued plan message with its own GUI plan context out of text-only guidance', () => {
    expect(canGuideQueuedMessage({
      id: 'q-plan-context',
      text: 'Refine the saved plan',
      mode: 'plan',
      guiPlan: {
        operation: 'refine',
        workspaceRoot: '/workspace',
        relativePath: '.kunsdd/plan/auth.md',
        planId: '/workspace:.kunsdd/plan/auth.md'
      }
    })).toBe(false)
  })

  it('uses visible Design canvas text instead of the expanded queued prompt for guidance', () => {
    const message = {
      id: 'q-design-text',
      text: 'Internal Design prompt with canvas snapshots and generation instructions',
      displayText: 'Make the title smaller',
      guiDesignCanvas: true,
      guiDesignMode: true,
      agentSurface: 'design' as const
    }

    expect(canGuideQueuedMessage(message)).toBe(true)
    expect(queuedMessageGuidancePayload(message)).toEqual({
      text: 'Make the title smaller',
      displayText: 'Make the title smaller'
    })
  })

  it('allows image attachments while rejecting documents and unbound metadata', () => {
    expect(queuedMessageGuidancePayload({
      text: 'Use this reference',
      attachmentIds: ['att_image'],
      attachments: [{ id: 'att_image', kind: 'image' }]
    })).toEqual({
      text: 'Use this reference',
      attachmentIds: ['att_image']
    })
    expect(queuedMessageGuidancePayload({
      text: 'Read this document',
      attachmentIds: ['att_document'],
      attachments: [{ id: 'att_document', kind: 'document' }]
    })).toBeNull()
    expect(queuedMessageGuidancePayload({
      text: 'Missing attachment id',
      attachments: [{ id: 'att_image', kind: 'image' }]
    })).toBeNull()
  })

  it('keeps targeted Design artifacts and canvas prompts without visible text queued', () => {
    expect(canGuideQueuedMessage({
      id: 'q-design-svg',
      text: 'Internal SVG prompt',
      displayText: 'Animate the logo',
      guiDesignMode: true,
      guiDesignArtifact: {
        kind: 'svg',
        artifactId: 'logo',
        relativePath: '.kun-design/logo/v1.svg'
      }
    })).toBe(false)
    expect(canGuideQueuedMessage({
      id: 'q-design-internal-only',
      text: 'Internal canvas prompt',
      guiDesignCanvas: true,
      guiDesignMode: true
    })).toBe(false)
  })
})
