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
