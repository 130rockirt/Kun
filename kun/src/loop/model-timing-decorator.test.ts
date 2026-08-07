import { describe, expect, it } from 'vitest'
import type { ModelClient, ModelStreamChunk } from '../ports/model-client.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { withModelTiming } from './model-timing-decorator.js'

function makeClient(chunks: ModelStreamChunk[], clock: { value: number }): ModelClient {
  return {
    provider: 'test',
    model: 'test-model',
    async *stream() {
      for (const chunk of chunks) {
        // Simulate network/provider latency so the decorator observes
        // non-zero TTFT and generation durations.
        clock.value += 250
        yield chunk
      }
    }
  }
}

const usageChunk = (completionTokens = 10): ModelStreamChunk => ({
  kind: 'usage',
  usage: { ...emptyUsageSnapshot(), completionTokens, totalTokens: completionTokens }
})

async function drain(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const out: ModelStreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('withModelTiming', () => {
  it('attaches TTFT and generation duration to the usage chunk of a text stream', async () => {
    const clock = { value: 0 }
    const client = withModelTiming(makeClient([
      { kind: 'assistant_text_delta', text: 'a' },
      { kind: 'assistant_text_delta', text: 'b' },
      usageChunk(),
      { kind: 'completed', stopReason: 'stop' }
    ], clock), { now: () => clock.value })

    const chunks = await drain(client.stream({
      threadId: 't', turnId: 'turn', model: 'm', prefix: [], history: [],
      tools: [], abortSignal: new AbortController().signal
    }))
    const usage = chunks.find((chunk) => chunk.kind === 'usage')
    expect(usage).toBeDefined()
    if (usage && usage.kind === 'usage') {
      // First text chunk arrived at 250ms; usage at 750ms.
      expect(usage.usage.requestTtftMs).toBe(250)
      expect(usage.usage.requestGenerationMs).toBe(500)
    }
  })

  it('falls back to the first tool chunk for pure tool-call rounds', async () => {
    const clock = { value: 0 }
    const client = withModelTiming(makeClient([
      { kind: 'tool_call_complete', callId: 'call_1', toolName: 'read', arguments: {} },
      usageChunk(5),
      { kind: 'completed', stopReason: 'tool_calls' }
    ], clock), { now: () => clock.value })

    const chunks = await drain(client.stream({
      threadId: 't', turnId: 'turn', model: 'm', prefix: [], history: [],
      tools: [], abortSignal: new AbortController().signal
    }))
    const usage = chunks.find((chunk) => chunk.kind === 'usage')
    if (usage && usage.kind === 'usage') {
      expect(usage.usage.requestTtftMs).toBe(250)
      expect(usage.usage.requestGenerationMs).toBe(250)
    }
  })

  it('passes streams without a usage chunk through unchanged', async () => {
    const clock = { value: 0 }
    const client = withModelTiming(makeClient([
      { kind: 'assistant_text_delta', text: 'hello' },
      { kind: 'completed', stopReason: 'stop' }
    ], clock), { now: () => clock.value })

    const chunks = await drain(client.stream({
      threadId: 't', turnId: 'turn', model: 'm', prefix: [], history: [],
      tools: [], abortSignal: new AbortController().signal
    }))
    expect(chunks).toEqual([
      { kind: 'assistant_text_delta', text: 'hello' },
      { kind: 'completed', stopReason: 'stop' }
    ])
  })

  it('does not time a stream that errors before any content chunk', async () => {
    const clock = { value: 0 }
    const client = withModelTiming(makeClient([
      { kind: 'error', message: 'boom' }
    ], clock), { now: () => clock.value })

    const chunks = await drain(client.stream({
      threadId: 't', turnId: 'turn', model: 'm', prefix: [], history: [],
      tools: [], abortSignal: new AbortController().signal
    }))
    expect(chunks).toEqual([{ kind: 'error', message: 'boom' }])
  })

  it('preserves chunk metadata such as route identity', async () => {
    const clock = { value: 0 }
    const route = { routePoolId: 'p', targetId: 'x', providerId: 'prov', modelId: 'm', requestedModelId: 'alias' }
    const client = withModelTiming(makeClient([
      { kind: 'assistant_text_delta', text: 'a' },
      { ...usageChunk(), route }
    ], clock), { now: () => clock.value })

    const chunks = await drain(client.stream({
      threadId: 't', turnId: 'turn', model: 'm', prefix: [], history: [],
      tools: [], abortSignal: new AbortController().signal
    }))
    const usage = chunks.find((chunk) => chunk.kind === 'usage')
    expect(usage?.route).toEqual({ routePoolId: 'p', targetId: 'x', providerId: 'prov', modelId: 'm', requestedModelId: 'alias' })
  })
})
