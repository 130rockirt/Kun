import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { KunCapabilitiesConfig, WebCapabilityConfig } from '../../contracts/capabilities.js'
import type { WebFetchResult, WebProvider, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor, UnavailableWebProvider } from '../../ports/web-provider.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

const WEB_REQUEST_TIMEOUT_MS = 60 * 60_000
const DEFAULT_WEB_MAX_BYTES = 1_000_000
// Models sometimes pass tiny max_bytes budgets (2000 was common in the
// wild); below this floor the extracted text is too small to be useful.
const MIN_WEB_FETCH_BYTES = 4_096
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 10
const MAX_WEB_REDIRECTS = 5

export type ResolvedAddress = {
  address: string
  family: 4 | 6
}

export type FetchWebTransportRequest = {
  url: URL
  lookup: LookupFunction
  signal: AbortSignal
}

export type FetchWebTransportResponse = {
  status: number
  contentType?: string
  location?: string
  body: AsyncIterable<Uint8Array>
  cancel(): void
}

export type FetchWebProviderOptions = {
  nowIso?: () => string
  /**
   * Injection point for deterministic tests. Production uses the OS resolver
   * and pins the vetted answers into the outbound socket lookup callback.
   */
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>
  request?: (request: FetchWebTransportRequest) => Promise<FetchWebTransportResponse>
}

export type WebProviderDiagnostic = {
  id: string
  enabled: boolean
  available: boolean
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
  reason?: string
}

export type WebToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: WebProviderDiagnostic[]
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
}

export type WebToolProviderOptions = {
  provider?: WebProvider
  nowIso?: () => string
}

export function buildWebToolProviders(
  config: KunCapabilitiesConfig['web'] | undefined,
  options: WebToolProviderOptions = {}
): WebToolProviderBuildResult {
  const web = config
  if (!web?.enabled) {
    return {
      providers: [],
      diagnostics: [],
      fetchAvailable: false,
      searchAvailable: false
    }
  }

  const provider: WebProvider = options.provider ?? (web.fetchEnabled ? new FetchWebProvider(web, {
    nowIso: options.nowIso
  }) : new UnavailableWebProvider(web.provider))
  const tools = []
  if (web.fetchEnabled) {
    tools.push(createFetchTool(web, provider))
  }
  if (web.searchEnabled) {
    tools.push(createSearchTool(web, provider))
  }
  const fetchAvailable = Boolean(web.fetchEnabled && provider.fetch)
  const searchAvailable = Boolean(web.searchEnabled && provider.search)
  const reason = !tools.length
    ? 'web tools are disabled by config'
    : !fetchAvailable && !searchAvailable
      ? 'web provider is unavailable'
      : undefined

  return {
    providers: tools.length
      ? [{
          id: 'web',
          kind: 'web',
          enabled: true,
          available: true,
          effects: {
            network: true,
            externalWrite: false,
            processExecution: false,
            guiAutomation: false
          },
          ...(reason ? { reason } : {}),
          tools
        }]
      : [],
    diagnostics: [{
      id: 'web',
      enabled: true,
      available: fetchAvailable || searchAvailable,
      fetchAvailable,
      searchAvailable,
      provider: provider.id,
      ...(reason ? { reason } : {})
    }],
    fetchAvailable,
    searchAvailable,
    provider: provider.id
  }
}

function createFetchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_fetch',
    description: 'Fetch an allowed HTTP or HTTPS URL and return extracted text with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_bytes: { type: 'number' }
      },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const rawUrl = pickString(args.url)
      if (!rawUrl) return toolError('invalid_url', 'url is required')
      const policy = validateUrlPolicy(rawUrl, config)
      if (!policy.ok) return toolError('policy_blocked', policy.reason, telemetry({ startedAt, policy: 'blocked', url: rawUrl }))
      if (!provider.fetch) return toolError('provider_unavailable', 'web fetch provider is unavailable')
      const maxBytesCap = config.maxFetchBytes ?? DEFAULT_WEB_MAX_BYTES
      const maxBytes = boundedInt(
        args.max_bytes,
        maxBytesCap,
        Math.min(MIN_WEB_FETCH_BYTES, maxBytesCap),
        maxBytesCap
      )
      try {
        const result = await provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs: WEB_REQUEST_TIMEOUT_MS,
          signal: context.abortSignal
        })
        return {
          output: fetchOutput(result, telemetry({
            startedAt,
            policy: 'allowed',
            url: policy.url.href,
            provider: provider.id,
            byteCount: result.byteCount
          }))
        }
      } catch (error) {
        if (error instanceof WebFetchPolicyError) {
          return toolError('policy_blocked', error.message, telemetry({
            startedAt,
            policy: 'blocked',
            url: policy.url.href,
            provider: provider.id
          }))
        }
        return toolError('fetch_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          url: policy.url.href,
          provider: provider.id
        }))
      }
    }
  })
}

function createSearchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_search',
    description: 'Search the web through the configured provider and return ranked results with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const query = pickString(args.query)
      if (!query) return toolError('invalid_query', 'query is required')
      if (!provider.search) return toolError('provider_unavailable', 'web search provider is unavailable')
      const limit = boundedInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      try {
        const results = await provider.search({
          query,
          limit,
          timeoutMs: WEB_REQUEST_TIMEOUT_MS,
          signal: context.abortSignal
        })
        return {
          output: searchOutput(query, provider.id, results, telemetry({
            startedAt,
            policy: 'allowed',
            provider: provider.id,
            query,
            resultCount: results.length
          }))
        }
      } catch (error) {
        return toolError('search_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          provider: provider.id,
          query
        }))
      }
    }
  })
}

export class FetchWebProvider implements WebProvider {
  readonly id = 'fetch'
  private readonly config: WebCapabilityConfig
  private readonly nowIso: () => string
  private readonly resolveHost: (hostname: string) => Promise<ResolvedAddress[]>
  private readonly request: (request: FetchWebTransportRequest) => Promise<FetchWebTransportResponse>

  constructor(config: WebCapabilityConfig, options: FetchWebProviderOptions = {}) {
    this.config = config
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.resolveHost = options.resolveHost ?? resolveHostAddresses
    this.request = options.request ?? requestWithPinnedLookup
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      let currentUrl = new URL(request.url)
      let redirectCount = 0
      let response: FetchWebTransportResponse | undefined

      while (true) {
        const policy = validateUrlPolicy(currentUrl.href, this.config)
        if (!policy.ok) throw new WebFetchPolicyError(policy.reason)
        const resolved = await awaitWithAbort(this.resolveDestination(policy.url), controller.signal)
        response = await this.request({
          url: policy.url,
          lookup: pinnedLookup(policy.url.hostname, resolved),
          signal: controller.signal
        })

        if (!isRedirectStatus(response.status)) break
        const location = response.location
        response.cancel()
        if (!location) throw new Error(`HTTP ${response.status} redirect is missing a Location header`)
        if (redirectCount >= MAX_WEB_REDIRECTS) throw new Error(`redirect limit (${MAX_WEB_REDIRECTS}) exceeded`)
        try {
          currentUrl = new URL(location, policy.url)
        } catch {
          throw new WebFetchPolicyError('redirect Location must be a valid absolute or relative HTTP URL')
        }
        redirectCount += 1
      }

      if (!response) throw new Error('web response is unavailable')
      if (response.status < 200 || response.status >= 300) {
        response.cancel()
        throw new Error(`HTTP ${response.status}`)
      }

      // Oversized pages truncate at maxBytes via the streaming read below.
      // Hard-failing on the declared content-length made most real pages
      // unfetchable whenever the model passed a small byte budget.
      const body = await readResponseBody(response, request.maxBytes)
      const buffer = Buffer.concat(body.chunks)
      const contentType = response.contentType
      const raw = buffer.toString('utf8')
      const extracted = extractReadableText(raw, contentType)
      const finalUrl = currentUrl.href
      return {
        sourceId: sourceIdFor('fetch', finalUrl),
        url: request.url,
        finalUrl,
        title: extracted.title,
        contentType,
        text: extracted.text,
        retrievedAt: this.nowIso(),
        byteCount: body.totalBytes,
        truncated: body.truncated
      }
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }

  private async resolveDestination(url: URL): Promise<ResolvedAddress[]> {
    const hostname = normalizedHostname(url.hostname)
    const literalFamily = isIP(hostname)
    if (literalFamily === 4 || literalFamily === 6) {
      if (!isPublicAddress(hostname)) {
        throw new WebFetchPolicyError('URL targets a non-public IP address')
      }
      return [{ address: hostname, family: literalFamily }]
    }

    let records: ResolvedAddress[]
    try {
      records = await this.resolveHost(hostname)
    } catch {
      throw new WebFetchPolicyError('hostname could not be resolved to a public address')
    }
    if (records.length === 0 || records.some((record) => !isResolvedPublicAddress(record))) {
      throw new WebFetchPolicyError('hostname resolves to a non-public address')
    }
    return records
  }
}

class WebFetchPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebFetchPolicyError'
  }
}

async function resolveHostAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.flatMap((record) => {
    if (record.family !== 4 && record.family !== 6) return []
    return [{ address: record.address, family: record.family }]
  })
}

function requestWithPinnedLookup(request: FetchWebTransportRequest): Promise<FetchWebTransportResponse> {
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

async function readResponseBody(response: FetchWebTransportResponse, maxBytes: number): Promise<{
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

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function pinnedLookup(expectedHostname: string, addresses: ResolvedAddress[]): LookupFunction {
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

function isResolvedPublicAddress(record: ResolvedAddress): boolean {
  const family = isIP(normalizedIpAddress(record.address))
  return family === record.family && isPublicAddress(record.address)
}

function isPublicAddress(value: string): boolean {
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

function fetchOutput(result: WebFetchResult, toolTelemetry: Record<string, unknown>) {
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

function searchOutput(
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

function validateUrlPolicy(rawUrl: string, config: WebCapabilityConfig): { ok: true; url: URL } | { ok: false; reason: string } {
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

function normalizedHostname(value: string): string {
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

function extractReadableText(raw: string, contentType: string | undefined): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes('html')) {
    return { text: normalizeWhitespace(raw) }
  }
  const extracted = extractHtmlText(raw)
  const title = normalizeWhitespace(decodeHtmlTextEntities(extracted.title))
  const text = normalizeWhitespace(decodeHtmlTextEntities(extracted.text))
  return {
    ...(title ? { title } : {}),
    text
  }
}

function extractHtmlText(raw: string): { title: string; text: string } {
  const titleParts: string[] = []
  const textParts: string[] = []
  let index = 0
  let inTitle = false
  let skipTag: 'script' | 'style' | null = null

  while (index < raw.length) {
    if (raw[index] !== '<') {
      if (!skipTag) {
        if (inTitle) titleParts.push(raw[index])
        else textParts.push(raw[index])
      }
      index += 1
      continue
    }

    if (raw.startsWith('<!--', index)) {
      const commentEnd = raw.indexOf('-->', index + 4)
      index = commentEnd >= 0 ? commentEnd + 3 : raw.length
      continue
    }

    const tagEnd = findHtmlTagEnd(raw, index + 1)
    if (tagEnd < 0) {
      if (!skipTag) {
        if (inTitle) titleParts.push(raw[index])
        else textParts.push(raw[index])
      }
      index += 1
      continue
    }

    const tag = parseHtmlTag(raw.slice(index + 1, tagEnd))
    index = tagEnd + 1
    if (!tag) continue

    if (skipTag) {
      if (tag.closing && tag.name === skipTag) skipTag = null
      continue
    }

    if (tag.name === 'script' || tag.name === 'style') {
      if (!tag.closing && !tag.selfClosing) skipTag = tag.name
      continue
    }

    if (tag.name === 'title') {
      inTitle = !tag.closing && !tag.selfClosing
      continue
    }

    if (inTitle) continue
    if (tag.name === 'br' || (tag.closing && isHtmlBlockTag(tag.name))) {
      textParts.push('\n')
    } else {
      textParts.push(' ')
    }
  }

  return {
    title: titleParts.join(''),
    text: textParts.join('')
  }
}

function findHtmlTagEnd(raw: string, start: number): number {
  let quote: string | null = null
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function parseHtmlTag(content: string): {
  name: string
  closing: boolean
  selfClosing: boolean
} | null {
  let index = 0
  while (index < content.length && isHtmlWhitespace(content[index])) index += 1
  const closing = content[index] === '/'
  if (closing) {
    index += 1
    while (index < content.length && isHtmlWhitespace(content[index])) index += 1
  }

  const nameStart = index
  while (index < content.length && isHtmlNameChar(content[index])) index += 1
  if (index === nameStart) return null

  let end = content.length
  while (end > index && isHtmlWhitespace(content[end - 1])) end -= 1
  return {
    name: content.slice(nameStart, index).toLowerCase(),
    closing,
    selfClosing: end > index && content[end - 1] === '/'
  }
}

function decodeHtmlTextEntities(value: string): string {
  let out = ''
  let index = 0
  while (index < value.length) {
    if (value[index] !== '&') {
      out += value[index]
      index += 1
      continue
    }
    const semicolon = value.indexOf(';', index + 1)
    if (semicolon < 0 || semicolon - index > 32) {
      out += value[index]
      index += 1
      continue
    }
    const entity = value.slice(index + 1, semicolon)
    const decoded = decodeHtmlTextEntity(entity)
    if (decoded == null) {
      out += value.slice(index, semicolon + 1)
    } else {
      out += decoded
    }
    index = semicolon + 1
  }
  return out
}

function decodeHtmlTextEntity(entity: string): string | null {
  const lower = entity.toLowerCase()
  switch (lower) {
    case 'nbsp':
      return ' '
    case 'amp':
      return '&'
    case 'quot':
      return '"'
    case 'apos':
      return "'"
    default:
      return decodeNumericHtmlTextEntity(lower)
  }
}

function decodeNumericHtmlTextEntity(entity: string): string | null {
  if (!entity.startsWith('#')) return null
  const hex = entity[1] === 'x'
  const digits = entity.slice(hex ? 2 : 1)
  if (!digits) return null
  const codePoint = htmlEntityCodePoint(digits, hex)
  if (codePoint == null || codePoint <= 0 || codePoint === 60 || codePoint === 62) return null
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return null
  }
}

function htmlEntityCodePoint(digits: string, hex: boolean): number | null {
  let out = 0
  for (const char of digits) {
    const digit = htmlEntityDigitValue(char)
    if (digit == null || digit >= (hex ? 16 : 10)) return null
    out = out * (hex ? 16 : 10) + digit
    if (out > 0x10ffff) return null
  }
  return out
}

function htmlEntityDigitValue(char: string): number | null {
  const code = char.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 97 && code <= 102) return code - 87
  return null
}

function isHtmlBlockTag(name: string): boolean {
  return (
    name === 'p' ||
    name === 'div' ||
    name === 'li' ||
    name === 'section' ||
    name === 'article' ||
    name === 'header' ||
    name === 'footer' ||
    name === 'tr' ||
    name === 'table' ||
    name === 'blockquote' ||
    (name.length === 2 && name[0] === 'h' && name[1] >= '1' && name[1] <= '6')
  )
}

function isHtmlWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f'
}

function isHtmlNameChar(char: string | undefined): boolean {
  if (!char) return false
  return !isHtmlWhitespace(char) && char !== '/' && char !== '>'
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function telemetry(input: {
  startedAt: number
  policy: 'allowed' | 'blocked'
  provider?: string
  url?: string
  query?: string
  byteCount?: number
  resultCount?: number
}): Record<string, unknown> {
  return {
    provider: input.provider,
    url: input.url,
    query: input.query,
    byteCount: input.byteCount,
    resultCount: input.resultCount,
    durationMs: Date.now() - input.startedAt,
    cacheStatus: 'miss',
    policy: input.policy
  }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>) {
  return {
    output: {
      error: {
        code,
        message
      },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
