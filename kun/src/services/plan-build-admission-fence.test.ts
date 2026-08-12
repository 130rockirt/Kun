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
import {
  fingerprintStartTurnRequest,
  hashPlanBuildAdmissionCapability
} from './turn-service-core.js'

const nowIso = () => '2026-08-12T12:00:00.000Z'
const planBuildAdmissionCapability = 'A'.repeat(43)

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
    planBuildRunId: 'run-plan',
    planBuildAdmissionFingerprint: fingerprintStartTurnRequest(originRequest())!,
    planBuildAdmissionCapabilityHash: hashPlanBuildAdmissionCapability(planBuildAdmissionCapability),
    forkedFromTurnCount: 0
  }))
}

function originRequest() {
  return {
    prompt: 'Execute the durable plan.',
    clientRequestId: 'plan-build:run-plan',
    mode: 'agent' as const,
    orchestration: 'direct' as const,
    clientSurface: 'gui' as const,
    agentSurface: 'code' as const,
    planBuildAdmissionCapability
  }
}

async function admitAndFinishOrigin(runtime: ReturnType<typeof harness>): Promise<void> {
  const started = await runtime.turns.startTurn({
    threadId: 'thr_plan',
    request: originRequest()
  })
  await runtime.turns.interruptTurn({ threadId: 'thr_plan', turnId: started.turnId })
}

describe('plan-build admission fence', () => {
  it('reserves the first post-fork turn for the exact durable host admission', async () => {
    const runtime = harness()
    await seed(runtime)

    for (const request of [
      { prompt: 'ordinary composer turn', mode: 'agent' as const, agentSurface: 'code' as const },
      { ...originRequest(), prompt: 'Forged prompt with the predictable request id.' },
      { ...originRequest(), planBuildAdmissionCapability: 'B'.repeat(43) },
      { ...originRequest(), clientSurface: 'api' as const }
    ]) {
      await expect(runtime.turns.startTurn({ threadId: 'thr_plan', request }))
        .rejects.toThrow('durable plan-build admission identity')
    }

    const first = await runtime.turns.startTurn({ threadId: 'thr_plan', request: originRequest() })
    await expect(runtime.turns.startTurn({
      threadId: 'thr_plan', request: originRequest()
    })).resolves.toEqual(first)
    const thread = await runtime.threadStore.get('thr_plan')
    expect(thread?.turns[0]).not.toHaveProperty('planBuildAdmissionCapability')

    await runtime.turns.interruptTurn({ threadId: 'thr_plan', turnId: first.turnId })
    await expect(runtime.turns.startTurn({
      threadId: 'thr_plan', request: { prompt: 'ordinary continuation', clientSurface: 'api' }
    })).resolves.toMatchObject({ threadId: 'thr_plan' })
  })

  it('fails closed for an empty legacy plan-build fork without a binding', async () => {
    const runtime = harness()
    await runtime.threadStore.upsert(createThreadRecord({
      id: 'thr_legacy_plan', title: 'Legacy plan', workspace: '/tmp/plan-worktree', model: 'm',
      relation: 'side', parentThreadId: 'thr_source', planBuildRunId: 'run-plan', forkedFromTurnCount: 0
    }))
    await expect(runtime.turns.startTurn({
      threadId: 'thr_legacy_plan', request: originRequest()
    })).rejects.toThrow('missing a durable admission binding')
  })

  it('blocks turn admission while frozen and atomically rebinds on release', async () => {
    const runtime = harness()
    await seed(runtime)
    await admitAndFinishOrigin(runtime)
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
      runtime.turns.startTurn({ threadId: 'thr_plan', request: originRequest() })
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
