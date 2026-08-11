import { describe, expect, it } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import { subagentResumeToolGate } from './model-step-preparation-helpers.js'

describe('subagentResumeToolGate', () => {
  const request = { childId: 'child_resume', expectedResumeCount: 2 }

  it('hard-requires delegate_task with the exact structured request on the first action', () => {
    const gate = subagentResumeToolGate({ subagentResume: request }, [], 'turn_resume')

    expect(gate.requiredToolName).toBe('delegate_task')
    expect(gate.instruction).toContain('"child_resume"')
    expect(gate.instruction).toContain('expectedResumeCount set to 2')
    expect(gate.instruction).toContain('Do not create a new child')
  })

  it('releases the first-action gate after a delegate_task result, including a rejection', () => {
    const result = makeToolResultItem({
      id: 'result_resume',
      threadId: 'thread_parent',
      turnId: 'turn_resume',
      callId: 'call_resume',
      toolName: 'delegate_task',
      output: 'stale resume request',
      isError: true
    })

    expect(subagentResumeToolGate({ subagentResume: request }, [result], 'turn_resume')).toEqual({})
  })
})
