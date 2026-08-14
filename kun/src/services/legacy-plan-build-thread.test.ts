import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { TurnService } from './turn-service.js'

describe('legacy plan-build thread admission', () => {
  it('treats retained plan-build metadata as inert and accepts ordinary input', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso: () => '2026-08-14T00:00:00.000Z'
    })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids,
      nowIso: () => '2026-08-14T00:00:00.000Z'
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_legacy_plan',
      title: 'Legacy plan',
      workspace: '/tmp/plan-worktree',
      model: 'm',
      relation: 'side',
      parentThreadId: 'thr_source',
      planBuildRunId: 'run-plan',
      planBuildAdmissionFrozen: true,
      forkedFromTurnCount: 0
    }))

    const started = await turns.startTurn({
      threadId: 'thr_legacy_plan',
      request: { prompt: 'Continue this historical task normally.', clientSurface: 'gui' }
    })

    expect(started).toMatchObject({ threadId: 'thr_legacy_plan' })
    await turns.interruptTurn({ threadId: 'thr_legacy_plan', turnId: started.turnId })
  })
})
