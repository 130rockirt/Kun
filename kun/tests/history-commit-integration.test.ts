import { describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeUserItem } from '../src/domain/item.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import type { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { bootstrapThread, makeHarness, makeSilentModel } from './loop-test-harness.js'

type ConditionalRewriteGate = {
  entered: Promise<void>
  release(): void
}

function blockFirstConditionalRewrite(store: InMemorySessionStore): ConditionalRewriteGate {
  const raw = store.rewriteItemsIfRevision.bind(store)
  let entered!: () => void
  let release!: () => void
  let blocked = false
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  store.rewriteItemsIfRevision = async (...args) => {
    if (!blocked) {
      blocked = true
      entered()
      await releasePromise
    }
    return raw(...args)
  }
  return { entered: enteredPromise, release }
}

describe('revision-aware history integrations', () => {
  it('retains a newly-started turn when discard races a full-history replacement', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h, { request: { prompt: 'first request' } })
    await h.turns.applyItem(h.threadId, makeAssistantTextItem({
      id: 'item_discarded_response',
      threadId: h.threadId,
      turnId: h.turnId,
      text: 'discard this generated response'
    }))
    const gate = blockFirstConditionalRewrite(h.sessionStore)

    const interrupting = h.turns.interruptTurn({
      threadId: h.threadId,
      turnId: h.turnId,
      discard: true
    })
    await gate.entered
    const next = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'new request must survive' }
    })
    gate.release()
    await expect(interrupting).resolves.toEqual({ status: 'aborted' })

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user_message', text: 'first request' }),
      expect.objectContaining({ kind: 'user_message', text: 'new request must survive' })
    ]))
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_discarded_response' })
    ]))
    const thread = await h.threadStore.get(h.threadId)
    expect(thread?.turns.find((turn) => turn.id === next.turnId)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user_message', text: 'new request must survive' })
    ]))

    await h.turns.interruptTurn({ threadId: h.threadId, turnId: next.turnId })
  })

  it('retries load-time healing from current history instead of dropping a concurrent append', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h, { request: { prompt: 'heal this history' } })
    await h.sessionStore.appendItem(h.threadId, {
      id: 'item_malformed_tool_call',
      threadId: h.threadId,
      turnId: h.turnId,
      role: 'tool',
      status: 'completed',
      createdAt: '2026-07-10T00:00:00.000Z',
      kind: 'tool_call',
      callId: '',
      toolName: '',
      toolKind: 'tool_call',
      arguments: {}
    })
    const gate = blockFirstConditionalRewrite(h.sessionStore)

    const running = h.loop.runTurn(h.threadId, h.turnId)
    await gate.entered
    await h.sessionStore.appendItem(h.threadId, makeUserItem({
      id: 'item_late_history_append',
      threadId: h.threadId,
      turnId: 'turn_late',
      text: 'late history append'
    }))
    gate.release()
    await expect(running).resolves.toBe('completed')

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_late_history_append', text: 'late history append' })
    ]))
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'item_malformed_tool_call' })
    ]))
  })

  it('retains a concurrent append and emits one completion when automatic compaction retries', async () => {
    const h = makeHarness(makeSilentModel(), {
      compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 })
    })
    await bootstrapThread(h, { request: { prompt: 'compact this history' } })
    const seedIds: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const id = `item_auto_seed_${index}`
      seedIds.push(id)
      await h.sessionStore.appendItem(h.threadId, makeUserItem({
        id,
        threadId: h.threadId,
        turnId: h.turnId,
        text: `durable automatic-compaction seed ${index} ${'x'.repeat(24)}`
      }))
    }
    const gate = blockFirstConditionalRewrite(h.sessionStore)

    const running = h.loop.runTurn(h.threadId, h.turnId)
    await gate.entered
    await h.turns.applyItem(h.threadId, makeAssistantTextItem({
      id: 'item_late_auto_compaction',
      threadId: h.threadId,
      turnId: h.turnId,
      text: 'this concurrent append must survive',
      status: 'completed'
    }))
    gate.release()
    await expect(running).resolves.toBe('completed')

    const sessionItems = await h.sessionStore.loadItems(h.threadId)
    for (const id of [...seedIds, 'item_late_auto_compaction']) {
      expect(sessionItems.filter((item) => item.id === id)).toHaveLength(1)
    }
    const summaries = sessionItems.filter((item) => item.kind === 'compaction')
    expect(summaries).toHaveLength(1)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const completed = events.filter((event) => event.kind === 'compaction_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.itemId).toBe(summaries[0]?.id)

    const threadItems = (await h.threadStore.get(h.threadId))?.turns.flatMap((turn) => turn.items) ?? []
    expect([...threadItems.map((item) => item.id)].sort()).toEqual(
      [...sessionItems.filter((item) => item.kind !== 'model_context').map((item) => item.id)].sort()
    )
    const sessionById = new Map(sessionItems.map((item) => [item.id, item]))
    for (const threadItem of threadItems) {
      expect(threadItem).toEqual(sessionById.get(threadItem.id))
    }
  })
})
