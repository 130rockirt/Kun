import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { makeAssistantTextItem, makeGoalContextItem, makeModelContextItem, makeUserItem } from '../domain/item.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'

const nowIso = () => '2026-08-06T00:00:00.000Z'

function createHarness() {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  return {
    threadStore,
    sessionStore,
    service: new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids: new SequentialIdGenerator(),
      nowIso
    })
  }
}

class FailFirstPlanForkCommitStore extends InMemoryThreadStore {
  private failPlanCommit = true

  override async upsert(...args: Parameters<InMemoryThreadStore['upsert']>) {
    if (args[0].planBuildRunId && this.failPlanCommit) {
      this.failPlanCommit = false
      throw new Error('injected plan fork commit failure')
    }
    return super.upsert(...args)
  }
}

async function seedGoalContextThread(
  harness: ReturnType<typeof createHarness>,
  options: { persistToSession?: boolean } = {}
) {
  const threadId = 'thr_source'
  const turnId = 'turn_source'
  const prompt = 'finish the task'
  const goalText = 'Active goal: finish the task'
  const user = makeUserItem({ id: 'item_user', threadId, turnId, text: prompt })
  const goalContext = makeGoalContextItem({
    id: 'item_goal_context',
    threadId,
    turnId,
    text: goalText,
    createdAt: '2026-08-06T00:00:01.000Z'
  })
  const assistant = makeAssistantTextItem({
    id: 'item_assistant',
    threadId,
    turnId,
    text: 'I will finish it.',
    status: 'completed',
    createdAt: '2026-08-06T00:00:02.000Z'
  })
  const turn = {
    ...createTurnRecord({ id: turnId, threadId, prompt, status: 'completed' }),
    // Simulate a pre-boundary FileThreadStore record. The canonical session
    // has always been authoritative, but older mirrors may have persisted an
    // internal item before the public projection was introduced.
    items: [user, goalContext, assistant]
  }
  await harness.threadStore.upsert({
    ...createThreadRecord({ id: threadId, title: 'Source', workspace: '/tmp', model: 'm' }),
    turns: [turn]
  })
  if (options.persistToSession !== false) {
    for (const item of [user, goalContext, assistant]) {
      await harness.sessionStore.appendItem(threadId, item)
    }
  }
  return { threadId, turnId, goalText, user, goalContext, assistant }
}

