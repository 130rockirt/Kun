import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { StartTurnRequest } from '../contracts/turns.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { TurnConflictError, TurnService } from './turn-service.js'
import {
  QUEUE_ADMISSION_FAILED_CODE,
  QUEUE_CANCELLED_TURN_CODE,
  MAX_QUEUED_TURNS_PER_THREAD
} from './turn-service-queue-operations.js'

type Harness = {
  turns: TurnService
  threadStore: InMemoryThreadStore
  sessionStore: InMemorySessionStore
  eventBus: InMemoryEventBus
  published: RuntimeEvent[]
  settled: string[]
}

function createHarness(options: { maxConcurrentTurns?: number } = {}): Harness {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const nowIso = () => new Date().toISOString()
  const settled: string[] = []
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
    ...(options.maxConcurrentTurns !== undefined
      ? { maxConcurrentTurns: options.maxConcurrentTurns }
      : {}),
    ids: new SequentialIdGenerator(),
    nowIso
  })
  turns.setTurnSettledHook((threadId) => {
    settled.push(threadId)
  })
  const published: RuntimeEvent[] = []
  eventBus.subscribe('thr_q', (event) => {
    published.push(event)
  })
  eventBus.subscribe('thr_other', (event) => {
    published.push(event)
  })
  eventBus.subscribe('thr_blocker', (event) => {
    published.push(event)
  })
  return { turns, threadStore, sessionStore, eventBus, published, settled }
}

async function createThread(h: Harness, id: string): Promise<void> {
  await h.threadStore.upsert(createThreadRecord({
    id,
    title: 'Queue thread',
    workspace: '/tmp/workspace',
    model: 'deepseek-v4-pro'
  }))
}

function startRequest(prompt: string, extras: Partial<StartTurnRequest> = {}): StartTurnRequest {
  return { prompt, model: 'deepseek-v4-pro', ...extras }
}

function eventsOfKind(h: Harness, kind: RuntimeEvent['kind']): RuntimeEvent[] {
  return h.published.filter((event) => event.kind === kind)
}

