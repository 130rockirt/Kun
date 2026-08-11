import { net } from 'electron'
import {
  isCustomModelEndpointFormat,
  normalizeModelEndpointFormat,
  resolveModelProviderProxyUrl,
  type AppSettingsV1,
  type ModelEndpointFormat
} from '../shared/app-settings'
import type { ModelProviderProbeRequest, ModelProviderProbeResult } from '../shared/kun-gui-api'
import { upstreamOpenAiModelsUrl } from '../shared/openai-compat-url'
import {
  CHATGPT_SUBSCRIPTION_MODEL_IDS,
  GROK_SUBSCRIPTION_MODEL_IDS
} from '../shared/model-provider-presets'
import { fetchWithOptionalProxy } from './proxy-fetch'
import { isCodexOAuthCredentials, parseCodexCredentials } from './codex-auth'
import {
  ensureFreshGrokCredentials,
  isGrokOAuthCredentials,
  parseGrokCredentials
} from './grok-auth'
import { logWarn } from './logger'

function isCodexBaseUrl(url: string): boolean {
  return hasExpectedHttpsHost(url, 'chatgpt.com') && new URL(url).pathname.startsWith('/backend-api/codex')
}

function isGrokSubscriptionBaseUrl(url: string): boolean {
  return hasExpectedHttpsHost(url, 'cli-chat-proxy.grok.com')
}

function hasExpectedHttpsHost(url: string, host: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === host
  } catch {
    return false
  }
}

const PROBE_TIMEOUT_MS = 10_000
const MAX_MODEL_LIST_RESPONSE_BYTES = 2_000_000
const MAX_MODEL_COUNT = 2_000
const MAX_MODEL_ID_LENGTH = 512
// The proxy-vs-direct diagnosis runs only after the proxied probe already
// failed, so it gets a shorter budget — we just need to learn whether the
// provider is reachable at all, not wait out another full timeout (which would
// make a failed test connection take up to 20s).
const DIRECT_PROBE_TIMEOUT_MS = 5_000
const CHROMIUM_PROBE_HEAD_START_MS = 250
const ANTHROPIC_VERSION = '2023-06-01'

type ProviderProbeFetch = typeof fetchWithOptionalProxy

/**
 * Provider discovery is a desktop UI operation. Without an explicit model
 * proxy, prefer Chromium's network stack so system proxy/PAC and desktop TLS
 * behavior match links opened by the app. Node fetch remains a fallback for
 * environments where Electron net is unavailable or rejects the request.
 */
export async function fetchProviderProbe(
  input: string | URL,
  init: RequestInit | undefined,
  proxyUrl: string
): Promise<Response> {
  if (proxyUrl.trim()) return fetchWithOptionalProxy(input, init, proxyUrl)
  if (typeof net?.fetch !== 'function') return fetchWithOptionalProxy(input, init, '')

  const chromiumController = new AbortController()
  const chromiumRequest = net.fetch(
    input.toString(),
    withProbeTransportSignal(init, chromiumController)
  ) as Promise<Response>
  let headStartTimer: ReturnType<typeof setTimeout> | undefined
  const earlyChromiumResult = await Promise.race([
    chromiumRequest.then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'error' as const, error })
    ),
    new Promise<{ kind: 'pending' }>((resolve) => {
      headStartTimer = setTimeout(
        () => resolve({ kind: 'pending' }),
        CHROMIUM_PROBE_HEAD_START_MS
      )
    })
  ])
  if (headStartTimer) clearTimeout(headStartTimer)
  if (earlyChromiumResult.kind === 'response') return earlyChromiumResult.response

  const nodeController = new AbortController()
  const nodeRequest = fetchWithOptionalProxy(
    input,
    withProbeTransportSignal(init, nodeController),
    ''
  )
  if (earlyChromiumResult.kind === 'error') {
    try {
      return await nodeRequest
    } catch (nodeError) {
      throw new AggregateError(
        [earlyChromiumResult.error, nodeError],
        'Chromium and Node network requests both failed'
      )
    }
  }

  try {
    const winner = await Promise.any([
      chromiumRequest.then((response) => ({ transport: 'chromium' as const, response })),
      nodeRequest.then((response) => ({ transport: 'node' as const, response }))
    ])
    if (winner.transport === 'chromium') nodeController.abort()
    else chromiumController.abort()
    return winner.response
  } catch (error) {
    const causes = error instanceof AggregateError ? error.errors : [error]
    throw new AggregateError(causes, 'Chromium and Node network requests both failed')
  }
}

function withProbeTransportSignal(
  init: RequestInit | undefined,
  controller: AbortController
): RequestInit | undefined {
  if (!init) return { signal: controller.signal }
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal
  return { ...init, signal }
}

