import { mkdtemp } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  ModelProviderAdapter,
  ModelProviderRequest,
  ModelProviderStreamEvent
} from '@kun/extension-api'

import { makeUserItem } from '../../src/domain/item.js'

import type { ExtensionPrincipal } from '../../src/services/extension-agent-service.js'

import {
  ExtensionProviderAccountStore,
  extensionProviderId
} from '../../src/services/extension-provider-account-store.js'

import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'

import {
  ExtensionModelProviderRegistry,
  type ExtensionModelProviderRegistryOptions
} from '../../src/adapters/model/extension-model-provider.js'

async function harness(
  adapter: ModelProviderAdapter,
  limits: Omit<ExtensionModelProviderRegistryOptions, 'accounts'> = {}
) {
  const store = new ExtensionProviderAccountStore({
    dataDir: await mkdtemp(join(tmpdir(), 'kun-extension-model-')),
    nowIso: () => '2026-07-11T00:00:00.000Z'
  })
  const owner = principal()
  const provider = await store.registerProvider(owner, {
    id: 'custom',
    displayName: 'Custom Provider',
    authTypes: ['api-key'],
    apiKey: { headerName: 'authorization', prefix: 'Bearer ' },
    capabilities: {
      streaming: true,
      toolCalls: true,
      reasoning: true,
      images: true,
      documents: true,
      tokenCounting: true
    }
  })
  const account = await store.createAccount({
    principal: owner,
    providerId: provider.id,
    label: 'Primary',
    authType: 'api-key',
    credentialRef: 'cred_test'
  })
  const registry = new ExtensionModelProviderRegistry({ accounts: store, ...limits })
  const registration = await registry.register(owner, {
    id: 'custom',
    displayName: 'Custom Provider',
    adapterApiVersion: '1.0.0',
    models: [{
      id: 'custom-model',
      displayName: 'Custom Model',
      capabilities: {
        input: ['text', 'image', 'file'],
        output: ['text'],
        reasoning: true,
        tools: true,
        parallelTools: true,
        streaming: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 8_192
      }
    }]
  }, adapter)
  return { registry, registration, store, owner, provider, account }
}

function principal(): ExtensionPrincipal {
  const providerId = extensionProviderId('com.example.provider', 'custom')
  return {
    extensionId: 'com.example.provider',
    extensionVersion: '1.0.0',
    permissions: [
      'providers.register',
      'accounts.read',
      `accounts.manage:${providerId}`,
      `accounts.use:${providerId}`
    ],
    workspaceRoots: ['/tmp/workspace'],
    workspaceTrusted: true
  }
}

function request(
  providerId: string,
  accountId: string,
  signal = new AbortController().signal,
  overrides: Partial<ModelRequest> = {}
): ModelRequest {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    model: 'custom-model',
    providerId,
    accountId,
    systemPrompt: 'Kun stable system prompt',
    contextInstructions: ['Extension profile overlay'],
    prefix: [],
    history: [makeUserItem({
      id: 'user_1', threadId: 'thread_1', turnId: 'turn_1', text: 'Hello custom provider'
    })],
    attachments: [{
      id: 'image_1', name: 'image.png', mimeType: 'image/png', dataBase64: 'aGVsbG8='
    }],
    tools: [{
      name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} }
    }],
    reasoningEffort: 'high',
    abortSignal: signal,
    ...overrides
  }
}

async function collect(source: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

function throwingStream(message: string): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(new Error(message))
      }
    }
  }
}

