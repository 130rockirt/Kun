import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { LocalToolHost, echoTool, type LocalTool } from '../adapters/tool/local-tool-host.js'
import { InMemoryArtifactStore } from '../artifacts/artifact-store.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { DEFAULT_GRAPH_RUNTIME_CONFIG } from '../config/kun-config.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { createThreadRecord } from '../domain/thread.js'
import type { ApprovalRequest } from '../domain/approval.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'
import { ContextCompactor } from './context-compactor.js'
import {
  AgentLoop,
  buildRuntimeContextInstruction,
  isStalePlanContext,
  resolvePlanModeToolSpecs,
  shouldInjectInitialRuntimeContext,
  svgArtifactCompletionState,
  turnHasUnverifiedSourceChanges
} from './agent-loop.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import type { ModelClient, ModelRequest, ModelStreamChunk, ModelToolSpec } from '../ports/model-client.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../ports/user-input-gate.js'
import { GraphRuntimeComposition } from '../server/graph-runtime-factory.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import { UsageService } from '../services/usage-service.js'

class AllowApprovalGate {
  request(_approval: ApprovalRequest): Promise<'allow' | 'deny'> {
    return Promise.resolve('allow')
  }

  decide(): boolean {
    return false
  }

  reserveDecision(): boolean {
    return false
  }

  commitDecision(): boolean {
    return false
  }

  rollbackDecision(): boolean {
    return false
  }

  expire(): boolean {
    return false
  }

  pending(): ApprovalRequest[] {
    return []
  }

  get(): ApprovalRequest | undefined {
    return undefined
  }
}

class NoopUserInputGate implements UserInputGate {
  request(_input: UserInputRequest): Promise<UserInputResolution> {
    return Promise.resolve({ status: 'cancelled' })
  }

  get(): UserInputRequest | undefined {
    return undefined
  }

  claimResolution() {
    return undefined
  }

  resolve(): boolean {
    return false
  }

  pending(): UserInputRequest[] {
    return []
  }

  reset(): void {}
}

class AbortAwareModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'abort-aware-model'
  readonly requests: ModelRequest[] = []
  abortObserved = false
  private readonly streamStartedListeners: Array<() => void> = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    for (const listener of this.streamStartedListeners.splice(0)) listener()
    if (!request.abortSignal.aborted) {
      await new Promise<void>((resolve) => {
        request.abortSignal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    this.abortObserved = request.abortSignal.aborted
    for (const chunk of [] as ModelStreamChunk[]) yield chunk
  }

  waitForStreamStart(): Promise<void> {
    if (this.requests.length > 0) return Promise.resolve()
    return new Promise((resolve) => this.streamStartedListeners.push(resolve))
  }
}

class RepeatingToolModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'repeating-tool-model'
  private calls = 0

  async *stream(): AsyncIterable<ModelStreamChunk> {
    this.calls += 1
    yield {
      kind: 'tool_call_complete',
      callId: `call_${this.calls}`,
      toolName: 'echo',
      arguments: { text: 'again' }
    }
    yield { kind: 'completed', stopReason: 'tool_calls' }
  }
}

class AlternatingGraphLeadToolModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'alternating-graph-lead-tool-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    const sequence = this.requests.length
    const controlStep = sequence % 2 === 1
    yield {
      kind: 'tool_call_complete',
      callId: `graph_lead_call_${sequence}`,
      toolName: controlStep ? 'graph_control_run' : 'graph_supervise_node',
      arguments: {
        action: controlStep ? 'inspect' : 'overview',
        sequence
      }
    }
    yield { kind: 'completed', stopReason: 'tool_calls' }
  }
}

class HangingGraphLeadModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'hanging-graph-lead-model'
  readonly requests: ModelRequest[] = []
  private markStarted: (() => void) | undefined
  private readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    this.markStarted?.()
    if (!request.abortSignal.aborted) {
      await new Promise<void>((resolve) => {
        request.abortSignal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    for (const chunk of [] as ModelStreamChunk[]) yield chunk
  }

  waitForStart(): Promise<void> {
    return this.started
  }
}

class CapturingCompleteModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'capturing-complete-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: 'Done.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class RecoverableGraphStreamModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'recoverable-graph-stream-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield { kind: 'assistant_text_delta', text: 'Partial Graph supervision update.' }
      yield {
        kind: 'error',
        message: 'model stream read failed: terminated',
        code: 'stream_read_error',
        failure: { category: 'network', failoverAllowed: true }
      }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'Recovered Graph final response.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class ScriptedGraphModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'scripted-graph-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield {
        kind: 'assistant_text_delta',
        text: 'Graph validation failed, so the run was not started.'
      }
      yield { kind: 'completed', stopReason: 'stop' }
      return
    }
    if (this.requests.length === 2) {
      yield {
        kind: 'tool_call_complete',
        callId: 'graph_define_call',
        toolName: 'graph_define_plan',
        arguments: { plan: { tasks: [] } }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'GraphRun started.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class ScriptedInvalidGraphModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'scripted-invalid-graph-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (this.requests.length <= 2) {
      yield {
        kind: 'tool_call_complete',
        callId: `graph_define_call_${this.requests.length}`,
        toolName: 'graph_define_plan',
        arguments: this.requests.length === 1
          ? { plan: {} }
          : { plan: { valid: true } }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'GraphRun started after correction.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class TruncatedRawGraphPlanModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'truncated-raw-graph-plan-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (this.requests.length <= 2) {
      yield {
        kind: 'tool_call_complete',
        callId: `graph_define_raw_recovery_${this.requests.length}`,
        toolName: 'graph_define_plan',
        arguments: this.requests.length === 1
          ? { __raw: '{"plan":{"title":"truncated-private-marker","tasks":[' }
          : {
              plan: {
                title: 'Implement the requested Graph change',
                tasks: [{
                  key: 'implement',
                  kind: 'work',
                  title: 'Implement and verify the change',
                  objective: 'Implement the requested change and verify its behavior.',
                  dependsOn: [],
                  dataFrom: [],
                  acceptanceCriteria: ['The requested behavior is implemented and verified.'],
                  readScopes: ['.'],
                  writeScopes: ['src']
                }],
                completionTaskKeys: ['implement']
              }
            }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'The durable GraphRun is now active.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class FinalResponseGateModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'final-response-gate-model'
  readonly requests: ModelRequest[] = []
  private releaseFirstResponse: (() => void) | undefined
  private markFirstStarted: (() => void) | undefined
  private readonly firstResponseStarted = new Promise<void>((resolve) => {
    this.markFirstStarted = resolve
  })
  private readonly firstResponseReleased = new Promise<void>((resolve) => {
    this.releaseFirstResponse = resolve
  })

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      this.markFirstStarted?.()
      await this.firstResponseReleased
    }
    yield { kind: 'assistant_text_delta', text: `response ${this.requests.length}` }
    yield { kind: 'completed', stopReason: 'stop' }
  }

  waitForFirstResponse(): Promise<void> {
    return this.firstResponseStarted
  }

  release(): void {
    this.releaseFirstResponse?.()
  }
}

class RoutedFailureModel implements ModelClient {
  readonly provider = 'compat-multi'
  readonly model = 'gpt-5.3-codex-spark'
  readonly config = {
    model: this.model,
    baseUrl: 'https://chatgpt.example/codex',
    endpointFormat: 'custom_endpoint'
  }
  request?: ModelRequest

  configFor(providerId?: string) {
    if (providerId !== 'deepseek') throw new Error(`unknown model provider: ${providerId}`)
    return {
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions'
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.request = request
    yield* [] as ModelStreamChunk[]
    throw new Error('upstream transport failed')
  }
}

type SvgModelAction = 'stop' | 'edit' | 'validate'

class ScriptedSvgModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'scripted-svg-model'
  readonly requests: ModelRequest[] = []
  private index = 0

  constructor(private readonly actions: readonly SvgModelAction[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    const action = this.actions[this.index] ?? 'stop'
    this.index += 1
    if (action !== 'stop') {
      yield {
        kind: 'tool_call_complete',
        callId: `${action}_${this.index}`,
        toolName: action === 'edit' ? 'design_svg_edit' : 'design_svg_validate',
        arguments: { attempt: this.index }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'Done.' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

function svgGateTool(
  name: 'design_svg_edit' | 'design_svg_validate' | 'write',
  result: { output: unknown; isError?: boolean }
): LocalTool {
  return LocalToolHost.defineTool({
    name,
    description: name,
    inputSchema: { type: 'object', additionalProperties: true },
    toolKind: name === 'design_svg_validate' ? 'tool_call' : 'file_change',
    policy: 'auto',
    shouldAdvertise: (context) => context.guiDesignArtifact?.kind === 'svg',
    execute: async () => result
  })
}

async function svgLoopHarness(input: {
  model: ModelClient
  tools: LocalTool[]
  skillRuntime?: ConstructorParameters<typeof AgentLoop>[0]['skillRuntime']
}) {
  const sessionStore = new InMemorySessionStore()
  const threadStore = new InMemoryThreadStore()
  const eventBus = new InMemoryEventBus()
  const inflight = new InflightTracker()
  const steering = new SteeringQueue()
  const ids = new SequentialIdGenerator()
  const nowIso = () => '2026-07-10T00:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
  })
  const turns = new TurnService({
    threadStore, sessionStore, events, inflight, steering, compactor: new ContextCompactor(), ids, nowIso
  })
  const loop = new AgentLoop({
    threadStore,
    sessionStore,
    approvalGate: new AllowApprovalGate(),
    userInputGate: new NoopUserInputGate(),
    model: input.model,
    toolHost: new LocalToolHost({ tools: input.tools }),
    usage: new UsageService(),
    events,
    turns,
    inflight,
    steering,
    compactor: new ContextCompactor(),
    prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
    ids,
    nowIso,
    ...(input.skillRuntime ? { skillRuntime: input.skillRuntime } : {})
  })
  const threadId = 'thr_svg_gate'
  await threadStore.upsert(createThreadRecord({
    id: threadId,
    title: 'SVG gate',
    workspace: '/tmp/workspace',
    model: input.model.model,
    mode: 'plan'
  }))
  const started = await turns.startTurn({
    threadId,
    request: {
      prompt: 'make the reserved svg',
      model: input.model.model,
      guiDesignCanvas: true,
      guiDesignMode: true,
      guiDesignArtifact: {
        kind: 'svg', artifactId: 'motion', relativePath: '.kun-design/doc/motion/v1.svg'
      }
    }
  })
  return { loop, sessionStore, threadId, turnId: started.turnId }
}

describe('AgentLoop interruption', () => {
  it('materializes a stable active-goal history item before the native model request', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-08-06T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new CapturingCompleteModel()
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor: new ContextCompactor(), ids, nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'thr_native_goal_context'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Native goal context',
      workspace: '/tmp/workspace',
      model: model.model,
      goal: {
        threadId,
        objective: 'Keep this goal as stable history.',
        status: 'active',
        tokenBudget: 321,
        tokensUsed: 19,
        timeUsedSeconds: 7,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    }))
    const started = await turns.startTurn({
      threadId,
      request: { prompt: 'Continue the goal.', model: model.model }
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')

    expect(model.requests.length).toBeGreaterThan(0)
    expect(model.requests[0]?.history.map((item) => item.kind)).toEqual([
      'user_message',
      'goal_context'
    ])
    const goalContext = model.requests[0]?.history[1]
    expect(goalContext).toMatchObject({
      kind: 'goal_context',
      text: expect.stringContaining('Keep this goal as stable history.')
    })
    if (!goalContext || goalContext.kind !== 'goal_context') {
      throw new Error('expected goal context in model history')
    }
    expect(goalContext.text).not.toContain('Tokens used')
    expect(model.requests[0]?.contextInstructions?.join('\n') ?? '').not.toContain('active thread goal')
    expect(model.requests.every((request) =>
      request.history.filter((item) => item.kind === 'goal_context').length === 1
    )).toBe(true)
    expect((await threadStore.get(threadId))?.turns[0]?.items.some((item) => item.kind === 'goal_context'))
      .toBe(false)
  })

  it('continues after a final streamed response when steering was accepted mid-step', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-16T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new FinalResponseGateModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'thr_mid_turn_guidance'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Mid-turn guidance',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: { prompt: 'start with the original request', model: model.model }
    })

    const run = loop.runTurn(threadId, started.turnId)
    await model.waitForFirstResponse()
    await turns.steerTurn({
      threadId,
      turnId: started.turnId,
      text: 'use the compact logo instead',
      displayText: 'Use the compact logo instead'
    })
    model.release()

    await expect(run).resolves.toBe('completed')
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user_message',
        text: 'use the compact logo instead',
        displayText: 'Use the compact logo instead'
      })
    ]))
    // Turn finalization clears transient queue state, including its seal.
    expect(steering.isSealed(started.turnId)).toBe(false)
  })

  it('injects the Design intent policy as a system mode instruction on canvas turns', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-10T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new CapturingCompleteModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'thr_design_mode'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Design mode test',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: {
        prompt: '做一套完整 CRM',
        model: model.model,
        guiDesignCanvas: true,
        guiDesignMode: true
      }
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.modeInstruction).toContain('SINGLE SCREEN')
    expect(model.requests[0]?.modeInstruction).toContain('COMPLETE MULTI-SCREEN EXPERIENCE')
    expect(model.requests[0]?.modeInstruction).toContain('MODIFY EXISTING DESIGN')
    expect(model.requests[0]?.contextInstructions?.[0]).toContain(
      'Kun assembled the following dynamic context'
    )
    expect(model.requests[0]?.contextInstructions).toEqual(expect.arrayContaining([
      expect.stringContaining('<kun_context_block kind="runtime-context" authority="runtime">'),
      expect.stringContaining('Current opened project absolute path: `/tmp/workspace`')
    ]))
  })

  it('keeps the source turn active until its GraphRun is terminal (#1031)', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-26T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new ScriptedGraphModel()
    let graphTerminal = false
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async ({ threadId }) => threadId === 'thr_graph_mode'
        ? {
            runId: 'graph_run_1',
            lastEventSeq: graphTerminal ? 9 : 3,
            terminal: graphTerminal
          }
        : null,
      ids,
      nowIso
    })
    const graphTool = LocalToolHost.defineTool({
      name: 'graph_define_plan',
      description: 'Define and commit a validated Graph plan.',
      inputSchema: { type: 'object', additionalProperties: false },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { run: { id: 'graph_run_1', status: 'running' } } })
    })
    const graphControlTool = LocalToolHost.defineTool({
      name: 'graph_control_run',
      description: 'Control an existing GraphRun.',
      inputSchema: { type: 'object', additionalProperties: false },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { ok: true } })
    })
    const graphSuperviseTool = LocalToolHost.defineTool({
      name: 'graph_supervise_node',
      description: 'Inspect, wait for, or guide an active Graph worker.',
      inputSchema: { type: 'object', additionalProperties: false },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { ok: true } })
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({
        tools: [graphTool, graphControlTool, graphSuperviseTool]
      }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      turnLimits: { maxSteps: 2, maxWallTimeMs: 60_000 },
      ids,
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_graph_mode',
      title: 'Graph mode',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const graphTurn = await turns.startTurn({
      threadId: 'thr_graph_mode',
      request: {
        prompt: 'Implement and verify the feature.',
        model: model.model,
        orchestration: 'graph'
      }
    })

    await expect(loop.runTurn('thr_graph_mode', graphTurn.turnId)).resolves.toBe('suspended')
    expect((await turns.getTurn('thr_graph_mode', graphTurn.turnId))?.status).toBe('running')
    expect(turns.isTurnExecutionActive(graphTurn.turnId)).toBe(false)
    expect(eventBus.snapshotSince('thr_graph_mode', 0)
      .some((event) => event.kind === 'turn_completed')).toBe(false)
    expect(eventBus.snapshotSince('thr_graph_mode', 0)
      .some((event) => event.kind === 'error' && event.code === 'turn_step_limit')).toBe(false)
    expect(model.requests).toHaveLength(3)
    expect(model.requests[0]?.requiredToolName).toBeUndefined()
    expect(model.requests[0]?.modeInstruction).toContain('Graph Mode is active')
    expect(model.requests[0]?.modeInstruction).toContain(
      'You are the source Graph Lead: the original main agent'
    )
    expect(model.requests[0]?.modeInstruction).toContain('## Required operating loop')
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(['graph_define_plan'])
    expect(model.requests[1]?.requiredToolName).toBeUndefined()
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toEqual(['graph_define_plan'])
    expect(model.requests[1]?.contextInstructions).toEqual(expect.arrayContaining([
      expect.stringContaining('did not call `graph_define_plan`')
    ]))
    expect(model.requests[2]?.requiredToolName).toBeUndefined()
    expect(model.requests[2]?.tools.map((tool) => tool.name)).toEqual([
      'graph_define_plan',
      'graph_control_run',
      'graph_supervise_node'
    ])
    expect(model.requests[2]?.modeInstruction).toContain(
      'You are the source Graph Lead: the original main agent'
    )
    expect(model.requests[2]?.modeInstruction).toContain(
      'Use `graph_supervise_node overview`'
    )
    expect(model.requests[2]?.modeInstruction).toContain(
      'Do not treat dispatch or one milestone as completion'
    )
    expect(model.requests[2]?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool_result',
        toolName: 'graph_define_plan'
      })
    ]))

    graphTerminal = true
    await turns.resumeGraphLeadTurn({
      threadId: 'thr_graph_mode',
      turnId: graphTurn.turnId,
      runId: 'graph_run_1',
      lastDeliveredSeq: 9,
      terminal: true
    })
    await turns.steerTurn({
      threadId: 'thr_graph_mode',
      turnId: graphTurn.turnId,
      text: 'Present the persisted final Graph result.',
      messageSource: 'graph_runtime'
    })
    await expect(loop.runTurn('thr_graph_mode', graphTurn.turnId)).resolves.toBe('completed')
    expect((await turns.getTurn('thr_graph_mode', graphTurn.turnId))?.status).toBe('completed')
    expect(eventBus.snapshotSince('thr_graph_mode', 0)
      .some((event) => event.kind === 'turn_completed')).toBe(true)

    const directModel = new CapturingCompleteModel()
    const directLoop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model: directModel,
      toolHost: new LocalToolHost({ tools: [graphTool] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_direct_mode',
      title: 'Direct mode',
      workspace: '/tmp/workspace',
      model: directModel.model
    }))
    const directTurn = await turns.startTurn({
      threadId: 'thr_direct_mode',
      request: {
        prompt: 'Answer directly.',
        model: directModel.model,
        orchestration: 'direct'
      }
    })
    await expect(directLoop.runTurn('thr_direct_mode', directTurn.turnId))
      .resolves.toBe('completed')
    expect(directModel.requests[0]?.requiredToolName).toBeUndefined()
    expect(directModel.requests[0]?.tools.map((tool) => tool.name))
      .not.toContain('graph_create_run')
  })

  it('parks a nonterminal Graph Lead episode after eight alternating tool steps', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-30T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new AlternatingGraphLeadToolModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async () => ({
        runId: 'graph_run_bounded_episode',
        lastEventSeq: 12,
        terminal: false,
        supervisionPending: true
      }),
      ids,
      nowIso
    })
    const graphToolSchema = {
      type: 'object',
      properties: {
        action: { type: 'string' },
        sequence: { type: 'number' }
      },
      required: ['action', 'sequence'],
      additionalProperties: false
    } as const
    const graphControlTool = LocalToolHost.defineTool({
      name: 'graph_control_run',
      description: 'Inspect a GraphRun.',
      inputSchema: graphToolSchema,
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { ok: true } })
    })
    const graphSuperviseTool = LocalToolHost.defineTool({
      name: 'graph_supervise_node',
      description: 'Inspect a Graph worker.',
      inputSchema: graphToolSchema,
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { ok: true } })
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [graphControlTool, graphSuperviseTool] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      turnLimits: { maxSteps: 1, maxWallTimeMs: 60_000 },
      ids,
      nowIso
    })
    const threadId = 'thr_graph_bounded_lead_episode'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Bounded Graph Lead episode',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: {
        prompt: 'Supervise the durable GraphRun.',
        model: model.model,
        orchestration: 'graph'
      }
    })
    await turns.resumeGraphLeadTurn({
      threadId,
      turnId: started.turnId,
      runId: 'graph_run_bounded_episode',
      lastDeliveredSeq: 12,
      terminal: false
    })

    const suspendGraphLeadTurn = turns.suspendGraphLeadTurn.bind(turns)
    const suspensionInputs: Parameters<TurnService['suspendGraphLeadTurn']>[0][] = []
    turns.suspendGraphLeadTurn = async (input) => {
      suspensionInputs.push(input)
      return suspendGraphLeadTurn(input)
    }
    const finishTurn = turns.finishTurn.bind(turns)
    let finishTurnCalls = 0
    turns.finishTurn = async (input) => {
      finishTurnCalls += 1
      return finishTurn(input)
    }

    await expect(loop.runTurn(threadId, started.turnId))
      .resolves.toBe('suspended_pending_supervision')

    expect(model.requests).toHaveLength(8)
    expect(suspensionInputs).toEqual([
      {
        threadId,
        turnId: started.turnId,
        force: true,
        preserveDeliveryCursor: true,
        allowPendingSupervision: true
      }
    ])
    expect(finishTurnCalls).toBe(0)
    expect((await turns.getTurn(threadId, started.turnId))?.status).toBe('running')
    expect(turns.isTurnExecutionActive(started.turnId)).toBe(false)
    expect(eventBus.snapshotSince(threadId, 0).some((event) =>
      event.kind === 'turn_completed' ||
      event.kind === 'turn_failed' ||
      (event.kind === 'error' && event.code === 'turn_step_limit')
    )).toBe(false)
  })

  it('aborts and parks a Graph Lead model step at the episode elapsed-time limit', async () => {
    vi.useFakeTimers()
    try {
      const sessionStore = new InMemorySessionStore()
      const threadStore = new InMemoryThreadStore()
      const eventBus = new InMemoryEventBus()
      const inflight = new InflightTracker()
      const steering = new SteeringQueue()
      const ids = new SequentialIdGenerator()
      const nowIso = () => '2026-07-30T00:00:00.000Z'
      const events = new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      })
      const model = new HangingGraphLeadModel()
      const turns = new TurnService({
        threadStore,
        sessionStore,
        events,
        inflight,
        steering,
        compactor: new ContextCompactor(),
        resolveGraphLeadRun: async () => ({
          runId: 'graph_run_elapsed_episode',
          lastEventSeq: 4,
          terminal: false,
          supervisionPending: true
        }),
        ids,
        nowIso
      })
      const loop = new AgentLoop({
        threadStore,
        sessionStore,
        approvalGate: new AllowApprovalGate(),
        userInputGate: new NoopUserInputGate(),
        model,
        toolHost: new LocalToolHost({ tools: [] }),
        usage: new UsageService(),
        events,
        turns,
        inflight,
        steering,
        compactor: new ContextCompactor(),
        prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
        ids,
        nowIso
      })
      const threadId = 'thr_graph_elapsed_lead_episode'
      await threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Elapsed Graph Lead episode',
        workspace: '/tmp/workspace',
        model: model.model
      }))
      const started = await turns.startTurn({
        threadId,
        request: {
          prompt: 'Supervise without hanging forever.',
          model: model.model,
          orchestration: 'graph'
        }
      })
      await turns.resumeGraphLeadTurn({
        threadId,
        turnId: started.turnId,
        runId: 'graph_run_elapsed_episode',
        lastDeliveredSeq: 4,
        terminal: false
      })

      const finishTurn = turns.finishTurn.bind(turns)
      let finishTurnCalls = 0
      turns.finishTurn = async (input) => {
        finishTurnCalls += 1
        return finishTurn(input)
      }

      const run = loop.runTurn(threadId, started.turnId)
      await model.waitForStart()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      await expect(run).resolves.toBe('suspended_pending_supervision')
      expect(model.requests).toHaveLength(1)
      expect(model.requests[0]?.abortSignal.aborted).toBe(true)
      expect(finishTurnCalls).toBe(0)
      expect((await turns.getTurn(threadId, started.turnId))?.status).toBe('running')
      expect(turns.isTurnExecutionActive(started.turnId)).toBe(false)
      expect(eventBus.snapshotSince(threadId, 0).some((event) =>
        event.kind === 'turn_completed' ||
        event.kind === 'turn_failed' ||
        event.kind === 'error'
      )).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('parks and resumes the same Graph source turn after a committed stream read failure', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-30T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new RecoverableGraphStreamModel()
    let graphTerminal = false
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      resolveGraphLeadRun: async () => ({
        runId: 'graph_run_stream_recovery',
        lastEventSeq: graphTerminal ? 8 : 4,
        terminal: graphTerminal
      }),
      ids,
      nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'thr_graph_stream_recovery'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Graph stream recovery',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: {
        prompt: 'Keep supervising this Graph until it is complete.',
        model: model.model,
        orchestration: 'graph'
      }
    })

    const suspendGraphLeadTurn = turns.suspendGraphLeadTurn.bind(turns)
    let parkedTurn: Awaited<ReturnType<TurnService['getTurn']>> | undefined
    let parkedItems: Awaited<ReturnType<InMemorySessionStore['loadItems']>> = []
    let executionReleasedBeforeWake = false
    let turnFailedBeforeWake = false
    let racedContinuation: ReturnType<AgentLoop['runTurn']> | undefined
    turns.suspendGraphLeadTurn = async (input) => {
      const outcome = await suspendGraphLeadTurn(input)
      if (outcome !== 'suspended' || racedContinuation) return outcome
      parkedTurn = await turns.getTurn(threadId, started.turnId)
      parkedItems = await sessionStore.loadItems(threadId)
      executionReleasedBeforeWake = !turns.isTurnExecutionActive(started.turnId)
      turnFailedBeforeWake = eventBus.snapshotSince(threadId, 0)
        .some((event) => event.kind === 'turn_failed')

      // Reacquire the lease and invoke runTurn before the old suspended
      // promise has left AgentLoop.activeTurnRuns. The wake-up must chain a
      // fresh runner after that promise settles instead of losing the lease.
      graphTerminal = true
      await turns.resumeGraphLeadTurn({
        threadId,
        turnId: started.turnId,
        runId: 'graph_run_stream_recovery',
        lastDeliveredSeq: 8,
        terminal: true
      })
      await turns.steerTurn({
        threadId,
        turnId: started.turnId,
        text: 'Continue in Graph mode and deliver the final result.'
      })
      racedContinuation = loop.runTurn(threadId, started.turnId)
      return outcome
    }

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('suspended')
    expect(parkedTurn).toMatchObject({
      id: started.turnId,
      status: 'running',
      orchestration: 'graph',
      graphLeadLifecycle: {
        runId: 'graph_run_stream_recovery',
        state: 'supervising',
        // Parking a failed episode must not acknowledge events that were not
        // delivered through an explicit Graph Lead resume snapshot.
        lastDeliveredSeq: 0
      }
    })
    expect(executionReleasedBeforeWake).toBe(true)
    expect(parkedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error',
        code: 'stream_read_error',
        message: 'model stream read failed: terminated'
      })
    ]))
    expect(parkedItems.filter((item) =>
      item.kind === 'assistant_text' &&
      item.text === 'Partial Graph supervision update.'
    )).toHaveLength(1)
    expect(turnFailedBeforeWake).toBe(false)

    expect(racedContinuation).toBeDefined()
    await expect(racedContinuation!).resolves.toBe('completed')
    expect((await turns.getTurn(threadId, started.turnId))?.status).toBe('completed')
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.modeInstruction).toContain('Graph Mode is active')
    expect(model.requests[1]?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user_message',
        text: 'Continue in Graph mode and deliver the final result.'
      })
    ]))
  })

  it('parks the planning draft without a terminal error when the model cannot call tools', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-28T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new CapturingCompleteModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      createGraphPlanningDraft: async () => ({
        version: 1,
        draftId: 'draft_unsupported',
        reservedRunId: 'run_unsupported',
        state: 'planning',
        draftRevision: 1
      }),
      transitionGraphPlanningDraft: async ({ action }) => ({
        version: 1,
        draftId: 'draft_unsupported',
        reservedRunId: 'run_unsupported',
        state: action === 'suspend' ? 'needs_correction' : 'planning',
        draftRevision: 2
      }),
      ids,
      nowIso
    })
    const graphTool = LocalToolHost.defineTool({
      name: 'graph_define_plan',
      description: 'Define and commit a validated Graph plan.',
      inputSchema: { type: 'object', additionalProperties: false },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { run: { id: 'graph_run_unsupported' } } })
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [graphTool] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso,
      modelCapabilities: (modelId) => ({
        id: modelId,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: false,
        messageParts: ['text']
      })
    })
    const threadId = 'thr_graph_unsupported'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Unsupported Graph mode',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: {
        prompt: 'Create a graph.',
        model: model.model,
        orchestration: 'graph'
      }
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('suspended')
    expect(model.requests).toHaveLength(2)
    expect(model.requests.every((request) => request.requiredToolName === undefined)).toBe(true)
    expect(model.requests[1]?.contextInstructions).toEqual(expect.arrayContaining([
      expect.stringContaining('did not call `graph_define_plan`')
    ]))
    const turn = await turns.getTurn(threadId, started.turnId)
    expect(turn?.status).toBe('running')
    expect(turn?.graphPlanningLifecycle).toMatchObject({
      draftId: 'draft_unsupported',
      state: 'needs_correction'
    })
    const recorded = await sessionStore.loadEventsSince(threadId, 0)
    expect(recorded.some((event) => event.kind === 'error')).toBe(false)

    await turns.steerTurn({
      threadId,
      turnId: started.turnId,
      text: 'Continue the suspended Graph planning turn.'
    })
    expect(turns.isTurnExecutionActive(started.turnId)).toBe(true)
    expect(steering.peek(started.turnId)).toEqual([
      { text: 'Continue the suspended Graph planning turn.' }
    ])
    await turns.interruptTurn({ threadId, turnId: started.turnId })
  })

  it('recovers retryable invalid Graph creation through a single-tool correction round', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-27T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new ScriptedInvalidGraphModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const graphTool = LocalToolHost.defineTool({
      name: 'graph_define_plan',
      description: 'Define and commit a validated Graph plan.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: { valid: { type: 'boolean' } },
            required: ['valid'],
            additionalProperties: false
          }
        },
        required: ['plan'],
        additionalProperties: false
      },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async (args) => {
        const plan = args.plan as { valid?: unknown } | undefined
        return plan?.valid === true
          ? { output: { run: { id: 'graph_run_1', status: 'running' } } }
          : {
              output: {
                code: 'graph_plan_invalid',
                error: 'plan.valid is required',
                issues: [{ path: ['plan', 'valid'], code: 'invalid_type', message: 'Required' }],
                retryable: true,
                draft: { status: 'repairing' }
              },
              isError: true
            }
      }
    })
    const graphControlTool = LocalToolHost.defineTool({
      name: 'graph_control_run',
      description: 'Control an existing GraphRun.',
      inputSchema: { type: 'object', additionalProperties: false },
      toolKind: 'tool_call',
      policy: 'auto',
      shouldAdvertise: (context) => context.orchestration === 'graph',
      execute: async () => ({ output: { ok: true } })
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [graphTool, graphControlTool] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    await threadStore.upsert(createThreadRecord({
      id: 'thr_invalid_graph_mode',
      title: 'Invalid Graph mode',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const graphTurn = await turns.startTurn({
      threadId: 'thr_invalid_graph_mode',
      request: {
        prompt: 'Implement and verify the feature.',
        model: model.model,
        orchestration: 'graph'
      }
    })

    await expect(loop.runTurn('thr_invalid_graph_mode', graphTurn.turnId))
      .resolves.toBe('completed')
    expect(model.requests).toHaveLength(3)
    expect(model.requests[1]?.requiredToolName).toBeUndefined()
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toEqual(['graph_define_plan'])
    expect(model.requests[1]?.modeInstruction).toContain('structured issues')
    expect(model.requests[1]?.modeInstruction).toContain('repository-relative paths')
    expect(model.requests[1]?.modeInstruction).toContain('actual next tool arguments')
    expect(model.requests[1]?.modeInstruction).toContain('Explanatory prose')
    expect(model.requests[1]?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool_result',
        toolName: 'graph_define_plan',
        isError: true,
        output: expect.objectContaining({ retryable: true })
      })
    ]))
    expect(model.requests[2]?.requiredToolName).toBeUndefined()
  })

  it('recovers truncated raw Graph planning arguments into one durable runtime run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-agent-loop-graph-raw-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const sessionStore = new InMemorySessionStore()
      const threadStore = new InMemoryThreadStore()
      const eventBus = new InMemoryEventBus()
      const inflight = new InflightTracker()
      const steering = new SteeringQueue()
      const ids = new SequentialIdGenerator()
      const nowIso = () => '2026-08-09T00:00:00.000Z'
      const events = new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
        nowIso
      })
      const graphConfig = () => ({
        ...DEFAULT_GRAPH_RUNTIME_CONFIG,
        enabled: true
      })
      const graphRuntime = new GraphRuntimeComposition({
        dataDir: root,
        config: graphConfig,
        artifactStore: new InMemoryArtifactStore(),
        runtimeEvents: events,
        threadStore,
        sessionStore,
        ids,
        nowIso
      })
      const resolveGraphLeadRun = async (input: { threadId: string; turnId: string }) => {
        const run = (await graphRuntime.store.list({ threadId: input.threadId }))
          .find((candidate) => candidate.sourceTurnId === input.turnId)
        return run
          ? {
              runId: run.id,
              lastEventSeq: run.lastEventSeq,
              terminal: run.status === 'completed' ||
                run.status === 'failed' ||
                run.status === 'cancelled'
            }
          : null
      }
      const turns = new TurnService({
        threadStore,
        sessionStore,
        events,
        inflight,
        steering,
        compactor: new ContextCompactor(),
        resolveGraphLeadRun,
        createGraphPlanningDraft: (input) => graphRuntime.createPlanningDraft(input),
        resolveGraphPlanningDraft: (input) => graphRuntime.resolvePlanningDraft(input),
        transitionGraphPlanningDraft: (input) => graphRuntime.transitionPlanningDraft(input),
        ids,
        nowIso
      })
      const graphDefineTool = graphRuntime.toolsProvider.tools.find(
        (tool) => tool.name === 'graph_define_plan'
      )
      if (!graphDefineTool) throw new Error('graph_define_plan tool is unavailable')
      const model = new TruncatedRawGraphPlanModel()
      const loop = new AgentLoop({
        threadStore,
        sessionStore,
        approvalGate: new AllowApprovalGate(),
        userInputGate: new NoopUserInputGate(),
        model,
        toolHost: new LocalToolHost({ tools: [graphDefineTool] }),
        usage: new UsageService(),
        events,
        turns,
        inflight,
        steering,
        compactor: new ContextCompactor(),
        prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
        ids,
        nowIso
      })
      const threadId = 'thr_graph_raw_recovery'
      await threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Graph raw argument recovery',
        workspace,
        model: model.model
      }))
      const started = await turns.startTurn({
        threadId,
        request: {
          prompt: 'Implement and verify the requested change as one durable Graph.',
          model: model.model,
          orchestration: 'graph'
        }
      })
      expect(await turns.getTurn(threadId, started.turnId)).toMatchObject({
        orchestration: 'graph',
        graphPlanningLifecycle: { state: 'planning' }
      })
      expect(await graphRuntime.control.list({ threadId })).toEqual([])

      await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('suspended')

      expect(model.requests).toHaveLength(3)
      expect(model.requests.slice(0, 2).every((request) =>
        request.requiredToolName === undefined &&
        request.tools.map((tool) => tool.name).join(',') === 'graph_define_plan'
      )).toBe(true)
      expect(model.requests.every((request) =>
        request.modeInstruction?.includes('Graph Mode is active') === true
      )).toBe(true)
      expect(model.requests[1]?.history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          toolName: 'graph_define_plan',
          isError: true,
          output: expect.objectContaining({
            code: 'graph_plan_invalid',
            retryable: true,
            issues: [expect.objectContaining({ code: 'incomplete_tool_arguments' })]
          })
        })
      ]))

      const items = await sessionStore.loadItems(threadId)
      const planCalls = items.filter((item) =>
        item.turnId === started.turnId &&
        item.kind === 'tool_call' &&
        item.toolName === 'graph_define_plan'
      )
      expect(planCalls).toHaveLength(2)
      expect(planCalls[0]).toMatchObject({
        arguments: {},
        summary: expect.stringMatching(/Incomplete tool arguments omitted \(\d+ UTF-8 bytes; sha256 [a-f0-9]{64}\)\./)
      })
      expect(planCalls[1]).toMatchObject({ arguments: { plan: expect.any(Object) } })
      expect(planCalls[1]?.kind === 'tool_call' && '__raw' in planCalls[1].arguments).toBe(false)
      const planResults = items.filter((item) =>
        item.turnId === started.turnId &&
        item.kind === 'tool_result' &&
        item.toolName === 'graph_define_plan'
      )
      expect(planResults).toHaveLength(2)
      expect(planResults.filter((item) => {
        if (item.kind !== 'tool_result' || !item.output || typeof item.output !== 'object') {
          return false
        }
        return item.isError === true &&
          (item.output as Record<string, unknown>).retryable === true
      })).toHaveLength(1)
      expect(JSON.stringify(planResults[0])).not.toContain('truncated-private-marker')
      expect(JSON.stringify(items)).not.toContain('truncated-private-marker')
      expect(JSON.stringify(model.requests[1]?.history)).not.toContain('truncated-private-marker')
      expect(planResults[1]).toMatchObject({
        isError: false,
        output: {
          status: 'committed',
          draft: { status: 'committed' },
          run: { status: 'running' }
        }
      })

      const drafts = await graphRuntime.drafts.list({ threadId })
      const runs = await graphRuntime.control.list({ threadId })
      expect(drafts).toHaveLength(1)
      expect(runs).toHaveLength(1)
      expect(drafts[0]).toMatchObject({
        sourceTurnId: started.turnId,
        status: 'committed',
        reservedRunId: runs[0]?.id,
        committedRunId: runs[0]?.id,
        repairCount: 1
      })
      expect(runs[0]).toMatchObject({
        sourceTurnId: started.turnId,
        threadId,
        status: 'running'
      })

      const persistedThread = await threadStore.get(threadId)
      expect(persistedThread?.turns).toHaveLength(1)
      expect(persistedThread?.turns[0]).toMatchObject({
        id: started.turnId,
        status: 'running',
        orchestration: 'graph',
        graphPlanningLifecycle: { state: 'committed' },
        graphLeadLifecycle: { runId: runs[0]?.id, state: 'supervising' }
      })
      expect(persistedThread?.turns.some((turn) => turn.orchestration === 'direct')).toBe(false)
      expect(turns.isTurnExecutionActive(started.turnId)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a dedicated SVG turn until mutation and matching validation succeed', async () => {
    const model = new ScriptedSvgModel(['stop', 'edit', 'validate', 'stop'])
    const harness = await svgLoopHarness({
      model,
      tools: [
        svgGateTool('design_svg_edit', { output: { ok: true, revision: 'rev_1' } }),
        svgGateTool('design_svg_validate', { output: { ok: true, revision: 'rev_1' } }),
        svgGateTool('write', { output: { ok: true } })
      ],
      skillRuntime: {
        resolveTurn: async () => ({
          activeSkillIds: ['unrelated-restricted-skill'],
          activations: [],
          instructions: [],
          injectedBytes: 0,
          allowedToolNames: ['read']
        })
      } as never
    })

    await expect(harness.loop.runTurn(harness.threadId, harness.turnId)).resolves.toBe('completed')
    expect(model.requests).toHaveLength(4)
    expect(model.requests[0].modeInstruction).toContain('dedicated Kun SVG artifact turn')
    expect(model.requests[0].modeInstruction).not.toContain('PLAN MODE')
    expect(model.requests[0].tools.map((tool) => tool.name)).toEqual([
      'design_svg_edit', 'design_svg_validate'
    ])
    expect(model.requests[2].requiredToolName).toBe('design_svg_validate')
    const items = await harness.sessionStore.loadItems(harness.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', code: 'required_svg_mutation_missing' })
    ]))
  })

  it('fails after three structured SVG calls make no completion progress', async () => {
    const model = new ScriptedSvgModel(['edit', 'edit', 'edit', 'stop'])
    const harness = await svgLoopHarness({
      model,
      tools: [
        svgGateTool('design_svg_edit', { output: { ok: false, error: 'bad edit' }, isError: true }),
        svgGateTool('design_svg_validate', { output: { ok: true, revision: 'unused' } })
      ]
    })

    await expect(harness.loop.runTurn(harness.threadId, harness.turnId)).resolves.toBe('failed')
    expect(model.requests).toHaveLength(3)
    const items = await harness.sessionStore.loadItems(harness.threadId)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', code: 'svg_completion_gate_exhausted' })
    ]))
  })

  it('aborts an in-flight model stream when the turn service interrupts the turn', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-08T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new AbortAwareModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'thr_interrupt'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Interrupt test',
      workspace: '/tmp/workspace',
      model: model.model
    }))
    const started = await turns.startTurn({
      threadId,
      request: { prompt: 'keep streaming until interrupted', model: model.model }
    })

    const run = loop.runTurn(threadId, started.turnId)
    await model.waitForStreamStart()
    const interrupted = await turns.interruptTurn({ threadId, turnId: started.turnId })
    const status = await Promise.race([
      run,
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 500))
    ])

    expect(interrupted.status).toBe('aborted')
    expect(status).toBe('aborted')
    expect(model.abortObserved).toBe(true)
    expect(steering.isSealed(started.turnId)).toBe(false)
    expect((await threadStore.get(threadId))?.status).toBe('idle')
    expect((await threadStore.get(threadId))?.turns[0]?.status).toBe('aborted')
  })

  it('fails a tool loop that exceeds the configured hard step limit', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-08T00:00:00.000Z'
    const events = new RuntimeEventRecorder({ eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso })
    const model = new RepeatingToolModel()
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor: new ContextCompactor(), ids, nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [echoTool] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso,
      turnLimits: { maxSteps: 2, maxWallTimeMs: 60_000 }
    })
    const threadId = 'thr_step_limit'
    await threadStore.upsert(createThreadRecord({ id: threadId, title: 'Step limit', workspace: '/tmp', model: model.model }))
    const started = await turns.startTurn({ threadId, request: { prompt: 'loop', model: model.model } })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('failed')
    const eventsAfter = await sessionStore.loadEventsSince(threadId, 0)
    expect(eventsAfter).toContainEqual(expect.objectContaining({ kind: 'error', code: 'turn_step_limit' }))
  })

  it('reports the effective routed model and provider instead of the runtime default', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const ids = new SequentialIdGenerator()
    const nowIso = () => '2026-07-11T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (id) => eventBus.allocateSeq(id),
      nowIso
    })
    const model = new RoutedFailureModel()
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      ids,
      nowIso
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: new AllowApprovalGate(),
      userInputGate: new NoopUserInputGate(),
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor: new ContextCompactor(),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      ids,
      nowIso
    })
    const threadId = 'child_routed_failure'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Routed child',
      workspace: '/tmp',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      accountId: 'account_extension'
    }))
    const started = await turns.startTurn({
      threadId,
      request: {
        prompt: 'fail accurately',
        model: 'deepseek-v4-pro',
        providerId: 'deepseek',
        accountId: 'account_extension'
      }
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('failed')
    const failed = (await threadStore.get(threadId))?.turns[0]
    expect(failed?.error).toContain('model=deepseek-v4-pro')
    expect(failed?.error).toContain('providerId=deepseek')
    expect(failed?.error).toContain('baseUrl=https://api.deepseek.com')
    expect(failed?.error).toContain('endpointFormat=chat_completions')
    expect(failed?.error).not.toContain('model=gpt-5.3-codex-spark')
    expect(model.request).toMatchObject({
      providerId: 'deepseek',
      accountId: 'account_extension'
    })
  })
})

