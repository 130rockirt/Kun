import { describe, expect, it } from 'vitest'
import { MultiProviderModelClient } from '../adapters/model/multi-provider-model-client.js'
import type {
  ModelClient,
  ModelRequest,
  ModelStreamChunk
} from '../ports/model-client.js'
import { AgentSdkApprovalReviewModelClient } from '../runtime/agent-sdk/agent-sdk-approval-review-model-client.js'
import {
  UnsupportedNativeApprovalReviewModelClient,
  buildApprovalReviewModelRouterInput
} from './approval-review-model-router.js'

describe('buildApprovalReviewModelRouterInput', () => {
  it('keeps HTTP routes exact and installs provider-native review boundaries', () => {
    const directDefault = modelClient('direct-default')
    const directHttp = modelClient('direct-http')
    const input = buildApprovalReviewModelRouterInput({
      direct: {
        default: directDefault,
        providers: new Map([['http-provider', directHttp]])
      },
      providers: {
        'http-provider': {
          kind: 'http',
          apiKey: 'http-secret',
          baseUrl: 'https://example.invalid'
        },
        'claude-provider': {
          kind: 'agent-sdk',
          apiKey: 'sk-ant-oat01-review'
        },
        'cursor-provider': {
          kind: 'cursor-sdk',
          apiKey: 'cursor-secret'
        },
        'antigravity-provider': {
          kind: 'antigravity-cli',
          apiKey: ''
        }
      },
      defaultModel: 'claude-default',
      reviewCwd: '/review'
    })

    expect(input.default).toBe(directDefault)
    expect(input.providers.get('http-provider')).toBe(directHttp)
    expect(input.providers.get('claude-provider')).toBeInstanceOf(
      AgentSdkApprovalReviewModelClient
    )
    expect(input.providers.get('cursor-provider')).toBeInstanceOf(
      UnsupportedNativeApprovalReviewModelClient
    )
    expect(input.providers.get('antigravity-provider')).toBeInstanceOf(
      UnsupportedNativeApprovalReviewModelClient
    )
  })

  it('uses an explicit native default instead of falling back to HTTP', async () => {
    const directDefault = modelClient('must-not-run')
    const cursor = buildApprovalReviewModelRouterInput({
      direct: { default: directDefault, providers: new Map() },
      defaultProviderKind: 'cursor-sdk',
      reviewCwd: '/review'
    })
    const router = new MultiProviderModelClient(cursor)

    await expect(collect(router.stream(request()))).rejects.toThrow(
      'refusing provider substitution'
    )
    await expect(collect(router.stream({
      ...request(),
      turnId: 'review_2',
      providerId: 'cursor-subscription'
    }))).rejects.toThrow('refusing provider substitution')
  })

  it('does not borrow the default token for an explicit Agent SDK provider with ambient login', () => {
    const routed = buildApprovalReviewModelRouterInput({
      direct: { default: modelClient('direct-default'), providers: new Map() },
      providers: {
        'ambient-claude': {
          kind: 'agent-sdk',
          apiKey: ''
        }
      },
      defaultApiKey: 'sk-ant-oat01-must-not-cross-provider',
      reviewCwd: '/review'
    })
    const explicit = routed.providers.get('ambient-claude')
    expect(explicit).toBeInstanceOf(AgentSdkApprovalReviewModelClient)
    expect((
      explicit as unknown as {
        options: { oauthToken?: string }
      }
    ).options.oauthToken).toBeUndefined()
  })

  it('keeps an explicit provider named agent-sdk separate from the implicit default route', () => {
    const routed = buildApprovalReviewModelRouterInput({
      direct: { default: modelClient('direct-default'), providers: new Map() },
      providers: {
        'agent-sdk': {
          kind: 'agent-sdk',
          apiKey: 'sk-ant-oat01-explicit-provider'
        }
      },
      defaultProviderKind: 'agent-sdk',
      defaultApiKey: 'sk-ant-oat01-implicit-default',
      reviewCwd: '/review'
    })
    const options = (client: ModelClient): { oauthToken?: string; providerId: string } =>
      (client as unknown as {
        options: { oauthToken?: string; providerId: string }
      }).options

    expect(options(routed.default)).toMatchObject({
      providerId: 'default',
      oauthToken: 'sk-ant-oat01-implicit-default'
    })
    expect(options(routed.providers.get('agent-sdk')!)).toMatchObject({
      providerId: 'agent-sdk',
      oauthToken: 'sk-ant-oat01-explicit-provider'
    })
  })

  it('fails closed for an unknown explicit provider rather than using the default', () => {
    const router = new MultiProviderModelClient(buildApprovalReviewModelRouterInput({
      direct: { default: modelClient('direct-default'), providers: new Map() },
      reviewCwd: '/review'
    }))
    expect(() => router.stream({
      ...request(),
      providerId: 'missing-provider'
    })).toThrow('unknown model provider')
  })
})

function modelClient(provider: string): ModelClient {
  return {
    provider,
    model: 'test-model',
    async *stream(): AsyncIterable<ModelStreamChunk> {
      yield { kind: 'completed', stopReason: 'stop' }
    }
  }
}

function request(): ModelRequest {
  return {
    threadId: 'thread_1',
    turnId: 'review_1',
    model: 'selected-model',
    prefix: [],
    history: [],
    tools: [],
    abortSignal: new AbortController().signal
  }
}

async function collect(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
