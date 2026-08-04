import { describe, expect, it } from 'vitest'
import {
  canGuideQueuedMessage,
  queuedMessageGuidancePayload
} from './queued-message-guidance'

describe('canGuideQueuedMessage', () => {
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