export function providerProbeHeaders(
  endpointFormat: ModelEndpointFormat,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const key = apiKey.trim()
  if (endpointFormat === 'messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key) headers['x-api-key'] = key
    return headers
  }
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

/**
 * Probe a model provider by listing its models endpoint. Runs in the main
 * process so the API key never leaves it and renderer CORS does not apply.
 */
export async function probeModelProvider(
  request: ModelProviderProbeRequest,
  settings?: AppSettingsV1,
  fetcher: ProviderProbeFetch = fetchProviderProbe
): Promise<ModelProviderProbeResult> {
  const baseUrl = request.baseUrl.trim()
  const proxyUrl = settings ? resolveModelProviderProxyUrl(settings) : ''
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: 'Base URL must start with http:// or https://.' }
  }
  if (isCodexBaseUrl(baseUrl)) {
    const rawKey = request.apiKey.trim()
    if (!rawKey) {
      return { ok: false, message: 'ChatGPT 订阅未登录，请先点击「登录 ChatGPT」。' }
    }
    if (!isCodexOAuthCredentials(rawKey)) {
      return { ok: false, message: 'ChatGPT 订阅凭据格式无效，请重新登录。' }
    }
    const creds = parseCodexCredentials(rawKey)
    if (!creds) {
      return { ok: false, message: 'ChatGPT 订阅凭据已损坏，请重新登录。' }
    }
    if (creds.expiresAt < Date.now()) {
      return { ok: false, message: 'ChatGPT 订阅凭据已过期，请重新登录。' }
    }
    return { ok: true, latencyMs: 0, modelIds: [...CHATGPT_SUBSCRIPTION_MODEL_IDS] }
  }
  if (isGrokSubscriptionBaseUrl(baseUrl)) {
    const rawKey = request.apiKey.trim()
    if (!rawKey) {
      return { ok: false, message: 'Grok 订阅未登录，请先点击「登录 Grok」。' }
    }
    if (!isGrokOAuthCredentials(rawKey)) {
      return { ok: false, message: 'Grok 订阅凭据格式无效，请重新登录。' }
    }
    const fresh = await ensureFreshGrokCredentials(rawKey, { fetcher, proxyUrl })
    const creds = fresh.credentials ?? parseGrokCredentials(fresh.apiKey)
    if (!creds) {
      return { ok: false, message: 'Grok 订阅凭据已损坏，请重新登录。' }
    }
    if (creds.expiresAt < Date.now()) {
      return { ok: false, message: 'Grok 订阅凭据已过期，请重新登录。' }
    }
    return { ok: true, latencyMs: 0, modelIds: [...GROK_SUBSCRIPTION_MODEL_IDS] }
  }
  const endpointFormat = normalizeModelEndpointFormat(request.endpointFormat)
  if (isCustomModelEndpointFormat(endpointFormat)) {
    return {
      ok: false,
      message: 'Custom full endpoint mode does not support /models probing. Add model IDs manually.'
    }
  }
  const url = upstreamOpenAiModelsUrl(baseUrl)
  const startedAt = Date.now()
  let res: Response
  let text: string
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: providerProbeHeaders(endpointFormat, request.apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    }, proxyUrl)
    const body = await readBoundedResponseText(res, MAX_MODEL_LIST_RESPONSE_BYTES)
    if (body.truncated) {
      return { ok: false, message: `Model list response exceeded the ${MAX_MODEL_LIST_RESPONSE_BYTES} byte limit.` }
    }
    text = body.text
  } catch (e) {
    const message = providerProbeFailureMessage(e, url)
    logWarn('provider-probe', 'Provider model discovery failed.', {
      requestUrl: url,
      usingConfiguredProxy: Boolean(proxyUrl),
      message: describeProviderProbeError(e)
    })
    if (proxyUrl && await directProviderReachable(url, endpointFormat, request.apiKey, fetcher)) {
      return {
        ok: false,
        message: `${message} The configured model-request proxy failed, but a direct connection reached the provider. Disable or update the proxy in Settings > Providers.`
      }
    }
    return { ok: false, message }
  }
  const latencyMs = Date.now() - startedAt
  if (!res.ok) {
    return { ok: false, message: `${url} responded ${res.status}: ${text.slice(0, 300)}` }
  }
  return { ok: true, latencyMs, modelIds: parseModelIds(text) }
}

function providerProbeFailureMessage(error: unknown, url: string): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `Request to ${url} timed out after ${PROBE_TIMEOUT_MS / 1_000}s.`
  }
  return `Request to ${url} failed: ${describeProviderProbeError(error)}`
}

/** Flatten Node fetch causes and Chromium/Node AggregateErrors for actionable UI output. */
export function describeProviderProbeError(error: unknown): string {
  const pending: unknown[] = [error]
  const parts: string[] = []
  for (let depth = 0; depth < 10 && pending.length > 0; depth += 1) {
    const current = pending.shift()
    if (current instanceof AggregateError) {
      const message = current.message.trim()
      if (message) parts.push(message)
      pending.unshift(...current.errors)
      continue
    }
    if (!(current instanceof Error)) {
      if (current != null) parts.push(String(current))
      continue
    }
    const code = (current as { code?: unknown }).code
    const codeText = typeof code === 'string' ? code : ''
    const message = current.message.trim()
    if (message) {
      parts.push(codeText && !message.includes(codeText) ? `${message} (${codeText})` : message)
    } else if (codeText) {
      parts.push(codeText)
    }
    if (current.cause != null) pending.push(current.cause)
  }
  const unique = parts.filter((part, index) => parts.indexOf(part) === index)
  return unique.join(': ') || 'unknown network error'
}

async function directProviderReachable(
  url: string,
  endpointFormat: ModelEndpointFormat,
  apiKey: string,
  fetcher: ProviderProbeFetch
): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: providerProbeHeaders(endpointFormat, apiKey),
      signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS)
    }, '')
    await response.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}

export function parseModelIds(body: string): string[] {
  if (body.length > MAX_MODEL_LIST_RESPONSE_BYTES) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (() => {
          const record = parsed as { data?: unknown; models?: unknown }
          if (Array.isArray(record.data)) return record.data
          if (Array.isArray(record.models)) return record.models
          return []
        })()
      : []
  const ids = new Set<string>()
  for (const row of rows.slice(0, MAX_MODEL_COUNT)) {
    if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
      const id = (row as { id: string }).id.trim()
      if (id && id.length <= MAX_MODEL_ID_LENGTH) ids.add(id)
    }
  }
  return [...ids]
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { text: '', truncated: true }
  }
  if (!response.body) {
    const text = await response.text()
    return { text, truncated: new TextEncoder().encode(text).byteLength > maxBytes }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!next.value) continue
      totalBytes += next.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { text: '', truncated: true }
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated: false }
}
