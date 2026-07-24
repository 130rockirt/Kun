import { describe, expect, it } from 'vitest'
import { canGuideQueuedMessage } from './queued-message-guidance'

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
})
