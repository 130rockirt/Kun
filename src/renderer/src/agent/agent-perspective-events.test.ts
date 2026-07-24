import { describe, expect, it } from 'vitest'
import type { ModelRequestTraceRecord } from './model-request-traces'
import {
  isTitleGenerationRequest,
  parseSemanticRequest,
  projectAgentPerspectiveEvents
} from './agent-perspective-events'

function trace(
  id: string,
  body: Record<string, unknown>,
  overrides: Partial<ModelRequestTraceRecord> = {}
): ModelRequestTraceRecord {
  const text = JSON.stringify(body)
  return {
    schemaVersion: 1,
    id,
    sequence: Number(id.replace(/\D/g, '')) || 1,
    threadId: 'thread-1',
    turnId: `turn-${id}`,
    provider: 'compat',
    model: 'test-model',
    endpointFormat: 'openai_chat_completions',
    attempt: 1,
    attemptReason: 'initial',
    status: 'completed',
    startedAt: `2026-07-20T00:00:0${Number(id.replace(/\D/g, '')) || 1}.000Z`,
    finishedAt: `2026-07-20T00:00:0${Number(id.replace(/\D/g, '')) || 1}.500Z`,
    request: {
      method: 'POST',
      url: 'https://example.test/chat/completions',
      urlRedacted: false,
      headers: { values: {}, redactedNames: [] },
      body: { text, capturedBytes: text.length, originalBytes: text.length, truncated: false }
    },
    ...overrides
  }
}

