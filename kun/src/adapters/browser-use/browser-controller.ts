import { randomUUID } from 'node:crypto'
import {
  BROWSER_USE_BRIDGE_CONTRACT_VERSION,
  BrowserUseBridgeResponse,
  KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV,
  KUN_BROWSER_USE_BRIDGE_TOKEN_ENV,
  KUN_BROWSER_USE_BRIDGE_URL_ENV,
  signBrowserUseKunApprovalGrant,
  type BrowserUseActionInput,
  type BrowserUseKunApprovalGrantDraft,
  type BrowserUseKunApprovalMode,
  type BrowserUseToolResult
} from '../../contracts/browser-use.js'
import type {
  BrowserController,
  BrowserControllerReadiness
} from '../../ports/browser-controller.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export type HostBridgeBrowserControllerOptions = {
  bridgeUrl?: string
  bridgeToken?: string
  approvalSigningKey?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export class BrowserControllerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BrowserControllerError'
  }
}

export class HostBridgeBrowserController implements BrowserController {
  private readonly bridgeUrl?: string
  private readonly bridgeToken?: string
  private readonly approvalSigningKey?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: HostBridgeBrowserControllerOptions = {}) {
    const captured = captureManagedBridgeEnvironment()
    this.bridgeUrl = normalizeBridgeUrl(
      options.bridgeUrl ?? captured.bridgeUrl
    )
    this.bridgeToken = normalizeBridgeToken(
      options.bridgeToken ?? captured.bridgeToken
    )
    this.approvalSigningKey = normalizeBridgeToken(
      options.approvalSigningKey ?? captured.approvalSigningKey
    )
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? fetch
  }

  readiness(): BrowserControllerReadiness {
    if (!this.bridgeUrl || !this.bridgeToken || !this.approvalSigningKey) {
      return {
        available: false,
        interactionRequired: true,
        reason: 'Browser Use requires the managed desktop host and a visible authenticated GUI.'
      }
    }
    return { available: true }
  }

  async execute(input: {
    threadId: string
    turnId: string
    action: BrowserUseActionInput
    kunApprovalMode?: BrowserUseKunApprovalMode
    kunApprovalGrant?: BrowserUseKunApprovalGrantDraft
    signal: AbortSignal
  }): Promise<BrowserUseToolResult> {
    const ready = this.readiness()
    if (
      !ready.available ||
      !this.bridgeUrl ||
      !this.bridgeToken ||
      !this.approvalSigningKey
    ) {
      throw new BrowserControllerError(
        'interaction_required',
        ready.reason ?? 'Browser Use host is unavailable.'
      )
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort(input.signal.reason)
    input.signal.addEventListener('abort', onAbort, { once: true })
    const requestId = randomUUID()
    try {
      const signedGrant = input.kunApprovalGrant
        ? signBrowserUseKunApprovalGrant({
            ...input.kunApprovalGrant,
            threadId: input.threadId,
            turnId: input.turnId
          }, this.approvalSigningKey)
        : undefined
      const response = await this.fetchImpl(`${this.bridgeUrl}/v1/actions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.bridgeToken}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          contractVersion: BROWSER_USE_BRIDGE_CONTRACT_VERSION,
          requestId,
          threadId: input.threadId,
          turnId: input.turnId,
          action: input.action,
          ...(input.kunApprovalMode
            ? { kunApprovalMode: input.kunApprovalMode }
            : {}),
          ...(signedGrant
            ? { kunApprovalGrant: signedGrant }
            : {})
        }),
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) {
        throw new BrowserControllerError(
          response.status === 401 ? 'browser_host_unauthorized' : 'browser_host_failed',
          `Browser Use host rejected the request (HTTP ${response.status}).`
        )
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new BrowserControllerError(
          'browser_host_response_too_large',
          'Browser Use host returned an oversized response.'
        )
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new BrowserControllerError(
          'browser_host_response_too_large',
          'Browser Use host returned an oversized response.'
        )
      }
      let raw: unknown
      try {
        raw = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        throw new BrowserControllerError(
          'browser_host_invalid_response',
          'Browser Use host returned malformed JSON.'
        )
      }
      const parsed = BrowserUseBridgeResponse.safeParse(raw)
      if (!parsed.success || parsed.data.requestId !== requestId) {
        throw new BrowserControllerError(
          'browser_host_invalid_response',
          'Browser Use host returned a mismatched or invalid response.'
        )
      }
      return parsed.data.result
    } catch (error) {
      if (error instanceof BrowserControllerError) throw error
      if (controller.signal.aborted) {
        throw new BrowserControllerError(
          input.signal.aborted ? 'aborted' : 'browser_host_timeout',
          input.signal.aborted
            ? 'Browser Use action was cancelled.'
            : 'Browser Use host timed out.'
        )
      }
      throw new BrowserControllerError('browser_host_unavailable', safeErrorMessage(error))
    } finally {
      clearTimeout(timeout)
      input.signal.removeEventListener('abort', onAbort)
    }
  }
}

function normalizeBridgeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/'
    ) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function normalizeBridgeToken(value: string | undefined): string | undefined {
  const token = value?.trim() ?? ''
  return /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : undefined
}

type CapturedManagedBridgeEnvironment = {
  bridgeUrl?: string
  bridgeToken?: string
  approvalSigningKey?: string
}

let capturedManagedBridgeEnvironment: CapturedManagedBridgeEnvironment | undefined

/**
 * Capture the desktop-only authority once, then remove it from process.env
 * before native provider SDKs spawn model-controlled children. The module
 * cache keeps hot-applied Browser Use provider rebuilds connected without
 * republishing either secret through the process environment.
 */
function captureManagedBridgeEnvironment(): CapturedManagedBridgeEnvironment {
  if (capturedManagedBridgeEnvironment) return capturedManagedBridgeEnvironment
  const captured: CapturedManagedBridgeEnvironment = {
    ...(process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV]
      ? { bridgeUrl: process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV] }
      : {}),
    ...(process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]
      ? { bridgeToken: process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV] }
      : {}),
    ...(process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
      ? {
          approvalSigningKey:
            process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
        }
      : {})
  }
  if (Object.keys(captured).length === 0) return captured
  capturedManagedBridgeEnvironment = Object.freeze(captured)
  delete process.env[KUN_BROWSER_USE_BRIDGE_URL_ENV]
  delete process.env[KUN_BROWSER_USE_BRIDGE_TOKEN_ENV]
  delete process.env[KUN_BROWSER_USE_APPROVAL_SIGNING_KEY_ENV]
  return capturedManagedBridgeEnvironment
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .slice(0, 1024)
}
