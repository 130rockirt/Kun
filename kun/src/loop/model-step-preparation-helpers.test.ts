import { describe, expect, it } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import {
  pptSourceReadToolGate,
  requiredWorkflowToolGate,
  subagentResumeToolGate
} from './model-step-preparation-helpers.js'

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

describe('requiredWorkflowToolGate', () => {
  it('keeps a delegated resume ahead of the Work PPT source-read gate', () => {
    const gate = requiredWorkflowToolGate(
      { subagentResume: { childId: 'child_resume', expectedResumeCount: 1 } },
      {
        action: 'start', workflowId: 'ppt_workflow', projectDir: '.kun/ppt/ppt_workflow',
        parentThreadId: 'thread_parent', previewMode: 'image-first', sourceReadRequired: true
      },
      [],
      'turn_resume',
      undefined
    )

    expect(gate.requiredToolName).toBe('delegate_task')
    expect(gate.subagentResumeInstruction).toContain('child_resume')
  })
})

describe('pptSourceReadToolGate', () => {
  const scope = {
    action: 'start' as const,
    workflowId: 'ppt_workflow',
    projectDir: '.kun/ppt/ppt_workflow',
    parentThreadId: 'thread_parent',
    previewMode: 'image-first' as const,
    sourceReadRequired: true
  }

  it('hard-requires reading the Work Markdown before presentation planning', () => {
    const gate = pptSourceReadToolGate(scope, [], 'turn_ppt')

    expect(gate.requiredToolName).toBe('read')
    expect(gate.instruction).toContain('Markdown source')
  })

  it('releases the gate once the read call has a result', () => {
    const result = makeToolResultItem({
      id: 'result_source', threadId: 'thread_child', turnId: 'turn_ppt',
      callId: 'call_source', toolName: 'read', output: '# Source', isError: false
    })

    expect(pptSourceReadToolGate(scope, [result], 'turn_ppt')).toEqual({})
  })
})
