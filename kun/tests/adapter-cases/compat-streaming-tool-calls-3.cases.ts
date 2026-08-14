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
