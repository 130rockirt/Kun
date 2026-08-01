import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorsCapabilityConfig } from '../../contracts/capabilities.js'

export const CONNECTOR_RUNTIME_TOKEN_ENV = 'KUN_OPENCONNECTOR_RUNTIME_TOKEN'
export const CONNECTOR_INSTANCE_PROOF_KEY_ENV = 'KUN_OPENCONNECTOR_INSTANCE_PROOF_KEY'
export const CONNECTOR_PROTOCOL_VERSION = '1'

export const ConnectorSideEffect = z.enum(['read', 'write', 'send', 'delete', 'unknown'])
export type ConnectorSideEffect = z.infer<typeof ConnectorSideEffect>

const JsonObject = z.record(z.string(), z.unknown())
const RuntimeMeta = z.record(z.string(), z.unknown())

const RuntimeFailureEnvelope = z.object({
  success: z.literal(false),
  message: z.string(),
  data: z.unknown(),
  errorCode: z.string().min(1),
  meta: RuntimeMeta
}).strict()

const RuntimeSuccessEnvelope = <T extends z.ZodType>(data: T) => z.object({
  success: z.literal(true),
  message: z.literal('OK'),
  data,
  meta: RuntimeMeta
}).strict()

const ConnectorProviderCategory = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1)
}).strict()

export const ConnectorProviderMetadata = z.object({
  service: z.string().min(1),
  displayName: z.string().min(1),
  iconUrl: z.string().nullable(),
  homepageUrl: z.string().nullable(),
  categories: z.array(ConnectorProviderCategory),
  authTypes: z.array(z.string().min(1))
}).strict()
export type ConnectorProviderMetadata = z.infer<typeof ConnectorProviderMetadata>

export const ConnectorConnectionMetadata = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  status: z.enum(['active', 'disconnected']),
  alias: z.string(),
  authType: z.string().min(1),
  displayName: z.string(),
  accountLabel: z.string(),
  isDefault: z.boolean(),
  scopes: z.array(z.string())
}).strict()
export type ConnectorConnectionMetadata = z.infer<typeof ConnectorConnectionMetadata>

const ConnectorActionExecution = z.object({
  locallyExecutable: z.boolean(),
  catalogOnly: z.boolean(),
  requiredAuthTypes: z.array(z.string().min(1)),
  noAuthRunnable: z.boolean(),
  needsCredential: z.boolean()
}).strict()

const ConnectorActionLifecycle = z.object({
  startActionId: z.string().min(1),
  statusActionId: z.string().min(1),
  cancelActionId: z.string().min(1).optional()
}).strict()

export const ConnectorActionMetadata = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  sideEffect: ConnectorSideEffect.optional(),
  requiredScopes: z.array(z.string()),
  providerPermissions: z.array(z.string()),
  inputSchema: JsonObject,
  outputSchema: JsonObject,
  followUpActions: z.array(z.object({ actionId: z.string().min(1) }).strict()),
  asyncLifecycle: ConnectorActionLifecycle.nullable(),
  execution: ConnectorActionExecution
}).strict()
export type ConnectorActionMetadata = z.infer<typeof ConnectorActionMetadata>

export const ConnectorActionSearchResult = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  sideEffect: ConnectorSideEffect.optional(),
  authenticated: z.boolean(),
  inputSchema: JsonObject.optional(),
  outputSchema: JsonObject.optional()
}).strict()
export type ConnectorActionSearchResult = z.infer<typeof ConnectorActionSearchResult>

const ConnectorHealth = z.object({
  ok: z.literal(true),
  runtime: z.literal('open-connector'),
  runtimeVersion: z.string().min(1),
  protocolVersion: z.literal(CONNECTOR_PROTOCOL_VERSION)
}).strict()

