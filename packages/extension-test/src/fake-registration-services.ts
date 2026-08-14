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


import { FakeClock, FakeHostTransport } from './fake-transport.js'
import { notFound } from './fake-service-helpers.js'

export class FakeToolService {
  readonly registrations = new Map<string, ExtensionToolDeclaration>()
  #next = 1

  constructor(private readonly transport: FakeHostTransport) {}

  install(): void {
    this.transport.handle('tools.register', (params) => {
      const registrationId = `tool-${this.#next++}`
      this.registrations.set(registrationId, ExtensionToolDeclarationSchema.parse(params))
      return { registrationId }
    })
    this.transport.handle('tools.unregister', (params) => {
      this.registrations.delete(String(JsonObjectSchema.parse(params).registrationId))
      return { ok: true }
    })
  }

  invoke(registrationId: string, input: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    const declaration = this.registrations.get(registrationId)
    if (!declaration) throw notFound(`Tool ${registrationId} is not registered`, 'tools.invoke')
    return this.transport.invokeExtension(
      `tools.invoke:${registrationId}`,
      {
        invocationId: `invocation-${registrationId}`,
        toolId: declaration.id,
        input
      },
      { signal }
    )
  }
}

export class FakeProviderService {
  readonly registrations = new Map<string, ModelProviderDeclaration>()
  readonly statuses = new Map<string, ProviderStatus>()
  #next = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly clock: FakeClock
  ) {}

  install(): void {
    this.transport.handle('modelProviders.register', (params) => {
      const declaration = ModelProviderDeclarationSchema.parse(params)
      const registrationId = `provider-${this.#next++}`
      this.registrations.set(registrationId, declaration)
      this.statuses.set(declaration.id, {
        providerId: declaration.id,
        status: 'available',
        checkedAt: this.clock.nowIso()
      })
      return { registrationId }
    })
    this.transport.handle('modelProviders.unregister', (params) => {
      this.registrations.delete(String(JsonObjectSchema.parse(params).registrationId))
      return { ok: true }
    })
    this.transport.handle('modelProviders.getStatus', (params) => {
      const providerId = String(JsonObjectSchema.parse(params).providerId)
      return (
        this.statuses.get(providerId) ?? {
          providerId,
          status: 'unavailable',
          checkedAt: this.clock.nowIso()
        }
      )
    })
  }

  async invoke(
    registrationId: string,
    invocation: JsonObject,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    return this.transport.invokeExtension(`modelProviders.invoke:${registrationId}`, invocation, { signal })
  }

  takeStreamEvents(registrationId: string): ModelProviderStreamEvent[] {
    const events = this.transport.sentStreams
      .map((item) => JsonObjectSchema.parse(item.payload))
      .filter((item) => item.kind === 'event')
      .filter((item) => item.registrationId === registrationId)
      .map((item) => item.event as unknown as ModelProviderStreamEvent)
    this.transport.sentStreams.splice(
      0,
      this.transport.sentStreams.length,
      ...this.transport.sentStreams.filter((item) => {
        const payload = JsonObjectSchema.parse(item.payload)
        return payload.registrationId !== registrationId
      })
    )
    return events
  }
}

export class FakeAccountService {
  readonly accounts = new Map<string, Account>()
  readonly secrets = new Map<string, string>()
  #nextSession = 1
  readonly sessions = new Map<string, JsonObject>()

  constructor(private readonly clock: FakeClock) {}

  addAccount(account: Omit<Account, 'createdAt' | 'updatedAt'>, secret?: string): Account {
    const parsed = AccountSchema.parse({
      ...account,
      createdAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso()
    })
    this.accounts.set(parsed.id, parsed)
    if (secret !== undefined) this.secrets.set(parsed.id, secret)
    return parsed
  }

