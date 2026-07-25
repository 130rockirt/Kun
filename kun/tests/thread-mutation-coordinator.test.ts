import { describe, expect, it } from 'vitest'
import { bootstrapThread, makeFakeModel, makeHarness, makeSilentModel, type Harness } from './loop-test-harness.js'

type ThreadReadBlock = {
  entered: Promise<void>
  release: () => void
}

function blockThreadRead(harness: Harness, blockAt: number): ThreadReadBlock {
  const originalGet = harness.threadStore.get.bind(harness.threadStore)
  let reads = 0
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })

  harness.threadStore.get = async (threadId: string) => {
    const snapshot = structuredClone(await originalGet(threadId))
    reads += 1
    if (reads === blockAt) {
      entered()
      await releasePromise
    }
    return snapshot
  }

  return { entered: enteredPromise, release }
}

async function flushCompetingMutation(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('shared thread mutation coordination', () => {
  it('preserves a thread update and a concurrently-started turn', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    await h.turns.finishTurn({ threadId: h.threadId, turnId: h.turnId, status: 'completed' })
    const block = blockThreadRead(h, 1)

    const update = h.threads.update(h.threadId, {
      title: 'User-selected title',
      titleAuto: false
    })
    await block.entered

    let startSettled = false
    const started = h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'second request' }
    }).finally(() => {
      startSettled = true
    })
    await flushCompetingMutation()
    const startWaitedForUpdate = startSettled
    block.release()

    const [, turn] = await Promise.all([update, started])
    expect(startWaitedForUpdate).toBe(false)
    const thread = await h.threadStore.get(h.threadId)
    expect(thread).toMatchObject({ title: 'User-selected title', titleAuto: false, status: 'running' })
    expect(thread?.turns).toHaveLength(2)
    expect(thread?.turns.at(-1)?.id).toBe(turn.turnId)

    await h.turns.interruptTurn({ threadId: h.threadId, turnId: turn.turnId })
  })

  it('preserves goal usage when a competing turn finish updates the same record', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    await h.threads.setGoal(h.threadId, { objective: 'Finish the task', tokenBudget: 100 })
    const block = blockThreadRead(h, 1)
    const loop = h.loop as unknown as {
      recordGoalUsage(threadId: string, tokenDelta: number): Promise<void>
    }

    const usage = loop.recordGoalUsage(h.threadId, 7)
    await block.entered

    let finishSettled = false
    const finish = h.turns.finishTurn({
      threadId: h.threadId,
      turnId: h.turnId,
      status: 'completed'
    }).finally(() => {
      finishSettled = true
    })
    await flushCompetingMutation()
    const finishWaitedForUsage = finishSettled
    block.release()

    await Promise.all([usage, finish])
    expect(finishWaitedForUsage).toBe(false)
    const thread = await h.threadStore.get(h.threadId)
    expect(thread).toMatchObject({ status: 'idle', goal: { tokensUsed: 7 } })
    expect(thread?.turns[0]).toMatchObject({ id: h.turnId, status: 'completed' })
  })

  it('preserves a delayed generated title while the first turn finishes concurrently', async () => {
    // Title generation now runs in parallel with the first turn (before any
    // completed turn). Race the title mutation against finishTurn.
    const h = makeHarness(makeFakeModel([
      { kind: 'assistant_text_delta', text: 'Generated task title' },
      { kind: 'completed', stopReason: 'stop' }
    ]))
    await bootstrapThread(h)
    await h.threads.update(h.threadId, { title: 'New chat', titleAuto: true })
    const block = blockThreadRead(h, 2)
    const loop = h.loop as unknown as {
      maybeGenerateThreadTitle(threadId: string, turnId: string): Promise<void>
    }

    const title = loop.maybeGenerateThreadTitle(h.threadId, h.turnId)
    await block.entered

    let finishSettled = false
    const finish = h.turns.finishTurn({
      threadId: h.threadId,
      turnId: h.turnId,
      status: 'completed'
    }).finally(() => {
      finishSettled = true
    })
    await flushCompetingMutation()
    const finishWaitedForTitle = finishSettled
    block.release()

    await Promise.all([title, finish])
    expect(finishWaitedForTitle).toBe(false)
    const thread = await h.threadStore.get(h.threadId)
    expect(thread).toMatchObject({ title: 'Generated task title', titleAuto: true, status: 'idle' })
    expect(thread?.turns[0]).toMatchObject({ id: h.turnId, status: 'completed' })
  })
})
