import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadSchema } from '../contracts/threads.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { ModelConnectionSnapshot } from '../contracts/model-connections.js'
import type { KunTuiClient, ThreadDetail, TuiConnection } from './client.js'
import { TuiClientError } from './client.js'
import { TuiController } from './controller.js'
import type { TuiOptions } from './options.js'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'
import { modelCapabilitiesForModel } from '../loop/model-context-profile.js'
import { testGraphEnvelope, testGraphPlan } from '../graph/graph-test-fixtures.test-support.js'
import { testTuiGraphRun } from './graph-mode.test-support.js'

function detail(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    ...ThreadSchema.parse({
      id: 'thr_1',
      title: 'Shared',
      workspace: '/tmp/project',
      model: 'model-a',
      mode: 'agent',
      status: 'idle',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      relation: 'primary',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      turns: []
    }),
    latestSeq: 0,
    pendingUserInputIds: [],
    ...overrides
  }
}

function options(): TuiOptions {
  return {
    runtimeToken: 'secret',
    dataDir: '/tmp/data',
    workspace: '/tmp/project',
    continueLatest: true,
    noStart: false,
    help: false
  }
}

const runtime = {
  baseUrl: 'http://127.0.0.1:18899',
  runtimeToken: 'secret',
  discovered: true,
  runtimeInfo: {
    model: 'model-a',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write'
  }
} as unknown as TuiConnection

