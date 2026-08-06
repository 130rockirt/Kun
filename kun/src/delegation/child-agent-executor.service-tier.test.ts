import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { LocalToolHost, echoTool } from '../adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { createChildAgentExecutor } from './child-agent-executor.js'

const PRIORITY_CAPABILITIES: ModelCapabilityMetadata = {
  id: 'gpt-5.4',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  contextWindowTokens: 128_000,
  messageParts: ['text'],
  serviceTiers: ['priority']
}

const PLAIN_CAPABILITIES: ModelCapabilityMetadata = {
  id: 'deepseek-v4-pro',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  contextWindowTokens: 128_000,
  messageParts: ['text']
}

class RecordingModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'child-model'
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: 'child answer' }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('child executor service tier', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function runChild(serviceTier: 'priority' | undefined, capabilities: ModelCapabilityMetadata) {
    dir = await mkdtemp(join(tmpdir(), 'child-tier-'))
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
    const model = new RecordingModel()
    const executor = createChildAgentExecutor({
      model,
      toolHost: new LocalToolHost({ tools: [echoTool] }),
      prefix: createImmutablePrefix({ systemPrompt: 'test system prompt' }),
      defaultModel: model.model,
      approvalPolicy: 'auto',
      approvalGate: new InMemoryApprovalGate(),
      modelCapabilities: () => capabilities,
      sessionStore,
      threadStore,
      events,
      nowIso
    })
    await executor({
      childId: 'child_tier',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'explore the repo',
      workspace: '/workspace',
      model: capabilities.id,
      providerId: 'codex-2',
      toolPolicy: 'inherit',
      ...(serviceTier ? { serviceTier } : {}),
      signal: new AbortController().signal
    })
    return model
  }

  it('forwards priority to the child model request when the model advertises priority', async () => {
    const model = await runChild('priority', PRIORITY_CAPABILITIES)
    expect(model.requests[0]?.serviceTier).toBe('priority')
  })

  it('never attaches the tier when the routed model lacks priority support', async () => {
    const model = await runChild('priority', PLAIN_CAPABILITIES)
    expect(model.requests[0]?.serviceTier).toBeUndefined()
  })

  it('leaves the tier unset when the tool did not request it', async () => {
    const model = await runChild(undefined, PRIORITY_CAPABILITIES)
    expect(model.requests[0]?.serviceTier).toBeUndefined()
  })
})