describe('ThreadService goal context persistence', () => {
  it('keeps private model context through fork and resume without exposing it in turns', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)
    const context = makeModelContextItem({
      id: 'item_model_context',
      threadId: source.threadId,
      turnId: source.turnId,
      stepIndex: 0,
      contentDigest: 'digest',
      blocks: [{
        key: 'persona:user:0', kind: 'persona', authority: 'user',
        state: 'active', digest: 'persona-digest'
      }],
      text: 'Persisted persona capsule',
      createdAt: '2026-08-06T00:00:01.500Z'
    })
    if (context.kind !== 'model_context') throw new Error('expected model context')
    await harness.sessionStore.appendItem(source.threadId, context)

    const fork = await harness.service.fork(source.threadId)
    const resumed = await harness.service.resumeSession(source.threadId)

    for (const target of [fork, resumed.thread]) {
      expect(target.turns[0]?.items.some((item) => item.kind === 'model_context')).toBe(false)
      expect(await harness.sessionStore.loadItems(target.id)).toContainEqual(expect.objectContaining({
        id: context.id,
        kind: 'model_context',
        threadId: target.id,
        text: context.text,
        blocks: context.blocks
      }))
    }
  })

  it('keeps canonical goal context ordered through fork and resume without exposing it in turns', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)

    const fork = await harness.service.fork(source.threadId)
    const resumed = await harness.service.resumeSession(source.threadId)

    for (const target of [fork, resumed.thread]) {
      expect(target.turns[0]?.items.map((item) => item.id)).toEqual([
        source.user.id,
        source.assistant.id
      ])
      expect(target.turns[0]?.items).not.toContainEqual(expect.objectContaining({ kind: 'goal_context' }))
      const targetItems = await harness.sessionStore.loadItems(target.id)
      expect(targetItems.map((item) => item.id)).toEqual([
        source.user.id,
        source.goalContext.id,
        source.assistant.id
      ])
      expect(targetItems[1]).toMatchObject({
        kind: 'goal_context',
        threadId: target.id,
        turnId: source.turnId,
        text: source.goalText
      })
    }

    const resumedSession = await harness.sessionStore.loadSession(resumed.thread.id)
    expect(resumedSession?.items.map((item) => item.id)).toEqual([
      source.user.id,
      source.goalContext.id,
      source.assistant.id
    ])
  })

  it('keeps goal context but not discarded in-flight output in a side fork', async () => {
    const harness = createHarness()
    const threadId = 'thr_side_source'
    const turnId = 'turn_side_source'
    const prompt = 'finish the task'
    const user = makeUserItem({ id: 'item_side_user', threadId, turnId, text: prompt })
    const goalContext = makeGoalContextItem({
      id: 'item_side_goal_context',
      threadId,
      turnId,
      text: 'Active goal: finish the task',
      createdAt: '2026-08-06T00:00:01.000Z'
    })
    const partialAssistant = makeAssistantTextItem({
      id: 'item_side_assistant',
      threadId,
      turnId,
      text: 'partial output',
      status: 'running',
      createdAt: '2026-08-06T00:00:02.000Z'
    })
    const sourceTurn = {
      ...createTurnRecord({ id: turnId, threadId, prompt, status: 'running' }),
      items: [user, partialAssistant]
    }
    await harness.threadStore.upsert({
      ...createThreadRecord({ id: threadId, title: 'Side source', workspace: '/tmp', model: 'm', status: 'running' }),
      turns: [sourceTurn]
    })
    for (const item of [user, goalContext, partialAssistant]) {
      await harness.sessionStore.appendItem(threadId, item)
    }

    const side = await harness.service.fork(threadId, { relation: 'side' })
    const sideItems = await harness.sessionStore.loadItems(side.id)

    expect(side.turns[0]).toMatchObject({ status: 'aborted' })
    expect(side.turns[0]?.items.map((item) => item.id)).toEqual([user.id])
    expect(sideItems.map((item) => item.id)).toEqual([user.id, goalContext.id])
    expect(sideItems).not.toContainEqual(expect.objectContaining({ id: partialAssistant.id }))
  })

  it('binds an isolated plan side fork to its authorized workspace and run id', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)
    const sourceRecord = await harness.threadStore.get(source.threadId)
    if (!sourceRecord) throw new Error('expected source thread')
    await harness.threadStore.upsert({
      ...sourceRecord,
      additionalWorkspaces: ['/tmp/source-shared'],
      costBudgetUsd: 12
    })

    const fork = await harness.service.fork(source.threadId, {
      relation: 'side',
      workspace: '/tmp/isolated-plan-worktree',
      planBuildRunId: 'run-plan-1',
      planBuildAgentSurface: 'code'
    })

    expect(fork).toMatchObject({
      relation: 'side',
      parentThreadId: source.threadId,
      workspace: '/tmp/isolated-plan-worktree',
      additionalWorkspaces: [],
      planBuildRunId: 'run-plan-1',
      approvalReviewer: 'user',
      costBudgetUsd: 12
    })

    const ordinaryFork = await harness.service.fork(source.threadId)
    expect(ordinaryFork.additionalWorkspaces).toEqual(['/tmp/source-shared'])
  })

  it('forks a Code plan executor from Design history without sharing document ownership', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)
    const sourceRecord = await harness.threadStore.get(source.threadId)
    if (!sourceRecord) throw new Error('expected source thread')
    const designProfile = {
      version: 1 as const,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_source' },
      outputMedium: 'html' as const,
      target: 'web' as const,
      preset: 'ios' as const,
      context: { tone: [] },
      lockedAtTurnId: source.turnId
    }
    await harness.threadStore.upsert({
      ...sourceRecord,
      agentSurface: 'design',
      designProfile,
      turns: sourceRecord.turns.map((turn) => ({
        ...turn,
        designProfile,
        designDocumentTarget: designProfile.documentTarget
      }))
    })

    const fork = await harness.service.fork(source.threadId, {
      relation: 'side',
      workspace: '/tmp/code-plan-from-design-history',
      planBuildRunId: 'run-code-from-design',
      planBuildAgentSurface: 'code'
    })

    expect(fork.agentSurface).toBe('code')
    expect(fork.designProfile).toBeUndefined()
    expect(fork.turns[0]?.designProfile).toEqual(designProfile)
    expect(fork.workspace).toBe('/tmp/code-plan-from-design-history')
  })

  it('returns the committed plan fork for concurrent and response-loss retries', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)
    const request = {
      relation: 'side' as const,
      workspace: '/tmp/isolated-plan-worktree',
      planBuildRunId: 'run-plan-response-loss',
      planBuildAgentSurface: 'code' as const
    }

    const [first, concurrentRetry] = await Promise.all([
      harness.service.fork(source.threadId, request),
      harness.service.fork(source.threadId, request)
    ])
    // Simulate a committed response that the client never observed.
    const operationRetry = await harness.service.fork(source.threadId, request)

    expect(concurrentRetry.id).toBe(first.id)
    expect(operationRetry.id).toBe(first.id)
    expect(operationRetry).toEqual(first)
    const matching = (await harness.threadStore.list({ includeSide: true }))
      .filter((thread) => thread.planBuildRunId === request.planBuildRunId)
    expect(matching).toHaveLength(1)
  })

  it('deduplicates cloned history when retrying after a pre-commit crash', async () => {
    const threadStore = new FailFirstPlanForkCommitStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const harness = {
      threadStore,
      sessionStore,
      service: new ThreadService({
        threadStore, sessionStore, events,
        ids: new SequentialIdGenerator(), nowIso
      })
    }
    const source = await seedGoalContextThread(harness)
    const request = {
      relation: 'side' as const,
      workspace: '/tmp/precommit-retry',
      planBuildRunId: 'run-plan-precommit',
      planBuildAgentSurface: 'code' as const
    }

    await expect(harness.service.fork(source.threadId, request))
      .rejects.toThrow('injected plan fork commit failure')
    const retry = await harness.service.fork(source.threadId, request)

    const clonedItems = await sessionStore.loadItems(retry.id)
    expect(clonedItems.map((item) => item.id)).toEqual([
      source.user.id, source.goalContext.id, source.assistant.id
    ])
  })

  it('rejects reuse of a committed plan run id for another source or workspace', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness)
    await harness.threadStore.upsert(createThreadRecord({
      id: 'thr_other_source',
      title: 'Other source',
      workspace: '/tmp',
      model: 'm'
    }))
    await harness.service.fork(source.threadId, {
      relation: 'side',
      workspace: '/tmp/isolated-plan-worktree',
      planBuildRunId: 'run-plan-immutable',
      planBuildAgentSurface: 'code'
    })

    await expect(harness.service.fork(source.threadId, {
      relation: 'side',
      workspace: '/tmp/another-worktree',
      planBuildRunId: 'run-plan-immutable',
      planBuildAgentSurface: 'code'
    })).rejects.toThrow('different source or workspace')
    await expect(harness.service.fork('thr_other_source', {
      relation: 'side',
      workspace: '/tmp/isolated-plan-worktree',
      planBuildRunId: 'run-plan-immutable',
      planBuildAgentSurface: 'code'
    })).rejects.toThrow('different source or workspace')
  })

  it('recovers a legacy raw mirror into canonical fork and resume history without exposing the context', async () => {
    const harness = createHarness()
    const source = await seedGoalContextThread(harness, { persistToSession: false })

    const fork = await harness.service.fork(source.threadId)
    const resumed = await harness.service.resumeSession(source.threadId)

    for (const target of [fork, resumed.thread]) {
      expect(target.turns[0]?.items.map((item) => item.id)).toEqual([
        source.user.id,
        source.assistant.id
      ])
      expect(target.turns[0]?.items).not.toContainEqual(expect.objectContaining({ kind: 'goal_context' }))
      expect((await harness.sessionStore.loadItems(target.id)).map((item) => item.id)).toEqual([
        source.user.id,
        source.goalContext.id,
        source.assistant.id
      ])
    }
  })
})
