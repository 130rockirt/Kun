import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'
import { TurnService } from './turn-service.js'
import {
  ExtensionAgentService,
  ExtensionBrokerError,
  type ExtensionPrincipal
} from './extension-agent-service.js'
import { ExtensionAgentProfileRegistry } from './extension-agent-profile-registry.js'

const workspace = resolve('/tmp/kun-extension-workspace')

function createHarness(headless = false) {
  const threadStore = new InMemoryThreadStore()
  const sessions = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const ids = new SequentialIdGenerator()
  const nowIso = () => '2026-07-11T08:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore: sessions,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const threads = new ThreadService({ threadStore, sessionStore: sessions, events, ids, nowIso })
  const turns = new TurnService({
    threadStore,
    sessionStore: sessions,
    events,
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor(),
    ids,
    nowIso
  })
  const profiles = new ExtensionAgentProfileRegistry()
  profiles.register({
    extensionId: 'com.example.agent',
    extensionVersion: '1.2.3',
    profiles: [{
      id: 'reviewer',
      displayName: 'Reviewer',
      instructionOverlay: 'Review carefully. Do not change Kun policy.',
      providerBinding: {
        providerId: 'example-provider',
        accountId: 'account_1',
        modelId: 'example-model'
      },
      allowedToolScopes: ['read'],
      defaultBudget: { maxTokens: 800_000 },
      visibility: 'workspace'
    }]
  })
  const launched: Array<{ threadId: string; turnId: string }> = []
  const service = new ExtensionAgentService({
    threads,
    turns,
    sessions,
    eventBus,
    profiles,
    runTurn: (threadId, turnId) => { launched.push({ threadId, turnId }) },
    defaultBinding: { providerId: 'default-provider', modelId: 'default-model' },
    headless,
    maximumBudget: { maxTokens: 500_000 },
    resolveToolCatalogEpoch: async () => ({
      id: 'epoch_1',
      fingerprint: 'sha256:catalog',
      toolCount: 1,
      canonicalToolIds: ['extension:com.example.agent/read'],
      schemaDigests: { 'extension:com.example.agent/read': 'sha256:read' },
      createdAt: nowIso()
    })
  })
  return { service, threads, turns, sessions, events, launched }
}

function principal(extensionId = 'com.example.agent'): ExtensionPrincipal {
  return {
    extensionId,
    extensionVersion: '1.2.3',
    permissions: [
      'agent.run',
      'agent.threads.readOwn',
      'accounts.use:example-provider'
    ],
    workspaceRoots: [workspace],
    workspaceTrusted: true
  }
}

