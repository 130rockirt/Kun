import { describe, expect, it } from 'vitest'
import type {
  GraphAttempt,
  GraphChildRuntime,
  GraphNodeProjection,
  GraphNodeStatus,
  GraphPlanNode,
  GraphSupervisionLiveness,
  GraphSupervisionProjection
} from './graph-types'
import {
  graphLivenessIsProcessing,
  graphNodeLiveness
} from './graph-liveness'

const NOW = Date.parse('2026-07-28T00:01:00.000Z')

function attempt(
  attemptNumber: number,
  childThreadId = `child_${attemptNumber}`
): GraphAttempt {
  return {
    id: `attempt_${attemptNumber}`,
    attemptNumber,
    status: 'running',
    childThreadId,
    startedAt: '2026-07-28T00:00:00.000Z',
    tokenUsage: 0,
    elapsedMs: 0,
    assignment: {
      name: 'Kun'
    } as GraphAttempt['assignment']
  }
}

function projection(
  status: GraphNodeStatus,
  attempts: GraphAttempt[] = []
): GraphNodeProjection {
  const node: GraphPlanNode = {
    id: 'node_1',
    phaseId: 'phase_1',
    kind: 'work',
    title: 'Node',
    objective: 'Work',
    priority: 1,
    required: true,
    riskClass: 'low',
    readScopes: [],
    writeScopes: []
  }
  return { node, status, attempts, loopIteration: 0 }
}

function child(
  status: GraphChildRuntime['status'],
  updatedAt: string
): GraphChildRuntime {
  return {
    childId: 'child_1',
    parentThreadId: 'thread_1',
    parentTurnId: 'turn_1',
    status,
    startedAt: '2026-07-28T00:00:00.000Z',
    updatedAt,
    activity: {
      phase: 'tool',
      label: 'Scanning the repository',
      toolName: 'repo_map',
      startedAt: '2026-07-28T00:00:00.000Z',
      updatedAt
    }
  }
}

function supervision(
  liveness: Exclude<GraphSupervisionLiveness, 'idle'>,
  nodeId = 'node_1'
): GraphSupervisionProjection {
  return {
    version: 1,
    runId: 'run_1',
    lastEventSeq: 7,
    leadActive: liveness === 'active_review',
    liveness,
    pendingActions: [{
      obligationId: 'obligation_1',
      pendingAction: 'review_required',
      nodeIds: [nodeId],
      liveness,
      retryCount: liveness === 'retry_scheduled' ? 1 : 0,
      noProgressCount: liveness === 'needs_attention' ? 3 : 0,
      canWake: liveness !== 'active_review'
    }],
    canWake: liveness !== 'active_review',
    updatedAt: '2026-07-28T00:01:00.000Z'
  }
}