function spec(name: string): ModelToolSpec {
  return {
    name,
    description: `Tool: ${name}`,
    toolKind: name === 'create_plan' || name === 'write' || name === 'edit'
      ? 'file_change'
      : 'tool_call',
    inputSchema: { type: 'object', properties: {} }
  }
}

function result(input: {
  id: string
  toolName: string
  toolKind: 'file_change' | 'command_execution'
  path?: string
  turnId?: string
  isError?: boolean
}) {
  return {
    id: input.id,
    threadId: 'thread_1',
    turnId: input.turnId ?? 'turn_1',
    role: 'tool' as const,
    kind: 'tool_result' as const,
    toolName: input.toolName,
    callId: `call_${input.id}`,
    toolKind: input.toolKind,
    output: input.path ? { relative_path: input.path } : {},
    isError: input.isError ?? false,
    status: 'completed' as const,
    createdAt: '2000-01-02T03:04:05.000Z'
  }
}

function svgResult(
  id: string,
  toolName: 'design_svg_edit' | 'design_svg_animate' | 'design_svg_validate',
  revision: string,
  options: { isError?: boolean; ok?: boolean; turnId?: string } = {}
) {
  return {
    id,
    threadId: 'thread_1',
    turnId: options.turnId ?? 'turn_1',
    role: 'tool' as const,
    kind: 'tool_result' as const,
    toolName,
    callId: `call_${id}`,
    toolKind: toolName === 'design_svg_validate' ? 'tool_call' as const : 'file_change' as const,
    output: { ok: options.ok ?? true, revision },
    isError: options.isError ?? false,
    status: 'completed' as const,
    createdAt: '2000-01-02T03:04:05.000Z'
  }
}

