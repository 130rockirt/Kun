import { describe, expect, it } from 'vitest'
import { CompatModelClient } from './compat-model-client.js'
import { MultiProviderModelClient } from './multi-provider-model-client.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'

// Workflow / scheduled-task / IM-bridge can pick a non-runtime provider per
// request. The same Kun process must route those requests to a per-provider
// HTTP client, leaving requests without a providerId on the default client.

type CapturedCall = { url: string; authorization: string }

function fakeFetch(calls: CapturedCall[]): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({
      url: String(url),
      authorization: init.headers?.Authorization ?? ''
    })
    return new Response(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as unknown as typeof fetch
}

function request(model: string, providerId?: string): ModelRequest {
  return {
    threadId: 't1',
    turnId: 'u1',
    model,
    ...(providerId ? { providerId } : {}),
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

describe('MultiProviderModelClient', () => {
  it('routes provider ids case-insensitively and rejects explicit unknown ids', async () => {
    const defaultCalls: CapturedCall[] = []
    const minimaxCalls: CapturedCall[] = []
    const defaultClient = new CompatModelClient({
      baseUrl: 'https://default.example/v1',
      apiKey: 'sk-default',
      model: 'deepseek-v4-pro',
      fetchImpl: fakeFetch(defaultCalls)
    })
    const minimaxClient = new CompatModelClient({
      baseUrl: 'https://minimax.example/anthropic',
      apiKey: 'sk-minimax',
      model: 'MiniMax-M3',
      fetchImpl: fakeFetch(minimaxCalls)
    })
    const router = new MultiProviderModelClient({
      default: defaultClient,
      providers: new Map([
        ['deepseek', defaultClient],
        ['minimax-token-plan', minimaxClient]
      ])
    })

    await drain(router.stream(request('deepseek-v4-pro')))
    await drain(router.stream({ ...request('deepseek-v4-pro', 'deepseek'), turnId: 'u2' }))
    await drain(router.stream({ ...request('MiniMax-M3', 'MiniMax-Token-Plan'), turnId: 'u3' }))
    expect(() => router.stream({
      ...request('deepseek-v4-pro', 'unknown-provider'),
      turnId: 'u4'
    })).toThrow(/unknown model provider/)

    expect(defaultCalls).toHaveLength(2)
    expect(defaultCalls[0].url).toContain('default.example')
    expect(defaultCalls[0].authorization).toBe('Bearer sk-default')
    expect(minimaxCalls).toHaveLength(1)
    expect(minimaxCalls[0].url).toContain('minimax.example')
    expect(minimaxCalls[0].authorization).toBe('Bearer sk-minimax')
  })

  it('exposes the default client\'s config so loop-side diagnostics keep working for single-provider deployments', () => {
    const defaultClient = new CompatModelClient({
      baseUrl: 'https://default.example/v1',
      apiKey: 'sk-default',
      model: 'deepseek-v4-pro'
    })
    const router = new MultiProviderModelClient({ default: defaultClient })
    expect(router.model).toBe('deepseek-v4-pro')
    expect((router.config as { baseUrl?: string }).baseUrl).toBe('https://default.example/v1')
  })

  it('exposes routed client config for per-request diagnostics', () => {
    const defaultClient = new CompatModelClient({
      baseUrl: 'https://default.example/v1',
      apiKey: 'sk-default',
      model: 'deepseek-v4-pro',
      endpointFormat: 'chat_completions'
    })
    const minimaxClient = new CompatModelClient({
      baseUrl: 'https://minimax.example/anthropic',
      apiKey: 'sk-minimax',
      model: 'MiniMax-M3',
      endpointFormat: 'messages'
    })
    const router = new MultiProviderModelClient({
      default: defaultClient,
      providers: new Map([['minimax-token-plan', minimaxClient]])
    })

    expect((router.configFor() as { baseUrl?: string }).baseUrl).toBe('https://default.example/v1')
    expect((router.configFor('minimax-token-plan') as { endpointFormat?: string }).endpointFormat).toBe('messages')
    expect(() => router.configFor('unknown-provider')).toThrow(/unknown model provider/)
  })

  it('routes new requests through replaced default and provider clients', async () => {
    const oldDefaultCalls: CapturedCall[] = []
    const newDefaultCalls: CapturedCall[] = []
    const oldProviderCalls: CapturedCall[] = []
    const newProviderCalls: CapturedCall[] = []
    const router = new MultiProviderModelClient({
      default: new CompatModelClient({
        baseUrl: 'https://old-default.example/v1',
        apiKey: 'sk-old-default',
        model: 'old-default',
        fetchImpl: fakeFetch(oldDefaultCalls)
      }),
      providers: new Map([
        ['hot-provider', new CompatModelClient({
          baseUrl: 'https://old-provider.example/v1',
          apiKey: 'sk-old-provider',
          model: 'old-provider',
          fetchImpl: fakeFetch(oldProviderCalls)
        })]
      ])
    })

    await drain(router.stream(request('old-provider', 'hot-provider')))
    router.replace({
      default: new CompatModelClient({
        baseUrl: 'https://new-default.example/v1',
        apiKey: 'sk-new-default',
        model: 'new-default',
        fetchImpl: fakeFetch(newDefaultCalls)
      }),
      providers: new Map([
        ['hot-provider', new CompatModelClient({
          baseUrl: 'https://new-provider.example/v1',
          apiKey: 'sk-new-provider',
          model: 'new-provider',
          fetchImpl: fakeFetch(newProviderCalls)
        })]
      ])
    })

    await drain(router.stream({ ...request('new-default'), turnId: 'u2' }))
    await drain(router.stream({ ...request('new-provider', 'hot-provider'), turnId: 'u3' }))

    expect(router.model).toBe('new-default')
    expect(oldProviderCalls).toHaveLength(1)
    expect(oldDefaultCalls).toHaveLength(0)
    expect(newDefaultCalls).toHaveLength(1)
    expect(newProviderCalls).toHaveLength(1)
    expect(newProviderCalls[0].authorization).toBe('Bearer sk-new-provider')
  })

  it('pins one client generation for every model round in a running turn', async () => {
    const calls: string[] = []
    const client = (label: string): ModelClient => ({
      provider: label,
      model: label,
      async *stream(input) {
        calls.push(`${label}:${input.turnId}`)
        yield { kind: 'assistant_text_delta' as const, text: label }
        yield { kind: 'completed' as const, stopReason: 'stop' as const }
      }
    })
    const router = new MultiProviderModelClient({ default: client('old') })

    await drain(router.stream(request('model-a')))
    router.replace({ default: client('new') })
    await drain(router.stream(request('model-a')))
    await drain(router.stream({ ...request('model-a'), turnId: 'u2' }))

    expect(calls).toEqual(['old:u1', 'old:u1', 'new:u2'])
  })
})
