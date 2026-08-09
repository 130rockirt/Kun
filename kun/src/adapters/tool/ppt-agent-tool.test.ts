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
  PPT_AGENT_ALLOWED_TOOLS,
  PPT_AGENT_PROVIDER_ID,
  PPT_AGENT_TOOL_NAME,
  buildPptAgentToolProvider
} from './ppt-agent-tool-provider.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

function makeRuntime(dir: string, executor: ChildRunExecutor): DelegationRuntime {
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
      maxParallel: 1,
      maxChildRuns: 10,
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

describe('ppt_agent tool provider', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('registers the tool and gates advertising from live Lab settings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    expect(buildPptAgentToolProvider(runtime, () => undefined)).toHaveLength(1)
    expect(buildPptAgentToolProvider(runtime, () => ({ enabled: true }))).toHaveLength(1)
    const disabledProvider = buildPptAgentToolProvider(runtime, () => ({ enabled: false }))
    expect(disabledProvider).toHaveLength(1)
    expect(disabledProvider[0].tools[0].shouldAdvertise?.(baseContext)).toBe(false)
    const provider = buildPptAgentToolProvider(runtime, () => ({}))[0]
    expect(provider.id).toBe(PPT_AGENT_PROVIDER_ID)
    expect(provider.kind).toBe('delegation')
    expect(provider.tools[0].name).toBe(PPT_AGENT_TOOL_NAME)
    expect(provider.tools[0].sideEffect).toBe('unknown')
    expect(provider.tools[0].shouldAdvertise?.(baseContext)).toBe(true)
    expect(provider.tools[0].description).toContain('Use `ppt_agent` for any presentation/PPT task')
    expect(provider.tools[0].description).toContain('open-kimi-ppt-skill workflow distilled')
    expect(provider.tools[0].description).toContain('generate_image')
    expect(provider.tools[0].inputSchema).toMatchObject({
      required: ['title', 'query']
    })

    let cfg: { enabled?: boolean } | undefined
    const liveTool = buildPptAgentToolProvider(runtime, () => cfg)[0].tools[0]
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(true)
    cfg = { enabled: false }
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(false)
    cfg = { enabled: true }
    expect(liveTool.shouldAdvertise?.(baseContext)).toBe(true)
  })

  it('does not register when delegation is unavailable', () => {
    expect(buildPptAgentToolProvider(undefined, () => ({ enabled: true }))).toHaveLength(0)
  })

  it('is advertised in normal turns but stripped from plan and Graph Lead turns', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildPptAgentToolProvider(runtime, () => ({ enabled: true })))
    })

    // Normal turns: listed (Lab gate only).
    const normalTools = await host.listTools(baseContext)
    expect(normalTools.map((tool) => tool.name)).toEqual([PPT_AGENT_TOOL_NAME])
    expect(normalTools[0]?.sideEffect).toBe('unknown')

    // Plan turns only allow read-only + plan tools, so this mutation surface
    // is hidden (same policy that hides write/edit for non-Markdown targets).
    expect(await host.listTools({ ...baseContext, threadMode: 'plan' })).toEqual([])

    // Delegation-kind providers are disabled on Graph Lead turns (no explore
    // exemption) so Graph scheduling never races this heavyweight child.
    for (const current of [
      { ...baseContext, orchestration: 'graph' as const },
      { ...baseContext, messageSource: 'graph_runtime' as const }
    ]) {
      expect(await host.listTools(current)).toEqual([])
    }

    const disabledHost = new LocalToolHost({
      registry: new CapabilityRegistry(buildPptAgentToolProvider(runtime, () => ({ enabled: false })))
    })
    expect(await disabledHost.listTools(baseContext)).toEqual([])
  })

  it('rejects a missing title/query and a disabled feature without creating a child run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    let ran = false
    const runtime = makeRuntime(dir, async () => {
      ran = true
      return { summary: 'ok' }
    })
    const tool = buildPptAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const missingBoth = await tool.execute({}, baseContext)
    expect(missingBoth.isError).toBe(true)
    expect((missingBoth.output as { error: string }).error).toBe('title is required')
    expect(ran).toBe(false)

    const missingQuery = await tool.execute({ title: 'Build deck' }, baseContext)
    expect(missingQuery.isError).toBe(true)
    expect((missingQuery.output as { error: string }).error).toBe('query is required')
    expect(ran).toBe(false)

    // The execute-time backstop fires when the feature is turned off after
    // the tool was already advertised (in-flight call safety).
    let cfg = { enabled: true }
    const mutableTool = buildPptAgentToolProvider(runtime, () => cfg)[0].tools[0]
    cfg = { enabled: false }
    expect(mutableTool.shouldAdvertise?.(baseContext)).toBe(false)
    const disabled = await mutableTool.execute({ title: 'Build deck', query: 'build a deck' }, baseContext)
    expect(disabled.isError).toBe(true)
    expect((disabled.output as { error: string }).error).toContain('disabled in Lab settings')
    expect(ran).toBe(false)
  })

  it('runs a PPT child that inherits the main session and returns a summary', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    let received: Record<string, unknown> | undefined
    const lifecycle: Array<Record<string, unknown>> = []
    const runtime = makeRuntime(dir, async () => ({ summary: 'deck ready', toolInvocations: 5 }))
    const originalRunChild = runtime.runChild.bind(runtime)
    runtime.runChild = (async (input) => {
      received = { ...input, signal: undefined }
      return originalRunChild(input)
    }) as typeof runtime.runChild
    const tool = buildPptAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    const result = await tool.execute(
      { title: 'Build launch deck', query: 'create a 5-page launch deck' },
      baseContext,
      async (update) => {
        lifecycle.push(update.output as Record<string, unknown>)
      }
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatchObject({
      summary: 'deck ready',
      toolInvocations: 5,
      title: 'Build launch deck',
      profile: 'ppt',
      profileName: 'PPT Master',
      model: 'main-model',
      status: 'completed'
    })
    expect(typeof (result.output as { childId?: string }).childId).toBe('string')
    expect(lifecycle.length).toBeGreaterThanOrEqual(1)
    expect(lifecycle[0]).toMatchObject({
      status: expect.stringMatching(/^(queued|running)$/),
      title: 'Build launch deck',
      profile: 'ppt',
      profileName: 'PPT Master'
    })
    expect(received).toMatchObject({
      parentThreadId: 'thr_main',
      parentTurnId: 'turn_main',
      workspace: '/workspace',
      label: 'Build launch deck',
      agentSurface: 'code',
      inheritSessionDefaults: true,
      inheritedModel: 'main-model',
      inheritedProviderId: 'deepseek',
      inheritedReasoningEffort: 'high',
      inheritedServiceTier: 'priority',
      returnFormat: 'summary',
      approvalPolicy: 'auto',
      approvalReviewer: 'user'
    })
    expect(String(received?.prompt)).toContain('IMAGE-FIRST FALLBACK')
    expect(result.output).toMatchObject({
      phase: 'direct_build',
      fallbackNotice: expect.stringContaining('no configured image-generation model')
    })
    const inline = received?.inlineProfile as { id: string; source: string; profile: Record<string, unknown> }
    expect(inline.id).toBe('ppt')
    expect(inline.source).toBe('builtin')
    expect(inline.profile.toolPolicy).toBe('inherit')
    expect(inline.profile.skillsEnabled).toBe(false)
    expect(inline.profile.allowedTools).toEqual([...PPT_AGENT_ALLOWED_TOOLS])
    expect(inline.profile.blockedTools).toEqual(['delegate_task', 'generate_subagent', 'load_skill'])
    expect(inline.profile.model).toBeUndefined()
    const systemPrompt = String(inline.profile.systemPrompt ?? '')
    expect(systemPrompt).toContain('step0')
    expect(systemPrompt).toContain('slides_categories')
    expect(systemPrompt).toContain('export_images')
    expect(systemPrompt).toContain('ppt_read_guide')
    expect(systemPrompt).toContain('ppt_export')
    expect(systemPrompt).toContain('validated=true')
    expect(systemPrompt).toContain('generate_image')
  })

  it('requires image-first review output and resumes the same PPT child for revisions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    const calls: Array<Record<string, unknown>> = []
    const runtime = makeRuntime(dir, async (input) => {
      calls.push({ ...input, signal: undefined })
      return {
        summary: 'review ready',
        reviewBundle: {
          workflowId: 'ppt_workflow',
          childId: input.childId,
          manifestPath: 'deck/.kun-ppt-review/manifest.json',
          deckTitle: 'Launch deck',
          styleFingerprint: 'style-1',
          phase: 'awaiting_review',
          slides: []
        }
      }
    })
    const tool = buildPptAgentToolProvider(runtime, () => ({
      enabled: true,
      imageFirst: true,
      imageGenAvailable: true,
      imageGenSupportsReferenceEdit: true
    }))[0].tools[0]
    const started = await tool.execute({ title: 'Review deck', query: 'create a launch deck' }, baseContext)
    expect(started).toMatchObject({
      isError: false,
      output: { phase: 'awaiting_review', reviewBundle: { workflowId: 'ppt_workflow' } }
    })
    expect(String(calls[0]?.prompt)).toContain('Do not create PPTD or PPTX yet')
    const childId = (started.output as { childId: string }).childId

    const revised = await tool.execute({
      action: 'revise_previews',
      childId,
      workflowId: 'ppt_workflow',
      title: 'Revise deck',
      query: 'make the opening bolder',
      reviewContext: { slides: [{ slideId: 'slide-1', feedback: 'larger headline' }] }
    }, { ...baseContext, turnId: 'turn_followup' })
    expect(revised).toMatchObject({
      isError: false,
      output: { childId, phase: 'awaiting_review', reviewBundle: { workflowId: 'ppt_workflow' } }
    })
    expect(calls[1]).toMatchObject({ childId, resumeChild: true, parentTurnId: 'turn_followup' })
    expect(String(calls[1]?.prompt)).toContain('workflowId="ppt_workflow"')
    expect(String(calls[1]?.prompt)).toContain('larger headline')
  })

  it('fails an image-first run that does not return a visual review bundle', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    const runtime = makeRuntime(dir, async () => ({ summary: 'stopped early' }))
    const tool = buildPptAgentToolProvider(runtime, () => ({
      enabled: true,
      imageFirst: true,
      imageGenAvailable: true
    }))[0].tools[0]
    const result = await tool.execute({ title: 'Review deck', query: 'create a deck' }, baseContext)
    expect(result).toMatchObject({
      isError: true,
      output: {
        phase: 'failed_recoverable',
        error: 'PPT child completed without the required visual review bundle'
      }
    })
  })

  it('passes guiDesignCanvas into the child when the parent canvas is active', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    let received: Record<string, unknown> | undefined
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    const originalRunChild = runtime.runChild.bind(runtime)
    runtime.runChild = (async (input) => {
      received = { ...input, signal: undefined }
      return originalRunChild(input)
    }) as typeof runtime.runChild
    const tool = buildPptAgentToolProvider(runtime, () => ({ enabled: true }))[0].tools[0]
    await tool.execute(
      { title: 'Deck to board', query: 'deck on board' },
      { ...baseContext, guiDesignCanvas: true }
    )
    expect(received?.guiDesignCanvas).toBe(true)
  })

  it('applies Lab model/provider/reasoning/fast overrides on top of the profile', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppt-agent-tool-'))
    let received: Record<string, unknown> | undefined
    const runtime = makeRuntime(dir, async () => ({ summary: 'ok' }))
    const originalRunChild = runtime.runChild.bind(runtime)
    runtime.runChild = (async (input) => {
      received = { ...input, signal: undefined }
      return originalRunChild(input)
    }) as typeof runtime.runChild
    const tool = buildPptAgentToolProvider(runtime, () => ({
      enabled: true,
      model: 'gpt-5.4',
      providerId: 'codex-2',
      reasoningEffort: 'medium',
      fast: true
    }))[0].tools[0]
    await tool.execute({ title: 'Build deck', query: 'build' }, baseContext)
    const inline = received?.inlineProfile as { profile: Record<string, unknown> }
    expect(inline.profile.model).toBe('gpt-5.4')
    expect(inline.profile.providerId).toBe('codex-2')
    expect(inline.profile.reasoningEffort).toBe('medium')
    expect(received?.serviceTier).toBe('priority')
    expect(received?.inheritedModel).toBe('main-model')
  })

  it('keeps the allow-list free of delegation, board and child-inert design tools (verdict B)', () => {
    const forbidden = [
      'delegate_task',
      'generate_subagent',
      'load_skill',
      'task_graph',
      'create_plan',
      // Verdict B: child design-tool results never reach the canvas, so the
      // child must not receive the board tool; the parent replays it.
      'ppt_to_board',
      'design_canvas',
      'design_create_screen',
      'design_update_shapes'
    ]
    for (const name of forbidden) {
      expect(PPT_AGENT_ALLOWED_TOOLS).not.toContain(name)
    }
    for (const name of ['write', 'edit', 'bash', 'generate_image', 'ppt_read_guide', 'ppt_export']) {
      expect(PPT_AGENT_ALLOWED_TOOLS).toContain(name)
    }
  })
})
