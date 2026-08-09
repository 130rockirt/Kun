import { describe, expect, it } from 'vitest'
import type { RuntimeProjectionAction } from '../agent/runtime-projection-actions'
import type { ChatState } from './chat-store-types'
import { reduceChatProjection } from './chat-projection-reducer'

const NOW = Date.parse('2026-07-11T00:00:00.000Z')
const context = {
  now: NOW,
  clearRecoveringError: (error: string | null) => error === 'recovering' ? null : error,
  goalTimelineText: (goal: ChatState['activeThreadGoal'], cleared?: boolean) =>
    cleared || !goal ? 'Goal cleared' : `Goal ${goal.status}: ${goal.objective}`,
  runtimeStatusText: () => 'Runtime status',
  runtimeErrorView: (event: { message: string; code?: string }) => ({
    summary: `Summary: ${event.message}`,
    message: event.message,
    ...(event.code ? { code: event.code } : {})
  }),
  upsertRuntimeError: (blocks: ChatState['blocks'], block: ChatState['blocks'][number]) => {
    const index = blocks.findIndex((candidate) => candidate.id === block.id)
    if (index < 0) return [...blocks, block]
    const next = [...blocks]
    next[index] = block
    return next
  },
  formatRuntimeError: (error: unknown) => error instanceof Error ? error.message : String(error),
  runtimeErrorDetail: () => '',
  isInterruptSettledError: () => false,
  settlePendingRuntimeWork: (blocks: ChatState['blocks']) => blocks,
  threadSnapshotLooksRunning: () => false
}

function state(): ChatState {
  return {
    activeThreadId: 'thread_1',
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    threads: [{
      id: 'thread_1', title: 'Thread', updatedAt: '2026-07-10T00:00:00.000Z', model: 'model', mode: 'agent'
    }],
    usageRefreshKey: 0,
    error: 'recovering'
  } as unknown as ChatState
}

function project(
  initial: ChatState,
  actions: RuntimeProjectionAction[],
  reducerContext = context
): ChatState {
  return actions.reduce(
    (current, action) => ({ ...current, ...reduceChatProjection(current, action, reducerContext) }),
    initial
  )
}

