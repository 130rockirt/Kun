import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../../domain/thread.js'
import { ContextCompactor } from '../../loop/context-compactor.js'
import { InflightTracker } from '../../loop/inflight-tracker.js'
import { SteeringQueue } from '../../loop/steering-queue.js'
import { SequentialIdGenerator } from '../../ports/id-generator.js'
import { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import { TurnService } from '../../services/turn-service.js'
import type { JsonResponse } from '../response.js'
import { rewindThread, startTurn } from './turns.js'

describe('POST /v1/threads/:id/turns admission', () => {
  it('rejects stale Graph submissions after safe disable while direct turns remain available', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-26T00:00:00.000Z'
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_graph_disabled'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Safe disable',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))

    const graphResponse = await startTurn(
      turns,
      threadId,
      new Request(`http://kun.local/v1/threads/${threadId}/turns`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'graph task', orchestration: 'graph' })
      }),
      undefined,
      () => false
    ) as JsonResponse
    expect(graphResponse.status).toBe(503)
    expect((await threadStore.get(threadId))?.turns).toEqual([])

    const directResponse = await startTurn(
      turns,
      threadId,
      new Request(`http://kun.local/v1/threads/${threadId}/turns`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'direct task' })
      }),
      undefined,
      () => false
    ) as JsonResponse
    expect(directResponse.status).toBe(202)
  })

  it('maps an archived thread to a conflict without creating a turn', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_route_archived'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Archived route',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro',
      status: 'archived'
    }))

    const response = await startTurn(
      turns,
      threadId,
      new Request(`http://kun.local/v1/threads/${threadId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'must be rejected' })
      })
    ) as JsonResponse

    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({
      code: 'conflict',
      message: `thread is archived: ${threadId}`
    })
    expect((await threadStore.get(threadId))?.turns).toEqual([])
  })

  it('maps exhausted global admission capacity to a structured 429 response', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      maxConcurrentTurns: 1,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await Promise.all(['thr_route_capacity_a', 'thr_route_capacity_b'].map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id,
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))))
    const first = await turns.startTurn({
      threadId: 'thr_route_capacity_a',
      request: { prompt: 'occupy the only slot' }
    })

    const response = await startTurn(
      turns,
      'thr_route_capacity_b',
      new Request('http://kun.local/v1/threads/thr_route_capacity_b/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'must be rejected' })
      })
    ) as JsonResponse

    expect(response.status).toBe(429)
    expect(JSON.parse(response.body)).toEqual({
      code: 'rate_limited',
      message: expect.stringContaining('runtime turn capacity reached'),
      details: { maxConcurrentTurns: 1 }
    })
    expect((await threadStore.get('thr_route_capacity_b'))?.turns).toEqual([])
    await turns.interruptTurn({ threadId: 'thr_route_capacity_a', turnId: first.turnId })
  })

  it('maps an active rewind attempt to a structured conflict', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_route_rewind_active'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Route rewind',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await turns.startTurn({ threadId, request: { prompt: 'stay active' } })

    const response = await rewindThread(
      turns,
      threadId,
      new Request(`http://kun.local/v1/threads/${threadId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: started.turnId })
      })
    ) as JsonResponse

    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({
      code: 'conflict',
      message: `cannot rewind while a turn is active: ${threadId}`
    })
    await turns.interruptTurn({ threadId, turnId: started.turnId })
  })
})