describe('durable per-thread turn queue', () => {
  it('queues a start request on a busy thread when enqueueIfBusy is set', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const queued = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true, clientRequestId: 'req-2' })
    })
    expect(queued.status).toBe('queued')
    expect(queued.queuedPosition).toBe(1)
    expect(queued.turnId).not.toBe(first.turnId)
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns.map((turn) => turn.status)).toEqual(['running', 'queued'])
    // The queued message is durable and visible immediately.
    const items = await h.sessionStore.loadItems('thr_q')
    expect(items.filter((item) => item.kind === 'user_message')).toHaveLength(2)
    expect(eventsOfKind(h, 'turn_queued')).toHaveLength(1)
    // A queued turn holds no global admission slot.
    await createThread(h, 'thr_other')
    await expect(
      h.turns.startTurn({ threadId: 'thr_other', request: startRequest('other') })
    ).resolves.toMatchObject({ threadId: 'thr_other' })
  })

  it('rejects a plain start on a busy thread even when queued turns exist', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    await expect(
      h.turns.startTurn({ threadId: 'thr_q', request: startRequest('third') })
    ).rejects.toBeInstanceOf(TurnConflictError)
  })

  it('replays an enqueued request by clientRequestId without duplicating the queue entry', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const request = startRequest('second', { enqueueIfBusy: true, clientRequestId: 'req-dup' })
    const first = await h.turns.startTurn({ threadId: 'thr_q', request })
    const retry = await h.turns.startTurn({ threadId: 'thr_q', request })
    expect(retry.turnId).toBe(first.turnId)
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns).toHaveLength(2)
    expect(eventsOfKind(h, 'turn_queued')).toHaveLength(1)
  })

  it('enforces the per-thread queue limit', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    for (let index = 0; index < MAX_QUEUED_TURNS_PER_THREAD; index += 1) {
      await h.turns.startTurn({
        threadId: 'thr_q',
        request: startRequest(`queued ${index}`, { enqueueIfBusy: true })
      })
    }
    await expect(
      h.turns.startTurn({
        threadId: 'thr_q',
        request: startRequest('overflow', { enqueueIfBusy: true })
      })
    ).rejects.toThrow(/queued turn limit/)
  })

  it('starts the next queued turn after completion and notifies the settlement hook', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const queued = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: first.turnId, status: 'completed' })
    expect(h.settled).toEqual(['thr_q'])

    const started = await h.turns.startNextQueuedTurn('thr_q')
    expect(started).toEqual({ turnId: queued.turnId })
    const thread = await h.threadStore.get('thr_q')
    const promoted = thread?.turns.find((turn) => turn.id === queued.turnId)
    expect(promoted?.status).toBe('running')
    expect(eventsOfKind(h, 'turn_started').map((event) => event.turnId))
      .toContain(queued.turnId)
  })

  it('does not auto-drain after a user interrupt', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    await h.turns.interruptTurn({ threadId: 'thr_q', turnId: first.turnId })
    expect(h.settled).toEqual([])
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns.map((turn) => turn.status)).toEqual(['aborted', 'queued'])
    // A manual resume promotes the queued turn afterwards.
    const resumed = await h.turns.startNextQueuedTurn('thr_q')
    expect(resumed).not.toBeNull()
  })

  it('drains queued turns in FIFO order', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const second = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    const third = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('third', { enqueueIfBusy: true })
    })
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: first.turnId, status: 'completed' })
    expect(await h.turns.startNextQueuedTurn('thr_q')).toEqual({ turnId: second.turnId })
    expect(await h.turns.startNextQueuedTurn('thr_q')).toBeNull()
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: second.turnId, status: 'failed', error: 'boom' })
    expect(await h.turns.startNextQueuedTurn('thr_q')).toEqual({ turnId: third.turnId })
  })

  it('cancels a queued turn and keeps later entries queued', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const second = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    const third = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('third', { enqueueIfBusy: true })
    })
    const cancelled = await h.turns.cancelQueuedTurn({ threadId: 'thr_q', turnId: second.turnId })
    expect(cancelled.status).toBe('aborted')
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns.map((turn) => turn.status)).toEqual(['running', 'aborted', 'queued'])
    const cancelledTurn = thread?.turns.find((turn) => turn.id === second.turnId)
    expect(cancelledTurn?.terminalCode).toBe(QUEUE_CANCELLED_TURN_CODE)
    expect(eventsOfKind(h, 'turn_aborted').map((event) => event.turnId))
      .toContain(second.turnId)
    // Cancelling the running turn is a conflict.
    await expect(
      h.turns.cancelQueuedTurn({ threadId: 'thr_q', turnId: first.turnId })
    ).rejects.toBeInstanceOf(TurnConflictError)
    // Cancelling an already-terminal turn is a conflict too.
    await expect(
      h.turns.cancelQueuedTurn({ threadId: 'thr_q', turnId: second.turnId })
    ).rejects.toBeInstanceOf(TurnConflictError)
    expect(third).toBeTruthy()
  })

  it('reorders queued turns relative to each other', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const second = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    const third = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('third', { enqueueIfBusy: true })
    })
    const moved = await h.turns.moveQueuedTurn({
      threadId: 'thr_q',
      turnId: third.turnId,
      beforeTurnId: second.turnId
    })
    expect(moved.queuedPosition).toBe(1)
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns.slice(1).map((turn) => turn.id))
      .toEqual([third.turnId, second.turnId])
  })

  it('fails a queued turn whose durable surface lock no longer applies and tries the next one', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const poisoned = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('poisoned', { enqueueIfBusy: true })
    })
    const healthy = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('healthy', { enqueueIfBusy: true })
    })
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: first.turnId, status: 'completed' })
    // Mutate the queued record directly (a downgrade/corrupt store scenario):
    // its frozen snapshot now requires a Design profile that is missing, so
    // re-running admission at drain time must fail it and skip ahead.
    const thread = await h.threadStore.get('thr_q')
    await h.threadStore.upsert({
      ...thread!,
      turns: thread!.turns.map((turn) =>
        turn.id === poisoned.turnId
          ? { ...turn, agentSurface: 'design' as const }
          : turn
      )
    })
    const started = await h.turns.startNextQueuedTurn('thr_q')
    const after = await h.threadStore.get('thr_q')
    const poisonedTurn = after?.turns.find((turn) => turn.id === poisoned.turnId)
    expect(poisonedTurn?.status).toBe('failed')
    expect(poisonedTurn?.terminalCode).toBe(QUEUE_ADMISSION_FAILED_CODE)
    expect(started).toEqual({ turnId: healthy.turnId })
  })

  it('returns null while capacity is exhausted and starts after it frees', async () => {
    const h = createHarness({ maxConcurrentTurns: 1 })
    await createThread(h, 'thr_q')
    await createThread(h, 'thr_blocker')
    const blocker = await h.turns.startTurn({
      threadId: 'thr_blocker',
      request: startRequest('blocker')
    })
    // The single global slot is held by the blocker; thr_q's first turn can
    // only enqueue once thr_q itself is busy, so emulate by parking the
    // blocker, starting thr_q, then re-filling the slot with a fresh turn.
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
      .catch((error: unknown) => error)
    if (first instanceof Error) {
      // Capacity held by the blocker; free it and start thr_q directly.
      await h.turns.finishTurn({ threadId: 'thr_blocker', turnId: blocker.turnId, status: 'completed' })
      await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    }
    await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('queued', { enqueueIfBusy: true })
    })
    // Saturate the single slot with another thread's turn after thr_q's own
    // turn settles, so the queued turn cannot promote.
    const runningFirst = (await h.threadStore.get('thr_q'))!.turns.find(
      (turn) => turn.status === 'running'
    )!
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: runningFirst.id, status: 'completed' })
    const blocker2 = await h.turns.startTurn({
      threadId: 'thr_blocker',
      request: startRequest('blocker-2')
    })
    expect(await h.turns.startNextQueuedTurn('thr_q')).toBeNull()
    await h.turns.finishTurn({ threadId: 'thr_blocker', turnId: blocker2.turnId, status: 'completed' })
    expect(await h.turns.startNextQueuedTurn('thr_q')).not.toBeNull()
  })

  it('interrupt on a queued turn aborts it without touching running execution', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const queued = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    const result = await h.turns.interruptTurn({ threadId: 'thr_q', turnId: queued.turnId })
    expect(result.status).toBe('aborted')
    const thread = await h.threadStore.get('thr_q')
    expect(thread?.turns.map((turn) => turn.status)).toEqual(['running', 'aborted'])
    expect(h.turns.isTurnExecutionActive(first.turnId)).toBe(true)
  })

  it('queued turns carry admission metadata so restart reconciliation keeps them durable', async () => {
    const h = createHarness()
    await createThread(h, 'thr_q')
    const first = await h.turns.startTurn({ threadId: 'thr_q', request: startRequest('first') })
    const queued = await h.turns.startTurn({
      threadId: 'thr_q',
      request: startRequest('second', { enqueueIfBusy: true })
    })
    const thread = await h.threadStore.get('thr_q')
    const record = thread?.turns.find((turn) => turn.id === queued.turnId)
    expect(record?.admissionCompletedAt).toBeTruthy()
    expect(record?.admissionPending).toBeUndefined()
    // Settle the in-process running turn (a real restart parks/suspends it);
    // the durable queued turn must survive the orphan sweep untouched.
    await h.turns.finishTurn({ threadId: 'thr_q', turnId: first.turnId, status: 'completed' })
    await h.turns.reconcileOrphanedTurns()
    const after = await h.threadStore.get('thr_q')
    expect(after?.turns.find((turn) => turn.id === queued.turnId)?.status).toBe('queued')
  })
})