describe('chat projection reducer', () => {
  it('keeps distinct automatic compaction markers for a turn', () => {
    const projected = project(state(), [
      {
        type: 'compaction_updated',
        payload: {
          itemId: 'compaction_1',
          turnId: 'turn_1',
          summary: 'first summary',
          status: 'success',
          auto: true
        }
      },
      {
        type: 'compaction_updated',
        payload: {
          itemId: 'compaction_2',
          turnId: 'turn_1',
          summary: 'new summary',
          status: 'success',
          auto: true
        }
      }
    ])

    expect(projected.blocks).toEqual([
      expect.objectContaining({
        kind: 'compaction',
        id: 'compaction_1',
        turnId: 'turn_1',
        summary: 'first summary'
      }),
      expect.objectContaining({
        kind: 'compaction',
        id: 'compaction_2',
        turnId: 'turn_1',
        summary: 'new summary'
      })
    ])
  })

  it('updates one automatic compaction marker across status changes', () => {
    const projected = project(state(), [
      {
        type: 'compaction_updated',
        payload: {
          itemId: 'compaction_1',
          turnId: 'turn_1',
          summary: 'starting',
          status: 'running',
          auto: true
        }
      },
      {
        type: 'compaction_updated',
        payload: {
          itemId: 'compaction_1',
          turnId: 'turn_1',
          summary: 'completed summary',
          status: 'success',
          auto: true,
          messagesBefore: 10,
          messagesAfter: 3
        }
      }
    ])

    expect(projected.blocks).toEqual([
      expect.objectContaining({
        kind: 'compaction',
        id: 'compaction_1',
        summary: 'completed summary',
        status: 'success',
        messagesBefore: 10,
        messagesAfter: 3
      })
    ])
  })

  it('retires a pending approval after its runtime resolution is projected', () => {
    const projected = project(state(), [
      {
        type: 'approval_received',
        payload: { approvalId: 'approval_1', summary: 'Run tests' }
      },
      {
        type: 'approval_status_changed',
        payload: {
          approvalId: 'approval_1',
          status: 'expired',
          errorMessage: 'turn aborted while awaiting approval'
        }
      }
    ])

    expect(projected.blocks).toContainEqual(expect.objectContaining({
      kind: 'approval',
      approvalId: 'approval_1',
      status: 'expired',
      errorMessage: 'turn aborted while awaiting approval'
    }))
  })

  it.each(['allowed', 'denied'] as const)(
    'clears stale approval errors when the runtime resolves it as %s',
    (status) => {
      const initial = {
        ...state(),
        blocks: [{
          kind: 'approval' as const,
          id: 'approval-approval_1',
          approvalId: 'approval_1',
          summary: 'Run tests',
          status: 'error' as const,
          errorMessage: 'response was lost'
        }]
      }

      const projected = project(initial, [{
        type: 'approval_status_changed',
        payload: { approvalId: 'approval_1', status }
      }])
      const approval = projected.blocks[0]

      expect(approval).toMatchObject({ kind: 'approval', status })
      expect(approval).not.toHaveProperty('errorMessage')
    }
  )

  it('reconciles a persisted completion through the same projection reducer', () => {
    const initial = {
      ...state(),
      busy: false,
      currentTurnId: null,
      lastSeq: 4,
      liveAssistant: ''
    }
    const blocks = [{
      kind: 'assistant' as const,
      id: 'assistant_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      text: 'Persisted answer'
    }]
    const projected = project(initial, [{
      type: 'thread_snapshot_reconciled',
      payload: { threadId: 'thread_1', blocks, latestSeq: 8 }
    }])

    expect(projected.blocks).toEqual(blocks)
    expect(projected.lastSeq).toBe(8)
    expect(projected.error).toBeNull()
  })

  it('replaces incomplete deltas with the authoritative completed item snapshot', () => {
    const initial = {
      ...state(),
      busy: true,
      currentTurnId: 'turn_1',
      currentTurnUserId: 'user_1',
      liveDeltaSeqFloor: 0,
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    }
    const projected = project(initial, [
      {
        type: 'deltas_received',
        deltas: [{
          seq: 1,
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'assistant_1',
          createdAt: '2026-07-11T00:00:00.000Z',
          kind: 'agent_message',
          text: 'Hello '
        }]
      },
      {
        type: 'assistant_item_upserted',
        payload: {
          itemId: 'assistant_1',
          threadId: 'thread_1',
          turnId: 'turn_1',
          kind: 'agent_message',
          status: 'completed',
          createdAt: '2026-07-11T00:00:00.000Z',
          text: 'Hello missing middle world'
        }
      }
    ])

    expect(projected.liveAssistant).toBe('')
    expect(projected.blocks).toContainEqual({
      kind: 'assistant',
      id: 'assistant_1',
      turnId: 'turn_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      text: 'Hello missing middle world'
    })
  })

  it('does not flush or split live assistant text when tool and status events arrive', () => {
    const initial = {
      ...state(),
      busy: true,
      currentTurnId: 'turn_1',
      currentTurnUserId: 'user_1',
      liveDeltaSeqFloor: 0,
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    }
    const projected = project(initial, [
      {
        type: 'deltas_received',
        deltas: [{
          seq: 1,
          turnId: 'turn_1',
          itemId: 'assistant_1',
          kind: 'agent_message',
          text: 'first '
        }]
      },
      {
        type: 'tool_updated',
        payload: {
          itemId: 'tool_1',
          turnId: 'turn_1',
          summary: 'read',
          status: 'running'
        }
      },
      {
        type: 'runtime_status_received',
        payload: {
          kind: 'model_request_retry',
          itemId: 'status_1',
          turnId: 'turn_1'
        }
      },
      {
        type: 'deltas_received',
        deltas: [{
          seq: 2,
          turnId: 'turn_1',
          itemId: 'assistant_1',
          kind: 'agent_message',
          text: 'second'
        }]
      }
    ])

    expect(projected.liveAssistant).toBe('first second')
    expect(projected.blocks.filter((block) => block.kind === 'assistant')).toEqual([])
    expect(projected.blocks.map((block) => block.id)).toEqual(['tool_1', 'status_1'])
  })

  it('is idempotent for repeated delta seqs and authoritative snapshots', () => {
    const initial = {
      ...state(),
      busy: true,
      currentTurnId: 'turn_1',
      currentTurnUserId: 'user_1',
      liveDeltaSeqFloor: 0,
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    }
    const delta: RuntimeProjectionAction = {
      type: 'deltas_received',
      deltas: [{
        seq: 4,
        turnId: 'turn_1',
        itemId: 'assistant_1',
        kind: 'agent_message',
        text: 'hello'
      }]
    }
    const snapshot: RuntimeProjectionAction = {
      type: 'assistant_item_upserted',
      payload: {
        itemId: 'assistant_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        kind: 'agent_message',
        status: 'completed',
        createdAt: '2026-07-11T00:00:00.000Z',
        text: 'hello'
      }
    }

    const projected = project(initial, [delta, delta, snapshot, snapshot])

    expect(projected.blocks.filter((block) => block.kind === 'assistant')).toHaveLength(1)
    expect(projected.blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: 'hello' })
  })

})