const ConnectorPublicHealth = z.object({
  ok: z.literal(true),
  runtime: z.literal('open-connector'),
  runtimeVersion: z.string().min(1),
  protocolVersion: z.literal(CONNECTOR_PROTOCOL_VERSION),
  instanceProof: z.string().regex(/^[a-f0-9]{64}$/i)
}).passthrough()

export const ConnectorTransitFile = z.object({
  fileId: z.string().min(1),
  downloadUrl: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  name: z.string().min(1),
  mimeType: z.string().min(1)
}).strict()
export type ConnectorTransitFile = z.infer<typeof ConnectorTransitFile>

const HealthEnvelope = RuntimeSuccessEnvelope(ConnectorHealth)
const ProvidersEnvelope = RuntimeSuccessEnvelope(z.array(ConnectorProviderMetadata))
const ConnectionsEnvelope = RuntimeSuccessEnvelope(z.array(ConnectorConnectionMetadata))
const ActionEnvelope = RuntimeSuccessEnvelope(ConnectorActionMetadata)
const SearchEnvelope = RuntimeSuccessEnvelope(z.array(ConnectorActionSearchResult))
const ActionResultEnvelope = RuntimeSuccessEnvelope(z.unknown())
const TransitFileEnvelope = RuntimeSuccessEnvelope(ConnectorTransitFile)

export type ConnectorClientDiagnostic = {
  enabled: boolean
  configured: boolean
  available: boolean
  baseUrl: string
  protocolVersion?: string
  runtimeVersion?: string
  lastCheckedAt?: string
  lastError?: string
}

export type ConnectorActionResult = {
  data: unknown
  meta: Record<string, unknown>
}

export type ConnectorDownloadedFile = {
  content: Buffer
  name?: string
  mimeType?: string
}

export type ConnectorHttpClientOptions = {
  config: ConnectorsCapabilityConfig
  runtimeToken?: string
  instanceProofKey?: string
  fetcher?: typeof fetch
  nowIso?: () => string
}

export class ConnectorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'ConnectorApiError'
  }
}

export class ConnectorOutcomeUnknownError extends Error {
  readonly unknownOutcome = true

  constructor(message: string) {
    super(message)
    this.name = 'ConnectorOutcomeUnknownError'
  }
}

export class ConnectorHttpClient {
  private readonly config: ConnectorsCapabilityConfig
  private readonly runtimeToken: string
  private readonly instanceProofKey: string
  private readonly fetcher: typeof fetch
  private readonly nowIso: () => string
  private diagnostic: ConnectorClientDiagnostic
  private everCompatible = false

  constructor(options: ConnectorHttpClientOptions) {
    this.config = options.config
    this.runtimeToken = options.runtimeToken?.trim() ?? ''
    this.instanceProofKey = options.instanceProofKey?.trim() ?? ''
    this.fetcher = options.fetcher ?? fetch
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.diagnostic = {
      enabled: options.config.enabled,
      configured: Boolean(this.runtimeToken),
      available: false,
      baseUrl: options.config.baseUrl,
      ...(!options.config.enabled
        ? { lastError: 'connectors are disabled by config' }
        : !this.runtimeToken
          ? { lastError: `${CONNECTOR_RUNTIME_TOKEN_ENV} is not configured` }
          : {})
    }
  }

  diagnostics(): ConnectorClientDiagnostic {
    return structuredClone(this.diagnostic)
  }

  isAvailable(): boolean {
    return this.diagnostic.available
  }

  /**
   * Keep a previously validated stable tool catalog callable while a health
   * check is failing. This lets LocalToolHost surface its operation-journal
   * unknown-outcome result instead of losing the tool before replay is denied.
   */
  canAdvertiseTools(): boolean {
    return this.config.enabled && Boolean(this.runtimeToken) && this.everCompatible
  }

