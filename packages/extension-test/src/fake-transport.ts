import {
  AccountSchema,
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  ExtensionApiError,
  ExtensionHostClient,
  ExtensionToolDeclarationSchema,
  GeneratedArtifactSchema,
  HostMessageSchema,
  JobCancelRequestSchema,
  JobEventSchema,
  JobFilterSchema,
  JobListRequestSchema,
  JobResultSchema,
  JobSnapshotSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaMetadataSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickSaveTargetRequestSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartArchiveJobRequestSchema,
  MediaVisualModelStatusSchema,
  ModelProviderDeclarationSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ProviderStatusSchema,
  ThemeSchema,
  LocaleSchema,
  createExtensionContext,
  hasPermission,
  toDisposable,
  type Account,
  type Activate,
  type AgentCreateRunRequest,
  type AgentRun,
  type AgentRunEvent,
  type Deactivate,
  type Disposable,
  type ExtensionContext,
  type ExtensionIdentity,
  type ExtensionToolDeclaration,
  type HostNotification,
  type HostRequestContext,
  type HostRequestHandler,
  type HostRequestOptions,
  type HostTransport,
  type GeneratedArtifact,
  type JobEvent,
  type JobListRequest,
  type JobResult,
  type JobResultInput,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaAudioAnalysisCapabilities,
  type MediaVisualModelStatus,
  type MediaCapabilities,
  type ModelProviderDeclaration,
  type ModelProviderStreamEvent,
  type MediaMetadata,
  type MediaProbeResult,
  type NetworkResponse,
  type Permission,
  type ProviderStatus,
  type Theme,
  type Locale,
  type WorkspaceContext,
  type WorkspaceFile
} from '@kun/extension-api'
import { createHash } from 'node:crypto'


type FakeHostHandler = (
  params: JsonValue | undefined,
  options: HostRequestOptions
) => unknown | Promise<unknown>
type PermissionResolver = (params: JsonValue | undefined) => string | readonly string[] | undefined

export class FakeClock {
  #now: number

  constructor(now = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.#now = now
  }

  now(): number {
    return this.#now
  }

  nowIso(): string {
    return new Date(this.#now).toISOString()
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('FakeClock can only advance by a positive duration')
    this.#now += ms
  }
}

export interface FakeTransportOptions {
  permissions?: Iterable<Permission | string>
}

export class FakeHostTransport implements HostTransport {
  readonly #hostHandlers = new Map<string, FakeHostHandler>()
  readonly #extensionHandlers = new Map<string, HostRequestHandler>()
  readonly #notificationListeners = new Set<(notification: HostNotification) => void>()
  readonly #permissionResolvers = new Map<string, PermissionResolver>()
  readonly permissions = new Set<string>()
  readonly sentNotifications: HostNotification[] = []
  readonly sentStreams: Array<{ requestId: string; payload: JsonValue; terminal: boolean }> = []
  readonly requests: Array<{ method: string; params?: JsonValue }> = []
  #disposed = false
  #nextInvocation = 1

  constructor(options: FakeTransportOptions = {}) {
    for (const permission of options.permissions ?? []) this.permissions.add(permission)
  }

  handle(method: string, handler: FakeHostHandler): Disposable {
    this.#hostHandlers.set(method, handler)
    return toDisposable(() => {
      this.#hostHandlers.delete(method)
    })
  }

  requirePermission(
    method: string,
    permission: string | readonly string[] | PermissionResolver
  ): void {
    this.#permissionResolvers.set(method, typeof permission === 'function' ? permission : () => permission)
  }

  grant(...permissions: string[]): void {
    for (const permission of permissions) this.permissions.add(permission)
  }

  deny(...permissions: string[]): void {
    for (const permission of permissions) this.permissions.delete(permission)
  }

  async request(
    method: string,
    params?: JsonValue,
    options: HostRequestOptions = {}
  ): Promise<unknown> {
    this.#assertActive()
    if (options.signal?.aborted) throw this.#cancelled(method)
    this.requests.push({ method, params })
    const required = this.#permissionResolvers.get(method)?.(params)
    const missing = (typeof required === 'string' ? [required] : required ?? [])
      .find((permission) => !hasPermission([...this.permissions], permission))
    if (missing) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: `Permission ${missing} is required for ${method}`,
        operation: method,
        retryable: false,
        details: { permission: missing }
      })
    }
    const handler = this.#hostHandlers.get(method)
    if (!handler) {
      throw new ExtensionApiError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: `Fake Host has no handler for ${method}`,
        operation: method,
        retryable: false
      })
    }
    return handler(params, options)
  }

  notify(method: string, params?: JsonValue): void {
    this.#assertActive()
    this.sentNotifications.push({ method, params })
  }

  async sendStream(requestId: string, payload: JsonValue, terminal = false): Promise<void> {
    this.#assertActive()
    this.sentStreams.push({ requestId, payload, terminal })
  }

  onNotification(listener: (notification: HostNotification) => void): Disposable {
    this.#notificationListeners.add(listener)
    return toDisposable(() => {
      this.#notificationListeners.delete(listener)
    })
  }

  registerHandler(method: string, handler: HostRequestHandler): Disposable {
    if (this.#extensionHandlers.has(method)) throw new Error(`Duplicate extension handler: ${method}`)
    this.#extensionHandlers.set(method, handler)
    return toDisposable(() => {
      this.#extensionHandlers.delete(method)
    })
  }

  emit(method: string, params?: JsonValue): void {
    this.#assertActive()
    for (const listener of [...this.#notificationListeners]) listener({ method, params })
  }

  async invokeExtension(
    method: string,
    params?: JsonValue,
    options: HostRequestOptions = {}
  ): Promise<JsonValue> {
    this.#assertActive()
    const handler = this.#extensionHandlers.get(method)
    if (!handler) {
      throw new ExtensionApiError({
        code: 'NOT_FOUND',
        message: `Extension handler ${method} is not registered`,
        operation: method,
        retryable: false
      })
    }
    return handler(params, {
      signal: options.signal,
      requestId: `fake_request_${this.#nextInvocation++}`
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#hostHandlers.clear()
    this.#extensionHandlers.clear()
    this.#notificationListeners.clear()
    this.sentStreams.splice(0)
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('FakeHostTransport is disposed')
  }

  #cancelled(operation: string): ExtensionApiError {
    return new ExtensionApiError({
      code: 'CANCELLED',
      message: `${operation} was cancelled`,
      operation,
      retryable: false
    })
  }
}
