import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { SubagentCallCard } from './SubagentCallCard'

const { runtimeRequest } = vi.hoisted(() => ({ runtimeRequest: vi.fn() }))
const selectThread = vi.fn(async () => undefined)
const sendMessage = vi.fn(async () => true)

vi.mock('../../agent/runtime-client', () => ({
  rendererRuntimeClient: { runtimeRequest }
}))

vi.mock('../../store/chat-store', () => ({
  useChatStore: (selector: (state: {
    selectThread: typeof selectThread
    sendMessage: typeof sendMessage
    busy: boolean
  }) => unknown) => selector({ selectThread, sendMessage, busy: false })
}))

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    subagentStatusQueued: 'Queued',
    subagentStatusRunning: 'Running',
    subagentStatusDone: 'Done',
    subagentStatusStopped: 'Stopped',
    subagentStatusFailed: 'Failed',
    subagentStatusAwaiting: 'Awaiting approval',
    subagentStopAction: 'Stop subagent',
    subagentStopShort: 'Stop',
    subagentStoppingAction: 'Stopping subagent',
    subagentStoppingShort: 'Stopping',
    subagentStopFailed: 'Could not stop',
    subagentOpenSession: 'Open sub-session',
    subagentOpenSessionShort: 'Open',
    subagentNotRecorded: 'Not recorded',
    subagentDefaultName: 'Subagent'
  }
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string }) =>
        labels[key] ?? (typeof fallback === 'string' ? fallback : fallback?.defaultValue) ?? key
    })
  }
})

describe('SubagentCallCard stop action', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    runtimeRequest.mockReset()
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it('encodes the child id, prevents duplicate requests, and settles as stopped', async () => {
    let resolveRequest = (_value: { ok: boolean; status: number; body: string }): void => undefined
    const pending = new Promise<{ ok: boolean; status: number; body: string }>((resolve) => {
      resolveRequest = resolve
    })
    runtimeRequest.mockReturnValueOnce(pending)
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, { block: runningBlock() }))
    })

    const button = renderer!.root.findByProps({ 'data-testid': 'subagent-stop-button' })
    await act(async () => {
      button.props.onClick({ stopPropagation() {} })
      button.props.onClick({ stopPropagation() {} })
      await Promise.resolve()
    })
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/delegation/abort/child%2Fone', 'POST')
    expect(renderer!.root.findByProps({ 'data-testid': 'subagent-stop-button' }).props.disabled).toBe(true)
    expect(instanceText(renderer!.root)).toContain('Stopping')

    await act(async () => {
      resolveRequest({ ok: true, status: 200, body: JSON.stringify({ aborted: true }) })
      await pending
      await Promise.resolve()
    })
    expect(renderer!.root.findByProps({ 'data-testid': 'subagent-stop-button' }).props.disabled).toBe(true)

    await act(async () => {
      renderer!.update(createElement(SubagentCallCard, { block: stoppedBlock() }))
    })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'subagent-stop-button' })).toHaveLength(0)
    expect(instanceText(renderer!.root)).toContain('Stopped')
    expect(renderer!.root.findByProps({ 'data-testid': 'subagent-call-card' }).props['aria-label'])
      .toContain('Stopped')
  })

  it('shows recoverable feedback when a stale stop request is not accepted', async () => {
    runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({ childId: 'child/one', aborted: false })
    })
    await act(async () => {
      renderer = create(createElement(SubagentCallCard, { block: runningBlock() }))
    })

    await act(async () => {
      renderer!.root.findByProps({ 'data-testid': 'subagent-stop-button' })
        .props.onClick({ stopPropagation() {} })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(instanceText(renderer!.root.findByProps({ role: 'alert' }))).toBe('Could not stop')
    expect(renderer!.root.findByProps({ 'data-testid': 'subagent-stop-button' }).props.disabled).toBe(false)
  })
})

function runningBlock(): ToolBlock {
  return childBlock('running', undefined)
}

function stoppedBlock(): ToolBlock {
  return childBlock('aborted', 'user_stop')
}

function childBlock(
  status: 'running' | 'aborted',
  terminationReason: 'user_stop' | undefined
): ToolBlock {
  return {
    kind: 'tool',
    id: 'tool_child_stop',
    turnId: 'turn_parent',
    createdAt: '2026-08-12T00:00:00.000Z',
    summary: 'Focused child task',
    status: status === 'running' ? 'running' : 'error',
    toolKind: 'tool_call',
    detail: JSON.stringify({
      childId: 'child/one',
      status,
      ...(terminationReason ? { terminationReason } : {})
    }),
    meta: {
      toolName: 'delegate_task',
      child: {
        parentThreadId: 'thread_parent',
        parentTurnId: 'turn_parent',
        childId: 'child/one',
        childLabel: 'Focused child task',
        childStatus: status,
        childTerminationReason: terminationReason,
        childSeq: 1
      }
    }
  }
}

function instanceText(node: { children: Array<string | { children?: unknown[] }> }): string {
  return node.children.map((child) => {
    if (typeof child === 'string') return child
    return child && Array.isArray(child.children)
      ? instanceText(child as { children: Array<string | { children?: unknown[] }> })
      : ''
  }).join(' ')
}
