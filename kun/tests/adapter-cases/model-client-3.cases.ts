import { describe, expect, it, vi } from 'vitest'

import {
  CompatModelClient,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS
} from '../../src/adapters/model/compat-model-client.js'

import {
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeCompactionItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserItem
} from '../../src/domain/item.js'

import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'

function buildRequest(abortSignal: AbortSignal): ModelRequest {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    model: 'deepseek-chat',
    systemPrompt: 'You are a helpful assistant.',
    prefix: [],
    history: [],
    tools: [
      {
        name: 'echo',
        description: 'Echo a string back to the model.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        }
      }
    ],
    abortSignal
  }
}

const READ_IMAGE_BASE64 = 'aW1hZ2UtYnl0ZXM='

function readImageToolRequest(model: string): ModelRequest {
  const request = buildRequest(new AbortController().signal)
  request.model = model
  request.tools = [{
    name: 'read',
    description: 'Read a file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }]
  request.history = [
    makeToolCallItem({
      id: 'item_call_read',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      arguments: { path: 'img/diagram.png' },
      status: 'completed'
    }),
    makeToolResultItem({
      id: 'item_result_read',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      output: {
        path: '/workspace/img/diagram.png',
        relative_path: 'img/diagram.png',
        kind: 'image',
        mime_type: 'image/png',
        width: 16,
        height: 8,
        byte_size: 11,
        data_base64: READ_IMAGE_BASE64,
        note: 'Read image file [image/png]'
      }
    })
  ]
  return request
}

function collectKinds(chunks: ModelStreamChunk[]): string[] {
  return chunks.map((chunk) => chunk.kind)
}

function sseStream(payloads: Array<Record<string, unknown> | '[DONE]'>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`))
      }
      controller.close()
    }
  })
}

describe('CompatModelClient', () => {

it('requests usage in streaming responses', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const sentHeaders: Array<Record<string, string>> = []
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      sentHeaders.push(init?.headers as Record<string, string>)
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })

    for await (const _chunk of client.stream(buildRequest(new AbortController().signal))) {
      // drain
    }

    expect(sentBodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    })
    expect(sentHeaders[0]?.Accept).toBeUndefined()
  })

it('serializes requiredToolName as an exact provider-native tool choice', async () => {
    const response = {
      id: 'required-tool-metadata',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ]
    }
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.requiredToolName = 'echo'
    for await (const _chunk of client.stream(request)) {
      // drain
    }
    expect(sentBodies[0]).toHaveProperty('tools')
    expect(sentBodies[0]).toHaveProperty('tool_choice', {
      type: 'function',
      function: { name: 'echo' }
    })
  })

it('passes the request abort signal to fetch', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenSignal = init?.signal as AbortSignal | undefined
      return new Response(JSON.stringify({
        id: 'signal',
        model: 'deepseek-chat',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    for await (const _chunk of client.stream(buildRequest(controller.signal))) {
      // drain
    }
    expect(seenSignal).toBe(controller.signal)
  })

it('strips DeepSeek thinking payload for Azure OpenAI-compatible endpoints', async () => {
    const response = {
      id: 'azure',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ]
    }
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.openai.azure.com/openai/deployments/demo',
      apiKey: 'k',
      model: 'gpt-4.1',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'gpt-4.1'
    request.reasoningEffort = 'high'
    for await (const _chunk of client.stream(request)) {
      // drain
    }
    expect(sentBodies[0]?.reasoning_effort).toBe('high')
    expect(sentBodies[0]).not.toHaveProperty('thinking')
  })

it('maps Xiaomi max reasoning to the highest supported Xiaomi effort from model profiles', async () => {
    const response = {
      id: 'xiaomi',
      model: 'mimo-v2.5-pro',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ]
    }
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'k',
      model: 'mimo-v2.5-pro',
      fetchImpl,
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        contextWindowTokens: 1_000_000,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['off', 'low', 'medium', 'high'],
          defaultEffort: 'high',
          requestProtocol: 'mimo-chat-completions'
        }
      })
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'mimo-v2.5-pro'
    request.reasoningEffort = 'max'
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    expect(sentBodies[0]?.reasoning_effort).toBe('high')
    expect(sentBodies[0]?.thinking).toEqual({ type: 'enabled' })
  })

it('parses a non-streaming JSON response into chunks', async () => {
    const response = {
      id: 'r1',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'I will run the tool.',
            reasoning_content: 'I should call echo.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'echo',
                  arguments: JSON.stringify({ text: 'hi' })
                }
              }
            ]
          }
        }
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        prompt_tokens_details: { cached_tokens: 30 }
      }
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const client = new CompatModelClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }
    const textChunk = chunks.find((c) => c.kind === 'assistant_text_delta')
    const reasoningChunk = chunks.find((c) => c.kind === 'assistant_reasoning_delta')
    const callChunk = chunks.find((c) => c.kind === 'tool_call_complete')
    const usageChunk = chunks.find((c) => c.kind === 'usage')
    const completionChunk = chunks.find((c) => c.kind === 'completed')
    expect(textChunk && textChunk.kind === 'assistant_text_delta' ? textChunk.text : '').toBe(
      'I will run the tool.'
    )
    expect(
      reasoningChunk && reasoningChunk.kind === 'assistant_reasoning_delta' ? reasoningChunk.text : ''
    ).toBe('I should call echo.')
    expect(
      callChunk && callChunk.kind === 'tool_call_complete' ? callChunk.arguments : {}
    ).toEqual({ text: 'hi' })
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheHitTokens : 0).toBe(30)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheMissTokens : 0).toBe(20)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.costUsd : 0).toBeGreaterThan(0)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.costCny : 0).toBeGreaterThan(0)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheSavingsUsd : undefined).toBeUndefined()
    expect(
      completionChunk && completionChunk.kind === 'completed' ? completionChunk.stopReason : ''
    ).toBe('tool_calls')
  })

it('repairs fenced non-streaming tool arguments', async () => {
    const response = {
      id: 'repair',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_repair',
                type: 'function',
                function: {
                  name: 'echo',
                  arguments: '```json\n{"text":"repaired"}\n```'
                }
              }
            ]
          }
        }
      ]
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }
    const callChunk = chunks.find((c) => c.kind === 'tool_call_complete')
    expect(callChunk && callChunk.kind === 'tool_call_complete' ? callChunk.arguments : {})
      .toEqual({ text: 'repaired' })
  })

it('prefers DeepSeek native prompt cache hit and miss counters', async () => {
    const response = {
      id: 'r1',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_cache_hit_tokens: 930,
        prompt_cache_miss_tokens: 70,
        prompt_tokens_details: { cached_tokens: 123 }
      }
    }
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const client = new CompatModelClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }
    const usageChunk = chunks.find((c) => c.kind === 'usage')
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheHitTokens : 0).toBe(930)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheMissTokens : 0).toBe(70)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.cacheHitRate : 0).toBeCloseTo(0.93)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.costUsd : 0).toBeCloseTo(0.000015204)
    expect(usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage.costCny : 0).toBeCloseTo(0.0001086)
  })

it('sends tools in a canonical order for a stable cache prefix', async () => {
    const sentBodies: Array<{ tools?: Array<{ function?: { name?: string; parameters?: unknown } }> }> = []
    const response = {
      id: 'r1',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.tools = [
      { name: 'zeta', description: 'z', inputSchema: { required: ['b'], properties: { b: { type: 'string' }, a: { type: 'number' } }, type: 'object' } },
      { name: 'alpha', description: 'a', inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } } }
    ]
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const sentBody = sentBodies[0]
    expect(sentBody?.tools?.map((tool) => tool.function?.name)).toEqual(['alpha', 'zeta'])
    expect(Object.keys((sentBody?.tools?.[1]?.function?.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['a', 'b'])
  })

it('heals incomplete tool-call pairs before sending history upstream', async () => {
    const sentBodies: Array<{ messages?: Array<Record<string, unknown>> }> = []
    const response = {
      id: 'r1',
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'done' }
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.history = [
      makeToolResultItem({
        id: 'orphan_result',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_orphan',
        toolName: 'echo',
        output: 'orphan'
      }),
      makeToolCallItem({
        id: 'missing_result_call',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_missing',
        toolName: 'echo',
        arguments: { text: 'missing' }
      }),
      makeUserItem({ id: 'user_after_missing', turnId: 'turn_1', threadId: 'thr_1', text: 'continue' }),
      makeToolCallItem({
        id: 'valid_call',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_ok',
        toolName: 'echo',
        arguments: { text: 'ok' },
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'valid_result',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_ok',
        toolName: 'echo',
        output: 'ok'
      })
    ]
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    expect(messages.some((message) => message.tool_call_id === 'call_orphan')).toBe(false)
    expect(JSON.stringify(messages)).not.toContain('call_missing')
    expect(messages.some((message) => message.role === 'user' && message.content === 'continue')).toBe(true)
    expect(
      messages.some((message) =>
        Array.isArray(message.tool_calls) &&
        message.tool_calls.some((call: { id?: string }) => call.id === 'call_ok')
      )
    ).toBe(true)
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_ok')).toBe(true)
  })

})
