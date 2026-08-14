import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import {
  BROWSER_USE_BRIDGE_CONTRACT_VERSION,
  BrowserUseBridgeRequest,
  BrowserUseHostChallengeRequest,
  signBrowserUseBridgeResponse,
  signBrowserUseHostChallenge,
  verifyBrowserUseKunApprovalGrant
} from '../../../kun/src/contracts/browser-use.js'
import { decryptBrowserUseActionEnvelope } from '../../../kun/src/contracts/browser-use-bridge-crypto.js'
import { ToolOperationJournal } from '../../../kun/src/reliability/operation-journal.js'
import type { BrowserUseManager } from './browser-use-manager'

const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_MAX_CONCURRENCY = 8
const REQUEST_TIMEOUT_MS = 120_000
const MAX_CONSUMED_APPROVAL_GRANTS = 4_096

export type BrowserUseBridgeLaunch = {
  url: string
  token: string
  approvalSigningKey: string
}

export class BrowserUseBridgeService {
  private server?: Server
  private launch?: BrowserUseBridgeLaunch
  private activeRequests = 0
  private readonly abortControllers = new Set<AbortController>()
  private readonly consumedApprovalGrants = new Map<string, number>()

  constructor(
    private readonly manager: BrowserUseManager,
    private readonly maxConcurrency = DEFAULT_MAX_CONCURRENCY
  ) {}

  async start(): Promise<BrowserUseBridgeLaunch> {
    if (this.launch) return this.launch
    const token = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    server.maxHeadersCount = 32
    server.headersTimeout = 5_000
    server.requestTimeout = REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = 1_000
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Browser Use host bridge did not bind a TCP port.')
    }
    this.server = server
    this.launch = {
      url: `http://127.0.0.1:${address.port}`,
      token,
      approvalSigningKey: randomBytes(32).toString('base64url')
    }
    return this.launch
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.launch = undefined
    for (const controller of this.abortControllers) controller.abort()
    this.abortControllers.clear()
    this.consumedApprovalGrants.clear()
    await this.manager.disposeAll('bridge-stopped')
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const launch = this.launch
    if (!launch || !this.validHost(request.headers.host, launch.url)) {
      this.json(response, 400, { error: 'invalid_host' })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/challenge') {
      await this.handleChallenge(request, response, launch)
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/actions') {
      this.json(response, 404, { error: 'unsupported_operation' })
      return
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      this.json(response, 415, { error: 'content_type_required' })
      return
    }
    const declaredLength = parseDeclaredContentLength(request.headers['content-length'])
    if (declaredLength === null) {
      this.json(response, 400, { error: 'invalid_content_length' })
      request.destroy()
      return
    }
    if (declaredLength > MAX_REQUEST_BYTES) {
      this.json(response, 413, { error: 'request_too_large' })
      request.destroy()
      return
    }
    if (this.activeRequests >= this.maxConcurrency) {
      this.json(response, 429, { error: 'bridge_concurrency_exceeded' })
      return
    }

    this.activeRequests += 1
    const controller = new AbortController()
    this.abortControllers.add(controller)
    const onRequestClosed = (): void => controller.abort()
    const onResponseClosed = (): void => {
      if (!response.writableEnded) controller.abort()
    }
    request.once('aborted', onRequestClosed)
    response.once('close', onResponseClosed)
    try {
      const body = await readBoundedJson(request, MAX_REQUEST_BYTES, controller.signal)
      let decrypted: ReturnType<typeof decryptBrowserUseActionEnvelope>
      try {
        decrypted = decryptBrowserUseActionEnvelope(body, launch.approvalSigningKey)
      } catch {
        this.json(response, 400, { error: 'invalid_envelope' })
        return
      }
      if (!this.validBridgeToken(decrypted.bridgeToken, launch.token)) {
        this.json(response, 401, { error: 'unauthorized' })
        return
      }
      const parsed = BrowserUseBridgeRequest.safeParse(decrypted.request)
      if (!parsed.success) {
        this.json(response, 400, { error: 'invalid_request' })
        return
      }
      const grant = parsed.data.kunApprovalGrant
      if (
        grant &&
        (
          !verifyBrowserUseKunApprovalGrant(
            grant,
            launch.approvalSigningKey
          ) ||
          grant.threadId !== parsed.data.threadId ||
          grant.turnId !== parsed.data.turnId ||
          grant.argumentsHash !== ToolOperationJournal.argsHash(parsed.data.action)
        )
      ) {
        this.json(response, 400, { error: 'approval_grant_invalid' })
        return
      }
      if (grant && !this.consumeApprovalGrant(grant.id, grant.issuedAt, grant.expiresAt)) {
        this.json(response, 409, { error: 'approval_grant_replayed' })
        return
      }
      const result = grant
        ? await this.manager.execute(
            parsed.data.threadId,
            parsed.data.turnId,
            parsed.data.action,
            controller.signal,
            grant,
            parsed.data.kunApprovalMode
          )
        : await this.manager.execute(
            parsed.data.threadId,
            parsed.data.turnId,
            parsed.data.action,
            controller.signal
          )
      this.json(response, 200, signBrowserUseBridgeResponse({
        contractVersion: BROWSER_USE_BRIDGE_CONTRACT_VERSION,
        requestId: parsed.data.requestId,
        result
      }, launch.approvalSigningKey))
    } catch (error) {
      if (error instanceof RequestBodyError) {
        this.json(response, error.status, { error: error.code })
      } else if (controller.signal.aborted) {
        this.json(response, 499, { error: 'request_aborted' })
      } else {
        this.json(response, 500, { error: 'bridge_failed_closed' })
      }
    } finally {
      request.removeListener('aborted', onRequestClosed)
      response.removeListener('close', onResponseClosed)
      this.abortControllers.delete(controller)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
  }

