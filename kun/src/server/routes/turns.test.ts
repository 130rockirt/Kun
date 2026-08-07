import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../../domain/thread.js'
import { createTurnRecord } from '../../domain/turn.js'
import { makeGoalContextItem, makeUserItem } from '../../domain/item.js'
import { ContextCompactor } from '../../loop/context-compactor.js'
import { InflightTracker } from '../../loop/inflight-tracker.js'
import { SteeringQueue } from '../../loop/steering-queue.js'
import { SequentialIdGenerator } from '../../ports/id-generator.js'
import { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import { TurnService } from '../../services/turn-service.js'
import type { JsonResponse } from '../response.js'
import { cancelToolCall, getTurn, rewindThread, startTurn, steerTurn } from './turns.js'

describe('GET /v1/threads/:id/turns/:turnId public-item boundary', () => {
  it('does not expose a legacy internal goal context from the raw turn mirror', async () => {
    const turn = createTurnRecord({
      id: 'turn_legacy_goal_context', threadId: 'thr_legacy_goal_context', prompt: 'finish', status: 'completed'
    })
    const user = makeUserItem({ id: 'item_user', threadId: turn.threadId, turnId: turn.id, text: 'finish' })
    const context = makeGoalContextItem({
      id: 'item_goal_context',
      threadId: turn.threadId,
      turnId: turn.id,
      text: 'internal goal instructions must never be public'
    })
    const turns = {
      getTurn: async () => ({ ...turn, items: [user, context] })
    } as unknown as TurnService

    const response = await getTurn(turns, turn.threadId, turn.id)
    const body = JSON.parse(response.body)

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([user.id])
    expect(JSON.stringify(body)).not.toContain('internal goal instructions')
  })
})

describe('POST /v1/threads/:id/turns/:turnId/steer execution', () => {
  it('starts the runner after accepted steering so a suspended Graph planning turn can continue', async () => {
    const turns = {
      steerTurn: vi.fn(async () => undefined)
    } as unknown as TurnService
    const onSteered = vi.fn()
    const response = await steerTurn(
      turns,
      'thread_graph_planning',
      'turn_graph_planning',
      new Request('http://kun.local/v1/threads/thread_graph_planning/turns/turn_graph_planning/steer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Continue building the Graph.' })
      }),
      onSteered
    ) as JsonResponse

    expect(response.status).toBe(200)
    expect(turns.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread_graph_planning',
      turnId: 'turn_graph_planning',
      text: 'Continue building the Graph.'
    })
    expect(onSteered).toHaveBeenCalledWith({
      threadId: 'thread_graph_planning',
      turnId: 'turn_graph_planning'
    })
  })
})

describe('POST /v1/threads/:id/turns/:turnId/tool-calls/:callId/cancel', () => {
  it('returns the accepted cancellation status without requiring a request body', async () => {
    const cancellation = {
      cancel: vi.fn(async (input: { threadId: string; turnId: string; callId: string }) => ({
        ...input,
        status: 'cancellation_requested' as const
      }))
    }
    const response = await cancelToolCall(
      cancellation as never,
      'thread_1',
      'turn_1',
      'call_1'
    ) as JsonResponse

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      status: 'cancellation_requested'
    })
    expect(cancellation.cancel).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1'
    })
  })

  it('maps missing and inactive calls to the documented HTTP statuses', async () => {
    const notFound = await cancelToolCall({
      cancel: async () => { throw new Error('tool call not found: call_1') }
    } as never, 'thread_1', 'turn_1', 'call_1') as JsonResponse
    expect(notFound.status).toBe(404)

    const conflict = await cancelToolCall({
      cancel: async () => { throw new Error('tool call is no longer active: call_1') }
    } as never, 'thread_1', 'turn_1', 'call_1') as JsonResponse
    expect(conflict.status).toBe(409)
  })
})

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
