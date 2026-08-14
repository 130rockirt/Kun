import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { SubagentCallCard } from './SubagentCallCard'

const selectThread = vi.fn(async () => undefined)
const sendMessage = vi.fn(async () => true)
let chatBusy = false

vi.mock('../../store/chat-store', () => ({
  useChatStore: (selector: (state: {
    selectThread: typeof selectThread
    sendMessage: typeof sendMessage
    busy: boolean
  }) => unknown) => selector({ selectThread, sendMessage, busy: chatBusy })
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? _key
  })
}))

describe('SubagentCallCard resume action', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    chatBusy = false
    sendMessage.mockClear()
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it('submits one stable request only for the latest resumable generic attempt', async () => {
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, {
        block: failedChildBlock('delegate_task')
      }))
    })

    let button = renderer!.root.findByProps({ 'data-testid': 'subagent-resume-button' })
    await act(async () => {
      await button.props.onClick({ stopPropagation() {} })
    })
    button = renderer!.root.findByProps({ 'data-testid': 'subagent-resume-button' })
    await act(async () => {
      await button.props.onClick({ stopPropagation() {} })
    })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Continue the interrupted delegated task'),
      'agent',
      {
        clientRequestId: 'subagent-resume:2:child_resume',
        expectedThreadId: 'thread_parent',
        displayText: 'Continue interrupted subagent',
        orchestration: 'direct',
        subagentResume: { childId: 'child_resume', expectedResumeCount: 2 }
      }
    )

    chatBusy = true
    await act(async () => {
      renderer!.update(createElement(SubagentCallCard, { block: failedChildBlock('delegate_task') }))
    })
    chatBusy = false
    await act(async () => {
      renderer!.update(createElement(SubagentCallCard, { block: failedChildBlock('delegate_task') }))
    })
    expect(renderer!.root.findByProps({ 'data-testid': 'subagent-resume-button' }).props.disabled).toBe(false)

    await act(async () => {
      renderer!.update(createElement(SubagentCallCard, { block: failedChildBlock('graph') }))
    })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'subagent-resume-button' })).toHaveLength(0)
  })
})

function failedChildBlock(launcher: 'delegate_task' | 'graph'): ToolBlock {
  return {
    kind: 'tool',
    id: `tool_${launcher}`,
    turnId: 'turn_parent',
    createdAt: '2026-08-11T00:00:00.000Z',
    summary: 'delegate_task',
    status: 'error',
    toolKind: 'tool_call',
    detail: JSON.stringify({ childId: 'child_resume', status: 'failed' }),
    meta: {
      toolName: 'delegate_task',
      child: {
        parentThreadId: 'thread_parent',
        parentTurnId: 'turn_parent',
        childId: 'child_resume',
        childStatus: 'failed',
        childLauncher: launcher,
        childTerminationReason: 'manual_stop',
        resumable: launcher === 'delegate_task',
        resumeCount: 2,
        childSeq: 1
      }
    }
  }
}