  install(transport: FakeHostTransport): void {
    transport.handle('authentication.listAccounts', (params) => {
      const providerId = JsonObjectSchema.parse(params).providerId
      return [...this.accounts.values()].filter(
        (account) => providerId === undefined || account.providerId === providerId
      )
    })
    transport.handle('authentication.createSession', (params) => {
      const request = JsonObjectSchema.parse(params)
      const id = `account-session-${this.#nextSession++}`
      const session = { id, status: 'pending' as const, message: `Authorize ${String(request.providerId)}` }
      this.sessions.set(id, session)
      return session
    })
    transport.handle('authentication.getSession', (params) => {
      const id = String(JsonObjectSchema.parse(params).sessionId)
      const session = this.sessions.get(id)
      if (!session) throw notFound(`Account session ${id} was not found`, 'authentication.getSession')
      return session
    })
    transport.handle('authentication.cancelSession', (params) => {
      const id = String(JsonObjectSchema.parse(params).sessionId)
      this.sessions.set(id, { id, status: 'cancelled' })
      return { ok: true }
    })
    transport.handle('authentication.deleteAccount', (params) => {
      const id = String(JsonObjectSchema.parse(params).accountId)
      this.accounts.delete(id)
      this.secrets.delete(id)
      return { ok: true }
    })
    transport.handle('authentication.revealSecret', (params) => {
      const id = String(JsonObjectSchema.parse(params).accountId)
      const secret = this.secrets.get(id)
      if (!secret) throw notFound(`Secret for account ${id} was not found`, 'authentication.revealSecret')
      return { secret }
    })
    transport.handle('authentication.authenticatedFetch', (params) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: JsonObjectSchema.parse(params).accountId }),
      bodyEncoding: 'utf8',
      truncated: false
    }))
  }
}

export class FakeWebviewService {
  theme: Theme = ThemeSchema.parse({ kind: 'dark', tokens: {}, zoomFactor: 1, reducedMotion: false })
  locale: Locale = LocaleSchema.parse({ language: 'en', direction: 'ltr', messages: {} })
  state: JsonValue | undefined
  readonly messages: JsonValue[] = []
  readonly notifications: Array<{
    id: string
    title: string
    message: string
    severity: 'info' | 'warning' | 'error'
    actions: Array<{ id: string; title: string }>
  }> = []
  readonly composerContexts: Array<ReturnType<typeof ComposerContextAttachmentSchema.parse>> = []
  readonly #notificationResponses: Array<{ value?: string }> = []

  constructor(
    private readonly identity: ExtensionIdentity,
    private readonly workspaceId: string
  ) {}

  install(transport: FakeHostTransport): void {
    transport.handle('ui.getTheme', () => this.theme)
    transport.handle('ui.getLocale', () => this.locale)
    transport.handle('ui.getViewState', () =>
      this.state === undefined ? { found: false } : { found: true, value: this.state }
    )
    transport.handle('ui.setViewState', (params) => {
      this.state = JsonObjectSchema.parse(params).value
      return { ok: true }
    })
    transport.handle('ui.postMessage', (params) => {
      this.messages.push(HostMessageSchema.parse(params))
      return { ok: true }
    })
    transport.handle('ui.showNotification', (params) => {
      this.notifications.push(NotificationOptionsSchema.parse(params))
      return this.#notificationResponses.shift() ?? {}
    })
    transport.handle('ui.attachComposerContext', (params) => {
      const request = ComposerContextAttachmentRequestSchema.parse(params)
      const attachment = ComposerContextAttachmentSchema.parse({
        ...request,
        attachmentId: `extension-context:${createHash('sha256')
          .update(`${this.identity.id}\0${this.workspaceId}\0${request.id}`)
          .digest('hex')}`,
        provenance: {
          extensionId: this.identity.id,
          extensionVersion: this.identity.version,
          viewContributionId: `extension:${this.identity.id}/test-view`,
          workspaceId: this.workspaceId
        }
      })
      this.composerContexts.push(attachment)
      return attachment
    })
  }

  setTheme(transport: FakeHostTransport, theme: Theme): void {
    this.theme = ThemeSchema.parse(theme)
    transport.emit('ui.themeChanged', this.theme)
  }

  setLocale(transport: FakeHostTransport, locale: Locale): void {
    this.locale = LocaleSchema.parse(locale)
    transport.emit('ui.localeChanged', this.locale)
  }

  sendMessage(transport: FakeHostTransport, channel: string, payload: JsonValue): void {
    transport.emit('ui.message', { channel, payload })
  }

  respondToNextNotification(actionId?: string): void {
    this.#notificationResponses.push(actionId === undefined ? {} : { value: actionId })
  }
}
