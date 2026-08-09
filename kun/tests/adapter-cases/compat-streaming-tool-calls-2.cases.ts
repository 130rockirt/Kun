import { describe, expect, it } from 'vitest'

import { CompatModelClient, type ModelStreamLimits } from '../../src/adapters/model/compat-model-client.js'

import {
  ModelStreamResourceBudget,
  ModelStreamResourceStateError,
  TOOL_ARGUMENT_PART_COMPACTION_WINDOW,
  type PendingToolCall
} from '../../src/adapters/model/model-stream-resource-budget.js'

import type { ModelCapabilityMetadata } from '../../src/contracts/capabilities.js'

import type { ModelRequest, ModelStreamChunk } from '../../src/ports/model-client.js'

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

function makeResponsesClient(frames: string[]): CompatModelClient {
  return new CompatModelClient({
    baseUrl: 'https://provider.example/v1/responses',
    apiKey: 'sk-test',
    model: 'test-model',
    endpointFormat: 'responses',
    fetchImpl: streamingFetch(frames)
  })
}

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
