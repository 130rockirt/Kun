import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { LocalToolHost, echoTool } from '../adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { makeAssistantTextItem } from '../domain/item.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { createChildAgentExecutor } from './child-agent-executor.js'
import { DelegationRuntime, FileDelegationStore, type ChildRunExecutor } from './delegation-runtime.js'

class AbortAwareModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'abort-aware-child-model'
  readonly requests: ModelRequest[] = []
  abortObserved = false
  private readonly streamStartedListeners: Array<() => void> = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    yield* [] as ModelStreamChunk[]
    this.requests.push(request)
    for (const listener of this.streamStartedListeners.splice(0)) listener()
    if (!request.abortSignal.aborted) {
      await new Promise<void>((resolve) => {
        request.abortSignal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    this.abortObserved = request.abortSignal.aborted
  }

  waitForStreamStart(): Promise<void> {
    if (this.requests.length > 0) return Promise.resolve()
    return new Promise((resolve) => this.streamStartedListeners.push(resolve))
  }
}

class ApprovalToolModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'approval-child-model'
  requests = 0

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests += 1
    if (this.requests === 1) {
      yield {
        kind: 'tool_call_complete',
        callId: 'call_echo',
        toolName: 'echo',
        arguments: { text: 'approved child work' }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'child completed after approval' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

class PptExportModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'ppt-export-child-model'
  requests = 0

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests += 1
    if (this.requests === 1) {
      yield {
        kind: 'tool_call_complete',
        callId: 'call_export',
        toolName: 'ppt_export',
        arguments: { input: 'deck.pptd', output: 'deck.pptx' }
      }
      yield { kind: 'completed', stopReason: 'tool_calls' }
      return
    }
    yield { kind: 'assistant_text_delta', text: 'validated deck ready' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('createChildAgentExecutor', () => {
  it('aborts the child model stream when the parent delegation signal is aborted', async () => {
    const sessionStore = new InMemorySessionStore()
    const threadStore = new InMemoryThreadStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-07-08T00:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const model = new AbortAwareModel()
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ tools: [] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: model.model,
      approvalPolicy: 'auto',
      sessionStore,
      threadStore,
      events,
      nowIso
    })
    const parent = new AbortController()
    const run = executor({
      childId: 'child_abort',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'keep streaming until interrupted',
      workspace: '/tmp/workspace',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      toolPolicy: 'readOnly',
      signal: parent.signal
    })

    await model.waitForStreamStart()
    parent.abort()
    const result = await Promise.race([
      run.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 500))
    ])

    expect(result).toBe('rejected')
    expect(model.abortObserved).toBe(true)
    expect(model.requests[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      providerId: 'deepseek'
    })
    expect((await threadStore.get('child_abort'))?.status).toBe('idle')
    expect((await threadStore.get('child_abort'))?.turns[0]?.status).toBe('aborted')
  })

  it('registers child approvals on the runtime-owned gate and continues after a decision', async () => {
    const approvalGate = new InMemoryApprovalGate()
    const model = new ApprovalToolModel()
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ tools: [echoTool] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: model.model,
      approvalPolicy: 'always',
      approvalGate
    })
    const run = executor({
      childId: 'child_approval',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'use echo',
      workspace: '/tmp/workspace',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })

    await waitFor(() => expect(approvalGate.pending('child_approval')).toHaveLength(1))
    const pending = approvalGate.pending('child_approval')[0]
    expect(pending).toMatchObject({
      threadId: 'child_approval',
      toolName: 'echo',
      status: 'pending'
    })
    expect(approvalGate.decide(pending.id, 'allow')).toBe(true)

    await expect(run).resolves.toMatchObject({
      summary: 'child completed after approval',
      toolInvocations: 1
    })
    expect(approvalGate.get(pending.id)?.status).toBe('allowed')
  })

  it('returns the validated ppt_export result as a structured deck artifact', async () => {
    const pptExport = LocalToolHost.defineTool({
      name: 'ppt_export',
      description: 'test exporter',
      toolKind: 'file_change',
      policy: 'auto',
      sideEffect: 'unknown',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      execute: async () => ({
        output: {
          output: 'deck.pptx',
          absolutePath: '/tmp/workspace/deck.pptx',
          slides: 1,
          editableSlides: 1,
          validated: true
        }
      })
    })
    const executor = createChildAgentExecutor({
      model: new PptExportModel(),
      toolHost: new LocalToolHost({ tools: [pptExport] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: 'ppt-export-child-model',
      approvalPolicy: 'auto'
    })

    await expect(executor({
      childId: 'child_ppt_export',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'export the deck',
      workspace: '/tmp/workspace',
      toolPolicy: 'inherit',
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      summary: 'validated deck ready',
      deckArtifact: {
        output: 'deck.pptx',
        slides: 1,
        editableSlides: 1,
        validated: true
      }
    })
  })

  it('expires a shared child approval when the parent aborts', async () => {
    const approvalGate = new InMemoryApprovalGate()
    const executor = createChildAgentExecutor({
      model: new ApprovalToolModel(),
      toolHost: new LocalToolHost({ tools: [echoTool] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: 'approval-child-model',
      approvalPolicy: 'always',
      approvalGate
    })
    const parent = new AbortController()
    const run = executor({
      childId: 'child_approval_abort',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'use echo',
      workspace: '/tmp/workspace',
      toolPolicy: 'inherit',
      signal: parent.signal
    })

    await waitFor(() => expect(approvalGate.pending('child_approval_abort')).toHaveLength(1))
    const pending = approvalGate.pending('child_approval_abort')[0]
    parent.abort()

    await expect(run).rejects.toThrow(/aborted/)
    expect(approvalGate.get(pending.id)).toMatchObject({
      status: 'expired',
      reason: 'turn aborted while awaiting approval'
    })
  })

  it('dispatches provider-native children through the host runtime factory with the narrowed boundary', async () => {
    let nativeModelCalled = false
    let capturedBoundary:
      | Parameters<NonNullable<
          Parameters<typeof createChildAgentExecutor>[0]['createDelegatedRuntime']
        >>[0]
      | undefined
    const executor = createChildAgentExecutor({
      model: {
        provider: 'http',
        model: 'http-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          nativeModelCalled = true
          if (nativeModelCalled) {
            throw new Error('HTTP model must not own a subscription child')
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      toolHost: new LocalToolHost({ tools: [] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: 'http-model',
      createDelegatedRuntime: (boundary) => {
        capturedBoundary = boundary
        return {
          handlesProvider: (providerId) => providerId === 'claude-subscription',
          capabilities: (providerId) => providerId === 'claude-subscription'
            ? {
                nativeResume: true,
                structuredStreaming: true,
                kunTools: true,
                externalApproval: true,
                liveSteering: true,
                nativeContextTelemetry: true,
                fork: true
              }
            : undefined,
          runTurn: async (threadId, turnId) => {
            await boundary.turns.applyItem(
              threadId,
              makeAssistantTextItem({
                id: 'item_subscription',
                threadId,
                turnId,
                text: 'subscription child completed',
                status: 'completed'
              })
            )
            await boundary.turns.finishTurn({ threadId, turnId, status: 'completed' })
            return 'completed'
          }
        }
      }
    })

    await expect(executor({
      childId: 'child_subscription',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'inspect safely',
      workspace: '/tmp/workspace',
      model: 'claude-sonnet-4-5',
      providerId: 'claude-subscription',
      toolPolicy: 'readOnly',
      allowedTools: ['read', 'bash'],
      blockedTools: ['grep'],
      blockedMcpServers: ['private'],
      blockedSkills: ['unsafe-skill'],
      skillsEnabled: false,
      security: {
        sandboxRoot: '/tmp/workspace',
        allowedToolNames: ['read', 'web_search'],
        allowedProviderIds: ['builtin'],
        allowedSkillIds: ['safe-skill'],
        blockedToolNames: ['write'],
        blockedProviderIds: ['mcp:blocked'],
        blockedSkillIds: ['parent-blocked'],
        memoryEnabled: false
      },
      signal: new AbortController().signal
    })).resolves.toMatchObject({ summary: 'subscription child completed' })

    expect(nativeModelCalled).toBe(false)
    expect(capturedBoundary).toMatchObject({
      toolPolicy: 'readOnly',
      allowedToolNames: ['read'],
      allowedProviderIds: ['builtin'],
      allowedSkillIds: ['safe-skill'],
      blockedToolNames: ['write', 'grep'],
      blockedProviderIds: ['mcp:blocked', 'mcp:private'],
      blockedSkillIds: ['parent-blocked', 'unsafe-skill'],
      skillsEnabled: false,
      memoryEnabled: false
    })
  })
})

describe('DelegationRuntime detached children', () => {
  it('keeps a background child running when the parent signal is aborted', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kun-delegation-'))
    try {
      let childSignal: AbortSignal | undefined
      let resolveStarted: () => void = () => {}
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const executor: ChildRunExecutor = async (input) => {
        childSignal = input.signal
        resolveStarted()
        if (!input.signal.aborted) {
          await new Promise<void>((abortResolve) => {
            input.signal.addEventListener('abort', () => abortResolve(), { once: true })
          })
        }
        throw new Error('child aborted')
      }
      const runtime = new DelegationRuntime({
        config: {
          enabled: true,
          useExistingAgents: true,
          maxParallel: 1,
          defaultToolPolicy: 'readOnly',
          profiles: {}
        },
        store: new FileDelegationStore(tempDir),
        idGenerator: () => 'child_detached',
        nowIso: () => '2026-07-08T00:00:00.000Z',
        executor
      })
      const parent = new AbortController()

      const queued = await runtime.runChild({
        parentThreadId: 'thr_parent',
        parentTurnId: 'turn_parent',
        prompt: 'background work',
        detach: true,
        signal: parent.signal
      })
      expect(queued.status).toBe('queued')
      await started

      parent.abort()
      await delay(20)
      expect(childSignal?.aborted).toBe(false)
      expect((await runtime.diagnostics('thr_parent')).childRuns[0]?.status).toBe('running')

      expect(runtime.abortChild('child_detached')).toBe(true)
      await waitFor(async () => {
        const status = (await runtime.diagnostics('thr_parent')).childRuns[0]?.status
        expect(status).toBe('aborted')
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 500
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await delay(10)
    }
  }
  if (lastError) throw lastError
}
