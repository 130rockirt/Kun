import { describe, expect, it } from 'vitest'
import { makeToolResultItem } from '../domain/item.js'
import {
  pptSourceReadToolGate,
  pptWorkflowCompletionToolGate,
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

describe('pptWorkflowCompletionToolGate', () => {
  const base = {
    action: 'start' as const,
    workflowId: 'ppt_workflow',
    projectDir: '.kun/ppt/ppt_workflow',
    parentThreadId: 'thread_parent',
    previewMode: 'image-first' as const
  }

  it('keeps each PPT stage active until its structured completion tool succeeds', () => {
    expect(pptWorkflowCompletionToolGate({ ...base, stage: 'direction' }, [], 'turn_ppt'))
      .toEqual({ expectedToolName: 'ppt_create_direction_bundle' })
    expect(pptWorkflowCompletionToolGate({ ...base, stage: 'review' }, [], 'turn_ppt'))
      .toEqual({ expectedToolName: 'ppt_create_review_bundle' })
    expect(pptWorkflowCompletionToolGate({
      ...base, stage: 'review', previewMode: 'editable'
    }, [], 'turn_ppt')).toEqual({ expectedToolName: 'ppt_generate_previews' })
    expect(pptWorkflowCompletionToolGate({ ...base, stage: 'build' }, [], 'turn_ppt'))
      .toEqual({ expectedToolName: 'ppt_export' })
  })

  it('releases the stage after a successful structured completion result', () => {
    const result = makeToolResultItem({
      id: 'result_review', threadId: 'thread_child', turnId: 'turn_ppt',
      callId: 'call_review', toolName: 'ppt_create_review_bundle', output: {}, isError: false
    })
    expect(pptWorkflowCompletionToolGate({ ...base, stage: 'review' }, [result], 'turn_ppt'))
      .toEqual({})
  })
})
