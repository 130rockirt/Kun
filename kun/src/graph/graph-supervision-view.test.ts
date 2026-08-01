import { describe, expect, it } from 'vitest'
import type {
  GraphRunV1,
  GraphSupervisionObligationState,
  GraphSupervisionObligationV1
} from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import { graphSupervisionProjection } from './graph-supervision-view.js'
import {
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

const NOW = Date.parse('2026-07-31T00:01:00.000Z')

function baseRun(): GraphRunV1 {
  return applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan(),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
}

function obligation(
  state: GraphSupervisionObligationState,
  overrides: Partial<GraphSupervisionObligationV1> = {}
): GraphSupervisionObligationV1 {
  return {
    version: 1,
    id: 'obligation_review',
    kind: 'review_required',
    reason: 'submitted',
    graphRevision: 1,
    nodeIds: ['research'],
    attemptIds: ['attempt_1'],
    digest: 'Private executor result that must never cross the projection boundary.',
    state,
    deliveryAttempts: 2,
    noProgressCount: 0,
    lastProgressSeq: 1,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:30.000Z',
    ...overrides
  }
}

function withObligations(
  obligations: GraphSupervisionObligationV1[],
  status: GraphRunV1['status'] = 'awaiting_supervision'
): GraphRunV1 {
  return {
    ...baseRun(),
    status,
    supervisionObligations: obligations
  }
}

describe('Graph supervision renderer projection', () => {
  it('shows an inactive submitted review as waiting and redacts durable diagnostics', () => {
    const projection = graphSupervisionProjection(withObligations([
      obligation('awaiting_action', {
        lastError: 'token=secret /private/worktree delivery crashed',
        lastDeliveredAt: '2026-07-31T00:00:30.000Z',
        nextWakeAt: '2026-07-31T00:02:00.000Z'
      })
    ]), { leadActive: false, nowMs: NOW })

    expect(projection).toMatchObject({
      liveness: 'waiting_for_lead',
      leadActive: false,
      canWake: true,
      pendingActions: [{
        pendingAction: 'review_required',
        liveness: 'waiting_for_lead',
        retryCount: 1,
        lastWakeAt: '2026-07-31T00:00:30.000Z'
      }]
    })
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('Private executor result')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('/private/worktree')
  })

  it('shows active review only for an active delivery or source Lead lease', () => {
    const delivering = graphSupervisionProjection(withObligations([
      obligation('delivering', { leaseUntil: '2026-07-31T00:01:30.000Z' })
    ]), { leadActive: false, nowMs: NOW })
    const expired = graphSupervisionProjection(withObligations([
      obligation('delivering', { leaseUntil: '2026-07-31T00:00:59.000Z' })
    ]), { leadActive: false, nowMs: NOW })
    const leadActive = graphSupervisionProjection(withObligations([
      obligation('awaiting_action')
    ]), { leadActive: true, nowMs: NOW })

    expect(delivering.liveness).toBe('active_review')
    expect(delivering.pendingActions[0]?.canWake).toBe(false)
    expect(expired.liveness).toBe('waiting_for_lead')
    expect(leadActive.liveness).toBe('active_review')
  })

  it('projects only unexpired peer-review leases for the owning run', () => {
    const active = graphSupervisionProjection(withObligations([]), {
      leadActive: false,
      nowMs: NOW,
      peerReviewLeases: [{
        nodeId: 'research',
        attemptId: 'attempt_peer',
        leaseUntil: '2026-07-31T00:01:30.000Z'
      }, {
        nodeId: 'expired',
        attemptId: 'attempt_expired',
        leaseUntil: '2026-07-31T00:00:59.000Z'
      }]
    })

    expect(active).toMatchObject({
      liveness: 'active_review',
      leadActive: false,
      pendingActions: [],
      peerReviewLeases: [{
        nodeId: 'research',
        attemptId: 'attempt_peer',
        leaseUntil: '2026-07-31T00:01:30.000Z'
      }],
      canWake: false
    })
  })

  it('distinguishes scheduled retry from terminal attention without infinite activity', () => {
    const retry = graphSupervisionProjection(withObligations([
      obligation('retry_scheduled', { nextWakeAt: '2026-07-31T00:02:00.000Z' })
    ]), { leadActive: false, nowMs: NOW })
    const attention = graphSupervisionProjection(withObligations([
      obligation('needs_attention', {
        noProgressCount: 3,
        attentionReason: 'No durable progress; raw reviewer content /private/result.md.'
      })
    ], 'awaiting_human'), { leadActive: false, nowMs: NOW })

    expect(retry.liveness).toBe('retry_scheduled')
    expect(retry.pendingActions[0]).toMatchObject({
      retryCount: 1,
      nextWakeAt: '2026-07-31T00:02:00.000Z'
    })
    expect(attention.liveness).toBe('needs_attention')
    expect(attention.pendingActions[0]).toMatchObject({
      noProgressCount: 3,
      attentionReason: 'The source Lead made no durable progress after repeated wake attempts.'
    })
    expect(JSON.stringify(attention)).not.toContain('/private/result.md')
  })

  it('bounds obligations and node identifiers and disables wake for terminal runs', () => {
    const obligations = Array.from({ length: 80 }, (_, index) => obligation('pending', {
      id: `obligation_${String(index).padStart(2, '0')}`,
      nodeIds: Array.from({ length: 40 }, (__, nodeIndex) => `node_${nodeIndex}`)
    }))
    const projection = graphSupervisionProjection(
      withObligations(obligations, 'cancelled'),
      { leadActive: false, nowMs: NOW }
    )

    expect(projection.pendingActions).toHaveLength(64)
    expect(projection.pendingActions.every((item) => item.nodeIds.length === 32)).toBe(true)
    expect(projection.canWake).toBe(false)
    expect(projection.pendingActions.every((item) => !item.canWake)).toBe(true)
  })
})
