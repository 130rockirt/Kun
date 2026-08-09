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

it('sends volatile context instructions after the history for cache prefix stability', async () => {
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
    request.contextInstructions = ['Tokens used: 4321 — continue the goal.']
    request.history = [
      makeUserItem({ id: 'user_1', turnId: 'turn_1', threadId: 'thr_1', text: 'hello' })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    const instructionIndex = messages.findIndex(
      (message) => typeof message.content === 'string' && message.content.includes('Tokens used: 4321')
    )
    const userIndex = messages.findIndex((message) => message.role === 'user')
    expect(instructionIndex).toBeGreaterThan(userIndex)
    expect(messages[instructionIndex]).toMatchObject({ role: 'system' })
  })

it('preserves the latest compaction summary when applying history limits', async () => {
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
      nonStreaming: true,
      historyLimit: 2
    })
    const request = buildRequest(new AbortController().signal)
    request.history = [
      makeCompactionItem({
        id: 'compact_1',
        turnId: 'turn_1',
        threadId: 'thr_1',
        summary: 'Keep original requirement beta.',
        replacedTokens: 50,
        pinnedConstraints: []
      }),
      makeUserItem({ id: 'old_1', turnId: 'turn_2', threadId: 'thr_1', text: 'old detail one' }),
      makeUserItem({ id: 'old_2', turnId: 'turn_3', threadId: 'thr_1', text: 'old detail two' }),
      makeUserItem({ id: 'latest', turnId: 'turn_4', threadId: 'thr_1', text: 'latest question' })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    expect(JSON.stringify(messages)).toContain('Keep original requirement beta')
    expect(JSON.stringify(messages)).not.toContain('old detail two')
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'latest question' })
  })

it('reports an error when the HTTP response is not OK', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const providerMessage = `Not supported model ${'mimo-v2.5-pro-ultraspeed'.repeat(40)}`
    const body = JSON.stringify({ error: { code: '400', message: providerMessage } })
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 400 })
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }
    warn.mockRestore()
    expect(chunks[0].kind).toBe('error')
    expect(chunks[0]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('model request failed with status 400: {"error":{"code":"400","message":"Not supported model mimo-v2.5-pro-ultraspeed'),
      code: 'http_400'
    })
    expect(JSON.stringify(chunks[0])).toContain('...')
    expect(JSON.stringify(chunks[0])).not.toContain(providerMessage)
  })

it('adds a proxy hint when a proxied model request fails before receiving a response', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ETIMEDOUT')
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-v4-pro',
      modelProxyUrl: 'http://127.0.0.1:7890',
      retry: { maxAttempts: 0 },
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(chunks[0]).toMatchObject({
      kind: 'error',
      message: 'model request failed: connect ETIMEDOUT. Check the configured model-request proxy in Settings > Providers.'
    })
  })

it('omits the proxy hint when a proxied request is aborted (cancel/idle-timeout)', async () => {
    const fetchImpl: typeof fetch = async () => {
      const abort = new Error('The operation was aborted')
      abort.name = 'AbortError'
      throw abort
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-v4-pro',
      modelProxyUrl: 'http://127.0.0.1:7890',
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(chunks[0]).toMatchObject({ kind: 'error' })
    expect(JSON.stringify(chunks[0])).not.toContain('model-request proxy')
  })

it('adds a provider configuration hint and logs request context for HTTP 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchImpl: typeof fetch = async () => new Response('', { status: 404 })
    const client = new CompatModelClient({
      baseUrl: 'https://api.example.com/chat/completions?api_key=secret',
      apiKey: 'k',
      model: 'deepseek-chat',
      endpointFormat: 'custom_endpoint',
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(chunks[0]).toMatchObject({
      kind: 'error',
      message: 'model request failed with status 404: Check your model provider configuration, especially Base URL and Endpoint format.',
      code: 'http_404'
    })
    expect(warn).toHaveBeenCalledWith('[kun:model] model HTTP request failed', expect.objectContaining({
      provider: 'compat',
      status: 404,
      model: 'deepseek-chat',
      configuredModel: 'deepseek-chat',
      baseUrl: 'https://api.example.com/chat/completions?api_key=%5Bredacted%5D',
      requestUrl: 'https://api.example.com/chat/completions?api_key=%5Bredacted%5D',
      endpointFormat: 'chat_completions',
      configuredEndpointFormat: 'custom_endpoint',
      responseBody: ''
    }))
    warn.mockRestore()
  })

it('reports provider JSON error payloads returned with HTTP 200', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({
        error: {
          message: 'model mimo-v2.5-pro-ultraspeed is not available for this account',
          code: 'model_not_available'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const client = new CompatModelClient({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'k',
      model: 'mimo-v2.5-pro-ultraspeed',
      fetchImpl,
      nonStreaming: true
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        kind: 'error',
        message: 'model mimo-v2.5-pro-ultraspeed is not available for this account',
        code: 'model_not_available'
      }
    ])
  })

it('reports streamed provider error payloads returned with HTTP 200', async () => {
    const body = sseStream([
      {
        error: {
          message: 'no permission to access model mimo-v2.5-pro-ultraspeed',
          type: 'permission_denied'
        }
      },
      '[DONE]'
    ])
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const client = new CompatModelClient({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'k',
      model: 'mimo-v2.5-pro-ultraspeed',
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(chunks.find((chunk) => chunk.kind === 'error')).toMatchObject({
      kind: 'error',
      message: 'no permission to access model mimo-v2.5-pro-ultraspeed',
      code: 'permission_denied'
    })
    expect(chunks.find((chunk) => chunk.kind === 'completed')).toMatchObject({
      kind: 'completed',
      stopReason: 'error'
    })
  })

it('parses streamed SSE events with tool call deltas', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"text\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      }
    })
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }
    const text = chunks
      .filter((c) => c.kind === 'assistant_text_delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('Hello world')
    const complete = chunks.find((c) => c.kind === 'tool_call_complete')
    expect(complete && complete.kind === 'tool_call_complete' ? complete.callId : '').toBe('call_1')
    expect(complete && complete.kind === 'tool_call_complete' ? complete.arguments : {}).toEqual({ text: 'hi' })
    expect(chunks.find((c) => c.kind === 'usage')).toBeDefined()
  })

it('keeps reading streamed usage sent after finish_reason', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      }
    })
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    const usage = chunks.find((c) => c.kind === 'usage')
    const completed = chunks.find((c) => c.kind === 'completed')
    expect(usage && usage.kind === 'usage' ? usage.usage.totalTokens : 0).toBe(10)
    expect(completed && completed.kind === 'completed' ? completed.stopReason : '').toBe('stop')
  })

