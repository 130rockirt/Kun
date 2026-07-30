import { describe, expect, test, vi } from 'vitest'
import {
  delegatedGraphAllowedToolNames,
  delegatedGraphPlanCanRetry,
  delegatedGraphPlanRepairFeedback,
  delegatedGraphPlanWasCommitted,
  delegatedGraphRecoveryInstruction,
  delegatedGraphTurnPolicy,
  parkDelegatedGraphTurnAfterRecovery
} from './delegated-graph-turn-policy.js'

describe('delegated Graph turn policy', () => {
  test('uses durable planning state to select a read-only planning catalog', () => {
    const policy = delegatedGraphTurnPolicy({
      orchestration: 'graph',
      graphPlanningLifecycle: {
        version: 1,
        draftId: 'draft_1',
        reservedRunId: 'run_1',
        state: 'planning',
        draftRevision: 1
      }
    })
    expect(policy?.phase).toBe('planning')
    expect(policy?.disableNativeTools).toBe(true)
    expect(policy?.instruction).toContain('Graph Mode: source Lead operating contract')
    expect(delegatedGraphAllowedToolNames([
      { name: 'read', sideEffect: 'read-only' },
      { name: 'repo_map', sideEffect: 'read-only' },
      { name: 'graph_define_plan' },
      { name: 'graph_review_node' },
      { name: 'write', sideEffect: 'unknown' },
      { name: 'delegate_task' }
    ], policy!.phase)).toEqual([
      'read',
      'repo_map',
      'graph_define_plan'
    ])
  })

  test('switches a committed draft to bounded Lead supervision tools', () => {
    const policy = delegatedGraphTurnPolicy({
      orchestration: 'graph',
      graphPlanningLifecycle: {
        version: 1,
        draftId: 'draft_1',
        reservedRunId: 'run_1',
        state: 'committed',
        draftRevision: 2
      }
    })
    expect(policy?.phase).toBe('supervising')
    expect(delegatedGraphAllowedToolNames([
      { name: 'read', sideEffect: 'read-only' },
      { name: 'graph_define_plan' },
      { name: 'graph_review_node' },
      { name: 'graph_supervise_node' },
      { name: 'bash', sideEffect: 'unknown' }
    ], policy!.phase)).toEqual([
      'read',
      'graph_review_node',
      'graph_supervise_node'
    ])
  })

  test('provides explicit host gates and recognizes only a committed plan result', () => {
    expect(delegatedGraphRecoveryInstruction('planning')).toContain(
      'call `graph_define_plan` now'
    )
    expect(delegatedGraphRecoveryInstruction('supervising')).toContain(
      'call `graph_review_node`'
    )
    expect(delegatedGraphPlanWasCommitted({
      output: { status: 'committed' }
    })).toBe(true)
    expect(delegatedGraphPlanWasCommitted({
      output: { status: 'committed' },
      isError: true
    })).toBe(false)
    expect(delegatedGraphPlanWasCommitted({
      output: '{"status":"needs_correction"}'
    })).toBe(false)
    const feedback = delegatedGraphPlanRepairFeedback({
      output: {
        code: 'graph_plan_invalid',
        issues: [{ path: ['tasks', 0, 'loop'], repairHint: 'Remove loop.' }]
      },
      isError: true
    })
    expect(delegatedGraphRecoveryInstruction('planning', feedback)).toContain(
      '"path":["tasks",0,"loop"]'
    )
    expect(delegatedGraphPlanCanRetry({
      output: { code: 'graph_plan_invalid', retryable: true },
      isError: true
    })).toBe(true)
    expect(delegatedGraphPlanCanRetry({
      output: { code: 'graph_plan_needs_correction', retryable: false },
      isError: true
    })).toBe(false)
  })

  test('forces a safe park only after the bounded recovery exchange is exhausted', async () => {
    const suspendGraphLeadTurn = vi.fn()
      .mockResolvedValueOnce('supervision_pending')
      .mockResolvedValueOnce('suspended')
    await expect(parkDelegatedGraphTurnAfterRecovery(
      { suspendGraphLeadTurn },
      { threadId: 'thread_1', turnId: 'turn_1' }
    )).resolves.toBe('suspended')
    expect(suspendGraphLeadTurn).toHaveBeenLastCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      force: true,
      preserveDeliveryCursor: true,
      allowPendingSupervision: true
    })
  })
})
