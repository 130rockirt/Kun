import { describe, expect, it } from 'vitest'
import type {
  GraphAttempt,
  GraphChildRuntime,
  GraphNodeProjection,
  GraphNodeStatus,
  GraphPlanNode
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
    ['submitted', 'reviewing'],
    ['reviewing', 'reviewing'],
    ['repair_required', 'retrying'],
    ['accepted', 'done'],
    ['failed', 'failed']
  ] as const)('maps %s to %s', (status, kind) => {
    expect(graphNodeLiveness(projection(status), {}, NOW).kind).toBe(kind)
  })

  it.each([
    ['running', true],
    ['submitted', true],
    ['reviewing', true],
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
