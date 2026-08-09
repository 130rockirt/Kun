import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { LocalToolHost, echoTool, type LocalTool } from '../../src/adapters/tool/local-tool-host.js'
import { InMemoryArtifactStore } from '../../src/artifacts/artifact-store.js'
import { createImmutablePrefix } from '../../src/cache/immutable-prefix.js'
import { DEFAULT_GRAPH_RUNTIME_CONFIG } from '../../src/config/kun-config.js'
import { emptyUsageSnapshot } from '../../src/contracts/usage.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import type { ApprovalRequest } from '../../src/domain/approval.js'
import { InflightTracker } from '../../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../../src/loop/steering-queue.js'
import { ContextCompactor } from '../../src/loop/context-compactor.js'
import {
  AgentLoop,
  buildRuntimeContextInstruction,
  isStalePlanContext,
  resolvePlanModeToolSpecs,
  shouldInjectInitialRuntimeContext,
  svgArtifactCompletionState,
  turnHasUnverifiedSourceChanges
} from '../../src/loop/agent-loop.js'
import { SequentialIdGenerator } from '../../src/ports/id-generator.js'
import type { ModelClient, ModelRequest, ModelStreamChunk, ModelToolSpec } from '../../src/ports/model-client.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../../src/ports/user-input-gate.js'
import { GraphRuntimeComposition } from '../../src/server/graph-runtime-factory.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { TurnService } from '../../src/services/turn-service.js'
import { UsageService } from '../../src/services/usage-service.js'
import {
  AbortAwareModel,
  AllowApprovalGate,
  AlternatingGraphLeadToolModel,
  CapturingCompleteModel,
  FinalResponseGateModel,
  HangingGraphLeadModel,
  NoopUserInputGate,
  RecoverableGraphStreamModel,
  RepeatingToolModel,
  RoutedFailureModel,
  ScriptedGraphModel,
  ScriptedInvalidGraphModel,
  ScriptedSvgModel,
  TruncatedRawGraphPlanModel,
  svgGateTool,
  svgLoopHarness
} from './agent-loop-support.cases.js'

describe('AgentLoop interruption', () => {
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
