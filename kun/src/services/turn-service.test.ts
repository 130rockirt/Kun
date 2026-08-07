import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { makeAssistantTextItem, makeUserItem } from '../domain/item.js'
import { createThreadRecord } from '../domain/thread.js'
import { appendTurnItem, createTurnRecord, finishTurn } from '../domain/turn.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { COMPACTION_SYSTEM_PROMPT } from '../loop/compaction-summary.js'
import { effectiveHistoryAfterLatestCompaction } from '../loop/compaction-history.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import type { TurnItem } from '../contracts/items.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { GraphPlanningLifecycle } from '../contracts/turns.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import {
  DEFAULT_MAX_CONCURRENT_TURNS,
  TurnCapacityError,
  TurnConflictError,
  TurnService
} from './turn-service.js'
import { ThreadService } from './thread-service.js'
import { UsageService } from './usage-service.js'
import { FileAttachmentStore } from '../attachments/attachment-store.js'
import { KunCapabilitiesConfig } from '../contracts/capabilities.js'

function testPng(): Buffer {
  const buffer = Buffer.alloc(24)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer.writeUInt32BE(1, 16)
  buffer.writeUInt32BE(1, 20)
  return buffer
}

class SummaryModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'summary-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield {
      kind: 'assistant_text_delta',
      text: [
        '## Goal',
        '- Continue the compacted task.',
        '## Completed',
        '- MODEL SUMMARY kept the durable state.'
      ].join('\n')
    }
    yield {
      kind: 'usage',
      usage: {
        ...emptyUsageSnapshot(),
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
        turns: 1
      }
    }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class BlockingSummaryModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'blocking-summary-model'
  readonly requests: ModelRequest[] = []
  readonly summaryStarted: Promise<void>
  private readonly releaseSummary: Promise<void>
  private resolveStarted!: () => void
  private resolveRelease!: () => void

  constructor() {
    this.summaryStarted = new Promise<void>((resolve) => {
      this.resolveStarted = resolve
    })
    this.releaseSummary = new Promise<void>((resolve) => {
      this.resolveRelease = resolve
    })
  }

  release(): void {
    this.resolveRelease()
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    this.resolveStarted()
    await this.releaseSummary
    yield { kind: 'assistant_text_delta', text: 'Summary from the first snapshot.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class FailOnceAppendSessionStore extends InMemorySessionStore {
  private failNextAppend = true

  override async appendItem(threadId: string, item: TurnItem): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false
      throw new Error('append item failed')
    }
    await super.appendItem(threadId, item)
  }
}

class BlockingGoalContextSessionStore extends InMemorySessionStore {
  readonly loadItemsStarted: Promise<void>
  private resolveLoadItemsStarted!: () => void
  private resolveLoadItems!: () => void
  private readonly releaseLoadItems: Promise<void>
  private blockNextLoadItems = false

  constructor() {
    super()
    this.loadItemsStarted = new Promise<void>((resolve) => {
      this.resolveLoadItemsStarted = resolve
    })
    this.releaseLoadItems = new Promise<void>((resolve) => {
      this.resolveLoadItems = resolve
    })
  }

  blockNextLoad(): void {
    this.blockNextLoadItems = true
  }

  release(): void {
    this.resolveLoadItems()
  }

  override async loadItems(threadId: string): Promise<TurnItem[]> {
    if (this.blockNextLoadItems) {
      this.blockNextLoadItems = false
      this.resolveLoadItemsStarted()
      await this.releaseLoadItems
    }
    return super.loadItems(threadId)
  }
}

class BlockingDeltaEventSessionStore extends InMemorySessionStore {
  readonly order: string[] = []
  readonly eventAppendStarted: Promise<void>
  private releaseEventAppend!: () => void
  private markEventAppendStarted!: () => void
  private readonly eventAppendRelease: Promise<void>

  constructor() {
    super()
    this.eventAppendStarted = new Promise<void>((resolve) => {
      this.markEventAppendStarted = resolve
    })
    this.eventAppendRelease = new Promise<void>((resolve) => {
      this.releaseEventAppend = resolve
    })
  }

  releaseEvent(): void {
    this.releaseEventAppend()
  }

  override async appendItem(threadId: string, item: TurnItem): Promise<void> {
    this.order.push('item')
    await super.appendItem(threadId, item)
  }

  override async appendEvent(threadId: string, event: RuntimeEvent): Promise<void> {
    this.order.push('event-start')
    this.markEventAppendStarted()
    await this.eventAppendRelease
    await super.appendEvent(threadId, event)
    this.order.push('event-commit')
  }
}

class MetadataCountingThreadStore extends InMemoryThreadStore {
  readonly hydratedGets: string[] = []
  readonly metadataGets: string[] = []
  readonly touches: string[] = []

  override async get(threadId: string) {
    this.hydratedGets.push(threadId)
    return super.get(threadId)
  }

  async getMetadata(threadId: string) {
    this.metadataGets.push(threadId)
    return super.get(threadId)
  }

  async touch(threadId: string, _updatedAt: string): Promise<boolean> {
    this.touches.push(threadId)
    return Boolean(await super.get(threadId))
  }
}

describe('TurnService assistant delta persistence (#1087)', () => {
  it('persists the cumulative item before committing its offset-addressed replay event', async () => {
    const sessionStore = new BlockingDeltaEventSessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso: () => '2026-08-05T00:00:01.000Z'
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso: () => '2026-08-05T00:00:01.000Z'
    })
    const item = makeAssistantTextItem({
      id: 'item_stream',
      threadId: 'thr_stream',
      turnId: 'turn_stream',
      text: 'prefix',
      status: 'running',
      createdAt: '2026-08-05T00:00:00.000Z'
    })

    const recording = service.applyAssistantDelta('thr_stream', item, 'prefix', 0)
    await sessionStore.eventAppendStarted

    expect(sessionStore.order).toEqual(['item', 'event-start'])
    expect(await sessionStore.loadItems('thr_stream')).toEqual([item])
    expect(await sessionStore.highestSeq('thr_stream')).toBe(0)

    sessionStore.releaseEvent()
    await recording

    expect(sessionStore.order).toEqual(['item', 'event-start', 'event-commit'])
    expect(await sessionStore.loadEventsSince('thr_stream', 0)).toEqual([
      expect.objectContaining({
        kind: 'assistant_text_delta',
        seq: 1,
        deltaOffset: 0,
        item: expect.objectContaining({ id: item.id, text: 'prefix' })
      })
    ])
  })
})

