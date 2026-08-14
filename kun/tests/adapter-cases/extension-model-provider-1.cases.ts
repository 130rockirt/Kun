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

it('normalizes full Kun requests and validates ordered provider streams', async () => {
    let captured: ModelProviderRequest | undefined
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        captured = input
        const events: ModelProviderStreamEvent[] = [
          { requestId: input.requestId, sequence: 0, type: 'reasoningDelta', delta: 'thinking' },
          { requestId: input.requestId, sequence: 1, type: 'textDelta', delta: 'answer' },
          {
            requestId: input.requestId,
            sequence: 2,
            type: 'usage',
            usage: {
              inputTokens: 12,
              outputTokens: 3,
              reasoningTokens: 2,
              cacheReadTokens: 5,
              cacheWriteTokens: 4,
              cost: 0.01,
              currency: 'USD'
            }
          },
          { requestId: input.requestId, sequence: 3, type: 'completed', finishReason: 'stop' }
        ]
        yield* events
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!
    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(captured).toMatchObject({
      binding: { providerId: h.provider.id, accountId: h.account.id, modelId: 'custom-model' },
      instructions: ['Kun stable system prompt'],
      tools: [{ name: 'read' }],
      generation: { reasoningEffort: 'high' }
    })
    expect(captured?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.arrayContaining([
        { type: 'text', text: 'Hello custom provider' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
      ]) }),
      // Request-level context stays chronological so it cannot destabilize
      // the provider's cacheable instruction prefix.
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Extension profile overlay' }]
      })
    ]))
    expect(chunks).toEqual([
      { kind: 'assistant_reasoning_delta', text: 'thinking' },
      { kind: 'assistant_text_delta', text: 'answer' },
      expect.objectContaining({
        kind: 'usage',
        usage: expect.objectContaining({
          totalTokens: 15,
          reasoningTokens: 2,
          cacheWriteTokens: 4,
          costUsd: 0.01,
          costByCurrency: { USD: 0.01 }
        })
      }),
      { kind: 'completed', stopReason: 'stop' }
    ])
  })

it('passes a hard named tool constraint to extension providers', async () => {
    let captured: ModelProviderRequest | undefined
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        captured = input
        yield { requestId: input.requestId, sequence: 0, type: 'completed', finishReason: 'tool_calls' }
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!
    await collect(client.stream(request(h.provider.id, h.account.id, undefined, {
      requiredToolName: 'read'
    })))

    expect(captured?.generation.toolChoice).toEqual({ type: 'tool', name: 'read' })
  })

it('fails explicitly on malformed streams and never falls back to another provider', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield { requestId: input.requestId, sequence: 7, type: 'textDelta', delta: 'out of order' }
      },
      cancel
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!
    await expect(collect(client.stream(request(h.provider.id, h.account.id)))).resolves.toEqual([
      expect.objectContaining({ kind: 'error', code: 'extension_provider_protocol_error' }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('does not let a stalled adapter cancel hook block provider disposal', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield { requestId: input.requestId, sequence: 0, type: 'textDelta', delta: 'started' }
        await new Promise<void>(() => undefined)
      },
      cancel
    }
    const h = await harness(adapter)
    const iterator = h.registry.clientMap().get(h.provider.id)!
      .stream(request(h.provider.id, h.account.id))[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'assistant_text_delta', text: 'started' }
    })

    await expect(Promise.race([
      h.registration.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])).resolves.toBe('disposed')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(h.registry.clientMap().has(h.provider.id)).toBe(false)
  })

