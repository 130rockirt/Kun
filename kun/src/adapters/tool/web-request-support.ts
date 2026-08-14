import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { WebCapabilityConfig } from '../../contracts/capabilities.js'
import type { WebFetchResult, WebSearchResult } from '../../ports/web-provider.js'
import type {
  FetchWebTransportRequest,
  FetchWebTransportResponse,
  ResolvedAddress
} from './web-tool-provider.js'

export class WebFetchPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebFetchPolicyError'
  }
}

export async function resolveHostAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.flatMap((record) => {
    if (record.family !== 4 && record.family !== 6) return []
    return [{ address: record.address, family: record.family }]
  })
}

export function requestWithPinnedLookup(request: FetchWebTransportRequest): Promise<FetchWebTransportResponse> {
  const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outbound = send(request.url, {
      method: 'GET',
      signal: request.signal,
      lookup: request.lookup,
      headers: {
        accept: 'text/html, text/plain, application/xhtml+xml;q=0.9, */*;q=0.1',
        // Node's http client does not transparently decompress responses. Ask
        // for the representation we can account for byte-for-byte instead.
        'accept-encoding': 'identity'
      }
    }, (response) => resolve(transportResponse(response)))
    outbound.once('error', reject)
    outbound.end()
  })
}

function transportResponse(response: IncomingMessage): FetchWebTransportResponse {
  return {
    status: response.statusCode ?? 0,
    contentType: headerValue(response.headers['content-type']),
    location: headerValue(response.headers.location),
    body: response,
    cancel: () => response.destroy()
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export async function readResponseBody(response: FetchWebTransportResponse, maxBytes: number): Promise<{
  chunks: Uint8Array[]
  totalBytes: number
  truncated: boolean
}> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for await (const value of response.body) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
    const remaining = maxBytes - totalBytes
    if (remaining <= 0) {
      response.cancel()
      return { chunks, totalBytes, truncated: true }
    }
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining))
      response.cancel()
      return { chunks, totalBytes: totalBytes + remaining, truncated: true }
    }
    chunks.push(chunk)
    totalBytes += chunk.length
  }
  return { chunks, totalBytes, truncated: false }
}

export async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortError(): Error {
  const error = new Error('web fetch aborted')
  error.name = 'AbortError'
  return error
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export function pinnedLookup(expectedHostname: string, addresses: ResolvedAddress[]): LookupFunction {
  const expected = normalizedHostname(expectedHostname)
  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expected) {
      callback(lookupError('outbound lookup hostname did not match the vetted destination'), '', 0)
      return
    }
    const requestedFamily = lookupFamily(options.family)
    const candidates = addresses.filter((address) => requestedFamily === 0 || address.family === requestedFamily)
    if (candidates.length === 0) {
      callback(lookupError('no vetted address matches the requested IP family'), '', 0)
      return
    }
    if (options.all) {
      callback(null, candidates)
      return
    }
    const candidate = candidates[0]!
    callback(null, candidate.address, candidate.family)
  }
}

function lookupFamily(value: number | 'IPv4' | 'IPv6' | undefined): 0 | 4 | 6 {
  if (value === 4 || value === 'IPv4') return 4
  if (value === 6 || value === 'IPv6') return 6
  return 0
}

function lookupError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EHOSTUNREACH' })
}

export function isResolvedPublicAddress(record: ResolvedAddress): boolean {
  const family = isIP(normalizedIpAddress(record.address))
  return family === record.family && isPublicAddress(record.address)
}

export function isPublicAddress(value: string): boolean {
  const address = normalizedIpAddress(value)
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false

  // URL and DNS parsers can spell IPv4-mapped addresses in several ways.
  // Map them back to IPv4 policy instead of trusting their IPv6 spelling.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12).join('.'))
  }
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return isPublicIpv4(bytes.slice(12).join('.'))
  }

  // Only global-unicast IPv6 is useful for a public web fetch. This rejects
  // unspecified, loopback, unique-local, link-local, multicast, and other
  // special-use ranges before any connection is opened.
  if ((bytes[0]! & 0xe0) !== 0x20) return false
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return false // documentation
  if (hasIpv6Prefix(bytes, [0x20, 0x01, 0x00, 0x00])) return false // Teredo
  if (hasIpv6Prefix(bytes, [0x20, 0x02])) return false // 6to4 embeds an IPv4 address

  return true
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Bytes(address)
  if (!octets) return false
  const [first, second, third] = octets
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second! >= 64 && second! <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 52 && third === 193) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return false
  }
  return true
}

function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    return Number(part)
  })
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined
}

function ipv6Bytes(address: string): number[] | undefined {
  let normalized = address.toLowerCase()
  const tailStart = normalized.lastIndexOf(':')
  const tail = normalized.slice(tailStart + 1)
  if (tail.includes('.')) {
    const ipv4 = ipv4Bytes(tail)
    if (!ipv4) return undefined
    normalized = `${normalized.slice(0, tailStart)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`
  }
  const pieces = normalized.split('::')
  if (pieces.length > 2) return undefined
  const left = pieces[0] ? pieces[0].split(':') : []
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : []
  if (left.length + right.length > 8 || (pieces.length === 1 && left.length !== 8)) return undefined
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    const value = Number.parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

function hasIpv6Prefix(bytes: number[], prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function normalizedIpAddress(value: string): string {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

export function fetchOutput(result: WebFetchResult, toolTelemetry: Record<string, unknown>) {
  const source = {
    sourceId: result.sourceId,
    url: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt
  }
  return {
    sourceId: result.sourceId,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt,
    contentType: result.contentType,
    text: result.text,
    byteCount: result.byteCount,
    truncated: result.truncated,
    sources: [source],
    citations: [source],
    telemetry: toolTelemetry
  }
}

export function searchOutput(
  query: string,
  provider: string,
  results: WebSearchResult[],
  toolTelemetry: Record<string, unknown>
) {
  const sources = results.map((result) => ({
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    retrievedAt: result.retrievedAt
  }))
  return {
    query,
    provider,
    results,
    sources,
    citations: sources,
    telemetry: toolTelemetry
  }
}

export function validateUrlPolicy(rawUrl: string, config: WebCapabilityConfig): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL must be absolute' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs are allowed' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' }
  }
  const hostname = normalizedHostname(url.hostname)
  if (!hostname) return { ok: false, reason: 'URL host is required' }
  if (isLocalOnlyHostname(hostname)) {
    return { ok: false, reason: 'local and metadata hosts are not allowed' }
  }
  const literalFamily = isIP(hostname)
  if ((literalFamily === 4 || literalFamily === 6) && !isPublicAddress(hostname)) {
    return { ok: false, reason: 'URL targets a non-public IP address' }
  }
  if (config.denyDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is denied: ${hostname}` }
  }
  if (config.allowDomains.length > 0 && !config.allowDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is not allowed: ${hostname}` }
  }
  return { ok: true, url }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = normalizedHostname(domain).replace(/^\./, '')
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

export function normalizedHostname(value: string): string {
  let normalized = value.trim().toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }
  let end = normalized.length
  while (end > 0 && normalized[end - 1] === '.') end -= 1
  return normalized.slice(0, end)
}

function isLocalOnlyHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata' ||
    hostname === 'metadata.google.internal' ||
    hostname === 'instance-data' ||
    hostname === 'instance-data.ec2.internal' ||
    hostname.endsWith('.local')
  )
}
