import { describe, expect, it } from 'vitest'
import { CompatModelClient } from './compat-model-client.js'
import type { ModelCapabilityMetadata } from '../../contracts/capabilities.js'
import type { ModelEndpointFormat } from '../../contracts/model-endpoint-format.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import {
  makeAssistantTextItem,
  makeCompactionItem,
  makeGoalContextItem,
  makeUserItem
} from '../../domain/item.js'
import { GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA } from '../tool/graph-mode-tool-provider.js'
import { createCompatRequestCodecs, normalizeToolSpecs } from './compat-request-builder.js'

// A single provider (OpenCode Go) routes some models over chat completions
// and others over Anthropic Messages. The wire format is resolved per request
// model from its capability metadata, falling back to the provider format.

type CapturedCall = { url: string; body: Record<string, unknown> }

const DEEPSEEK_REASONING: NonNullable<ModelCapabilityMetadata['reasoning']> = {
  supportedEfforts: ['off', 'high', 'max'],
  defaultEffort: 'max',
  requestProtocol: 'deepseek-chat-completions'
}

function modelCapabilities(
  overrides: Record<string, ModelEndpointFormat>
): (model: string) => ModelCapabilityMetadata {
  return (model) => ({
    id: model,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text'],
    ...(overrides[model] ? { endpointFormat: overrides[model] } : {})
  })
}

function fakeFetch(calls: CapturedCall[]): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const target = String(url)
    calls.push({ url: target, body: JSON.parse(init.body) as Record<string, unknown> })
    const json = target.endsWith('/messages')
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : { choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }] }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
}

function request(model: string): ModelRequest {
  return {
    threadId: 't1',
    turnId: 'u1',
    model,
    systemPrompt: 'You are a helpful assistant.',
    prefix: [],
    history: [],
    tools: [],
    abortSignal: new AbortController().signal
  }
}

