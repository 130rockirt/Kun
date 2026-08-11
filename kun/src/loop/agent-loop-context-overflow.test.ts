import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { createThreadRecord } from '../domain/thread.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import { UsageService } from '../services/usage-service.js'
import { AgentLoop } from './agent-loop.js'
import { ContextCompactor } from './context-compactor.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'

class OverflowModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'overflow-model'
  readonly calls = new Map<string, number>()

  constructor(private readonly recover: boolean) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const call = (this.calls.get(request.threadId) ?? 0) + 1
    this.calls.set(request.threadId, call)
    if (request.threadId === 'affected' && call >= 2 && (!this.recover || call === 2)) {
      yield {
        kind: 'error',
        message: 'Maximum context length is 128000 tokens',
        code: 'context_length_exceeded'
      }
      yield { kind: 'completed', stopReason: 'error' }
      return
    }
    yield {
      kind: 'assistant_text_delta',
      text: call === 1 && request.threadId === 'affected'
        ? 'seed history '.repeat(200)
        : 'completed normally'
    }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('AgentLoop provider context overflow recovery', () => {
  it('compacts and retries once when no partial output was committed', async () => {
    const model = new OverflowModel(true)
    const harness = createHarness(model)
    await runTurn(harness, 'affected', 'seed')
    await expect(runTurn(harness, 'affected', 'trigger overflow')).resolves.toBe('completed')
    expect(model.calls.get('affected')).toBe(3)
    expect(harness.eventBus.snapshotSince('affected', 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'compaction_completed' }),
      expect.objectContaining({ kind: 'model_request_retry', reason: 'context_overflow' })
    ]))
  })

  it('fails only the affected turn after one retry and leaves unrelated threads usable', async () => {
    const model = new OverflowModel(false)
    const harness = createHarness(model)
    await runTurn(harness, 'affected', 'seed')
    await expect(runTurn(harness, 'affected', 'overflow twice')).resolves.toBe('failed')
    expect(model.calls.get('affected')).toBe(3)
    await expect(runTurn(harness, 'unrelated', 'continue elsewhere')).resolves.toBe('completed')
    expect(model.calls.get('unrelated')).toBe(1)
    expect(harness.eventBus.snapshotSince('affected', 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error',
        code: 'context_window_exceeded',
        severity: 'error'
      })
    ]))
  })
})

function createHarness(model: ModelClient) {
  const sessionStore = new InMemorySessionStore()
  const threadStore = new InMemoryThreadStore()
  const eventBus = new InMemoryEventBus()
  const inflight = new InflightTracker()
  const steering = new SteeringQueue()
  const ids = new SequentialIdGenerator()
  const nowIso = () => '2026-08-11T00:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const compactor = new ContextCompactor()
  const turns = new TurnService({
    threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
  })
  const loop = new AgentLoop({
    threadStore,
    sessionStore,
    approvalGate: { request: async () => 'allow' } as never,
    userInputGate: {} as never,
    model,
    toolHost: new LocalToolHost({ tools: [] }),
    usage: new UsageService(),
    events,
    turns,
    inflight,
    steering,
    compactor,
    prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
    ids,
    nowIso
  })
  return { sessionStore, threadStore, eventBus, turns, loop, model }
}

async function runTurn(
  harness: ReturnType<typeof createHarness>,
  threadId: string,
  prompt: string
) {
  if (!await harness.threadStore.get(threadId)) {
    await harness.threadStore.upsert(createThreadRecord({
      id: threadId,
      title: threadId,
      workspace: '/tmp/workspace',
      model: harness.model.model
    }))
  }
  const started = await harness.turns.startTurn({
    threadId,
    request: { prompt, model: harness.model.model }
  })
  return harness.loop.runTurn(threadId, started.turnId)
}
