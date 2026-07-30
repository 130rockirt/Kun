import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { makeCompactionItem, makeUserItem } from '../domain/item.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import {
  projectSessionItemsOntoExistingTurns,
  ThreadItemProjectionService
} from './thread-item-projection.js'
import { TurnService } from './turn-service.js'

const threadId = 'thread_projection'
const nowIso = () => '2026-07-11T00:00:00.000Z'

describe('thread item projection', () => {
  it('projects existing turn buckets without changing thread or turn metadata', () => {
    const firstTurn = {
      ...createTurnRecord({
        id: 'turn_first',
        threadId,
        prompt: 'first prompt',
        attachmentIds: ['attachment_1'],
        status: 'completed'
      }),
      activeSkillIds: ['documents'],
      items: [makeUserItem({ id: 'stale_first', threadId, turnId: 'turn_first', text: 'stale' })]
    }
    const secondTurn = createTurnRecord({
      id: 'turn_second',
      threadId,
      prompt: 'second prompt',
      status: 'completed'
    })
    const untouchedTurn = {
      ...createTurnRecord({
        id: 'turn_without_session_items',
        threadId,
        prompt: 'keep this turn',
        status: 'completed'
      }),
      items: [makeUserItem({
        id: 'keep_existing',
        threadId,
        turnId: 'turn_without_session_items',
        text: 'keep existing mirror'
      })]
    }
    const thread = {
      ...createThreadRecord({
        id: threadId,
        title: 'Projection metadata',
        titleAuto: false,
        workspace: '/workspace',
        model: 'test-model',
        goal: {
          threadId,
          objective: 'preserve metadata',
          status: 'active',
          tokensUsed: 7,
          timeUsedSeconds: 3,
          createdAt: nowIso(),
          updatedAt: nowIso()
        }
      }),
      turns: [firstTurn, secondTurn, untouchedTurn]
    }
    const firstHead = {
      ...makeUserItem({ id: 'first_head', threadId, turnId: firstTurn.id, text: 'head' }),
      createdAt: '2026-07-11T00:00:00.000Z'
    }
    const firstSummary = {
      ...makeCompactionItem({
        id: 'first_summary',
        threadId,
        turnId: firstTurn.id,
        summary: 'summary',
        replacedTokens: 10,
        pinnedConstraints: []
      }),
      createdAt: '2026-07-11T00:00:02.000Z'
    }
    const firstTail = {
      ...makeUserItem({ id: 'first_tail', threadId, turnId: firstTurn.id, text: 'tail' }),
      createdAt: '2026-07-11T00:00:03.000Z'
    }
    const secondItem = makeUserItem({ id: 'second_item', threadId, turnId: secondTurn.id, text: 'second' })
    const unknownItem = makeUserItem({ id: 'unknown_item', threadId, turnId: 'turn_unknown', text: 'unknown' })

    const sessionItems = [
      firstHead,
      firstSummary,
      firstTail,
      unknownItem,
      secondItem
    ]
    const projected = projectSessionItemsOntoExistingTurns(thread, sessionItems)

    expect(projected).not.toBeNull()
    expect(projected).toMatchObject({
      title: 'Projection metadata',
      titleAuto: false,
      goal: { objective: 'preserve metadata', tokensUsed: 7 }
    })
    expect(projected?.turns.map((turn) => turn.id)).toEqual([
      firstTurn.id,
      secondTurn.id,
      untouchedTurn.id
    ])
    expect(projected?.turns[0]).toMatchObject({
      prompt: 'first prompt',
      attachmentIds: ['attachment_1'],
      activeSkillIds: ['documents']
    })
    expect(projected?.turns[0]?.items.map((item) => item.id)).toEqual([
      'first_head',
      'first_summary',
      'first_tail'
    ])
    expect(sessionItems.map((item) => item.id)).toEqual([
      'first_head',
      'first_summary',
      'first_tail',
      'unknown_item',
      'second_item'
    ])
    expect(projected?.turns[1]?.items.map((item) => item.id)).toEqual(['second_item'])
    expect(projected?.turns[2]).toBe(untouchedTurn)
  })

  it('keeps zero-token compaction markers in session order and skips unmatched projections', () => {
    const turn = createTurnRecord({ id: 'turn_zero', threadId, prompt: 'zero', status: 'completed' })
    const thread = { ...createThreadRecord({ id: threadId, title: 'zero', workspace: '/', model: 'm' }), turns: [turn] }
    const head = makeUserItem({ id: 'head', threadId, turnId: turn.id, text: 'head' })
    const noOpSummary = makeCompactionItem({
      id: 'noop_summary',
      threadId,
      turnId: turn.id,
      summary: 'noop',
      replacedTokens: 0,
      pinnedConstraints: []
    })
    const tail = makeUserItem({ id: 'tail', threadId, turnId: turn.id, text: 'tail' })

    const projected = projectSessionItemsOntoExistingTurns(thread, [head, noOpSummary, tail])
    expect(projected?.turns[0]?.items.map((item) => item.id)).toEqual([
      'head',
      'noop_summary',
      'tail'
    ])
    expect(projectSessionItemsOntoExistingTurns(thread, [
      makeUserItem({ id: 'unknown', threadId, turnId: 'missing_turn', text: 'unknown' })
    ])).toBeNull()
  })

  it('does not upsert when the thread is missing or no session bucket matches', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const service = new ThreadItemProjectionService({ threadStore, sessionStore, nowIso })
    const upsert = vi.spyOn(threadStore, 'upsert')

    await service.syncFromSession('missing_thread')
    expect(upsert).not.toHaveBeenCalled()

    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'no match',
      workspace: '/',
      model: 'm'
    }))
    await sessionStore.appendItem(threadId, makeUserItem({
      id: 'unknown',
      threadId,
      turnId: 'unknown_turn',
      text: 'unknown'
    }))
    upsert.mockClear()
    await service.syncFromSession(threadId)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('cannot overwrite a concurrent append with an older session snapshot', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const turn = {
      ...createTurnRecord({ id: 'turn_race', threadId, prompt: 'race', status: 'running' }),
      items: []
    }
    await threadStore.upsert({
      ...createThreadRecord({ id: threadId, title: 'race', workspace: '/', model: 'm', status: 'running' }),
      turns: [turn]
    })
    const first = makeUserItem({ id: 'item_first', threadId, turnId: turn.id, text: 'first' })
    await sessionStore.appendItem(threadId, first)
    const current = await threadStore.get(threadId)
    if (!current) throw new Error('expected thread')
    await threadStore.upsert({
      ...current,
      turns: current.turns.map((candidate) => (
        candidate.id === turn.id ? { ...candidate, items: [first] } : candidate
      ))
    })

    const originalLoadItems = sessionStore.loadItems.bind(sessionStore)
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    sessionStore.loadItems = async (id) => {
      const snapshot = await originalLoadItems(id)
      entered()
      await releasePromise
      return snapshot
    }

    const bus = new InMemoryEventBus()
    const events = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (id) => bus.allocateSeq(id),
      nowIso
    })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const service = new ThreadItemProjectionService({ threadStore, sessionStore, nowIso })
    const syncing = service.syncFromSession(threadId)
    await enteredPromise

    const concurrent = makeUserItem({
      id: 'item_concurrent',
      threadId,
      turnId: turn.id,
      text: 'concurrent append'
    })
    let appendSettled = false
    const appending = turns.applyItem(threadId, concurrent).finally(() => {
      appendSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((await originalLoadItems(threadId)).map((item) => item.id)).toEqual([
      'item_first',
      'item_concurrent'
    ])
    expect(appendSettled).toBe(false)

    release()
    await Promise.all([syncing, appending])
    const sessionIds = (await originalLoadItems(threadId)).map((item) => item.id)
    const threadIds = (await threadStore.get(threadId))?.turns[0]?.items.map((item) => item.id)
    expect(threadIds).toEqual(sessionIds)
  })
})
