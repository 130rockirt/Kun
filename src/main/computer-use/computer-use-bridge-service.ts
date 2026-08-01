import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import {
  COMPUTER_USE_BRIDGE_CONTRACT_VERSION,
  ComputerUseBridgeRequest,
  ComputerUseBridgeResponse,
  type ComputerUseBridgeRequest as ComputerUseBridgeRequestValue
} from '../../../kun/src/contracts/computer-use-bridge.js'
import type { HostControlController } from '../../../kun/src/adapters/computer-use/host-control.js'

const MAX_REQUEST_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 120_000

export type ComputerUseBridgeLaunch = {
  url: string
  token: string
}

/**
 * Authenticated loopback bridge owned by the visible Kun GUI. Native screen
 * capture and input automation stay in this process, so the headless Runtime
 * never acquires an Electron/Dock application identity or OS privacy grants.
 */
export class ComputerUseBridgeService {
  private server?: Server
  private launch?: ComputerUseBridgeLaunch
  private activeRequest = false
  private readonly abortControllers = new Set<AbortController>()

  constructor(private readonly controller: HostControlController) {}

  async start(): Promise<ComputerUseBridgeLaunch> {
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
      throw new Error('Computer Use GUI bridge did not bind a TCP port.')
    }
    this.server = server
    this.launch = {
      url: `http://127.0.0.1:${address.port}`,
      token
    }
    return this.launch
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.launch = undefined
    for (const controller of this.abortControllers) controller.abort()
    this.abortControllers.clear()
    this.activeRequest = false
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const launch = this.launch
    if (!launch || !this.validHost(request.headers.host, launch.url)) {
      this.json(response, 400, { error: 'invalid_host' })
      return
    }
    if (!this.validAuthorization(request.headers.authorization, launch.token)) {
      this.json(response, 401, { error: 'unauthorized' })
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
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      this.json(response, 413, { error: 'request_too_large' })
      request.destroy()
      return
    }
    // Desktop input is inherently ordered. Reject overlapping callers rather
    // than interleaving mouse/keyboard actions with an unrelated screenshot.
    if (this.activeRequest) {
      this.json(response, 429, { error: 'bridge_busy' })
      return
    }

    this.activeRequest = true
    const controller = new AbortController()
    this.abortControllers.add(controller)
    request.once('aborted', () => controller.abort())
    try {
      const body = await readBoundedJson(request, MAX_REQUEST_BYTES)
      const parsed = ComputerUseBridgeRequest.safeParse(body)
      if (!parsed.success) {
        this.json(response, 400, { error: 'invalid_request' })
        return
      }
      const result = await this.execute(parsed.data, controller.signal)
      this.json(response, 200, ComputerUseBridgeResponse.parse({
        contractVersion: COMPUTER_USE_BRIDGE_CONTRACT_VERSION,
        requestId: parsed.data.requestId,
        result
      }))
    } catch (error) {
      if (error instanceof RequestBodyError) {
        this.json(response, error.status, { error: error.code })
      } else if (controller.signal.aborted) {
        this.json(response, 499, { error: 'request_aborted' })
      } else {
        this.json(response, 500, { error: 'bridge_failed_closed' })
      }
    } finally {
      this.abortControllers.delete(controller)
      this.activeRequest = false
    }
  }

  private async execute(
    request: ComputerUseBridgeRequestValue,
    signal: AbortSignal
  ): Promise<unknown> {
    switch (request.operation) {
      case 'ready':
        return this.controller.ensureReady()
      case 'capture':
        return this.controller.capture()
      case 'screen_size':
        return this.controller.screenSize()
      case 'cursor_position':
        return this.controller.cursorPosition()
      case 'move_to':
        await this.controller.moveTo(request.x, request.y)
        return { ok: true }
      case 'click':
        await this.controller.click(
          request.x,
          request.y,
          request.button,
          request.count,
          request.modifiers
        )
        return { ok: true }
      case 'drag':
        await this.controller.drag(request.x1, request.y1, request.x2, request.y2)
        return { ok: true }
      case 'scroll':
        await this.controller.scroll(
          request.x,
          request.y,
          request.direction,
          request.amount
        )
        return { ok: true }
      case 'type_text':
        await this.controller.typeText(request.text)
        return { ok: true }
      case 'press_hotkey':
        await this.controller.pressHotkey(request.key)
        return { ok: true }
      case 'wait':
        await this.controller.wait(request.ms, signal)
        return { ok: true }
    }
  }

  private validHost(host: string | undefined, launchUrl: string): boolean {
    if (!host) return false
    return host.toLowerCase() === new URL(launchUrl).host.toLowerCase()
  }

  private validAuthorization(header: string | undefined, token: string): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
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

function readBoundedJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        reject(new RequestBodyError(413, 'request_too_large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new RequestBodyError(400, 'invalid_json'))
      }
    })
    request.once('error', reject)
  })
}
