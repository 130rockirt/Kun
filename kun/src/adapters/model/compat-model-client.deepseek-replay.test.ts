import { describe, expect, it } from 'vitest'
import {
  makeAssistantReasoningItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserItem
} from '../../domain/item.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import { CompatModelClient } from './compat-model-client.js'

describe('CompatModelClient DeepSeek replay boundary', () => {
  it('never sends a partially completed multi-tool assistant round to a strict DeepSeek server', async () => {
    const captured: Array<Record<string, unknown>> = []
    const client = strictDeepSeekClient(captured)
    const threadId = 'thread-replay'
    const priorTurnId = 'turn-prior'
    const chunks = await drain(client.stream({
      threadId,
      turnId: 'turn-current',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      prefix: [],
      history: [
        makeUserItem({ id: 'user-prior', threadId, turnId: priorTurnId, text: 'Inspect both files.' }),
        makeAssistantReasoningItem({
          id: 'reason-prior', threadId, turnId: priorTurnId, text: 'I need both files.', status: 'completed'
        }),
        makeToolCallItem({
          id: 'call-a', threadId, turnId: priorTurnId, callId: 'call-a', toolName: 'read_file',
          arguments: { path: 'a.ts' }, status: 'completed'
        }),
        makeToolCallItem({
          id: 'call-b', threadId, turnId: priorTurnId, callId: 'call-b', toolName: 'read_file',
          arguments: { path: 'b.ts' }, status: 'completed'
        }),
        makeToolResultItem({
          id: 'result-a', threadId, turnId: priorTurnId, callId: 'call-a', toolName: 'read_file',
          output: 'a', status: 'completed'
        })
      ],
      tools: [],
      abortSignal: new AbortController().signal
    }))

    expect(chunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
    expect(chunks.some((chunk) => chunk.kind === 'error')).toBe(false)
    const serialized = JSON.stringify(captured[0])
    expect(serialized).not.toContain('call-a')
    expect(serialized).not.toContain('call-b')
    expect(serialized).not.toContain('I need both files.')
  })

  it('replays a complete historical round only with its persisted same-route reasoning', async () => {
    const captured: Array<Record<string, unknown>> = []
    const client = strictDeepSeekClient(captured)
    const threadId = 'thread-replay-complete'
    const priorTurnId = 'turn-prior'
    const chunks = await drain(client.stream({
      threadId,
      turnId: 'turn-current',
      model: 'deepseek-v4-pro',
      providerId: 'default',
      reasoningEffort: 'high',
      prefix: [],
      history: [
        makeAssistantReasoningItem({
          id: 'reason-prior', threadId, turnId: priorTurnId, text: 'Read the file before answering.', status: 'completed'
        }),
        makeToolCallItem({
          id: 'call-a', threadId, turnId: priorTurnId, callId: 'call-a', toolName: 'read_file',
          arguments: { path: 'a.ts' }, status: 'completed'
        }),
        makeToolResultItem({
          id: 'result-a', threadId, turnId: priorTurnId, callId: 'call-a', toolName: 'read_file',
          output: 'a', status: 'completed'
        })
      ],
      historyRoutesByTurnId: {
        [priorTurnId]: { model: 'deepseek-v4-pro', providerId: 'default' }
      },
      tools: [],
      abortSignal: new AbortController().signal
    }))

    expect(chunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
    const messages = captured[0]?.messages as Array<Record<string, unknown>>
    expect(messages.find((message) => Array.isArray(message.tool_calls))).toMatchObject({
      reasoning_content: 'Read the file before answering.'
    })
  })
})

function strictDeepSeekClient(captured: Array<Record<string, unknown>>): CompatModelClient {
  return new CompatModelClient({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-v4-pro',
    endpointFormat: 'chat_completions',
    nonStreaming: true,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      captured.push(body)
      const violation = strictDeepSeekHistoryViolation(body.messages)
      if (violation) {
        return new Response(JSON.stringify({ error: { message: violation } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })
}

function strictDeepSeekHistoryViolation(messages: unknown): string | null {
  if (!Array.isArray(messages)) return 'messages must be an array'
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Record<string, unknown>
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (calls.length === 0) {
      if (message.role === 'tool') return 'orphan tool result'
      continue
    }
    if (typeof message.reasoning_content !== 'string' || !message.reasoning_content.trim()) {
      return 'tool-use assistant message is missing reasoning_content'
    }
    const callIds = calls.map((call) => (call as Record<string, unknown>).id)
    for (const callId of callIds) {
      const result = messages[++index] as Record<string, unknown> | undefined
      if (result?.role !== 'tool' || result.tool_call_id !== callId) {
        return `missing result for ${String(callId)}`
      }
    }
  }
  return null
}

async function drain(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