it('retries without stream usage options when a provider rejects them', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const encoder = new TextEncoder()
    const retryBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"retried"}}]}\n\n'))
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'
          )
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (sentBodies.length === 1) {
        return new Response('unknown field stream_options.include_usage', { status: 400 })
      }
      return new Response(retryBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter((c) => c.kind === 'assistant_text_delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    const usage = chunks.find((c) => c.kind === 'usage')
    expect(sentBodies).toHaveLength(2)
    expect(sentBodies[0]).toHaveProperty('stream_options')
    expect(sentBodies[1]).not.toHaveProperty('stream_options')
    expect(text).toBe('retried')
    expect(usage && usage.kind === 'usage' ? usage.usage.totalTokens : 0).toBe(7)
  })

it('retries configured HTTP statuses before streaming starts', async () => {
    const statuses = [429, 200]
    const fetchImpl: typeof fetch = async () => {
      const status = statuses.shift() ?? 200
      if (status !== 200) return new Response('rate limited', { status })
      return new Response(
        'data: {"choices":[{"delta":{"content":"retried"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      retry: {
        maxAttempts: 1,
        initialDelayMs: 0,
        httpStatusCodes: [429]
      }
    })
    const chunks = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter((c) => c.kind === 'assistant_text_delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('retried')
    expect(statuses).toHaveLength(0)
  })

it('uses Retry-After before retrying configured HTTP statuses', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        if (fetchImpl.mock.calls.length === 1) {
          return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
        }
        return new Response('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop","index":0}]}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
      const client = new CompatModelClient({
        baseUrl: 'https://example.com/beta',
        apiKey: 'k',
        model: 'deepseek-chat',
        fetchImpl,
        nonStreaming: true,
        retry: {
          maxAttempts: 1,
          initialDelayMs: 0,
          httpStatusCodes: [429]
        }
      })
      const chunksPromise = (async () => {
        const chunks = []
        for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
          chunks.push(chunk)
        }
        return chunks
      })()

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(1_999)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      const chunks = await chunksPromise

      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(chunks.some((chunk) => chunk.kind === 'assistant_text_delta')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

it('uses exponential backoff when Retry-After is absent', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        if (fetchImpl.mock.calls.length <= 2) {
          return new Response('rate limited', { status: 429 })
        }
        return new Response('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop","index":0}]}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
      const client = new CompatModelClient({
        baseUrl: 'https://example.com/beta',
        apiKey: 'k',
        model: 'deepseek-chat',
        fetchImpl,
        nonStreaming: true,
        retry: {
          maxAttempts: 2,
          initialDelayMs: 3000,
          httpStatusCodes: [429]
        }
      })
      const chunksPromise = (async () => {
        const chunks: ModelStreamChunk[] = []
        for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
          chunks.push(chunk)
        }
        return chunks
      })()

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2999)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5999)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      const chunks = await chunksPromise

      expect(fetchImpl).toHaveBeenCalledTimes(3)
      expect(chunks.filter((chunk) => chunk.kind === 'retrying')).toEqual([
        { kind: 'retrying', status: 429, attempt: 1, maxAttempts: 2, delayMs: 3000 },
        { kind: 'retrying', status: 429, attempt: 2, maxAttempts: 2, delayMs: 6000 }
      ])
      expect(chunks.some((chunk) => chunk.kind === 'assistant_text_delta')).toBe(true)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

})