describe('TuiController', () => {
  it('hydrates the shared default before first render and publishes it through the compatibility callback', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-default-model-'))
    const snapshot: ModelConnectionSnapshot = {
      schemaVersion: 1,
      revision: 7,
      providers: [{
        id: 'codex',
        accountId: 'account:codex',
        name: 'Codex',
        kind: 'http',
        authType: 'subscription',
        baseUrl: 'https://example.test/codex',
        endpointFormat: 'responses',
        configured: true,
        models: ['gpt-next'],
        selectedModel: 'gpt-next'
      }],
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-next',
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    }
    const client = {
      modelConnections: vi.fn(async () => snapshot),
      listThreads: vi.fn(async () => [])
    } as unknown as KunTuiClient
    const persistSelection = vi.fn(async () => undefined)
    const tuiOptions = { ...options(), dataDir, continueLatest: false }
    const tuiRuntime = {
      ...runtime,
      runtimeInfo: { ...runtime.runtimeInfo, model: 'stale-model' }
    } as TuiConnection
    const controller = new TuiController(client, tuiOptions, tuiRuntime, persistSelection)

    try {
      const initialized = await controller.initializeModelConnections()
      expect(initialized).toBe(snapshot)
      expect(controller.state.modelConnections).toBe(snapshot)
      expect(tuiOptions).toMatchObject({
        providerId: 'codex',
        accountId: 'account:codex',
        model: 'gpt-next'
      })
      expect(tuiRuntime.runtimeInfo.model).toBe('gpt-next')
      expect(persistSelection).toHaveBeenCalledWith(snapshot)
    } finally {
      await controller.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps an open session pinned while new sessions follow a changed shared default', async () => {
    const oldThread = detail({
      providerId: 'codex',
      accountId: 'account:codex',
      model: 'gpt-old'
    })
    const newThread = detail({
      id: 'thr_new',
      providerId: 'minimax',
      accountId: 'account:minimax',
      model: 'MiniMax-M3'
    })
    let threads = [oldThread]
    const createThread = vi.fn(async () => {
      threads = [oldThread, newThread]
      return newThread
    })
    const client = {
      listThreads: vi.fn(async () => threads),
      getThread: vi.fn(async (id: string) => threads.find((thread) => thread.id === id)!),
      createThread,
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const tuiOptions = options()
    const controller = new TuiController(client, tuiOptions, runtime)

    await controller.start()
    expect(tuiOptions).toMatchObject({
      providerId: 'codex',
      accountId: 'account:codex',
      model: 'gpt-old'
    })
    controller.applyModelSelection({
      schemaVersion: 1,
      revision: 8,
      providers: [{
        id: 'minimax',
        accountId: 'account:minimax',
        name: 'MiniMax',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://example.test/minimax',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['MiniMax-M3'],
        selectedModel: 'MiniMax-M3'
      }],
      defaultProviderId: 'minimax',
      defaultAccountId: 'account:minimax',
      defaultModel: 'MiniMax-M3',
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    }, false)

    expect(tuiOptions).toMatchObject({
      providerId: 'codex',
      accountId: 'account:codex',
      model: 'gpt-old'
    })
    await controller.createThread()
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'minimax',
      accountId: 'account:minimax',
      model: 'MiniMax-M3'
    }))
    await controller.stop()
  })

  it('leaves implicit permissions to the active shared runtime defaults', async () => {
    const created = detail({
      id: 'thr_inherited',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access'
    })
    const createThread = vi.fn(async (_request: Parameters<KunTuiClient['createThread']>[0]) => created)
    const client = {
      createThread,
      listThreads: vi.fn(async () => [created]),
      getThread: vi.fn(async () => created),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const staleRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write'
      }
    } as TuiConnection
    const controller = new TuiController(client, { ...options(), continueLatest: false }, staleRuntime)

    await controller.createThread('Inherited permissions')

    const request = createThread.mock.calls[0]![0]
    expect(request).not.toHaveProperty('approvalPolicy')
    expect(request).not.toHaveProperty('sandboxMode')
    await controller.stop()
  })

  it.each([
    {
      name: 'approval only',
      overrides: { approvalPolicy: 'never' as const },
      expected: { approvalPolicy: 'never' }
    },
    {
      name: 'sandbox only',
      overrides: { sandboxMode: 'danger-full-access' as const },
      expected: { sandboxMode: 'danger-full-access' }
    },
    {
      name: 'approval and sandbox',
      overrides: {
        approvalPolicy: 'auto' as const,
        sandboxMode: 'danger-full-access' as const
      },
      expected: {
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access'
      }
    }
  ])('sends explicit TUI permission overrides: $name', async ({ overrides, expected }) => {
    const created = detail({ id: `thr_${expected.approvalPolicy ?? 'default'}_${expected.sandboxMode ?? 'default'}` })
    const createThread = vi.fn(async (_request: Parameters<KunTuiClient['createThread']>[0]) => created)
    const client = {
      createThread,
      listThreads: vi.fn(async () => [created]),
      getThread: vi.fn(async () => created),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(
      client,
      { ...options(), continueLatest: false, ...overrides },
      runtime
    )

    await controller.createThread('Explicit permissions')

    const request = createThread.mock.calls[0]![0]
    expect(request).toMatchObject(expected)
    if (!('approvalPolicy' in expected)) expect(request).not.toHaveProperty('approvalPolicy')
    if (!('sandboxMode' in expected)) expect(request).not.toHaveProperty('sandboxMode')
    await controller.stop()
  })

  it('does not create a fallback session after the last shared provider is disconnected', async () => {
    const createThread = vi.fn()
    const client = {
      createThread
    } as unknown as KunTuiClient
    const tuiRuntime = {
      ...runtime,
      runtimeInfo: { ...runtime.runtimeInfo, model: 'stale-model' }
    } as TuiConnection
    const controller = new TuiController(client, options(), tuiRuntime)
    controller.applyModelSelection({
      schemaVersion: 1,
      revision: 9,
      providers: [],
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    }, false)

    await controller.createThread()

    expect(createThread).not.toHaveBeenCalled()
    expect(tuiRuntime.runtimeInfo.model).toBe('')
    expect(controller.state.busy).toBe(false)
    expect(controller.state.notification?.message).toContain('/connect')
  })

  it('starts on the guided composer and only opens the thread picker on request', async () => {
    const client = {
      listThreads: vi.fn(async () => [detail()])
    } as unknown as KunTuiClient
    const controller = new TuiController(client, { ...options(), continueLatest: false }, runtime)

    await controller.start()
    expect(controller.state.view).toBe('chat')
    expect(controller.state.projection).toBeUndefined()

    controller.showThreads()
    expect(controller.state.view).toBe('threads')
    controller.showChat()
    expect(controller.state.view).toBe('chat')
    expect(controller.state.projection).toBeUndefined()
    await controller.stop()
  })

  it('publishes an immediate sending phase before start-turn acknowledges the request', async () => {
    const source = detail()
    let resolveStart!: (value: { turnId: string }) => void
    const startTurn = vi.fn(() => new Promise<{ turnId: string }>((resolve) => {
      resolveStart = resolve
    }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    const submission = controller.submit('slow request')

    expect(controller.state).toMatchObject({
      busy: true,
      busyLabel: 'Sending message'
    })
    expect(controller.state.busyStartedAt).toBeTruthy()
    expect(controller.state.projection?.runningTurnId).toBeUndefined()

    resolveStart({ turnId: 'turn_slow' })
    await submission
    expect(controller.state).toMatchObject({
      busy: false,
      projection: {
        runningTurnId: 'turn_slow',
        activity: {
          phase: 'starting',
          label: 'Sending message'
        }
      }
    })
    expect(controller.state.busyLabel).toBeUndefined()
    expect(controller.state.busyStartedAt).toBeUndefined()
    expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
      prompt: 'slow request',
      clientSurface: 'tui'
    }))
    await controller.stop()
  })

  it('enters Graph mode before the prompt and submits the shared orchestration contract', async () => {
    const source = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_graph' }))
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns: vi.fn(async () => []),
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    await controller.manageGraphMode()
    expect(controller.state.composerOrchestration).toBe('graph')
    expect(controller.state.notification?.message).toContain('type a requirement')

    await controller.submit('Implement the release workflow.')
    expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
      prompt: 'Implement the release workflow.',
      clientSurface: 'tui',
      orchestration: 'graph'
    }))
    expect(controller.state.projection?.thread.turns.at(-1)?.orchestration).toBe('graph')

    await controller.manageGraphMode('off')
    expect(controller.state.composerOrchestration).toBe('direct')
    await controller.stop()
  })

  it('enables and submits a one-step Graph requirement', async () => {
    const source = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_graph_one_step' }))
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns: vi.fn(async () => []),
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    await expect(controller.submitGraphRequirement('构建实时看板')).resolves.toBe(true)
    expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
      prompt: '构建实时看板',
      orchestration: 'graph'
    }))
    await controller.stop()
  })

  it('refuses disabled Graph entry without changing Direct mode', async () => {
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: false })),
      listThreads: vi.fn(async () => [])
    } as unknown as KunTuiClient
    const controller = new TuiController(
      client,
      { ...options(), continueLatest: false },
      runtime
    )

    await controller.start()
    await controller.manageGraphMode()
    await expect(controller.submitGraphRequirement('Keep this draft')).resolves.toBe(false)

    expect(controller.state.composerOrchestration).toBe('direct')
    expect(controller.state.graphAvailable).toBe(false)
    expect(controller.state.notification).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('disabled')
    })
    await controller.stop()
  })

  it('explains an older runtime without Graph diagnostics and keeps Direct mode', async () => {
    const client = {
      graphAvailability: vi.fn(async () => {
        throw new TuiClientError('not found', 404, 'not_found')
      }),
      listThreads: vi.fn(async () => [])
    } as unknown as KunTuiClient
    const controller = new TuiController(
      client,
      { ...options(), continueLatest: false },
      runtime
    )

    await controller.start()
    await expect(controller.manageGraphMode()).resolves.toBe(false)
    expect(controller.state).toMatchObject({
      composerOrchestration: 'direct',
      graphAvailable: false,
      graphUnavailableReason: expect.stringContaining('does not support')
    })
    await controller.stop()
  })

  it('does not open a stale Graph board when the requested refresh fails', async () => {
    const source = detail()
    const run = testTuiGraphRun()
    const listGraphRuns = vi.fn()
      .mockResolvedValueOnce([run])
      .mockRejectedValueOnce(new Error('refresh failed'))
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns,
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    await controller.showGraphStatus()
    expect(controller.state.graphBoard).toBeUndefined()
    expect(controller.state.notification).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Could not load Graph status')
    })
    await controller.stop()
  })

  it('starts a new TUI process in Direct mode after another process selected Graph', async () => {
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listThreads: vi.fn(async () => [])
    } as unknown as KunTuiClient
    const first = new TuiController(
      client,
      { ...options(), continueLatest: false },
      runtime
    )
    await first.start()
    await first.manageGraphMode()
    expect(first.state.composerOrchestration).toBe('graph')
    await first.stop()

    const restarted = new TuiController(
      client,
      { ...options(), continueLatest: false },
      runtime
    )
    expect(restarted.state.composerOrchestration).toBe('direct')
    await restarted.start()
    expect(restarted.state.composerOrchestration).toBe('direct')
    await restarted.stop()
  })

  it('steers a durable active GraphRun instead of starting a second graph', async () => {
    const source = detail()
    const run = testTuiGraphRun()
    const startTurn = vi.fn()
    const steerGraphRun = vi.fn(async () => run)
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns: vi.fn(async () => [run]),
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn,
      steerGraphRun
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    await controller.submitGraphRequirement('Prioritize the Windows validation node.')

    expect(steerGraphRun).toHaveBeenCalledWith(
      run.id,
      'Prioritize the Windows validation node.'
    )
    expect(startTurn).not.toHaveBeenCalled()
    expect(controller.state.notification?.message).toContain('Guidance persisted')

    await controller.showGraphStatus()
    expect(controller.state.graphBoard).toEqual({ runId: run.id })
    controller.dismissGraphBoard()
    expect(controller.state.graphBoard).toBeUndefined()
    await controller.stop()
  })

  it('reconciles Graph events through server-confirmed run truth', async () => {
    const source = detail()
    const run = testTuiGraphRun()
    const latestRun = testTuiGraphRun({
      lastEventSeq: 5,
      updatedAt: '2026-07-26T00:00:05.000Z'
    })
    let onEvent!: (event: RuntimeEvent) => void
    let resolveFirst!: (value: typeof run) => void
    const getGraphRun = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof run>((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce(latestRun)
    const client = {
      graphAvailability: vi.fn(async () => ({ enabled: true })),
      listGraphRuns: vi.fn(async () => []),
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      getGraphRun,
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onEvent: (event: RuntimeEvent) => void
      }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    onEvent({
      kind: 'graph_event',
      threadId: source.id,
      seq: 1,
      timestamp: '2026-07-26T00:00:01.000Z',
      graph: testGraphEnvelope(1, {
        type: 'run_created',
        payload: {
          plan: testGraphPlan(),
          projectId: 'project_1',
          sourceTurnId: 'turn_source'
        }
      }, {
        threadId: source.id
      })
    })
    await vi.waitFor(() => expect(getGraphRun).toHaveBeenCalledTimes(1))
    onEvent({
      kind: 'graph_event',
      threadId: source.id,
      seq: 2,
      timestamp: '2026-07-26T00:00:02.000Z',
      graph: testGraphEnvelope(2, {
        type: 'run_created',
        payload: {
          plan: testGraphPlan(),
          projectId: 'project_1',
          sourceTurnId: 'turn_source'
        }
      }, {
        threadId: source.id
      })
    })
    resolveFirst(run)

    await vi.waitFor(() => expect(controller.state.graphRuns).toEqual([latestRun]))
    expect(getGraphRun).toHaveBeenCalledTimes(2)
    expect(getGraphRun).toHaveBeenNthCalledWith(1, run.id)
    expect(getGraphRun).toHaveBeenNthCalledWith(2, run.id)
    await controller.stop()
  })

  it('hydrates attachment metadata for persisted user messages', async () => {
    const createdAt = '2026-07-22T00:00:00.000Z'
    const source = detail({
      turns: [{
        id: 'turn_attachment',
        threadId: 'thr_1',
        status: 'completed',
        orchestration: 'direct',
        prompt: 'What is in this image?',
        steering: [],
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        items: [{
          id: 'item_attachment',
          turnId: 'turn_attachment',
          threadId: 'thr_1',
          role: 'user',
          status: 'completed',
          createdAt,
          finishedAt: createdAt,
          kind: 'user_message',
          text: 'What is in this image?',
          attachmentIds: ['att_image']
        }],
        attachmentIds: ['att_image'],
        activeSkillIds: [],
        injectedMemoryIds: [],
        injectedMemorySummaries: [],
        injectedInstructionSources: []
      }]
    })
    const getAttachment = vi.fn(async () => ({
      attachment: {
        id: 'att_image',
        name: 'clipboard.png',
        kind: 'image' as const,
        mimeType: 'image/png',
        byteSize: 2048,
        hash: 'hash-image',
        width: 640,
        height: 480,
        threadIds: ['thr_1'],
        workspaces: ['/tmp/project'],
        createdAt,
        updatedAt: createdAt
      }
    }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      getAttachment,
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)

    await controller.start()
    await vi.waitFor(() => expect(controller.state.attachmentMetadata.att_image).toMatchObject({
      name: 'clipboard.png',
      width: 640,
      height: 480
    }))
    expect(getAttachment).toHaveBeenCalledWith('att_image')
    await controller.stop()
  })

  it('selects from a legacy GUI model catalog locally without calling unavailable runtime routes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-legacy-model-'))
    const selectModel = vi.fn()
    const client = { selectModel } as unknown as KunTuiClient
    const legacyRuntime = { ...runtime, legacyGui: true }
    const controller = new TuiController(client, { ...options(), dataDir }, legacyRuntime)
    try {
      controller.applyModelSelection({
        schemaVersion: 1,
        revision: 0,
        providers: [{
          id: 'codex', accountId: 'account:codex', name: 'Codex', kind: 'http',
          authType: 'subscription', baseUrl: 'https://chatgpt.com/backend-api',
          endpointFormat: 'responses', configured: true,
          models: ['gpt-5.6-luna', 'gpt-5.6-sol'], selectedModel: 'gpt-5.6-luna'
        }],
        defaultProviderId: 'codex', defaultAccountId: 'account:codex', defaultModel: 'gpt-5.6-luna',
        proxy: { enabled: false, url: '' }, routePools: [], localModelGateway: { enabled: false }
      }, false)

      const selected = await controller.selectModel({
        providerId: 'codex', accountId: 'account:codex', model: 'gpt-5.6-sol'
      })
      expect(selected).toMatchObject({ revision: 1, defaultModel: 'gpt-5.6-sol' })
      expect(controller.options).toMatchObject({
        providerId: 'codex', accountId: 'account:codex', model: 'gpt-5.6-sol'
      })
      expect(selectModel).not.toHaveBeenCalled()
    } finally {
      await controller.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('shows a verified legacy GUI session as connected while its idle SSE long poll is pending', async () => {
    const source = detail()
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onConnection?: (state: 'connecting' | 'connected' | 'reconnecting') => void
      }) => {
        input.onConnection?.('connecting')
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), { ...runtime, legacyGui: true })
    await controller.start()
    expect(controller.state.projection?.thread.id).toBe(source.id)
    expect(controller.state.connection).toBe('connected')
    await controller.stop()
  })

  it('refreshes a stale model catalog after another client wins the revision race', async () => {
    const initial = {
      schemaVersion: 1 as const,
      revision: 2,
      providers: [{
        id: 'deepseek', accountId: 'account:deepseek', name: 'DeepSeek', kind: 'http' as const,
        authType: 'api-key' as const, endpointFormat: 'chat_completions' as const,
        configured: true, models: ['deepseek-chat'], selectedModel: 'deepseek-chat'
      }],
      defaultProviderId: 'deepseek', defaultAccountId: 'account:deepseek', defaultModel: 'deepseek-chat',
      proxy: { enabled: false, url: '' }, routePools: [], localModelGateway: { enabled: false }
    }
    const refreshed = {
      ...initial,
      revision: 3,
      providers: [...initial.providers, {
        id: 'kimi-code', accountId: 'account:kimi-code', name: 'Kimi Code', kind: 'http' as const,
        authType: 'subscription' as const, endpointFormat: 'chat_completions' as const,
        configured: true, models: ['kimi-k2.5'], selectedModel: 'kimi-k2.5'
      }]
    }
    const client = {
      selectModel: vi.fn(async () => { throw new TuiClientError('revision conflict', 409, 'revision_conflict') }),
      modelConnections: vi.fn(async () => refreshed)
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    controller.applyModelSelection(initial, false)

    await expect(controller.selectModel({
      providerId: 'deepseek', accountId: 'account:deepseek', model: 'deepseek-chat'
    })).rejects.toThrow(/selector was refreshed/i)
    expect(controller.state.modelConnections).toEqual(refreshed)
    expect(client.modelConnections).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('cycles supported reasoning efforts and sends the selected effort with the turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-effort-'))
    const source = detail({ providerId: 'provider-a', accountId: 'account-a', model: 'reasoning-model' })
    const startTurn = vi.fn(async () => ({ turnId: 'turn_reasoning' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, { ...options(), dataDir }, runtime)
    try {
      await controller.start()
      controller.applyModelSelection({
        schemaVersion: 1,
        revision: 1,
        defaultProviderId: 'provider-a',
        defaultAccountId: 'account-a',
        defaultModel: 'reasoning-model',
        proxy: { enabled: false, url: '' },
        routePools: [],
        localModelGateway: { enabled: false },
        providers: [{
          id: 'provider-a', accountId: 'account-a', name: 'Provider A', kind: 'http',
          authType: 'api-key', endpointFormat: 'chat_completions', configured: true,
          models: ['reasoning-model'], selectedModel: 'reasoning-model',
          modelCapabilities: {
            'reasoning-model': {
              id: 'reasoning-model', inputModalities: ['text'], outputModalities: ['text'],
              supportsToolCalling: true, messageParts: ['text'],
              reasoning: {
                supportedEfforts: ['off', 'low', 'high'], defaultEffort: 'low',
                requestProtocol: 'deepseek-chat-completions'
              }
            }
          }
        }]
      }, false)

      expect(controller.state.reasoningEffort).toBe('low')
      expect(controller.cycleReasoningEffort()).toBe(true)
      expect(controller.state.reasoningEffort).toBe('high')
      await controller.submit('stream this answer')
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        model: 'reasoning-model', providerId: 'provider-a', accountId: 'account-a',
        reasoningEffort: 'high', prompt: 'stream this answer'
      }))
    } finally {
      await controller.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('cycles audited GLM variants from a legacy catalog without capability metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-legacy-glm-effort-'))
    const source = detail({
      providerId: 'opencode-go',
      accountId: 'account:opencode-go',
      model: 'glm-5.2'
    })
    const startTurn = vi.fn(async () => ({ turnId: 'turn_glm_reasoning' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, {
      ...options(),
      dataDir,
      providerId: 'opencode-go',
      accountId: 'account:opencode-go',
      model: 'glm-5.2'
    }, { ...runtime, legacyGui: true })
    try {
      await controller.start()
      controller.applyModelSelection({
        schemaVersion: 1,
        revision: 0,
        defaultProviderId: 'opencode-go',
        defaultAccountId: 'account:opencode-go',
        defaultModel: 'glm-5.2',
        proxy: { enabled: false, url: '' },
        routePools: [],
        localModelGateway: { enabled: false },
        providers: [{
          id: 'opencode-go',
          accountId: 'account:opencode-go',
          name: 'OpenCode Go',
          kind: 'http',
          authType: 'subscription',
          endpointFormat: 'chat_completions',
          configured: true,
          models: ['glm-5.2'],
          selectedModel: 'glm-5.2',
          modelCapabilities: {
            'glm-5.2': {
              id: 'glm-5.2',
              inputModalities: ['text'],
              outputModalities: ['text'],
              supportsToolCalling: true,
              messageParts: ['text'],
              reasoning: {
                supportedEfforts: ['auto'],
                defaultEffort: 'auto',
                requestProtocol: 'none'
              }
            }
          }
        }]
      }, false)

      expect(controller.reasoningOptions()).toEqual(['off', 'high', 'max'])
      expect(controller.state.reasoningEffort).toBe('max')
      expect(controller.cycleReasoningEffort()).toBe(true)
      expect(controller.state.reasoningEffort).toBe('off')
      await controller.submit('use the selected effort')
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        providerId: 'opencode-go',
        accountId: 'account:opencode-go',
        model: 'glm-5.2',
        reasoningEffort: 'off'
      }))
    } finally {
      await controller.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('cycles audited Codex variants from a legacy catalog without capability metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-legacy-codex-effort-'))
    const source = detail({
      providerId: 'codex',
      accountId: 'account:codex',
      model: 'gpt-5.6-luna'
    })
    const startTurn = vi.fn(async () => ({ turnId: 'turn_codex_reasoning' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, {
      ...options(),
      dataDir,
      providerId: 'codex',
      accountId: 'account:codex',
      model: 'gpt-5.6-luna'
    }, { ...runtime, legacyGui: true })
    try {
      await controller.start()
      controller.applyModelSelection({
        schemaVersion: 1,
        revision: 0,
        defaultProviderId: 'codex',
        defaultAccountId: 'account:codex',
        defaultModel: 'gpt-5.6-luna',
        proxy: { enabled: false, url: '' },
        routePools: [],
        localModelGateway: { enabled: false },
        providers: [{
          id: 'codex',
          accountId: 'account:codex',
          name: 'ChatGPT subscription',
          kind: 'http',
          authType: 'subscription',
          endpointFormat: 'custom_endpoint',
          configured: true,
          models: ['gpt-5.6-luna'],
          selectedModel: 'gpt-5.6-luna'
        }]
      }, false)

      expect(controller.reasoningOptions()).toEqual(['low', 'medium', 'high', 'max'])
      expect(controller.state.reasoningEffort).toBe('high')
      expect(controller.cycleReasoningEffort()).toBe(true)
      expect(controller.state.reasoningEffort).toBe('max')
      await controller.submit('use the selected Codex effort')
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        providerId: 'codex',
        accountId: 'account:codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'max'
      }))
    } finally {
      await controller.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('opens the latest thread, projects external events, and steers a GUI-started turn', async () => {
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    const steerTurn = vi.fn(async () => ({ ok: true }))
    const client = {
      listThreads: vi.fn(async () => [detail()]),
      getThread: vi.fn(async () => detail()),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onEvent: (event: RuntimeEvent) => void
      }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      steerTurn,
      startTurn: vi.fn()
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    expect(controller.state).toMatchObject({ view: 'chat', projection: { thread: { id: 'thr_1' } } })

    onEvent?.({
      kind: 'turn_started',
      seq: 1,
      timestamp: '2026-07-22T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_gui',
      status: 'running'
    })
    await controller.submit('focus on tests')
    expect(steerTurn).toHaveBeenCalledWith('thr_1', 'turn_gui', 'focus on tests')
    await controller.stop()
  })

  it('returns to the welcome screen when another client deletes the active session', async () => {
    let onError: ((error: Error) => void) | undefined
    let threads = [detail()]
    const client = {
      listThreads: vi.fn(async () => threads),
      getThread: vi.fn(async () => detail()),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal; onError?: (error: Error) => void }) => {
        onError = input.onError
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      })
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    threads = []
    onError?.(new TuiClientError('gone', 410, 'gone'))
    await vi.waitFor(() => expect(controller.state.threads).toEqual([]))
    expect(controller.state.projection).toBeUndefined()
    expect(controller.state.notification?.message).toMatch(/removed by another client/i)
    await controller.stop()
  })

  it('refreshes authoritative state when another client wins an approval race', async () => {
    let onEvent: ((event: RuntimeEvent) => void) | undefined
    let detailCalls = 0
    const decideApproval = vi.fn(async () => {
      throw new TuiClientError('already resolved', 409, 'conflict')
    })
    const client = {
      listThreads: vi.fn(async () => [detail()]),
      getThread: vi.fn(async () => {
        detailCalls += 1
        return detail()
      }),
      subscribeThreadEvents: vi.fn(async (input: {
        signal: AbortSignal
        onEvent: (event: RuntimeEvent) => void
      }) => {
        onEvent = input.onEvent
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      decideApproval
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    onEvent?.({
      kind: 'approval_requested',
      seq: 1,
      timestamp: '2026-07-22T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      approvalId: 'appr_1',
      toolName: 'bash',
      status: 'pending',
      summary: 'Run tests'
    })
    expect(controller.state.projection?.pendingApproval?.approvalId).toBe('appr_1')

    await controller.decideApproval('allow')
    expect(detailCalls).toBeGreaterThanOrEqual(2)
    expect(controller.state.projection?.pendingApproval).toBeUndefined()
    await controller.stop()
  })

  it('creates a source-preserving undo fork before the latest user turn', async () => {
    const source = detail()
    source.turns = [{
      id: 'turn_first', threadId: source.id, status: 'completed', orchestration: 'direct', prompt: 'first', steering: [],
      createdAt: source.createdAt, attachmentIds: [], activeSkillIds: [],
      injectedMemoryIds: [], injectedMemorySummaries: [], injectedInstructionSources: [],
      items: [{
        id: 'item_user', turnId: 'turn_first', threadId: source.id, role: 'user',
        createdAt: source.createdAt, kind: 'user_message', status: 'completed', text: 'first'
      }]
    }]
    const branch = detail({ id: 'thr_undo', title: 'Shared undo', turns: [] })
    const forkThread = vi.fn(async () => branch)
    const client = {
      listThreads: vi.fn(async () => [source, branch]),
      getThread: vi.fn(async (id: string) => id === branch.id ? branch : source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      forkThread
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    await controller.undoLastTurn()

    expect(forkThread).toHaveBeenCalledWith('thr_1', {
      relation: 'fork', turnId: 'turn_first', beforeTurn: true, title: 'Shared undo'
    })
    expect(controller.state.projection?.thread.id).toBe('thr_undo')
    await controller.stop()
  })

  it('executes session lifecycle mutations through authoritative runtime routes', async () => {
    let threads = [detail()]
    const compactThread = vi.fn(async () => ({ ok: true }))
    const updateThread = vi.fn(async (id: string, patch: Partial<ThreadDetail>) => {
      const index = threads.findIndex((thread) => thread.id === id)
      const updated = { ...threads[index]!, ...patch, updatedAt: '2026-07-22T00:01:00.000Z' }
      threads[index] = updated
      return updated
    })
    const forkThread = vi.fn(async (id: string, input: { title?: string; relation: 'fork'; turnId?: string }) => {
      const source = threads.find((thread) => thread.id === id)!
      const branch = detail({
        id: 'thr_branch',
        title: input.title ?? `${source.title} fork`,
        parentThreadId: source.id,
        relation: 'fork',
        createdAt: '2026-07-22T00:02:00.000Z',
        updatedAt: '2026-07-22T00:02:00.000Z'
      })
      threads.push(branch)
      return branch
    })
    const deleteThread = vi.fn(async (id: string) => {
      threads = threads.filter((thread) => thread.id !== id)
      return { deleted: true }
    })
    const client = {
      listThreads: vi.fn(async () => threads.filter((thread) => thread.status !== 'archived')),
      getThread: vi.fn(async (id: string) => threads.find((thread) => thread.id === id)!),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      compactThread,
      updateThread,
      forkThread,
      deleteThread
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()

    await controller.toggleSelectedThreadPin()
    expect(updateThread).toHaveBeenCalledWith('thr_1', { pinned: true })

    await controller.compact()
    expect(compactThread).toHaveBeenCalledWith('thr_1')
    expect(controller.state.projection?.thread.id).toBe('thr_1')

    await controller.rename('Renamed session')
    expect(updateThread).toHaveBeenCalledWith('thr_1', { title: 'Renamed session', titleAuto: false })
    expect(controller.state.projection?.thread.title).toBe('Renamed session')

    await controller.forkAtTurn('turn_anchor', 'Review branch')
    expect(forkThread).toHaveBeenCalledWith('thr_1', {
      relation: 'fork', turnId: 'turn_anchor', title: 'Review branch'
    })
    expect(controller.state.projection?.thread.id).toBe('thr_branch')

    await controller.openThread('thr_1')
    await controller.redoBranch()
    expect(controller.state.projection?.thread.id).toBe('thr_branch')

    await controller.archive()
    expect(updateThread).toHaveBeenCalledWith('thr_branch', { status: 'archived' })
    expect(controller.state).toMatchObject({ view: 'threads', projection: undefined })
    expect(controller.state.threads.map((thread) => thread.id)).toEqual(['thr_1'])

    await controller.deleteSelectedThread()
    expect(deleteThread).toHaveBeenCalledWith('thr_1')
    expect(controller.state.threads).toEqual([])
    await controller.stop()
  })

  it('persists permissions, plan mode, and an additional workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-controller-'))
    const extra = await mkdtemp(join(tmpdir(), 'kun-tui-controller-extra-'))
    let current = detail({ workspace: root })
    const updateThread = vi.fn(async (_id: string, patch: Partial<ThreadDetail>) => {
      current = { ...current, ...patch }
      return current
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      updateThread
    } as unknown as KunTuiClient
    const controller = new TuiController(client, { ...options(), workspace: root }, runtime)
    try {
      await controller.start()
      await expect(controller.setPermissions('never', 'read-only')).resolves.toBe(true)
      await controller.setPlanMode('plan')
      await controller.addDirectory(extra)
      const canonicalExtra = await realpath(extra)
      expect(controller.state.projection?.thread).toMatchObject({
        approvalPolicy: 'never', sandboxMode: 'read-only', mode: 'plan', additionalWorkspaces: [canonicalExtra]
      })
      expect(updateThread).toHaveBeenCalledWith('thr_1', { additionalWorkspaces: [canonicalExtra] })
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
      await rm(extra, { recursive: true, force: true })
    }
  })

  it('activates a persistent goal as an agent turn and keeps it visible in the shared thread', async () => {
    let current = detail({ mode: 'plan' })
    const updateThread = vi.fn(async (_id: string, patch: Partial<ThreadDetail>) => {
      current = { ...current, ...patch }
      return current
    })
    const setThreadGoal = vi.fn(async (_id: string, request: { objective?: string; status?: string }) => {
      const now = '2026-07-22T00:00:01.000Z'
      current = {
        ...current,
        goal: {
          threadId: current.id,
          objective: request.objective ?? current.goal?.objective ?? '',
          status: request.status === 'active' ? 'active' : current.goal?.status ?? 'active',
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now
        }
      }
      return { goal: current.goal }
    })
    const startTurn = vi.fn(async () => ({ turnId: 'turn_goal' }))
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      updateThread,
      setThreadGoal,
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()

    await expect(controller.activateGoal('Ship the complete TUI')).resolves.toBe(true)
    expect(updateThread).toHaveBeenCalledWith(current.id, { mode: 'agent' })
    expect(setThreadGoal).toHaveBeenCalledWith(current.id, {
      objective: 'Ship the complete TUI',
      status: 'active'
    })
    expect(startTurn).toHaveBeenCalledWith(current.id, expect.objectContaining({
      prompt: 'Ship the complete TUI',
      mode: 'agent'
    }))
    expect(controller.state.projection?.thread.goal?.objective).toBe('Ship the complete TUI')
    expect(controller.state.projection?.runningTurnId).toBe('turn_goal')
    await controller.stop()
  })

  it('pauses an active goal when the user explicitly switches to Plan mode', async () => {
    const now = '2026-07-22T00:00:00.000Z'
    let current = detail({
      goal: {
        threadId: 'thr_1',
        objective: 'Finish everything',
        status: 'active',
        tokensUsed: 10,
        timeUsedSeconds: 5,
        createdAt: now,
        updatedAt: now
      }
    })
    const setThreadGoal = vi.fn(async (_id: string, request: { status?: string }) => {
      current = {
        ...current,
        goal: current.goal ? { ...current.goal, status: request.status === 'paused' ? 'paused' : current.goal.status } : undefined
      }
      return { goal: current.goal ?? null }
    })
    const updateThread = vi.fn(async (_id: string, patch: Partial<ThreadDetail>) => {
      current = { ...current, ...patch }
      return current
    })
    const client = {
      listThreads: vi.fn(async () => [current]),
      getThread: vi.fn(async () => current),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setThreadGoal,
      updateThread
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()

    await controller.setPlanMode('plan')
    expect(setThreadGoal).toHaveBeenCalledWith(current.id, { status: 'paused' })
    expect(updateThread).toHaveBeenCalledWith(current.id, { mode: 'plan' })
    expect(controller.state.projection?.thread).toMatchObject({
      mode: 'plan',
      goal: { status: 'paused' }
    })
    await controller.stop()
  })

  it('exposes runtime diagnostics and invokes workspace-visible skills through real turns', async () => {
    const source = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_skill' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      runtimeTools: vi.fn(async () => ({
        providers: [],
        mcpServers: [{
          id: 'git', enabled: true, transport: 'stdio', trustScope: 'workspace', available: true,
          status: 'connected', toolCount: 3, toolNames: ['diff', 'log', 'status']
        }]
      })),
      skills: vi.fn(async () => ({
        enabled: true, roots: [], validationErrors: [],
        skills: [{
          id: 'review', name: 'Review', version: '1', root: '/tmp/skill', source: 'project',
          legacy: false, allowedTools: [], description: 'Review code'
        }]
      })),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()

    await controller.showMcp()
    expect(controller.state.inspection?.lines).toEqual(expect.arrayContaining([
      'git: connected · 3 tools · stdio',
      '  Tools: diff, log, status'
    ]))
    controller.dismissInspection()
    await controller.invokeSkill('review', 'check the diff')
    expect(startTurn).toHaveBeenCalledWith('thr_1', expect.objectContaining({
      prompt: '/skill:review check the diff'
    }))
    await controller.stop()
  })

  it('aggregates plan, goal, task, context, and queue state from shared runtime APIs', async () => {
    const source = detail()
    source.status = 'running'
    source.turns = [{
      id: 'turn_queued', threadId: source.id, status: 'running', orchestration: 'direct', prompt: 'work', steering: ['check packaging'],
      createdAt: source.createdAt, items: [], attachmentIds: [], activeSkillIds: [],
      injectedMemoryIds: [], injectedMemorySummaries: [], injectedInstructionSources: []
    }]
    const todo = {
      id: 'todo_1', content: 'Ship tests', status: 'in_progress' as const,
      createdAt: source.createdAt, updatedAt: source.updatedAt
    }
    const setThreadGoal = vi.fn(async () => ({ goal: null }))
    const steerTurn = vi.fn(async () => ({ ok: true }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      threadTodos: vi.fn(async () => ({
        todos: { threadId: source.id, items: [todo], updatedAt: source.updatedAt }
      })),
      threadGoal: vi.fn(async () => ({ goal: {
        threadId: source.id, objective: 'Ship all P0/P1 commands', status: 'active',
        tokensUsed: 10, timeUsedSeconds: 5, createdAt: source.createdAt, updatedAt: source.updatedAt
      } })),
      setThreadGoal,
      steerTurn,
      steeringQueue: vi.fn(async () => ({
        threadId: source.id,
        turnId: 'turn_queued',
        entries: [{ id: 'steer_1', text: 'check packaging', queuedAt: source.updatedAt }]
      })),
      delegationDiagnostics: vi.fn(async () => ({
        enabled: true, active: 1, childRuns: [{
          id: 'child_1', parentThreadId: source.id, parentTurnId: 'turn_1', prompt: 'Review',
          status: 'running', createdAt: source.createdAt, updatedAt: source.updatedAt
        }], aggregates: []
      })),
      backgroundShells: vi.fn(async () => ({
        threadId: source.id, running: 1, sessions: [{
          id: 'shell_1', threadId: source.id, turnId: 'turn_1', command: 'npm test', cwd: source.workspace,
          shell: 'sh', status: 'running', startedAt: source.createdAt, detached: true, output: ''
        }]
      })),
      runtimeTools: vi.fn(async () => ({
        providers: [], mcpServers: [], extensions: { jobs: {
          activeCount: 1, subscriptionCount: 0, recent: [{
            jobId: 'job_1', ownerExtensionId: 'ext', kind: 'task', state: 'running',
            executionAttempt: 1, action: 'sync'
          }]
        } }
      })),
      usage: vi.fn(async () => ({ buckets: [{
        thread_id: source.id, input_tokens: 100, output_tokens: 20, reasoning_tokens: 5,
        cached_tokens: 50, total_tokens: 125, turns: 2
      }] }))
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()

    await controller.showPlan()
    expect(controller.state.inspection?.lines).toContain('1. [in_progress] Ship tests')
    controller.dismissInspection()
    await controller.showTasks()
    expect(controller.state.inspection?.lines).toEqual(expect.arrayContaining([
      'Subagents: 1 active / 1 total',
      'Background shells: 1 active / 1 total',
      'Goal: active · Ship all P0/P1 commands',
      'Extension jobs: 1 active / 1 recent'
    ]))
    controller.dismissInspection()
    await controller.showContext()
    expect(controller.state.inspection?.lines).toContain(
      'Latest request: no request-local context snapshot yet'
    )
    expect(controller.state.inspection?.lines).toContain(
      'Cumulative usage (not context occupancy):'
    )
    expect(controller.state.inspection?.lines).toContain('Total: 125 tokens')
    controller.dismissInspection()
    await controller.showQueue()
    expect(controller.state.inspection?.lines).toContain('1. check packaging')
    await controller.manageGoal('Ship the TUI')
    expect(setThreadGoal).toHaveBeenCalledWith(source.id, { objective: 'Ship the TUI', status: 'active' })
    expect(steerTurn).toHaveBeenCalledWith(source.id, 'turn_queued', 'Ship the TUI')
    await controller.stop()
  })

  it('runs /init guidance as a normal authoritative turn', async () => {
    const source = detail()
    const startTurn = vi.fn(async () => ({ turnId: 'turn_init' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    await controller.initializeWorkspace('Use the repository package manager.')

    expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
      prompt: expect.stringMatching(/create or update.*AGENTS\.md[\s\S]*Use the repository package manager\./i)
    }))
    await controller.stop()
  })

  it('starts by-the-way questions in an isolated side thread', async () => {
    const source = detail()
    const side = detail({ id: 'thr_side', title: 'Shared · side', relation: 'side', parentThreadId: source.id })
    const forkThread = vi.fn(async () => side)
    const startTurn = vi.fn(async () => ({ turnId: 'turn_side' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async (id: string) => id === side.id ? side : source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      forkThread,
      startTurn
    } as unknown as KunTuiClient
    const controller = new TuiController(client, options(), runtime)
    await controller.start()
    await controller.askSideQuestion('What does this API do?')

    expect(forkThread).toHaveBeenCalledWith(source.id, { relation: 'side', title: 'Shared · side' })
    expect(startTurn).toHaveBeenCalledWith(side.id, expect.objectContaining({
      prompt: 'What does this API do?',
      clientSurface: 'tui'
    }))
    expect(controller.state.projection?.thread.id).toBe(side.id)
    await controller.stop()
  })

  it('hot-enables local attachment storage and sends uploaded files with the next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-attachment-'))
    const file = join(root, 'notes.txt')
    await writeFile(file, 'hello')
    const source = detail({ workspace: root })
    const setLocalCapabilityEnabled = vi.fn(async () => ({ id: 'attachments' as const, enabled: true }))
    const uploadAttachment = vi.fn(async () => ({
      attachment: {
        id: 'attachment_1',
        name: 'notes.txt',
        kind: 'document' as const,
        mimeType: 'text/plain',
        byteSize: 5,
        hash: 'hash',
        localFilePath: file,
        threadIds: [source.id],
        workspaces: [root],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      }
    }))
    const startTurn = vi.fn(async () => ({ turnId: 'turn_attachment' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setLocalCapabilityEnabled,
      uploadAttachment,
      startTurn
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, attachmentRuntime)
    try {
      await controller.start()
      await controller.manageAttachments(file)
      expect(setLocalCapabilityEnabled).toHaveBeenCalledWith('attachments', true)
      expect(controller.state.pendingAttachments).toHaveLength(1)
      await controller.submit('read this')
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        prompt: 'read this',
        attachmentIds: ['attachment_1']
      }))
      expect(controller.state.pendingAttachments).toEqual([])
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds distinct @file mentions to attachment IDs without rewriting the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-file-mention-'))
    const notes = join(root, 'notes.txt')
    const design = join(root, 'design notes.md')
    await writeFile(notes, 'notes')
    await writeFile(design, '# design')
    const source = detail({ workspace: root })
    const uploadAttachment = vi.fn(async (input: {
      name: string
      mimeType: string
      localFilePath?: string
      dataBase64: string
    }) => ({
      attachment: {
        id: `attachment_${input.name}`,
        name: input.name,
        kind: 'document' as const,
        mimeType: input.mimeType,
        byteSize: Buffer.from(input.dataBase64, 'base64').length,
        hash: `hash_${input.name}`,
        localFilePath: input.localFilePath,
        threadIds: [source.id],
        workspaces: [root],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      }
    }))
    const startTurn = vi.fn(async () => ({ turnId: 'turn_mentions' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setLocalCapabilityEnabled: vi.fn(async () => ({ id: 'attachments' as const, enabled: true })),
      uploadAttachment,
      startTurn
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, attachmentRuntime)
    const prompt = 'Compare @notes.txt with @"design notes.md", then re-check @notes.txt'
    try {
      await controller.start()
      await expect(controller.prepareFileMentions(prompt)).resolves.toBe(true)
      expect(uploadAttachment).toHaveBeenCalledTimes(2)
      expect(controller.state.pendingAttachments.map((attachment) => attachment.name)).toEqual([
        'notes.txt',
        'design notes.md'
      ])

      await controller.submit(prompt)
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        prompt,
        attachmentIds: ['attachment_notes.txt', 'attachment_design notes.md']
      }))
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rolls back staged mention leases and preserves existing pending attachments on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-file-mention-rollback-'))
    const existing = join(root, 'existing.txt')
    const staged = join(root, 'staged.txt')
    const unsupported = join(root, 'unsupported.bin')
    await writeFile(existing, 'existing')
    await writeFile(staged, 'staged')
    await writeFile(unsupported, Buffer.from([0, 1, 2, 3]))
    const source = detail({ workspace: root })
    const uploadAttachment = vi.fn(async (input: {
      name: string
      mimeType: string
      localFilePath?: string
      dataBase64: string
    }) => ({
      attachment: {
        id: `attachment_${input.name}`,
        name: input.name,
        kind: 'document' as const,
        mimeType: input.mimeType,
        byteSize: Buffer.from(input.dataBase64, 'base64').length,
        hash: `hash_${input.name}`,
        localFilePath: input.localFilePath,
        threadIds: [source.id],
        workspaces: [root],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      }
    }))
    const releaseAttachment = vi.fn(async () => ({ released: true }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setLocalCapabilityEnabled: vi.fn(async () => ({ id: 'attachments' as const, enabled: true })),
      uploadAttachment,
      releaseAttachment
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, attachmentRuntime)
    try {
      await controller.start()
      await controller.manageAttachments(existing)
      expect(controller.state.pendingAttachments.map((attachment) => attachment.name)).toEqual(['existing.txt'])

      await expect(controller.prepareFileMentions(
        'Use @staged.txt and @unsupported.bin'
      )).resolves.toBe(false)
      expect(controller.state.pendingAttachments.map((attachment) => attachment.name)).toEqual(['existing.txt'])
      expect(releaseAttachment).toHaveBeenCalledWith(
        'attachment_staged.txt',
        expect.stringMatching(/^tui_/u)
      )
      expect(controller.state.notification?.message).toContain('unsupported attachment type')
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an @file symlink whose canonical target is outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-file-mention-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'kun-tui-file-mention-outside-'))
    const target = join(outside, 'secret.txt')
    await writeFile(target, 'secret')
    await symlink(target, join(root, 'escape.txt'))
    const source = detail({ workspace: root })
    const uploadAttachment = vi.fn()
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      uploadAttachment
    } as unknown as KunTuiClient
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, runtime)
    try {
      await controller.start()
      await expect(controller.prepareFileMentions('Read @escape.txt')).resolves.toBe(false)
      expect(uploadAttachment).not.toHaveBeenCalled()
      expect(controller.state.notification?.message).toContain('outside the active workspace')
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('uploads a system clipboard image without requiring a local file path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-clipboard-image-'))
    const source = detail({ workspace: root })
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52
    ])
    const setLocalCapabilityEnabled = vi.fn(async () => ({ id: 'attachments' as const, enabled: true }))
    const uploadAttachment = vi.fn(async (input: {
      name: string
      mimeType?: string
      dataBase64?: string
      localFilePath?: string
    }) => ({
      attachment: {
        id: 'attachment_clipboard',
        name: input.name,
        kind: 'image' as const,
        mimeType: input.mimeType ?? 'image/png',
        byteSize: bytes.length,
        hash: 'clipboard-hash',
        threadIds: [source.id],
        workspaces: [root],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      }
    }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setLocalCapabilityEnabled,
      uploadAttachment
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('model-a')
        })
      }
    } as TuiConnection
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, attachmentRuntime)
    try {
      await controller.start()
      expect(await controller.attachClipboardImage({
        bytes,
        mimeType: 'image/png',
        source: 'macos'
      })).toBe(true)
      expect(setLocalCapabilityEnabled).toHaveBeenCalledWith('attachments', true)
      expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
        name: expect.stringMatching(/^clipboard-\d{14}\.png$/u),
        mimeType: 'image/png',
        dataBase64: bytes.toString('base64'),
        threadId: source.id,
        workspace: root
      }))
      expect(uploadAttachment.mock.calls[0]?.[0]).not.toHaveProperty('localFilePath')
      expect(controller.state.pendingAttachments).toHaveLength(1)
      expect(controller.state.notification?.message).toContain('Pasted clipboard image')
      expect(controller.removeLastPendingAttachment()).toBe(true)
      expect(controller.state.pendingAttachments).toEqual([])
      expect(controller.state.notification?.message).toContain('Removed clipboard-')
      expect(controller.removeLastPendingAttachment()).toBe(false)

      expect(await controller.attachClipboardImage({
        bytes,
        mimeType: 'image/png',
        source: 'macos'
      })).toBe(true)
      expect(controller.clearPendingAttachments()).toBe(true)
      expect(controller.state.pendingAttachments).toEqual([])
      expect(controller.state.notification?.message).toBe('Pending attachments cleared.')
      expect(controller.clearPendingAttachments()).toBe(false)
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('turns a pasted image path into a queued attachment and keeps it when the model is text-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-pasted-image-'))
    const file = join(root, 'screen shot.png')
    await writeFile(file, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1
    ]))
    const source = detail({ workspace: root, model: 'text-only', providerId: 'custom' })
    const setLocalCapabilityEnabled = vi.fn(async () => ({ id: 'attachments' as const, enabled: true }))
    const uploadAttachment = vi.fn(async (input: { name: string; mimeType?: string; localFilePath?: string }) => ({
      attachment: {
        id: 'attachment_image',
        name: input.name,
        kind: 'image' as const,
        mimeType: input.mimeType ?? 'image/png',
        byteSize: 24,
        hash: 'image-hash',
        localFilePath: input.localFilePath,
        threadIds: [source.id],
        workspaces: [root],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      }
    }))
    const startTurn = vi.fn(async () => ({ turnId: 'turn_image' }))
    const client = {
      listThreads: vi.fn(async () => [source]),
      getThread: vi.fn(async () => source),
      subscribeThreadEvents: vi.fn(async (input: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      }),
      setLocalCapabilityEnabled,
      uploadAttachment,
      startTurn
    } as unknown as KunTuiClient
    const attachmentRuntime = {
      ...runtime,
      runtimeInfo: {
        ...runtime.runtimeInfo,
        capabilities: buildRuntimeCapabilityManifest({
          model: modelCapabilitiesForModel('text-only')
        })
      }
    } as TuiConnection
    const textOnly: ModelConnectionSnapshot = {
      schemaVersion: 1,
      revision: 1,
      providers: [{
        id: 'custom',
        accountId: 'account:custom',
        name: 'Custom',
        kind: 'http',
        authType: 'api-key',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['text-only'],
        selectedModel: 'text-only',
        modelCapabilities: {
          'text-only': {
            id: 'text-only',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text']
          }
        }
      }],
      defaultProviderId: 'custom',
      defaultAccountId: 'account:custom',
      defaultModel: 'text-only',
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    }
    const controller = new TuiController(client, {
      ...options(),
      dataDir: join(root, 'data'),
      workspace: root
    }, attachmentRuntime)
    try {
      await controller.start()
      controller.applyModelSelection(textOnly, false)
      expect(await controller.attachPastedPaths(`'${file}'`)).toBe(true)
      expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
        name: 'screen shot.png',
        mimeType: 'image/png',
        localFilePath: await realpath(file)
      }))
      expect(controller.state.pendingAttachments).toHaveLength(1)
      expect(controller.validatePendingAttachmentsForCurrentModel()).toBe(false)
      expect(controller.state.notification?.message).toContain('does not support image input')
      expect(controller.state.notification?.message).toContain('still attached')
      expect(controller.state.pendingAttachments).toHaveLength(1)

      controller.applyModelSelection({
        ...textOnly,
        revision: 2,
        providers: [{
          ...textOnly.providers[0]!,
          models: ['vision'],
          selectedModel: 'vision',
          modelCapabilities: {
            vision: {
              id: 'vision',
              inputModalities: ['text', 'image'],
              outputModalities: ['text'],
              supportsToolCalling: true,
              messageParts: ['text', 'image_url']
            }
          }
        }],
        defaultModel: 'vision'
      }, false)
      // Registry events update the shared default for future sessions. The
      // current session changes only after an explicit model choice.
      controller.options.model = 'vision'
      expect(controller.validatePendingAttachmentsForCurrentModel()).toBe(true)
      await controller.submit('What is in this screenshot?')
      expect(startTurn).toHaveBeenCalledWith(source.id, expect.objectContaining({
        prompt: 'What is in this screenshot?',
        model: 'vision',
        attachmentIds: ['attachment_image']
      }))
      expect(controller.state.pendingAttachments).toEqual([])
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps ordinary text and unsupported video paths in the composer paste flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-pasted-video-'))
    const video = join(root, 'demo clip.mp4')
    await writeFile(video, 'not-a-real-video')
    const controller = new TuiController({} as KunTuiClient, {
      ...options(),
      workspace: root
    }, runtime)
    try {
      expect(await controller.attachPastedPaths('please inspect /tmp/example.png')).toBe(false)
      expect(await controller.attachPastedPaths(`'${video}'`)).toBe(false)
      expect(controller.state.notification?.message).toContain('does not support video input yet')
      expect(controller.state.notification?.message).toContain('kept in the composer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
