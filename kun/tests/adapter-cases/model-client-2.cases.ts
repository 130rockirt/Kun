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

it('keeps volatile context out of the Anthropic system block and marks cache breakpoints', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'k',
      model: 'MiniMax-M2.5',
      endpointFormat: 'messages',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.contextInstructions = ['Tokens used: 4321 — continue the goal.']
    request.history = [
      makeUserItem({ id: 'user_1', turnId: 'turn_1', threadId: 'thr_1', text: 'hello' }),
      makeAssistantTextItem({ id: 'asst_1', turnId: 'turn_1', threadId: 'thr_1', text: 'hi there' }),
      makeUserItem({ id: 'user_2', turnId: 'turn_2', threadId: 'thr_1', text: 'continue' })
    ]
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const body = sentBodies[0]
    // The volatile per-turn instruction must not invalidate the cached
    // system prefix: it trails the history inside the final user turn.
    expect(body.system).toEqual([{
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' }
    }])
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const lastMessage = messages[messages.length - 1]
    expect(lastMessage.role).toBe('user')
    const lastBlocks = lastMessage.content
    expect(lastBlocks.some((block) => String(block.text ?? '').includes('Tokens used: 4321'))).toBe(true)
    // Explicit-cache providers (MiniMax) only cache content before
    // cache_control breakpoints: the last two messages carry one.
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    const previousMessage = messages[messages.length - 2]
    const previousBlocks = previousMessage.content
    expect(previousBlocks[previousBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })

it('enables MiniMax M3 adaptive thinking from a model reasoning profile', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'msg_m3',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'k',
      model: 'MiniMax-M3',
      endpointFormat: 'messages',
      fetchImpl,
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        contextWindowTokens: 1_000_000,
        messageParts: ['text', 'image_url'],
        reasoning: {
          supportedEfforts: ['auto', 'off'],
          defaultEffort: 'auto',
          requestProtocol: 'anthropic-thinking'
        }
      })
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'MiniMax-M3'
    request.reasoningEffort = 'max'
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    expect(sentBodies[0]?.thinking).toEqual({ type: 'adaptive' })
  })

it('sends Anthropic Messages effort with adaptive thinking from a model reasoning profile', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'msg_effort',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/anthropic',
      apiKey: 'k',
      model: 'deepseek-v4-pro',
      endpointFormat: 'messages',
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
          supportedEfforts: ['off', 'low', 'medium', 'high', 'max'],
          defaultEffort: 'max',
          requestProtocol: 'anthropic-thinking'
        }
      })
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'deepseek-v4-pro'
    request.reasoningEffort = 'max'
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    expect(sentBodies[0]?.thinking).toEqual({ type: 'adaptive' })
    expect(sentBodies[0]?.output_config).toEqual({ effort: 'max' })
  })

it('does not send thinking controls for MiniMax M2.x built-in reasoning profiles', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'msg_m25',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'k',
      model: 'MiniMax-M2.5',
      endpointFormat: 'messages',
      fetchImpl,
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        contextWindowTokens: 204_800,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['auto'],
          defaultEffort: 'auto',
          requestProtocol: 'none'
        }
      })
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'MiniMax-M2.5'
    request.reasoningEffort = 'off'
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    expect(sentBodies[0]).not.toHaveProperty('thinking')
  })

it('maps GLM reasoning profiles to GLM thinking request controls', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'glm_1',
        model: 'glm-5.2',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'k',
      model: 'glm-5.2',
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
          supportedEfforts: ['off', 'high', 'max'],
          defaultEffort: 'max',
          requestProtocol: 'glm-chat-completions'
        }
      })
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'glm-5.2'
    request.reasoningEffort = 'max'
    for await (const _chunk of client.stream(request)) {
      // drain
    }

    expect(sentBodies[0]?.thinking).toEqual({ type: 'enabled', clear_thinking: true })
    expect(sentBodies[0]).not.toHaveProperty('reasoning_effort')
  })

