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
import { ThreadService } from './thread-service.js'
import { TurnService } from './turn-service.js'

const nowIso = () => '2026-08-12T12:00:00.000Z'

function harness() {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const ids = new SequentialIdGenerator()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  return {
    threadStore,
    threads: new ThreadService({ threadStore, sessionStore, events, ids, nowIso }),
    turns: new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
  }
}

async function seed(runtime: ReturnType<typeof harness>) {
  await runtime.threadStore.upsert(createThreadRecord({
    id: 'thr_plan',
    title: 'Plan executor',
    workspace: '/tmp/plan-worktree',
    model: 'm',
    relation: 'side',
    parentThreadId: 'thr_source',
    planBuildRunId: 'run-plan'
  }))
}

describe('plan-build admission fence', () => {
  it('blocks turn admission while frozen and atomically rebinds on release', async () => {
    const runtime = harness()
    await seed(runtime)
    const frozen = await runtime.threads.setPlanBuildAdmissionFence('thr_plan', {
      planBuildRunId: 'run-plan',
      expectedWorkspace: '/tmp/plan-worktree',
      frozen: true
    })
    expect(frozen.planBuildAdmissionFrozen).toBe(true)
    await expect(runtime.turns.startTurn({
      threadId: 'thr_plan', request: { prompt: 'late turn' }
    })).rejects.toThrow('admission is frozen')

    const released = await runtime.threads.setPlanBuildAdmissionFence('thr_plan', {
      planBuildRunId: 'run-plan',
      expectedWorkspace: '/tmp/plan-worktree',
      frozen: false,
      workspace: '/tmp/source-checkout'
    })
    expect(released).toMatchObject({
      workspace: '/tmp/source-checkout',
      planBuildAdmissionFrozen: false
    })
    await expect(runtime.turns.startTurn({
      threadId: 'thr_plan', request: { prompt: 'source continuation' }
    })).resolves.toMatchObject({ threadId: 'thr_plan' })
  })

  it('serializes freeze and turn admission so exactly one boundary wins', async () => {
    const runtime = harness()
    await seed(runtime)
    const [freeze, admission] = await Promise.allSettled([
      runtime.threads.setPlanBuildAdmissionFence('thr_plan', {
        planBuildRunId: 'run-plan',
        expectedWorkspace: '/tmp/plan-worktree',
        frozen: true
      }),
      runtime.turns.startTurn({ threadId: 'thr_plan', request: { prompt: 'racing turn' } })
    ])

    expect([freeze.status, admission.status].sort()).toEqual(['fulfilled', 'rejected'])
    const thread = await runtime.threadStore.get('thr_plan')
    if (freeze.status === 'fulfilled') {
      expect(thread?.planBuildAdmissionFrozen).toBe(true)
      expect(thread?.turns).toHaveLength(0)
    } else {
      expect(thread?.turns.at(-1)?.status).toBe('running')
      expect(thread?.planBuildAdmissionFrozen).not.toBe(true)
    }
  })
})
