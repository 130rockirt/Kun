import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { CapabilityRegistry } from '../../src/adapters/tool/capability-registry.js'
import { buildDelegationToolProviders } from '../../src/adapters/tool/delegation-tool-provider.js'
import { LocalToolHost } from '../../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig, type SubagentProfileConfig } from '../../src/contracts/capabilities.js'
import { emptyUsageSnapshot } from '../../src/contracts/usage.js'
import { BUILTIN_SUBAGENT_PROFILES } from '../../src/delegation/builtin-profiles.js'
import {
  ChildRunRecord,
  DelegationRuntime,
  FileDelegationStore,
  type ChildRunExecutor
} from '../../src/delegation/delegation-runtime.js'
import { SubagentRouter } from '../../src/delegation/subagent-router.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'
import type { ToolHostContext } from '../../src/ports/tool-host.js'
import { RuntimeEventRecorder } from '../../src/services/runtime-event-recorder.js'
import { StaticRouterModel, deferred, waitFor } from '../support/delegation-runtime-fixtures.js'

describe('DelegationRuntime', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kun-delegation-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates child runs, persists records, and emits child event metadata', async () => {
    const sessionStore = new InMemorySessionStore()
    const externalUsage: unknown[] = []
    const runtime = createRuntime({ sessionStore, recordExternalUsage: (_threadId, usage) => externalUsage.push(usage) })
    const result = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'Research A',
      workspace: '/tmp/ws',
      signal: new AbortController().signal
    })

    expect(result).toMatchObject({ status: 'completed', summary: 'done: Research A' })
    expect((await runtime.diagnostics('thr_1')).childRuns).toHaveLength(1)
    const events = await sessionStore.loadEventsSince('thr_1', 0)
    expect(events.some((event) => event.child?.childId === result.id && event.child.childStatus === 'completed')).toBe(true)
    expect(externalUsage).toHaveLength(1)
    expect(externalUsage[0]).toMatchObject({ totalTokens: 3 })
  })

  it('fires onStart with the child id (so the tool can surface it mid-run)', async () => {
    const runtime = createRuntime({})
    const started: Array<{ childId: string; profile?: string }> = []
    const states: string[] = []
    const result = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'Research B',
      onStart: (childId, profile) => started.push({ childId, profile }),
      onQueued: async () => { states.push('queued') },
      onRunning: async () => {
        states.push('running')
        throw new Error('renderer disconnected')
      },
      signal: new AbortController().signal
    })
    expect(started).toHaveLength(1)
    expect(started[0]?.childId).toBe(result.id)
    expect(states).toEqual(['queued', 'running'])
    expect(result.status).toBe('completed')
  })

  it('denies disabled delegation', async () => {
    const disabled = createRuntime({ enabled: false })
    await expect(disabled.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'x',
      signal: new AbortController().signal
    })).rejects.toThrow(/disabled/)
  })

  it('ignores the legacy cumulative child limit for one parent thread', async () => {
    const runtime = createRuntime({ legacyMaxChildRuns: 25 })
    const results = []
    for (let index = 0; index < 26; index += 1) {
      results.push(await runtime.runChild({
        parentThreadId: 'thr_unbounded',
        parentTurnId: `turn_${index}`,
        prompt: `task ${index}`,
        signal: new AbortController().signal
      }))
    }

    expect(results.every((record) => record.status === 'completed')).toBe(true)
    expect((await runtime.diagnostics('thr_unbounded')).childRuns).toHaveLength(26)
  })

  it('allows the first child when a legacy config carries maxChildRuns zero', async () => {
    const runtime = createRuntime({ legacyMaxChildRuns: 0 })
    await expect(runtime.runChild({
      parentThreadId: 'thr_legacy_zero', parentTurnId: 'turn_first',
      prompt: 'first task', signal: new AbortController().signal
    })).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps spawning after restart when the parent already has persisted child history', async () => {
    const firstRuntime = createRuntime({ legacyMaxChildRuns: 25, idNamespace: 'before_restart' })
    for (let index = 0; index < 26; index += 1) {
      await firstRuntime.runChild({
        parentThreadId: 'thr_restart',
        parentTurnId: `turn_before_restart_${index}`,
        prompt: `before restart ${index}`,
        signal: new AbortController().signal
      })
    }

    const restartedRuntime = createRuntime({ legacyMaxChildRuns: 25, idNamespace: 'after_restart' })
    const afterRestart = await restartedRuntime.runChild({
      parentThreadId: 'thr_restart',
      parentTurnId: 'turn_after_restart',
      prompt: 'after restart',
      signal: new AbortController().signal
    })

    expect(afterRestart.status).toBe('completed')
    const childRuns = (await restartedRuntime.diagnostics('thr_restart')).childRuns
    expect(childRuns).toHaveLength(27)
    expect(new Set(childRuns.map((record) => record.id)).size).toBe(27)
  })

  it('records high child usage without enforcing an execution budget', async () => {
    const externalUsage: unknown[] = []
    const runtime = createRuntime({
      recordExternalUsage: (_threadId, usage) => externalUsage.push(usage),
      executor: async () => ({
        summary: 'completed a large investigation',
        usage: { promptTokens: 800_000, completionTokens: 400_000, totalTokens: 1_200_000 },
        toolInvocations: 500
      })
    })
    const completed = await runtime.runChild({
      parentThreadId: 'thr_tokens',
      parentTurnId: 'turn_tokens',
      prompt: 'large task',
      signal: new AbortController().signal
    })
    expect(completed).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 1_200_000 },
      toolInvocations: 500
    })
    expect(completed).not.toHaveProperty('tokenBudget')
    expect(completed).not.toHaveProperty('budgetExceeded')
    expect(externalUsage).toHaveLength(1)
  })

  it('loads historical child budget fields as read-only compatibility data', async () => {
    const root = join(dir, 'legacy-children')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'child_legacy.json'), JSON.stringify({
      id: 'child_legacy',
      parentThreadId: 'thr_legacy',
      parentTurnId: 'turn_legacy',
      prompt: 'old task',
      status: 'failed',
      tokenBudget: 10,
      timeBudgetMs: 1_000,
      budgetExceeded: 'token',
      error: 'legacy budget failure',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z'
    }), 'utf8')

    await expect(new FileDelegationStore(root).list('thr_legacy')).resolves.toEqual([
      expect.objectContaining({
        id: 'child_legacy',
        tokenBudget: 10,
        timeBudgetMs: 1_000,
        budgetExceeded: 'token'
      })
    ])
  })

  it('validates evidence-return contracts', async () => {
    const withEvidence = createRuntime({
      executor: async () => ({ summary: 'done', evidence: ['read src/index.ts', 'ran unit tests'] })
    })
    await expect(withEvidence.runChild({
      parentThreadId: 'thr_evidence',
      parentTurnId: 'turn_evidence',
      prompt: 'investigate',
      returnFormat: 'evidence',
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      status: 'completed',
      returnFormat: 'evidence',
      evidence: ['read src/index.ts', 'ran unit tests']
    })

    const withoutEvidence = createRuntime({ executor: async () => ({ summary: 'done' }) })
    await expect(withoutEvidence.runChild({
      parentThreadId: 'thr_missing_evidence',
      parentTurnId: 'turn_missing_evidence',
      prompt: 'investigate',
      returnFormat: 'evidence',
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      status: 'failed',
      error: 'child contract requires evidence but none was returned'
    })
  })

  it('executes delegate_task through the normal tool host', async () => {
    const runtime = createRuntime()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'delegate_task',
      arguments: { label: 'A', prompt: 'Investigate A' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        status: 'completed',
        summary: 'done: Investigate A',
        usage: { totalTokens: 3 }
      })
    }
  })

  it('automatically routes delegate_task through BM25 Top-5 and the LLM judge', async () => {
    const seen: Array<{ profile?: string; toolPolicy: string }> = []
    const runtime = createRuntime({
      profiles: {
        'security-auditor': {
          name: 'Security Auditor',
          description: 'Security vulnerability threat audit',
          toolPolicy: 'readOnly'
        },
        general: { description: 'General implementation worker', toolPolicy: 'inherit' }
      },
      executor: async (input) => {
        seen.push({ profile: input.profile, toolPolicy: input.toolPolicy })
        return { summary: 'audited' }
      }
    })
    const model = new StaticRouterModel(JSON.stringify({
      decision: 'profile',
      targetId: 'security-auditor',
      confidence: 0.94,
      reason: 'Exact security specialty.'
    }))
    const router = new SubagentRouter({ modelClient: model, defaultModel: () => 'router-model' })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime, router))
    })

    const result = await host.execute({
      callId: 'call_auto_route',
      toolName: 'delegate_task',
      arguments: { label: 'Audit auth', prompt: '审查认证逻辑中的安全漏洞' }
    }, {
      threadId: 'thr_auto_route',
      turnId: 'turn_auto_route',
      workspace: dir,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen).toEqual([{ profile: 'security-auditor', toolPolicy: 'readOnly' }])
    expect((await runtime.diagnostics('thr_auto_route')).childRuns[0]).toMatchObject({
      profile: 'security-auditor',
      routing: {
        method: 'bm25-llm-profile',
        selectedKind: 'profile',
        selectedId: 'security-auditor'
      }
    })
    expect(model.requests).toHaveLength(1)

    await host.execute({
      callId: 'call_explicit_route',
      toolName: 'delegate_task',
      arguments: { prompt: 'Implement the fix', profile: 'general' }
    }, {
      threadId: 'thr_explicit_route',
      turnId: 'turn_explicit_route',
      workspace: dir,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })
    expect(model.requests).toHaveLength(1)
    expect(seen.at(-1)).toEqual({ profile: 'general', toolPolicy: 'inherit' })
  })

  it('pins the parent workspace and capability boundary onto the child', async () => {
    const seen: Parameters<ChildRunExecutor>[0][] = []
    const runtime = createRuntime({
      profiles: { general: { toolPolicy: 'inherit' } },
      executor: async (input) => {
        seen.push(input)
        return { summary: 'bounded' }
      }
    })
    const providers = buildDelegationToolProviders(runtime)
    const tool = providers[0]?.tools[0]
    expect((tool?.inputSchema.properties as Record<string, unknown> | undefined)?.workspace).toBeUndefined()
    const host = new LocalToolHost({ registry: new CapabilityRegistry(providers) })
    const context: ToolHostContext = {
      threadId: 'thr_security_boundary',
      turnId: 'turn_security_boundary',
      workspace: dir,
      approvalPolicy: 'auto' as const,
      sandboxMode: 'workspace-write' as const,
      model: {
        id: 'deepseek-chat',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      },
      modelProviderId: 'deepseek',
      allowedProviderIds: ['delegation'],
      allowedToolNames: ['delegate_task', 'read'],
      blockedProviderIds: ['mcp:github'],
      blockedToolNames: ['bash'],
      blockedSkillIds: ['untrusted-skill'],
      memoryPolicy: { enabled: false },
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    }
    const result = await host.execute({
      callId: 'call_security_boundary',
      toolName: 'delegate_task',
      arguments: { prompt: 'Implement a bounded change', profile: 'general' }
    }, context)

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen[0]).toMatchObject({
      workspace: dir,
      model: 'deepseek-chat',
      providerId: 'deepseek',
      security: {
        sandboxRoot: dir,
        allowedProviderIds: ['delegation'],
        allowedToolNames: ['delegate_task', 'read'],
        blockedProviderIds: ['mcp:github'],
        blockedToolNames: ['bash'],
        blockedSkillIds: ['untrusted-skill'],
        memoryEnabled: false
      }
    })
    expect((await runtime.diagnostics('thr_security_boundary')).childRuns[0]).toMatchObject({
      workspace: dir,
      security: { sandboxRoot: dir, allowedToolNames: ['delegate_task', 'read'] },
      profileSnapshot: expect.objectContaining({ toolPolicy: 'inherit' }),
      profileSource: 'configured',
      profileFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })

    const readOnlyReview = await host.execute({
      callId: 'call_read_only_ceiling',
      toolName: 'delegate_task',
      arguments: { prompt: '请审查这个实现是否需要删除多余抽象，不要改代码', profile: 'general' }
    }, { ...context, turnId: 'turn_read_only_ceiling' })
    expect(readOnlyReview.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen.at(-1)?.toolPolicy).toBe('readOnly')
  })

  it('lets custom-only mode create an ephemeral subagent that inherits the active turn model', async () => {
    const seen: Array<{
      systemPrompt?: string
      blockedTools?: string[]
      toolPolicy: string
      model?: string
      providerId?: string
      reasoningEffort?: string
    }> = []
    const runtime = createRuntime({
      useExistingAgents: false,
      profiles: { general: { description: 'General worker', toolPolicy: 'inherit' } },
      executor: async (input) => {
        seen.push({
          systemPrompt: input.systemPrompt,
          blockedTools: input.blockedTools,
          toolPolicy: input.toolPolicy,
          model: input.model,
          providerId: input.providerId,
          reasoningEffort: input.reasoningEffort
        })
        return { summary: 'investigated' }
      }
    })
    const model = new StaticRouterModel('{"decision":"profile","targetId":"general"}')
    const router = new SubagentRouter({ modelClient: model, defaultModel: () => 'router-model' })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime, router))
    })
    const before = runtime.listProfiles()

    const result = await host.execute({
      callId: 'call_custom',
      toolName: 'delegate_task',
      arguments: {
        prompt: 'Trace the IPC failure',
        model: 'deepseek-v4-flash',
        providerId: 'deepseek',
        custom_agent: {
          name: 'IPC Investigator',
          description: 'Diagnoses Electron IPC boundaries.',
          system_prompt: 'Trace renderer, preload, and main. Cite concrete evidence.',
          tool_policy: 'readOnly',
          blocked_tools: ['bash']
        }
      }
    }, {
      threadId: 'thr_custom',
      turnId: 'turn_custom',
      workspace: dir,
      model: {
        id: 'gpt-5.6-luna',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      },
      modelProviderId: 'openai',
      reasoningEffort: 'high',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(model.requests).toHaveLength(0)
    expect(runtime.listProfiles()).toEqual(before)
    expect(seen).toEqual([{
      systemPrompt: 'Trace renderer, preload, and main. Cite concrete evidence.',
      blockedTools: ['delegate_task', 'generate_subagent', 'load_skill', 'bash'],
      toolPolicy: 'readOnly',
      model: 'gpt-5.6-luna',
      providerId: 'openai',
      reasoningEffort: 'high'
    }])
    expect((await runtime.diagnostics('thr_custom')).childRuns[0]).toMatchObject({
      profile: 'custom:ipc-investigator',
      model: 'gpt-5.6-luna',
      providerId: 'openai',
      reasoningEffort: 'high',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      routing: { method: 'explicit-custom', selectedKind: 'custom' }
    })
  })

  it('reuses the existing default agent when the router finds no matching profile', async () => {
    const seen: Array<{ profile?: string; systemPrompt?: string }> = []
    const runtime = createRuntime({
      defaultProfile: 'general',
      profiles: { general: { description: 'General worker', toolPolicy: 'inherit' } },
      executor: async (input) => {
        seen.push({
          profile: input.profile,
          systemPrompt: input.systemPrompt
        })
        return { summary: 'general investigation complete' }
      }
    })
    const routerModel = new StaticRouterModel(JSON.stringify({
      decision: 'generate',
      roleBrief: 'Electron IPC investigator that returns file-cited evidence.',
      permissionHint: 'readOnly',
      confidence: 0.92,
      reason: 'No fixed profile is narrow enough.'
    }))
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(
        runtime,
        new SubagentRouter({ modelClient: routerModel, defaultModel: () => 'router-model' })
      ))
    })
    const result = await host.execute({
      callId: 'call_generated',
      toolName: 'delegate_task',
      arguments: { prompt: 'Investigate a novel Electron IPC contract mismatch' }
    }, {
      threadId: 'thr_generated',
      turnId: 'turn_generated',
      workspace: dir,
      model: {
        id: 'gpt-5.6-luna',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      },
      modelProviderId: 'openai',
      reasoningEffort: 'high',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(result.item).not.toHaveProperty('output.generatedAgent')
    expect(seen).toEqual([{ profile: 'general', systemPrompt: undefined }])
    expect((await runtime.diagnostics('thr_generated')).childRuns[0]).toMatchObject({
      profile: 'general',
      model: 'gpt-5.6-luna',
      providerId: 'openai',
      routing: {
        method: 'bm25-fallback-profile',
        selectedKind: 'profile',
        selectedId: 'general'
      }
    })
    expect(routerModel.requests).toHaveLength(1)
  })

  it('runs a parent-defined one-run role when existing-agent reuse is disabled', async () => {
    const seen: Array<{ profile?: string; systemPrompt?: string }> = []
    const runtime = createRuntime({
      useExistingAgents: false,
      profiles: { general: { toolPolicy: 'inherit' } },
      executor: async (input) => {
        seen.push({ profile: input.profile, systemPrompt: input.systemPrompt })
        return { summary: 'custom review complete' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_custom_role',
      toolName: 'delegate_task',
      arguments: {
        prompt: 'Review the IPC boundary',
        custom_agent: {
          name: 'IPC Reviewer',
          description: 'Reviews IPC contracts.',
          system_prompt: 'Review IPC contracts, cite concrete evidence, and never delegate.',
          tool_policy: 'readOnly'
        }
      }
    }, {
      threadId: 'thr_custom_role',
      turnId: 'turn_custom_role',
      workspace: dir,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen).toEqual([{
      profile: 'custom:ipc-reviewer',
      systemPrompt: 'Review IPC contracts, cite concrete evidence, and never delegate.'
    }])
    expect((await runtime.diagnostics('thr_custom_role')).childRuns[0]).toMatchObject({
      profile: 'custom:ipc-reviewer',
      profileSource: 'custom',
      routing: {
        method: 'explicit-custom',
        selectedKind: 'custom',
        selectedId: 'custom:ipc-reviewer'
      }
    })
  })

  it('rejects custom_agent in existing-profile mode before consuming a child-run slot', async () => {
    const runtime = createRuntime({ profiles: { general: { toolPolicy: 'inherit' } } })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_conflict',
      toolName: 'delegate_task',
      arguments: {
        prompt: 'work',
        profile: 'general',
        custom_agent: {
          name: 'Custom',
          description: 'One task.',
          system_prompt: 'Do the task.'
        }
      }
    }, {
      threadId: 'thr_conflict',
      turnId: 'turn_conflict',
      workspace: dir,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: true,
      output: {
        error: expect.stringContaining('custom_agent is unavailable')
      }
    })
    expect((await runtime.diagnostics('thr_conflict')).childRuns).toEqual([])
  })

  it('does not advertise execution budgets for delegate_task', () => {
    const runtime = createRuntime()
    const tools = buildDelegationToolProviders(runtime)[0]?.tools ?? []
    const tool = tools.find((candidate) => candidate.name === 'delegate_task')
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined

    expect(tool?.description).toContain('Run a standalone child agent')
    expect(tool?.description).not.toContain('bounded child agent task')
    expect(properties).not.toHaveProperty('tokenBudget')
    expect(properties).not.toHaveProperty('timeBudgetMs')
    expect(properties).not.toHaveProperty('skill_id')
    expect(tools.map((candidate) => candidate.name)).toEqual([
      'delegate_task',
      'list_subagent_profiles'
    ])
  })

  function createRuntime(options: {
    enabled?: boolean
    useExistingAgents?: boolean
    maxParallel?: number
    legacyMaxChildRuns?: number
    idNamespace?: string
    defaultToolPolicy?: 'readOnly' | 'inherit'
    defaultProfile?: string
    profiles?: Record<string, Partial<SubagentProfileConfig>>
    sessionStore?: InMemorySessionStore
    eventBus?: InMemoryEventBus
    executor?: ConstructorParameters<typeof DelegationRuntime>[0]['executor']
    recordExternalUsage?: ConstructorParameters<typeof DelegationRuntime>[0]['recordExternalUsage']
  } = {}) {
    const sessionStore = options.sessionStore ?? new InMemorySessionStore()
    const bus = options.eventBus ?? new InMemoryEventBus()
    const recorder = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (threadId) => bus.allocateSeq(threadId),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
    const profiles = options.profiles ?? {
      general: { description: 'General worker', toolPolicy: 'inherit' as const }
    }
    const defaultProfile = options.defaultProfile
    const config = KunCapabilitiesConfig.parse({
      subagents: {
        enabled: options.enabled ?? true,
        useExistingAgents: options.useExistingAgents ?? true,
        maxParallel: options.maxParallel ?? 1,
        ...(options.legacyMaxChildRuns !== undefined
          ? { maxChildRuns: options.legacyMaxChildRuns }
          : {}),
        ...(options.defaultToolPolicy ? { defaultToolPolicy: options.defaultToolPolicy } : {}),
        ...(defaultProfile ? { defaultProfile } : {}),
        profiles
      }
    }).subagents
    let idSeq = 0
    return new DelegationRuntime({
      config,
      store: new FileDelegationStore(join(dir, 'children')),
      events: recorder,
      eventBus: bus,
      nowIso: () => '2026-06-03T00:00:00.000Z',
      idGenerator: () => options.idNamespace
        ? `child_${options.idNamespace}_${++idSeq}`
        : `child_${++idSeq}_${Math.random().toString(36).slice(2, 6)}`,
      recordExternalUsage: options.recordExternalUsage,
      executor: options.executor ?? (async ({ prompt }) => ({
        summary: `done: ${prompt}`,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      }))
    })
  }
})
