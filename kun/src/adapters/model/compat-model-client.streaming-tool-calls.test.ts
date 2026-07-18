import { describe, expect, it } from 'vitest'
import { CompatModelClient, type ModelStreamLimits } from './compat-model-client.js'
import {
  ModelStreamResourceBudget,
  ModelStreamResourceStateError,
  TOOL_ARGUMENT_PART_COMPACTION_WINDOW,
  type PendingToolCall
} from './model-stream-resource-budget.js'
import type { ModelCapabilityMetadata } from '../../contracts/capabilities.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'

// These tests exercise the REAL streaming SSE path (`streamSse` /
// `consumeStreamPayload`), which had no coverage before. They lock in the fix
// for the silent tool-call drop: the chat_completions branch only finalized on
// `finish_reason === 'tool_calls'`, so a provider ending with 'stop', 'length',
// or a bare `[DONE]` while a tool call was pending dropped it entirely.

type CapturedCall = { url: string; body: Record<string, unknown> }

function sseResponse(
  frames: string[],
  options: { close?: boolean; onCancel?: (reason: unknown) => void } = {}
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      if (options.close !== false) controller.close()
    },
    cancel(reason) {
      options.onCancel?.(reason)
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamingFetch(
  frames: string[],
  calls: CapturedCall[] = [],
  responseOptions: { close?: boolean; onCancel?: (reason: unknown) => void } = {}
): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
    return sseResponse(frames, responseOptions)
  }) as unknown as typeof fetch
}

function capability(overrides: Partial<ModelCapabilityMetadata> = {}): (model: string) => ModelCapabilityMetadata {
  return (model) => ({
    id: model,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text'],
    ...overrides
  })
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    threadId: 't1',
    turnId: 'u1',
    model: 'test-model',
    systemPrompt: 'You are a helpful assistant.',
    prefix: [],
    history: [],
    tools: [{ name: 'edit', description: 'edit a file', inputSchema: { type: 'object' } }],
    abortSignal: new AbortController().signal,
    ...overrides
  }
}

