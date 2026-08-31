import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import type { SessionStore } from '../ports/session-store.js'
import { LlmDebugRecorder } from './llm-debug-recorder.js'
import { TrajectoryQueryService } from './trajectory-query-service.js'

describe('TrajectoryQueryService', () => {
  it('joins model attempts with canonical tool and message items', async () => {
    const recorder = new LlmDebugRecorder()
    const round = recorder.start({
      threadId: 'thread-1', turnId: 'turn-1', provider: 'test', model: 'gpt-test',
      roundId: 'round-1', step: 2, captureContent: false
    })
    const request = recorder.beginHttpAttempt(round, {
      endpointFormat: 'chat_completions', attempt: 1, reason: 'initial',
      url: 'https://provider.example/v1/chat/completions', headers: {}, bodyText: '{"secret":"not-stored"}'
    })
    recorder.captureChunk(round, { kind: 'assistant_text_delta', text: 'done' })
    recorder.captureChunk(round, {
      kind: 'usage',
      usage: {
        promptTokens: 100, completionTokens: 20, totalTokens: 120,
        cacheHitTokens: 80, cacheHitRate: 0.8, turns: 1,
        requestTtftMs: 25, requestGenerationMs: 500
      }
    })
    recorder.captureChunk(round, { kind: 'completed', stopReason: 'tool_calls' })
    await recorder.finish(round)

    const items: TurnItem[] = [
      {
        id: 'user-1', kind: 'user_message', threadId: 'thread-1', turnId: 'turn-1',
        role: 'user', status: 'completed', createdAt: request.startedAt, text: 'fix it'
      },
      {
        id: 'tool-call-1', kind: 'tool_call', threadId: 'thread-1', turnId: 'turn-1',
        role: 'assistant', status: 'completed', createdAt: request.startedAt,
        callId: 'call-1', toolName: 'read', toolKind: 'tool_call', arguments: { path: 'src/a.ts' }
      },
      {
        id: 'tool-result-1', kind: 'tool_result', threadId: 'thread-1', turnId: 'turn-1',
        role: 'tool', status: 'completed', createdAt: new Date(Date.parse(request.startedAt) + 10).toISOString(),
        callId: 'call-1', toolName: 'read', toolKind: 'tool_call', output: 'ok', isError: false
      }
    ]
    const sessions = { loadItems: async () => items } as unknown as SessionStore
    const service = new TrajectoryQueryService(recorder, sessions)
    const page = await service.page('thread-1', { limit: 20, filter: 'all', query: '' })

    expect(page.records.some((record) => record.kind === 'llm_request' && record.step === 2)).toBe(true)
    expect(page.records).toContainEqual(expect.objectContaining({
      kind: 'tool', callId: 'call-1', status: 'completed', resultItemId: 'tool-result-1'
    }))
    expect(page.summary).toMatchObject({ requestCount: 1, toolCount: 1, inputTokens: 100 })
    const input = await service.detail('thread-1', `request:${request.id}`, 'input')
    expect(input).toMatchObject({ state: 'not_captured' })
    const output = await service.detail('thread-1', `request:${request.id}`, 'output')
    expect(JSON.stringify(output)).toContain('tool-result-1')
  })
})
