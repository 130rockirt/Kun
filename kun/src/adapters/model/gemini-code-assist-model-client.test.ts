import { describe, expect, it, vi } from 'vitest'
import type { TurnItem } from '../../contracts/items.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import {
  buildGeminiCodeAssistRequest,
  GeminiCodeAssistModelClient,
  mapGeminiCodeAssistModel
} from './gemini-code-assist-model-client.js'
import { makeModelContextItem } from '../../domain/item.js'

const createdAt = '2026-07-23T00:00:00.000Z'

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  const prefix: TurnItem[] = [{
    id: 'item-user',
    turnId: 'turn-history',
    threadId: 'thread-one',
    role: 'user',
    status: 'completed',
    createdAt,
    kind: 'user_message',
    text: 'Hello Gemini'
  }]
  return {
    threadId: 'thread-one',
    turnId: 'turn-one',
    model: 'gemini-3.1-pro-preview',
    systemPrompt: 'You are Kun.',
    prefix,
    history: [],
    tools: [],
    abortSignal: new AbortController().signal,
    ...overrides
  }
}

function auth() {
  return {
    kind: 'gemini-oauth' as const,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    projectId: 'project-one'
  }
}

async function drain(iterable: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('GeminiCodeAssistModelClient', () => {
  it('removes arbitrarily many trailing base URL slashes without a backtracking regexp', () => {
    const client = new GeminiCodeAssistModelClient({
      model: 'gemini-3.1-pro-preview',
      baseUrl: `https://cloudcode-pa.googleapis.com${'/'.repeat(4_096)}`
    })
    expect(client.config.baseUrl).toBe('https://cloudcode-pa.googleapis.com')
  })

  it('projects the Code Assist request envelope and model aliases', () => {
    expect(mapGeminiCodeAssistModel('gemini-3.5-flash')).toBe('gemini-3-flash')
    const body = buildGeminiCodeAssistRequest({
      request: request({ maxTokens: 2048 }),
      model: 'gemini-3.1-pro-preview',
      projectId: 'project-one'
    })
    expect(body).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      project: 'project-one',
      user_prompt_id: 'turn-one',
      request: {
        systemInstruction: { role: 'user', parts: [{ text: 'You are Kun.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello Gemini' }] }],
        generationConfig: { maxOutputTokens: 2048 },
        session_id: 'thread-one'
      }
    })
  })

  it('keeps private model context in chronological contents instead of systemInstruction', () => {
    const capsule = makeModelContextItem({
      id: 'context', threadId: 'thread-one', turnId: 'turn-history', stepIndex: 0,
      contentDigest: 'digest', blocks: [], text: 'Dynamic persona capsule', createdAt
    })
    const body = buildGeminiCodeAssistRequest({
      request: request({ prefix: [...request().prefix, capsule] }),
      model: 'gemini-3.1-pro-preview',
      projectId: 'project-one'
    }) as { request: { systemInstruction?: unknown; contents: unknown[] } }
    expect(JSON.stringify(body.request.systemInstruction)).not.toContain('Dynamic persona capsule')
    expect(JSON.stringify(body.request.contents)).toContain('Dynamic persona capsule')
    expect(JSON.stringify(body.request.contents).indexOf('Hello Gemini'))
      .toBeLessThan(JSON.stringify(body.request.contents).indexOf('Dynamic persona capsule'))
  })

  it('emits SSE fragments as they arrive instead of buffering the whole response', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    })
    const client = new GeminiCodeAssistModelClient({
      model: 'gemini-3.1-pro-preview',
      auth: auth(),
      fetchImpl: (async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })) as typeof fetch
    })
    const iterator = client.stream(request())[Symbol.asyncIterator]()
    const first = iterator.next()
    controller!.enqueue(encoder.encode(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }
      })}\n\n`
    ))
    await expect(first).resolves.toEqual({
      done: false,
      value: { kind: 'assistant_text_delta', text: 'Hel' }
    })

    controller!.enqueue(encoder.encode(
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
        }
      })}\n\n`
    ))
    controller!.close()
    const remaining: ModelStreamChunk[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      remaining.push(next.value)
    }
    expect(remaining).toContainEqual({ kind: 'assistant_text_delta', text: 'lo' })
    expect(remaining.at(-1)).toEqual({ kind: 'completed', stopReason: 'stop' })
  })

  it('refreshes an expired access token before a non-streaming request', async () => {
    const urls: string[] = []
    const client = new GeminiCodeAssistModelClient({
      model: 'gemini-3.1-pro-preview',
      auth: { ...auth(), accessToken: 'expired', expiresAt: 1 },
      fetchImpl: (async (url: string) => {
        urls.push(String(url))
        if (String(url).includes('oauth2.googleapis.com/token')) {
          return Response.json({ access_token: 'fresh-token', expires_in: 3600 })
        }
        return Response.json({
          response: {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
          }
        })
      }) as typeof fetch
    })

    const chunks = await drain(client.stream(request({ stream: false })))
    expect(urls[0]).toBe('https://oauth2.googleapis.com/token')
    expect(urls[1]).toContain('/v1internal:generateContent')
    expect(chunks).toContainEqual({ kind: 'assistant_text_delta', text: 'ok' })
  })

  it('re-resolves managed auth for every request and never falls back to cached auth', async () => {
    let authoritativeAuth: ReturnType<typeof auth> | null = null
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
      }
    }))
    const client = new GeminiCodeAssistModelClient({
      model: 'gemini-3.1-pro-preview',
      auth: { ...auth(), accessToken: 'stale-constructor-token' },
      resolveAuth: async () => authoritativeAuth,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const fenced = await drain(client.stream(request({ stream: false })))
    expect(fenced).toContainEqual(expect.objectContaining({
      kind: 'error',
      message: expect.stringContaining('credentials are unavailable')
    }))
    expect(fetchImpl).not.toHaveBeenCalled()

    authoritativeAuth = { ...auth(), accessToken: 'replacement-token' }
    const committed = await drain(client.stream(request({ stream: false })))
    expect(committed).toContainEqual({ kind: 'assistant_text_delta', text: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer replacement-token' })
    })
  })

  it('keeps concurrent managed auth generations request-local', async () => {
    let releaseOld!: () => void
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve })
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve })
    let resolveCount = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      response: {
        candidates: [{ content: { parts: [{ text: 'old request' }] }, finishReason: 'STOP' }]
      }
    }))
    const client = new GeminiCodeAssistModelClient({
      model: 'gemini-3.1-pro-preview',
      auth: { ...auth(), accessToken: 'stale-constructor-token' },
      resolveAuth: async () => {
        resolveCount += 1
        if (resolveCount === 1) {
          markOldStarted()
          await oldBlocked
          return { ...auth(), accessToken: 'late-old-token' }
        }
        return null
      },
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const oldRequest = drain(client.stream(request({ stream: false })))
    await oldStarted
    const fencedRequest = await drain(client.stream(request({ stream: false })))
    expect(fencedRequest).toContainEqual(expect.objectContaining({
      kind: 'error',
      message: expect.stringContaining('credentials are unavailable')
    }))
    expect(fetchImpl).not.toHaveBeenCalled()

    releaseOld()
    await expect(oldRequest).resolves.toContainEqual({
      kind: 'assistant_text_delta',
      text: 'old request'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer late-old-token' })
    })
  })
})