describe('svgArtifactCompletionState', () => {
  it('requires a successful mutation followed by matching-revision validation', () => {
    expect(svgArtifactCompletionState([
      svgResult('edit', 'design_svg_edit', 'r1'),
      svgResult('validate', 'design_svg_validate', 'r1')
    ], 'turn_1')).toMatchObject({
      mutationSucceeded: true,
      validationAfterMutation: true,
      mutationRevision: 'r1',
      validationRevision: 'r1'
    })
  })

  it('rejects validation before mutation, stale revisions, failed results, and other turns', () => {
    expect(svgArtifactCompletionState([
      svgResult('before', 'design_svg_validate', 'r0'),
      svgResult('failed', 'design_svg_edit', 'r1', { isError: true }),
      svgResult('other', 'design_svg_edit', 'r2', { turnId: 'turn_2' }),
      svgResult('edit', 'design_svg_animate', 'r2'),
      svgResult('stale', 'design_svg_validate', 'r1')
    ], 'turn_1')).toMatchObject({
      mutationSucceeded: true,
      validationAfterMutation: false,
      mutationRevision: 'r2',
      validationRevision: 'r1'
    })
  })
})

describe('turnHasUnverifiedSourceChanges', () => {
  it('flags an unverified source edit so the optional nudge can appear', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/app.ts' })
    ], 'turn_1')).toBe(true)
  })

  it('ignores non-source changes (docs/HTML written in write/design/SDD modes)', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'doc', toolName: 'write', toolKind: 'file_change', path: 'notes.md' }),
      result({ id: 'page', toolName: 'write', toolKind: 'file_change', path: '.kun-design/a/v1.html' })
    ], 'turn_1')).toBe(false)
  })

  it('ignores failed edits and create_plan artifacts', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'failed', toolName: 'edit', toolKind: 'file_change', path: 'src/a.ts', isError: true }),
      result({ id: 'plan', toolName: 'create_plan', toolKind: 'file_change', path: 'plan.md' })
    ], 'turn_1')).toBe(false)
  })

  it('clears after a verify_changes run and re-arms on the next source edit', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts' }),
      result({ id: 'verify', toolName: 'verify_changes', toolKind: 'command_execution' })
    ], 'turn_1')).toBe(false)

    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'write', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts' }),
      result({ id: 'verify', toolName: 'verify_changes', toolKind: 'command_execution' }),
      result({ id: 'repair', toolName: 'edit', toolKind: 'file_change', path: 'src/a.ts' })
    ], 'turn_1')).toBe(true)
  })

  it('ignores changes from other turns', () => {
    expect(turnHasUnverifiedSourceChanges([
      result({ id: 'other', toolName: 'write', toolKind: 'file_change', path: 'src/a.ts', turnId: 'turn_2' })
    ], 'turn_1')).toBe(false)
  })
})