it('requires reported usage before successful completion and defers the terminal commit', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield { requestId: input.requestId, sequence: 0, type: 'textDelta', delta: 'partial' }
        yield { requestId: input.requestId, sequence: 1, type: 'completed', finishReason: 'stop' }
      },
      cancel
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!

    await expect(collect(client.stream(request(h.provider.id, h.account.id)))).resolves.toEqual([
      { kind: 'assistant_text_delta', text: 'partial' },
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/without terminal usage/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('retains manifest models when dynamic discovery fails and diagnoses invalid duplicates', async () => {
    const failing = await harness({
      probe: async () => ({ ok: true }),
      listModels: async () => { throw new Error('upstream body must not enter diagnostics') },
      stream: () => throwingStream('not used'),
      cancel: async () => undefined
    })
    await expect(failing.registry.listModels(failing.provider.id, failing.account.id)).resolves.toEqual([
      expect.objectContaining({ id: 'custom-model' })
    ])
    expect(failing.registry.diagnostics()).toEqual([
      expect.objectContaining({
        extensionId: 'com.example.provider',
        providerId: failing.provider.id,
        code: 'model_discovery_failed',
        message: expect.not.stringContaining('upstream body')
      })
    ])

    const discovered = await harness({
      probe: async () => ({ ok: true }),
      listModels: async () => [
        {
          id: 'dynamic-model',
          displayName: 'First',
          capabilities: { input: ['text'], output: ['text'] }
        },
        {
          id: 'dynamic-model',
          displayName: 'Second',
          capabilities: { input: ['text'], output: ['text'] }
        },
        { id: '', displayName: 'Invalid', capabilities: {} }
      ] as never,
      stream: () => throwingStream('not used'),
      cancel: async () => undefined
    })
    await expect(discovered.registry.listModels(discovered.provider.id, discovered.account.id)).resolves.toEqual([
      expect.objectContaining({ id: 'custom-model' }),
      expect.objectContaining({ id: 'dynamic-model', displayName: 'First' })
    ])
    expect(discovered.registry.diagnostics().map((diagnostic) => diagnostic.code).sort()).toEqual([
      'duplicate_model',
      'invalid_model'
    ])
  })

it('redacts adapter-controlled probe and stream failures before diagnostics or model history', async () => {
    const secret = 'sk-super-secret-provider-key'
    const reportedError = await harness({
      probe: async () => ({
        ok: false,
        message: `Authorization: Bearer ${secret}`,
        details: { credential: secret }
      }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'error',
          code: secret,
          message: `upstream rejected ${secret}`,
          retryable: false
        }
      },
      cancel: async () => undefined
    })
    await expect(reportedError.registry.probe(
      reportedError.provider.id,
      reportedError.account.id,
      'custom-model'
    )).resolves.toEqual({ ok: false, message: 'Extension provider probe failed.' })
    const chunks = await collect(reportedError.registry.clientMap().get(reportedError.provider.id)!.stream(
      request(reportedError.provider.id, reportedError.account.id)
    ))
    expect(JSON.stringify(chunks)).not.toContain(secret)
    expect(chunks).toEqual([
      { kind: 'error', code: 'extension_provider_error', message: 'Extension provider reported an error.' },
      { kind: 'completed', stopReason: 'error' }
    ])
    const diagnostics = reportedError.registry.diagnostics()
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        extensionId: 'com.example.provider',
        providerId: reportedError.provider.id,
        modelId: 'custom-model',
        accountId: reportedError.account.id,
        operation: 'probe',
        category: 'unavailable',
        retryable: false
      }),
      expect.objectContaining({
        extensionId: 'com.example.provider',
        providerId: reportedError.provider.id,
        modelId: 'custom-model',
        accountId: reportedError.account.id,
        requestId: expect.stringMatching(/^modelreq_/),
        operation: 'stream',
        category: 'adapter_failure',
        retryable: false
      })
    ]))

    const thrown = await harness({
      probe: async () => { throw new Error(`probe leaked ${secret}`) },
      listModels: async () => [],
      stream: () => throwingStream(`stream leaked ${secret}`),
      cancel: async () => undefined
    })
    await expect(thrown.registry.probe(
      thrown.provider.id,
      thrown.account.id,
      'custom-model'
    )).rejects.toThrow('Extension provider probe failed.')
    const thrownChunks = await collect(thrown.registry.clientMap().get(thrown.provider.id)!.stream(
      request(thrown.provider.id, thrown.account.id)
    ))
    expect(JSON.stringify({ thrownChunks, diagnostics: thrown.registry.diagnostics() })).not.toContain(secret)
  })

