import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  isManagedPlanBuildConversation,
  shouldShowSideSessionReturnBar
} from './workbench-side-session-mode'

function thread(patch: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id: 'thread-side',
    title: 'Conversation',
    updatedAt: '2026-08-14T00:00:00.000Z',
    model: 'auto',
    mode: 'agent',
    workspace: '/workspace',
    relation: 'side',
    parentThreadId: 'thread-parent',
    ...patch
  }
}

describe('workbench side-session presentation', () => {
  it('keeps ordinary subagent side threads on the process return bar', () => {
    expect(shouldShowSideSessionReturnBar({
      thread: thread(),
      relation: 'side',
      parentThreadId: 'thread-parent'
    })).toBe(true)
  })

  it('presents a managed plan-build side thread as an interactive main conversation', () => {
    const execution = thread({
      workspace: '/Users/zxy/.kun/worktrees/run-1/project',
      planBuildRunId: 'run-1'
    })

    expect(isManagedPlanBuildConversation(execution)).toBe(true)
    expect(shouldShowSideSessionReturnBar({
      thread: execution,
      relation: 'side',
      parentThreadId: 'thread-parent'
    })).toBe(false)
  })

  it('does not show the return bar without a side-thread parent', () => {
    expect(shouldShowSideSessionReturnBar({
      thread: thread({ relation: 'primary', parentThreadId: undefined }),
      relation: 'primary',
      parentThreadId: null
    })).toBe(false)
  })
})
