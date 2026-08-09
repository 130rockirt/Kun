import { describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSdkRuntime, resolveTurnPlanContext, waitForGate } from './agent-sdk-runtime-factory.js'
import { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import type { ThreadRecord } from '../../contracts/threads.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../../ports/user-input-gate.js'
import { InstructionRuntime } from '../../instructions/instruction-runtime.js'
import { CapabilityRegistry } from '../../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../../adapters/tool/local-tool-host.js'
import { InMemoryApprovalGate } from '../../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../../adapters/in-memory-user-input-gate.js'
import { goalContextKey } from '../../loop/continuation-instructions.js'
import type { TurnRunOutcome } from '../../loop/turn-execution-types.js'
import {
  DelegatedSessionCoordinator,
  FileDelegatedSessionBindingStore,
  type DelegatedSessionPreparation
} from '../delegated-session-binding.js'

function fakeGate(pending: Promise<UserInputResolution>): {
  gate: UserInputGate
  resolvedWith: UserInputResolution[]
} {
  const resolvedWith: UserInputResolution[] = []
  const gate = {
    request: () => pending,
    resolve: (_id: string, resolution: UserInputResolution) => {
      resolvedWith.push(resolution)
      return true
    },
    get: () => undefined,
    pending: () => []
  } as unknown as UserInputGate
  return { gate, resolvedWith }
}

const req: UserInputRequest = { id: 'in1', threadId: 'th', turnId: 'tn', itemId: 'it1', prompt: 'pick', questions: [] }

describe('waitForGate', () => {
  test('resolves with the gate answer when the user submits', async () => {
    const answer: UserInputResolution = { status: 'submitted', answers: [] }
    const { gate } = fakeGate(Promise.resolve(answer))
    expect(await waitForGate(gate, req, new AbortController().signal)).toEqual(answer)
  })

  test('an already-aborted turn cancels the request immediately', async () => {
    const { gate, resolvedWith } = fakeGate(new Promise(() => {})) // never resolves
    const ac = new AbortController()
    ac.abort()
    expect(await waitForGate(gate, req, ac.signal)).toEqual({ status: 'cancelled' })
    expect(resolvedWith).toEqual([{ status: 'cancelled' }])
  })

  test('aborting mid-wait cancels the pending request and rejects', async () => {
    const { gate, resolvedWith } = fakeGate(new Promise(() => {}))
    const ac = new AbortController()
    const waiting = waitForGate(gate, req, ac.signal)
    ac.abort()
    await expect(waiting).rejects.toThrow(/cancelled/)
    expect(resolvedWith).toEqual([{ status: 'cancelled' }])
  })
})

function threadWith(partial: Partial<ThreadRecord>): ThreadRecord {
  const thread = {
    id: 'th',
    title: 't',
    workspace: '/ws',
    model: 'claude-haiku-4-5',
    mode: 'agent',
    status: 'idle',
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    approvalReviewer: 'user',
    relation: 'primary',
    createdAt: '2026-06-27T00:00:00Z',
    updatedAt: '2026-06-27T00:00:00Z',
    turns: [{ id: 'tn', prompt: 'test turn' } as ThreadRecord['turns'][number]],
    ...partial
  } as ThreadRecord
  return {
    ...thread,
    turns: thread.turns.map((turn) => ({
      actingModelRoute: {
        model: turn.model?.trim() || thread.model,
        ...(turn.providerId?.trim() || thread.providerId?.trim()
          ? { providerId: turn.providerId?.trim() || thread.providerId?.trim() }
          : {}),
        ...(turn.accountId?.trim() || thread.accountId?.trim()
          ? { accountId: turn.accountId?.trim() || thread.accountId?.trim() }
          : {})
      },
      approvalReviewer: turn.approvalReviewer ?? thread.approvalReviewer ?? 'user',
      ...turn
    }))
  } as ThreadRecord
}

const planTurn = (id: string, workspaceRoot: string): ThreadRecord['turns'][number] =>
  ({
    id,
    prompt: 'plan it',
    guiPlan: { operation: 'draft', workspaceRoot, relativePath: '.kun/plan.md', planId: 'p1' }
  }) as ThreadRecord['turns'][number]

describe('resolveTurnPlanContext', () => {
  test('exposes the GUI plan + planMode for a plan turn in the same workspace', () => {
    const thread = threadWith({ workspace: '/ws', turns: [planTurn('tn', '/ws')] })
    const resolved = resolveTurnPlanContext(thread, 'tn')
    expect(resolved.planMode).toBe(true)
    expect(resolved.guiPlan?.relativePath).toBe('.kun/plan.md')
    expect(resolved.guiPlan?.turnId).toBe('tn')
  })

  test('drops a stale plan whose workspace does not match the thread', () => {
    const thread = threadWith({ workspace: '/ws', turns: [planTurn('tn', '/other-ws')] })
    const resolved = resolveTurnPlanContext(thread, 'tn')
    expect(resolved.guiPlan).toBeUndefined()
    // mode falls back to the thread mode (no live plan to force plan mode)
    expect(resolved.planMode).toBe(false)
  })

  test('plan mode via thread.mode without a GUI plan', () => {
    const thread = threadWith({ mode: 'plan', turns: [{ id: 'tn', prompt: 'x' } as ThreadRecord['turns'][number]] })
    const resolved = resolveTurnPlanContext(thread, 'tn')
    expect(resolved.planMode).toBe(true)
    expect(resolved.guiPlan).toBeUndefined()
  })

  test('a normal agent turn is not a plan turn', () => {
    const thread = threadWith({ turns: [{ id: 'tn', prompt: 'x' } as ThreadRecord['turns'][number]] })
    expect(resolveTurnPlanContext(thread, 'tn')).toEqual({ planMode: false })
  })
})

describe('createAgentSdkRuntime delegated session binding', () => {
  test('restores a compatible Claude session and scopes OAuth state under Kun data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-claude-binding-'))
    try {
      let items = [{
        id: 'item_t1',
        turnId: 't1',
        threadId: 'th',
        kind: 'user_message',
        role: 'user',
        status: 'completed',
        text: 'first',
        createdAt: '2026-07-25T00:00:00.000Z'
      }]
      let thread = threadWith({
        id: 'th',
        providerId: 'claude-subscription',
        workspace: '/ws',
        turns: [{ id: 't1', prompt: 'first' } as ThreadRecord['turns'][number]]
      })
      const buildRuntime = (sessionCoordinator: DelegatedSessionCoordinator) =>
        createAgentSdkRuntime({
          registry: CapabilityRegistry.fromLocalTools([]),
          turns: { updateTurnMetadata: async () => undefined } as never,
          sessionStore: { loadItems: async () => items } as never,
          threadStore: { get: async () => thread } as never,
          events: {} as never,
          ids: { next: (prefix) => prefix },
          prefix: { systemPrompt: 'Kun system prompt' },
          providerConfigs: {
            'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-oauth-secret' }
          } as never,
          agentSdkProviderIds: new Set(['claude-subscription']),
          defaultApprovalPolicy: 'auto',
          sessionCoordinator
        })
      const firstCoordinator = new DelegatedSessionCoordinator(
        new FileDelegatedSessionBindingStore(root)
      )
      const firstRuntime = buildRuntime(firstCoordinator)
      const firstDeps = (firstRuntime as unknown as {
        deps: {
          loadTurnContext(threadId: string, turnId: string): Promise<{
            claudeConfigDir?: string
            sessionPreparation?: DelegatedSessionPreparation
          } | null>
        }
      }).deps
      const first = await firstDeps.loadTurnContext('th', 't1')
      expect(first?.claudeConfigDir).toContain('provider-state')
      await firstCoordinator.commit({
        preparation: first!.sessionPreparation!,
        committedItems: items as never,
        lastCommittedTurnId: 't1',
        nativeSessionId: 'session_persisted'
      })

      items = [...items, {
        id: 'item_t2',
        turnId: 't2',
        threadId: 'th',
        kind: 'user_message',
        role: 'user',
        status: 'completed',
        text: 'second',
        createdAt: '2026-07-25T00:01:00.000Z'
      }]
      thread = {
        ...thread,
        turns: [
          ...thread.turns,
          { id: 't2', prompt: 'second' } as ThreadRecord['turns'][number]
        ]
      }
      const restarted = buildRuntime(new DelegatedSessionCoordinator(
        new FileDelegatedSessionBindingStore(root)
      ))
      const restartedDeps = (restarted as unknown as {
        deps: {
          loadTurnContext(threadId: string, turnId: string): Promise<{
            resumeSessionId?: string
            historyTranscript?: string
          } | null>
        }
      }).deps
      const second = await restartedDeps.loadTurnContext('th', 't2')
      expect(second?.resumeSessionId).toBe('session_persisted')
      expect(second?.historyTranscript).toContain('first')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rotates Claude continuation when a bridged tool changes provider identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-claude-tool-provider-'))
    try {
      let items = [{
        id: 'item_t1',
        turnId: 't1',
        threadId: 'th',
        kind: 'user_message',
        role: 'user',
        status: 'completed',
        text: 'first',
        createdAt: '2026-07-25T00:00:00.000Z'
      }]
      let thread = threadWith({
        id: 'th',
        providerId: 'claude-subscription',
        turns: [{ id: 't1', prompt: 'first' } as ThreadRecord['turns'][number]]
      })
      const coordinator = new DelegatedSessionCoordinator(
        new FileDelegatedSessionBindingStore(root)
      )
      const buildRegistry = (providerId: string) => new CapabilityRegistry([{
        id: providerId,
        kind: 'mcp',
        enabled: true,
        available: true,
        tools: [LocalToolHost.defineTool({
          name: 'remote_lookup',
          description: 'Look up remote documentation',
          inputSchema: { type: 'object' },
          sideEffect: 'read-only',
          execute: async () => ({ output: 'ok' })
        })]
      }])
      const buildRuntime = (registry: CapabilityRegistry) => createAgentSdkRuntime({
        registry,
        toolHost: new LocalToolHost({ registry }),
        turns: { updateTurnMetadata: async () => undefined } as never,
        sessionStore: { loadItems: async () => items } as never,
        threadStore: { get: async () => thread } as never,
        events: {} as never,
        ids: { next: (prefix) => prefix },
        prefix: { systemPrompt: 'Kun system prompt' },
        providerConfigs: {
          'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-oauth-secret' }
        } as never,
        agentSdkProviderIds: new Set(['claude-subscription']),
        defaultApprovalPolicy: 'auto',
        sessionCoordinator: coordinator
      })
      const firstRuntime = buildRuntime(buildRegistry('mcp:first'))
      const firstDeps = (firstRuntime as unknown as {
        deps: {
          loadTurnContext(threadId: string, turnId: string): Promise<{
            sessionPreparation?: DelegatedSessionPreparation
          } | null>
        }
      }).deps
      const first = await firstDeps.loadTurnContext('th', 't1')
      await coordinator.commit({
        preparation: first!.sessionPreparation!,
        committedItems: items as never,
        lastCommittedTurnId: 't1',
        nativeSessionId: 'session_first_provider'
      })

      items = [...items, {
        id: 'item_t2',
        turnId: 't2',
        threadId: 'th',
        kind: 'user_message',
        role: 'user',
        status: 'completed',
        text: 'second',
        createdAt: '2026-07-25T00:01:00.000Z'
      }]
      thread = {
        ...thread,
        turns: [
          ...thread.turns,
          { id: 't2', prompt: 'second' } as ThreadRecord['turns'][number]
        ]
      }
      const secondRuntime = buildRuntime(buildRegistry('mcp:second'))
      const secondDeps = (secondRuntime as unknown as {
        deps: {
          loadTurnContext(threadId: string, turnId: string): Promise<{
            resumeSessionId?: string
            bridgeableTools: Array<{ providerId?: string }>
            sessionPreparation?: DelegatedSessionPreparation
          } | null>
        }
      }).deps
      const second = await secondDeps.loadTurnContext('th', 't2')

      expect(second?.resumeSessionId).toBeUndefined()
      expect(second?.sessionPreparation?.rebaseReason).toBe('capabilities_changed')
      expect(second?.bridgeableTools).toContainEqual(expect.objectContaining({
        name: 'remote_lookup',
        providerId: 'mcp:second',
        providerKind: 'mcp'
      }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// handlesProvider only reads providerConfigs / agentSdkProviderIds / defaultIsAgentSdk,
// so the heavy service deps can be stubbed for this routing test.
function make(opts: { agentSdk: string[]; http: string[]; defaultIsAgentSdk: boolean }): {
  handlesProvider(id: string | undefined): boolean
} {
  const providerConfigs: Record<string, { baseUrl?: string; apiKey: string; kind?: 'http' | 'agent-sdk' }> = {}
  for (const id of opts.agentSdk) {
    providerConfigs[id] = { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-tok' }
  }
  for (const id of opts.http) providerConfigs[id] = { baseUrl: 'https://x', apiKey: 'key' }
  return createAgentSdkRuntime({
    registry: {} as never,
    turns: {} as never,
    sessionStore: {} as never,
    threadStore: {} as never,
    events: {} as never,
    ids: { next: (p: string) => p },
    prefix: { systemPrompt: '' },
    providerConfigs: providerConfigs as never,
    agentSdkProviderIds: new Set(opts.agentSdk),
    defaultApprovalPolicy: 'auto',
    defaultIsAgentSdk: opts.defaultIsAgentSdk,
    defaultToken: 'sk-ant-oat01-tok'
  })
}

describe('createAgentSdkRuntime handlesProvider', () => {
  test('claims only explicit agent-sdk providers when default is not agent-sdk', () => {
    const r = make({ agentSdk: ['claude-subscription'], http: ['deepseek'], defaultIsAgentSdk: false })
    expect(r.handlesProvider('claude-subscription')).toBe(true)
    expect(r.handlesProvider('deepseek')).toBe(false)
    expect(r.handlesProvider(undefined)).toBe(false)
  })

  test('when the default provider is agent-sdk, also claims absent/default providerId', () => {
    const r = make({ agentSdk: ['claude-subscription'], http: ['deepseek'], defaultIsAgentSdk: true })
    expect(r.handlesProvider(undefined)).toBe(true) // default turn → SDK (the reported 401 case)
    expect(r.handlesProvider('claude-subscription')).toBe(true)
    expect(r.handlesProvider('deepseek')).toBe(false) // an explicit HTTP provider stays HTTP
  })

  test('forwards every native turn limit to delegated SDK turns', () => {
    const turnLimits = { maxSteps: 9, maxWallTimeMs: 12_345, maxToolCallsPerStep: 4 }
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {} as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      turnLimits
    })
    const deps = (runtime as unknown as {
      deps: { getTurnLimits?(): typeof turnLimits | undefined }
    }).deps

    expect(deps.getTurnLimits?.()).toEqual(turnLimits)
  })
})

describe('createAgentSdkRuntime turn context', () => {
  type CredentialContextOptions = {
    providerId?: string
    providerToken?: string
    defaultToken?: string
    credentialSourceId?: string
    resolveCredentialSource?: (sourceId: string) => Promise<{ apiKey: string } | null>
  }
  type CredentialContext = {
    oauthToken?: string
    actingModelRoute?: {
      model: string
      providerId?: string
      accountId?: string
    }
  } | null
  const credentialContextLoader = (options: CredentialContextOptions): (() => Promise<CredentialContext>) => {
    const runtime = createAgentSdkRuntime({
      registry: CapabilityRegistry.fromLocalTools([]),
      turns: { updateTurnMetadata: async () => undefined } as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'check credentials',
          createdAt: '2026-07-25T00:00:00.000Z'
        }]
      } as never,
      threadStore: {
        get: async () => threadWith({
          ...(options.providerId ? { providerId: options.providerId } : {}),
          turns: [{
            id: 'tn',
            prompt: 'check credentials',
            // Exercise first-resolution behavior rather than the test helper's
            // synthesized legacy route snapshot.
            actingModelRoute: undefined
          } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: 'Kun system prompt' },
      providerConfigs: options.providerId
        ? {
            [options.providerId]: {
              kind: 'agent-sdk',
              apiKey: options.providerToken ?? '',
              ...(options.credentialSourceId
                ? { credentialSourceId: options.credentialSourceId }
                : {})
            }
          } as never
        : {},
      agentSdkProviderIds: new Set(options.providerId ? [options.providerId] : []),
      defaultApprovalPolicy: 'auto',
      defaultIsAgentSdk: !options.providerId,
      defaultToken: options.defaultToken,
      ...(options.credentialSourceId && !options.providerId
        ? { defaultCredentialSourceId: options.credentialSourceId }
        : {}),
      ...(options.resolveCredentialSource
        ? { resolveCredentialSource: options.resolveCredentialSource }
        : {})
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(
          threadId: string,
          turnId: string
        ): Promise<{
          oauthToken?: string
          actingModelRoute?: {
            model: string
            providerId?: string
            accountId?: string
          }
        } | null>
      }
    }).deps
    return () => deps.loadTurnContext('th', 'tn')
  }
  const credentialContext = (options: CredentialContextOptions): Promise<CredentialContext> =>
    credentialContextLoader(options)()

  test('keeps an explicit Claude provider on ambient login instead of inheriting the default token', async () => {
    const context = await credentialContext({
      providerId: 'claude-subscription',
      providerToken: '',
      defaultToken: 'sk-ant-oat01-unrelated-provider'
    })
    expect(context?.oauthToken).toBeUndefined()
  })

  test('uses the default token only for the implicit default Agent SDK route', async () => {
    const context = await credentialContext({
      defaultToken: 'sk-ant-oat01-default-agent-sdk'
    })
    expect(context?.oauthToken).toBe('sk-ant-oat01-default-agent-sdk')
    expect(context?.actingModelRoute).toMatchObject({
      providerId: 'default'
    })
  })

  test('persists an active goal context before assembling delegated history', async () => {
    const createdAt = '2026-08-06T00:00:00.000Z'
    const goal = {
      threadId: 'th',
      objective: 'Finish the migration safely.',
      status: 'active' as const,
      tokenBudget: 10_000,
      tokensUsed: 250,
      timeUsedSeconds: 12,
      createdAt,
      updatedAt: createdAt
    }
    const sessionItems = [{
      id: 'item_user',
      turnId: 'tn',
      threadId: 'th',
      kind: 'user_message',
      role: 'user',
      status: 'completed',
      text: 'continue the migration',
      createdAt
    }]
    const loadItems = vi.fn(async () => sessionItems)
    const ensureGoalContext = vi.fn(async () => {
      sessionItems.push({
        id: 'item_tn_goal_context',
        turnId: 'tn',
        threadId: 'th',
        kind: 'goal_context',
        role: 'system',
        status: 'completed',
        goalKey: goalContextKey(goal)!,
        text: 'Finish the migration safely.',
        createdAt
      } as never)
    })
    const runtime = createAgentSdkRuntime({
      registry: CapabilityRegistry.fromLocalTools([]),
      turns: {
        updateTurnMetadata: async () => undefined,
        ensureGoalContext
      } as never,
      sessionStore: { loadItems } as never,
      threadStore: {
        get: async () => threadWith({
          goal
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: 'Kun system prompt' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      defaultIsAgentSdk: true
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{
          historyTranscript?: string
          contextInstructions?: string[]
          redactedRequestValues?: string[]
        } | null>
      }
    }).deps

    const context = await deps.loadTurnContext('th', 'tn')

    expect(ensureGoalContext).toHaveBeenCalledWith('th', 'tn', undefined)
    expect(loadItems).toHaveBeenCalledTimes(2)
    expect(context?.historyTranscript).toContain('[active goal] Finish the migration safely.')
    expect(context?.redactedRequestValues).toEqual(['Finish the migration safely.'])
    expect(context?.contextInstructions?.join('\n')).not.toContain(
      'Continue working toward the active thread goal.'
    )
  })

  test('re-resolves a managed Claude credential for every turn on the same Runtime', async () => {
    let authoritativeToken = ''
    const resolveCredentialSource = vi.fn(async (sourceId: string) =>
      authoritativeToken ? { apiKey: authoritativeToken } : null)
    const load = credentialContextLoader({
      providerId: 'claude-subscription',
      providerToken: 'sk-ant-oat01-stale-constructor-token',
      credentialSourceId: 'model-connection:claude-subscription',
      resolveCredentialSource
    })

    await expect(load()).rejects.toMatchObject({
      code: 'agent_sdk_credential_unavailable'
    })
    authoritativeToken = 'sk-ant-oat01-authoritative-token'
    await expect(load()).resolves.toMatchObject({
      oauthToken: 'sk-ant-oat01-authoritative-token'
    })
    expect(resolveCredentialSource).toHaveBeenNthCalledWith(
      1,
      'model-connection:claude-subscription'
    )
    expect(resolveCredentialSource).toHaveBeenNthCalledWith(
      2,
      'model-connection:claude-subscription'
    )
  })

  test('rejects an invalid explicit token without disclosing it', async () => {
    const raw = 'Bearer sk-ant-oat01-private-value'
    const loading = credentialContext({
      providerId: 'claude-subscription',
      providerToken: raw
    })
    await expect(loading).rejects.toThrow('Claude subscription token format is invalid')
    await loading.catch((error) => {
      expect(String(error)).not.toContain('sk-ant-oat01-private-value')
    })
  })

  test('prepares lazy extension tools and preserves MCP/extension provenance', async () => {
    const extensionExecute = vi.fn(async () => ({ output: 'extension result' }))
    const registry = new CapabilityRegistry([{
      id: 'mcp:docs',
      kind: 'mcp',
      enabled: true,
      available: true,
      tools: [LocalToolHost.defineTool({
        name: 'mcp_docs_lookup',
        description: 'Look up MCP docs',
        inputSchema: { type: 'object' },
        sideEffect: 'read-only',
        execute: async () => ({ output: 'mcp result' })
      })]
    }])
    let prepared = false
    const host = new LocalToolHost({
      registry,
      prepare: () => {
        if (prepared) return
        prepared = true
        registry.registerProvider({
          id: 'extension:demo',
          kind: 'extension',
          enabled: true,
          available: true,
          tools: [LocalToolHost.defineTool({
            name: 'extension_render',
            description: 'Render with an extension',
            inputSchema: { type: 'object' },
            sideEffect: 'read-only',
            execute: extensionExecute
          })]
        })
      }
    })
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: host,
      turns: { updateTurnMetadata: async () => undefined } as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'use the configured tools',
          createdAt: '2026-07-25T00:00:00.000Z'
        }]
      } as never,
      threadStore: {
        get: async () => threadWith({
          providerId: 'claude-subscription',
          turns: [{ id: 'tn', prompt: 'use the configured tools' } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: 'Kun system prompt' },
      providerConfigs: {
        'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-tok' }
      } as never,
      agentSdkProviderIds: new Set(['claude-subscription']),
      defaultApprovalPolicy: 'auto'
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{
          bridgeableTools: Array<{
            name: string
            providerId?: string
            providerKind?: string
          }>
          contextInstructions?: string[]
        } | null>
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    const context = await deps.loadTurnContext('th', 'tn')
    expect(context?.bridgeableTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'mcp_docs_lookup',
        providerId: 'mcp:docs',
        providerKind: 'mcp'
      }),
      expect.objectContaining({
        name: 'extension_render',
        providerId: 'extension:demo',
        providerKind: 'extension'
      })
    ]))
    expect(context?.contextInstructions?.join('\n')).toContain(
      'Kun-managed capabilities are available through the mcp__kun__ tools.'
    )
    await expect(deps.executeKunTool('th', 'tn', 'extension_render', {})).resolves.toEqual({
      output: 'extension result',
      isError: false
    })
    expect(extensionExecute).toHaveBeenCalledOnce()
  })

  test('uses the bounded Graph catalog and disables SDK built-ins across planning and supervision', async () => {
    const graphOnly = (context: { orchestration?: string }) =>
      context.orchestration === 'graph'
    const graphDefinePlan = vi.fn(async (args: Record<string, unknown>) => {
      if (Object.prototype.hasOwnProperty.call(args, '__raw')) {
        return {
          output: {
            code: 'graph_plan_invalid',
            retryable: true,
            receivedArguments: args
          },
          isError: true
        }
      }
      return { output: { status: 'committed', receivedArguments: args } }
    })
    const registry = CapabilityRegistry.fromLocalTools([
      LocalToolHost.defineTool({
        name: 'read',
        description: 'Read safely',
        inputSchema: { type: 'object' },
        sideEffect: 'read-only',
        execute: async () => ({ output: 'read' })
      }),
      LocalToolHost.defineTool({
        name: 'write',
        description: 'Write',
        inputSchema: { type: 'object' },
        sideEffect: 'unknown',
        execute: async () => ({ output: 'write' })
      }),
      LocalToolHost.defineTool({
        name: 'graph_define_plan',
        description: 'Define Graph plan',
        inputSchema: { type: 'object' },
        shouldAdvertise: graphOnly,
        execute: graphDefinePlan
      }),
      LocalToolHost.defineTool({
        name: 'graph_review_node',
        description: 'Review Graph node',
        inputSchema: { type: 'object' },
        shouldAdvertise: graphOnly,
        execute: async () => ({ output: { status: 'accepted' } })
      })
    ])
    const host = new LocalToolHost({ registry })
    const graphTurn = {
      id: 'tn',
      prompt: 'plan with Graph',
      orchestration: 'graph',
      graphPlanningLifecycle: {
        version: 1,
        draftId: 'draft_1',
        reservedRunId: 'run_1',
        state: 'planning',
        draftRevision: 1
      }
    } as ThreadRecord['turns'][number]
    const thread = threadWith({
      providerId: 'claude-subscription',
      turns: [graphTurn]
    })
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: host,
      turns: { updateTurnMetadata: async () => undefined } as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'plan with Graph',
          createdAt: '2026-07-30T00:00:00.000Z'
        }]
      } as never,
      threadStore: { get: async () => thread } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: 'Kun system prompt' },
      providerConfigs: {
        'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-token' }
      } as never,
      agentSdkProviderIds: new Set(['claude-subscription']),
      defaultApprovalPolicy: 'auto'
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{
          bridgeableTools: Array<{ name: string }>
          allowSdkBuiltins?: boolean
          bridgeKunBuiltinOverlaps?: boolean
          graphPhase?: 'planning' | 'supervising'
          contextInstructions?: string[]
        } | null>
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    const planning = await deps.loadTurnContext('th', 'tn')
    expect(planning).toMatchObject({
      allowSdkBuiltins: false,
      bridgeKunBuiltinOverlaps: true,
      graphPhase: 'planning'
    })
    expect(planning?.bridgeableTools.map((tool) => tool.name).sort()).toEqual([
      'graph_define_plan',
      'read'
    ])
    expect(planning?.contextInstructions?.join('\n')).toContain(
      'Graph Mode: source Lead operating contract'
    )
    await expect(deps.executeKunTool('th', 'tn', 'write', {})).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining('active tool policy')
    })

    const incompleteRaw = '{"plan":{"title":"truncated"'
    await expect(deps.executeKunTool(
      'th',
      'tn',
      'graph_define_plan',
      { __raw: incompleteRaw }
    )).resolves.toEqual({
      output: {
        code: 'graph_plan_invalid',
        retryable: true,
        receivedArguments: { __raw: incompleteRaw }
      },
      isError: true
    })
    expect(graphDefinePlan).toHaveBeenLastCalledWith(
      { __raw: incompleteRaw },
      expect.objectContaining({ threadId: 'th', turnId: 'tn' }),
      expect.any(Function)
    )

    const correctedArguments = {
      plan: {
        title: 'Bounded Graph plan',
        tasks: [{ id: 'task_1', objective: 'Apply the requested change' }]
      }
    }
    await expect(deps.executeKunTool(
      'th',
      'tn',
      'graph_define_plan',
      { __raw: JSON.stringify(correctedArguments) }
    )).resolves.toEqual({
      output: {
        status: 'committed',
        receivedArguments: correctedArguments
      },
      isError: false
    })
    expect(graphDefinePlan).toHaveBeenLastCalledWith(
      correctedArguments,
      expect.objectContaining({ threadId: 'th', turnId: 'tn' }),
      expect.any(Function)
    )

    thread.turns[0]!.graphPlanningLifecycle = {
      ...thread.turns[0]!.graphPlanningLifecycle!,
      state: 'committed',
      draftRevision: 2
    }
    const supervising = await deps.loadTurnContext('th', 'tn')
    expect(supervising?.graphPhase).toBe('supervising')
    expect(supervising?.bridgeableTools.map((tool) => tool.name).sort()).toEqual([
      'graph_review_node',
      'read'
    ])
  })

  test('applies a child capability boundary to SDK discovery and execution', async () => {
    const executionContexts: Array<{
      allowedToolNames?: readonly string[]
      allowedProviderIds?: readonly string[]
      blockedToolNames?: readonly string[]
      blockedProviderIds?: readonly string[]
      blockedSkillIds?: readonly string[]
    }> = []
    const readTool = LocalToolHost.defineTool({
      name: 'read',
      description: 'Read safely',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async (_args, context) => {
        executionContexts.push(context)
        return { output: 'safe' }
      }
    })
    const writeTool = LocalToolHost.defineTool({
      name: 'write',
      description: 'Write a file',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => ({ output: 'mutated' })
    })
    const registry = CapabilityRegistry.fromLocalTools([readTool, writeTool])
    const host = new LocalToolHost({ registry })
    const skillRuntime = {
      resolveTurn: vi.fn(async () => ({
        activeSkillIds: [],
        activations: [],
        instructions: [],
        injectedBytes: 0
      })),
      availableSkillIdsForWorkspace: vi.fn(async () => ['safe-skill', 'blocked-skill'])
    }
    const sdkTurn = {
      id: 'tn',
      prompt: 'inspect',
      clientSurface: 'tui'
    } as ThreadRecord['turns'][number]
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: host,
      turns: { updateTurnMetadata: async () => undefined } as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'inspect',
          createdAt: '2026-07-10T00:00:00.000Z'
        }]
      } as never,
      threadStore: {
        get: async () => threadWith({
          id: 'th',
          providerId: 'claude-subscription',
          turns: [sdkTurn]
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {
        'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-tok' }
      } as never,
      agentSdkProviderIds: new Set(['claude-subscription']),
      defaultApprovalPolicy: 'auto',
      allowSdkBuiltins: false,
      skillRuntime: skillRuntime as never,
      toolContextBoundary: {
        allowedProviderIds: ['builtin'],
        allowedToolNames: ['read'],
        blockedProviderIds: ['mcp:private'],
        blockedToolNames: ['write'],
        blockedSkillIds: ['blocked-skill']
      }
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{
          bridgeableTools: Array<{ name: string }>
          allowSdkBuiltins?: boolean
          contextInstructions?: string[]
        } | null>
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    const context = await deps.loadTurnContext('th', 'tn')
    expect(context).toMatchObject({
      allowSdkBuiltins: false,
      bridgeableTools: [{ name: 'read' }]
    })
    expect(context?.contextInstructions?.join('\n')).toContain('Kun terminal TUI')
    await expect(deps.executeKunTool('th', 'tn', 'read', {})).resolves.toEqual({
      output: 'safe',
      isError: false
    })
    await expect(deps.executeKunTool('th', 'tn', 'write', {})).resolves.toMatchObject({
      isError: true
    })
    expect(executionContexts).toEqual([
      expect.objectContaining({
        allowedProviderIds: ['builtin'],
        allowedToolNames: ['read'],
        blockedProviderIds: ['mcp:private'],
        blockedToolNames: ['write'],
        blockedSkillIds: ['blocked-skill'],
        clientSurface: 'tui'
      })
    ])
    expect(skillRuntime.resolveTurn).toHaveBeenCalledWith(expect.objectContaining({
      blockedSkillIds: ['blocked-skill']
    }))
  })

  test('scopes dedicated SVG turns to structured tools and the artifact-specific policy', async () => {
    type DesignContext = {
      guiDesignCanvas?: boolean
      guiDesignArtifact?: { kind: 'svg'; artifactId: string; relativePath: string }
      allowedToolNames?: readonly string[]
    }
    const listedContexts: DesignContext[] = []
    const executedContexts: DesignContext[] = []
    const designTurn = {
      id: 'tn',
      prompt: '制作轨道动画',
      mode: 'plan',
      guiDesignMode: true,
      guiDesignArtifact: {
        kind: 'svg',
        artifactId: 'motion',
        relativePath: '.kun-design/doc/motion/v1.svg'
      }
    } as ThreadRecord['turns'][number]
    const runtime = createAgentSdkRuntime({
      registry: {
        listTools: (context: DesignContext) => {
          listedContexts.push(context)
          return [
            { name: 'write', description: 'Raw write', inputSchema: {} },
            { name: 'design_svg_edit', description: 'Edit SVG', inputSchema: {} },
            { name: 'design_svg_validate', description: 'Validate SVG', inputSchema: {} }
          ].filter((tool) => !context.allowedToolNames || context.allowedToolNames.includes(tool.name))
        },
        resolveTool: (_name: string, context: DesignContext) => ({
          tool: {
            execute: async () => {
              executedContexts.push(context)
              return { output: { ok: true } }
            }
          }
        })
      } as never,
      toolHost: {
        id: 'test-host',
        listTools: async () => [],
        execute: async (_call: unknown, context: DesignContext) => {
          executedContexts.push(context)
          return { item: { kind: 'tool_result', output: { ok: true } }, approved: true }
        }
      } as never,
      turns: { updateTurnMetadata: async () => undefined } as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: '制作轨道动画',
          createdAt: '2026-07-10T00:00:00.000Z'
        }]
      } as never,
      threadStore: {
        get: async () => threadWith({
          id: 'th',
          providerId: 'claude-subscription',
          turns: [designTurn]
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {
        'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-tok' }
      } as never,
      agentSdkProviderIds: new Set(['claude-subscription']),
      defaultApprovalPolicy: 'auto'
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{
          contextInstructions?: string[]
          bridgeableTools: Array<{ name: string }>
          allowSdkBuiltins?: boolean
          requireSvgCompletion?: boolean
          planMode?: boolean
        } | null>
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<unknown>
      }
    }).deps

    const context = await deps.loadTurnContext('th', 'tn')
    await deps.executeKunTool('th', 'tn', 'design_svg_edit', { ops: [] })

    expect(listedContexts).toEqual([expect.objectContaining({
      guiDesignArtifact: { kind: 'svg', artifactId: 'motion', relativePath: '.kun-design/doc/motion/v1.svg' },
      allowedToolNames: expect.arrayContaining(['design_svg_edit', 'design_svg_validate'])
    })])
    expect(executedContexts).toEqual([expect.objectContaining({
      guiDesignArtifact: { kind: 'svg', artifactId: 'motion', relativePath: '.kun-design/doc/motion/v1.svg' },
      allowedToolNames: expect.arrayContaining(['design_svg_edit', 'design_svg_validate'])
    })])
    expect(context?.bridgeableTools.map((tool) => tool.name)).toEqual(['design_svg_edit', 'design_svg_validate'])
    expect(context).toMatchObject({
      allowSdkBuiltins: false,
      requireSvgCompletion: true,
      planMode: false
    })
    expect(context?.contextInstructions?.join('\n')).toContain('already-reserved file')
    expect(context?.contextInstructions?.join('\n')).not.toContain('SINGLE SCREEN')
  })

  test('bridges skill-gated PPT tools with the same active skill ids at execution time', async () => {
    const executed: string[] = []
    const pptTool = LocalToolHost.defineTool({
      name: 'ppt_master_run',
      description: 'Managed PPT Master step',
      inputSchema: { type: 'object', properties: {} },
      toolKind: 'file_change',
      policy: 'auto',
      shouldAdvertise: (context) => context.activeSkillIds?.includes('ppt-master') === true,
      execute: async () => {
        executed.push('ppt_master_run')
        return { output: { ok: true } }
      }
    })
    const registry = CapabilityRegistry.fromLocalTools([pptTool])
    const host = new LocalToolHost({ registry })
    const skillRuntime = {
      resolveTurn: vi.fn(async () => ({
        activeSkillIds: ['ppt-master'],
        activations: [],
        instructions: [],
        injectedBytes: 0
      }))
    }
    const sdkTurn = { id: 'tn', prompt: '$ppt-master' } as ThreadRecord['turns'][number]
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: host,
      turns: {} as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: '$ppt-master',
          createdAt: '2026-07-10T00:00:00.000Z'
        }]
      } as never,
      threadStore: { get: async () => threadWith({ id: 'th', turns: [sdkTurn] }) } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      skillRuntime: skillRuntime as never
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{ bridgeableTools: Array<{ name: string }> } | null>
        executeKunTool(threadId: string, turnId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
      }
    }).deps

    const turnContext = await deps.loadTurnContext('th', 'tn')
    expect(turnContext?.bridgeableTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ppt_master_run' })
    ]))
    await expect(deps.executeKunTool('th', 'tn', 'ppt_master_run', {})).resolves.toEqual({
      output: { ok: true },
      isError: false
    })
    expect(executed).toEqual(['ppt_master_run'])
    expect(skillRuntime.resolveTurn).toHaveBeenCalledTimes(2)
    expect(skillRuntime.resolveTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'th',
      turnId: 'tn'
    }))
  })

  test('pre-bridges visible skill tools but requires load_skill activation before SDK execution', async () => {
    let manuallyActive = false
    const loadSkill = LocalToolHost.defineTool({
      name: 'load_skill',
      description: 'Load a skill',
      inputSchema: { type: 'object', properties: { skill_id: { type: 'string' } } },
      policy: 'auto',
      execute: async () => {
        manuallyActive = true
        return { output: { skillId: 'ppt-master' } }
      }
    })
    const pptTool = LocalToolHost.defineTool({
      name: 'ppt_master_run',
      description: 'Managed PPT Master step',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      shouldAdvertise: (context) => context.activeSkillIds?.includes('ppt-master') === true,
      execute: async () => ({ output: { ran: true } })
    })
    const registry = CapabilityRegistry.fromLocalTools([loadSkill, pptTool])
    const host = new LocalToolHost({ registry })
    const skillRuntime = {
      resolveTurn: vi.fn(async () => ({
        activeSkillIds: manuallyActive ? ['ppt-master'] : [],
        activations: [],
        instructions: [],
        injectedBytes: 0
      })),
      availableSkillIdsForWorkspace: vi.fn(async () => ['ppt-master']),
      clearTurnActivation: vi.fn()
    }
    const sdkTurn = { id: 'tn', prompt: 'continue' } as ThreadRecord['turns'][number]
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: host,
      turns: {} as never,
      sessionStore: {
        loadItems: async () => [{
          id: 'item_user',
          turnId: 'tn',
          threadId: 'th',
          kind: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'continue',
          createdAt: '2026-07-10T00:00:00.000Z'
        }]
      } as never,
      threadStore: { get: async () => threadWith({ id: 'th', turns: [sdkTurn] }) } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      skillRuntime: skillRuntime as never
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<{ bridgeableTools: Array<{ name: string }> } | null>
        executeKunTool(threadId: string, turnId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
        decideToolApproval(threadId: string, turnId: string, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }>
      }
    }).deps

    const context = await deps.loadTurnContext('th', 'tn')
    expect(context?.bridgeableTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'load_skill' }),
      expect.objectContaining({ name: 'ppt_master_run' })
    ]))

    await expect(deps.executeKunTool('th', 'tn', 'ppt_master_run', {})).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining('not advertised')
    })
    await expect(deps.executeKunTool('th', 'tn', 'load_skill', { skill_id: 'ppt-master' })).resolves.toMatchObject({
      isError: false
    })
    await expect(deps.executeKunTool('th', 'tn', 'ppt_master_run', {})).resolves.toEqual({
      output: { ran: true },
      isError: false
    })
    await expect(deps.decideToolApproval('th', 'tn', 'Bash', { command: 'python3 script.py' })).resolves.toMatchObject({
      allow: false,
      message: expect.stringContaining('ppt_master_run')
    })
  })

  test('clears turn-scoped skill activation when an SDK turn finishes', async () => {
    const clearTurnActivation = vi.fn()
    const finishTurn = vi.fn(async () => undefined)
    const suspendGraphLeadTurn = vi.fn(async () => 'not_graph' as const)
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: { finishTurn, suspendGraphLeadTurn } as never,
      sessionStore: {} as never,
      threadStore: {} as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      skillRuntime: { clearTurnActivation } as never
    })
    const deps = (runtime as unknown as {
      deps: {
        finishTurn(
          threadId: string,
          turnId: string,
          status: 'completed' | 'failed' | 'aborted',
          error?: string
        ): Promise<void>
      }
    }).deps

    await deps.finishTurn('thread_1', 'turn_1', 'completed')

    expect(suspendGraphLeadTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(finishTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      status: 'completed'
    })
    expect(clearTurnActivation).toHaveBeenCalledWith('thread_1', 'turn_1')
  })

  test('parks a completed SDK response when the same Graph Lead turn is still supervising', async () => {
    const clearTurnActivation = vi.fn()
    const finishTurn = vi.fn(async () => undefined)
    const suspendGraphLeadTurn = vi.fn(async () => 'suspended' as const)
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: { finishTurn, suspendGraphLeadTurn } as never,
      sessionStore: {} as never,
      threadStore: {} as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      skillRuntime: { clearTurnActivation } as never
    })
    const runtimeDeps = (runtime as unknown as {
      deps: {
        finishTurn(
          threadId: string,
          turnId: string,
          status: 'completed' | 'failed' | 'aborted',
          error?: string
        ): Promise<TurnRunOutcome>
      }
    }).deps

    await expect(runtimeDeps.finishTurn(
      'thread_1',
      'turn_1',
      'completed'
    )).resolves.toBe('suspended')

    expect(finishTurn).not.toHaveBeenCalled()
    expect(clearTurnActivation).toHaveBeenCalledWith('thread_1', 'turn_1')
  })

  test('parks prose-only SDK completion while a Graph node still awaits Lead review', async () => {
    const finishTurn = vi.fn(async () => undefined)
    const suspendGraphLeadTurn = vi.fn()
      .mockResolvedValueOnce('supervision_pending')
      .mockResolvedValueOnce('suspended_pending_supervision')
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: { finishTurn, suspendGraphLeadTurn } as never,
      sessionStore: {} as never,
      threadStore: {} as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto'
    })
    const runtimeDeps = (runtime as unknown as {
      deps: {
        finishTurn(
          threadId: string,
          turnId: string,
          status: 'completed' | 'failed' | 'aborted',
          error?: string
        ): Promise<TurnRunOutcome>
      }
    }).deps

    await expect(runtimeDeps.finishTurn(
      'thread_1',
      'turn_1',
      'completed'
    )).resolves.toBe('suspended_pending_supervision')

    expect(suspendGraphLeadTurn).toHaveBeenNthCalledWith(1, {
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(suspendGraphLeadTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread_1',
      turnId: 'turn_1',
      force: true,
      preserveDeliveryCursor: true,
      allowPendingSupervision: true
    })
    expect(finishTurn).not.toHaveBeenCalled()
  })

  test('does not fall back to the process workspace when a thread or turn has disappeared', async () => {
    const runtime = createAgentSdkRuntime({
      registry: {
        resolveTool: () => {
          throw new Error('a stale turn must not resolve a tool')
        }
      } as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => null } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto'
    })
    const deps = (runtime as unknown as {
      deps: {
        loadTurnContext(threadId: string, turnId: string): Promise<unknown>
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>,
          signal?: AbortSignal
        ): Promise<{ output: unknown; isError: boolean }>
      }
    }).deps

    await expect(deps.loadTurnContext('deleted-thread', 'deleted-turn')).resolves.toBeNull()
    await expect(deps.executeKunTool(
      'deleted-thread',
      'deleted-turn',
      'bash',
      {},
      new AbortController().signal
    )).resolves.toEqual({
      output: 'turn is no longer active; tool execution was cancelled',
      isError: true
    })
  })

  test('runs bridged Kun tools through the canonical host policy boundary', async () => {
    const executed: string[] = []
    const tools = [
      LocalToolHost.defineTool({
        name: 'approval_required',
        description: 'Requires approval',
        inputSchema: { type: 'object', properties: {} },
        policy: 'on-request',
        toolKind: 'command_execution',
        execute: async () => {
          executed.push('approval_required')
          return { output: 'should not execute' }
        }
      }),
      LocalToolHost.defineTool({
        name: 'disabled_tool',
        description: 'Disabled',
        inputSchema: { type: 'object', properties: {} },
        policy: 'never',
        execute: async () => {
          executed.push('disabled_tool')
          return { output: 'should not execute' }
        }
      })
    ]
    const registry = CapabilityRegistry.fromLocalTools(tools)
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: new LocalToolHost({ registry }),
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {
        get: async () => threadWith({
          workspace: '/ws',
          approvalPolicy: 'on-request',
          turns: [{ id: 'tn', prompt: 'run tool' } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: {} as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'on-request'
    })
    const deps = (runtime as unknown as {
      deps: {
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    await expect(deps.executeKunTool('th', 'tn', 'approval_required', {})).resolves.toMatchObject({
      isError: true,
      output: expect.objectContaining({ code: 'approval_denied' })
    })
    await expect(deps.executeKunTool('th', 'tn', 'disabled_tool', {})).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining('disabled by policy')
    })
    expect(executed).toEqual([])
  })

  test('gives concurrent bridged calls distinct approval identities', async () => {
    const approvalGate = new InMemoryApprovalGate()
    const executed: string[] = []
    const registry = CapabilityRegistry.fromLocalTools([
      LocalToolHost.defineTool({
        name: 'approval_required',
        description: 'Requires approval',
        inputSchema: { type: 'object', properties: {} },
        policy: 'on-request',
        toolKind: 'command_execution',
        execute: async () => {
          executed.push('approval_required')
          return { output: 'executed' }
        }
      })
    ])
    let nextId = 0
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: new LocalToolHost({ registry }),
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {
        get: async () => threadWith({
          workspace: '/ws',
          approvalPolicy: 'on-request',
          turns: [{ id: 'tn', prompt: 'run tool' } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: { record: async () => undefined } as never,
      ids: { next: (prefix) => `${prefix}_${++nextId}` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'on-request',
      approvalGate
    })
    const deps = (runtime as unknown as {
      deps: {
        executeKunTool(
          threadId: string,
          turnId: string,
          toolName: string,
          args: Record<string, unknown>
        ): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    const first = deps.executeKunTool('th', 'tn', 'approval_required', {})
    const second = deps.executeKunTool('th', 'tn', 'approval_required', {})

    await vi.waitFor(() => {
      expect(approvalGate.pending('th')).toHaveLength(2)
    })
    const approvals = approvalGate.pending('th')
    expect(new Set(approvals.map((approval) => approval.id)).size).toBe(2)
    for (const approval of approvals) approvalGate.decide(approval.id, 'allow')

    await expect(Promise.all([first, second])).resolves.toEqual([
      { output: 'executed', isError: false },
      { output: 'executed', isError: false }
    ])
    expect(executed).toEqual(['approval_required', 'approval_required'])
  })

  test('uses the thread approval policy to gate SDK built-in tools', async () => {
    const events: Array<{ kind: string; approvalPolicy?: string }> = []
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => threadWith({ approvalPolicy: 'always' }) } as never,
      events: { record: async (event: { kind: string; approvalPolicy?: string }) => { events.push(event) } } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      approvalGate: {
        request: async () => 'allow', decide: () => false, pending: () => [], get: () => undefined
      } as never
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(threadId: string, turnId: string, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean }>
      }
    }).deps

    await expect(deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' })).resolves.toEqual({ allow: true })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'approval_requested', approvalPolicy: 'always' }))
  })

  test.each([
    { decision: 'allow' as const, reviewStatus: 'approved' as const, allow: true },
    { decision: 'deny' as const, reviewStatus: 'denied' as const, allow: false }
  ])('routes native SDK commands through agent review ($decision)', async ({
    decision,
    reviewStatus,
    allow
  }) => {
    const approvalGate = new InMemoryApprovalGate()
    const gateRequest = vi.spyOn(approvalGate, 'request')
    const review = vi.fn(async () => ({
      decision,
      reviewer: 'agent' as const,
      reviewId: 'review_sdk',
      reviewStatus,
      riskLevel: decision === 'allow' ? 'low' as const : 'high' as const,
      reason: decision === 'allow'
        ? 'Command matches the initiating intent.'
        : 'Command is broader than the initiating intent.'
    }))
    const record = vi.fn(async () => undefined)
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {
        get: async () => threadWith({
          approvalPolicy: 'on-request',
          sandboxMode: 'workspace-write',
          approvalReviewer: 'agent',
          providerId: 'selected-provider',
          accountId: 'selected-account',
          turns: [{
            id: 'tn',
            prompt: 'Run the tests',
            model: 'selected-model',
            providerId: 'selected-provider',
            accountId: 'selected-account',
            approvalReviewer: 'agent',
            actingModelRoute: {
              model: 'selected-model',
              providerId: 'selected-provider',
              accountId: 'selected-account'
            }
          } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: { record } as never,
      ids: { next: (prefix) => `${prefix}_sdk` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'on-request',
      defaultSandboxMode: 'workspace-write',
      defaultApprovalReviewer: 'agent',
      approvalGate,
      approvalReview: { review }
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(
          threadId: string,
          turnId: string,
          toolName: string,
          input: Record<string, unknown>
        ): Promise<{ allow: boolean; message?: string }>
      }
    }).deps

    await expect(deps.decideToolApproval(
      'th',
      'tn',
      'Bash',
      { command: 'npm test', apiKey: 'sk-sdk-secret-abcdefghijklmnop' }
    )).resolves.toMatchObject({
      allow,
      ...(allow
        ? {}
        : { message: 'Command is broader than the initiating intent.' })
    })
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        model: 'selected-model',
        providerId: 'selected-provider',
        accountId: 'selected-account'
      },
      intent: 'Run the tests',
      approval: expect.objectContaining({
        toolName: 'Bash',
        action: expect.objectContaining({
          kind: 'command',
          arguments: expect.objectContaining({
            command: 'npm test',
            apiKey: '[redacted]'
          })
        })
      })
    }))
    expect(JSON.stringify(review.mock.calls)).not.toContain('sk-sdk-secret')
    expect(gateRequest).not.toHaveBeenCalled()
    expect(approvalGate.pending()).toEqual([])
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval_requested'
    }))
  })

  test.each(['Read', 'Glob', 'Grep', 'TodoWrite'])(
    'does not review SDK-native safe tool %s under on-request policy',
    async (toolName) => {
      const approvalGate = new InMemoryApprovalGate()
      const gateRequest = vi.spyOn(approvalGate, 'request')
      const review = vi.fn()
      const record = vi.fn()
      const runtime = createAgentSdkRuntime({
        registry: {} as never,
        turns: {} as never,
        sessionStore: {} as never,
        threadStore: {
          get: async () => threadWith({
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
            approvalReviewer: 'agent',
            turns: [{
              id: 'tn',
              prompt: 'Inspect the workspace',
              model: 'selected-model',
              approvalPolicy: 'on-request',
              sandboxMode: 'workspace-write',
              approvalReviewer: 'agent',
              actingModelRoute: {
                model: 'selected-model',
                providerId: 'selected-provider',
                accountId: 'selected-account'
              }
            } as ThreadRecord['turns'][number]]
          })
        } as never,
        events: { record } as never,
        ids: { next: (prefix) => `${prefix}_safe` },
        prefix: { systemPrompt: '' },
        providerConfigs: {},
        agentSdkProviderIds: new Set(),
        defaultApprovalPolicy: 'on-request',
        defaultSandboxMode: 'workspace-write',
        defaultApprovalReviewer: 'agent',
        approvalGate,
        approvalReview: { review } as never
      })
      const deps = (runtime as unknown as {
        deps: {
          decideToolApproval(
            threadId: string,
            turnId: string,
            toolName: string,
            input: Record<string, unknown>
          ): Promise<{ allow: boolean; message?: string }>
        }
      }).deps

      await expect(deps.decideToolApproval(
        'th',
        'tn',
        toolName,
        toolName === 'Glob' ? { pattern: '**/*.ts' } : { file_path: '/tmp/file.ts' }
      )).resolves.toEqual({ allow: true })
      expect(review).not.toHaveBeenCalled()
      expect(gateRequest).not.toHaveBeenCalled()
      expect(record).not.toHaveBeenCalled()
    }
  )

  test('lets native SDK tools run in Full access without any Kun approval lifecycle', async () => {
    const approvalGate = new InMemoryApprovalGate()
    const gateRequest = vi.spyOn(approvalGate, 'request')
    const review = vi.fn()
    const record = vi.fn()
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {
        get: async () => threadWith({
          approvalPolicy: 'auto',
          sandboxMode: 'danger-full-access',
          approvalReviewer: 'agent'
        })
      } as never,
      events: { record } as never,
      ids: { next: (prefix) => `${prefix}_full` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      defaultSandboxMode: 'danger-full-access',
      defaultApprovalReviewer: 'agent',
      approvalGate,
      approvalReview: { review } as never
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(
          threadId: string,
          turnId: string,
          toolName: string,
          input: Record<string, unknown>
        ): Promise<{ allow: boolean }>
      }
    }).deps

    await expect(deps.decideToolApproval(
      'th',
      'tn',
      'Bash',
      { command: 'pwd' }
    )).resolves.toEqual({ allow: true })
    expect(review).not.toHaveBeenCalled()
    expect(gateRequest).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  test('requires approval for SDK Bash under auto workspace-write policy', async () => {
    const events: Array<{ kind: string; approvalPolicy?: string; sandboxMode?: string }> = []
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: {
        get: async () => threadWith({
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write'
        })
      } as never,
      events: {
        record: async (event: { kind: string; approvalPolicy?: string; sandboxMode?: string }) => {
          events.push(event)
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_workspace` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      approvalGate: {
        request: async () => 'allow', decide: () => false, pending: () => [], get: () => undefined
      } as never
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(
          threadId: string,
          turnId: string,
          toolName: string,
          input: Record<string, unknown>
        ): Promise<{ allow: boolean }>
      }
    }).deps

    await expect(
      deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' })
    ).resolves.toEqual({ allow: true })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'approval_requested',
      approvalPolicy: 'auto',
      sandboxMode: 'workspace-write'
    }))
  })

  test('arms SDK approvals before publishing approval_requested', async () => {
    const approvalGate = new InMemoryApprovalGate()
    let immediatelyAllowed = false
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => threadWith({ approvalPolicy: 'always' }) } as never,
      events: {
        record: async (event: { kind: string; approvalId?: string }) => {
          if (event.kind === 'approval_requested' && event.approvalId) {
            immediatelyAllowed = approvalGate.decide(event.approvalId, 'allow')
          }
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      approvalGate
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(threadId: string, turnId: string, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean }>
      }
    }).deps

    await expect(deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' })).resolves.toEqual({ allow: true })
    expect(immediatelyAllowed).toBe(true)
  })

  test('aborts while approval_requested persistence is blocked and records one expired resolution', async () => {
    type ApprovalEvent = { kind: string; approvalId?: string; status?: string; reason?: string }
    const approvalGate = new InMemoryApprovalGate()
    const calls: ApprovalEvent[] = []
    const persisted: ApprovalEvent[] = []
    let releaseRequested!: () => void
    const requestedBarrier = new Promise<void>((resolve) => {
      releaseRequested = resolve
    })
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => threadWith({ approvalPolicy: 'always' }) } as never,
      events: {
        record: async (event: ApprovalEvent) => {
          calls.push(event)
          if (event.kind === 'approval_requested') await requestedBarrier
          persisted.push(event)
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      approvalGate
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(
          threadId: string,
          turnId: string,
          toolName: string,
          input: Record<string, unknown>,
          signal?: AbortSignal
        ): Promise<{ allow: boolean }>
      }
    }).deps
    const controller = new AbortController()

    const waiting = deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' }, controller.signal)
    await vi.waitFor(() => {
      expect(calls).toContainEqual(expect.objectContaining({ kind: 'approval_requested' }))
      expect(approvalGate.pending('th')).toHaveLength(1)
    })
    const approval = approvalGate.pending('th')[0]
    if (!approval) throw new Error('expected a pending SDK approval')

    controller.abort()

    await expect(waiting).resolves.toMatchObject({ allow: false })
    expect(approvalGate.get(approval.id)).toMatchObject({
      status: 'expired',
      reason: 'turn aborted while awaiting approval'
    })
    expect(persisted).toEqual([])

    releaseRequested()
    await vi.waitFor(() => {
      expect(persisted.map((event) => event.kind)).toEqual([
        'approval_requested',
        'approval_resolved'
      ])
    })
    expect(persisted.filter((event) => event.kind === 'approval_resolved')).toEqual([
      expect.objectContaining({
        approvalId: approval.id,
        status: 'expired',
        reason: 'turn aborted while awaiting approval'
      })
    ])
  })

  test('consumes a delayed approval_requested failure after abort without publishing an orphan resolution', async () => {
    type ApprovalEvent = { kind: string; approvalId?: string; status?: string }
    const approvalGate = new InMemoryApprovalGate()
    const calls: ApprovalEvent[] = []
    let rejectRequested!: (error: Error) => void
    const requestedFailure = new Promise<never>((_resolve, reject) => {
      rejectRequested = reject
    })
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => threadWith({ approvalPolicy: 'always' }) } as never,
      events: {
        record: async (event: ApprovalEvent) => {
          calls.push(event)
          if (event.kind === 'approval_requested') await requestedFailure
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      approvalGate
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(
          threadId: string,
          turnId: string,
          toolName: string,
          input: Record<string, unknown>,
          signal?: AbortSignal
        ): Promise<{ allow: boolean }>
      }
    }).deps
    const controller = new AbortController()

    const waiting = deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' }, controller.signal)
    await vi.waitFor(() => {
      expect(calls).toContainEqual(expect.objectContaining({ kind: 'approval_requested' }))
    })
    controller.abort()
    await expect(waiting).resolves.toMatchObject({ allow: false })

    rejectRequested(new Error('approval request persistence failed'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(calls.filter((event) => event.kind === 'approval_resolved')).toEqual([])
  })

  test('denies SDK built-in tools under a thread never policy', async () => {
    const runtime = createAgentSdkRuntime({
      registry: {} as never,
      turns: {} as never,
      sessionStore: {} as never,
      threadStore: { get: async () => threadWith({ approvalPolicy: 'never' }) } as never,
      events: {} as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto'
    })
    const deps = (runtime as unknown as {
      deps: {
        decideToolApproval(threadId: string, turnId: string, toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string }>
      }
    }).deps

    await expect(deps.decideToolApproval('th', 'tn', 'Bash', { command: 'pwd' })).resolves.toMatchObject({
      allow: false, message: expect.stringContaining('never')
    })
  })

  test('does not duplicate an HTTP-recorded user input resolution event', async () => {
    const events: Array<{ kind: string; inputId?: string }> = []
    const runtime = createAgentSdkRuntime({
      registry: {
        resolveTool: () => ({
          tool: {
            execute: async (_args: unknown, context: { awaitUserInput?: (input: {
              id: string; itemId: string; prompt: string; questions: []
            }) => Promise<unknown> }) => {
              await context.awaitUserInput?.({ id: 'in_sdk', itemId: 'item_sdk', prompt: 'Pick', questions: [] })
              return { output: {} }
            }
          }
        })
      } as never,
      toolHost: {
        id: 'test-host',
        listTools: async () => [],
        execute: async (_call: unknown, context: { awaitUserInput?: (input: {
          id: string; itemId: string; prompt: string; questions: []
        }) => Promise<unknown> }) => {
          await context.awaitUserInput?.({ id: 'in_sdk', itemId: 'item_sdk', prompt: 'Pick', questions: [] })
          return { item: { kind: 'tool_result', output: {} }, approved: true }
        }
      } as never,
      turns: { applyItem: async () => undefined, updateItem: async () => undefined } as never,
      sessionStore: {
        loadEventsSince: async () => [{ kind: 'user_input_resolved', inputId: 'in_sdk' }]
      } as never,
      threadStore: {
        get: async () => threadWith({
          workspace: '/ws',
          turns: [{ id: 'tn', prompt: 'ask' } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: { record: async (event: { kind: string; inputId?: string }) => { events.push(event) } } as never,
      ids: { next: (prefix) => prefix },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      userInputGate: {
        request: async () => ({ status: 'submitted', answers: [] }),
        resolve: () => true,
        get: () => undefined,
        pending: () => []
      } as never
    })
    const deps = (runtime as unknown as {
      deps: { executeKunTool(threadId: string, turnId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> }
    }).deps

    await deps.executeKunTool('th', 'tn', 'user_input', {})

    expect(events.filter((event) => event.kind === 'user_input_requested')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'user_input_resolved')).toHaveLength(0)
  })

  test('arms SDK user input before publishing user_input_requested', async () => {
    const userInputGate = new InMemoryUserInputGate()
    const interactiveTool = LocalToolHost.defineTool({
      name: 'user_input',
      description: 'Ask the user a question',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async (_args, context) => {
        const resolution = await context.awaitUserInput?.({
          id: 'in_sdk_immediate',
          itemId: 'item_sdk_immediate',
          prompt: 'Continue?',
          questions: []
        })
        return { output: resolution ?? { status: 'cancelled' }, isError: resolution?.status === 'cancelled' }
      }
    })
    const registry = CapabilityRegistry.fromLocalTools([interactiveTool])
    let immediatelyResolved = false
    const runtime = createAgentSdkRuntime({
      registry,
      toolHost: new LocalToolHost({ registry }),
      turns: { applyItem: async () => undefined, updateItem: async () => undefined } as never,
      sessionStore: { loadEventsSince: async () => [] } as never,
      threadStore: {
        get: async () => threadWith({
          workspace: '/ws',
          turns: [{ id: 'tn', prompt: 'ask' } as ThreadRecord['turns'][number]]
        })
      } as never,
      events: {
        record: async (event: { kind: string; inputId?: string }) => {
          if (event.kind === 'user_input_requested' && event.inputId) {
            immediatelyResolved = userInputGate.resolve(event.inputId, {
              status: 'submitted',
              answers: []
            })
          }
        }
      } as never,
      ids: { next: (prefix) => `${prefix}_1` },
      prefix: { systemPrompt: '' },
      providerConfigs: {},
      agentSdkProviderIds: new Set(),
      defaultApprovalPolicy: 'auto',
      userInputGate
    })
    const deps = (runtime as unknown as {
      deps: {
        executeKunTool(threadId: string, turnId: string, toolName: string, args: Record<string, unknown>): Promise<{ output: unknown; isError?: boolean }>
      }
    }).deps

    await expect(deps.executeKunTool('th', 'tn', 'user_input', {})).resolves.toEqual({
      output: { status: 'submitted', answers: [] },
      isError: false
    })
    expect(immediatelyResolved).toBe(true)
  })

  test('injects native AGENTS.md instructions and records turn metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-sdk-instructions-'))
    try {
      const home = join(root, 'home')
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'AGENTS.md'), 'SDK workspace rule.', 'utf8')
      const updatedMetadata: unknown[] = []
      const runtime = createAgentSdkRuntime({
        registry: { listTools: () => [] } as never,
        turns: {
          updateTurnMetadata: async (_threadId: string, _turnId: string, patch: unknown) => {
            updatedMetadata.push(patch)
          }
        } as never,
        sessionStore: {
          loadItems: async () => [{
            id: 'item_user',
            turnId: 'tn',
            threadId: 'th',
            kind: 'user_message',
            role: 'user',
            status: 'completed',
            text: 'hello',
            createdAt: '2026-07-03T00:00:00.000Z'
          }]
        } as never,
        threadStore: {
          get: async () => threadWith({
            id: 'th',
            workspace,
            providerId: 'claude-subscription',
            turns: [{
              id: 'tn',
              prompt: 'hello',
              actingModelRoute: undefined
            } as ThreadRecord['turns'][number]]
          })
        } as never,
        events: {} as never,
        ids: { next: (p: string) => p },
        prefix: { systemPrompt: '' },
        providerConfigs: {
          'claude-subscription': { kind: 'agent-sdk', apiKey: 'sk-ant-oat01-tok' }
        } as never,
        agentSdkProviderIds: new Set(['claude-subscription']),
        defaultApprovalPolicy: 'auto',
        instructionRuntime: new InstructionRuntime(
          KunCapabilitiesConfig.parse({ instructions: { enabled: true } }).instructions,
          { homeDir: home }
        )
      })
      const deps = (runtime as unknown as {
        deps: {
          loadTurnContext(threadId: string, turnId: string): Promise<{
            contextInstructions?: string[]
            actingModelRoute?: {
              model: string
              providerId?: string
              accountId?: string
            }
          } | null>
        }
      }).deps

      const ctx = await deps.loadTurnContext('th', 'tn')

      expect(ctx?.contextInstructions?.join('\n')).toContain('SDK workspace rule.')
      expect(ctx?.actingModelRoute).toEqual({
        model: 'claude-haiku-4-5',
        providerId: 'claude-subscription'
      })
      expect(updatedMetadata).toEqual(expect.arrayContaining([
        {
          actingModelRoute: {
            model: 'claude-haiku-4-5',
            providerId: 'claude-subscription'
          }
        },
        expect.objectContaining({
          injectedInstructionSources: [
            expect.objectContaining({
              scope: 'workspace',
              path: join(workspace, 'AGENTS.md')
            })
          ],
          instructionInjectionBytes: expect.any(Number)
        })
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
