import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GraphRun,
  GraphSupervisionProjection
} from './graph-types'

const client = vi.hoisted(() => ({ wakeLead: vi.fn() }))

vi.mock('./graph-runtime-client', () => ({ graphRuntimeClient: client }))

import {
  createGraphLeadWakeAction,
  mergeGraphRunSnapshots
} from './graph-supervision-store'

function run(seq: number): GraphRun {
  return {
    version: 1,
    id: 'run_1',
    projectId: 'project_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    status: 'awaiting_supervision',
    currentRevision: 1,
    plans: [],
    nodes: {},
    reviews: [],
    messages: [],
    artifacts: [],
    cleanup: [],
    steering: [],
    budget: {
      limits: { maxWallTimeMs: 60_000, maxAttemptsPerNode: 3 },
      attempts: 0,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 0,
      totalTokens: 0,
      messages: 0,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: seq,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
}

function supervision(
  seq: number,
  liveness: GraphSupervisionProjection['liveness']
): GraphSupervisionProjection {
  return {
    version: 1,
    runId: 'run_1',
    lastEventSeq: seq,
    leadActive: liveness === 'active_review',
    liveness,
    pendingActions: liveness === 'idle' ? [] : [{
      obligationId: 'obligation_1',
      pendingAction: 'review_required',
      nodeIds: ['node_1'],
      liveness,
      retryCount: 0,
      noProgressCount: 0,
      canWake: liveness !== 'active_review'
    }],
    peerReviewLeases: [],
    canWake: liveness !== 'idle' && liveness !== 'active_review',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
}

describe('Graph supervision store actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies a manual Lead wake projection and clears its in-flight marker', async () => {
    const current = run(5)
    current.supervision = supervision(5, 'waiting_for_lead')
    let state: {
      selectedRunId: string | null
      runs: GraphRun[]
      wakingObligationId: string | null
      error: string | null
    } = {
      selectedRunId: current.id,
      runs: [current],
      wakingObligationId: null,
      error: null
    }
    const wakeLead = createGraphLeadWakeAction({
      get: () => state,
      update: (updater) => { state = { ...state, ...updater(state) } }
    })
    client.wakeLead.mockResolvedValueOnce(supervision(6, 'retry_scheduled'))

    await wakeLead('obligation_1')

    expect(client.wakeLead).toHaveBeenCalledWith('run_1', 'obligation_1')
    expect(state).toMatchObject({
      wakingObligationId: null,
      error: null,
      runs: [{ supervision: { lastEventSeq: 6, liveness: 'retry_scheduled' } }]
    })
  })

  it('does not let a late manual wake response overwrite newer durable supervision', async () => {
    let resolveWake!: (projection: GraphSupervisionProjection) => void
    client.wakeLead.mockReturnValueOnce(new Promise((resolve) => { resolveWake = resolve }))
    const current = run(5)
    current.supervision = supervision(5, 'waiting_for_lead')
    let state: {
      selectedRunId: string | null
      runs: GraphRun[]
      wakingObligationId: string | null
      error: string | null
    } = {
      selectedRunId: current.id,
      runs: [current],
      wakingObligationId: null,
      error: null
    }
    const wakeLead = createGraphLeadWakeAction({
      get: () => state,
      update: (updater) => { state = { ...state, ...updater(state) } }
    })

    const pending = wakeLead('obligation_1')
    expect(state.wakingObligationId).toBe('obligation_1')
    const newer = run(7)
    newer.supervision = supervision(7, 'active_review')
    state = { ...state, runs: [newer] }
    resolveWake(supervision(6, 'retry_scheduled'))
    await pending

    expect(state).toMatchObject({
      wakingObligationId: null,
      runs: [{ supervision: { lastEventSeq: 7, liveness: 'active_review' } }]
    })
  })

  it('keeps a newer supervision projection during a same-run snapshot refresh', () => {
    const current = run(7)
    current.supervision = supervision(7, 'active_review')
    const incoming = run(7)
    incoming.supervision = supervision(6, 'retry_scheduled')

    expect(mergeGraphRunSnapshots([current], [incoming])[0]?.supervision)
      .toEqual(current.supervision)
  })
})