it('normalizes provider error categories while retaining safe correlation metadata', async () => {
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield {
          requestId: input.requestId,
          sequence: 0,
          type: 'error',
          code: 'invalid_api_key',
          message: 'raw adapter message is never projected',
          retryable: true
        }
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const chunks = await collect(h.registry.clientMap().get(h.provider.id)!.stream(
      request(h.provider.id, h.account.id)
    ))

    expect(chunks).toEqual([
      {
        kind: 'error',
        code: 'extension_provider_authentication_error',
        message: 'Extension provider authentication failed; reconnect the selected account.'
      },
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(h.registry.diagnostics()).toEqual([
      expect.objectContaining({
        extensionId: h.owner.extensionId,
        providerId: h.provider.id,
        modelId: 'custom-model',
        accountId: h.account.id,
        requestId: expect.stringMatching(/^modelreq_/),
        operation: 'stream',
        code: 'provider_error',
        category: 'authentication',
        retryable: true,
        message: expect.not.stringContaining('raw adapter')
      })
    ])
  })

it.each([
    ['MODEL_NOT_FOUND', 'extension_provider_invalid_request', 'invalid_request'],
    ['HTTP_401', 'extension_provider_authentication_error', 'authentication'],
    ['HTTP_429', 'extension_provider_rate_limit_error', 'rate_limit'],
    ['RESOURCE_EXHAUSTED', 'extension_provider_rate_limit_error', 'rate_limit'],
    ['TOO_MANY_REQUESTS', 'extension_provider_rate_limit_error', 'rate_limit'],
    ['rateLimitExceeded', 'extension_provider_rate_limit_error', 'rate_limit'],
    ['invalidApiKey', 'extension_provider_authentication_error', 'authentication'],
    ['HTTP_503', 'extension_provider_unavailable', 'unavailable']
  ] as const)(
    'normalizes common provider code %s',
    async (reportedCode, expectedCode, expectedCategory) => {
      const adapter: ModelProviderAdapter = {
        probe: async () => ({ ok: true }),
        listModels: async () => [],
        stream: async function* (input) {
          yield {
            requestId: input.requestId,
            sequence: 0,
            type: 'error',
            code: reportedCode,
            message: 'untrusted provider detail',
            retryable: false
          }
        },
        cancel: async () => undefined
      }
      const h = await harness(adapter)

      const chunks = await collect(h.registry.clientMap().get(h.provider.id)!.stream(
        request(h.provider.id, h.account.id)
      ))

      expect(chunks[0]).toEqual(expect.objectContaining({ kind: 'error', code: expectedCode }))
      expect(h.registry.diagnostics()).toEqual([
        expect.objectContaining({ category: expectedCategory, retryable: false })
      ])
      expect(JSON.stringify({ chunks, diagnostics: h.registry.diagnostics() }))
        .not.toContain('untrusted provider detail')
    }
  )

it('cancels streams that exceed the cumulative per-request byte budget', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield { requestId: input.requestId, sequence: 0, type: 'textDelta', delta: 'a'.repeat(700) }
        yield { requestId: input.requestId, sequence: 1, type: 'textDelta', delta: 'b'.repeat(700) }
        yield { requestId: input.requestId, sequence: 2, type: 'completed', finishReason: 'stop' }
      },
      cancel
    }
    const h = await harness(adapter, {
      maxEventBytes: 1_024,
      maxTotalBytesPerRequest: 1_100
    })
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toEqual([
      { kind: 'assistant_text_delta', text: 'a'.repeat(700) },
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/stream byte limit exceeded/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('cancels streams that exceed the native-equivalent output byte budget', async () => {
    const cancel = vi.fn(async () => undefined)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        yield { requestId: input.requestId, sequence: 0, type: 'textDelta', delta: 'a'.repeat(700) }
        yield { requestId: input.requestId, sequence: 1, type: 'reasoningDelta', delta: 'b'.repeat(700) }
        yield { requestId: input.requestId, sequence: 2, type: 'completed', finishReason: 'stop' }
      },
      cancel
    }
    const h = await harness(adapter, {
      maxTotalBytesPerRequest: 8_192,
      maxOutputBytesPerRequest: 1_100
    })
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toEqual([
      { kind: 'assistant_text_delta', text: 'a'.repeat(700) },
      expect.objectContaining({
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: expect.stringMatching(/output byte limit exceeded/)
      }),
      { kind: 'completed', stopReason: 'error' }
    ])
    expect(cancel).toHaveBeenCalledTimes(1)
  })

it('accepts and reconstructs tool arguments split across more than 1,024 events', async () => {
    const expectedInput = { path: `/tmp/${'x'.repeat(1_500)}` }
    const serialized = JSON.stringify(expectedInput)
    const adapter: ModelProviderAdapter = {
      probe: async () => ({ ok: true }),
      listModels: async () => [],
      stream: async function* (input) {
        let sequence = 0
        for (const [index, character] of [...serialized].entries()) {
          yield {
            requestId: input.requestId,
            sequence: sequence++,
            type: 'toolCallDelta' as const,
            callId: 'call_fragmented',
            ...(index === 0 ? { nameDelta: 'read' } : {}),
            argumentsDelta: character
          }
        }
        yield {
          requestId: input.requestId,
          sequence,
          type: 'completed',
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 }
        }
      },
      cancel: async () => undefined
    }
    const h = await harness(adapter)
    const client = h.registry.clientMap().get(h.provider.id)!

    const chunks = await collect(client.stream(request(h.provider.id, h.account.id)))

    expect(chunks).toContainEqual({
      kind: 'tool_call_complete',
      callId: 'call_fragmented',
      toolName: 'read',
      arguments: expectedInput
    })
    expect(chunks).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

})
