import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryApprovalGate } from '../in-memory-approval-gate.js'
import { InMemoryEventBus } from '../in-memory-event-bus.js'
import { InMemorySessionStore } from '../in-memory-session-store.js'
import { InMemoryThreadStore } from '../in-memory-thread-store.js'
import { createImmutablePrefix } from '../../cache/immutable-prefix.js'
import { ContextCompactor } from '../../loop/context-compactor.js'
import { InflightTracker } from '../../loop/inflight-tracker.js'
import { SteeringQueue } from '../../loop/steering-queue.js'
import { SequentialIdGenerator } from '../../ports/id-generator.js'
import { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import { TurnService } from '../../services/turn-service.js'
import {
  DelegationRuntime,
  FileDelegationStore,
  type ChildRunExecutor
} from '../../delegation/delegation-runtime.js'
import { SubagentsCapabilityConfig } from '../../contracts/capabilities.js'
import {
  EXPLORE_AGENT_ALLOWED_TOOLS,
  EXPLORE_AGENT_PROVIDER_ID,
  EXPLORE_AGENT_TOOL_NAME,
  buildExploreAgentToolProvider
} from './explore-agent-tool-provider.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

function makeRuntime(
  dir: string,
  executor: ChildRunExecutor,
  maxParallel = 4
): DelegationRuntime {
  const nowIso = () => '2026-07-08T00:00:00.000Z'
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
  return new DelegationRuntime({
    config: SubagentsCapabilityConfig.parse({
      enabled: true,
      maxParallel,
      profiles: { general: { mode: 'subagent', toolPolicy: 'inherit' } }
    }),
    store: new FileDelegationStore(dir),
    events,
    threadStore,
    turns,
    nowIso,
    executor
  })
}

const baseContext = {
  threadId: 'thr_main',
  turnId: 'turn_main',
  workspace: '/workspace',
  agentSurface: 'code' as const,
  clientSurface: 'gui' as const,
  approvalPolicy: 'auto' as const,
  approvalReviewer: 'user' as const,
  awaitApproval: async () => 'allow' as const,
  model: {
    id: 'main-model',
    inputModalities: ['text'] as ('text' | 'image')[],
    outputModalities: ['text'] as ('text' | 'image')[],
    supportsToolCalling: true,
    messageParts: ['text'] as ('text' | 'image_url' | 'input_image')[],
    contextWindowTokens: 128_000
  },
  actingModelRoute: { model: 'main-model', providerId: 'deepseek' },
  reasoningEffort: 'high',
  serviceTier: 'priority' as const,
  abortSignal: new AbortController().signal
}

const batchTasks = (count: number) => Array.from({ length: count }, (_, index) => ({
  title: `Scope ${index + 1}`,
  query: `inspect scope ${index + 1}`
}))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('explore_agent tool provider', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('registers the tool and gates advertising from live Lab settings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    expect(buildExploreAgentToolProvider(runtime, () => undefined)).toHaveLength(1)
    expect(buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))).toHaveLength(1)
    const disabledProvider = buildExploreAgentToolProvider(runtime, () => ({ enabled: false }))
    expect(disabledProvider).toHaveLength(1)
    expect(disabledProvider[0].tools[0].shouldAdvertise?.(baseContext)).toBe(false)
    const provider = buildExploreAgentToolProvider(runtime, () => ({}))[0]
    expect(provider.id).toBe(EXPLORE_AGENT_PROVIDER_ID)
    expect(provider.tools[0].name).toBe(EXPLORE_AGENT_TOOL_NAME)
    expect(provider.tools[0].sideEffect).toBe('read-only')
    expect(provider.tools[0].shouldAdvertise?.(baseContext)).toBe(true)
    expect(provider.tools[0].description).toContain('Use this first for any repository or project exploration')
    expect(provider.tools[0].description).toContain('one batch containing 2-4 non-overlapping tasks')
    expect(provider.tools[0].description).toContain('submit it in a later explore_agent batch')
    expect(provider.tools[0].description).toContain('即使后续需要修改文件，也必须先调用 explore_agent')
    expect(provider.tools[0].description).toContain('Only use direct inspection tools for narrow follow-up verification')
    expect(provider.tools[0].description).toContain('始终不会修改文件')
    expect(provider.tools[0].inputSchema).toMatchObject({
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { required: ['title', 'query'] }
        }
      },
      required: ['tasks']
    })

    let cfg: { enabled?: boolean } | undefined
    const liveTool = buildExploreAgentToolProvider(runtime, () => cfg)[0].tools[0]
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(true)
    cfg = { enabled: false }
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(false)
    cfg = { enabled: true }
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(true)
  })

  it('does not register when delegation is unavailable', () => {
    expect(buildExploreAgentToolProvider(undefined, () => ({ enabled: true }))).toHaveLength(0)
  })

  it('stays advertised in plan and graph contexts while Lab is enabled', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildExploreAgentToolProvider(runtime, () => ({ enabled: true })))
    })

    for (const current of [
      { ...baseContext, threadMode: 'plan' as const },
      { ...baseContext, orchestration: 'graph' as const },
      { ...baseContext, messageSource: 'graph_runtime' as const }
    ]) {
      const tools = await host.listTools(current)
      expect(tools.map((tool) => tool.name)).toEqual([EXPLORE_AGENT_TOOL_NAME])
      expect(tools[0]?.sideEffect).toBe('read-only')
    }

    const disabledHost = new LocalToolHost({
      registry: new CapabilityRegistry(buildExploreAgentToolProvider(runtime, () => ({ enabled: false })))
    })
    expect(await disabledHost.listTools({ ...baseContext, threadMode: 'plan' })).toEqual([])
  })

  it('rejects invalid task batches and a disabled feature without creating a child run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    let ran = false
    const runtime = makeRuntime(dir, async () => {
      ran = true
      return { summary: 'ok' }
    })
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const missingBoth = await tool.execute({}, baseContext)
    expect(missingBoth.isError).toBe(true)
    expect((missingBoth.output as { error: string }).error).toContain('tasks must be an array')
    expect(ran).toBe(false)

    const empty = await tool.execute({ tasks: [] }, baseContext)
    expect(empty.isError).toBe(true)
    expect((empty.output as { error: string }).error).toContain('at least 1')

    const tooMany = await tool.execute({
      tasks: Array.from({ length: 5 }, (_, index) => ({ title: `Task ${index}`, query: 'inspect' }))
    }, baseContext)
    expect(tooMany.isError).toBe(true)
    expect((tooMany.output as { error: string }).error).toContain('at most 4')

    const missingQuery = await tool.execute({ tasks: [{ title: 'Find main' }] }, baseContext)
    expect(missingQuery.isError).toBe(true)
    expect((missingQuery.output as { error: string }).error).toBe('tasks[0].query is required')
    expect(ran).toBe(false)

    // The execute-time backstop fires when the feature is turned off after
    // the tool was already advertised (in-flight call safety).
    let cfg = { enabled: true }
    const mutableTool = buildExploreAgentToolProvider(runtime, () => cfg)[0].tools[0]
    cfg = { enabled: false }
    expect(mutableTool.shouldAdvertise?.(baseContext)).toBe(false)
    const disabled = await mutableTool.execute({
      tasks: [{ title: 'Find x', query: 'find x' }]
    }, baseContext)
    expect(disabled.isError).toBe(true)
    expect((disabled.output as { error: string }).error).toContain('disabled in Lab settings')
    expect(ran).toBe(false)
  })

  it('runs a read-oriented child that inherits the main session and returns a summary', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    let received: Record<string, unknown> | undefined
    const lifecycle: Array<Record<string, unknown>> = []
    const runtime = makeRuntime(dir, async () => ({ summary: 'found src/main.ts:12', toolInvocations: 3 }))
    const originalRunChild = runtime.runChild.bind(runtime)
    runtime.runChild = (async (input) => {
      received = { ...input, signal: undefined }
      return originalRunChild(input)
    }) as typeof runtime.runChild
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const result = await tool.execute(
      { tasks: [{ title: 'Locate main symbol', query: 'where is main defined' }] },
      {
        ...baseContext,
        sandboxMode: 'danger-full-access' as const,
        allowedProviderIds: ['deepseek'],
        allowedToolNames: ['read', 'grep'],
        allowedSkillIds: ['repo-skill'],
        allowedReadPaths: ['src'],
        allowedWritePaths: [],
        allowedArtifactIds: ['artifact_1'],
        blockedProviderIds: ['blocked-provider'],
        blockedToolNames: ['write'],
        blockedSkillIds: ['blocked-skill'],
        memoryPolicy: { enabled: true }
      },
      async (update) => {
        lifecycle.push(update.output as Record<string, unknown>)
      }
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatchObject({
      status: 'completed',
      total: 1,
      completed: 1,
      failed: 0,
      children: [{
        index: 0,
        summary: 'found src/main.ts:12',
        toolInvocations: 3,
        title: 'Locate main symbol',
        query: 'where is main defined',
        profile: 'explore',
        profileName: 'Repository Explorer',
        model: 'main-model',
        status: 'completed'
      }]
    })
    const child = (result.output as { children: Array<{ childId?: string }> }).children[0]
    expect(typeof child?.childId).toBe('string')
    expect(child?.childId?.length).toBeGreaterThan(0)
    expect(lifecycle.length).toBeGreaterThanOrEqual(1)
    expect(lifecycle[0]).toMatchObject({
      status: 'running',
      total: 1,
      completed: 0,
      failed: 0,
      children: [{
        index: 0,
        status: 'queued',
        title: 'Locate main symbol',
        profile: 'explore'
      }]
    })
    expect(lifecycle.some((snapshot) => {
      const children = snapshot.children as Array<{ childId?: string }> | undefined
      return typeof children?.[0]?.childId === 'string'
    })).toBe(true)
    expect(received).toMatchObject({
      parentThreadId: 'thr_main',
      parentTurnId: 'turn_main',
      prompt: 'where is main defined',
      workspace: '/workspace',
      label: 'Locate main symbol',
      agentSurface: 'code',
      inheritSessionDefaults: true,
      inheritedModel: 'main-model',
      inheritedProviderId: 'deepseek',
      inheritedReasoningEffort: 'high',
      inheritedServiceTier: 'priority',
      returnFormat: 'summary',
      approvalPolicy: 'auto',
      approvalReviewer: 'user',
      sandboxMode: 'danger-full-access',
      security: {
        sandboxRoot: '/workspace',
        allowedProviderIds: ['deepseek'],
        allowedToolNames: ['read', 'grep'],
        allowedSkillIds: ['repo-skill'],
        allowedReadPaths: ['src'],
        allowedWritePaths: [],
        allowedArtifactIds: ['artifact_1'],
        blockedProviderIds: ['blocked-provider'],
        blockedToolNames: ['write'],
        blockedSkillIds: ['blocked-skill'],
        memoryEnabled: true
      }
    })
    const inline = received?.inlineProfile as { id: string; source: string; profile: Record<string, unknown> }
    expect(inline.id).toBe('explore')
    expect(inline.source).toBe('builtin')
    expect(inline.profile.toolPolicy).toBe('inherit')
    expect(inline.profile.skillsEnabled).toBe(false)
    expect(inline.profile.allowedTools).toEqual([...EXPLORE_AGENT_ALLOWED_TOOLS])
    expect(inline.profile.blockedTools).toEqual(['delegate_task', 'generate_subagent', 'load_skill'])
    expect(inline.profile.model).toBeUndefined()
  })

  it('starts four independent tasks concurrently and keeps results in input order', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const releases = Array.from({ length: 4 }, deferred)
    const completions = Array.from({ length: 4 }, deferred)
    const allStarted = deferred()
    let active = 0
    let maxActive = 0
    let started = 0
    const finished: number[] = []
    const runtime = makeRuntime(dir, async (input) => {
      const index = Number(input.prompt.match(/\d+$/)?.[0] ?? 1) - 1
      active += 1
      maxActive = Math.max(maxActive, active)
      started += 1
      if (started === 4) allStarted.resolve()
      await releases[index]!.promise
      active -= 1
      finished.push(index)
      completions[index]!.resolve()
      return { summary: `done: ${input.prompt}` }
    }, 4)
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const pending = tool.execute({ tasks: batchTasks(4) }, baseContext)

    await allStarted.promise
    expect(maxActive).toBe(4)
    for (const index of [3, 1, 0, 2]) {
      releases[index]!.resolve()
      await completions[index]!.promise
    }
    const result = await pending
    expect(finished).toEqual([3, 1, 0, 2])
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatchObject({
      status: 'completed',
      total: 4,
      completed: 4,
      failed: 0
    })
    const children = (result.output as {
      children: Array<{ index: number; title: string; summary?: string }>
    }).children
    expect(children.map((child) => child.index)).toEqual([0, 1, 2, 3])
    expect(children.map((child) => child.title)).toEqual(batchTasks(4).map((task) => task.title))
    expect(children.map((child) => child.summary)).toEqual(
      batchTasks(4).map((task) => `done: ${task.query}`)
    )
  })

  it('uses the global maxParallel queue and emits monotonic aggregate progress', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const release = deferred()
    const firstWaveStarted = deferred()
    const snapshots: Array<{
      children: Array<{ status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' }>
    }> = []
    let active = 0
    let maxActive = 0
    let started = 0
    const runtime = makeRuntime(dir, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      started += 1
      if (started === 2) firstWaveStarted.resolve()
      await release.promise
      active -= 1
      return { summary: 'ok' }
    }, 2)
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const pending = tool.execute({ tasks: batchTasks(4) }, baseContext, (update) => {
      snapshots.push(update.output as typeof snapshots[number])
    })

    await firstWaveStarted.promise
    const firstWave = snapshots.at(-1)?.children.map((child) => child.status)
    expect(firstWave?.filter((status) => status === 'running')).toHaveLength(2)
    expect(firstWave?.filter((status) => status === 'queued')).toHaveLength(2)
    release.resolve()
    const result = await pending
    expect(maxActive).toBe(2)
    expect((result.output as { status: string }).status).toBe('completed')

    const rank = { queued: 0, running: 1, completed: 2, failed: 2, aborted: 2 }
    for (let index = 0; index < 4; index += 1) {
      const statuses = snapshots.map((snapshot) => snapshot.children[index]?.status).filter(Boolean)
      for (let offset = 1; offset < statuses.length; offset += 1) {
        expect(rank[statuses[offset]!]).toBeGreaterThanOrEqual(rank[statuses[offset - 1]!])
      }
      expect(statuses.at(-1)).toBe('completed')
    }
  })

  it.each(['always', 'untrusted', 'never'] as const)(
    'keeps the internal batch serial for %s approval policy',
    async (approvalPolicy) => {
      dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
      let active = 0
      let maxActive = 0
      const runtime = makeRuntime(dir, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return { summary: 'ok' }
      }, 4)
      const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
      const result = await tool.execute(
        { tasks: batchTasks(4) },
        { ...baseContext, approvalPolicy }
      )
      expect(result.isError).toBeFalsy()
      expect(maxActive).toBe(1)
    }
  )

  it('reports partial and all-failed batches without cancelling successful siblings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const runtime = makeRuntime(dir, async (input) => {
      if (input.prompt.includes('scope 2')) throw new Error('scope 2 failed')
      return { summary: `ok: ${input.prompt}` }
    })
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const partial = await tool.execute({ tasks: batchTasks(3) }, baseContext)
    expect(partial.isError).toBeFalsy()
    expect(partial.output).toMatchObject({ status: 'partial', total: 3, completed: 2, failed: 1 })
    expect((partial.output as { children: Array<{ status: string }> }).children.map((child) => child.status))
      .toEqual(['completed', 'failed', 'completed'])

    const failedRuntime = makeRuntime(dir, async (input) => {
      throw new Error(`failed: ${input.prompt}`)
    })
    const failedTool = buildExploreAgentToolProvider(failedRuntime, () => ({ enabled: true }))[0].tools[0]
    const failed = await failedTool.execute({ tasks: batchTasks(2) }, baseContext)
    expect(failed.isError).toBe(true)
    expect(failed.output).toMatchObject({ status: 'failed', total: 2, completed: 0, failed: 2 })
  })

  it('aborts every running child when the parent turn is cancelled', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    const allStarted = deferred()
    const controller = new AbortController()
    let started = 0
    const runtime = makeRuntime(dir, async (input) => {
      started += 1
      if (started === 4) allStarted.resolve()
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('executor aborted')), { once: true })
      })
      return { summary: 'unreachable' }
    }, 4)
    const tool = buildExploreAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const pending = tool.execute(
      { tasks: batchTasks(4) },
      { ...baseContext, abortSignal: controller.signal }
    )

    await allStarted.promise
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.output).toMatchObject({ status: 'failed', completed: 0, failed: 4 })
    expect((result.output as { children: Array<{ status: string }> }).children.every(
      (child) => child.status === 'aborted'
    )).toBe(true)
  })

  it('applies Lab model/provider/reasoning/fast overrides on top of the profile', async () => {
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    let received: Record<string, unknown> | undefined
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    const originalRunChild = runtime.runChild.bind(runtime)
    runtime.runChild = (async (input) => {
      received = { ...input, signal: undefined }
      return originalRunChild(input)
    }) as typeof runtime.runChild
    const tool = buildExploreAgentToolProvider(runtime, () => ({
      enabled: true,
      model: 'gpt-5.4',
      providerId: 'codex-2',
      reasoningEffort: 'medium',
      fast: true
    }))[0].tools[0]
    await tool.execute({ tasks: [{ title: 'Inspect module', query: 'inspect' }] }, baseContext)
    const inline = received?.inlineProfile as { profile: Record<string, unknown> }
    expect(inline.profile.model).toBe('gpt-5.4')
    expect(inline.profile.providerId).toBe('codex-2')
    expect(inline.profile.reasoningEffort).toBe('medium')
    expect(received?.serviceTier).toBe('priority')
    expect(received?.inheritedModel).toBe('main-model')
  })

  it('keeps the allow-list free of mutation and delegation tools', () => {
    const forbidden = ['write', 'edit', 'delete', 'delegate_task', 'generate_subagent', 'load_skill', 'task_graph', 'create_plan']
    for (const name of forbidden) {
      expect(EXPLORE_AGENT_ALLOWED_TOOLS).not.toContain(name)
    }
  })

  it('does not leak the parent service tier for plain delegate_task children', async () => {
    // Regression guard: the delegation runtime must only inherit serviceTier
    // when the delegating tool opts into inheritSessionDefaults (explore_agent),
    // so delegate_task behavior stays unchanged.
    const nowIso = () => '2026-07-08T00:00:00.000Z'
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
    dir = await mkdtemp(join(tmpdir(), 'explore-agent-tool-'))
    let executorInput: Record<string, unknown> | undefined
    const runtime = new DelegationRuntime({
      config: SubagentsCapabilityConfig.parse({
        enabled: true,
        maxParallel: 1,
        profiles: { general: { mode: 'subagent', toolPolicy: 'inherit' } }
      }),
      store: new FileDelegationStore(dir),
      events,
      threadStore,
      turns,
      nowIso,
      executor: async (input) => {
        executorInput = { ...input, signal: undefined }
        return { summary: 'ok' }
      }
    })
    const record = await runtime.runChild({
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'review this',
      profile: 'general',
      inheritedModel: 'main-model',
      inheritedProviderId: 'deepseek',
      inheritedReasoningEffort: 'high',
      inheritedServiceTier: 'priority',
      signal: new AbortController().signal
    })
    expect(record.serviceTier).toBeUndefined()
    expect(executorInput?.serviceTier).toBeUndefined()
    expect(executorInput?.reasoningEffort).toBeUndefined()
  })
})