  async probeHealth(signal?: AbortSignal): Promise<boolean> {
    if (!this.config.enabled || !this.runtimeToken) return false
    try {
      const response = await this.requestEnvelope('/v1/health', HealthEnvelope, {
        method: 'GET',
        signal
      })
      this.everCompatible = true
      this.diagnostic = {
        enabled: true,
        configured: true,
        available: true,
        baseUrl: this.config.baseUrl,
        protocolVersion: response.data.protocolVersion,
        runtimeVersion: response.data.runtimeVersion,
        lastCheckedAt: this.nowIso()
      }
      return true
    } catch (error) {
      this.markUnavailable(error)
      return false
    }
  }

  async listProviders(query: string | undefined, signal?: AbortSignal): Promise<ConnectorProviderMetadata[]> {
    const search = query ? `?${new URLSearchParams({ q: query }).toString()}` : ''
    const response = await this.requestEnvelope(`/v1/providers${search}`, ProvidersEnvelope, {
      method: 'GET',
      signal
    })
    return response.data
  }

  async listConnections(service: string | undefined, signal?: AbortSignal): Promise<ConnectorConnectionMetadata[]> {
    const path = service
      ? `/v1/apps/services/${encodeURIComponent(service)}`
      : '/v1/apps'
    const response = await this.requestEnvelope(path, ConnectionsEnvelope, {
      method: 'GET',
      signal
    })
    return response.data
  }

  async searchActions(input: {
    query: string
    service?: string
    limit?: number
    signal?: AbortSignal
  }): Promise<ConnectorActionSearchResult[]> {
    const query = new URLSearchParams({
      q: input.query,
      limit: String(Math.min(input.limit ?? this.config.maxSearchResults, this.config.maxSearchResults))
    })
    if (input.service) query.set('service', input.service)
    const response = await this.requestEnvelope(`/v1/actions/search?${query.toString()}`, SearchEnvelope, {
      method: 'GET',
      signal: input.signal
    })
    return response.data
  }

  async getAction(actionId: string, signal?: AbortSignal): Promise<ConnectorActionMetadata> {
    const response = await this.requestEnvelope(
      `/v1/actions/${encodeURIComponent(actionId)}`,
      ActionEnvelope,
      { method: 'GET', signal }
    )
    return response.data
  }

  async executeAction(input: {
    actionId: string
    actionInput: Record<string, unknown>
    connectionName?: string
    idempotencyKey?: string
    signal?: AbortSignal
    outcomeMayBeUnknown?: boolean
  }): Promise<ConnectorActionResult> {
    const response = await this.requestEnvelope(
      `/v1/actions/${encodeURIComponent(input.actionId)}`,
      ActionResultEnvelope,
      {
        method: 'POST',
        signal: input.signal,
        json: {
          input: input.actionInput,
          ...(input.connectionName ? { connectionName: input.connectionName } : {})
        },
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        outcomeMayBeUnknown: input.outcomeMayBeUnknown === true
      }
    )
    return { data: response.data, meta: response.meta }
  }

  async uploadFile(input: {
    content: Buffer
    name: string
    mimeType: string
    signal?: AbortSignal
  }): Promise<ConnectorTransitFile> {
    if (input.content.byteLength > this.config.maxFileBytes) {
      throw new ConnectorApiError(
        `connector file exceeds configured ${this.config.maxFileBytes}-byte limit`,
        413,
        'file_too_large'
      )
    }
    const form = new FormData()
    const bytes = new Uint8Array(input.content.byteLength)
    bytes.set(input.content)
    form.append('file', new Blob([bytes], { type: input.mimeType }), input.name)
    const response = await this.requestEnvelope('/v1/files', TransitFileEnvelope, {
      method: 'POST',
      signal: input.signal,
      body: form
    })
    return {
      ...response.data,
      // Never hand an Action a server-provided arbitrary URL. The opaque id
      // is authoritative and Kun reconstructs the transit URL on the pinned
      // loopback origin.
      downloadUrl: new URL(
        `/v1/files/${encodeURIComponent(response.data.fileId)}`,
        normalizedBaseUrl(this.config.baseUrl)
      ).toString()
    }
  }

