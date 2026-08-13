import { describe, expect, it } from 'vitest'
import { StartTurnRequest } from './turns.js'

describe('subagent resume turn contract', () => {
  it('accepts a strict child id and optimistic resume count', () => {
    expect(StartTurnRequest.parse({
      prompt: 'continue',
      messageSource: 'subagent_resume',
      subagentResume: { childId: 'child_1', expectedResumeCount: 3 }
    })).toMatchObject({
      messageSource: 'subagent_resume',
      subagentResume: { childId: 'child_1', expectedResumeCount: 3 }
    })
  })

  it.each([
    { childId: '', expectedResumeCount: 0 },
    { childId: 'child_1', expectedResumeCount: -1 },
    { childId: 'child_1', expectedResumeCount: 0, extra: true }
  ])('rejects invalid or extended resume metadata', (subagentResume) => {
    expect(StartTurnRequest.safeParse({ prompt: 'continue', subagentResume }).success).toBe(false)
  })
})

describe('Design continuation turn contract', () => {
  it('accepts an auditable internal progress source without resume metadata', () => {
    expect(StartTurnRequest.parse({
      prompt: 'generate the pinned logo artifact',
      messageSource: 'design_continuation'
    })).toMatchObject({
      messageSource: 'design_continuation'
    })
  })
})
