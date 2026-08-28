import {
  WpsOfficeDocumentRefSchema,
  WpsOfficeGatewayError,
  WpsOfficeInspectResponseSchema,
  WpsOfficeRenderResponseSchema,
  WpsOfficeSessionSchema,
  WpsOfficeVersionSchema,
  type WpsOfficeInspectRequest,
  type WpsOfficeOperation
} from '../../contracts/wps-office.js'
import type { WpsOfficeGateway, WpsOfficeUpload } from '../../ports/wps-office.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_JSON_BYTES = 6 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

export type WpsOfficeClientOptions = {
  baseUrl: string
  tenantId: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  allowLoopbackHttp?: boolean
  authorizationHeader?: () => Promise<string | undefined> | string | undefined
}

export class WpsOfficeClient implements WpsOfficeGateway {
  private readonly baseUrl: URL
  private readonly tenantId: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof globalThis.fetch
  private readonly authorizationHeader?: WpsOfficeClientOptions['authorizationHeader']

  constructor(options: WpsOfficeClientOptions) {
    this.baseUrl = safeGatewayBaseUrl(options.baseUrl, options.allowLoopbackHttp === true)
    this.tenantId = boundedIdentifier(options.tenantId, 'tenantId')
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000))
    this.fetcher = options.fetch ?? globalThis.fetch
    this.authorizationHeader = options.authorizationHeader
  }

  async putDocument(input: WpsOfficeUpload, signal?: AbortSignal) {
    const response = await this.request('documents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': input.idempotencyKey,
        'X-Kun-Office-Format': input.format,
        'X-Kun-Source-Sha256': input.sourceSha256,
        'X-Kun-Workspace-Identity': input.workspaceIdentity,
        'X-Kun-Relative-Path': encodeURIComponent(input.relativePath)
      },
      body: Buffer.from(input.content)
    }, signal)
    return WpsOfficeDocumentRefSchema.parse(await boundedJson(response))
  }

  async createSession(documentId: string, input: { mode: 'read' | 'edit'; locale?: string; idempotencyKey: string }, signal?: AbortSignal) {
    const response = await this.jsonRequest(`documents/${pathId(documentId)}/sessions`, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({ mode: input.mode, ...(input.locale ? { locale: input.locale } : {}) })
    }, signal)
    return WpsOfficeSessionSchema.parse(response)
  }

  async inspect(documentId: string, input: WpsOfficeInspectRequest, signal?: AbortSignal) {
    const response = await this.jsonRequest(`documents/${pathId(documentId)}/inspect`, {
      method: 'POST', body: JSON.stringify(input)
    }, signal)
    return WpsOfficeInspectResponseSchema.parse(response)
  }

  async applyOperations(documentId: string, input: { expectedVersion: string; operations: WpsOfficeOperation[]; idempotencyKey: string }, signal?: AbortSignal) {
    const response = await this.jsonRequest(`documents/${pathId(documentId)}/operations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({ expectedVersion: input.expectedVersion, operations: input.operations })
    }, signal)
    return WpsOfficeVersionSchema.parse(response)
  }

  async render(documentId: string, input: { page?: number; sheet?: string; range?: string }, signal?: AbortSignal) {
    const response = await this.jsonRequest(`documents/${pathId(documentId)}/render`, {
      method: 'POST', body: JSON.stringify(input)
    }, signal)
    return WpsOfficeRenderResponseSchema.parse(response)
  }

  async download(documentId: string, version: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(
      `documents/${pathId(documentId)}/content?version=${encodeURIComponent(version)}`,
      { method: 'GET' },
      signal
    )
    const value = await boundedBytes(response, MAX_DOCUMENT_BYTES, 'WPS document download')
    if (value.byteLength === 0) throw invalidResponse('WPS document download is empty')
    return value
  }

  async delete(documentId: string, idempotencyKey: string, signal?: AbortSignal): Promise<void> {
    await this.request(`documents/${pathId(documentId)}`, {
      method: 'DELETE', headers: { 'Idempotency-Key': idempotencyKey }
    }, signal)
  }

  private async jsonRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
    }, signal)
    return boundedJson(response)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const authorization = await this.authorizationHeader?.()
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, application/octet-stream',
          'X-Kun-Tenant-Id': this.tenantId,
          ...(authorization ? { Authorization: authorization } : {}),
          ...(init.headers as Record<string, string> | undefined)
        }
      })
      if (response.ok) return response
      if (response.status === 409) throw new WpsOfficeGatewayError('remote_changed', 'WPS document version changed')
      throw new WpsOfficeGatewayError(
        'gateway_unavailable',
        `WPS gateway request failed with HTTP ${response.status}`,
        response.status === 429 || response.status >= 500
      )
    } catch (error) {
      if (error instanceof WpsOfficeGatewayError) throw error
      const timedOut = controller.signal.aborted && !signal?.aborted
      throw new WpsOfficeGatewayError(
        'gateway_unavailable',
        timedOut ? 'WPS gateway request timed out' : 'WPS gateway request failed',
        true
      )
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function safeGatewayBaseUrl(value: string, allowLoopbackHttp = false): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('WPS gateway URL is invalid') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if ((url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('WPS gateway URL must be credential-free HTTPS')
  }
  url.hash = ''
  url.search = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, MAX_JSON_BYTES, 'WPS gateway JSON response')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  try { return JSON.parse(text) } catch { throw invalidResponse('WPS gateway returned invalid JSON') }
}

async function boundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limit) throw invalidResponse(`${label} exceeds its size limit`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw invalidResponse(`${label} exceeds its size limit`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function invalidResponse(message: string): WpsOfficeGatewayError {
  return new WpsOfficeGatewayError('invalid_gateway_response', message)
}

function pathId(value: string): string { return encodeURIComponent(boundedIdentifier(value, 'documentId')) }
function boundedIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) throw new Error(`${label} is invalid`)
  return normalized
}
