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

it('groups completed multi-tool blocks into one assistant tool_calls message', async () => {
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
      makeToolCallItem({
        id: 'call_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        arguments: { text: 'a' },
        status: 'completed'
      }),
      makeToolCallItem({
        id: 'call_b',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_b',
        toolName: 'echo',
        arguments: { text: 'b' },
        status: 'completed'
      }),
      makeAssistantTextItem({
        id: 'assistant_bridge',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'I will run both checks.',
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        output: 'a'
      }),
      makeToolResultItem({
        id: 'result_b',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_b',
        toolName: 'echo',
        output: 'b'
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    const assistantToolMessage = messages.find((message) => Array.isArray(message.tool_calls))
    const toolMessages = messages.filter((message) => message.role === 'tool')

    expect(assistantToolMessage).toMatchObject({
      role: 'assistant',
      content: 'I will run both checks.'
    })
    expect((assistantToolMessage?.tool_calls as Array<{ id?: string }> | undefined)?.map((call) => call.id))
      .toEqual(['call_a', 'call_b'])
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call_a', 'call_b'])
  })

it('preserves thinking reasoning_content for completed tool-call blocks', async () => {
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
    request.reasoningEffort = 'high'
    request.history = [
      makeToolCallItem({
        id: 'call_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        arguments: { text: 'a' },
        status: 'completed'
      }),
      makeToolCallItem({
        id: 'call_b',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_b',
        toolName: 'echo',
        arguments: { text: 'b' },
        status: 'completed'
      }),
      makeAssistantReasoningItem({
        id: 'assistant_reasoning_bridge',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'I need to inspect the current changes before writing the commit message.',
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        output: 'a'
      }),
      makeToolResultItem({
        id: 'result_b',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_b',
        toolName: 'echo',
        output: 'b'
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    const assistantToolMessage = messages.find((message) => Array.isArray(message.tool_calls))

    expect(assistantToolMessage?.reasoning_content).toBe(
      'I need to inspect the current changes before writing the commit message.'
    )
    expect(assistantToolMessage?.content).toBe('')
    expect((assistantToolMessage?.tool_calls as Array<{ id?: string }> | undefined)?.map((call) => call.id))
      .toEqual(['call_a', 'call_b'])
    expect(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
      .toEqual(['call_a', 'call_b'])
  })

it('uses a single space for empty thinking reasoning_content', async () => {
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
    request.reasoningEffort = 'high'
    request.history = [
      makeAssistantTextItem({
        id: 'assistant_text',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'Done.',
        status: 'completed'
      }),
      makeToolCallItem({
        id: 'call_a',
        turnId: 'turn_2',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        arguments: { text: 'a' },
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result_a',
        turnId: 'turn_2',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        output: 'a'
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    const assistantTextMessage = messages.find((message) => message.role === 'assistant' && message.content === 'Done.')
    const assistantToolMessage = messages.find((message) => Array.isArray(message.tool_calls))

    expect(assistantTextMessage?.reasoning_content).toBe(' ')
    expect(assistantToolMessage?.reasoning_content).toBe(' ')
    expect(assistantToolMessage?.content).toBe('')
  })

it('treats fixed DeepSeek v4 models as thinking producers', async () => {
    const sentBodies: Array<{ messages?: Array<Record<string, unknown>>; thinking?: unknown; reasoning_effort?: unknown }> = []
    const response = {
      id: 'r1',
      model: 'deepseek-v4-pro',
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
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl,
      nonStreaming: true
    })
    const request = buildRequest(new AbortController().signal)
    request.model = 'deepseek-v4-pro'
    request.history = [
      makeAssistantTextItem({
        id: 'assistant_text',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'Done.',
        status: 'completed'
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const body = sentBodies[0]
    const assistantMessage = body?.messages?.find((message) => message.role === 'assistant')

    expect(body?.thinking).toEqual({ type: 'enabled' })
    expect(body?.reasoning_effort).toBeUndefined()
    expect(assistantMessage?.reasoning_content).toBe(' ')
  })

it('preserves thinking reasoning_content that appears before tool calls', async () => {
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
    request.reasoningEffort = 'high'
    request.history = [
      makeAssistantReasoningItem({
        id: 'assistant_reasoning_before_call',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'I should inspect git status before answering.',
        status: 'completed'
      }),
      makeAssistantTextItem({
        id: 'assistant_text_before_call',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'I will inspect the changes.',
        status: 'completed'
      }),
      makeToolCallItem({
        id: 'call_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        arguments: { text: 'a' },
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        output: 'a'
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const assistantToolMessage = sentBodies[0]?.messages?.find((message) => Array.isArray(message.tool_calls))
    const assistantMessages = sentBodies[0]?.messages?.filter((message) => message.role === 'assistant') ?? []

    expect(assistantMessages).toHaveLength(1)
    expect(assistantToolMessage?.content).toBe('I will inspect the changes.')
    expect(assistantToolMessage?.reasoning_content).toBe('I should inspect git status before answering.')
  })

it('serializes undefined tool outputs as empty string content', async () => {
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
      makeToolCallItem({
        id: 'call_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        arguments: { text: 'a' },
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result_a',
        turnId: 'turn_1',
        threadId: 'thr_1',
        callId: 'call_a',
        toolName: 'echo',
        output: undefined
      })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const toolMessage = sentBodies[0]?.messages?.find((message) => message.role === 'tool')

    expect(toolMessage?.content).toBe('')
  })

it('sends compaction summaries as mutable system messages', async () => {
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
      makeCompactionItem({
        id: 'compact_1',
        turnId: 'turn_1',
        threadId: 'thr_1',
        summary: 'User wants the login feature finished. Keep the auth files in scope.',
        replacedTokens: 123,
        pinnedConstraints: []
      }),
      makeUserItem({ id: 'user_after_compact', turnId: 'turn_2', threadId: 'thr_1', text: 'continue' })
    ]

    for await (const _chunk of client.stream(request)) {
      // drain
    }

    const messages = sentBodies[0]?.messages ?? []
    expect(messages[0]).toMatchObject({ role: 'system', content: 'You are a helpful assistant.' })
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('User wants the login feature finished')
    })
    expect(messages[2]).toMatchObject({ role: 'user', content: 'continue' })
  })

})
