import { describe, expect, it } from 'vitest'

import { CompatModelClient } from '../../src/adapters/model/compat-model-client.js'

import type { ModelCapabilityMetadata } from '../../src/contracts/capabilities.js'

import type { ModelEndpointFormat } from '../../src/contracts/model-endpoint-format.js'

import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'

import {
  makeAssistantTextItem,
  makeCompactionItem,
  makeGoalContextItem,
  makeUserItem
} from '../../src/domain/item.js'

import { GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA } from '../../src/adapters/tool/graph-mode-tool-provider.js'

import { createCompatRequestCodecs, normalizeToolSpecs } from '../../src/adapters/model/compat-request-builder.js'

type CapturedCall = { url: string; body: Record<string, unknown> }

const DEEPSEEK_REASONING: NonNullable<ModelCapabilityMetadata['reasoning']> = {
  supportedEfforts: ['off', 'high', 'max'],
  defaultEffort: 'max',
  requestProtocol: 'deepseek-chat-completions'
}

function modelCapabilities(
  overrides: Record<string, ModelEndpointFormat>
): (model: string) => ModelCapabilityMetadata {
  return (model) => ({
    id: model,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text'],
    ...(overrides[model] ? { endpointFormat: overrides[model] } : {})
  })
}

function fakeFetch(calls: CapturedCall[]): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const target = String(url)
    calls.push({ url: target, body: JSON.parse(init.body) as Record<string, unknown> })
    const json = target.endsWith('/messages')
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : { choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }] }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
}

function request(model: string): ModelRequest {
  return {
    threadId: 't1',
    turnId: 'u1',
    model,
    systemPrompt: 'You are a helpful assistant.',
    prefix: [],
    history: [],
    tools: [],
    abortSignal: new AbortController().signal
  }
}

async function drain(iterable: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('CompatModelClient per-model endpointFormat', () => {

it('uses the Codex Responses Lite shape for GPT-5.6 models', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.6-sol',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({
          url: String(url),
          headers: init.headers,
          body: JSON.parse(init.body) as Record<string, unknown>
        })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: (model) => ({
        id: model,
        endpointFormat: 'responses',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text', 'image_url'],
        serviceTiers: model === 'gpt-5.6-sol' ? ['priority'] : undefined,
        responsesMode: model === 'gpt-5.6-sol' ? 'lite' : undefined
      })
    })

    await drain(client.stream({
      ...request('gpt-5.6-sol'),
      reasoningEffort: 'max',
      serviceTier: 'priority',
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: {} }
      }]
    }))

    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].headers['x-openai-internal-codex-responses-lite']).toBe('true')
    expect(calls[0].body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      parallel_tool_calls: false,
      prompt_cache_key: 't1',
      service_tier: 'priority',
      reasoning: { effort: 'xhigh', context: 'all_turns' }
    })
    expect(calls[0].body).not.toHaveProperty('instructions')
    expect(calls[0].body).not.toHaveProperty('tools')
    const input = calls[0].body.input as Array<Record<string, unknown>>
    expect(input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'read_file' }]
    })
    expect(input[0].tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_generation' })
    ]))
    expect(input[1]).toMatchObject({ type: 'message', role: 'developer' })
  })

it('normalizes legacy Codex baseUrl + responses format to the custom /responses endpoint', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.5',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream(request('gpt-5.5')))

    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].body).toMatchObject({
      model: 'gpt-5.5',
      store: false
    })
    expect(calls[0].body).not.toHaveProperty('messages')
  })