describe('TurnService startTurn', () => {
  it('defaults to 256 concurrent active turns', () => {
    expect(DEFAULT_MAX_CONCURRENT_TURNS).toBe(256)
  })

  it('persists one stable goal context in canonical history without publishing it', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-06T00:00:00.000Z'
    const service = new TurnService({
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
    const threadId = 'thr_goal_context'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Goal context',
      workspace: '/tmp/workspace',
      model: 'test-model',
      goal: {
        threadId,
        objective: 'Keep the durable goal context stable.',
        status: 'active',
        tokenBudget: 500,
        tokensUsed: 17,
        timeUsedSeconds: 3,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    }))

    const started = await service.startTurn({
      threadId,
      request: { prompt: 'Make progress.', model: 'test-model' }
    })
    await Promise.all([
      service.ensureGoalContext(threadId, started.turnId),
      service.ensureGoalContext(threadId, started.turnId)
    ])

    const items = await sessionStore.loadItems(threadId)
    expect(items.map((item) => item.kind)).toEqual(['user_message', 'goal_context'])
    const goalContext = items[1]
    expect(goalContext).toMatchObject({
      id: expect.stringMatching(new RegExp(`^item_${started.turnId}_goal_context_goal_`)),
      kind: 'goal_context',
      goalKey: expect.stringMatching(/^goal_/),
      text: expect.stringContaining('Keep the durable goal context stable.')
    })
    if (!goalContext || goalContext.kind !== 'goal_context') {
      throw new Error('expected internal goal context')
    }
    expect(goalContext.text).not.toContain('Tokens used')
    expect(goalContext.text).not.toContain('Tokens remaining')

    const thread = await threadStore.get(threadId)
    expect(thread?.turns[0]?.items.map((item) => item.kind)).toEqual(['user_message'])
    expect(JSON.stringify(await sessionStore.loadEventsSince(threadId, 0))).not.toContain('"kind":"goal_context"')

    await threadStore.upsert({
      ...thread!,
      goal: {
        ...thread!.goal!,
        tokensUsed: 499,
        timeUsedSeconds: 400,
        updatedAt: '2026-08-06T00:10:00.000Z'
      }
    })
    await service.ensureGoalContext(threadId, started.turnId)
    expect(await sessionStore.loadItems(threadId)).toEqual(items)

    await service.finishTurn({ threadId, turnId: started.turnId, status: 'completed' })
    const second = await service.startTurn({
      threadId,
      request: { prompt: 'Continue in a later turn.', model: 'test-model' }
    })
    await service.ensureGoalContext(threadId, second.turnId)
    expect((await sessionStore.loadItems(threadId)).filter((item) => item.kind === 'goal_context'))
      .toEqual([goalContext])

    const latest = await threadStore.get(threadId)
    await threadStore.upsert({
      ...latest!,
      goal: {
        ...latest!.goal!,
        objective: 'Work on the replacement goal generation.',
        updatedAt: '2026-08-06T00:20:00.000Z'
      }
    })
    await Promise.all([
      service.ensureGoalContext(threadId, second.turnId),
      service.ensureGoalContext(threadId, second.turnId)
    ])
    const goalContexts = (await sessionStore.loadItems(threadId))
      .filter((item): item is Extract<TurnItem, { kind: 'goal_context' }> => item.kind === 'goal_context')
    expect(goalContexts).toHaveLength(2)
    expect(goalContexts.map((item) => item.goalKey)).toEqual([
      goalContext.goalKey,
      expect.stringMatching(/^goal_/)
    ])
    expect(goalContexts[1]?.goalKey).not.toBe(goalContext.goalKey)

    await service.interruptTurn({ threadId, turnId: second.turnId })
  })

  it('does not append goal context after an interrupt or discard has won the turn mutation', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-06T00:00:00.000Z'
    const service = new TurnService({
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
    const threadId = 'thr_goal_context_interrupted'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Interrupted goal context',
      workspace: '/tmp/workspace',
      model: 'test-model',
      goal: {
        threadId,
        objective: 'This goal must not survive a discarded turn context write.',
        status: 'active',
        tokenBudget: 100,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    }))
    const started = await service.startTurn({
      threadId,
      request: { prompt: 'Start then discard.', model: 'test-model' }
    })

    await service.interruptTurn({ threadId, turnId: started.turnId, discard: true })
    await service.ensureGoalContext(threadId, started.turnId)

    expect((await sessionStore.loadItems(threadId)).some((item) => item.kind === 'goal_context'))
      .toBe(false)
    expect((await threadStore.get(threadId))?.turns[0]?.status).toBe('aborted')
  })

  it('does not append goal context when an execution signal aborts while history is loading', async () => {
    const sessionStore = new BlockingGoalContextSessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-06T00:00:00.000Z'
    const service = new TurnService({
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
    const threadId = 'thr_goal_context_signal_abort'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Signal-aborted goal context',
      workspace: '/tmp/workspace',
      model: 'test-model',
      goal: {
        threadId,
        objective: 'Never append after an execution lease is lost.',
        status: 'active',
        tokenBudget: 100,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    }))
    const started = await service.startTurn({
      threadId,
      request: { prompt: 'Start then lose the execution lease.', model: 'test-model' }
    })
    const controller = new AbortController()
    sessionStore.blockNextLoad()
    const pending = service.ensureGoalContext(threadId, started.turnId, controller.signal)
    await sessionStore.loadItemsStarted
    controller.abort()
    sessionStore.release()
    await pending

    expect((await sessionStore.loadItems(threadId)).some((item) => item.kind === 'goal_context')).toBe(false)
    expect((await threadStore.get(threadId))?.turns[0]?.status).toBe('running')
  })

  it('claims an empty legacy thread on its first surfaced turn without reclassifying existing history', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-01T00:00:00.000Z'
    const service = new TurnService({
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

    const empty = createThreadRecord({
      id: 'thr_empty_legacy',
      title: 'Empty legacy',
      workspace: '/tmp/workspace',
      model: 'test-model'
    })
    await threadStore.upsert(empty)
    const designTurn = await service.startTurn({
      threadId: empty.id,
      request: { prompt: 'draw a page', model: 'test-model', agentSurface: 'design' }
    })
    expect((await threadStore.get(empty.id))?.agentSurface).toBe('design')
    await service.interruptTurn({ threadId: empty.id, turnId: designTurn.turnId })

    const existing = createThreadRecord({
      id: 'thr_existing_legacy',
      title: 'Existing legacy',
      workspace: '/tmp/workspace',
      model: 'test-model'
    })
    await threadStore.upsert({
      ...existing,
      turns: [finishTurn(createTurnRecord({
        id: 'turn_existing',
        threadId: existing.id,
        prompt: 'prior Code turn',
        model: existing.model
      }), 'completed', nowIso())]
    })
    const laterDesignTurn = await service.startTurn({
      threadId: existing.id,
      request: { prompt: 'misdirected design request', model: 'test-model', agentSurface: 'design' }
    })
    expect((await threadStore.get(existing.id))?.agentSurface).toBeUndefined()
    expect((await threadStore.list()).find((thread) => thread.id === existing.id)?.agentSurface).toBe('code')
    await service.interruptTurn({ threadId: existing.id, turnId: laterDesignTurn.turnId })
  })

  it('binds submitted attachments to the final thread before persisting the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-turn-attachment-'))
    try {
      const sessionStore = new InMemorySessionStore()
      const threadStore = new InMemoryThreadStore()
      const eventBus = new InMemoryEventBus()
      const nowIso = () => '2026-07-24T00:00:00.000Z'
      const attachmentStore = new FileAttachmentStore({
        rootDir: join(root, 'attachments'),
        config: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }).attachments,
        nowIso
      })
      const service = new TurnService({
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
        attachmentStore: () => attachmentStore,
        ids: new SequentialIdGenerator(),
        nowIso
      })
      const threadId = 'thr_attachment_final'
      await threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Attachment turn',
        workspace: '/tmp/workspace',
        model: 'deepseek-v4-pro'
      }))
      const attachment = await attachmentStore.create({
        name: 'draft.png',
        data: testPng(),
        workspace: '/tmp/workspace'
      })

      const started = await service.startTurn({
        threadId,
        request: { prompt: 'inspect', model: 'm', attachmentIds: [attachment.id, attachment.id] }
      })

      await expect(attachmentStore.resolveContent(attachment.id, { threadId })).resolves.toMatchObject({
        id: attachment.id
      })
      expect((await threadStore.get(threadId))?.turns[0]?.attachmentIds).toEqual([attachment.id])
      expect((await sessionStore.loadItems(threadId))[0]).toMatchObject({
        attachmentIds: [attachment.id]
      })
      await service.interruptTurn({ threadId, turnId: started.turnId })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not persist a turn when a submitted attachment is missing', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-24T00:00:00.000Z'
    const bindScopes = async (): Promise<never> => {
      throw new Error('attachment not found: att_000000000000000000000000')
    }
    const service = new TurnService({
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
      attachmentStore: () => ({ bindScopes } as never),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_attachment_missing'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Missing attachment',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))

    await expect(service.startTurn({
      threadId,
      request: {
        prompt: 'inspect',
        model: 'm',
        attachmentIds: ['att_000000000000000000000000']
      }
    })).rejects.toThrow(/attachment not found/)

    expect((await threadStore.get(threadId))?.turns).toEqual([])
    expect(await sessionStore.loadItems(threadId)).toEqual([])
  })

  it('does not bind any attachment when batch validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-turn-attachment-batch-'))
    try {
      const sessionStore = new InMemorySessionStore()
      const threadStore = new InMemoryThreadStore()
      const eventBus = new InMemoryEventBus()
      const nowIso = () => '2026-07-24T00:00:00.000Z'
      const attachmentStore = new FileAttachmentStore({
        rootDir: join(root, 'attachments'),
        config: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }).attachments,
        nowIso
      })
      const service = new TurnService({
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
        attachmentStore: () => attachmentStore,
        ids: new SequentialIdGenerator(),
        nowIso
      })
      const threadId = 'thr_attachment_batch_failure'
      await threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Attachment batch failure',
        workspace: '/tmp/workspace',
        model: 'deepseek-v4-pro'
      }))
      const valid = await attachmentStore.create({
        name: 'valid.png',
        data: testPng(),
        workspace: '/tmp/workspace'
      })

      await expect(service.startTurn({
        threadId,
        request: {
          prompt: 'inspect',
          model: 'm',
          attachmentIds: [valid.id, 'att_000000000000000000000000']
        }
      })).rejects.toThrow(/attachment not found/)

      expect(await attachmentStore.get(valid.id)).toMatchObject({ threadIds: [] })
      expect((await threadStore.get(threadId))?.turns).toEqual([])
      expect(await sessionStore.loadItems(threadId)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves every thread scope when turns bind the same attachment concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-turn-attachment-concurrent-'))
    try {
      const sessionStore = new InMemorySessionStore()
      const threadStore = new InMemoryThreadStore()
      const eventBus = new InMemoryEventBus()
      const nowIso = () => '2026-07-24T00:00:00.000Z'
      const attachmentStore = new FileAttachmentStore({
        rootDir: join(root, 'attachments'),
        config: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }).attachments,
        nowIso
      })
      const service = new TurnService({
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
        attachmentStore: () => attachmentStore,
        ids: new SequentialIdGenerator(),
        nowIso
      })
      const threadIds = ['thr_attachment_concurrent_a', 'thr_attachment_concurrent_b']
      for (const threadId of threadIds) {
        await threadStore.upsert(createThreadRecord({
          id: threadId,
          title: threadId,
          workspace: '/tmp/shared-workspace',
          model: 'deepseek-v4-pro'
        }))
      }
      const attachment = await attachmentStore.create({
        name: 'shared.png',
        data: testPng(),
        workspace: '/tmp/shared-workspace'
      })

      const starts = await Promise.all(threadIds.map((threadId) => service.startTurn({
        threadId,
        request: { prompt: 'inspect', model: 'm', attachmentIds: [attachment.id] }
      })))

      expect((await attachmentStore.get(attachment.id))?.threadIds.sort()).toEqual([...threadIds].sort())
      await Promise.all(starts.map((started, index) =>
        service.interruptTurn({ threadId: threadIds[index], turnId: started.turnId })
      ))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically admits only one active turn for a thread', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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
    const threadId = 'thr_single_active_turn'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Single active turn',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    }))

    const [first, second] = await Promise.allSettled([
      service.startTurn({
        threadId,
        request: {
          prompt: 'first', model: 'm', providerId: 'provider-a', accountId: 'account-a',
          reasoningEffort: 'high', serviceTier: 'priority', mode: 'plan', clientSurface: 'tui'
        }
      }),
      service.startTurn({ threadId, request: { prompt: 'second', model: 'm' } })
    ])

    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: expect.any(TurnConflictError) })
    const thread = await threadStore.get(threadId)
    expect(thread?.turns).toHaveLength(1)
    expect(thread?.turns[0]?.status).toBe('running')
    expect(thread?.turns[0]).toMatchObject({
      serviceTier: 'priority',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    })
    const liveTurnStarted = eventBus.snapshotSince(threadId, 0)
      .find((event) => event.kind === 'turn_started')
    expect(liveTurnStarted).toMatchObject({
      kind: 'turn_started', model: 'm', providerId: 'provider-a', accountId: 'account-a',
      reasoningEffort: 'high', serviceTier: 'priority', mode: 'plan', clientSurface: 'tui',
      approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalReviewer: 'agent'
    })
    const replayedTurnStarted = (await sessionStore.loadEventsSince(threadId, 0))
      .find((event) => event.kind === 'turn_started')
    expect(replayedTurnStarted).toMatchObject({
      kind: 'turn_started',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent'
    })
    expect(thread?.turns[0]?.clientSurface).toBe('tui')
    await service.updateTurnMetadata(threadId, thread!.turns[0]!.id, {
      actingModelRoute: {
        model: 'input-model',
        providerId: 'provider-a',
        accountId: 'account-a'
      }
    })
    await service.updateTurnMetadata(threadId, thread!.turns[0]!.id, {
      actingModelRoute: {
        model: 'changed-later',
        providerId: 'provider-b',
        accountId: 'account-b'
      }
    })
    expect((await threadStore.get(threadId))?.turns[0]?.actingModelRoute).toEqual({
      model: 'input-model',
      providerId: 'provider-a',
      accountId: 'account-a'
    })
    expect(await service.interruptActiveTurns()).toBe(1)
    expect((await threadStore.get(threadId))?.turns[0]?.status).toBe('aborted')
  })

  it('rejects an archived thread before creating a turn or consuming runtime capacity', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      maxConcurrentTurns: 1,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_archived_start'
    const admittedThreadId = 'thr_archived_start_capacity'
    await Promise.all([threadId, admittedThreadId].map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id === threadId ? 'Archived thread' : 'Capacity check',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro',
      ...(id === threadId ? { status: 'archived' as const } : {})
    }))))

    await expect(service.startTurn({
      threadId,
      request: { prompt: 'must not run', model: 'm' }
    })).rejects.toBeInstanceOf(TurnConflictError)

    expect((await threadStore.get(threadId))?.turns).toEqual([])
    expect(await sessionStore.loadItems(threadId)).toEqual([])
    expect(await sessionStore.loadEventsSince(threadId, 0)).toEqual([])
    const admitted = await service.startTurn({
      threadId: admittedThreadId,
      request: { prompt: 'capacity was not consumed', model: 'm' }
    })
    await service.interruptTurn({ threadId: admittedThreadId, turnId: admitted.turnId })
  })

  it('keeps archival as an overlay when active turns finish or are interrupted', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const ids = new SequentialIdGenerator()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const threads = new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids,
      nowIso
    })
    const finishedThreadId = 'thr_archived_finish'
    const interruptedThreadId = 'thr_archived_interrupt'
    await Promise.all([finishedThreadId, interruptedThreadId].map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id,
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))))

    const finishing = await turns.startTurn({
      threadId: finishedThreadId,
      request: { prompt: 'finish after archival', model: 'm' }
    })
    await threads.update(finishedThreadId, { status: 'archived' })
    await turns.finishTurn({
      threadId: finishedThreadId,
      turnId: finishing.turnId,
      status: 'completed'
    })

    const finished = await threadStore.get(finishedThreadId)
    expect(finished?.status).toBe('archived')
    expect(finished?.turns.find((turn) => turn.id === finishing.turnId)?.status).toBe('completed')
    await expect(turns.startTurn({
      threadId: finishedThreadId,
      request: { prompt: 'still archived', model: 'm' }
    })).rejects.toBeInstanceOf(TurnConflictError)

    const interrupting = await turns.startTurn({
      threadId: interruptedThreadId,
      request: { prompt: 'interrupt after archival', model: 'm' }
    })
    await threads.update(interruptedThreadId, { status: 'archived' })
    await turns.interruptTurn({
      threadId: interruptedThreadId,
      turnId: interrupting.turnId
    })

    const interrupted = await threadStore.get(interruptedThreadId)
    expect(interrupted?.status).toBe('archived')
    expect(interrupted?.turns.find((turn) => turn.id === interrupting.turnId)?.status).toBe('aborted')
  })

  it('caps active turns across threads before persistence and releases slots when they settle', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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
    const threadIds = ['thr_capacity_a', 'thr_capacity_b', 'thr_capacity_c']
    await Promise.all(threadIds.map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id,
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))))

    const first = await service.startTurn({
      threadId: 'thr_capacity_a',
      request: { prompt: 'first', model: 'm' }
    })
    await expect(service.startTurn({
      threadId: 'thr_capacity_b',
      request: { prompt: 'rejected', model: 'm' }
    })).rejects.toBeInstanceOf(TurnCapacityError)

    // The rejected request must be invisible to both the durable turn history
    // and SSE replay, not merely left queued for a later scheduler pass.
    expect((await threadStore.get('thr_capacity_b'))?.turns).toEqual([])
    expect(await sessionStore.loadItems('thr_capacity_b')).toEqual([])
    expect(await sessionStore.loadEventsSince('thr_capacity_b', 0)).toEqual([])

    await service.finishTurn({
      threadId: 'thr_capacity_a',
      turnId: first.turnId,
      status: 'completed'
    })
    const second = await service.startTurn({
      threadId: 'thr_capacity_b',
      request: { prompt: 'admitted after completion', model: 'm' }
    })
    await service.interruptTurn({ threadId: 'thr_capacity_b', turnId: second.turnId })
    const third = await service.startTurn({
      threadId: 'thr_capacity_c',
      request: { prompt: 'admitted after interrupt', model: 'm' }
    })

    expect(third.threadId).toBe('thr_capacity_c')
    await service.interruptTurn({ threadId: 'thr_capacity_c', turnId: third.turnId })
  })

  it('suspends and resumes one durable Graph Lead turn without holding runtime capacity', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const nowIso = () => '2026-07-28T12:00:00.000Z'
    let graphLastEventSeq = 7
    let supervisionPending = false
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight,
      steering,
      compactor: new ContextCompactor(),
      maxConcurrentTurns: 1,
      resolveGraphLeadRun: async ({ turnId }) => turnId === 'turn_1'
        ? {
            runId: 'run_1',
            lastEventSeq: graphLastEventSeq,
            terminal: false,
            supervisionPending
          }
        : null,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    for (const id of ['thr_graph_lead', 'thr_other']) {
      await threadStore.upsert(createThreadRecord({
        id,
        title: id,
        workspace: '/tmp/workspace',
        model: 'deepseek-v4-pro'
      }))
    }

    const source = await service.startTurn({
      threadId: 'thr_graph_lead',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })
    expect(source.turnId).toBe('turn_1')
    expect(await service.graphRunOwnsLeadLimits({
      threadId: 'thr_graph_lead',
      turnId: source.turnId
    })).toBe(true)
    expect(await service.suspendGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId
    })).toBe('suspended')
    expect(service.isTurnExecutionActive(source.turnId)).toBe(false)
    expect(inflight.has(source.turnId)).toBe(false)
    expect(await service.getTurn('thr_graph_lead', source.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId: 'run_1',
        state: 'supervising',
        lastDeliveredSeq: 0
      }
    })

    const other = await service.startTurn({
      threadId: 'thr_other',
      request: { prompt: 'uses released capacity' }
    })
    await expect(service.resumeGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId,
      runId: 'run_1',
      lastDeliveredSeq: 8,
      terminal: false
    })).rejects.toBeInstanceOf(TurnCapacityError)
    await service.interruptTurn({ threadId: 'thr_other', turnId: other.turnId })

    await expect(service.resumeGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId,
      runId: 'run_1',
      lastDeliveredSeq: 8,
      terminal: false
    })).resolves.toBe('resumed')
    expect(service.isTurnExecutionActive(source.turnId)).toBe(true)
    graphLastEventSeq = 9
    supervisionPending = true
    await expect(service.suspendGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId
    })).resolves.toBe('supervision_pending')
    expect(service.isTurnExecutionActive(source.turnId)).toBe(true)
    await expect(service.suspendGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId,
      force: true,
      preserveDeliveryCursor: true,
      allowPendingSupervision: true
    })).resolves.toBe('suspended_pending_supervision')
    expect(service.isTurnExecutionActive(source.turnId)).toBe(false)
    expect(await service.getTurn('thr_graph_lead', source.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId: 'run_1',
        lastDeliveredSeq: 8
      }
    })
    await expect(service.resumeGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId,
      runId: 'run_1',
      lastDeliveredSeq: 9,
      terminal: false
    })).resolves.toBe('resumed')
    supervisionPending = false
    await service.steerTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId,
      text: 'inspect the submitted node',
      messageSource: 'graph_runtime'
    })
    expect(await service.suspendGraphLeadTurn({
      threadId: 'thr_graph_lead',
      turnId: source.turnId
    })).toBe('pending_steering')
    expect(steering.drain(source.turnId)).toHaveLength(1)
    await service.interruptTurn({ threadId: 'thr_graph_lead', turnId: source.turnId })
    expect(await service.graphRunOwnsLeadLimits({
      threadId: 'thr_graph_lead',
      turnId: source.turnId
    })).toBe(false)
  })

  it('restores a planning draft to correction when resume cannot reacquire capacity', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const nowIso = () => '2026-07-30T14:00:00.000Z'
    let lifecycle: GraphPlanningLifecycle = {
      version: 1,
      draftId: 'draft_capacity',
      reservedRunId: 'run_capacity',
      state: 'planning',
      draftRevision: 1
    }
    const transitionGraphPlanningDraft = vi.fn(async ({
      action
    }: {
      action: 'suspend' | 'resume' | 'cancel'
    }): Promise<GraphPlanningLifecycle> => {
      const state = action === 'resume'
        ? 'planning'
        : action === 'suspend'
          ? 'needs_correction'
          : 'cancelled'
      if (lifecycle.state !== state) {
        lifecycle = {
          ...lifecycle,
          state,
          draftRevision: lifecycle.draftRevision + 1
        }
      }
      return lifecycle
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight,
      steering,
      compactor: new ContextCompactor(),
      maxConcurrentTurns: 1,
      createGraphPlanningDraft: async () => lifecycle,
      transitionGraphPlanningDraft,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    for (const id of ['thr_graph_planning_capacity', 'thr_capacity_owner']) {
      await threadStore.upsert(createThreadRecord({
        id,
        title: id,
        workspace: '/tmp/workspace',
        model: 'deepseek-v4-pro'
      }))
    }

    const source = await service.startTurn({
      threadId: 'thr_graph_planning_capacity',
      request: { prompt: 'plan graph', orchestration: 'graph' }
    })
    await expect(service.suspendGraphPlanningTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })).resolves.toBe('suspended')
    expect(lifecycle).toMatchObject({
      state: 'needs_correction',
      draftRevision: 2
    })

    const capacityOwner = await service.startTurn({
      threadId: 'thr_capacity_owner',
      request: { prompt: 'occupy the only execution slot' }
    })
    await expect(service.resumeGraphPlanningTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })).rejects.toBeInstanceOf(TurnCapacityError)
    expect(lifecycle).toMatchObject({
      state: 'needs_correction',
      draftRevision: 2
    })
    expect(await service.getTurn(source.threadId, source.turnId)).toMatchObject({
      graphPlanningLifecycle: {
        state: 'needs_correction',
        draftRevision: 2
      }
    })
    expect(service.isTurnExecutionActive(source.turnId)).toBe(false)

    await service.interruptTurn({
      threadId: capacityOwner.threadId,
      turnId: capacityOwner.turnId
    })
    await expect(service.resumeGraphPlanningTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })).resolves.toBe('resumed')
    expect(lifecycle).toMatchObject({
      state: 'planning',
      draftRevision: 3
    })
    expect(service.isTurnExecutionActive(source.turnId)).toBe(true)
    await service.interruptTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })
  })

  it('steers a suspended committed GraphRun through Lead resume, not planning resume', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const nowIso = () => '2026-07-30T12:00:00.000Z'
    const transitionGraphPlanningDraft = vi.fn(async (input: {
      action: 'suspend' | 'resume' | 'cancel'
    }) => {
      if (input.action === 'resume') {
        throw new Error('committed planning must not be resumed')
      }
      return {
        version: 1 as const,
        draftId: 'draft_committed',
        reservedRunId: 'run_committed',
        state: 'committed' as const,
        draftRevision: 4
      }
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      }),
      inflight,
      steering,
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async () => ({
        runId: 'run_committed',
        lastEventSeq: 9,
        terminal: false
      }),
      createGraphPlanningDraft: async () => ({
        version: 1,
        draftId: 'draft_committed',
        reservedRunId: 'run_committed',
        state: 'planning',
        draftRevision: 1
      }),
      resolveGraphPlanningDraft: async () => ({
        version: 1,
        draftId: 'draft_committed',
        reservedRunId: 'run_committed',
        state: 'committed',
        draftRevision: 4
      }),
      transitionGraphPlanningDraft,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_committed_steer',
      title: 'Committed graph steering',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const source = await service.startTurn({
      threadId: 'thr_graph_committed_steer',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })
    await expect(service.suspendGraphLeadTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })).resolves.toBe('suspended')
    expect(await service.getTurn(source.threadId, source.turnId)).toMatchObject({
      graphPlanningLifecycle: {
        state: 'committed',
        draftRevision: 4
      }
    })

    await expect(service.steerTurn({
      threadId: source.threadId,
      turnId: source.turnId,
      text: 'continue supervision',
      messageSource: 'graph_runtime'
    })).resolves.toBeUndefined()

    expect(service.isTurnExecutionActive(source.turnId)).toBe(true)
    expect(transitionGraphPlanningDraft).not.toHaveBeenCalled()
    expect(steering.peek(source.turnId)).toHaveLength(1)
    await service.interruptTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })
  })

  it('resumes and enqueues steering when Graph suspension releases the lease under the thread lock', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const nowIso = () => '2026-07-30T12:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async () => ({
        runId: 'run_suspend_steer_race',
        lastEventSeq: 11,
        terminal: false
      }),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_suspend_steer_race',
      title: 'Suspend steering race',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const source = await service.startTurn({
      threadId: 'thr_suspend_steer_race',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })

    const originalUpsert = threadStore.upsert.bind(threadStore)
    let markSuspendWriteStarted!: () => void
    let releaseSuspendWrite!: () => void
    const suspendWriteStarted = new Promise<void>((resolve) => {
      markSuspendWriteStarted = resolve
    })
    const suspendWriteRelease = new Promise<void>((resolve) => {
      releaseSuspendWrite = resolve
    })
    let blockSuspendWrite = true
    threadStore.upsert = vi.fn(async (
      thread: Parameters<InMemoryThreadStore['upsert']>[0]
    ) => {
      const sourceTurn = thread.turns.find((turn) => turn.id === source.turnId)
      if (blockSuspendWrite && sourceTurn?.graphLeadLifecycle?.suspendedAt) {
        blockSuspendWrite = false
        markSuspendWriteStarted()
        await suspendWriteRelease
      }
      return originalUpsert(thread)
    })

    const suspension = service.suspendGraphLeadTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })
    await suspendWriteStarted
    const steeringRequest = service.steerTurn({
      threadId: source.threadId,
      turnId: source.turnId,
      text: 'continue while suspension is committing',
      messageSource: 'graph_runtime'
    })
    releaseSuspendWrite()

    await expect(suspension).resolves.toBe('suspended')
    await expect(steeringRequest).resolves.toBeUndefined()
    expect(service.isTurnExecutionActive(source.turnId)).toBe(true)
    expect(steering.peek(source.turnId)).toEqual([{
      text: 'continue while suspension is committing',
      messageSource: 'graph_runtime'
    }])
    expect((await sessionStore.loadEventsSince(source.threadId, 0))
      .filter((event) => event.kind === 'turn_steered')).toHaveLength(1)
    await service.interruptTurn({
      threadId: source.threadId,
      turnId: source.turnId
    })
  })

  it('preserves an orphaned running Graph source turn when its run is nonterminal', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-28T12:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const original = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_restart',
      title: 'Graph restart',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await original.startTurn({
      threadId: 'thr_graph_restart',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })

    const recovered = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async ({ turnId }) => turnId === started.turnId
        ? { runId: 'run_restart', lastEventSeq: 3, terminal: false }
        : null,
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await expect(recovered.reconcileOrphanedTurns()).resolves.toEqual([])
    expect(await recovered.getTurn('thr_graph_restart', started.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId: 'run_restart',
        state: 'supervising',
        lastDeliveredSeq: 0
      }
    })
    await recovered.resumeGraphLeadTurn({
      threadId: 'thr_graph_restart',
      turnId: started.turnId,
      runId: 'run_restart',
      lastDeliveredSeq: 3,
      terminal: false
    })
    await recovered.interruptTurn({
      threadId: 'thr_graph_restart',
      turnId: started.turnId
    })
  })

  it('parks an orphaned Graph Lead with pending supervision without consuming its cursor', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-30T12:30:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const original = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_pending_restart',
      title: 'Graph supervision restart',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await original.startTurn({
      threadId: 'thr_graph_pending_restart',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })

    const recovered = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async ({ turnId }) => turnId === started.turnId
        ? {
            runId: 'run_pending_restart',
            lastEventSeq: 17,
            terminal: false,
            supervisionPending: true
          }
        : null,
      ids: new SequentialIdGenerator(),
      nowIso
    })

    await expect(recovered.reconcileOrphanedTurns()).resolves.toEqual([])
    expect(await recovered.getTurn(started.threadId, started.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId: 'run_pending_restart',
        state: 'supervising',
        lastDeliveredSeq: 0,
        suspendedAt: nowIso()
      }
    })
    expect((await sessionStore.loadEventsSince(started.threadId, 0))
      .filter((event) => event.kind === 'turn_failed')).toEqual([])

    await expect(recovered.resumeGraphLeadTurn({
      threadId: started.threadId,
      turnId: started.turnId,
      runId: 'run_pending_restart',
      lastDeliveredSeq: 0,
      terminal: false
    })).resolves.toBe('resumed')
    await recovered.interruptTurn({
      threadId: started.threadId,
      turnId: started.turnId
    })
  })

  it('preserves a terminal Graph source turn until delayed Lead recovery finalizes it', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-30T12:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const original = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_terminal_restart',
      title: 'Terminal Graph restart',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await original.startTurn({
      threadId: 'thr_graph_terminal_restart',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })

    const recovered = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async ({ turnId }) => turnId === started.turnId
        ? { runId: 'run_terminal_restart', lastEventSeq: 9, terminal: true }
        : null,
      ids: new SequentialIdGenerator(),
      nowIso
    })

    // Runtime startup performs this orphan sweep before the Graph supervisor's
    // delayed terminal wake-up. The GraphRun still owns finalization.
    await expect(recovered.reconcileOrphanedTurns()).resolves.toEqual([])
    expect(await recovered.getTurn(started.threadId, started.turnId)).toMatchObject({
      status: 'running'
    })
    expect((await sessionStore.loadEventsSince(started.threadId, 0))
      .filter((event) => event.kind === 'turn_failed')).toEqual([])

    await expect(recovered.resumeGraphLeadTurn({
      threadId: started.threadId,
      turnId: started.turnId,
      runId: 'run_terminal_restart',
      lastDeliveredSeq: 9,
      terminal: true
    })).resolves.toBe('resumed')
    expect(await recovered.getTurn(started.threadId, started.turnId)).toMatchObject({
      status: 'running',
      graphLeadLifecycle: {
        runId: 'run_terminal_restart',
        state: 'finalizing',
        lastDeliveredSeq: 9
      }
    })
    await recovered.interruptTurn({
      threadId: started.threadId,
      turnId: started.turnId
    })
  })

  it('migrates an active legacy Graph creation gate into a recoverable planning draft', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const nowIso = () => '2026-07-29T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const original = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_legacy_gate',
      title: 'Legacy gate',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await original.startTurn({
      threadId: 'thr_graph_legacy_gate',
      request: { prompt: 'run graph', orchestration: 'graph' }
    })
    await original.updateTurnMetadata('thr_graph_legacy_gate', started.turnId, {
      requiredToolGate: {
        toolName: 'graph_create_run',
        attempt: 2,
        maxAttempts: 3,
        phase: 'retrying',
        lastError: 'legacy invalid plan'
      }
    })

    let created = false
    const recovered = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      createGraphPlanningDraft: async () => {
        created = true
        return {
          version: 1,
          draftId: 'draft_migrated',
          reservedRunId: 'run_migrated',
          state: 'planning',
          draftRevision: 1
        }
      },
      transitionGraphPlanningDraft: async ({ action }) => created
        ? {
            version: 1,
            draftId: 'draft_migrated',
            reservedRunId: 'run_migrated',
            state: action === 'suspend' ? 'needs_correction' : 'planning',
            draftRevision: 2
          }
        : null,
      ids: new SequentialIdGenerator(),
      nowIso
    })

    await expect(recovered.suspendGraphPlanningTurn({
      threadId: 'thr_graph_legacy_gate',
      turnId: started.turnId
    })).resolves.toBe('suspended')
    expect(created).toBe(true)
    expect(await recovered.getTurn('thr_graph_legacy_gate', started.turnId)).toMatchObject({
      status: 'running',
      graphPlanningLifecycle: {
        draftId: 'draft_migrated',
        state: 'needs_correction'
      }
    })
    expect((await recovered.getTurn('thr_graph_legacy_gate', started.turnId))
      ?.requiredToolGate).toBeUndefined()
  })

  it('releases an admission and aborts an already-persisted turn when startup fails', async () => {
    const sessionStore = new FailOnceAppendSessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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
    await Promise.all(['thr_start_failure_a', 'thr_start_failure_b'].map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id,
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))))

    await expect(service.startTurn({
      threadId: 'thr_start_failure_a',
      request: { prompt: 'will fail while persisting', model: 'm' }
    })).rejects.toThrow('append item failed')

    expect((await threadStore.get('thr_start_failure_a'))?.turns[0]?.status).toBe('aborted')
    const recovered = await service.startTurn({
      threadId: 'thr_start_failure_b',
      request: { prompt: 'slot was released', model: 'm' }
    })
    await service.interruptTurn({ threadId: 'thr_start_failure_b', turnId: recovered.turnId })
  })

  it('rejects cross-thread interrupts and ignores a late loop finish after interrupt', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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
    await Promise.all(['thr_owner_a', 'thr_owner_b'].map((id) => threadStore.upsert(createThreadRecord({
      id,
      title: id,
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))))
    const started = await service.startTurn({
      threadId: 'thr_owner_b',
      request: { prompt: 'run', model: 'm' }
    })

    await expect(service.interruptTurn({
      threadId: 'thr_owner_a',
      turnId: started.turnId
    })).rejects.toThrow(/turn not found/)
    expect(service.getAbortController(started.turnId)?.aborted).toBe(false)

    await service.interruptTurn({ threadId: 'thr_owner_b', turnId: started.turnId })
    const lateSettlement = await service.finishTurn({
      threadId: 'thr_owner_b',
      turnId: started.turnId,
      status: 'completed'
    })

    const turn = await service.getTurn('thr_owner_b', started.turnId)
    expect(turn?.status).toBe('aborted')
    expect(lateSettlement).toEqual({ kind: 'already_terminal', status: 'aborted' })
    const events = await sessionStore.loadEventsSince('thr_owner_b', 0)
    expect(events.filter((event) => event.kind === 'turn_aborted')).toHaveLength(1)
    expect(events.some((event) => event.kind === 'turn_completed')).toBe(false)
  })

  it('persists per-turn provider ids for model routing', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_provider_turn',
      title: 'Provider turn',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))

    const started = await service.startTurn({
      threadId: 'thr_provider_turn',
      request: {
        prompt: 'hello',
        model: 'mimo-v2.5',
        providerId: 'xiaomi-token-plan'
      }
    })

    const thread = await threadStore.get('thr_provider_turn')
    const turn = thread?.turns.find((item) => item.id === started.turnId)
    expect(turn).toMatchObject({
      model: 'mimo-v2.5',
      providerId: 'xiaomi-token-plan'
    })
  })

  it('freezes an omitted provider as default before the thread selection can change', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-05T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      defaultModel: 'default-model',
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_default_provider_snapshot'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Default provider snapshot',
      workspace: '/tmp/workspace',
      model: 'default-model'
    }))

    const started = await service.startTurn({ threadId, request: { prompt: 'run' } })
    const admitted = await threadStore.get(threadId)
    expect(admitted?.turns[0]).toMatchObject({
      id: started.turnId,
      model: 'default-model',
      providerId: 'default'
    })
    if (!admitted) throw new Error('expected admitted thread')

    // Reproduce the old first-step window: a later thread projection gains a
    // concrete provider before ModelStepService reads it. The admitted turn's
    // explicit default alias remains authoritative and blocks that fallback.
    await threadStore.upsert({
      ...admitted,
      providerId: 'provider-after-admission',
      accountId: 'account-after-admission'
    })
    expect((await threadStore.get(threadId))?.turns[0]).toMatchObject({
      providerId: 'default'
    })

    await service.interruptTurn({ threadId, turnId: started.turnId })
  })

  it('rejects steering that exceeds the active turn buffer without recording a phantom event', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const steering = new SteeringQueue({ maxEntriesPerTurn: 1, maxBytesPerTurn: 32 })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering,
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_bounded_steering'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Bounded steering',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro',
      providerId: 'provider-a',
      accountId: 'account-a'
    }))
    const started = await service.startTurn({ threadId, request: { prompt: 'run' } })

    expect((await threadStore.get(threadId))?.turns[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      providerId: 'provider-a',
      accountId: 'account-a'
    })

    await service.steerTurn({ threadId, turnId: started.turnId, text: 'first' })
    await expect(service.steerTurn({
      threadId,
      turnId: started.turnId,
      text: 'second'
    })).rejects.toThrow(TurnConflictError)

    expect(steering.peek(started.turnId)).toEqual([{ text: 'first' }])
    const runtimeEvents = await sessionStore.loadEventsSince(threadId, 0)
    expect(runtimeEvents.filter((event) => event.kind === 'turn_steered')).toHaveLength(1)
    await service.interruptTurn({ threadId, turnId: started.turnId })
  })

  it('rejects guidance after the model loop seals its terminal boundary', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-16T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const steering = new SteeringQueue()
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering,
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_sealed_steering'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Sealed steering',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro'
    }))
    const started = await service.startTurn({ threadId, request: { prompt: 'run' } })
    expect(steering.sealIfEmpty(started.turnId)).toBe(true)

    await expect(service.steerTurn({
      threadId,
      turnId: started.turnId,
      text: 'too late'
    })).rejects.toThrow('turn is no longer accepting steering')

    const runtimeEvents = await sessionStore.loadEventsSince(threadId, 0)
    expect(runtimeEvents.filter((event) => event.kind === 'turn_steered')).toHaveLength(0)
    await service.interruptTurn({ threadId, turnId: started.turnId })
  })
})