  async downloadFile(fileId: string, signal?: AbortSignal): Promise<ConnectorDownloadedFile> {
    const pending = await this.requestRaw(`/v1/files/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      signal
    })
    try {
      const { response } = pending
      if (!response.ok) {
        const content = await readBoundedResponse(response, this.config.maxResultBytes)
        const failure = parseFailureResponse(content)
        throw new ConnectorApiError(
          failure?.message ?? `OpenConnector request failed with HTTP ${response.status}`,
          response.status,
          failure?.errorCode ?? 'invalid_response',
          failure?.data
        )
      }
      const content = await readBoundedResponse(response, this.config.maxFileBytes)
      const disposition = response.headers.get('content-disposition')
      const name = fileNameFromDisposition(disposition)
      return {
        content,
        ...(name ? { name } : {}),
        ...(response.headers.get('content-type')
          ? { mimeType: response.headers.get('content-type')! }
          : {})
      }
    } finally {
      pending.dispose()
    }
  }

  private async requestEnvelope<T extends z.ZodType>(
    path: string,
    schema: T,
    options: {
      method: 'GET' | 'POST' | 'DELETE'
      signal?: AbortSignal
      json?: Record<string, unknown>
      body?: BodyInit
      idempotencyKey?: string
      outcomeMayBeUnknown?: boolean
    }
  ): Promise<z.output<T>> {
    let pending: { response: Response; dispose: () => void }
    try {
      pending = await this.requestRaw(path, options)
    } catch (error) {
      if (options.outcomeMayBeUnknown) {
        throw new ConnectorOutcomeUnknownError(
          'OpenConnector did not confirm the action outcome. Do not retry automatically; verify the external system before deciding whether to run it again.'
        )
      }
      throw error
    }
    try {
      const { response } = pending
      const content = await readBoundedResponse(response, this.config.maxResultBytes)
      let decoded: unknown
      try {
        decoded = JSON.parse(content.toString('utf8'))
      } catch {
        throw new ConnectorApiError('OpenConnector returned invalid JSON', response.status, 'invalid_response')
      }
      if (!response.ok) {
        const failure = RuntimeFailureEnvelope.safeParse(decoded)
        if (!failure.success) {
          throw new ConnectorApiError(
            `OpenConnector request failed with HTTP ${response.status}`,
            response.status,
            'invalid_response'
          )
        }
        if (options.outcomeMayBeUnknown && failure.data.errorCode === 'idempotency_request_in_progress') {
          throw new ConnectorOutcomeUnknownError(
            'OpenConnector reports this idempotency key as still in progress, so the external outcome is unknown. Verify the external system before retrying.'
          )
        }
        throw new ConnectorApiError(
          failure.data.message,
          response.status,
          failure.data.errorCode,
          failure.data.data
        )
      }
      const parsed = schema.safeParse(decoded)
      if (!parsed.success) {
        throw new ConnectorApiError('OpenConnector response did not match the runtime contract', response.status, 'invalid_response')
      }
      return parsed.data
    } catch (error) {
      if (
        options.outcomeMayBeUnknown &&
        !(error instanceof ConnectorOutcomeUnknownError) &&
        (
          !(error instanceof ConnectorApiError) ||
          error.code === 'invalid_response' ||
          error.code === 'result_too_large'
        )
      ) {
        throw new ConnectorOutcomeUnknownError(
          'OpenConnector did not confirm the action outcome. Do not retry automatically; verify the external system before deciding whether to run it again.'
        )
      }
      throw error
    } finally {
      pending.dispose()
    }
  }

  private async requestRaw(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE'
      signal?: AbortSignal
      json?: Record<string, unknown>
      body?: BodyInit
      idempotencyKey?: string
    }
  ): Promise<{ response: Response; dispose: () => void }> {
    if (!this.config.enabled) {
      throw new ConnectorApiError('connectors are disabled by config', 503, 'connector_disabled')
    }
    if (!this.runtimeToken) {
      throw new ConnectorApiError(
        `${CONNECTOR_RUNTIME_TOKEN_ENV} is not configured`,
        503,
        'connector_not_configured'
      )
    }
    const { signal, dispose } = linkedTimeoutSignal(options.signal, this.config.timeoutMs)
    try {
      signal.throwIfAborted()
      await this.assertExpectedInstance(signal)
      signal.throwIfAborted()
      const headers = new Headers({
        authorization: `Bearer ${this.runtimeToken}`,
        accept: 'application/json'
      })
      if (options.json) headers.set('content-type', 'application/json')
      if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)
      const response = await this.fetcher(new URL(path, normalizedBaseUrl(this.config.baseUrl)), {
        method: options.method,
        headers,
        signal,
        ...(options.json ? { body: JSON.stringify(options.json) } : {}),
        ...(options.body ? { body: options.body } : {})
      })
      this.markReachable()
      return { response, dispose }
    } catch (error) {
      dispose()
      this.markUnavailable(error)
      throw error
    }
  }

  /** Authenticate the loopback process before disclosing the bearer token. */
  private async assertExpectedInstance(signal: AbortSignal): Promise<void> {
    if (!this.instanceProofKey) return
    signal.throwIfAborted()
    if (!/^[a-f0-9]{64}$/i.test(this.instanceProofKey)) {
      throw new ConnectorApiError(
        `${CONNECTOR_INSTANCE_PROOF_KEY_ENV} is invalid`,
        503,
        'connector_not_configured'
      )
    }
    const challenge = randomBytes(32).toString('hex')
    const url = new URL('/health', normalizedBaseUrl(this.config.baseUrl))
    url.searchParams.set('challenge', challenge)
    const response = await this.fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal
    })
    signal.throwIfAborted()
    const content = await readBoundedResponse(response, 64 * 1024)
    let decoded: unknown
    try {
      decoded = JSON.parse(content.toString('utf8'))
    } catch {
      throw new ConnectorApiError('OpenConnector instance proof is invalid', 503, 'connector_instance_mismatch')
    }
    const parsed = ConnectorPublicHealth.safeParse(decoded)
    if (!response.ok || !parsed.success) {
      throw new ConnectorApiError('OpenConnector instance proof is unavailable', 503, 'connector_instance_mismatch')
    }
    const expected = createHmac('sha256', Buffer.from(this.instanceProofKey, 'hex'))
      .update(challenge)
      .digest()
    const actual = Buffer.from(parsed.data.instanceProof, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ConnectorApiError(
        'The process on the configured connector port is not the OpenConnector instance started by Kun.',
        503,
        'connector_instance_mismatch'
      )
    }
  }

  private markReachable(): void {
    this.diagnostic = {
      ...this.diagnostic,
      available: true,
      lastCheckedAt: this.nowIso()
    }
    delete this.diagnostic.lastError
  }

  private markUnavailable(error: unknown): void {
    this.diagnostic = {
      ...this.diagnostic,
      available: false,
      lastCheckedAt: this.nowIso(),
      lastError: safeErrorMessage(error)
    }
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ConnectorApiError(
      `OpenConnector response exceeds configured ${maxBytes}-byte limit`,
      413,
      'result_too_large'
    )
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ConnectorApiError(
          `OpenConnector response exceeds configured ${maxBytes}-byte limit`,
          413,
          'result_too_large'
        )
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('OpenConnector request timed out')), timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ConnectorApiError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}

function fileNameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1]
  if (utf8) {
    try {
      return decodeURIComponent(utf8).replaceAll(/[\\/]/g, '_')
    } catch {
      return undefined
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(value)?.[1]
  return quoted?.replaceAll(/[\\/]/g, '_')
}

function parseFailureResponse(content: Buffer): z.infer<typeof RuntimeFailureEnvelope> | undefined {
  try {
    const parsed = RuntimeFailureEnvelope.safeParse(JSON.parse(content.toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
