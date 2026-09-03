import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { ProxyAgent } from 'proxy-agent'

const MAX_CACHED_PROXY_AGENTS = 4
// Insertion order is used as a simple LRU: the oldest entry is evicted first
// once the cache exceeds its bound. A single process typically uses only one
// or two proxy URLs, so this bound keeps resources bounded without reference
// counting. Agents are disposed on runtime shutdown (or eviction), closing
// their pooled sockets so keep-alive connections never leak.
const proxyAgentCache = new Map<string, ProxyAgent>()

function getProxyAgent(normalizedProxyUrl: string): ProxyAgent {
  const cached = proxyAgentCache.get(normalizedProxyUrl)
  if (cached) {
    // Re-insert to mark this entry as most-recently-used.
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

export function createProxyFetch(proxyUrl: string): typeof fetch | null {
  const normalizedProxyUrl = proxyUrl.trim()
  if (!normalizedProxyUrl) return null
  return (input, init) => fetchViaProxy(input, init, normalizedProxyUrl)
}

async function fetchViaProxy(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  proxyUrl: string
): Promise<Response> {
  const requestInput = new Request(input, init)
  const url = new URL(requestInput.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported proxied request protocol: ${url.protocol}`)
  }

  const headers = headersToRecord(requestInput.headers)
  // Stream the body instead of materialising it with arrayBuffer(). When the
  // caller has not set content-length, Node emits Transfer-Encoding: chunked.
  const bodyStream = requestInput.body
    ? Readable.fromWeb(requestInput.body)
    : null

  return new Promise<Response>((resolve, reject) => {
    const agent = getProxyAgent(proxyUrl)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: requestInput.method,
        headers,
        agent
      },
      (response) => {
        if (settled) {
          response.resume()
          return
        }
        settled = true
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

    const signal = requestInput.signal
    let settled = false
    const settleReject = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abort = (): void => {
      bodyStream?.destroy()
      request.destroy(new Error('The operation was aborted.'))
    }
    request.on('error', (error) => {
      bodyStream?.destroy()
      settleReject(error)
    })
    request.on('close', () => signal?.removeEventListener('abort', abort))
    if (signal?.aborted) {
      abort()
      settleReject(new Error('The operation was aborted.'))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (bodyStream) {
      bodyStream.on('error', (error) => {
        request.destroy(error)
      })
      bodyStream.pipe(request)
    } else {
      request.end()
    }
  })
}

function headersToRecord(
  headers: { forEach(callback: (value: string, key: string) => void): void } | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}