it('maps Anthropic usage where input_tokens excludes cache reads and writes', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({
        id: 'msg_3',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const client = new CompatModelClient({
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'k',
      model: 'MiniMax-M2.5',
      endpointFormat: 'messages',
      fetchImpl,
      nonStreaming: true
    })
    const chunks: ModelStreamChunk[] = []
    const request = buildRequest(new AbortController().signal)
    request.model = 'MiniMax-M2.5'
    for await (const chunk of client.stream(request)) {
      chunks.push(chunk)
    }
    const usageChunk = chunks.find((chunk) => chunk.kind === 'usage')
    const usage = usageChunk && usageChunk.kind === 'usage' ? usageChunk.usage : null
    expect(usage).not.toBeNull()
    expect(usage!.promptTokens).toBe(1250)
    expect(usage!.cacheHitTokens).toBe(1000)
    expect(usage!.cacheMissTokens).toBe(250)
    expect(usage!.totalTokens).toBe(1260)
    expect(usage!.cacheHitRate).toBeCloseTo(0.8)
    expect(usage!.costCny).toBeCloseTo(0.000924)
    expect(usage!.costUsd).toBeUndefined()
  })

it('streams Responses API text and function calls', async () => {
    const fetchImpl: typeof fetch = async () => new Response(sseStream([
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_echo', name: 'echo', arguments: '' }
      },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"text":"ok"}' },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_echo', name: 'echo', arguments: '{"text":"ok"}' }
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_echo', name: 'echo', arguments: '{"text":"ok"}' }],
          usage: { input_tokens: 3, output_tokens: 4 }
        }
      }
    ]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
    const client = new CompatModelClient({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'gpt-5-mini',
      endpointFormat: 'responses',
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(collectKinds(chunks)).toEqual([
      'assistant_text_delta',
      'tool_call_delta',
      'tool_call_complete',
      'usage',
      'completed'
    ])
    expect(chunks.find((chunk) => chunk.kind === 'tool_call_complete')).toMatchObject({
      callId: 'call_echo',
      toolName: 'echo',
      arguments: { text: 'ok' }
    })
  })

it('streams Anthropic Messages API text and tool calls', async () => {
    const fetchImpl: typeof fetch = async () => new Response(sseStream([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 5, output_tokens: 1 } }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' }
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"text":"ok"}' }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' }
    ]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
    const client = new CompatModelClient({
      baseUrl: 'https://claude.example',
      apiKey: 'k',
      model: 'claude-sonnet-4-5',
      endpointFormat: 'messages',
      fetchImpl
    })
    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(buildRequest(new AbortController().signal))) {
      chunks.push(chunk)
    }

    expect(collectKinds(chunks)).toEqual([
      'assistant_text_delta',
      'tool_call_delta',
      'tool_call_complete',
      'usage',
      'completed'
    ])
    expect(chunks.find((chunk) => chunk.kind === 'tool_call_complete')).toMatchObject({
      callId: 'toolu_1',
      toolName: 'echo',
      arguments: { text: 'ok' }
    })
    expect(chunks.find((chunk) => chunk.kind === 'usage')).toMatchObject({
      usage: expect.objectContaining({ promptTokens: 5, completionTokens: 8, totalTokens: 13 })
    })
  })

it('does not inject body.thinking on non-DeepSeek host (issue #26)', async () => {
    const response = {
      id: 'r3',
      model: 'deepseek-chat',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
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
      baseUrl: 'https://openrouter.ai/api/v1',   // NOT api.deepseek.com
      apiKey: 'k',
      model: 'deepseek-v4-pro',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'deepseek-v4-pro'
    for await (const _chunk of client.stream(request)) {
      // drain
    }
    // The DeepSeek-specific `thinking` protocol extension must not be sent
    // to third-party OpenAI-compat providers — they may reject it. See issue #26.
    expect(sentBodies[0]).not.toHaveProperty('thinking')
  })

it('injects body.thinking on the official DeepSeek host (issue #26 regression guard)', async () => {
    const response = {
      id: 'r4',
      model: 'deepseek-chat',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
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
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-v4-pro',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'deepseek-v4-pro'
    for await (const _chunk of client.stream(request)) {
      // drain
    }
    // On the official host, the `thinking` field must still be set for v4 models.
    expect(sentBodies[0]).toHaveProperty('thinking')
    expect((sentBodies[0] as { thinking: { type: string } }).thinking).toMatchObject({ type: 'enabled' })
  })

it('sends per-request router controls when requested', async () => {
    const response = {
      id: 'router',
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"model":"deepseek-v4-pro","thinking":"max"}'
          }
        }
      ]
    }
    const sentBodies: Array<Record<string, unknown>> = []
    const sentAccept: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      sentAccept.push(String((init?.headers as Record<string, string>).Accept ?? ''))
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const client = new CompatModelClient({
      baseUrl: 'https://example.com/beta',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'deepseek-v4-flash'
    request.tools = []
    request.stream = false
    request.maxTokens = 96
    request.temperature = 0
    request.responseFormat = 'json_object'
    request.reasoningEffort = 'off'
    for await (const _chunk of client.stream(request)) {
      // drain
    }
    expect(sentAccept[0]).toBe('application/json')
    // Non-DeepSeek OpenAI-compat hosts must not receive DeepSeek-only `thinking`
    // (see compat-request-builder nativeDeepSeekHost scoping / issue #26).
    expect(sentBodies[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: false,
      max_tokens: 96,
      temperature: 0,
      response_format: { type: 'json_object' }
    })
    expect(sentBodies[0]).not.toHaveProperty('thinking')
  })

})
