import { describe, expect, it } from 'vitest'
import { CompatModelClient } from './compat-model-client.js'
import type { ModelRequestRetryConfig } from '../../config/kun-config.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'

// Retry behavior is opt-in and provider-configurable. Keep the status list and
// delays explicit so these tests match the runtime contract.

function request(signal?: AbortSignal): ModelRequest {
  return {
    threadId: 't1',
    turnId: 'u1',
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant.',
    prefix: [],
    history: [],
    tools: [],
    abortSignal: signal ?? new AbortController().signal
  }
}

async function drain(iterable: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function okJson(): Response {
  return new Response(
    JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

// Mirrors the real ALB 502 the user hit: HTML body, not JSON.
function gatewayError(status: number): Response {
  return new Response(
    `<html><head><title>${status}</title></head><body><center>${status}</center><center>alb</center></body></html>`,
    { status, headers: { 'content-type': 'text/html' } }
  )
}

function client(fetchImpl: typeof fetch, retry?: ModelRequestRetryConfig): CompatModelClient {
  return new CompatModelClient({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-test',
    model: 'glm-5.1',
    endpointFormat: 'chat_completions',
    nonStreaming: true,
    retry,
    fetchImpl
  })
}

describe('CompatModelClient transient gateway retry', () => {
  it('retries a 502 Bad Gateway and then succeeds', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return calls === 1 ? gatewayError(502) : okJson()
    }) as unknown as typeof fetch

    const chunks = await drain(
      client(fetchImpl, { maxAttempts: 1, initialDelayMs: 0, httpStatusCodes: [502] }).stream(request())
    )

    expect(calls).toBe(2)
    expect(chunks).toContainEqual({ kind: 'retrying', status: 502, attempt: 1, maxAttempts: 1, delayMs: 0 })
    expect(chunks.some((c) => c.kind === 'assistant_text_delta')).toBe(true)
    expect(chunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
    expect(chunks.some((c) => c.kind === 'error')).toBe(false)
  })

  it('does not retry by default', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return gatewayError(502)
    }) as unknown as typeof fetch

    const chunks = await drain(client(fetchImpl).stream(request()))

    expect(calls).toBe(1)
    expect(chunks.some((c) => c.kind === 'error')).toBe(true)
  })

  it('summarizes HTML challenge pages in user-visible HTTP errors', async () => {
    const html = `
      <html>
        <head><title>Challenge</title></head>
        <body>
          <h2><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></h2>
          ${'<svg><path d="M37.5324 16.8707" /></svg>'.repeat(100)}
        </body>
      </html>
    `
    const fetchImpl = (async () =>
      new Response(html, { status: 403, headers: { 'content-type': 'text/html' } })
    ) as unknown as typeof fetch

    const chunks = await drain(client(fetchImpl).stream(request()))
    const error = chunks.find((c) => c.kind === 'error')

    expect(error).toMatchObject({
      kind: 'error',
      code: 'http_403'
    })
    expect(error && error.kind === 'error' ? error.message : '').toContain('HTML challenge page')
    expect(error && error.kind === 'error' ? error.message : '').not.toContain('<svg>')
    expect(error && error.kind === 'error' ? error.message.length : 0).toBeLessThan(240)
  })

  it('stops retrying when the request is aborted during backoff', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      // Abort while the (failed) response is in hand, so the backoff sees it.
      controller.abort()
      return gatewayError(503)
    }) as unknown as typeof fetch

    const chunks = await drain(
      client(fetchImpl, { maxAttempts: 1, initialDelayMs: 1_000, httpStatusCodes: [503] }).stream(
        request(controller.signal)
      )
    )

    expect(calls).toBe(1)
    expect(chunks.some((c) => c.kind === 'error')).toBe(true)
  })
})

describe('CompatModelClient refreshed credentials', () => {
  it('keeps one Codex session across sequential calls and a 401 credential refresh', async () => {
    const sessionIds: string[] = []
    const authorization: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sessionIds.push(headers.get('session_id') ?? '')
      const value = headers.get('authorization') ?? ''
      authorization.push(value)
      return value === 'Bearer old-access'
        ? Response.json({ error: 'expired' }, { status: 401 })
        : Response.json({ output_text: 'ok', status: 'completed' })
    }) as unknown as typeof fetch
    let resolution = 0
    const oauthClient = new CompatModelClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'old-access',
      model: 'gpt-5.6-sol',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl,
      resolveCredentials: async (rejectedAccessToken?: string) => ({
        apiKey: rejectedAccessToken ? 'new-access' : 'old-access',
        headers: { session_id: `credential-session-${++resolution}` },
        refreshable: true
      })
    })

    await drain(oauthClient.stream({ ...request(), model: 'gpt-5.6-sol' }))
    await drain(oauthClient.stream({ ...request(), model: 'gpt-5.6-sol', turnId: 'u2' }))

    expect(authorization).toEqual([
      'Bearer old-access',
      'Bearer new-access',
      'Bearer old-access',
      'Bearer new-access'
    ])
    expect(sessionIds).toHaveLength(4)
    expect(sessionIds[0]).not.toBe('')
    expect(new Set(sessionIds)).toEqual(new Set([sessionIds[0]]))
    expect(sessionIds[0]).not.toMatch(/^credential-session-/)
  })

  it('refreshes a rejected OAuth bearer once and retries the request with the new token', async () => {
    const authorization: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const value = new Headers(init?.headers).get('authorization') ?? ''
      authorization.push(value)
      return value === 'Bearer old-access'
        ? Response.json({ error: 'expired' }, { status: 401 })
        : Response.json({ output_text: 'ok', status: 'completed' })
    }) as unknown as typeof fetch
    const resolverCalls: Array<string | undefined> = []
    const oauthClient = new CompatModelClient({
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      apiKey: 'old-access',
      model: 'grok-4.5',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl,
      resolveCredentials: async (rejectedAccessToken?: string) => {
        resolverCalls.push(rejectedAccessToken)
        return rejectedAccessToken
          ? {
              apiKey: 'new-access',
              headers: { 'X-XAI-Token-Auth': 'xai-grok-cli' },
              refreshable: true
            }
          : {
              apiKey: 'old-access',
              headers: { 'X-XAI-Token-Auth': 'xai-grok-cli' },
              refreshable: true
            }
      }
    })

    const chunks = await drain(oauthClient.stream({
      ...request(),
      model: 'grok-4.5'
    }))

    expect(authorization).toEqual(['Bearer old-access', 'Bearer new-access'])
    expect(resolverCalls).toEqual([undefined, 'old-access'])
    expect(chunks.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
    expect(chunks.some((chunk) => chunk.kind === 'error')).toBe(false)
  })

  it('does not retry a 401 for non-refreshable credentials', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return Response.json({ error: 'invalid key' }, { status: 401 })
    }) as unknown as typeof fetch
    const plainClient = new CompatModelClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'plain-key',
      model: 'glm-5.1',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      fetchImpl,
      resolveCredentials: async () => ({
        apiKey: 'plain-key',
        refreshable: false
      })
    })

    const chunks = await drain(plainClient.stream(request()))

    expect(calls).toBe(1)
    expect(chunks).toContainEqual(expect.objectContaining({ kind: 'error', code: 'http_401' }))
  })
})
