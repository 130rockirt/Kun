import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { SubagentsCapabilityConfig } from '../contracts/capabilities.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { createThreadRecord } from '../domain/thread.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import { createChildAgentExecutor } from './child-agent-executor.js'
import { DelegationRuntime, FileDelegationStore } from './delegation-runtime.js'
import type { ChildRunExecutor } from './delegation-runtime.js'

class HangingModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'test-model'
  readonly requests: ModelRequest[] = []
  private resolveRequest: (() => void) | undefined
  readonly requestStarted = new Promise<void>((resolve) => {
    this.resolveRequest = resolve
  })

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    this.resolveRequest?.()
    await new Promise<void>((resolve) => {
      if (request.abortSignal.aborted) {
        resolve()
        return
      }
      request.abortSignal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (!request.abortSignal.aborted) {
      yield { kind: 'usage', usage: emptyUsageSnapshot() }
      yield { kind: 'completed', stopReason: 'stop' }
    }
  }
}

describe('DelegationRuntime resume handling', () => {
  it('appends a follow-up turn to the same persisted child snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-delegation-resume-'))
    try {
      const calls: Parameters<ChildRunExecutor>[0][] = []
      const store = new FileDelegationStore(dir)
      const runtime = new DelegationRuntime({
        config: subagentConfig(),
        store,
        idGenerator: () => 'child_ppt',
        nowIso: (() => {
          let tick = 0
          return () => `2026-07-04T00:00:0${tick++}.000Z`
        })(),
        executor: async (input) => {
          calls.push(input)
          return {
            summary: input.resumeChild ? 'revised' : 'initial',
            reviewBundle: { revision: input.resumeChild ? 2 : 1 }
          }
        }
      })
      const first = await runtime.runChild({
        parentThreadId: 'parent',
        parentTurnId: 'turn-1',
        label: 'PPT review',
        prompt: 'generate previews',
        workspace: '/workspace',
        inlineProfile: {
          id: 'ppt',
          source: 'builtin',
          profile: {
            mode: 'subagent',
            toolPolicy: 'inherit',
            allowedTools: ['generate_image'],
            systemPrompt: 'PPT child'
          }
        },
        security: { sandboxRoot: '/workspace', memoryEnabled: false },
        signal: new AbortController().signal
      })
      const resumed = await runtime.resumeChild({
        childId: first.id,
        parentThreadId: 'parent',
        parentTurnId: 'turn-2',
        prompt: 'revise slide 2',
        signal: new AbortController().signal
      })

      expect(first.id).toBe('child_ppt')
      expect(resumed).toMatchObject({
        id: 'child_ppt',
        parentTurnId: 'turn-2',
        prompt: 'revise slide 2',
        summary: 'revised',
        resumeCount: 1,
        reviewBundle: { revision: 2 }
      })
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({
        resumeChild: true,
        childId: 'child_ppt',
        parentThreadId: 'parent',
        parentTurnId: 'turn-2',
        workspace: '/workspace',
        systemPrompt: 'PPT child',
        allowedTools: ['generate_image']
      })
      expect((await store.list('parent'))).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects concurrent follow-ups for the same persistent child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-delegation-resume-lock-'))
    try {
      let releaseResume = (): void => undefined
      const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve })
      const runtime = new DelegationRuntime({
        config: subagentConfig(),
        store: new FileDelegationStore(dir),
        idGenerator: () => 'child_ppt_lock',
        executor: async (input) => {
          if (input.resumeChild) await resumeGate
          return { summary: input.resumeChild ? 'revised' : 'initial' }
        }
      })
      const first = await runtime.runChild({
        parentThreadId: 'parent',
        parentTurnId: 'turn-1',
        prompt: 'generate previews',
        workspace: '/workspace',
        inlineProfile: {
          id: 'ppt',
          source: 'builtin',
          profile: { mode: 'subagent', toolPolicy: 'inherit' }
        },
        security: { sandboxRoot: '/workspace', memoryEnabled: false },
        signal: new AbortController().signal
      })
      const running = runtime.resumeChild({
        childId: first.id,
        parentThreadId: 'parent',
        parentTurnId: 'turn-2',
        prompt: 'first follow-up',
        signal: new AbortController().signal
      })
      await expect(runtime.resumeChild({
        childId: first.id,
        parentThreadId: 'parent',
        parentTurnId: 'turn-3',
        prompt: 'racing follow-up',
        signal: new AbortController().signal
      })).rejects.toThrow('is still running')
      releaseResume()
      await expect(running).resolves.toMatchObject({ summary: 'revised', resumeCount: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('createChildAgentExecutor abort handling', () => {
  it('connects the parent signal to the child turn interrupt', async () => {
    const model = new HangingModel()
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry() }),
      prefix: createImmutablePrefix({ systemPrompt: 'You are Kun.' }),
      defaultModel: 'test-model'
    })
    const parent = new AbortController()
    const run = executor({
      childId: 'child',
      parentThreadId: 'parent',
      parentTurnId: 'turn',
      prompt: 'work until interrupted',
      toolPolicy: 'inherit',
      signal: parent.signal
    })

    await model.requestStarted
    parent.abort()

    await expect(run).rejects.toThrow('Child agent aborted.')
    expect(model.requests[0].abortSignal.aborted).toBe(true)
  })
})

function subagentConfig() {
  return SubagentsCapabilityConfig.parse({
    enabled: true,
    maxParallel: 1,
    maxChildRuns: 10
  })
}

function makeRuntime(dir: string): {
  runtime: DelegationRuntime
  threadStore: InMemoryThreadStore
  turns: TurnService
} {
  const nowIso = () => '2026-07-04T00:00:00.000Z'
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
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
  const runtime = new DelegationRuntime({
    config: subagentConfig(),
    store: new FileDelegationStore(dir),
    events,
    threadStore,
    turns,
    nowIso,
    executor: async () => ({
      summary: 'done'
    })
  })
  return { runtime, threadStore, turns }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