async function drain(iterable: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('CompatModelClient per-model endpointFormat', () => {
  it('uses Gemini-compatible reasoning controls on the Google OpenAI endpoint', () => {
    const codecs = createCompatRequestCodecs()
    const expected = new Map([
      ['auto', undefined],
      ['off', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['max', 'high']
    ])

    for (const [reasoningEffort, wireEffort] of expected) {
      const body = codecs.build({
        request: { ...request('gemini-3.6-flash'), reasoningEffort },
        model: 'gemini-3.6-flash',
        messages: [],
        tools: [],
        stream: true,
        endpointFormat: 'chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        isCodex: false,
        isCodexLite: false,
        codexNativeImageGeneration: false
      })

      expect(body).not.toHaveProperty('thinking')
      if (wireEffort === undefined) {
        expect(body).not.toHaveProperty('reasoning_effort')
      } else {
        expect(body.reasoning_effort).toBe(wireEffort)
      }
    }
  })

  it('keeps DeepSeek thinking controls scoped to the official DeepSeek host', () => {
    const codecs = createCompatRequestCodecs()
    const build = (baseUrl: string) => codecs.build({
      request: { ...request('custom-model'), reasoningEffort: 'off' },
      model: 'custom-model',
      messages: [],
      tools: [],
      stream: true,
      endpointFormat: 'chat_completions',
      baseUrl,
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    })

    expect(build('https://api.deepseek.com').thinking).toEqual({ type: 'disabled' })
    expect(build('https://openrouter.ai/api/v1')).not.toHaveProperty('thinking')
  })

  it('disables DeepSeek thinking when a named tool choice is required', () => {
    const codecs = createCompatRequestCodecs()
    const tools = normalizeToolSpecs([{
      name: 'graph_create_run',
      description: 'Create a Graph run',
      inputSchema: { type: 'object', additionalProperties: false }
    }])
    const build = (reasoningEffort?: string) => codecs.build({
      request: {
        ...request('deepseek-v4-pro'),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        requiredToolName: 'graph_create_run'
      },
      model: 'deepseek-v4-pro',
      messages: [],
      tools,
      stream: true,
      endpointFormat: 'chat_completions',
      baseUrl: 'https://api.deepseek.com',
      reasoning: DEEPSEEK_REASONING,
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    })

    for (const body of [build('high'), build()]) {
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body.tool_choice).toEqual({
        type: 'function', function: { name: 'graph_create_run' }
      })
    }
  })

  it('keeps required-tool thinking fallback scoped to official DeepSeek requests', () => {
    const codecs = createCompatRequestCodecs()
    const tools = normalizeToolSpecs([{
      name: 'graph_create_run',
      description: 'Create a Graph run',
      inputSchema: { type: 'object', additionalProperties: false }
    }])
    const build = (baseUrl: string, requiredToolName?: string) => codecs.build({
      request: {
        ...request('deepseek-v4-pro'),
        reasoningEffort: 'high',
        ...(requiredToolName ? { requiredToolName } : {})
      },
      model: 'deepseek-v4-pro',
      messages: [],
      tools,
      stream: true,
      endpointFormat: 'chat_completions',
      baseUrl,
      reasoning: DEEPSEEK_REASONING,
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    })

    const ordinaryDeepSeek = build('https://api.deepseek.com')
    expect(ordinaryDeepSeek.thinking).toEqual({ type: 'enabled' })
    expect(ordinaryDeepSeek.reasoning_effort).toBe('high')
    expect(ordinaryDeepSeek).not.toHaveProperty('tool_choice')

    const compatibleProvider = build('https://provider.example/v1', 'graph_create_run')
    expect(compatibleProvider).not.toHaveProperty('thinking')
    expect(compatibleProvider.reasoning_effort).toBe('high')
    expect(compatibleProvider.tool_choice).toEqual({
      type: 'function', function: { name: 'graph_create_run' }
    })
  })

  it('excludes local tool provenance from every supported wire format', () => {
    const codecs = createCompatRequestCodecs()
    const tools = normalizeToolSpecs([{
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: {} },
      providerKind: 'gui',
      providerId: 'design-canvas'
    }])

    for (const endpointFormat of ['chat_completions', 'responses', 'messages'] as const) {
      const body = codecs.build({
        request: request('test-model'),
        model: 'test-model',
        messages: [],
        tools,
        stream: true,
        endpointFormat,
        baseUrl: 'https://provider.example/v1',
        isCodex: false,
        isCodexLite: false,
        codexNativeImageGeneration: false
      })
      const serialized = JSON.stringify(body)
      expect(serialized).toContain('read_file')
      expect(serialized).not.toContain('providerKind')
      expect(serialized).not.toContain('providerId')
      expect(serialized).not.toContain('design-canvas')
      if (endpointFormat === 'responses') {
        expect(body).not.toHaveProperty('prompt_cache_key')
      }
    }
  })

  it('uses protocol-native named tool choice for every compatible endpoint', () => {
    const codecs = createCompatRequestCodecs()
    const tools = normalizeToolSpecs([{
      name: 'graph_create_run',
      description: 'Create a Graph run',
      inputSchema: { type: 'object', additionalProperties: false }
    }])
    const build = (endpointFormat: 'chat_completions' | 'responses' | 'messages', isCodexLite = false) =>
      codecs.build({
        request: { ...request('test-model'), requiredToolName: 'graph_create_run' },
        model: 'test-model',
        messages: [],
        tools,
        stream: true,
        endpointFormat,
        baseUrl: 'https://provider.example/v1',
        isCodex: isCodexLite,
        isCodexLite,
        codexNativeImageGeneration: false
      })

    expect(build('chat_completions').tool_choice).toEqual({
      type: 'function', function: { name: 'graph_create_run' }
    })
    expect(build('responses').tool_choice).toEqual({ type: 'function', name: 'graph_create_run' })
    expect(build('responses').parallel_tool_calls).toBe(false)
    expect(build('messages').tool_choice).toEqual({ type: 'tool', name: 'graph_create_run' })
    expect(build('responses', true).tool_choice).toEqual({ type: 'function', name: 'graph_create_run' })

    expect(() => codecs.build({
      request: { ...request('test-model'), requiredToolName: 'missing_tool' },
      model: 'test-model',
      messages: [],
      tools,
      stream: true,
      endpointFormat: 'responses',
      baseUrl: 'https://provider.example/v1',
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    })).toThrow(/required_tool_unsupported/)
  })

  it('preserves the minimal graph_define_plan schema in OpenAI and Anthropic wire formats', () => {
    const codecs = createCompatRequestCodecs()
    const tools = normalizeToolSpecs([{
      name: 'graph_define_plan',
      description: 'Define a Graph plan',
      inputSchema: GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA
    }])

    for (const endpointFormat of ['chat_completions', 'responses', 'messages'] as const) {
      const body = codecs.build({
        request: request('test-model'),
        model: 'test-model',
        messages: [],
        tools,
        stream: true,
        endpointFormat,
        baseUrl: 'https://provider.example/v1',
        isCodex: false,
        isCodexLite: false,
        codexNativeImageGeneration: false
      })
      const wireTools = body.tools as Array<Record<string, unknown>>
      const wireSchema = endpointFormat === 'chat_completions'
        ? (wireTools[0]?.function as Record<string, unknown>)?.parameters
        : endpointFormat === 'messages'
          ? wireTools[0]?.input_schema
          : wireTools[0]?.parameters
      const schema = wireSchema as {
        properties: {
          plan: {
            properties: Record<string, unknown> & {
              tasks: {
                items: {
                  oneOf: Array<{
                    properties: Record<string, unknown>
                    required: string[]
                  }>
                }
              }
            }
          }
        }
      }

      expect(schema.properties.plan.properties).toHaveProperty('tasks')
      expect(schema.properties.plan.properties).toHaveProperty('completionTaskKeys')
      const branches = schema.properties.plan.properties.tasks.items.oneOf
      const ordinary = branches.find((branch) => !branch.required.includes('loop'))
      expect(ordinary?.properties).not.toHaveProperty('loop')
      const encoded = JSON.stringify(wireSchema)
      for (const forbidden of [
        'budget',
        'model',
        'providerId',
        'reasoningEffort',
        'timeout',
        'maxAttempts',
        'priority',
        'phase',
        'revision',
        'workspaceRoot',
        'runId',
        'timestamp'
      ]) {
        expect(encoded).not.toContain(`"${forbidden}"`)
      }
    }
  })

  it('uses stable thread-scoped prompt cache keys for Codex and GPT-5.6 Responses', () => {
    const codecs = createCompatRequestCodecs()
    const buildResponses = (
      model: string,
      threadId: string,
      isCodex: boolean,
      isCodexLite = false
    ) =>
      codecs.build({
        request: { ...request(model), threadId },
        model,
        messages: [],
        tools: [],
        stream: true,
        endpointFormat: 'responses',
        baseUrl: isCodex
          ? 'https://chatgpt.com/backend-api/codex'
          : 'https://provider.example/v1',
        isCodex,
        isCodexLite,
        codexNativeImageGeneration: false
      })

    const first = buildResponses('gpt-5.5-codex', 'thread-a', true)
    const repeated = buildResponses('gpt-5.5-codex', 'thread-a', true)
    const isolated = buildResponses('gpt-5.5-codex', 'thread-b', true)
    const lite = buildResponses('gpt-5.6-sol', 'thread-a', true, true)
    const compatibleFirst = buildResponses('gpt-5.6-sol', 'thread-a', false)
    const compatibleRepeated = buildResponses('gpt-5.6-sol', 'thread-a', false)
    const compatibleIsolated = buildResponses('gpt-5.6-sol', 'thread-b', false)
    const providerQualified = buildResponses('openai/gpt-5.6-terra', 'thread-a', false)

    expect(first.prompt_cache_key).toBe('thread-a')
    expect(repeated.prompt_cache_key).toBe(first.prompt_cache_key)
    expect(isolated.prompt_cache_key).toBe('thread-b')
    expect(isolated.prompt_cache_key).not.toBe(first.prompt_cache_key)
    expect(lite.prompt_cache_key).toBe('thread-a')
    expect(compatibleFirst.prompt_cache_key).toBe('thread-a')
    expect(compatibleRepeated.prompt_cache_key).toBe(compatibleFirst.prompt_cache_key)
    expect(compatibleIsolated.prompt_cache_key).toBe('thread-b')
    expect(compatibleIsolated.prompt_cache_key).not.toBe(compatibleFirst.prompt_cache_key)
    expect(providerQualified.prompt_cache_key).toBe('thread-a')
  })

  it('keeps custom prompt cache routing scoped to GPT-5.6 Responses requests', () => {
    const codecs = createCompatRequestCodecs()
    const build = (
      model: string,
      endpointFormat: 'chat_completions' | 'responses' | 'messages'
    ) => codecs.build({
      request: request(model),
      model,
      messages: [],
      tools: [],
      stream: true,
      endpointFormat,
      baseUrl: 'https://provider.example/v1',
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    })

    expect(build('gpt-5.6-sol', 'responses').prompt_cache_key).toBe('t1')
    expect(build('gpt-5.6-sol', 'chat_completions')).not.toHaveProperty('prompt_cache_key')
    expect(build('gpt-5.6-sol', 'messages')).not.toHaveProperty('prompt_cache_key')
    expect(build('gpt-5.5-codex', 'responses')).not.toHaveProperty('prompt_cache_key')
    expect(build('gpt-5.60-preview', 'responses')).not.toHaveProperty('prompt_cache_key')
  })

  it('routes an override model to the Anthropic Messages endpoint while others use chat completions', async () => {
    const calls: CapturedCall[] = []
    const client = new CompatModelClient({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'sk-test',
      model: 'glm-5.1',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      fetchImpl: fakeFetch(calls),
      modelCapabilities: modelCapabilities({ 'minimax-m3': 'messages' })
    })

    const messagesChunks = await drain(client.stream(request('minimax-m3')))
    const chatChunks = await drain(client.stream(request('glm-5.1')))

    // The override model hits /messages with the Anthropic body shape.
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/messages')
    expect(calls[0].body.max_tokens).toBeDefined()
    expect(calls[0].body).not.toHaveProperty('stream_options')

    // The non-override model inherits the provider format → /chat/completions.
    expect(calls[1].url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(calls[1].body.messages).toBeDefined()

    // Both responses still materialize cleanly through their respective parsers.
    expect(messagesChunks.some((c) => c.kind === 'assistant_text_delta')).toBe(true)
    expect(messagesChunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
    expect(chatChunks.some((c) => c.kind === 'assistant_text_delta')).toBe(true)
    expect(chatChunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
  })

  it('sets the Anthropic auth + version headers only for the messages-routed model', async () => {
    const headerCalls: Array<Record<string, string>> = []
    const capturingFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      headerCalls.push(init.headers)
      const target = String(_url)
      const json = target.endsWith('/messages')
        ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
        : { choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }] }
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const client = new CompatModelClient({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'sk-test',
      model: 'glm-5.1',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      fetchImpl: capturingFetch,
      modelCapabilities: modelCapabilities({ 'minimax-m3': 'messages' })
    })

    await drain(client.stream(request('minimax-m3')))
    await drain(client.stream(request('glm-5.1')))

    expect(headerCalls[0]['anthropic-version']).toBe('2023-06-01')
    expect(headerCalls[0]['x-api-key']).toBe('sk-test')
    expect(headerCalls[1]['anthropic-version']).toBeUndefined()
    expect(headerCalls[1]['x-api-key']).toBeUndefined()
    expect(headerCalls[1].Authorization).toBe('Bearer sk-test')
  })

  it('uses the exact URL for custom full endpoint chat completions providers', async () => {
    const calls: CapturedCall[] = []
    for (const baseUrl of [
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      'https://api.z.ai/api/coding/paas/v4/chat/completions'
    ]) {
      const client = new CompatModelClient({
        baseUrl,
        apiKey: 'sk-test',
        model: 'glm-5.2',
        endpointFormat: 'custom_endpoint',
        nonStreaming: true,
        fetchImpl: fakeFetch(calls),
        modelCapabilities: modelCapabilities({})
      })

      await drain(client.stream(request('glm-5.2')))
    }

    expect(calls.map((call) => call.url)).toEqual([
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      'https://api.z.ai/api/coding/paas/v4/chat/completions'
    ])
    expect(calls.every((call) => call.body.messages)).toBe(true)
  })

  it('keeps compacted Codex history in Responses input while preserving stable instructions', async () => {
    const calls: CapturedCall[] = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.3-codex-spark',
      endpointFormat: 'custom_endpoint',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream({
      ...request('gpt-5.3-codex-spark'),
      history: [makeCompactionItem({
        id: 'compaction_1',
        threadId: 't1',
        turnId: 'u1',
        summary: 'Preserve the repository findings.',
        replacedTokens: 80_000,
        pinnedConstraints: []
      })]
    }))

    expect(calls[0].body.instructions).toBe('You are a helpful assistant.')
    expect(calls[0].body.input).toEqual([{
      role: 'system',
      content: 'Conversation summary from earlier turns:\nPreserve the repository findings.'
    }])
    expect(JSON.stringify(calls[0].body)).not.toContain('compat-history-context')
  })

  it('moves system-only Codex context into Responses input without duplicating it', async () => {
    const calls: CapturedCall[] = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.3-codex-spark',
      endpointFormat: 'custom_endpoint',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream(request('gpt-5.3-codex-spark')))

    expect(calls[0].body.instructions).toBe(' ')
    expect(calls[0].body.input).toEqual([{
      role: 'system',
      content: 'You are a helpful assistant.'
    }])
    expect(JSON.stringify(calls[0].body).match(/You are a helpful assistant\./g)).toHaveLength(1)
  })

  it('uses the Codex Responses Lite shape for GPT-5.6 models', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.6-sol',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({
          url: String(url),
          headers: init.headers,
          body: JSON.parse(init.body) as Record<string, unknown>
        })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: (model) => ({
        id: model,
        endpointFormat: 'responses',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text', 'image_url'],
        serviceTiers: model === 'gpt-5.6-sol' ? ['priority'] : undefined,
        responsesMode: model === 'gpt-5.6-sol' ? 'lite' : undefined
      })
    })

    await drain(client.stream({
      ...request('gpt-5.6-sol'),
      reasoningEffort: 'max',
      serviceTier: 'priority',
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: {} }
      }]
    }))

    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].headers['x-openai-internal-codex-responses-lite']).toBe('true')
    expect(calls[0].body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      parallel_tool_calls: false,
      prompt_cache_key: 't1',
      service_tier: 'priority',
      reasoning: { effort: 'xhigh', context: 'all_turns' }
    })
    expect(calls[0].body).not.toHaveProperty('instructions')
    expect(calls[0].body).not.toHaveProperty('tools')
    const input = calls[0].body.input as Array<Record<string, unknown>>
    expect(input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'read_file' }]
    })
    expect(input[0].tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_generation' })
    ]))
    expect(input[1]).toMatchObject({ type: 'message', role: 'developer' })
  })

  it('normalizes legacy Codex baseUrl + responses format to the custom /responses endpoint', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.5',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
        return new Response(JSON.stringify({ output_text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream(request('gpt-5.5')))

    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0].body).toMatchObject({
      model: 'gpt-5.5',
      store: false
    })
    expect(calls[0].body).not.toHaveProperty('messages')
  })

  it('keeps GPT-5.6 Responses Lite cache inputs append-only and thread-scoped', async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = []
    const responses = [
      {
        status: 'completed',
        output_text: 'first response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 0 }
        }
      },
      {
        status: 'completed',
        output_text: 'second response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 900 }
        }
      },
      {
        status: 'completed',
        output_text: 'isolated response',
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          total_tokens: 1_010,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    ]
    let responseIndex = 0
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.6-sol',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
        const response = responses[responseIndex]
        responseIndex += 1
        if (!response) throw new Error('unexpected Responses request')
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as unknown as typeof fetch,
      modelCapabilities: (model) => ({
        id: model,
        endpointFormat: 'responses',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text', 'image_url'],
        responsesMode: model === 'gpt-5.6-sol' ? 'lite' : undefined
      })
    })
    const threadA = 'thread-cache-a'
    const firstTurnId = 'turn-cache-a-1'
    const firstHistory = [
      makeUserItem({
        id: 'item-cache-a-1',
        threadId: threadA,
        turnId: firstTurnId,
        text: 'first request'
      }),
      makeGoalContextItem({
        id: 'item-cache-a-1-goal',
        threadId: threadA,
        turnId: firstTurnId,
        text: 'Stable goal context for the cached conversation.',
        createdAt: '2026-08-06T00:00:00.000Z'
      })
    ]
    const firstChunks = await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadA,
      turnId: firstTurnId,
      history: firstHistory
    }))
    const secondTurnId = 'turn-cache-a-2'
    const secondChunks = await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadA,
      turnId: secondTurnId,
      history: [
        ...firstHistory,
        makeAssistantTextItem({
          id: 'item-cache-a-1-response',
          threadId: threadA,
          turnId: firstTurnId,
          text: 'first response',
          status: 'completed'
        }),
        makeUserItem({
          id: 'item-cache-a-2',
          threadId: threadA,
          turnId: secondTurnId,
          text: 'second request'
        })
      ]
    }))
    const threadB = 'thread-cache-b'
    await drain(client.stream({
      ...request('gpt-5.6-sol'),
      threadId: threadB,
      turnId: 'turn-cache-b-1',
      history: [makeUserItem({
        id: 'item-cache-b-1',
        threadId: threadB,
        turnId: 'turn-cache-b-1',
        text: 'isolated request'
      })]
    }))

    expect(calls.map((call) => call.headers['x-openai-internal-codex-responses-lite'])).toEqual([
      'true', 'true', 'true'
    ])
    expect(calls.map((call) => call.body.prompt_cache_key)).toEqual([
      threadA, threadA, threadB
    ])
    const firstInput = calls[0]?.body.input
    const secondInput = calls[1]?.body.input
    const isolatedInput = calls[2]?.body.input
    if (!Array.isArray(firstInput) || !Array.isArray(secondInput) || !Array.isArray(isolatedInput)) {
      throw new Error('expected Responses inputs')
    }
    expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput)
    expect(JSON.stringify(firstInput)).toContain('Stable goal context for the cached conversation.')
    expect(secondInput.slice(firstInput.length)).toEqual([
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second request' }
    ])
    const isolatedWire = JSON.stringify(isolatedInput)
    expect(isolatedWire).not.toContain('first request')
    expect(isolatedWire).not.toContain('first response')
    expect(isolatedWire).not.toContain('second request')

    const warmUsage = secondChunks.find(
      (chunk): chunk is Extract<ModelStreamChunk, { kind: 'usage' }> => chunk.kind === 'usage'
    )
    expect(firstChunks.some((chunk) => chunk.kind === 'usage')).toBe(true)
    expect(warmUsage?.usage).toMatchObject({
      cachedTokens: 900,
      cacheHitTokens: 900,
      cacheMissTokens: 100,
      cacheHitRate: 0.9
    })
  })

  it('omits the priority service tier for unsupported Codex models', async () => {
    const calls: CapturedCall[] = []
    const client = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      apiKey: 'oauth-access-token',
      model: 'gpt-5.4-mini',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: fakeFetch(calls),
      modelCapabilities: modelCapabilities({})
    })

    await drain(client.stream({
      ...request('gpt-5.4-mini'),
      serviceTier: 'priority'
    }))

    expect(calls[0].body).not.toHaveProperty('service_tier')
  })

  it('never forwards the priority service tier to non-Codex Responses endpoints', () => {
    const body = createCompatRequestCodecs().build({
      request: { ...request('gpt-5.4'), serviceTier: 'priority' },
      model: 'gpt-5.4',
      messages: [],
      tools: [],
      stream: true,
      endpointFormat: 'responses',
      baseUrl: 'https://api.openai.com/v1',
      isCodex: false,
      isCodexLite: false,
      serviceTiers: ['priority'],
      codexNativeImageGeneration: false
    })

    expect(body).not.toHaveProperty('service_tier')
  })
})