async function drain(iterable: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function toolCallCompletes(
  chunks: ModelStreamChunk[]
): Extract<ModelStreamChunk, { kind: 'tool_call_complete' }>[] {
  return chunks.filter(
    (c): c is Extract<ModelStreamChunk, { kind: 'tool_call_complete' }> =>
      c.kind === 'tool_call_complete'
  )
}

function completed(chunks: ModelStreamChunk[]): Extract<ModelStreamChunk, { kind: 'completed' }> {
  const last = chunks.at(-1)
  if (!last || last.kind !== 'completed') throw new Error('stream did not end with completed')
  return last
}

function expectResourceLimit(chunk: ModelStreamChunk | undefined, messagePrefix: string): void {
  expect(chunk).toMatchObject({ kind: 'error', code: 'stream_resource_limit' })
  if (!chunk || chunk.kind !== 'error') throw new Error('expected stream resource error')
  expect(chunk.message).toMatch(new RegExp(`^${messagePrefix}`))
  expect(chunk.message).toContain('responseBytes=')
  expect(chunk.message).toContain('frames=')
  expect(chunk.message).toContain('pendingToolCalls=')
  expect(chunk.message).toContain('pendingArgumentBytes=')
  expect(chunk.message).toContain('pendingArgumentFragments=')
}

function chatToolDelta(d: { index: number; id?: string; name?: string; args?: string }): string {
  const fn: Record<string, unknown> = {}
  if (d.name !== undefined) fn.name = d.name
  if (d.args !== undefined) fn.arguments = d.args
  const call: Record<string, unknown> = { index: d.index, function: fn }
  if (d.id !== undefined) call.id = d.id
  return frame({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })
}

function chatFinish(reason: string): string {
  return frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
}

// A two-part chat_completions tool-call stream. The args split across deltas so
// the test also covers index-based continuation accumulation.
function chatToolCallDeltas(): string[] {
  return [
    chatToolDelta({ index: 0, id: 'call_1', name: 'edit', args: '{"path":' }),
    chatToolDelta({ index: 0, args: '"a.txt"}' })
  ]
}

function makeClient(
  fetchImpl: typeof fetch,
  modelCapabilities?: (model: string) => ModelCapabilityMetadata,
  streamLimits?: Partial<ModelStreamLimits>
) {
  return new CompatModelClient({
    baseUrl: 'https://provider.example/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'test-model',
    endpointFormat: 'chat_completions',
    fetchImpl,
    ...(modelCapabilities ? { modelCapabilities } : {}),
    ...(streamLimits ? { streamLimits } : {})
  })
}

describe('CompatModelClient streaming tool-call finalization', () => {
  it('accepts CRLF-delimited SSE frames', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] })}\r\n\r\n`
    ]
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    expect(chunks).toEqual(expect.arrayContaining([{ kind: 'assistant_text_delta', text: 'hello' }]))
    expect(completed(chunks).stopReason).toBe('stop')
  })

  it('reports malformed or truncated SSE instead of completing a partial response', async () => {
    const malformed = await drain(makeClient(streamingFetch(['data: {bad-json}\n\n'])).stream(request()))
    expect(malformed).toEqual([{ kind: 'error', message: 'model stream contained invalid SSE JSON', code: 'stream_invalid_frame' }])

    const truncated = await drain(makeClient(streamingFetch([
      frame({ choices: [{ index: 0, delta: { content: 'partial' } }] })
    ])).stream(request()))
    expect(truncated).toEqual([
      { kind: 'assistant_text_delta', text: 'partial' },
      { kind: 'error', message: 'model stream ended before a terminal frame', code: 'stream_truncated' }
    ])
  })

  it('emits a tool call when chat_completions ends with finish_reason "tool_calls" (no double emit)', async () => {
    const frames = [...chatToolCallDeltas(), chatFinish('tool_calls'), 'data: [DONE]\n\n']
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    const calls = toolCallCompletes(chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolName).toBe('edit')
    expect(calls[0].arguments).toEqual({ path: 'a.txt' })
    expect(completed(chunks).stopReason).toBe('tool_calls')
  })

  it('recovers a tool call the provider mislabeled as finish_reason "stop"', async () => {
    // Regression: previously dropped silently because finishReason !== 'tool_calls'.
    const frames = [...chatToolCallDeltas(), chatFinish('stop'), 'data: [DONE]\n\n']
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    const calls = toolCallCompletes(chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ path: 'a.txt' })
    // A recovered call means it was really a tool-call turn.
    expect(completed(chunks).stopReason).toBe('tool_calls')
  })

  it('recovers a tool call when the stream ends with a bare [DONE] and no finish_reason', async () => {
    const frames = [...chatToolCallDeltas(), 'data: [DONE]\n\n']
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    expect(toolCallCompletes(chunks)).toHaveLength(1)
    expect(completed(chunks).stopReason).toBe('tool_calls')
  })

  it('surfaces truncated arguments as __raw (instead of dropping) on finish_reason "length"', async () => {
    // Only the first (incomplete) delta arrives, then the model hits its cap.
    const frames = [
      chatToolDelta({ index: 0, id: 'call_1', name: 'edit', args: '{"path":' }),
      chatFinish('length'),
      'data: [DONE]\n\n'
    ]
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    const calls = toolCallCompletes(chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toHaveProperty('__raw', '{"path":')
    // Truncation stays visible as 'length' so the loop can warn the user.
    expect(completed(chunks).stopReason).toBe('length')
  })

  it('does not emit a tool call when no tool deltas were streamed', async () => {
    const frames = [
      frame({ choices: [{ index: 0, delta: { content: 'hello' } }] }),
      chatFinish('stop'),
      'data: [DONE]\n\n'
    ]
    const chunks = await drain(makeClient(streamingFetch(frames)).stream(request()))
    expect(toolCallCompletes(chunks)).toHaveLength(0)
    expect(completed(chunks).stopReason).toBe('stop')
  })

  it('recovers an Anthropic Messages tool_use block cut off before content_block_stop', async () => {
    const frames = [
      frame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } }),
      // No content_block_stop — stream is cut off, then the message ends.
      frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      frame({ type: 'message_stop' })
    ]
    const client = new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch(frames)
    })
    const chunks = await drain(client.stream(request()))
    const calls = toolCallCompletes(chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolName).toBe('edit')
    expect(calls[0].arguments).toEqual({ path: 'a.txt' })
  })
})

describe('CompatModelClient streaming resource limits', () => {
  it('cancels an unterminated SSE frame once its buffered bytes exceed the limit', async () => {
    const cancellations: unknown[] = []
    const chunks = await drain(makeClient(
      streamingFetch([`data: ${'x'.repeat(128)}`], [], {
        close: false,
        onCancel: (reason) => cancellations.push(reason)
      }),
      undefined,
      { maxBufferBytes: 64, maxFrameBytes: 512, maxTotalBytes: 512 }
    ).stream(request()))

    expect(chunks).toHaveLength(1)
    expectResourceLimit(chunks[0], 'model stream exceeded 64 buffered SSE bytes')
    expect(cancellations).not.toHaveLength(0)
  })

  it('rejects oversized delimited frames and frame storms before parsing their payloads', async () => {
    const oversized = await drain(makeClient(
      streamingFetch([frame({ choices: [{ index: 0, delta: { content: 'x'.repeat(256) } }] })]),
      undefined,
      { maxBufferBytes: 4_096, maxFrameBytes: 128, maxTotalBytes: 4_096 }
    ).stream(request()))
    expect(oversized).toHaveLength(1)
    expectResourceLimit(oversized[0], 'model stream exceeded 128 SSE frame bytes')

    const frameStorm = await drain(makeClient(
      streamingFetch([': keepalive\n\n', ': keepalive\n\n']),
      undefined,
      { maxFrames: 1, maxBufferBytes: 4_096, maxFrameBytes: 4_096, maxTotalBytes: 4_096 }
    ).stream(request()))
    expect(frameStorm).toHaveLength(1)
    expectResourceLimit(frameStorm[0], 'model stream exceeded 1 SSE frames')
  })

  it('bounds cumulative emitted text without completing a partial response', async () => {
    const chunks = await drain(makeClient(
      streamingFetch([
        frame({ choices: [{ index: 0, delta: { content: 'abc' } }] }),
        frame({ choices: [{ index: 0, delta: { content: 'defg' } }] })
      ]),
      undefined,
      { maxOutputBytes: 6, maxBufferBytes: 4_096, maxFrameBytes: 4_096, maxTotalBytes: 4_096 }
    ).stream(request()))

    expect(chunks[0]).toEqual({ kind: 'assistant_text_delta', text: 'abc' })
    expect(chunks).toHaveLength(2)
    expectResourceLimit(chunks[1], 'model stream exceeded 6 response text and reasoning bytes')
  })

  it('applies raw argument limits before Chat, Responses, or Messages tool calls complete', async () => {
    const limits = {
      maxPendingToolArgumentBytes: 8,
      maxBufferBytes: 4_096,
      maxFrameBytes: 4_096,
      maxTotalBytes: 4_096
    }
    const chat = await drain(makeClient(
      streamingFetch([chatToolDelta({ index: 0, id: 'chat_1', name: 'edit', args: 'x'.repeat(9) })]),
      undefined,
      limits
    ).stream(request()))
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatchObject({ kind: 'error', code: 'stream_resource_limit' })
    if (chat[0].kind !== 'error') throw new Error('expected stream resource error')
    expect(chat[0].message).toMatch(/^model stream exceeded 8 bytes for one tool argument/)
    expect(chat[0].message).toContain('tool=edit')
    expect(chat[0].message).toContain('argumentBytes=9')
    expect(chat[0].message).toContain('fragments=1')
    expect(chat[0].message).not.toContain('xxxxxxxxx')

    const responsesClient = new CompatModelClient({
      baseUrl: 'https://provider.example/v1/responses',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'responses',
      fetchImpl: streamingFetch([frame({
        type: 'response.function_call_arguments.done',
        call_id: 'response_1',
        output_index: 0,
        arguments: 'x'.repeat(9)
      })]),
      streamLimits: limits
    })
    const responses = await drain(responsesClient.stream(request({})))
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ kind: 'error', code: 'stream_resource_limit' })
    if (responses[0].kind !== 'error') throw new Error('expected stream resource error')
    expect(responses[0].message).toContain('argumentBytes=9')

    const messagesClient = new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch([
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'msg_1', name: 'edit' } }),
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(9) } })
      ]),
      streamLimits: limits
    })
    const messages = await drain(messagesClient.stream(request()))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'error', code: 'stream_resource_limit' })
    if (messages[0].kind !== 'error') throw new Error('expected stream resource error')
    expect(messages[0].message).toContain('tool=edit')
    expect(messages[0].message).toContain('argumentBytes=9')
  })

  it('caps pending call cardinality while accepting highly fragmented arguments', async () => {
    const calls = await drain(makeClient(
      streamingFetch([
        chatToolDelta({ index: 0, id: 'call_1', name: 'edit' }),
        chatToolDelta({ index: 1, id: 'call_2', name: 'edit' })
      ]),
      undefined,
      { maxPendingToolCalls: 1, maxBufferBytes: 4_096, maxFrameBytes: 4_096, maxTotalBytes: 4_096 }
    ).stream(request()))
    expect(calls).toHaveLength(1)
    expectResourceLimit(calls[0], 'model stream exceeded 1 pending tool calls')

    const argumentValue = 'x'.repeat(1_100)
    const frames = [chatToolDelta({ index: 0, id: 'call_1', name: 'edit', args: '{"value":"' })]
    frames.push(...[...argumentValue].map((args) => chatToolDelta({ index: 0, args })))
    frames.push(chatToolDelta({ index: 0, args: '"}' }), chatFinish('tool_calls'))
    const fragments = await drain(makeClient(
      streamingFetch(frames),
      undefined,
      { maxBufferBytes: 16_384, maxFrameBytes: 4_096, maxTotalBytes: 512_000 }
    ).stream(request()))
    expect(toolCallCompletes(fragments)).toEqual([{
      kind: 'tool_call_complete',
      callId: 'call_1',
      toolName: 'edit',
      arguments: { value: argumentValue }
    }])
    expect(completed(fragments).stopReason).toBe('tool_calls')
  })

  it('accepts more than 1,024 Responses argument deltas', async () => {
    const argumentValue = 'y'.repeat(1_100)
    const frames = [frame({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'response_1', name: 'edit' }
    })]
    frames.push(...[...`{"value":"${argumentValue}"}`].map((delta) => frame({
      type: 'response.function_call_arguments.delta',
      call_id: 'response_1',
      output_index: 0,
      delta
    })))
    frames.push(frame({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', call_id: 'response_1', name: 'edit' }
    }), frame({ type: 'response.completed', response: { status: 'completed', output: [] } }))
    const client = new CompatModelClient({
      baseUrl: 'https://provider.example/v1/responses',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'responses',
      fetchImpl: streamingFetch(frames),
      streamLimits: { maxBufferBytes: 16_384, maxFrameBytes: 4_096, maxTotalBytes: 512_000 }
    })
    const chunks = await drain(client.stream(request()))
    expect(toolCallCompletes(chunks)).toEqual([{
      kind: 'tool_call_complete',
      callId: 'response_1',
      toolName: 'edit',
      arguments: { value: argumentValue }
    }])
    expect(completed(chunks).stopReason).toBe('tool_calls')
  })

  it('accepts more than 1,024 Anthropic Messages argument deltas', async () => {
    const argumentValue = 'z'.repeat(1_100)
    const frames = [frame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'message_1', name: 'edit' }
    })]
    frames.push(...[...`{"value":"${argumentValue}"}`].map((partial_json) => frame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json }
    })))
    frames.push(
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }),
      frame({ type: 'message_stop' })
    )
    const client = new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch(frames),
      streamLimits: { maxBufferBytes: 16_384, maxFrameBytes: 4_096, maxTotalBytes: 512_000 }
    })
    const chunks = await drain(client.stream(request()))
    expect(toolCallCompletes(chunks)).toEqual([{
      kind: 'tool_call_complete',
      callId: 'message_1',
      toolName: 'edit',
      arguments: { value: argumentValue }
    }])
    expect(completed(chunks).stopReason).toBe('tool_calls')
  })

  it('does not downgrade an Anthropic max_tokens terminal at message_stop', async () => {
    const client = new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch([
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial answer' }
        }),
        frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} }),
        frame({ type: 'message_stop' })
      ])
    })

    const chunks = await drain(client.stream(request()))

    expect(completed(chunks).stopReason).toBe('length')
  })

  it('preserves Anthropic length and error terminals after completed tool blocks', async () => {
    const toolFrames = [
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'message_1', name: 'edit' }
      }),
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' }
      }),
      frame({ type: 'content_block_stop', index: 0 })
    ]
    const makeMessagesClient = (terminalFrames: string[]) => new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch([...toolFrames, ...terminalFrames])
    })

    const lengthChunks = await drain(makeMessagesClient([
      frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} }),
      frame({ type: 'message_stop' })
    ]).stream(request()))
    expect(toolCallCompletes(lengthChunks)).toHaveLength(1)
    expect(completed(lengthChunks).stopReason).toBe('length')

    const errorChunks = await drain(makeMessagesClient([
      frame({ type: 'error', error: { message: 'provider refused' } }),
      frame({ type: 'message_stop' })
    ]).stream(request()))
    expect(toolCallCompletes(errorChunks)).toHaveLength(1)
    expect(errorChunks).toContainEqual(expect.objectContaining({ kind: 'error' }))
    expect(completed(errorChunks).stopReason).toBe('error')
  })

  it('compacts retained argument parts without changing reconstructed JSON', () => {
    const budget = new ModelStreamResourceBudget({
      maxBufferBytes: 1_000_000,
      maxFrameBytes: 1_000_000,
      maxTotalBytes: 1_000_000,
      maxFrames: 65_536,
      maxOutputBytes: 1_000_000,
      maxPendingToolCalls: 32,
      maxPendingToolArgumentBytes: 1_000_000,
      maxTotalPendingToolArgumentBytes: 1_000_000,
      maxCompletedToolCalls: 32,
      maxCompletedToolArgumentBytes: 1_000_000
    })
    const pendingCalls = new Map<string, PendingToolCall>()
    const pending = budget.pendingCall(pendingCalls, 'call-1', 0)
    pending.name = 'edit'
    for (let index = 0; index < 5_000; index += 1) budget.appendArguments(pending, 'x')
    expect(pending.argumentFragments).toBe(5_000)
    expect(pending.argumentParts.length).toBeLessThanOrEqual(TOOL_ARGUMENT_PART_COMPACTION_WINDOW)
    expect(pending.argumentBlocks?.length).toBeGreaterThan(1)
    expect(budget.pendingArguments(pending)).toBe('x'.repeat(5_000))
  })

  it('releases pending argument capacity exactly once', () => {
    const budget = new ModelStreamResourceBudget({
      maxBufferBytes: 1_000,
      maxFrameBytes: 1_000,
      maxTotalBytes: 1_000,
      maxFrames: 100,
      maxOutputBytes: 1_000,
      maxPendingToolCalls: 2,
      maxPendingToolArgumentBytes: 4,
      maxTotalPendingToolArgumentBytes: 4,
      maxCompletedToolCalls: 2,
      maxCompletedToolArgumentBytes: 8
    })
    const pendingCalls = new Map<string, PendingToolCall>()
    const first = budget.pendingCall(pendingCalls, 'first', 0)
    budget.appendArguments(first, '1234')

    expect(budget.removePendingCall(pendingCalls, 'first')).toBe(first)
    expect(budget.removePendingCall(pendingCalls, 'first')).toBeUndefined()

    const second = budget.pendingCall(pendingCalls, 'second', 1)
    expect(() => budget.appendArguments(second, '1234')).not.toThrow()
  })

  it('fails closed instead of hiding corrupted pending counters', () => {
    const budget = new ModelStreamResourceBudget({
      maxBufferBytes: 1_000,
      maxFrameBytes: 1_000,
      maxTotalBytes: 1_000,
      maxFrames: 100,
      maxOutputBytes: 1_000,
      maxPendingToolCalls: 2,
      maxPendingToolArgumentBytes: 8,
      maxTotalPendingToolArgumentBytes: 8,
      maxCompletedToolCalls: 2,
      maxCompletedToolArgumentBytes: 8
    })
    const pendingCalls = new Map<string, PendingToolCall>()
    const pending = budget.pendingCall(pendingCalls, 'call-1', 0)
    budget.appendArguments(pending, '{}')
    pending.argumentBytes += 1

    expect(() => budget.removePendingCall(pendingCalls, 'call-1'))
      .toThrow(ModelStreamResourceStateError)
    expect(pendingCalls.has('call-1')).toBe(true)
  })

  it('bounds and sanitizes provider-controlled tool names in limit diagnostics', () => {
    const budget = new ModelStreamResourceBudget({
      maxBufferBytes: 1_000,
      maxFrameBytes: 1_000,
      maxTotalBytes: 1_000,
      maxFrames: 100,
      maxOutputBytes: 1_000,
      maxPendingToolCalls: 2,
      maxPendingToolArgumentBytes: 1,
      maxTotalPendingToolArgumentBytes: 2,
      maxCompletedToolCalls: 2,
      maxCompletedToolArgumentBytes: 2
    })
    const pendingCalls = new Map<string, PendingToolCall>()
    const pending = budget.pendingCall(pendingCalls, 'call-1', 0)
    pending.name = `edit\n${'x'.repeat(10_000)}SECRET_TAIL`

    let message = ''
    try {
      budget.appendArguments(pending, 'xx')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/^model stream exceeded 1 bytes for one tool argument/)
    expect(message).not.toContain('\n')
    expect(message).not.toContain('SECRET_TAIL')
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(1_024)
  })

  it('uses the same body ceiling for application/json fallback responses', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ choices: [{ index: 0, message: { content: 'x'.repeat(256) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch
    const chunks = await drain(makeClient(
      fetchImpl,
      undefined,
      { maxTotalBytes: 64, maxBufferBytes: 4_096, maxFrameBytes: 4_096 }
    ).stream(request()))
    expect(chunks).toEqual([{
      kind: 'error',
      message: 'model response exceeded 64 bytes',
      code: 'stream_resource_limit'
    }])
  })
})

describe('CompatModelClient output-token cap', () => {
  function captureMessagesBody(
    cap: (model: string) => ModelCapabilityMetadata,
    req: Partial<ModelRequest> = {}
  ): Promise<Record<string, unknown>> {
    const calls: CapturedCall[] = []
    const frames = [frame({ type: 'message_start', message: { usage: {} } }), frame({ type: 'message_stop' })]
    const client = new CompatModelClient({
      baseUrl: 'https://provider.example/anthropic',
      apiKey: 'sk-test',
      model: 'test-model',
      endpointFormat: 'messages',
      fetchImpl: streamingFetch(frames, calls),
      modelCapabilities: cap
    })
    return drain(client.stream(request(req))).then(() => calls[0].body)
  }

  it('gives reasoning (anthropic-thinking) models a large messages max_tokens default', async () => {
    const body = await captureMessagesBody(
      capability({ reasoning: { supportedEfforts: ['auto', 'off'], defaultEffort: 'auto', requestProtocol: 'anthropic-thinking' } }),
      { reasoningEffort: 'auto' }
    )
    expect(body.max_tokens).toBe(32_768)
  })

  it('uses the smaller messages default for non-reasoning models', async () => {
    const body = await captureMessagesBody(capability())
    expect(body.max_tokens).toBe(8_192)
  })

  it('lets a per-model maxOutputTokens capability override the default', async () => {
    const body = await captureMessagesBody(
      capability({
        maxOutputTokens: 5_000,
        reasoning: { supportedEfforts: ['auto', 'off'], defaultEffort: 'auto', requestProtocol: 'anthropic-thinking' }
      }),
      { reasoningEffort: 'auto' }
    )
    expect(body.max_tokens).toBe(5_000)
  })

  it('lets an explicit request.maxTokens win over everything', async () => {
    const body = await captureMessagesBody(capability({ maxOutputTokens: 5_000 }), { maxTokens: 1_234 })
    expect(body.max_tokens).toBe(1_234)
  })
})
