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
  it('updates one stable non-actionable block across an automatic review lifecycle', () => {
    const projected = project(state(), [
      {
        type: 'approval_review_updated',
        payload: {
          reviewId: 'review_1',
          approvalId: 'approval_1',
          turnId: 'turn_1',
          createdAt: '2026-07-29T00:00:00.000Z',
          summary: 'Run tests',
          toolName: 'exec_command',
          status: 'in-progress'
        }
      },
      {
        type: 'approval_review_updated',
        payload: {
          reviewId: 'review_1',
          approvalId: 'approval_1',
          turnId: 'turn_1',
          createdAt: '2026-07-29T00:00:01.000Z',
          summary: 'Run tests',
          toolName: 'exec_command',
          status: 'approved',
          decision: 'allow',
          riskLevel: 'low',
          rationale: 'The command only runs workspace tests.'
        }
      }
    ])

    expect(projected.blocks).toEqual([{
      kind: 'approval_review',
      id: 'approval-review-review_1',
      reviewId: 'review_1',
      approvalId: 'approval_1',
      turnId: 'turn_1',
      createdAt: '2026-07-29T00:00:00.000Z',
      summary: 'Run tests',
      toolName: 'exec_command',
      status: 'approved',
      decision: 'allow',
      riskLevel: 'low',
      rationale: 'The command only runs workspace tests.'
    }])
  })

  it('renders a failed required-tool gate as an expandable runtime status, not an assistant block', () => {
    const projected = project(state(), [{
      type: 'runtime_status_received',
      payload: {
        kind: 'required_tool_gate',
        itemId: 'graph_gate_1',
        turnId: 'turn_graph',
        toolName: 'graph_create_run',
        phase: 'failed',
        attempt: 3,
        maxAttempts: 3,
        failureSummary: 'plan.nodes.0: Required'
      }
    }])

    expect(projected.blocks).toEqual([expect.objectContaining({
      kind: 'system',
      id: 'graph_gate_1',
      turnId: 'turn_graph',
      text: 'Runtime status',
      detail: 'plan.nodes.0: Required',
      severity: 'error'
    })])
    expect(projected.blocks.some((block) => block.kind === 'assistant')).toBe(false)
  })

  it.each(['success', 'error'] as const)(
    'does not regress a %s tool to running when historical lifecycle is replayed',
    (terminalStatus) => {
      const projected = project({
        ...state(),
        blocks: [{
          kind: 'tool',
          id: 'tool_1',
          summary: 'Terminal result',
          status: terminalStatus
        }]
      }, [{
        type: 'tool_updated',
        seq: 199,
        payload: {
          itemId: 'tool_1',
          summary: 'Historical start',
          status: 'running'
        }
      }])

      expect(projected.blocks[0]).toMatchObject({
        kind: 'tool',
        id: 'tool_1',
        status: terminalStatus
      })
    }
  )

  it('clears current-turn orchestration when a Graph turn completes', () => {
    const projected = project({
      ...state(),
      busy: true,
      currentTurnId: 'turn_graph',
      currentTurnOrchestration: 'graph',
      threads: [{ ...state().threads[0]!, status: 'running' }]
    }, [{ type: 'turn_completed' }])

    expect(projected.busy).toBe(false)
    expect(projected.currentTurnId).toBeNull()
    expect(projected.currentTurnOrchestration).toBeNull()
    expect(projected.threads[0]).toMatchObject({
      status: 'idle',
      latestTurnStatus: 'completed'
    })
  })

  it('settles an interrupted turn as aborted and closes running tools', () => {
    const projected = project({
      ...state(),
      busy: true,
      currentTurnId: 'turn_1',
      threads: [{ ...state().threads[0]!, status: 'running' }],
      blocks: [{
        kind: 'tool',
        id: 'tool_1',
        turnId: 'turn_1',
        summary: 'Run command',
        status: 'running'
      }]
    }, [{ type: 'turn_aborted' }], {
      ...context,
      settlePendingRuntimeWork: (blocks) => blocks.map((block) =>
        block.kind === 'tool' && block.status === 'running'
          ? { ...block, status: 'error' as const }
          : block
      )
    })

    expect(projected.busy).toBe(false)
    expect(projected.currentTurnId).toBeNull()
    expect(projected.threads[0]).toMatchObject({
      status: 'idle',
      latestTurnStatus: 'aborted'
    })
    expect(projected.blocks[0]).toMatchObject({ kind: 'tool', status: 'error' })
  })

  it('clears current-turn orchestration when a Graph turn fails terminally', () => {
    const projected = project({
      ...state(),
      busy: true,
      currentTurnId: 'turn_graph',
      currentTurnOrchestration: 'graph'
    }, [{
      type: 'turn_failed',
      error: new Error('stopped'),
      options: { terminal: true }
    }])

    expect(projected.busy).toBe(false)
    expect(projected.currentTurnId).toBeNull()
    expect(projected.currentTurnOrchestration).toBeNull()
  })

  it('settles a stale running sidebar status when a terminal event is replayed (#1028)', () => {
    const projected = project({
      ...state(),
      busy: false,
      currentTurnId: null,
      activeThreadGoal: {
        threadId: 'thread_1',
        objective: 'Finish the goal',
        status: 'complete',
        tokensUsed: 10,
        timeUsedSeconds: 30,
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:30.000Z'
      },
      threads: [{ ...state().threads[0]!, status: 'running' }]
    }, [{ type: 'turn_completed' }])

    expect(projected.threads[0]).toMatchObject({
      status: 'idle',
      latestTurnStatus: 'completed'
    })
  })

  it('applies status-only thread metadata updates', () => {
    const projected = project({
      ...state(),
      threads: [{ ...state().threads[0]!, status: 'running' }]
    }, [{
      type: 'thread_metadata_changed',
      payload: { threadId: 'thread_1', status: 'idle' }
    }])

    expect(projected.threads[0]?.status).toBe('idle')
  })

  it('produces identical state for live and replayed normalized actions', () => {
    const actions: RuntimeProjectionAction[] = [
      {
        type: 'approval_received',
        payload: { approvalId: 'approval_1', summary: 'Run tests', toolName: 'exec_command' }
      },
      {
        type: 'user_input_requested',
        payload: {
          itemId: 'input_item_1',
          requestId: 'input_1',
          questions: [{ header: 'Mode', id: 'mode', question: 'Choose', options: [] }]
        }
      },
      {
        type: 'goal_changed',
        payload: {
          threadId: 'thread_1',
          goal: {
            threadId: 'thread_1', objective: 'Finish reducer', status: 'active',
            tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
            createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z'
          },
          createdAt: '2026-07-11T00:00:00.000Z'
        }
      }
    ]

    const live = project(state(), actions)
    const replay = project(state(), structuredClone(actions))

    expect(replay).toEqual(live)
    expect(live.blocks.map((block) => block.kind)).toEqual(['approval', 'user_input', 'system'])
    expect(live.activeThreadGoal?.objective).toBe('Finish reducer')
    expect(live.error).toBeNull()
  })

  it('stores context snapshots only for the active thread', () => {
    const activeSnapshot: RuntimeProjectionAction = {
      type: 'context_snapshot_received',
      payload: {
        threadId: 'thread_1',
        model: 'model',
        stepIndex: 0,
        contextWindowTokens: 100_000,
        softThresholdTokens: 75_000,
        hardThresholdTokens: 85_000,
        estimatedInputTokens: 15,
        breakdown: { tools: 1, system: 2, skills: 3, messages: 4, other: 5 },
        toolCount: 1,
        activeSkillIds: []
      }
    }
    const otherSnapshot: RuntimeProjectionAction = {
      ...activeSnapshot,
      payload: { ...activeSnapshot.payload, threadId: 'thread_2' }
    }

    const active = project(state(), [activeSnapshot])
    const ignored = project(state(), [otherSnapshot])

    expect(active.lastContextSnapshot).toEqual(activeSnapshot.payload)
    expect(ignored.lastContextSnapshot).toBeUndefined()
  })

  it('stores delegated capabilities only for the active thread', () => {
    const action: RuntimeProjectionAction = {
      type: 'delegated_runtime_received',
      payload: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        providerKind: 'antigravity-cli',
        providerId: 'google-subscription',
        phase: 'portable',
        capabilities: {
          nativeResume: false,
          structuredStreaming: false,
          kunTools: false,
          externalApproval: false,
          liveSteering: false,
          nativeContextTelemetry: false,
          fork: false
        }
      }
    }
    expect(project(state(), [action]).lastDelegatedRuntimeState).toEqual(action.payload)
    expect(project({ ...state(), activeThreadId: 'thread_2' }, [action]).lastDelegatedRuntimeState)
      .toBeUndefined()
  })

  it('deduplicates approval and user-input replay by stable runtime identity', () => {
    const approval: RuntimeProjectionAction = {
      type: 'approval_received',
      payload: { approvalId: 'approval_1', summary: 'Run tests' }
    }
    const input: RuntimeProjectionAction = {
      type: 'user_input_requested',
      payload: {
        itemId: 'input_item_1',
        requestId: 'input_1',
        questions: [{ header: 'Input', id: 'input_1', question: 'Continue?', options: [] }]
      }
    }
    const projected = project(state(), [approval, input, approval, input])
    expect(projected.blocks).toHaveLength(2)
  })

  it('ignores user-input requests that have no question text', () => {
    const projected = project(state(), [{
      type: 'user_input_requested',
      payload: { itemId: 'input_item_empty', requestId: 'input_empty', questions: [] }
    }])
    expect(projected.blocks).toHaveLength(0)
  })

  it('projects the sanitized runtime message as a durable conversation error', () => {
    const projected = project(state(), [{
      type: 'runtime_error_received',
      payload: {
        itemId: 'error_1',
        message: 'provider returned HTTP 429',
        code: 'http_429',
        severity: 'error'
      }
    }])

    expect(projected.blocks).toContainEqual(expect.objectContaining({
      kind: 'system',
      id: 'error_1',
      text: 'provider returned HTTP 429',
      code: 'http_429',
      severity: 'error',
      runtimeError: true
    }))
    expect(projected.blocks[0]).not.toMatchObject({ text: 'Summary: provider returned HTTP 429' })
  })

  it('reconciles a delayed stable user event with its optimistic bubble', () => {
    const createdAt = '2026-07-11T00:00:00.000Z'
    const initial = {
      ...state(),
      busy: false,
      currentTurnId: null,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      blocks: [
        {
          kind: 'user' as const,
          id: 'u-optimistic',
          createdAt,
          text: '检查一下脚本并优化执行进度'
        },
        {
          kind: 'compaction' as const,
          id: 'compaction_1',
          status: 'success' as const,
          summary: 'Existing summary'
        }
      ]
    }

    const projected = project(initial, [{
      type: 'user_message_received',
      payload: {
        itemId: 'item_turn_1_user',
        turnId: 'turn_1',
        createdAt,
        text: '分析脚本是否存在问题，并优化执行过程和进度。',
        meta: { displayText: '检查一下脚本并优化执行进度' }
      }
    }])

    expect(projected.blocks).toHaveLength(2)
    expect(projected.blocks[0]).toMatchObject({
      kind: 'user',
      id: 'item_turn_1_user',
      meta: { displayText: '检查一下脚本并优化执行进度' }
    })
    expect(projected.blocks[1]).toMatchObject({ kind: 'compaction', id: 'compaction_1' })
  })

  it('reconciles guided optimistic input without replacing the active turn owner', () => {
    const createdAt = '2026-07-11T00:00:00.000Z'
    const initial = {
      ...state(),
      busy: true,
      currentTurnId: 'turn_1',
      currentTurnUserId: 'item_original_user',
      turnStartedAtByUserId: { item_original_user: NOW - 1_000 },
      blocks: [
        {
          kind: 'user' as const,
          id: 'item_original_user',
          turnId: 'turn_1',
          createdAt: '2026-07-10T23:59:00.000Z',
          text: 'Build the page'
        },
        {
          kind: 'user' as const,
          id: 'q-guided',
          turnId: 'turn_1',
          createdAt,
          text: 'Use the compact logo instead',
          meta: { displayText: 'Use the compact logo instead' }
        }
      ]
    }

    const projected = project(initial, [{
      type: 'user_message_received',
      payload: {
        itemId: 'item_guided_user',
        turnId: 'turn_1',
        createdAt,
        text: 'use the compact logo instead',
        meta: { displayText: 'Use the compact logo instead' }
      }
    }])

    expect(projected.blocks).toHaveLength(2)
    expect(projected.blocks[1]).toMatchObject({
      kind: 'user',
      id: 'item_guided_user',
      turnId: 'turn_1',
      meta: { displayText: 'Use the compact logo instead' }
    })
    expect(projected.currentTurnUserId).toBe('item_original_user')
  })

  it('reconciles Graph guidance when the stable user event arrives after the HTTP response', () => {
    const createdAt = '2026-07-11T00:00:00.000Z'
    const initial = {
      ...state(),
      busy: true,
      currentTurnId: 'turn_graph',
      currentTurnUserId: 'item_original_user',
      turnStartedAtByUserId: { item_original_user: NOW - 1_000 },
      blocks: [
        {
          kind: 'user' as const,
          id: 'item_original_user',
          turnId: 'turn_graph',
          createdAt: '2026-07-10T23:59:00.000Z',
          text: 'Build this as a Graph'
        },
        {
          kind: 'user' as const,
          id: 'graph-steering-1783728000000',
          turnId: 'turn_graph',
          createdAt,
          text: 'Continue building the Graph.'
        }
      ]
    }

    const projected = project(initial, [{
      type: 'user_message_received',
      payload: {
        itemId: 'item_steered',
        turnId: 'turn_graph',
        createdAt,
        text: 'Continue building the Graph.'
      }
    }])

    expect(projected.blocks).toHaveLength(2)
    expect(projected.blocks[1]).toMatchObject({
      kind: 'user',
      id: 'item_steered',
      turnId: 'turn_graph',
      text: 'Continue building the Graph.'
    })
    expect(projected.currentTurnUserId).toBe('item_original_user')
  })

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

  it('does not reopen or duplicate an item delta already covered by the hydrated snapshot', () => {
    const assistant = {
      kind: 'assistant' as const,
      id: 'assistant_1',
      turnId: 'turn_1',
      text: 'Hydrated answer'
    }
    const initial = {
      ...state(),
      blocks: [assistant],
      busy: false,
      lastSeq: 200,
      liveDeltaSeqFloor: 200,
      liveAssistant: ''
    }

    const projected = project(initial, [{
      type: 'deltas_received',
      deltas: [{
        seq: 201,
        deltaOffset: 0,
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'assistant_1',
        kind: 'agent_message',
        text: 'Hydrated answer'
      }]
    }])

    expect(projected.blocks).toBe(initial.blocks)
    expect(projected.liveAssistant).toBe('')
    expect(projected.liveAssistantItemId).toBeUndefined()
    expect(projected.busy).toBe(false)
    expect(projected.lastSeq).toBe(201)
    expect(projected.liveDeltaSeqFloor).toBe(201)
  })

  it('appends only the unseen suffix when an offset delta partially overlaps hydrated text', () => {
    const initial = {
      ...state(),
      blocks: [{
        kind: 'assistant' as const,
        id: 'assistant_1',
        turnId: 'turn_1',
        text: 'Hello '
      }],
      busy: false,
      lastSeq: 200,
      liveDeltaSeqFloor: 200,
      liveAssistant: ''
    }

    const projected = project(initial, [{
      type: 'deltas_received',
      deltas: [
        {
          seq: 201,
          deltaOffset: 4,
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'assistant_1',
          kind: 'agent_message',
          text: 'o world'
        },
        {
          seq: 202,
          deltaOffset: 11,
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'assistant_1',
          kind: 'agent_message',
          text: '!'
        }
      ]
    }])

    expect(projected.blocks).toEqual(initial.blocks)
    expect(projected.liveAssistant).toBe('world!')
    expect(projected.liveAssistantItemId).toBe('assistant_1')
    expect(projected.busy).toBe(true)
    expect(projected.lastSeq).toBe(202)
  })

  it('appends the complete delta when offset overlap does not match projected text', () => {
    const initial = {
      ...state(),
      blocks: [{
        kind: 'assistant' as const,
        id: 'assistant_1',
        turnId: 'turn_1',
        text: 'Hello '
      }],
      busy: false,
      lastSeq: 200,
      liveDeltaSeqFloor: 200,
      liveAssistant: ''
    }

    const projected = project(initial, [{
      type: 'deltas_received',
      deltas: [{
        seq: 201,
        deltaOffset: 4,
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'assistant_1',
        kind: 'agent_message',
        text: 'X world'
      }]
    }])

    expect(projected.liveAssistant).toBe('X world')
    expect(projected.liveAssistantItemId).toBe('assistant_1')
    expect(projected.busy).toBe(true)
  })

  it('keeps legacy no-offset deltas on their original append path', () => {
    const initial = {
      ...state(),
      blocks: [{
        kind: 'assistant' as const,
        id: 'assistant_1',
        turnId: 'turn_1',
        text: 'Hydrated answer'
      }],
      busy: false,
      lastSeq: 200,
      liveDeltaSeqFloor: 200,
      liveAssistant: ''
    }

    const projected = project(initial, [{
      type: 'deltas_received',
      deltas: [{
        seq: 201,
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'assistant_1',
        kind: 'agent_message',
        text: 'Hydrated answer'
      }]
    }])

    expect(projected.liveAssistant).toBe('Hydrated answer')
    expect(projected.liveAssistantItemId).toBe('assistant_1')
    expect(projected.busy).toBe(true)
  })

  it('preserves an unchanged assistant block reference during terminal snapshot reconciliation', () => {
    const assistant = {
      kind: 'assistant' as const,
      id: 'assistant_1',
      turnId: 'turn_1',
      createdAt: '2026-07-11T00:00:00.000Z',
      text: 'Stable markdown'
    }
    const initial = {
      ...state(),
      busy: false,
      currentTurnId: null,
      lastSeq: 4,
      blocks: [
        { kind: 'user' as const, id: 'user_1', turnId: 'turn_1', text: 'Question' },
        assistant
      ]
    }
    const projected = project(initial, [{
      type: 'thread_snapshot_reconciled',
      payload: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        userBlockId: 'user_1',
        latestSeq: 8,
        blocks: [
          { kind: 'user', id: 'user_1', turnId: 'turn_1', text: 'Question' },
          { ...assistant }
        ]
      }
    }])

    expect(projected.blocks.find((block) => block.id === 'assistant_1')).toBe(assistant)
  })
})
