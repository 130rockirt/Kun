import { describe, expect, it } from 'vitest'
import {
  parseModelRequestTracePage,
  parseModelRequestTracePageJson
} from './model-request-traces'

function record(id = 'trace-1') {
  return {
    schemaVersion: 1,
    id,
    sequence: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    endpointFormat: 'openai-chat',
    attempt: 1,
    attemptReason: 'initial',
    status: 'completed',
    startedAt: '2026-07-20T01:02:03.000Z',
    finishedAt: '2026-07-20T01:02:03.100Z',
    durationMs: 100,
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      urlRedacted: false,
      headers: {
        values: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        redactedNames: ['authorization']
      },
      body: {
        text: '{"model":"deepseek-chat"}',
        capturedBytes: 25,
        originalBytes: 25,
        truncated: false
      }
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { values: { 'content-type': 'text/event-stream' }, redactedNames: [] },
      body: {
        text: 'data: {"choices":[]}\n\n',
        capturedBytes: 22,
        originalBytes: 22,
        truncated: false
      }
    },
    decoded: {
      text: 'hello',
      reasoning: '',
      toolCalls: [],
      toolResults: [{
        callId: 'call-1',
        toolName: 'read_file',
        output: 'done',
        isError: false
      }],
      usage: { inputTokens: 12 }
    }
  }
}

function page(records: unknown[] = [record()]) {
  return {
    schemaVersion: 1,
    records,
    nextCursor: 'opaque-cursor',
    activeCount: 0,
    limits: {
      maxRequestBodyBytes: 4_194_304,
      maxResponseBodyBytes: 4_194_304,
      maxPageSize: 200
    },
    warnings: []
  }
}

describe('model request trace renderer contract', () => {
  it('parses the bounded wire exchange without discarding redaction and raw stream metadata', () => {
    const parsed = parseModelRequestTracePageJson(JSON.stringify(page()))
    expect(parsed.records[0]).toMatchObject({
      id: 'trace-1',
      attemptReason: 'initial',
      request: {
        headers: {
          values: { authorization: '[REDACTED]' },
          redactedNames: ['authorization']
        }
      },
      response: { status: 200 },
      decoded: {
        text: 'hello',
        toolResults: [{ callId: 'call-1', output: 'done' }]
      }
    })
    expect(parsed.records[0]?.response?.body?.text).toContain('data:')
  })

  it('fails closed for unsupported versions, methods, and oversized pages', () => {
    expect(() => parseModelRequestTracePage({ ...page(), schemaVersion: 2 }))
      .toThrow('unsupported model request trace schema')
    expect(() => parseModelRequestTracePage(page([
      { ...record(), request: { ...record().request, method: 'GET' } }
    ]))).toThrow('request.method is invalid')
    expect(() => parseModelRequestTracePage(page(
      Array.from({ length: 201 }, (_, index) => record(`trace-${index}`))
    ))).toThrow('bounded array')
  })

  it('accepts delegated CLI model requests without inventing an HTTP response', () => {
    const parsed = parseModelRequestTracePage(page([{
      ...record(),
      transport: 'cli',
      endpointFormat: 'antigravity-cli',
      request: {
        ...record().request,
        method: 'CLI',
        url: 'antigravity-cli://local/print',
        headers: { values: {}, redactedNames: [] }
      },
      response: undefined
    }]))

    expect(parsed.records[0]).toMatchObject({
      transport: 'cli',
      endpointFormat: 'antigravity-cli',
      request: {
        method: 'CLI',
        url: 'antigravity-cli://local/print'
      }
    })
    expect(parsed.records[0].response).toBeUndefined()
  })

  it('accepts delegated SDK model requests without labeling them as HTTP or CLI', () => {
    const parsed = parseModelRequestTracePage(page([{
      ...record(),
      transport: 'sdk',
      endpointFormat: 'cursor-sdk',
      request: {
        ...record().request,
        method: 'SDK',
        url: 'cursor-sdk://local/agent',
        headers: { values: {}, redactedNames: [] }
      },
      response: undefined,
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'rebased',
        reason: 'native_state_unavailable',
        contextManagement: 'sdk-managed',
        nativeHistory: 'none',
        capabilities: {
          nativeResume: true,
          structuredStreaming: true,
          kunTools: true,
          externalApproval: true,
          liveSteering: false,
          nativeContextTelemetry: false,
          fork: false
        }
      }
    }]))

    expect(parsed.records[0]).toMatchObject({
      transport: 'sdk',
      endpointFormat: 'cursor-sdk',
      request: {
        method: 'SDK',
        url: 'cursor-sdk://local/agent'
      },
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'rebased',
        reason: 'native_state_unavailable',
        nativeHistory: 'none'
      }
    })
    expect(parsed.records[0].response).toBeUndefined()
  })

  it('rejects malformed delegated capabilities instead of guessing support', () => {
    expect(() => parseModelRequestTracePage(page([{
      ...record(),
      delegated: {
        providerKind: 'cursor-sdk',
        phase: 'resumed',
        contextManagement: 'sdk-managed',
        nativeHistory: 'unknown',
        capabilities: { nativeResume: true }
      }
    }]))).toThrow('capabilities.structuredStreaming')
  })

  it('rejects malformed JSON and unbounded header values', () => {
    expect(() => parseModelRequestTracePageJson('{')).toThrow('invalid model request trace JSON')
    expect(() => parseModelRequestTracePage(page([{
      ...record(),
      request: {
        ...record().request,
        headers: { values: { huge: 'x'.repeat(65_537) }, redactedNames: [] }
      }
    }]))).toThrow('bounded string')
  })

  it('parses bounded tool provenance and ignores malformed catalog entries', () => {
    const parsed = parseModelRequestTracePage(page([{
      ...record(),
      toolCatalog: [
        { name: 'read', providerKind: 'built-in', providerId: 'builtin' },
        { name: '', providerKind: 'mcp' },
        { nope: true },
        { name: 'x'.repeat(257), providerKind: 'extension' }
      ]
    }]))

    expect(parsed.records[0].toolCatalog).toEqual([
      { name: 'read', providerKind: 'built-in', providerId: 'builtin' }
    ])
    expect(parseModelRequestTracePage(page()).records[0].toolCatalog).toBeUndefined()
  })
})