const ALL_TOOLS: ModelToolSpec[] = [
  spec('read'),
  spec('write'),
  spec('edit'),
  spec('ls'),
  spec('glob'),
  spec('grep'),
  spec('bash'),
  spec('web_search'),
  spec('web_fetch'),
  spec('create_plan')
]

const READ_ONLY_TOOLS = new Set([
  'read', 'ls', 'glob', 'grep', 'web_search', 'web_fetch'
])

describe('isStalePlanContext', () => {
  it('treats a workspace-mismatched plan context as stale (the fork bug)', () => {
    // A fork keeps the source thread's workspace; a plan context pointing at a
    // different workspace must be ignored, not passed to create_plan.
    expect(isStalePlanContext({ workspaceRoot: '/work/a' }, '/work/b')).toBe(true)
  })

  it('keeps a matching plan context (normalizing trailing slash / case)', () => {
    expect(isStalePlanContext({ workspaceRoot: '/work/a' }, '/work/a')).toBe(false)
    expect(isStalePlanContext({ workspaceRoot: '/work/a/' }, '/work/a')).toBe(false)
    expect(isStalePlanContext({ workspaceRoot: '/Work/A' }, '/work/a')).toBe(false)
  })

  it('is not stale when there is no plan context', () => {
    expect(isStalePlanContext(undefined, '/work/a')).toBe(false)
  })
})