describe('TurnService bounded history operations', () => {
  it('touches metadata without hydrating the Thread for a durable item update', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new MetadataCountingThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-31T00:00:00.000Z'
    const threadId = 'thr_metadata_touch'
    const turnId = 'turn_metadata_touch'
    const item = makeAssistantTextItem({
      id: 'assistant_metadata_touch',
      threadId,
      turnId,
      text: 'running',
      status: 'running'
    })
    await threadStore.upsert({
      ...createThreadRecord({
        id: threadId,
        title: 'Metadata touch',
        workspace: '/tmp/workspace',
        model: 'test'
      }),
      turns: [appendTurnItem(createTurnRecord({
        id: turnId,
        threadId,
        prompt: 'test',
        status: 'running'
      }), item)]
    })
    await sessionStore.appendItem(threadId, item)
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (id) => eventBus.allocateSeq(id),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })

    await service.updateItem(threadId, item.id, { text: 'completed', status: 'completed' })

    expect(threadStore.touches).toEqual([threadId])
    expect(threadStore.hydratedGets).toEqual([])
    expect(await sessionStore.loadItems(threadId)).toMatchObject([
      { id: item.id, text: 'completed', status: 'completed' }
    ])
  })

  it('hydrates only metadata-identified orphan candidates during reconciliation', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new MetadataCountingThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-31T00:00:00.000Z'
    const idleId = 'thr_orphan_idle'
    const activeId = 'thr_orphan_active'
    await threadStore.upsert({
      ...createThreadRecord({
        id: idleId,
        title: 'Idle history',
        workspace: '/tmp/workspace',
        model: 'test'
      }),
      turns: [finishTurn(createTurnRecord({
        id: 'turn_idle',
        threadId: idleId,
        prompt: 'done',
        status: 'completed'
      }), 'completed')]
    })
    await threadStore.upsert({
      ...createThreadRecord({
        id: activeId,
        title: 'Active orphan',
        workspace: '/tmp/workspace',
        model: 'test'
      }),
      turns: [createTurnRecord({
        id: 'turn_active',
        threadId: activeId,
        prompt: 'running',
        status: 'running'
      })]
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events: new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (id) => eventBus.allocateSeq(id),
        nowIso
      }),
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso
    })

    await expect(service.reconcileOrphanedTurns()).resolves.toEqual([activeId])

    expect(threadStore.metadataGets).toEqual(expect.arrayContaining([idleId, activeId]))
    expect(threadStore.hydratedGets).not.toContain(idleId)
    expect(threadStore.hydratedGets).toContain(activeId)
  })
})

