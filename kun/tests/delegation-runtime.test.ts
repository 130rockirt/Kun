import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { buildDelegationToolProviders } from '../src/adapters/tool/delegation-tool-provider.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig, type SubagentProfileConfig } from '../src/contracts/capabilities.js'
import { emptyUsageSnapshot } from '../src/contracts/usage.js'
import { BUILTIN_SUBAGENT_PROFILES } from '../src/delegation/builtin-profiles.js'
import {
  ChildRunRecord,
  DelegationRuntime,
  FileDelegationStore,
  type ChildRunExecutor
} from '../src/delegation/delegation-runtime.js'
import { SubagentRouter } from '../src/delegation/subagent-router.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'

class StaticRouterModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'router-model'
  readonly requests: ModelRequest[] = []

  constructor(private readonly response: string) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: this.response }
    yield { kind: 'usage', usage: emptyUsageSnapshot() }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

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

  it('denies disabled delegation and exhausted child budgets', async () => {
    const disabled = createRuntime({ enabled: false })
    await expect(disabled.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'x',
      signal: new AbortController().signal
    })).rejects.toThrow(/disabled/)

    const budgeted = createRuntime({ maxChildRuns: 1 })
    await budgeted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'first',
      signal: new AbortController().signal
    })
    await expect(budgeted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'second',
      signal: new AbortController().signal
    })).rejects.toThrow(/limit/)
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

  it('keeps built-in specialists searchable without embedding the full roster in the tool schema', () => {
    const runtime = createRuntime({ profiles: { ...BUILTIN_SUBAGENT_PROFILES } })
    const tool = buildDelegationToolProviders(runtime)[0]?.tools[0]
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined
    const profile = properties?.profile as { enum?: string[] } | undefined

    expect(profile?.enum).toBeUndefined()
    expect(runtime.listProfiles().map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'code-reviewer',
      'test-engineer',
      'security-auditor',
      'web-performance-auditor'
    ]))
    expect(tool?.description).toContain('reusable profile id')
    expect(tool?.description).not.toContain('Senior code reviewer')
  })

  it('includes workspace overlays in automatic routing and honors inherit snapshots', async () => {
    const runtime = createRuntime({
      profiles: {
        reviewer: { description: 'Configured reviewer', toolPolicy: 'readOnly' },
        primary: { description: 'Primary only', mode: 'primary', toolPolicy: 'inherit' },
        'code-only': {
          description: 'Code-only implementation role',
          surfaces: ['code'],
          toolPolicy: 'inherit'
        },
        'design-only': {
          description: 'Design-only implementation role',
          surfaces: ['design'],
          toolPolicy: 'inherit'
        }
      }
    })
    const agentDir = join(dir, '.kun', 'agents')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'reviewer.md'), [
      '---',
      'id: reviewer',
      'name: Workspace Reviewer',
      'description: Workspace-specific API contract review',
      'toolPolicy: inherit',
      'model: external-model',
      'providerId: external-provider',
      'allowedTools: [read, bash]',
      '---',
      'Review API contracts in this workspace.'
    ].join('\n'), 'utf8')
    await writeFile(join(agentDir, 'workspace-only.md'), [
      '---',
      'id: workspace-only',
      'name: Workspace Only',
      'description: Unique workspace routing keyword for API contracts',
      'toolPolicy: readOnly',
      '---',
      'Workspace-only role body.'
    ].join('\n'), 'utf8')

    const documents = await runtime.listRoutingProfiles(dir)
    expect(documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'reviewer',
        source: 'workspace',
        profile: expect.objectContaining({
          name: 'Workspace Reviewer',
          description: 'Workspace-specific API contract review',
          toolPolicy: 'inherit',
          allowedTools: ['read', 'bash']
        })
      }),
      expect.objectContaining({ id: 'workspace-only', source: 'workspace' })
    ]))
    expect(documents.find((item) => item.id === 'primary')).toBeUndefined()
    await expect(runtime.resolveProfileSnapshot('reviewer', dir)).resolves.toEqual(expect.objectContaining({
      id: 'reviewer',
      source: 'workspace',
      profile: expect.objectContaining({
        name: 'Workspace Reviewer',
        description: 'Workspace-specific API contract review',
        toolPolicy: 'inherit',
        allowedTools: ['read', 'bash'],
        skillsEnabled: false
      })
    }))
    const workspaceProfile = await runtime.resolveProfileSnapshot('reviewer', dir)
    expect(workspaceProfile?.profile.model).toBeUndefined()
    expect(workspaceProfile?.profile.providerId).toBeUndefined()

    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const discovered = await host.execute({
      callId: 'call_list_profiles',
      toolName: 'list_subagent_profiles',
      arguments: {}
    }, {
      threadId: 'thr_list_profiles',
      turnId: 'turn_list_profiles',
      workspace: dir,
      agentSurface: 'design',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })
    if (discovered.item.kind !== 'tool_result') {
      throw new Error(`expected tool_result, received ${discovered.item.kind}`)
    }
    const discoveredOutput = discovered.item.output as {
      profiles: Array<{ id: string; name: string; description: string; toolPolicy: string }>
    }
    expect(discovered.item).toMatchObject({
      kind: 'tool_result',
      isError: false,
      output: {
        mode: 'profiles-only',
        surface: 'design'
      }
    })
    expect(discovered.item.output).not.toHaveProperty('customAgent')
    expect(discoveredOutput.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'reviewer',
        name: 'Workspace Reviewer',
        description: 'Workspace-specific API contract review',
        toolPolicy: 'inherit'
      }),
      expect.objectContaining({
        id: 'workspace-only',
        name: 'Workspace Only',
        toolPolicy: 'readOnly'
      }),
      expect.objectContaining({ id: 'design-only' })
    ]))
    expect(discoveredOutput.profiles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary' }),
      expect.objectContaining({ id: 'code-only' })
    ]))
    expect(JSON.stringify(discovered.item.output)).not.toContain('Workspace-only role body.')

    await expect(runtime.listWorkspaceProfiles(dir)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'workspace-only',
        source: 'workspace',
        name: 'Workspace Only',
        description: 'Unique workspace routing keyword for API contracts',
        toolPolicy: 'readOnly'
      }),
      expect.objectContaining({
        id: 'reviewer',
        source: 'workspace',
        name: 'Workspace Reviewer',
        toolPolicy: 'inherit',
        allowedTools: ['read', 'bash']
      })
    ]))
  })

  it('inherits the parent model providerId through delegate_task', async () => {
    const seen: Array<string | undefined> = []
    const runtime = createRuntime({
      executor: async (input) => {
        seen.push(input.providerId)
        return { summary: 'done' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })

    const result = await host.execute({
      callId: 'call_provider',
      toolName: 'delegate_task',
      arguments: { label: 'Provider', prompt: 'Check routing' }
    }, {
      threadId: 'thr_provider',
      turnId: 'turn_provider',
      workspace: '/tmp/ws',
      model: {
        id: 'opencode-model',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      },
      modelProviderId: 'opencode-go',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen).toEqual(['opencode-go'])
    expect((await runtime.diagnostics('thr_provider')).childRuns[0]?.providerId).toBe('opencode-go')
  })

  it('ignores a stale user-facing delegate_task model override', async () => {
    const seen: Array<{ model?: string; providerId?: string }> = []
    const runtime = createRuntime({
      executor: async (input) => {
        seen.push({ model: input.model, providerId: input.providerId })
        return { summary: 'done' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })

    const result = await host.execute({
      callId: 'call_partial_model',
      toolName: 'delegate_task',
      arguments: { prompt: 'Check routing', model: 'gpt-5.3-codex-spark' }
    }, {
      threadId: 'thr_partial_model',
      turnId: 'turn_partial_model',
      workspace: '/tmp/ws',
      model: {
        id: 'deepseek-v4-pro',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        contextWindowTokens: 128000,
        messageParts: ['text']
      },
      modelProviderId: 'deepseek',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(seen).toEqual([{ model: 'deepseek-v4-pro', providerId: 'deepseek' }])
    expect((await runtime.diagnostics('thr_partial_model')).childRuns[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek'
    })
  })

  it('preserves the delegating turn approval and sandbox policies', async () => {
    const seen: Array<{ approvalPolicy: string | undefined; sandboxMode: string | undefined }> = []
    const runtime = createRuntime({
      executor: async (input) => {
        seen.push({
          approvalPolicy: input.approvalPolicy,
          sandboxMode: input.sandboxMode
        })
        return { summary: 'done' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })

    await host.execute({
      callId: 'call_policy',
      toolName: 'delegate_task',
      arguments: { label: 'Policy', prompt: 'Inspect without changing files' }
    }, {
      threadId: 'thr_policy',
      turnId: 'turn_policy',
      workspace: '/tmp/ws',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(seen).toEqual([{ approvalPolicy: 'on-request', sandboxMode: 'read-only' }])
    expect((await runtime.diagnostics('thr_policy')).childRuns[0]).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only'
    })
  })

  it('keeps a subagent profile providerId ahead of the inherited parent provider', async () => {
    const seen: Array<string | undefined> = []
    const runtime = createRuntime({
      defaultProfile: 'reviewer',
      profiles: {
        reviewer: {
          model: 'profile-model',
          providerId: 'profile-provider',
          toolPolicy: 'readOnly'
        }
      },
      executor: async (input) => {
        seen.push(input.providerId)
        return { summary: 'done' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })

    await host.execute({
      callId: 'call_profile_provider',
      toolName: 'delegate_task',
      arguments: { label: 'Profile', prompt: 'Check profile routing' }
    }, {
      threadId: 'thr_profile_provider',
      turnId: 'turn_profile_provider',
      workspace: '/tmp/ws',
      modelProviderId: 'opencode-go',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(seen).toEqual(['profile-provider'])
    expect((await runtime.diagnostics('thr_profile_provider')).childRuns[0]?.providerId).toBe('profile-provider')
  })

  it('forwards guiDesignCanvas from delegate_task context into the child run', async () => {
    const seen: boolean[] = []
    const runtime = createRuntime({
      executor: async (input) => {
        seen.push(input.guiDesignCanvas === true)
        return { summary: 'done' }
      }
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })

    const result = await host.execute({
      callId: 'call_canvas',
      toolName: 'delegate_task',
      arguments: { label: 'Canvas', prompt: 'Add a screen' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      guiDesignCanvas: true,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(seen).toEqual([true])
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
  })

  it('ignores legacy delegate_task budget arguments instead of enforcing them', async () => {
    const runtime = createRuntime()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_invalid_budget',
      toolName: 'delegate_task',
      arguments: { prompt: 'Investigate', tokenBudget: 0 }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect((await runtime.diagnostics('thr_1')).childRuns).toEqual([
      expect.objectContaining({ status: 'completed' })
    ])
    expect((await runtime.diagnostics('thr_1')).childRuns[0]).not.toHaveProperty('tokenBudget')
  })

  it('caps concurrency at maxParallel and queues the overflow instead of erroring', async () => {
    const gate = deferred<void>()
    let active = 0
    let maxObservedActive = 0
    const runtime = createRuntime({
      maxParallel: 2,
      maxChildRuns: 10,
      executor: async ({ prompt }) => {
        active += 1
        maxObservedActive = Math.max(maxObservedActive, active)
        await gate.promise
        active -= 1
        return { summary: `done: ${prompt}` }
      }
    })
    const signal = new AbortController().signal
    const runs = [0, 1, 2, 3].map((index) =>
      runtime.runChild({ parentThreadId: 'thr_1', parentTurnId: 'turn_1', prompt: `p${index}`, signal })
    )
    // Two children start; the other two wait on a parallel slot.
    await waitFor(() => maxObservedActive >= 2)
    expect(active).toBe(2)
    gate.resolve()
    const results = await Promise.all(runs)
    expect(results.every((record) => record.status === 'completed')).toBe(true)
    expect(maxObservedActive).toBe(2)
    expect((await runtime.diagnostics('thr_1')).childRuns).toHaveLength(4)
  })

  it('marks a child aborted while it is still queued', async () => {
    const gate = deferred<void>()
    const controller = new AbortController()
    const runtime = createRuntime({
      maxParallel: 1,
      executor: async () => {
        await gate.promise
        return { summary: 'blocking' }
      }
    })
    // Drive the only slot to a confirmed running state before enqueuing the
    // second child, so the abort target is deterministically the queued one.
    const blocking = runtime.runChild({ parentThreadId: 'thr_1', parentTurnId: 'turn_1', prompt: 'hold', signal: new AbortController().signal })
    await waitFor(async () => (await runtime.diagnostics('thr_1')).childRuns.some((run) => run.status === 'running'))
    const queued = runtime.runChild({ parentThreadId: 'thr_1', parentTurnId: 'turn_1', prompt: 'wait', signal: controller.signal })
    await waitFor(async () => (await runtime.diagnostics('thr_1')).childRuns.some((run) => run.status === 'queued'))
    controller.abort()
    await expect(queued).resolves.toMatchObject({ status: 'aborted' })
    gate.resolve()
    await expect(blocking).resolves.toMatchObject({ status: 'completed' })
  })

  it('resolves a profile to model, provider, preamble, and tool policy', async () => {
    const seen: Array<{ model?: string; providerId?: string; promptPreamble?: string; toolPolicy: string }> = []
    const runtime = createRuntime({
      defaultProfile: 'reviewer',
      profiles: {
        reviewer: { model: 'deepseek-v4-pro', providerId: 'minimax', promptPreamble: 'Review for bugs.', toolPolicy: 'readOnly' }
      },
      executor: async (input) => {
        seen.push({ model: input.model, providerId: input.providerId, promptPreamble: input.promptPreamble, toolPolicy: input.toolPolicy })
        return { summary: 'reviewed', toolInvocations: 2, prefixReused: true, inheritedHistoryItems: 0 }
      }
    })
    const record = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'check the diff',
      signal: new AbortController().signal
    })
    expect(seen[0]).toMatchObject({ model: 'deepseek-v4-pro', providerId: 'minimax', promptPreamble: 'Review for bugs.', toolPolicy: 'readOnly' })
    expect(record).toMatchObject({
      profile: 'reviewer',
      toolPolicy: 'readOnly',
      model: 'deepseek-v4-pro',
      providerId: 'minimax',
      toolInvocations: 2,
      prefixReused: true,
      inheritedHistoryItems: 0
    })
  })

  it('threads profile deny-lists and always blocks recursive delegation in the child executor', async () => {
    const seen: Array<{ blockedTools?: string[]; blockedMcpServers?: string[]; blockedSkills?: string[] }> = []
    const runtime = createRuntime({
      defaultProfile: 'scoped',
      profiles: {
        scoped: {
          toolPolicy: 'inherit',
          blockedTools: ['bash', 'write'],
          blockedMcpServers: ['github'],
          blockedSkills: ['deep-research']
        }
      },
      executor: async (input) => {
        seen.push({
          blockedTools: input.blockedTools,
          blockedMcpServers: input.blockedMcpServers,
          blockedSkills: input.blockedSkills
        })
        return { summary: 'ok' }
      }
    })
    await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'go',
      signal: new AbortController().signal
    })
    expect(seen[0]).toEqual({
      blockedTools: ['delegate_task', 'generate_subagent', 'bash', 'write'],
      blockedMcpServers: ['github'],
      blockedSkills: ['deep-research']
    })
  })

  it('routes a child through an explicit model/provider pair, overriding the profile, and surfaces it on the event', async () => {
    const sessionStore = new InMemorySessionStore()
    const seen: Array<{ providerId?: string }> = []
    const runtime = createRuntime({
      sessionStore,
      defaultProfile: 'reviewer',
      profiles: {
        reviewer: {
          model: 'minimax-model',
          providerId: 'minimax',
          toolPolicy: 'readOnly'
        }
      },
      executor: async (input) => {
        seen.push({ providerId: input.providerId })
        return { summary: 'ok' }
      }
    })
    // An explicit providerId on the call wins over the profile's providerId.
    const record = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'go',
      model: 'anthropic-model',
      providerId: 'anthropic',
      signal: new AbortController().signal
    })
    expect(seen[0]?.providerId).toBe('anthropic')
    expect(record.providerId).toBe('anthropic')
    const events = await sessionStore.loadEventsSince('thr_1', 0)
    const completed = events.find((event) => event.child?.childId === record.id && event.child.childStatus === 'completed')
    expect(completed?.child?.childProviderId).toBe('anthropic')
  })

  it('rejects an unknown profile name', async () => {
    const runtime = createRuntime({ profiles: { reviewer: { toolPolicy: 'readOnly' } } })
    await expect(runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'x',
      profile: 'ghost',
      signal: new AbortController().signal
    })).rejects.toThrow(/unknown subagent profile/)
  })

  it('rejects inherited Object.prototype names as unknown profiles without creating children', async () => {
    const runtime = createRuntime({ profiles: { reviewer: { toolPolicy: 'readOnly' } } })
    for (const profile of ['constructor', 'toString', '__proto__']) {
      await expect(runtime.runChild({
        parentThreadId: 'thr_prototype_profile',
        parentTurnId: 'turn_1',
        prompt: 'x',
        profile,
        signal: new AbortController().signal
      })).rejects.toThrow(/unknown subagent profile/)
    }
    expect((await runtime.diagnostics('thr_prototype_profile')).childRuns).toEqual([])
  })

  it('defaults the tool policy to inherit (follow the main agent) when no profile resolves', async () => {
    const seen: string[] = []
    const runtime = createRuntime({
      executor: async (input) => {
        seen.push(input.toolPolicy)
        return { summary: 'ok' }
      }
    })
    const record = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'investigate',
      signal: new AbortController().signal
    })
    expect(seen[0]).toBe('inherit')
    expect(record.toolPolicy).toBe('inherit')
  })

  it('still honors an explicit read-only default tool policy', async () => {
    const seen: string[] = []
    const runtime = createRuntime({
      defaultToolPolicy: 'readOnly',
      executor: async (input) => {
        seen.push(input.toolPolicy)
        return { summary: 'ok' }
      }
    })
    const record = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'investigate',
      signal: new AbortController().signal
    })
    expect(seen[0]).toBe('readOnly')
    expect(record.toolPolicy).toBe('readOnly')
  })

  it('emits queued -> running -> completed events with observability metrics', async () => {
    const sessionStore = new InMemorySessionStore()
    const runtime = createRuntime({
      sessionStore,
      executor: async () => ({
        summary: 'ok',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cacheHitRate: 0.5, costUsd: 0.01 },
        toolInvocations: 4,
        prefixReused: true,
        inheritedHistoryItems: 0
      })
    })
    const record = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'go',
      signal: new AbortController().signal
    })
    const events = await sessionStore.loadEventsSince('thr_1', 0)
    const statuses = events
      .filter((event) => event.child?.childId === record.id)
      .map((event) => event.child?.childStatus)
    expect(statuses).toEqual(['queued', 'running', 'completed'])
    const completed = events.find((event) => event.child?.childId === record.id && event.child.childStatus === 'completed')
    expect(completed?.child).toMatchObject({
      toolInvocations: 4,
      prefixReused: true,
      totalTokens: 3,
      cacheHitRate: 0.5,
      childToolPolicy: 'inherit'
    })
  })

  it('returns immediately when detach=true and keeps executing in the background', async () => {
    const start = deferred<void>()
    const release = deferred<void>()
    let executorStarted = false
    const runtime = createRuntime({
      executor: async () => {
        executorStarted = true
        start.resolve()
        await release.promise
        return { summary: 'background done' }
      }
    })
    const queued = await runtime.runChild({
      parentThreadId: 'thr_detach',
      parentTurnId: 'turn_detach',
      prompt: 'long running task',
      detach: true,
      signal: new AbortController().signal
    })
    // Immediately returns with status 'queued' — synchronous runs would
    // have returned 'completed' here.
    expect(queued.status).toBe('queued')
    // The executor actually runs in the background.
    await start.promise
    expect(executorStarted).toBe(true)
    let diagnostics = await runtime.diagnostics('thr_detach')
    expect(diagnostics.childRuns[0]?.status).toBe('running')
    // Release the executor and wait for the record to flip to completed.
    release.resolve()
    await waitFor(async () => {
      diagnostics = await runtime.diagnostics('thr_detach')
      return diagnostics.childRuns[0]?.status === 'completed'
    })
    expect(diagnostics.childRuns[0]?.summary).toBe('background done')
  })

  it('moves a live foreground child into the background without restarting it', async () => {
    const start = deferred<void>()
    const release = deferred<void>()
    let childSignal: AbortSignal | undefined
    let executions = 0
    const runtime = createRuntime({
      executor: async ({ signal }) => {
        executions += 1
        childSignal = signal
        start.resolve()
        await release.promise
        if (signal.aborted) throw new Error('unexpected abort')
        return {
          summary: 'continued in background',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        }
      }
    })
    const parent = new AbortController()
    const foreground = runtime.runChild({
      parentThreadId: 'thr_dynamic_detach',
      parentTurnId: 'turn_dynamic_detach',
      prompt: 'long foreground task',
      signal: parent.signal
    })
    await start.promise
    const diagnostics = await runtime.diagnostics('thr_dynamic_detach')
    const childId = diagnostics.childRuns[0]!.id

    expect(await runtime.detachChild(childId)).toBe(true)
    const released = await foreground
    expect(released).toMatchObject({ id: childId, status: 'running', detached: true })
    expect(await runtime.detachChild(childId)).toBe(false)
    parent.abort()
    expect(childSignal?.aborted).toBe(false)
    expect(executions).toBe(1)

    release.resolve()
    await waitFor(async () => {
      const latest = await runtime.diagnostics('thr_dynamic_detach')
      return latest.childRuns[0]?.status === 'completed'
    })
    const completed = (await runtime.diagnostics('thr_dynamic_detach')).childRuns[0]
    expect(completed).toMatchObject({
      id: childId,
      status: 'completed',
      detached: true,
      summary: 'continued in background',
      usage: { totalTokens: 15 }
    })
    expect(runtime.abortChild(childId)).toBe(false)
    expect(await runtime.detachChild('child_unknown')).toBe(false)
  })

  it('mirrors safe child activity phases onto the parent without reasoning text', async () => {
    const bus = new InMemoryEventBus()
    const sessionStore = new InMemorySessionStore()
    const started = deferred<string>()
    const release = deferred<void>()
    const runtime = createRuntime({
      eventBus: bus,
      sessionStore,
      executor: async ({ childId }) => {
        started.resolve(childId)
        await release.promise
        return { summary: 'activity complete' }
      }
    })
    const running = runtime.runChild({
      parentThreadId: 'thr_activity',
      parentTurnId: 'turn_activity',
      prompt: 'inspect activity',
      signal: new AbortController().signal
    })
    const childId = await started.promise
    bus.publish({
      kind: 'assistant_reasoning_delta',
      seq: 1,
      timestamp: '2026-06-03T00:00:01.000Z',
      threadId: childId,
      turnId: 'turn_child',
      itemId: 'reason_child',
      item: {
        id: 'reason_child',
        threadId: childId,
        turnId: 'turn_child',
        role: 'assistant',
        status: 'running',
        kind: 'assistant_reasoning',
        text: 'private chain of thought',
        createdAt: '2026-06-03T00:00:01.000Z'
      }
    })
    await waitFor(async () => {
      const child = (await runtime.diagnostics('thr_activity')).childRuns[0]
      return child?.activity?.phase === 'thinking'
    })
    bus.publish({
      kind: 'tool_call_started',
      seq: 2,
      timestamp: '2026-06-03T00:00:02.000Z',
      threadId: childId,
      turnId: 'turn_child',
      itemId: 'tool_child',
      item: {
        id: 'tool_child',
        threadId: childId,
        turnId: 'turn_child',
        role: 'assistant',
        status: 'running',
        kind: 'tool_call',
        toolName: 'search',
        callId: 'call_child',
        toolKind: 'tool_call',
        arguments: { query: 'secret query' },
        summary: 'Searching the workspace',
        createdAt: '2026-06-03T00:00:02.000Z'
      }
    })
    await waitFor(async () => {
      const child = (await runtime.diagnostics('thr_activity')).childRuns[0]
      return child?.activity?.phase === 'tool'
    })

    const child = (await runtime.diagnostics('thr_activity')).childRuns[0]
    expect(child?.activity).toMatchObject({
      phase: 'tool',
      label: 'Searching the workspace',
      toolName: 'search'
    })
    const parentEvents = await sessionStore.loadEventsSince('thr_activity', 0)
    const progress = parentEvents.filter((event) => event.child?.childId === childId && event.child.activity)
    expect(progress.map((event) => event.child?.activity?.phase)).toEqual(['thinking', 'tool'])
    expect(JSON.stringify(progress)).not.toContain('private chain of thought')
    expect(JSON.stringify(progress)).not.toContain('secret query')

    release.resolve()
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })

  it('abortChild signals a detached run and false-returns for unknown ids', async () => {
    const start = deferred<void>()
    const runtime = createRuntime({
      executor: async ({ signal }) => {
        start.resolve()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
        return { summary: 'unreachable' }
      }
    })
    const queued = await runtime.runChild({
      parentThreadId: 'thr_abort',
      parentTurnId: 'turn_abort',
      prompt: 'long task',
      detach: true,
      signal: new AbortController().signal
    })
    await start.promise
    expect(runtime.abortChild(queued.id)).toBe(true)
    await waitFor(async () => {
      const diagnostics = await runtime.diagnostics('thr_abort')
      return diagnostics.childRuns[0]?.status === 'aborted'
    })
    // After the run finished the controller is cleaned up via .finally.
    // Poll because the cleanup runs in a microtask after the run resolves.
    await waitFor(() => runtime.abortChild(queued.id) === false)
    expect(runtime.abortChild('child_unknown')).toBe(false)
  })

  it('aggregates child runs by label and model for dashboards', async () => {
    const runtime = createRuntime()
    await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'first',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek',
      signal: new AbortController().signal
    })
    await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'second',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek',
      signal: new AbortController().signal
    })

    const diagnostics = await runtime.diagnostics('thr_1')
    expect(diagnostics.aggregates[0]).toMatchObject({
      key: 'research:deepseek-v4-flash',
      runs: 2,
      completed: 2,
      totalTokens: 6,
      averageTotalTokens: 3
    })
  })

  it('records child failure and parent interruption states', async () => {
    const failed = createRuntime({
      executor: async () => {
        throw new Error('child failed')
      }
    })
    await expect(failed.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'fail',
      signal: new AbortController().signal
    })).resolves.toMatchObject({ status: 'failed', error: 'child failed' })

    const controller = new AbortController()
    controller.abort()
    const aborted = createRuntime({
      executor: async ({ signal }) => {
        if (signal.aborted) throw new Error('aborted')
        return { summary: 'unreachable' }
      }
    })
    await expect(aborted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'abort',
      signal: controller.signal
    })).rejects.toThrow('aborted before routing completed')
  })

  it('reconciles child runs left running/queued by a previous process, leaving terminal ones', async () => {
    const store = new FileDelegationStore(join(dir, 'children'))
    const base = {
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'x',
      toolPolicy: 'inherit' as const,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z'
    }
    await store.upsert(ChildRunRecord.parse({ ...base, id: 'child_run', status: 'running' }))
    await store.upsert(ChildRunRecord.parse({ ...base, id: 'child_queued', status: 'queued' }))
    await store.upsert(ChildRunRecord.parse({ ...base, id: 'child_done', status: 'completed' }))
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'children'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, 'children', 'child_run.json'))).mode & 0o777).toBe(0o600)
    }

    const runtime = createRuntime({})
    const reconciled = await runtime.reconcileOrphanedChildRuns()
    expect(reconciled).toBe(2)

    const byId = new Map((await store.list('thr_1')).map((run) => [run.id, run]))
    expect(byId.get('child_run')?.status).toBe('failed')
    expect(byId.get('child_run')?.error).toMatch(/interrupted by a runtime restart/)
    expect(byId.get('child_queued')?.status).toBe('failed')
    // Terminal records are left exactly as they were.
    expect(byId.get('child_done')?.status).toBe('completed')

    // Idempotent: a second sweep finds nothing new.
    expect(await runtime.reconcileOrphanedChildRuns()).toBe(0)
  })

  function createRuntime(options: {
    enabled?: boolean
    useExistingAgents?: boolean
    maxParallel?: number
    maxChildRuns?: number
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
        maxChildRuns: options.maxChildRuns ?? 3,
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
      idGenerator: () => `child_${++idSeq}_${Math.random().toString(36).slice(2, 6)}`,
      recordExternalUsage: options.recordExternalUsage,
      executor: options.executor ?? (async ({ prompt }) => ({
        summary: `done: ${prompt}`,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      }))
    })
  }
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