  private async handleChallenge(
    request: IncomingMessage,
    response: ServerResponse,
    launch: BrowserUseBridgeLaunch
  ): Promise<void> {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      this.json(response, 415, { error: 'content_type_required' })
      return
    }
    const declaredLength = parseDeclaredContentLength(request.headers['content-length'])
    if (declaredLength === null) {
      this.json(response, 400, { error: 'invalid_content_length' })
      request.destroy()
      return
    }
    if (declaredLength > MAX_REQUEST_BYTES) {
      this.json(response, 413, { error: 'request_too_large' })
      request.destroy()
      return
    }
    if (this.activeRequests >= this.maxConcurrency) {
      this.json(response, 429, { error: 'bridge_concurrency_exceeded' })
      return
    }

    this.activeRequests += 1
    const controller = new AbortController()
    this.abortControllers.add(controller)
    const onRequestClosed = (): void => controller.abort()
    request.once('aborted', onRequestClosed)
    try {
      const body = await readBoundedJson(request, MAX_REQUEST_BYTES, controller.signal)
      const parsed = BrowserUseHostChallengeRequest.safeParse(body)
      if (!parsed.success) {
        this.json(response, 400, { error: 'invalid_request' })
        return
      }
      this.json(response, 200, signBrowserUseHostChallenge(
        parsed.data,
        launch.approvalSigningKey
      ))
    } catch (error) {
      if (error instanceof RequestBodyError) {
        this.json(response, error.status, { error: error.code })
      } else {
        this.json(response, 500, { error: 'bridge_failed_closed' })
      }
    } finally {
      request.removeListener('aborted', onRequestClosed)
      this.abortControllers.delete(controller)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
  }

  private validHost(host: string | undefined, launchUrl: string): boolean {
    if (!host) return false
    return host.toLowerCase() === new URL(launchUrl).host.toLowerCase()
  }

  private validBridgeToken(candidate: string, token: string): boolean {
    const supplied = Buffer.from(candidate, 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private consumeApprovalGrant(
    id: string,
    issuedAtIso: string,
    expiresAtIso: string
  ): boolean {
    const now = Date.now()
    for (const [candidateId, candidateExpiry] of this.consumedApprovalGrants) {
      if (candidateExpiry <= now) this.consumedApprovalGrants.delete(candidateId)
    }
    if (this.consumedApprovalGrants.has(id)) return false
    const issuedAt = Date.parse(issuedAtIso)
    const expiresAt = Date.parse(expiresAtIso)
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now + 5_000 ||
      expiresAt <= now
    ) return false
    if (this.consumedApprovalGrants.size >= MAX_CONSUMED_APPROVAL_GRANTS) return false
    this.consumedApprovalGrants.set(id, expiresAt)
    return true
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) {
      response.destroy()
      return
    }
    const payload = Buffer.from(JSON.stringify(body))
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.byteLength),
      'cache-control': 'no-store',
      connection: 'close',
      'x-content-type-options': 'nosniff'
    })
    response.end(payload)
  }
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

function readBoundedJson(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (
      outcome: { ok: true; value: unknown } | { ok: false; error: unknown }
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      if (outcome.ok) resolve(outcome.value)
      else reject(outcome.error)
    }
    const onAborted = (): void => finish({
      ok: false,
      error: new RequestBodyError(499, 'request_aborted')
    })
    const onSignalAborted = (): void => finish({
      ok: false,
      error: new RequestBodyError(499, 'request_aborted')
    })
    const onError = (error: unknown): void => finish({ ok: false, error })
    const onEnd = (): void => {
      try {
        finish({
          ok: true,
          value: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        })
      } catch {
        finish({ ok: false, error: new RequestBodyError(400, 'invalid_json') })
      }
    }
    const cleanup = (): void => {
      request.removeListener('aborted', onAborted)
      request.removeListener('error', onError)
      request.removeListener('end', onEnd)
      request.removeListener('data', onData)
      signal.removeEventListener('abort', onSignalAborted)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        finish({ ok: false, error: new RequestBodyError(413, 'request_too_large') })
        request.destroy()
        return
      }
      chunks.push(buffer)
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
    signal.addEventListener('abort', onSignalAborted, { once: true })
    if (signal.aborted) onSignalAborted()
  })
}

export function parseDeclaredContentLength(value: string | undefined): number | null {
  if (value === undefined) return 0
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
