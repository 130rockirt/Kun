import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemorySessionStore } from '../../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { UsageService } from '../../src/services/usage-service.js'
import { createKunServeRuntime, seedUsageCarryover } from '../../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../../src/contracts/usage.js'
import type { SessionStore } from '../../src/ports/session-store.js'
import { KunCapabilitiesConfig } from '../../src/contracts/capabilities.js'
import { startLlmDebugRoundIfEnabled } from '../../src/services/llm-debug-recorder.js'
import { usage, writeConfigurationExtension, writeConfigurationFixtureRunner, writeLazyFixtureRunner, writeLazyToolExtension } from '../support/runtime-factory-fixtures.js'

describe('runtime factory usage carryover', () => {
  const tempDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('seeds runtime usage from the latest persisted cumulative usage event per thread', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const usageService = new UsageService()
    await threadStore.upsert(createThreadRecord({
      id: 'thr_seed',
      title: 'Seeded thread',
      workspace: '/tmp/project',
      model: 'deepseek-chat'
    }))
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 20, completionTokens: 5, cacheHitTokens: 10, cacheMissTokens: 10, turns: 1 })
    })
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 5,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 80, completionTokens: 20, cacheHitTokens: 72, cacheMissTokens: 8, turns: 3 })
    })

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(usageService.forThread('thr_seed')).toMatchObject({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cacheHitTokens: 72,
      cacheMissTokens: 8,
      turns: 3
    })
    expect(usageService.cacheSnapshot('thr_seed')).toMatchObject({
      hits: 72,
      misses: 8,
      hitRate: 0.9
    })
  })

  it('seeds runtime usage from indexed latest snapshots without replaying event logs', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore() as InMemorySessionStore & {
      loadLatestUsageSnapshots: NonNullable<SessionStore['loadLatestUsageSnapshots']>
    }
    const usageService = new UsageService()
    sessionStore.loadLatestUsageSnapshots = vi.fn(async () => [
      {
        threadId: 'thr_indexed',
        seq: 9,
        usage: usage({ promptTokens: 120, completionTokens: 30, cacheHitTokens: 100, cacheMissTokens: 20, turns: 4 })
      }
    ])
    const loadEventsSince = vi.spyOn(sessionStore, 'loadEventsSince')

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(loadEventsSince).not.toHaveBeenCalled()
    expect(usageService.forThread('thr_indexed')).toMatchObject({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cacheHitTokens: 100,
      cacheMissTokens: 20,
      turns: 4
    })
  })

  it('hot-applies tool capabilities without overriding the registry-owned default model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-apply-'))
    tempDirs.push(dataDir)
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'tok',
      apiKey: 'sk-default',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-before',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      tokenEconomyMode: false,
      insecure: false,
      storage: { backend: 'file' },
      capabilities: KunCapabilitiesConfig.parse({})
    })

    try {
      expect(runtime.llmDebug).toBeDefined()
      expect(runtime.extensionPlatform).toBeDefined()
      expect(runtime.info().extensions).toMatchObject({
        enabled: true,
        apiVersions: ['1.2.0', '1.1.0', '1.0.0'],
        manifestVersions: [1]
      })
      expect(runtime.info().capabilities.instructions.enabled).toBe(true)
      const applied = await runtime.applyConfig({
        serve: { model: 'model-after' },
        capabilities: KunCapabilitiesConfig.parse({
          web: { enabled: true, fetchEnabled: true },
          instructions: { enabled: false }
        })
      })

      expect(applied).toEqual({ ok: true })
      expect(runtime.info().model).toBe('model-before')
      expect(runtime.info().capabilities.web.fetch.available).toBe(true)
      expect(runtime.info().capabilities.instructions).toMatchObject({ enabled: false, status: 'disabled' })
      const diagnostics = await runtime.toolDiagnostics?.()
      expect(diagnostics?.providers.some((provider) => provider.id === 'web')).toBe(true)
      expect(diagnostics?.instructions?.enabled).toBe(false)
      expect(diagnostics?.extensions).toMatchObject({ tools: [], providers: [], hosts: [] })
    } finally {
      await runtime.shutdown?.()
    }
  })

  it('keeps explore_agent advertised across Lab hot-apply toggles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-explore-lab-'))
    tempDirs.push(dataDir)
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'tok',
      apiKey: 'sk-default',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-before',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      tokenEconomyMode: false,
      insecure: false,
      storage: { backend: 'file' },
      lab: { exploreAgent: { enabled: true, fast: false }, pptAgent: { enabled: true, fast: false, imageFirst: true } },
      capabilities: KunCapabilitiesConfig.parse({
        subagents: { enabled: true }
      })
    })

    const listExplore = async () => {
      const toolHost = runtime.toolHost
      expect(toolHost).toBeDefined()
      if (!toolHost) throw new Error('Expected the Kun runtime tool host to be available')
      const tools = await toolHost.listTools({
        threadId: 'thr_explore',
        turnId: 'turn_explore',
        workspace: dataDir,
        threadMode: 'agent',
        clientSurface: 'gui',
        approvalPolicy: 'auto',
        abortSignal: new AbortController().signal,
        awaitApproval: async () => 'allow'
      })
      return tools.some((tool) => tool.name === 'explore_agent')
    }

    try {
      const diagnostics = await runtime.toolDiagnostics?.()
      expect(diagnostics?.providers.some((provider) => provider.id === 'explore-agent')).toBe(true)
      expect(await listExplore()).toBe(true)

      // Any hot-apply previously dropped explore_agent from the rebuilt registry.
      expect(await runtime.applyConfig({
        capabilities: KunCapabilitiesConfig.parse({
          subagents: { enabled: true },
          web: { enabled: true, fetchEnabled: true }
        })
      })).toEqual({ ok: true })
      expect(await listExplore()).toBe(true)

      expect(await runtime.applyConfig({
        lab: { exploreAgent: { enabled: false, fast: false }, pptAgent: { enabled: true, fast: false, imageFirst: true } }
      })).toEqual({ ok: true })
      expect(await listExplore()).toBe(false)

      expect(await runtime.applyConfig({
        lab: { exploreAgent: { enabled: true, fast: false }, pptAgent: { enabled: true, fast: false, imageFirst: true } }
      })).toEqual({ ok: true })
      expect(await listExplore()).toBe(true)
    } finally {
      await runtime.shutdown?.()
    }
  })

  it('keeps ppt_agent advertised across Lab hot-apply toggles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-ppt-lab-'))
    tempDirs.push(dataDir)
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'tok',
      apiKey: 'sk-default',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-before',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      tokenEconomyMode: false,
      insecure: false,
      storage: { backend: 'file' },
      lab: { exploreAgent: { enabled: true, fast: false }, pptAgent: { enabled: true, fast: false, imageFirst: true } },
      capabilities: KunCapabilitiesConfig.parse({
        subagents: { enabled: true }
      })
    })

    const listPpt = async () => {
      const toolHost = runtime.toolHost
      expect(toolHost).toBeDefined()
      if (!toolHost) throw new Error('Expected the Kun runtime tool host to be available')
      const tools = await toolHost.listTools({
        threadId: 'thr_ppt',
        turnId: 'turn_ppt',
        workspace: dataDir,
        threadMode: 'agent',
        clientSurface: 'gui',
        approvalPolicy: 'auto',
        abortSignal: new AbortController().signal,
        awaitApproval: async () => 'allow'
      })
      return tools.some((tool) => tool.name === 'ppt_agent')
    }

    try {
      const diagnostics = await runtime.toolDiagnostics?.()
      expect(diagnostics?.providers.some((provider) => provider.id === 'ppt-agent')).toBe(true)
      expect(await listPpt()).toBe(true)

      // Any hot-apply previously dropped ppt_agent from the rebuilt registry.
      expect(await runtime.applyConfig({
        capabilities: KunCapabilitiesConfig.parse({
          subagents: { enabled: true },
          web: { enabled: true, fetchEnabled: true }
        })
      })).toEqual({ ok: true })
      expect(await listPpt()).toBe(true)

      expect(await runtime.applyConfig({
        lab: { exploreAgent: { enabled: true, fast: false }, pptAgent: { enabled: false, fast: false, imageFirst: true } }
      })).toEqual({ ok: true })
      expect(await listPpt()).toBe(false)

      expect(await runtime.applyConfig({
        lab: { exploreAgent: { enabled: true, fast: false }, pptAgent: { enabled: true, fast: false, imageFirst: true } }
      })).toEqual({ ok: true })
      expect(await listPpt()).toBe(true)
    } finally {
      await runtime.shutdown?.()
    }
  })

  it('keeps the recorder available while gating capture by each thread state', async () => {
    for (const [name, runtimeOptions, expectedCapture] of [
      ['omitted', undefined, false],
      ['disabled', { llmDebug: { enabled: false } }, false],
      ['enabled-default', {
        llmDebug: { enabled: true, defaultThreadCaptureEnabled: true }
      }, true]
    ] as const) {
      const dataDir = await mkdtemp(join(tmpdir(), `kun-runtime-llm-debug-${name}-`))
      tempDirs.push(dataDir)
      const runtime = await createKunServeRuntime({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        runtimeToken: 'tok',
        apiKey: 'sk-default',
        baseUrl: 'https://api.example.test/v1',
        model: 'model-before',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        tokenEconomyMode: false,
        insecure: false,
        storage: { backend: 'file' },
        ...(runtimeOptions ? { runtime: runtimeOptions } : {}),
        capabilities: KunCapabilitiesConfig.parse({})
      })

      try {
        const recorder = runtime.llmDebug
        if (name === 'disabled') {
          expect(recorder).toBeUndefined()
          continue
        }
        expect(recorder).toBeDefined()
        if (!recorder) throw new Error('expected Agent Perspective recorder')
        const thread = await runtime.threadService.create({
          workspace: dataDir,
          model: 'model-before',
          mode: 'agent'
        })
        expect(thread.modelRequestCaptureEnabled).toBe(expectedCapture)
        const round = await startLlmDebugRoundIfEnabled(recorder, {
          threadId: thread.id,
          turnId: 'turn-1',
          provider: 'compat',
          model: 'model-before'
        })
        if (!expectedCapture) {
          expect(round).toBeUndefined()
          await expect(recorder.listThread(thread.id)).resolves.toMatchObject({ records: [] })
          continue
        }
        expect(round).toBeDefined()
        if (!round) throw new Error('expected enabled thread trace')
        recorder.beginHttpAttempt(round, {
          endpointFormat: 'chat_completions',
          attempt: 1,
          reason: 'initial',
          url: 'https://api.example.test/v1/chat/completions',
          headers: {},
          bodyText: JSON.stringify({ model: 'model-before' })
        })
        await recorder.finish(round)
        await expect(recorder.listThread(thread.id)).resolves.toMatchObject({
          records: [expect.objectContaining({
            provider: 'compat',
            model: 'model-before',
            attempt: 1,
            endpointFormat: 'chat_completions'
          })]
        })
      } finally {
        await runtime.shutdown?.()
      }
    }
  })

  it('hot-applies the new-thread capture default without changing existing threads', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-llm-debug-default-'))
    tempDirs.push(dataDir)
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'tok',
      apiKey: 'sk-default',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-before',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      tokenEconomyMode: false,
      insecure: false,
      storage: { backend: 'file' },
      capabilities: KunCapabilitiesConfig.parse({})
    })

    try {
      const existing = await runtime.threadService.create({
        workspace: dataDir,
        model: 'model-before',
        mode: 'agent'
      })
      expect(existing.modelRequestCaptureEnabled).toBe(false)

      await expect(runtime.applyConfig({
        runtime: {
          llmDebug: {
            enabled: true,
            defaultThreadCaptureEnabled: true
          }
        }
      })).resolves.toEqual({ ok: true })

      const later = await runtime.threadService.create({
        workspace: dataDir,
        model: 'model-before',
        mode: 'agent'
      })
      expect(later.modelRequestCaptureEnabled).toBe(true)
      expect((await runtime.threadService.get(existing.id))?.modelRequestCaptureEnabled).toBe(false)
    } finally {
      await runtime.shutdown?.()
    }
  })
})