it('keeps GPT-5.6 Responses Lite cache inputs append-only and thread-scoped', async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = []
    const responses = [
      {
        status: 'completed',
        output_text: 'first response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 0 }
        }
      },
      {
        status: 'completed',
        output_text: 'second response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 900 }
        }
      },
      {
        status: 'completed',
        output_text: 'isolated response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    ]
    let responseIndex = 0
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.6-sol',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
        const response = responses[responseIndex]
        responseIndex += 1
        if (!response) throw new Error('unexpected Responses request')
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: (model) => ({
        id: model,
        endpointFormat: 'responses',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text', 'image_url'],
        responsesMode: model === 'gpt-5.6-sol' ? 'lite' : undefined
      })
    })
    const threadA = 'thread-cache-a'
    const firstTurnId = 'turn-cache-a-1'
    const firstHistory = [
      makeUserItem({
        id: 'item-cache-a-1',
        threadId: threadA,
        turnId: firstTurnId,
        text: 'first request'
      }),
      makeGoalContextItem({
        id: 'item-cache-a-1-goal',
        threadId: threadA,
        turnId: firstTurnId,
        text: 'Stable goal context for the cached conversation.',
        createdAt: '2026-08-06T00:00:00.000Z'
      })
    ]
    const firstChunks = await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadA,
      turnId: firstTurnId,
      history: firstHistory
    }))
    const secondTurnId = 'turn-cache-a-2'
    const secondChunks = await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadA,
      turnId: secondTurnId,
      history: [
        ...firstHistory,
        makeAssistantTextItem({
          id: 'item-cache-a-1-response',
          threadId: threadA,
          turnId: firstTurnId,
          text: 'first response',
          status: 'completed'
        }),
        makeUserItem({
          id: 'item-cache-a-2',
          threadId: threadA,
          turnId: secondTurnId,
          text: 'second request'
        })
      ]
    }))
    const threadB = 'thread-cache-b'
    await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadB,
      turnId: 'turn-cache-b-1',
      history: [makeUserItem({
        id: 'item-cache-b-1',
        threadId: threadB,
        turnId: 'turn-cache-b-1',
        text: 'isolated request'
      })]
    }))

    expect(calls.map((call) => call.headers['x-openai-internal-codex-responses-lite'])).toEqual([
      'true', 'true', 'true'
    ])
    expect(calls.map((call) => call.body.prompt_cache_key)).toEqual([
      threadA, threadA, threadB
    ])
    const firstInput = calls[0]?.body.input
    const secondInput = calls[1]?.body.input
    const isolatedInput = calls[2]?.body.input
    if (!Array.isArray(firstInput) || !Array.isArray(secondInput) || !Array.isArray(isolatedInput)) {
      throw new Error('expected Responses inputs')
    }
    expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput)
    expect(JSON.stringify(firstInput)).toContain('Stable goal context for the cached conversation.')
    expect(secondInput.slice(firstInput.length)).toEqual([
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second request' }
    ])
    const isolatedWire = JSON.stringify(isolatedInput)
    expect(isolatedWire).not.toContain('first request')
    expect(isolatedWire).not.toContain('first response')
    expect(isolatedWire).not.toContain('second request')

    const warmUsage = secondChunks.find(
      (chunk): chunk is Extract<ModelStreamChunk, { kind: 'usage' }> => chunk.kind === 'usage'
    )
    expect(firstChunks.some((chunk) => chunk.kind === 'usage')).toBe(true)
    expect(warmUsage?.usage).toMatchObject({
      cachedTokens: 900,
      cacheHitTokens: 900,
      cacheMissTokens: 100,
      cacheHitRate: 0.9
    })
  })

it('omits the priority service tier for unsupported Codex models', async () => {
    const calls: CapturedCall[] = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.4-mini',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: fakeFetch(calls),
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream({
      ...request('gpt-5.4-mini'),
      serviceTier: 'priority'
    }))

    expect(calls[0].body).not.toHaveProperty('service_tier')
  })

it('never forwards the priority service tier to non-Codex Responses endpoints', () => {
    const body = createCompatRequestCodecs().build({
      request: { ...request('gpt-5.4'), serviceTier: 'priority' },
      model: 'gpt-5.4',
      messages: [],
      tools: [],
      stream: true,
      endpointFormat: 'responses',
      baseUrl: 'https://api.openai.com/v1',
      isCodex: false,
      isCodexLite: false,
      serviceTiers: ['priority'],
      codexNativeImageGeneration: false
    })

    expect(body).not.toHaveProperty('service_tier')
  })

})