describe('resolvePlanModeToolSpecs', () => {
  it('keeps only read-only tools available while the plan is unsaved', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('ls')
    expect(names).toContain('glob')
    expect(names).toContain('grep')
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('create_plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('bash')
  })

  it('step 0: allows host-classified read-only MCP tools but not unknown calls', () => {
    const tools: ModelToolSpec[] = [
      { ...spec('mcp_read_resource'), sideEffect: 'read-only', providerKind: 'mcp' },
      { ...spec('mcp_call'), providerKind: 'mcp' },
      spec('create_plan')
    ]
    const result = resolvePlanModeToolSpecs(tools, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: new Set()
    })

    expect(result.map((tool) => tool.name)).toEqual(['mcp_read_resource', 'create_plan'])
  })

  it('step > 0: preserves investigation tools instead of forcing create_plan immediately', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((tool) => tool.name)).toEqual([
      'read',
      'ls',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'create_plan'
    ])
  })

  it('plan satisfied: keeps read-only tools but removes create_plan and mutation tools', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: true,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((tool) => tool.name)).toEqual([
      'read',
      'ls',
      'glob',
      'grep',
      'web_search',
      'web_fetch'
    ])
  })

  it('not plan-active: returns all tools unchanged (pass-through)', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: false,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result).toBe(ALL_TOOLS)
  })

  it('uses PLAN_READ_ONLY_TOOL_NAMES default when readOnlyToolNames omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0
    })
    const names = result.map((t) => t.name)
    // Default set excludes bash
    expect(names).not.toContain('bash')
    expect(names).toContain('create_plan')
    expect(names).toContain('read')
  })

  it('uses CREATE_PLAN_TOOL_NAME default when planToolName omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1
    })
    expect(result.map((tool) => tool.name)).toContain('create_plan')
  })

  it('custom readOnlyToolNames and planToolName', () => {
    const customTools: ModelToolSpec[] = [
      spec('custom-read'),
      spec('custom-plan'),
      spec('write'),
      spec('bash')
    ]
    const result = resolvePlanModeToolSpecs(customTools, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: new Set(['custom-read']),
      planToolName: 'custom-plan'
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('custom-read')
    expect(names).toContain('custom-plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  const WITH_INPUT_TOOLS: ModelToolSpec[] = [
    spec('read'),
    spec('write'),
    spec('create_plan'),
    spec('user_input'),
    spec('request_user_input')
  ]

  it('step 0: allows the structured user-input tools (so plan turns can ask)', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('user_input')
    expect(names).toContain('request_user_input')
    expect(names).toContain('create_plan')
    expect(names).not.toContain('write')
  })

  it('step > 0: keeps investigation and user-input tools available', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result.map((t) => t.name)).toEqual([
      'read',
      'create_plan',
      'user_input',
      'request_user_input'
    ])
  })

  it('custom interactiveToolNames overrides the default user-input set', () => {
    const result = resolvePlanModeToolSpecs(WITH_INPUT_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS,
      interactiveToolNames: new Set(['user_input'])
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('user_input')
    expect(names).not.toContain('request_user_input')
  })
})