describe('TurnService compact', () => {
  it('uses model summaries for manual compaction while preserving visible history', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new SummaryModel()
    const compactedThreads: string[] = []
    const prefix = createImmutablePrefix({
      systemPrompt: 'System prompt used by both chat and compaction.',
      pinnedConstraints: ['system: keep GUI HTTP/SSE stable']
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      model,
      usage: new UsageService(),
      prefix,
      defaultModel: 'default-model',
      contextCompaction: {
        summaryMode: 'model',
        summaryTimeoutMs: 1_000,
        summaryMaxTokens: 400,
        summaryInputMaxBytes: 16_384
      },
      onCompacted: async (threadId) => {
        compactedThreads.push(threadId)
      },
      ids: new SequentialIdGenerator(),
      nowIso
    })

    const threadId = 'thr_manual_compact'
    const turnId = 'turn_1'
    const items: TurnItem[] = [
      makeUserItem({ id: 'item_1', threadId, turnId, text: 'Initial task: fix /compact.' }),
      makeAssistantTextItem({ id: 'item_2', threadId, turnId, text: 'I found the service path.', status: 'completed' }),
      makeUserItem({ id: 'item_3', threadId, turnId, text: 'Active Skill: retained-manual-tail-only\nPlease preserve this clue.' }),
      makeAssistantTextItem({ id: 'item_4', threadId, turnId, text: 'Recent tail A.', status: 'completed' }),
      makeUserItem({ id: 'item_5', threadId, turnId, text: 'Recent tail B.' }),
      makeAssistantTextItem({ id: 'item_6', threadId, turnId, text: 'Recent tail C.', status: 'completed' })
    ]
    let turn = createTurnRecord({
      id: turnId,
      threadId,
      prompt: 'Initial task',
      model: 'turn-model',
      providerId: 'ext-manual-turn',
      accountId: 'account-manual-turn',
      status: 'completed'
    })
    for (const item of items) {
      turn = appendTurnItem(turn, item)
      await sessionStore.appendItem(threadId, item)
    }
    await threadStore.upsert({
      ...createThreadRecord({
        id: threadId,
        title: 'Manual compact',
        workspace: '/tmp/workspace',
        model: 'thread-model',
        providerId: 'ext-manual-thread',
        accountId: 'account-manual-thread'
      }),
      turns: [finishTurn(turn, 'completed')]
    })

    const response = await service.compact({
      threadId,
      request: { reason: 'manual test' }
    })

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({
      model: 'turn-model',
      providerId: 'ext-manual-turn',
      accountId: 'account-manual-turn'
    })
    // Compaction-mode turn uses the dedicated summarizer system prompt and
    // feeds the real conversation as messages (not a serialized transcript).
    expect(model.requests[0].systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(model.requests[0].prefix).toEqual([])
    const summaryHistory = model.requests[0].history
    const summaryUserMessages = summaryHistory
      .filter((item) => item.kind === 'user_message')
      .map((item) => item.text)
    expect(summaryUserMessages[0]).toContain('Initial task: fix /compact.')
    expect(summaryUserMessages).not.toContain('Active Skill: retained-manual-tail-only\nPlease preserve this clue.')
    expect(summaryUserMessages).not.toContain('Recent tail B.')
    expect(summaryUserMessages).not.toContain('Recent tail C.')
    const continuationItem = summaryHistory[summaryHistory.length - 1]
    expect(continuationItem?.kind).toBe('user_message')
    if (!continuationItem || continuationItem.kind !== 'user_message') {
      throw new Error('expected compaction continuation message to be a user message')
    }
    expect(continuationItem.text).toContain('Provide a detailed summary of our conversation above')
    expect(continuationItem.text).not.toContain('Active Skill: retained-manual-tail-only')
    expect(response.summary).toContain('MODEL SUMMARY kept the durable state.')
    expect(response.pinnedConstraints).toEqual(prefix.pinnedConstraints)
    expect(compactedThreads).toEqual([threadId])

    const visibleItems = await sessionStore.loadItems(threadId)
    expect(visibleItems).toHaveLength(7)
    expect(visibleItems.map((item) => item.id)).toEqual([
      'item_1',
      'item_2',
      expect.stringMatching(/^compaction_/),
      'item_3',
      'item_4',
      'item_5',
      'item_6'
    ])
    expect(visibleItems[2]).toMatchObject({
      kind: 'compaction',
      auto: false,
      summary: expect.stringContaining('MODEL SUMMARY kept the durable state.'),
      pinnedConstraints: prefix.pinnedConstraints,
      sourceItemIds: ['item_1', 'item_2']
    })
    expect(effectiveHistoryAfterLatestCompaction(visibleItems).map((item) => item.id)).toEqual([
      visibleItems[2]?.id,
      'item_3',
      'item_4',
      'item_5',
      'item_6'
    ])
    const hydratedThread = await threadStore.get(threadId)
    // Thread-store layout diverges from session-store on purpose: the runtime
    // wants `[head, summary, tail]` so `effectiveHistoryAfterLatestCompaction`
    // can return `[summary, tail]`, but the renderer groups blocks by user
    // message — leaving the summary in the middle of the flat list would push
    // the 已压缩上下文 row into the previous turn's process timeline. The
    // bucket-level reorder appends the summary at the end of its turn so it
    // renders inside the latest turn instead.
    expect(hydratedThread?.turns[0]?.items.map((item) => item.id)).toEqual([
      'item_1',
      'item_2',
      'item_3',
      'item_4',
      'item_5',
      'item_6',
      visibleItems[2]?.id
    ])

    const runtimeEvents = await sessionStore.loadEventsSince(threadId, 0)
    const started = runtimeEvents.find((event) => event.kind === 'compaction_started')
    const completed = runtimeEvents.find((event) => event.kind === 'compaction_completed')
    expect(started?.itemId).toBe(completed?.itemId)
    expect(completed).toMatchObject({
      kind: 'compaction_completed',
      auto: false,
      summary: expect.stringContaining('MODEL SUMMARY kept the durable state.')
    })
    expect(runtimeEvents.some((event) => event.kind === 'usage' && event.model === 'turn-model')).toBe(true)
  })

  it('retries manual compaction after a summary-window append without losing history', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new BlockingSummaryModel()
    const prefix = createImmutablePrefix({
      systemPrompt: 'System prompt used by both chat and compaction.',
      pinnedConstraints: ['system: keep GUI HTTP/SSE stable']
    })
    const service = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      model,
      usage: new UsageService(),
      prefix,
      defaultModel: 'default-model',
      contextCompaction: { summaryMode: 'model', summaryTimeoutMs: 1_000 },
      ids: new SequentialIdGenerator(),
      nowIso
    })
    const threadId = 'thr_manual_compact_race'
    const turnId = 'turn_1'
    const seeds: TurnItem[] = [
      makeUserItem({ id: 'item_1', threadId, turnId, text: 'Initial task: keep every item.' }),
      makeAssistantTextItem({ id: 'item_2', threadId, turnId, text: 'Older result.', status: 'completed' }),
      makeUserItem({ id: 'item_3', threadId, turnId, text: 'Recent clue.' }),
      makeAssistantTextItem({ id: 'item_4', threadId, turnId, text: 'Recent answer.', status: 'completed' }),
      makeUserItem({ id: 'item_5', threadId, turnId, text: 'Newest prompt.' }),
      makeAssistantTextItem({ id: 'item_6', threadId, turnId, text: 'Newest answer.', status: 'completed' })
    ]
    let turn = createTurnRecord({
      id: turnId,
      threadId,
      prompt: 'Initial task',
      model: 'thread-model',
      status: 'completed'
    })
    for (const item of seeds) {
      turn = appendTurnItem(turn, item)
      await sessionStore.appendItem(threadId, item)
    }
    await threadStore.upsert({
      ...createThreadRecord({
        id: threadId,
        title: 'Manual compact race',
        workspace: '/tmp/workspace',
        model: 'thread-model'
      }),
      turns: [finishTurn(turn, 'completed')]
    })

    const compacting = service.compact({ threadId, request: { reason: 'race test' } })
    await model.summaryStarted
    await service.applyItem(threadId, makeAssistantTextItem({
      id: 'item_late_manual_compaction',
      threadId,
      turnId,
      text: 'this summary-window append must survive',
      status: 'completed'
    }))
    model.release()
    await expect(compacting).resolves.toMatchObject({ threadId })

    const sessionItems = await sessionStore.loadItems(threadId)
    for (const id of [...seeds.map((item) => item.id), 'item_late_manual_compaction']) {
      expect(sessionItems.filter((item) => item.id === id)).toHaveLength(1)
    }
    const summaries = sessionItems.filter((item) => item.kind === 'compaction')
    expect(summaries).toHaveLength(1)
    const runtimeEvents = await sessionStore.loadEventsSince(threadId, 0)
    const completed = runtimeEvents.filter((event) => event.kind === 'compaction_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.itemId).toBe(summaries[0]?.id)
    expect(completed[0]?.kind === 'compaction_completed' ? completed[0].auto : undefined).toBe(false)

    const threadItems = (await threadStore.get(threadId))?.turns.flatMap((candidate) => candidate.items) ?? []
    expect([...threadItems.map((item) => item.id)].sort()).toEqual(
      [...sessionItems.map((item) => item.id)].sort()
    )
    const sessionById = new Map(sessionItems.map((item) => [item.id, item]))
    for (const threadItem of threadItems) {
      expect(threadItem).toEqual(sessionById.get(threadItem.id))
    }
  })
})

