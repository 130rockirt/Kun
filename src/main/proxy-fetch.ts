import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { ProxyAgent } from 'proxy-agent'

const MAX_CACHED_PROXY_AGENTS = 4
// Insertion order is used as a simple LRU: the oldest entry is evicted first
// once the cache exceeds its bound. Agents are disposed on Electron quit (or
// eviction), closing their pooled sockets so keep-alive connections never leak.
const proxyAgentCache = new Map<string, ProxyAgent>()

function getProxyAgent(normalizedProxyUrl: string): ProxyAgent {
  const cached = proxyAgentCache.get(normalizedProxyUrl)
  if (cached) {
    proxyAgentCache.delete(normalizedProxyUrl)
    proxyAgentCache.set(normalizedProxyUrl, cached)
    return cached
  }
  const agent = new ProxyAgent({
    getProxyForUrl: () => normalizedProxyUrl,
    keepAlive: true
  })
  proxyAgentCache.set(normalizedProxyUrl, agent)
  while (proxyAgentCache.size > MAX_CACHED_PROXY_AGENTS) {
    const oldestKey = proxyAgentCache.keys().next().value
    if (oldestKey === undefined) break
    const evicted = proxyAgentCache.get(oldestKey)
    proxyAgentCache.delete(oldestKey)
    evicted?.destroy()
  }
  return agent
}

export function disposeProxyAgents(): void {
  for (const agent of proxyAgentCache.values()) {
    try {
      agent.destroy()
    } catch {
      // A partially-closed agent must never block process shutdown.
    }
  }
  proxyAgentCache.clear()
}

export function cachedProxyAgentCountForTests(): number {
  return proxyAgentCache.size
}

export async function fetchWithOptionalProxy(
  input: string | URL,
  init: RequestInit | undefined,
  proxyUrl: string
): Promise<Response> {
  const normalizedProxyUrl = proxyUrl.trim()
  if (!normalizedProxyUrl) return fetch(input, init)
  return fetchViaProxy(input, init, normalizedProxyUrl)
}

async function fetchViaProxy(input: string | URL, init: RequestInit | undefined, proxyUrl: string): Promise<Response> {
  const url = new URL(input.toString())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported proxied request protocol: ${url.protocol}`)
  }

  const headers = headersToRecord(init?.headers)
  const body = await materializeProxyRequestBody(init?.body)
  for (const [key, value] of Object.entries(body.headers)) {
    if (!hasHeader(headers, key)) headers[key] = value
  }
  if (body.buffer && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(body.buffer.byteLength)
  }

  return new Promise<Response>((resolve, reject) => {
    const agent = getProxyAgent(proxyUrl)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init?.method ?? 'GET',
        headers,
        agent
      },
      (response) => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item)
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value))
          }
        }
        const webBody = Readable.toWeb(response) as ReadableStream<Uint8Array>
        resolve(new Response(webBody, {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: responseHeaders
        }))
      }
    )

    const signal = init?.signal
    const abort = (): void => {
      body.stream?.destroy()
      request.destroy(new Error('The operation was aborted.'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('error', (error) => {
      body.stream?.destroy()
      reject(error)
    })
    request.on('close', () => signal?.removeEventListener('abort', abort))
    if (body.stream) {
      body.stream.on('error', (error) => {
        request.destroy(error)
      })
      body.stream.pipe(request)
    } else if (body.buffer) {
      request.write(body.buffer)
      request.end()
    } else {
      request.end()
    }
  })
}

type MaterializedRequestBody = {
  buffer: Buffer | null
  stream: Readable | null
  headers: Record<string, string>
}

export async function materializeProxyRequestBody(body: BodyInit | null | undefined): Promise<MaterializedRequestBody> {
  if (body === null || body === undefined) return { buffer: null, stream: null, headers: {} }
  if (typeof body === 'string') return { buffer: Buffer.from(body), stream: null, headers: {} }
  if (body instanceof URLSearchParams) {
    return {
      buffer: Buffer.from(body.toString()),
      stream: null,
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    }
  }
  if (body instanceof ArrayBuffer) return { buffer: Buffer.from(body), stream: null, headers: {} }
  if (ArrayBuffer.isView(body)) {
    return {
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      stream: null,
      headers: {}
    }
  }
  if (body instanceof Blob) {
    return {
      buffer: null,
      stream: Readable.fromWeb(body.stream() as unknown as NodeWebReadableStream),
      headers: body.type
        ? { 'content-type': body.type, 'content-length': String(body.size) }
        : { 'content-length': String(body.size) }
    }
  }
  if (body instanceof FormData) {
    const encoded = new Response(body)
    const contentType = encoded.headers.get('content-type')
    return {
      buffer: null,
      stream: encoded.body ? Readable.fromWeb(encoded.body as unknown as NodeWebReadableStream) : null,
      headers: contentType ? { 'content-type': contentType } : {}
    }
  }
  throw new Error('Unsupported proxied request body type.')
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const normalized = new Headers(headers)
  normalized.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized)
}
