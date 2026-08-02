import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GraphRun,
  GraphSupervisionProjection
} from './graph-types'

const runtimeRequest = vi.hoisted(() => vi.fn())

vi.mock('../agent/runtime-client', () => ({
  rendererRuntimeClient: { runtimeRequest }
}))

import { graphRuntimeClient } from './graph-runtime-client'

const supervision: GraphSupervisionProjection = {
  version: 1,
  runId: 'run 1',
  lastEventSeq: 4,
  leadActive: false,
  liveness: 'waiting_for_lead',
  pendingActions: [{
    obligationId: 'obligation_1',
    pendingAction: 'review_required',
    nodeIds: ['node_1'],
    liveness: 'waiting_for_lead',
    retryCount: 0,
    noProgressCount: 0,
    canWake: true
  }],
  canWake: true,
  updatedAt: '2026-07-31T00:00:00.000Z'
}

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify(body)
  }
}

describe('Graph runtime supervision client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends an idempotent manual wake to the modeled same-run endpoint', async () => {
    runtimeRequest.mockResolvedValueOnce(response(supervision))

    await expect(graphRuntimeClient.wakeLead('run 1', 'obligation_1'))
      .resolves.toEqual(supervision)

    const [path, method, rawBody] = runtimeRequest.mock.calls[0]!
    expect(path).toBe('/v1/graphs/run%201/supervision/wake')
    expect(method).toBe('POST')
    const body = JSON.parse(rawBody)
    expect(body).toMatchObject({
      obligationId: 'obligation_1',
      commandId: expect.stringMatching(/^user_graph_wake_/),
      idempotencyKey: expect.stringMatching(/^user_graph_wake_/)
    })
    expect(body.commandId).toBe(body.idempotencyKey)
  })

  it('hydrates the additive projection when talking to a compatible older run response', async () => {
    const run = {
      id: 'run 1',
      lastEventSeq: 4
    } as GraphRun
    runtimeRequest
      .mockResolvedValueOnce(response(run))
      .mockResolvedValueOnce(response(supervision))

    await expect(graphRuntimeClient.getRun('run 1')).resolves.toMatchObject({
      id: 'run 1',
      supervision
    })
    expect(runtimeRequest.mock.calls.map(([path]) => path)).toEqual([
      '/v1/graphs/run%201',
      '/v1/graphs/run%201/supervision'
    ])
  })

  it('does not refetch supervision already attached to a GraphRun', async () => {
    const run = {
      id: 'run 1',
      lastEventSeq: 4,
      supervision
    } as GraphRun
    runtimeRequest.mockResolvedValueOnce(response(run))

    await expect(graphRuntimeClient.getRun('run 1')).resolves.toEqual(run)
    expect(runtimeRequest).toHaveBeenCalledOnce()
  })
})