describe('ExtensionModelProviderRegistry', () => {

it('rejects excessive pending tool calls before waiting for a terminal event', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'toolCallDelta',
          callId: 'call_1',
          nameDelta: 'read',
          argumentsDelta: '{}'
        }
        yield {
          requestId: input.requestId,
          sequence: 1,
          type: 'toolCallDelta',
          callId: 'call_2',
          nameDelta: 'read',
          argumentsDelta: '{}'
        }
      },
      cancel
    }
    const h = await harness(adapter, { maxPendingToolCallsPerRequest: 1 })
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toEqual([
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/pending tool-call limit exceeded/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('rejects cumulative pending tool arguments before terminal buffering can grow', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'toolCallDelta',
          callId: 'call_1',
          nameDelta: 'read',
          argumentsDelta: 'a'.repeat(700)
        }
        yield {
          requestId: input.requestId,
          sequence: 1,
          type: 'toolCallDelta',
          callId: 'call_2',
          nameDelta: 'read',
          argumentsDelta: 'b'.repeat(700)
        }
      },
      cancel
    }
    const h = await harness(adapter, {
      maxEventBytes: 2_048,
      maxTotalBytesPerRequest: 8_192,
      maxToolArgumentBytes: 2_048,
      maxTotalPendingToolArgumentBytesPerRequest: 1_100
    })
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toEqual([
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/total pending tool-argument byte limit exceeded/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('rejects completed tool calls beyond the native-equivalent per-response ceiling', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'toolCallComplete',
          callId: 'call_1',
          name: 'read',
          input: { path: '/tmp/a' }
        }
        yield {
          requestId: input.requestId,
          sequence: 1,
          type: 'toolCallComplete',
          callId: 'call_2',
          name: 'read',
          input: { path: '/tmp/b' }
        }
        yield {
          requestId: input.requestId,
          sequence: 2,
          type: 'completed',
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 }
        }
      },
      cancel
    }
    const h = await harness(adapter, { maxCompletedToolCallsPerRequest: 1 })
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toEqual([
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/completed tool-call limit exceeded/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('assembles interleaved tool-call fragments in first-seen order and validates advertised schemas', async () => {
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'toolCallDelta',
          callId: 'call_b',
          nameDelta: 'read',
          argumentsDelta: '{"path":'
        }
        yield {
          requestId: input.requestId,
          sequence: 1,
          type: 'toolCallDelta',
          callId: 'call_a',
          nameDelta: 'read',
          argumentsDelta: '{"path":'
        }
        yield {
          requestId: input.requestId,
          sequence: 2,
          type: 'toolCallDelta',
          callId: 'call_b',
          argumentsDelta: '"/b"}'
        }
        yield {
          requestId: input.requestId,
          sequence: 3,
          type: 'toolCallDelta',
          callId: 'call_a',
          argumentsDelta: '"/a"}'
        }
        yield {
          requestId: input.requestId,
          sequence: 4,
          type: 'completed',
          finishReason: 'tool_calls',
          usage: { inputTokens: 2, outputTokens: 1 }
        }
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const modelRequest = request(h.provider.id, h.account.id)
    modelRequest.tools = [{
      name: 'read',
      description: 'Read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }]
    const chunks = await collect(h.registry.clientMap().get(h.provider.id)!.stream(modelRequest))

    expect(chunks).toEqual([
      { kind: 'tool_call_complete', callId: 'call_b', toolName: 'read', arguments: { path: '/b' } },
      { kind: 'tool_call_complete', callId: 'call_a', toolName: 'read', arguments: { path: '/a' } },
      expect.objectContaining({ kind: 'usage' }),
      { kind: 'completed', stopReason: 'tool_calls' }
    ])
  })

it('rejects invalid or unadvertised completed tool calls before yielding tool history', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'toolCallComplete',
          callId: 'call_invalid',
          name: 'read',
          input: { path: 42 }
        }
        yield {
          requestId: input.requestId,
          sequence: 1,
          type: 'completed',
          finishReason: 'tool_calls',
          usage: { inputTokens: 1 }
        }
      },
      cancel
    }
    const h = await harness(adapter)
    const modelRequest = request(h.provider.id, h.account.id)
    modelRequest.tools = [{
      name: 'read',
      description: 'Read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }]
    const chunks = await collect(h.registry.clientMap().get(h.provider.id)!.stream(modelRequest))

    expect(chunks).toEqual([
      expect.objectContaining({ kind: 'error', code: 'extension_provider_protocol_error' }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('propagates cancellation to the provider adapter', async () => {
    const cancel = vi.fn(async () => undefined)
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input, context) {
        started()
        await new Promise<void>((resolve) => {
          if (context.cancellation.isCancellationRequested) resolve()
          else context.cancellation.onCancellationRequested(resolve)
        })
        yield { requestId: input.requestId, sequence: 0, type: 'completed', finishReason: 'other' }
      },
      cancel
    }
    const h = await harness(adapter)
    const controller = new AbortController()
    const client = h.registry.clientMap().get(h.provider.id)!
    const collecting = collect(client.stream(request(h.provider.id, h.account.id, controller.signal)))
    await didStart
    controller.abort()

    await expect(collecting).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('rejects a binding to a model outside the provider-owned catalog', async () => {
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: () => {
        throw new Error('stream must not start for an unknown model')
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!
    await expect(collect(client.stream({
      ...request(h.provider.id, h.account.id),
      model: 'forged-model'
    }))).rejects.toThrow(/model is not provided/)
  })

})
