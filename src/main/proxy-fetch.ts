import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { ProxyAgent } from 'proxy-agent'

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
    const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl })
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
      request.destroy(new Error('The operation was aborted.'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('error', reject)
    request.on('close', () => signal?.removeEventListener('abort', abort))
    if (body.buffer) request.write(body.buffer)
    request.end()
  })
}

type MaterializedRequestBody = {
  buffer: Buffer | null
  headers: Record<string, string>
}

export async function materializeProxyRequestBody(body: BodyInit | null | undefined): Promise<MaterializedRequestBody> {
  if (body === null || body === undefined) return { buffer: null, headers: {} }
  if (typeof body === 'string') return { buffer: Buffer.from(body), headers: {} }
  if (body instanceof URLSearchParams) {
    return {
      buffer: Buffer.from(body.toString()),
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    }
  }
  if (body instanceof ArrayBuffer) return { buffer: Buffer.from(body), headers: {} }
  if (ArrayBuffer.isView(body)) {
    return {
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      headers: {}
    }
  }
  if (body instanceof Blob) {
    return {
      buffer: Buffer.from(await body.arrayBuffer()),
      headers: body.type ? { 'content-type': body.type } : {}
    }
  }
  if (body instanceof FormData) {
    const encoded = new Response(body)
    const contentType = encoded.headers.get('content-type')
    return {
      buffer: Buffer.from(await encoded.arrayBuffer()),
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