describe('ExtensionAgentService', () => {
  it('creates an owned run with a clamped immutable profile snapshot', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), {
      input: 'Review this workspace',
      workspace,
      profileId: 'reviewer',
      visibility: 'workspace',
      budget: { maxTokens: 900_000 },
      allowedTools: ['read']
    })

    expect(run).toMatchObject({
      ownerExtensionId: 'com.example.agent',
      ownerExtensionVersion: '1.2.3',
      workspace,
      status: 'running',
      visibility: 'workspace',
      effectiveBudget: { maxTokens: 500_000 },
      profile: {
        id: 'reviewer',
        model: 'example-model',
        providerId: 'example-provider',
        accountId: 'account_1',
        allowedToolScopes: ['read']
      },
      toolCatalogEpoch: { id: 'epoch_1' }
    })
    expect(h.launched).toEqual([{ threadId: run.threadId, turnId: run.id }])
    const persisted = await h.threads.get(run.threadId)
    expect(persisted).toMatchObject({
      ownerExtensionId: 'com.example.agent',
      accountId: 'account_1',
      extensionBudget: { maxTokens: 500_000 },
      turns: [expect.objectContaining({ accountId: 'account_1' })]
    })

    await h.turns.finishTurn({
      threadId: run.threadId,
      turnId: run.id,
      status: 'completed'
    })
    const resumed = await h.service.createRun(principal(), {
      threadId: run.threadId,
      input: 'Continue with the same account',
      workspace
    })
    expect((await h.threads.get(run.threadId))?.turns.find(({ id }) => id === resumed.id))
      .toMatchObject({ accountId: 'account_1' })
  })

  it('does not reveal foreign threads or permit owner spoofing', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Owned run', workspace })

    await expect(h.service.getRun(principal('com.example.foreign'), run.id)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(h.service.getOwnThread(principal('com.example.foreign'), run.threadId)).rejects.toBeInstanceOf(
      ExtensionBrokerError
    )
  })

  it('enforces permission, workspace, account, steering, and idempotent cancellation', async () => {
    const h = createHarness()
    const denied = { ...principal(), permissions: ['agent.threads.readOwn'] }
    await expect(h.service.createRun(denied, { input: 'Denied', workspace })).rejects.toMatchObject({
      code: 'permission_denied'
    })
    await expect(h.service.createRun(principal(), {
      input: 'Outside', workspace: '/tmp/not-granted'
    })).rejects.toMatchObject({ code: 'workspace_denied' })

    const run = await h.service.createRun(principal(), { input: 'Control me', workspace })
    await h.service.steer(principal(), run.id, 'Use the smaller scope')
    expect((await h.service.getRun(principal(), run.id)).status).toBe('running')
    expect((await h.service.cancel(principal(), run.id)).status).toBe('cancelled')
    expect((await h.service.cancel(principal(), run.id)).status).toBe('cancelled')
  })

  it('admits concurrent run creation atomically per extension', async () => {
    const h = createHarness()
    const results = await Promise.allSettled([
      h.service.createRun(principal(), {
        input: 'Concurrent run A',
        workspace,
        budget: { maxConcurrentRuns: 1 }
      }),
      h.service.createRun(principal(), {
        input: 'Concurrent run B',
        workspace,
        budget: { maxConcurrentRuns: 1 }
      })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'conflict' })
    })
    expect(await h.threads.list({ includeArchived: true, includeSide: true })).toHaveLength(1)
  })

  it('replays ordered owner-scoped events and redacts protected gate identifiers', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Stream events', workspace })
    await h.events.record({
      kind: 'approval_requested',
      threadId: run.threadId,
      turnId: run.id,
      approvalId: 'approval_secret',
      toolName: 'write',
      status: 'pending'
    })
    const received: Array<{ seq: number; payload: Record<string, unknown> }> = []
    const subscription = await h.service.subscribe(principal(), { runId: run.id }, (event) => {
      received.push({ seq: event.seq, payload: event.payload })
    })

    expect(received.length).toBeGreaterThanOrEqual(3)
    expect(received.map((event) => event.seq)).toEqual(
      [...received.map((event) => event.seq)].sort((a, b) => a - b)
    )
    expect(received.at(-1)?.payload).not.toHaveProperty('approvalId')
    subscription.close()
  })

  it('summarizes run status with forward-only event iteration', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Inspect status', workspace })
    await h.events.record({
      kind: 'error',
      threadId: run.threadId,
      turnId: run.id,
      code: 'stream_resource_limit',
      message: 'model stream limit exceeded'
    })
    const loadEventsSince = vi.spyOn(h.sessions, 'loadEventsSince')
    const iterateEventsSince = vi.spyOn(h.sessions, 'iterateEventsSince')

    const projected = await h.service.getRun(principal(), run.id)

    expect(projected.status).toBe('budget-exhausted')
    expect(iterateEventsSince).toHaveBeenCalledWith(
      run.threadId,
      0,
      expect.objectContaining({ maxRecordBytes: expect.any(Number) })
    )
    expect(loadEventsSince).not.toHaveBeenCalled()
  })

  it('fails closed instead of materializing full history when bounded iteration is unavailable', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Require bounded replay', workspace })
    Object.defineProperty(h.sessions, 'iterateEventsSince', {
      configurable: true,
      value: undefined
    })
    const loadEventsSince = vi.spyOn(h.sessions, 'loadEventsSince')

    await expect(h.service.getRun(principal(), run.id)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/bounded extension event replay is unavailable/i)
    })
    expect(loadEventsSince).not.toHaveBeenCalled()
  })

  it('projects usage for a resumed run as a delta from prior thread usage', async () => {
    const h = createHarness()
    const first = await h.service.createRun(principal(), { input: 'First run', workspace })
    await h.events.record({
      kind: 'usage',
      threadId: first.threadId,
      turnId: first.id,
      model: 'default-model',
      usage: {
        promptTokens: 6,
        completionTokens: 4,
        reasoningTokens: 1,
        totalTokens: 10,
        cacheHitTokens: 2,
        cacheMissTokens: 4,
        cacheHitRate: 2 / 6,
        cacheMissReasons: ['cold'],
        cacheSuggestions: ['keep prefix stable'],
        turns: 1,
        costUsd: 0.1,
        costByCurrency: { USD: 0.1 },
        hasError: true
      }
    })
    await h.turns.finishTurn({
      threadId: first.threadId,
      turnId: first.id,
      status: 'completed'
    })
    const resumed = await h.service.createRun(principal(), {
      threadId: first.threadId,
      input: 'Second run',
      workspace
    })
    await h.events.record({
      kind: 'usage',
      threadId: resumed.threadId,
      turnId: resumed.id,
      model: 'default-model',
      usage: {
        promptTokens: 11,
        completionTokens: 6,
        reasoningTokens: 2,
        totalTokens: 17,
        cacheHitTokens: 3,
        cacheMissTokens: 5,
        cacheHitRate: 3 / 8,
        cacheMissReasons: ['cold'],
        cacheSuggestions: ['keep prefix stable'],
        turns: 2,
        costUsd: 0.17,
        costByCurrency: { USD: 0.17 },
        hasError: true
      }
    })
    await h.events.record({
      kind: 'usage',
      threadId: resumed.threadId,
      turnId: resumed.id,
      model: 'default-model',
      usage: {
        promptTokens: 16,
        completionTokens: 9,
        reasoningTokens: 4,
        totalTokens: 25,
        cacheHitTokens: 5,
        cacheMissTokens: 7,
        cacheHitRate: 5 / 12,
        cacheMissReasons: ['provider'],
        cacheSuggestions: ['check provider cache'],
        turns: 2,
        costUsd: 0.26,
        costByCurrency: { USD: 0.26, EUR: 0.2 },
        hasError: false
      }
    })

    const projected = await h.service.getRun(principal(), resumed.id)

    expect(projected.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 3,
      totalTokens: 15,
      cacheHitTokens: 3,
      cacheMissTokens: 3,
      cacheHitRate: 0.5,
      cacheMissReasons: ['cold', 'provider'],
      cacheSuggestions: ['keep prefix stable', 'check provider cache'],
      turns: 1,
      costByCurrency: { USD: 0.16, EUR: 0.2 },
      hasError: true
    })
    expect(projected.usage?.costUsd).toBeCloseTo(0.16)
  })

  it('streams a large persisted history and retains only the bounded replay tail', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), {
      input: 'Replay a large history',
      workspace,
      budget: { maxRetainedEvents: 5 }
    })
    const afterSeq = await h.sessions.highestSeq(run.threadId)
    const recordedSeqs: number[] = []
    for (let index = 0; index < 2_000; index += 1) {
      const event = await h.events.record({
        kind: 'turn_steered',
        threadId: run.threadId,
        turnId: run.id,
        text: `event-${index}`
      })
      recordedSeqs.push(event.seq)
    }
    const loadEventsSince = vi.spyOn(h.sessions, 'loadEventsSince')
    const iterateEventsSince = vi.spyOn(h.sessions, 'iterateEventsSince')
    const received: number[] = []

    const subscription = await h.service.subscribe(principal(), { runId: run.id, afterSeq }, (event) => {
      received.push(event.seq)
    })

    expect(received).toEqual(recordedSeqs.slice(-5))
    expect(iterateEventsSince).toHaveBeenCalledWith(
      run.threadId,
      afterSeq,
      expect.objectContaining({ maxRecordBytes: expect.any(Number) })
    )
    expect(loadEventsSince).not.toHaveBeenCalled()
    subscription.close()
  })

  it('bounds persisted replay by serialized bytes as well as event count', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), {
      input: 'Replay large events',
      workspace,
      budget: { maxRetainedEvents: 100 }
    })
    const afterSeq = await h.sessions.highestSeq(run.threadId)
    const recordedSeqs: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const event = await h.events.record({
        kind: 'turn_steered',
        threadId: run.threadId,
        turnId: run.id,
        text: `${index}:${'x'.repeat(200 * 1024)}`
      })
      recordedSeqs.push(event.seq)
    }
    const received: number[] = []

    const subscription = await h.service.subscribe(principal(), { runId: run.id, afterSeq }, (event) => {
      received.push(event.seq)
    })

    expect(received).toEqual(recordedSeqs.slice(-2))
    subscription.close()
  })

  it('closes with a resumable overflow when live events exceed the replay buffer byte budget', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Overflow replay', workspace })
    const afterSeq = await h.sessions.highestSeq(run.threadId)
    const originalIterate = h.sessions.iterateEventsSince!.bind(h.sessions)
    let releaseReplay!: () => void
    let markStarted!: () => void
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve })
    const replayStarted = new Promise<void>((resolve) => { markStarted = resolve })
    vi.spyOn(h.sessions, 'iterateEventsSince').mockImplementation(async function* (
      threadId: string,
      sinceSeq: number
    ) {
      markStarted()
      await replayBlocked
      yield* originalIterate(threadId, sinceSeq)
    })
    const received: Array<{ type: string; payload: Record<string, unknown> }> = []
    const subscribing = h.service.subscribe(principal(), { runId: run.id, afterSeq }, (event) => {
      received.push({ type: event.type, payload: event.payload })
    })
    await replayStarted

    for (let index = 0; index < 3; index += 1) {
      await h.events.record({
        kind: 'turn_steered',
        threadId: run.threadId,
        turnId: run.id,
        text: `${index}:${'y'.repeat(200 * 1024)}`
      })
    }
    releaseReplay()
    const subscription = await subscribing

    expect(received).toEqual([{
      type: 'subscription_overflow',
      payload: expect.objectContaining({
        message: expect.stringMatching(/live replay buffer overflowed/),
        resumeAfterSeq: afterSeq
      })
    }])
    expect(subscription.closed).toBe(true)
    expect(subscription.lastDeliveredSeq).toBe(afterSeq)
  })

  it('bounds the number of live events retained while persisted replay is blocked', async () => {
    const h = createHarness()
    const run = await h.service.createRun(principal(), { input: 'Overflow replay count', workspace })
    const afterSeq = await h.sessions.highestSeq(run.threadId)
    const originalIterate = h.sessions.iterateEventsSince!.bind(h.sessions)
    let releaseReplay!: () => void
    let markStarted!: () => void
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve })
    const replayStarted = new Promise<void>((resolve) => { markStarted = resolve })
    vi.spyOn(h.sessions, 'iterateEventsSince').mockImplementation(async function* (
      threadId: string,
      sinceSeq: number
    ) {
      markStarted()
      await replayBlocked
      yield* originalIterate(threadId, sinceSeq)
    })
    const received: Array<{ type: string; payload: Record<string, unknown> }> = []
    const subscribing = h.service.subscribe(principal(), { runId: run.id, afterSeq }, (event) => {
      received.push({ type: event.type, payload: event.payload })
    })
    await replayStarted

    for (let index = 0; index < 1_025; index += 1) {
      await h.events.record({
        kind: 'turn_steered',
        threadId: run.threadId,
        turnId: run.id,
        text: `event-${index}`
      })
    }
    releaseReplay()
    const subscription = await subscribing

    expect(received).toEqual([{
      type: 'subscription_overflow',
      payload: expect.objectContaining({ resumeAfterSeq: afterSeq })
    }])
    expect(subscription.closed).toBe(true)
  })

  it('runs headlessly without exposing an extension path for protected user-input gates', async () => {
    const h = createHarness(true)
    const run = await h.service.createRun(principal(), { input: 'Headless run', workspace })
    const thread = await h.threads.get(run.threadId)

    expect(thread?.turns.find((turn) => turn.id === run.id)?.disableUserInput).toBe(true)
  })
})
