import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { isSubagentBlock } from './message-timeline-process'

describe('isSubagentBlock', () => {
  it('recognizes fast_context even before child metadata arrives', () => {
    const block: ChatBlock = {
      kind: 'tool',
      id: 'tool_explore',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'fast_context',
      status: 'running',
      toolKind: 'tool_call',
      meta: { toolName: 'fast_context' }
    }
    expect(isSubagentBlock(block)).toBe(true)
  })

  it('recognizes persisted ppt_agent results without child metadata', () => {
    expect(isSubagentBlock({
      kind: 'tool',
      id: 'tool_ppt_history',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'ppt_agent',
      status: 'success',
      toolKind: 'tool_call',
      meta: { toolName: 'ppt_agent' }
    })).toBe(true)
  })

  it('still recognizes delegate_task and child-bearing tools', () => {
    expect(isSubagentBlock({
      kind: 'tool',
      id: 'tool_delegate',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'delegate_task',
      status: 'running',
      toolKind: 'tool_call',
      meta: { toolName: 'delegate_task' }
    })).toBe(true)

    expect(isSubagentBlock({
      kind: 'tool',
      id: 'tool_child',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'custom',
      status: 'running',
      toolKind: 'tool_call',
      meta: {
        toolName: 'custom_tool',
        child: {
          childId: 'child_1',
          parentThreadId: 'thr',
          parentTurnId: 'turn',
          childStatus: 'running',
          childSeq: 1
        }
      }
    })).toBe(true)
  })

  it('does not treat ordinary tools as subagent cards', () => {
    expect(isSubagentBlock({
      kind: 'tool',
      id: 'tool_grep',
      createdAt: '2026-08-07T00:00:00.000Z',
      summary: 'grep',
      status: 'running',
      toolKind: 'tool_call',
      meta: { toolName: 'grep' }
    })).toBe(false)
  })
})