describe('buildRuntimeContextInstruction', () => {
  it('includes the opened project absolute path and formatted local time context', () => {
    const instruction = buildRuntimeContextInstruction({
      workspace: '/tmp/kun-test-project',
      nowIso: '2000-01-02T03:04:05.000Z',
      timeZone: 'UTC'
    })

    expect(instruction).toContain('Current opened project absolute path: `/tmp/kun-test-project`')
    expect(instruction).toContain('Current user local time: 2000-01-02 03:04:05 Sunday (UTC')
    expect(instruction).toContain('GMT')
    expect(instruction).toContain('Treat this block as environment context')
  })

  it('normalizes relative workspace paths to absolute paths', () => {
    const instruction = buildRuntimeContextInstruction({
      workspace: 'relative-project',
      nowIso: '2026-06-21T04:30:15.000Z',
      timeZone: 'UTC'
    })

    expect(instruction).toContain(`Current opened project absolute path: \`${resolve('relative-project')}\``)
  })
})

describe('shouldInjectInitialRuntimeContext', () => {
  it('injects only for the first model step of the first thread turn', () => {
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 0,
      turnId: 'turn_1',
      historyItems: [
        {
          id: 'item_turn_1_user',
          threadId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          kind: 'user_message',
          text: 'hello',
          status: 'completed',
          createdAt: '2000-01-02T03:04:05.000Z'
        }
      ]
    })).toBe(true)
  })

  it('does not inject for tool continuations or later turns', () => {
    const currentTurnItem = {
      id: 'item_turn_2_user',
      threadId: 'thread_1',
      turnId: 'turn_2',
      role: 'user' as const,
      kind: 'user_message' as const,
      text: 'next',
      status: 'completed' as const,
      createdAt: '2000-01-02T03:04:05.000Z'
    }
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 1,
      turnId: 'turn_2',
      historyItems: [currentTurnItem]
    })).toBe(false)
    expect(shouldInjectInitialRuntimeContext({
      stepIndex: 0,
      turnId: 'turn_2',
      historyItems: [
        {
          ...currentTurnItem,
          id: 'item_turn_1_user',
          turnId: 'turn_1',
          text: 'previous'
        },
        currentTurnItem
      ]
    })).toBe(false)
  })
})