describe('Agent Perspective semantic projection', () => {
  it('extracts the Chat Completions request shape used by custom endpoints too', () => {
    const parsed = parseSemanticRequest(trace('1', {
      model: 'chat-model',
      messages: [
        { role: 'system', content: 'Chat Completions system prompt.' },
        { role: 'user', content: 'Inspect Chat Completions' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file',
          parameters: { type: 'object' }
        }
      }]
    }, { endpointFormat: 'custom_endpoint' }))

    expect(parsed).toMatchObject({
      prompts: [{ source: 'message', text: 'Chat Completions system prompt.' }],
      tools: [{ name: 'write_file', description: 'Write a file' }],
      messages: [{ role: 'user', text: 'Inspect Chat Completions' }]
    })
  })

  it('extracts system prompts, skills, tool definitions, messages, and parameters', () => {
    const record = trace('1', {
      model: 'gpt-test',
      instructions: [
        'Base instructions.',
        '## Skills',
        '### Available skills',
        '- pdf (pdf-reader): Read PDFs. (file: /skills/pdf/SKILL.md)',
        '### How to use skills',
        'Read the skill first.',
        '',
        'Active Skill: pdf (pdf-reader)',
        '',
        'Activation: user mentioned pdf',
        '',
        'Description: Read PDFs with the active workflow.'
      ].join('\n'),
      input: [{ role: 'user', content: 'Inspect the request' }],
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      stream: true,
      reasoning: { effort: 'high' }
    })

    expect(parseSemanticRequest(record)).toMatchObject({
      model: 'gpt-test',
      prompts: [{ source: 'instructions' }],
      skills: [{ id: 'pdf-reader', name: 'pdf', path: '/skills/pdf/SKILL.md', active: true }],
      tools: [{ name: 'read_file', description: 'Read a file' }],
      messages: [{ role: 'user', text: 'Inspect the request' }],
      parameters: [{ name: 'stream', value: true }, { name: 'reasoning', value: { effort: 'high' } }]
    })
  })

  it('extracts semantic sections from standard and Lite Responses requests', () => {
    const standard = parseSemanticRequest(trace('1', {
      model: 'gpt-responses',
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'Standard Responses system prompt.' }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect standard Responses' }]
        }
      ],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' }
      }]
    }, { endpointFormat: 'responses' }))
    expect(standard).toMatchObject({
      prompts: [{ source: 'message', text: 'Standard Responses system prompt.' }],
      tools: [{ name: 'read_file', description: 'Read a file' }],
      messages: [{ role: 'user', text: 'Inspect standard Responses' }]
    })

    const lite = parseSemanticRequest(trace('2', {
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{
            type: 'function',
            name: 'bash',
            description: 'Run a shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }]
        },
        {
          type: 'message',
          role: 'developer',
          content: [{
            type: 'input_text',
            text: [
              'Kun system prompt.',
              '### Available skills',
              '- pdf (pdf-reader): Read PDFs. (file: /skills/pdf/SKILL.md)',
              '### How to use skills',
              'Read the skill first.',
              '',
              'Active Skill: pdf (pdf-reader)',
              '',
              'Activation: user mentioned pdf',
              '',
              'Description: Read PDFs with the active workflow.'
            ].join('\n')
          }]
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect Responses Lite' }]
        }
      ],
      store: false
    }, {
      endpointFormat: 'responses',
      toolCatalog: [{ name: 'bash', providerKind: 'built-in', providerId: 'builtin' }]
    }))
    expect(lite).toMatchObject({
      prompts: [{ source: 'message', text: expect.stringContaining('Kun system prompt.') }],
      skills: [{ id: 'pdf-reader', name: 'pdf', active: true }],
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        provenance: { source: 'kun', inferred: false }
      }],
      messages: [{ role: 'user', text: 'Inspect Responses Lite' }],
      parameters: [{ name: 'store', value: false }]
    })
  })

  it('uses exactly the three supported event classes and matches tool results by call id', () => {
    const first = trace('1', {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Read package.json' }],
      tools: []
    }, {
      toolCatalog: [{ name: 'read_file', providerKind: 'mcp', providerId: 'mcp:filesystem' }],
      decoded: {
        text: '', reasoning: '',
        toolCalls: [{ callId: 'call-1', toolName: 'read_file', arguments: { path: 'package.json' } }]
      }
    })
    const second = trace('2', {
      model: 'gpt-test',
      messages: [{ role: 'tool', tool_call_id: 'call-1', content: '{"name":"kun"}' }],
      tools: []
    })
    const title = trace('3', {
      model: 'small-model',
      messages: [
        { role: 'user', content: 'User message:\nHello' },
        { role: 'system', content: 'You generate a concise title for a chat conversation.' }
      ]
    }, {
      turnId: 'turn-1_title',
      decoded: { text: 'Hello', reasoning: '', toolCalls: [] }
    })

    const events = projectAgentPerspectiveEvents([title, second, first])
    expect(events.map((event) => event.kind)).toEqual([
      'llm_request', 'tool_call', 'llm_request', 'title_generation'
    ])
    expect(events[1]).toMatchObject({
      kind: 'tool_call',
      toolName: 'read_file',
      provenance: {
        source: 'mcp',
        providerName: 'filesystem',
        inferred: false
      },
      result: { role: 'tool', text: '{"name":"kun"}' }
    })
    expect(events[3]).toMatchObject({ kind: 'title_generation', title: 'Hello' })
    expect(isTitleGenerationRequest(title)).toBe(true)
  })

  it('recognizes Anthropic tool results and preserves malformed raw requests', () => {
    const anthropic = trace('1', {
      model: 'claude-test',
      system: 'Be concise',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'done' }]
      }],
      tools: [{ name: 'bash', description: 'Run command', input_schema: { type: 'object' } }]
    })
    const parsed = parseSemanticRequest(anthropic)
    expect(parsed).toMatchObject({
      prompts: [{ source: 'system', text: 'Be concise' }],
      tools: [{ name: 'bash' }]
    })
    expect(parsed.messages.find((message) => message.callId === 'call-a')).toMatchObject({
      role: 'tool', text: 'done'
    })

    const malformed = trace('2', {})
    malformed.request.body.text = '{'
    expect(parseSemanticRequest(malformed)).toMatchObject({ body: null, prompts: [], tools: [] })
    expect(parseSemanticRequest(malformed).parseError).toBeTruthy()
  })

  it('preserves delegated SDK continuity metadata on projected requests', () => {
    const delegated = trace('1', {
      model: 'claude-sonnet-4-5',
      system: 'Kun system',
      input: 'Continue the task'
    }, {
      transport: 'sdk',
      endpointFormat: 'agent-sdk',
      decoded: {
        text: 'done',
        reasoning: '',
        toolCalls: [{
          callId: 'sdk-call-1',
          toolName: 'read_file',
          arguments: { path: 'README.md' }
        }],
        toolResults: [{
          callId: 'sdk-call-1',
          toolName: 'read_file',
          output: 'README content',
          isError: false
        }]
      },
      delegated: {
        providerKind: 'agent-sdk',
        phase: 'resumed',
        contextManagement: 'sdk-managed',
        nativeHistory: 'unknown',
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
    })

    const events = projectAgentPerspectiveEvents([delegated])
    expect(events[0]).toMatchObject({
      kind: 'llm_request',
      record: {
        transport: 'sdk',
        delegated: {
          providerKind: 'agent-sdk',
          phase: 'resumed',
          nativeHistory: 'unknown'
        }
      }
    })
    expect(events[1]).toMatchObject({
      kind: 'tool_call',
      callId: 'sdk-call-1',
      result: {
        role: 'tool',
        text: 'README content',
        kind: 'tool_result'
      }
    })
  })
})