describe('TurnService rewindThread', () => {
  it('removes the target turn and later session items from persisted history', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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

    const threadId = 'thr_rewind'
    const firstTurnId = 'turn_1'
    const secondTurnId = 'turn_2'
    const firstUser = makeUserItem({ id: 'item_1_user', threadId, turnId: firstTurnId, text: 'Keep me.' })
    const firstAssistant = makeAssistantTextItem({
      id: 'item_1_assistant',
      threadId,
      turnId: firstTurnId,
      text: 'Kept.',
      status: 'completed'
    })
    const secondUser = makeUserItem({
      id: 'item_2_user',
      threadId,
      turnId: secondTurnId,
      text: 'Rewind me.',
      workspaceCheckpointId: 'gcp_1'
    })
    const secondAssistant = makeAssistantTextItem({
      id: 'item_2_assistant',
      threadId,
      turnId: secondTurnId,
      text: 'Removed.',
      status: 'completed'
    })
    const firstTurn = finishTurn(
      appendTurnItem(appendTurnItem(createTurnRecord({
        id: firstTurnId,
        threadId,
        prompt: 'Keep me.',
        status: 'completed'
      }), firstUser), firstAssistant),
      'completed'
    )
    const secondTurn = finishTurn(
      appendTurnItem(appendTurnItem(createTurnRecord({
        id: secondTurnId,
        threadId,
        prompt: 'Rewind me.',
        workspaceCheckpointId: 'gcp_1',
        status: 'completed'
      }), secondUser), secondAssistant),
      'completed'
    )
    for (const item of [firstUser, firstAssistant, secondUser, secondAssistant]) {
      await sessionStore.appendItem(threadId, item)
    }
    await threadStore.upsert({
      ...createThreadRecord({
        id: threadId,
        title: 'Rewind',
        workspace: '/tmp/workspace',
        model: 'thread-model',
        status: 'archived'
      }),
      turns: [firstTurn, secondTurn]
    })

    const response = await service.rewindThread({ threadId, turnId: secondTurnId })

    expect(response).toMatchObject({
      threadId,
      turnId: secondTurnId,
      removedTurns: 1,
      remainingTurns: 1
    })
    expect((await sessionStore.loadItems(threadId)).map((item) => item.id)).toEqual([
      'item_1_user',
      'item_1_assistant'
    ])
    expect(await threadStore.get(threadId)).toMatchObject({
      status: 'archived',
      turns: [expect.objectContaining({ id: firstTurnId })]
    })
  })

  it('refuses to rewrite history while any turn remains active, including under archival', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-06-18T00:00:00.000Z'
    const service = new TurnService({
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
    const threadId = 'thr_rewind_active'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Active rewind',
      workspace: '/tmp/workspace',
      model: 'thread-model'
    }))
    const started = await service.startTurn({ threadId, request: { prompt: 'do not rewind' } })
    const activeThread = await threadStore.get(threadId)
    if (!activeThread) throw new Error('missing active thread')
    await threadStore.upsert({ ...activeThread, status: 'archived' })

    await expect(service.rewindThread({ threadId, turnId: started.turnId }))
      .rejects.toBeInstanceOf(TurnConflictError)
    expect((await threadStore.get(threadId))?.turns.map((turn) => turn.id)).toEqual([started.turnId])
    await service.interruptTurn({ threadId, turnId: started.turnId })
  })
})