describe('Graph node liveness projection', () => {
  it('keeps a zero-accepted running node visibly active without fake percent', () => {
    const live = graphNodeLiveness(
      projection('running', [attempt(1)]),
      { child_1: child('running', '2026-07-28T00:00:50.000Z') },
      NOW
    )

    expect(live).toMatchObject({
      kind: 'working',
      attemptNumber: 1,
      childThreadId: 'child_1',
      activityLabel: 'Scanning the repository',
      activityToolName: 'repo_map',
      elapsedMs: 60_000,
      quiet: false
    })
  })

  it.each([
    ['blocked', 'waiting_dependency'],
    ['submitted', 'waiting_lead'],
    ['reviewing', 'waiting_lead'],
    ['repair_required', 'retrying'],
    ['accepted', 'done'],
    ['failed', 'failed']
  ] as const)('maps %s to %s', (status, kind) => {
    expect(graphNodeLiveness(projection(status), {}, NOW).kind).toBe(kind)
  })

  it.each([
    ['running', true],
    ['submitted', false],
    ['reviewing', false],
    ['repair_required', true],
    ['blocked', false],
    ['queued', false],
    ['accepted', false],
    ['failed', false]
  ] as const)('treats %s processing state as %s', (status, processing) => {
    expect(graphLivenessIsProcessing(
      graphNodeLiveness(projection(status), {}, NOW)
    )).toBe(processing)
  })

  it.each([
    ['active_review', true],
    ['waiting_for_lead', false],
    ['retry_scheduled', false],
    ['needs_attention', false]
  ] as const)('projects supervision state %s without inventing processing', (state, processing) => {
    const live = graphNodeLiveness(
      projection('reviewing'),
      {},
      NOW,
      supervision(state)
    )

    expect(live.kind).toBe(state === 'waiting_for_lead' ? 'waiting_lead' : state)
    expect(graphLivenessIsProcessing(live)).toBe(processing)
  })

  it('does not apply another node supervision lease to this node', () => {
    const live = graphNodeLiveness(
      projection('submitted'),
      {},
      NOW,
      supervision('active_review', 'node_other')
    )

    expect(live.kind).toBe('waiting_lead')
    expect(graphLivenessIsProcessing(live)).toBe(false)
  })

  it('shows active review only for the matching unexpired peer-review lease', () => {
    const reviewProjection = projection('reviewing', [attempt(1)])
    const view = supervision('waiting_for_lead')
    view.peerReviewLeases = [{
      nodeId: 'node_1',
      attemptId: 'attempt_1',
      leaseUntil: '2026-07-28T00:01:30.000Z'
    }]

    const active = graphNodeLiveness(reviewProjection, {}, NOW, view)
    expect(active.kind).toBe('active_review')
    expect(graphLivenessIsProcessing(active)).toBe(true)

    view.peerReviewLeases[0]!.leaseUntil = '2026-07-28T00:00:59.000Z'
    expect(graphNodeLiveness(reviewProjection, {}, NOW, view).kind).toBe('waiting_lead')
    view.peerReviewLeases[0] = {
      nodeId: 'node_1',
      attemptId: 'attempt_other',
      leaseUntil: '2026-07-28T00:01:30.000Z'
    }
    expect(graphNodeLiveness(reviewProjection, {}, NOW, view).kind).toBe('waiting_lead')

    view.peerReviewLeases[0]!.attemptId = 'attempt_1'
    view.pendingActions[0]!.liveness = 'needs_attention'
    expect(graphNodeLiveness(reviewProjection, {}, NOW, view).kind).toBe('needs_attention')
  })

  it('surfaces the second attempt explicitly', () => {
    const live = graphNodeLiveness(
      projection('running', [attempt(1), attempt(2, 'child_2')]),
      {},
      NOW
    )
    expect(live).toMatchObject({
      kind: 'working',
      attemptNumber: 2,
      childThreadId: 'child_2'
    })
  })

  it('marks 30 seconds of child silence as quiet while elapsed time continues', () => {
    const live = graphNodeLiveness(
      projection('running', [attempt(1)]),
      { child_1: child('running', '2026-07-28T00:00:20.000Z') },
      NOW
    )
    expect(live).toMatchObject({
      quiet: true,
      lastActivityAgeMs: 40_000,
      elapsedMs: 60_000
    })
  })

  it('does not classify a running child waiting for human input as processing', () => {
    const waitingChild = child('running', '2026-07-28T00:00:50.000Z')
    waitingChild.activity!.phase = 'waiting'
    const live = graphNodeLiveness(
      projection('running', [attempt(1)]),
      { child_1: waitingChild },
      NOW
    )

    expect(live.kind).toBe('waiting_human')
    expect(graphLivenessIsProcessing(live)).toBe(false)
  })

  it('lets terminal node state override stale running child activity', () => {
    const live = graphNodeLiveness(
      projection('cancelled', [attempt(1)]),
      { child_1: child('running', '2026-07-28T00:00:50.000Z') },
      NOW
    )

    expect(live).toMatchObject({
      kind: 'failed',
      quiet: false,
      elapsedMs: 0
    })
    expect(live.activityLabel).toBeUndefined()
    expect(live.activityToolName).toBeUndefined()
  })
})
