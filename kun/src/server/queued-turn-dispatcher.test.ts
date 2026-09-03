import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord, finishTurn as finishTurnRecord } from '../domain/turn.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { ThreadExecutionLease } from '../contracts/runtime-flavor.js'
import type { ThreadExecutionLeasePort } from '../ports/thread-execution-lease.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import { QueuedTurnDispatcher } from './queued-turn-dispatcher.js'

describe('QueuedTurnDispatcher queue-commit trigger', () => {
  it('promotes a turn queued onto an idle thread exactly once via the queued hook', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => new Date().toISOString()
    // A busy lease forces the enqueue path; after the pre-check the settled
    // turn's lease is released, which is exactly the boundary the queued
    // hook exists for.
    let preCheckCalls = 0
    const executionLeases: ThreadExecutionLeasePort = {
      acquire: async (threadId, turnId) => ({
        threadId,
        turnId,
        ownerFlavor: 'production',
        ownerInstanceId: 'owner_test',
        fencingToken: 1,
        acquiredAt: '2026-09-03T00:00:00.000Z',
        expiresAt: '2026-09-03T01:00:00.000Z'
      }),
      release: async () => undefined,
      owner: async () => {
        preCheckCalls += 1
        return preCheckCalls <= 1
          ? ({
              threadId: 'thr_disp',
              turnId: 'turn_prev',
              ownerFlavor: 'production',
              ownerInstanceId: 'owner_test',
              fencingToken: 1,
              acquiredAt: '2026-09-03T00:00:00.000Z',
              expiresAt: '2026-09-03T01:00:00.000Z'
            } as ThreadExecutionLease)
          : null
      },
      shutdown: async () => undefined
    }
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
      nowIso,
      executionLeases
    })
    const runTurn = vi.fn(async () => undefined)
    const dispatcher = new QueuedTurnDispatcher({ turns, runTurn })
    turns.setTurnSettledHook((threadId) => dispatcher.drain(threadId))
    turns.setTurnQueuedHook((threadId) => dispatcher.drain(threadId))

    await threadStore.upsert(createThreadRecord({
      id: 'thr_disp',
      title: 'Dispatcher thread',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))

    // The race this guards: the busy decision saw a running turn, but it
    // settled before the queue record committed. The commit trigger must
    // promote the durable record as a direct start — no user-visible conflict.
    const thread = (await threadStore.get('thr_disp'))!
    await threadStore.upsert({
      ...thread,
      turns: [finishTurnRecord(
        createTurnRecord({ id: 'turn_prev', threadId: 'thr_disp', prompt: 'previous' }),
        'completed',
        '2026-09-03T00:00:01.000Z'
      )]
    })

    const queued = await turns.startTurn({
      threadId: 'thr_disp',
      request: { prompt: 'follow-up at settle boundary', model: 'deepseek-v4-pro', enqueueIfBusy: true }
    })
    expect(queued.status).toBe('queued')

    // The lease was already released when the record committed; the queued
    // hook's drain must promote it as a direct start without any further
    // trigger.
    await vi.waitFor(() => {
      expect(runTurn).toHaveBeenCalledOnce()
    })
    expect(runTurn).toHaveBeenCalledWith('thr_disp', queued.turnId)
    // Promotion happened exactly once: the record is running, not duplicated.
    const after = await threadStore.get('thr_disp')
    expect(after?.turns.filter((turn) => turn.status === 'running')).toHaveLength(1)
    expect(after?.turns.find((turn) => turn.id === queued.turnId)?.status).toBe('running')
  })
})
