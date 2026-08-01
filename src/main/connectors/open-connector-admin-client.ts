import { z } from 'zod'
import {
  OpenConnectorActionDetailSchema,
  OpenConnectorCatalogSchema,
  OpenConnectorConnectionSchema,
  OpenConnectorDeviceRegistrationResultSchema,
  OpenConnectorDeviceRegistrationStartResultSchema,
  OpenConnectorOAuthConfigSchema,
  OpenConnectorOAuthPollResultSchema,
  OpenConnectorPolicySchema,
  OpenConnectorProviderSchema,
  OpenConnectorRunPageSchema,
  OpenConnectorRunSchema,
  OpenConnectorSetupHelpResultSchema,
  type OpenConnectorActionDetail,
  type OpenConnectorCatalog,
  type OpenConnectorConnectInput,
  type OpenConnectorConnection,
  type OpenConnectorDisconnectInput,
  type OpenConnectorDeviceRegistrationPollInput,
  type OpenConnectorDeviceRegistrationResult,
  type OpenConnectorDeviceRegistrationStartInput,
  type OpenConnectorDeviceRegistrationStartResult,
  type OpenConnectorOAuthConfig,
  type OpenConnectorOAuthConfigInput,
  type OpenConnectorOAuthCancelInput,
  type OpenConnectorOAuthPollInput,
  type OpenConnectorOAuthPollResult,
  type OpenConnectorOAuthStartInput,
  type OpenConnectorOAuthStartResult,
  type OpenConnectorPolicy,
  type OpenConnectorPolicyUpdateInput,
  type OpenConnectorProvider,
  type OpenConnectorRun,
  type OpenConnectorRunPage,
  type OpenConnectorRunQuery,
  type OpenConnectorSetupHelpResult
} from '../../shared/open-connector'
import type { OpenConnectorSidecar } from './open-connector-sidecar'

const RawCredentialFieldSchema = z.object({
  key: z.string(),
  i18nKey: z.string().optional(),
  label: z.string(),
  inputType: z.enum(['text', 'password', 'textarea', 'json']),
  required: z.boolean(),
  secret: z.boolean(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  location: z.enum(['extra', 'secretExtra']).optional(),
  defaultValue: z.string().optional()
}).passthrough()

const RawAuthSchema = z.object({
  type: z.enum(['no_auth', 'api_key', 'custom_credential', 'oauth2']),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  extraFields: z.array(RawCredentialFieldSchema).optional(),
  fields: z.array(RawCredentialFieldSchema).optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'none']).optional(),
  clientConfigFields: z.array(RawCredentialFieldSchema).optional()
}).passthrough()

const RawActionSchema = z.object({
  id: z.string(),
  service: z.string(),
  name: z.string(),
  description: z.string(),
  i18nKey: z.string().optional(),
  sideEffect: z.enum(['read', 'write', 'send', 'delete', 'unknown']).optional(),
  requiredScopes: z.array(z.string()).default([]),
  providerPermissions: z.array(z.string()).default([]),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  execution: z.object({ locallyExecutable: z.boolean() }).passthrough()
}).passthrough()

const RawProviderSchema = z.object({
  service: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  i18nKey: z.string().optional(),
  categories: z.array(z.string()).default([]),
  authTypes: z.array(z.enum(['no_auth', 'api_key', 'custom_credential', 'oauth2'])),
  auth: z.array(RawAuthSchema),
  homepageUrl: z.string().optional(),
  iconUrl: z.string().optional(),
  actions: z.array(RawActionSchema),
  execution: z.object({
    actionCount: z.number().int().nonnegative(),
    locallyExecutableActionCount: z.number().int().nonnegative(),
    catalogOnlyActionCount: z.number().int().nonnegative()
  }).passthrough()
}).passthrough()

const RawConnectionSchema = z.object({
  id: z.string(),
  service: z.string(),
  connectionName: z.string(),
  authType: z.enum(['no_auth', 'api_key', 'custom_credential', 'oauth2']),
  configured: z.boolean(),
  virtual: z.boolean(),
  default: z.boolean(),
  profile: z.object({
    accountId: z.string(),
    displayName: z.string(),
    grantedScopes: z.array(z.string())
  }).passthrough()
}).passthrough()

const RawOAuthConfigSchema = z.object({
  service: z.string(),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  expectedRedirectUri: z.string(),
  auth: RawAuthSchema
}).passthrough()

const RawPolicyRulesSchema = z.object({
  allowedActions: z.array(z.string()),
  blockedActions: z.array(z.string()),
  allowedProxies: z.array(z.string()),
  blockedProxies: z.array(z.string())
}).passthrough()

const RawPolicySchema = z.object({
  deployment: RawPolicyRulesSchema,
  runtime: RawPolicyRulesSchema,
  updatedAt: z.string().optional()
}).passthrough()

const RawRunSchema = z.object({
  id: z.string(),
  service: z.string(),
  actionId: z.string(),
  caller: z.enum(['http', 'mcp', 'web']),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  connectionId: z.string().optional(),
  connectionProfile: z.object({ displayName: z.string() }).passthrough().optional(),
  policy: z.unknown().optional(),
  inputSummary: z.unknown().optional(),
  outputSummary: z.unknown().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional()
}).passthrough()

const RawRunPageSchema = z.object({
  items: z.array(RawRunSchema),
  nextCursor: z.string().optional()
}).passthrough()

const RawOAuthStartSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string().min(1),
  expiresAt: z.string().datetime()
}).passthrough()

const RawOAuthAuthorizationStatusSchema = z.object({
  service: z.string().min(1),
  connectionName: z.string().min(1).optional(),
  state: z.string().min(1),
  status: z.enum(['pending', 'connected', 'failed', 'expired', 'cancelled', 'denied']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional()
}).passthrough()

const RawDeviceRegistrationSchema = z.object({
  flowId: z.string().uuid(),
  service: z.string().min(1),
  connectionName: z.string().min(1),
  status: z.enum(['pending', 'authorized', 'connected', 'denied', 'expired', 'cancelled', 'failed']),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url(),
  userCode: z.string().min(1).optional(),
  expiresAt: z.string().datetime(),
  intervalMs: z.number().int().positive(),
  connection: RawConnectionSchema.optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional()
}).passthrough()

type OAuthSession = {
  service: string
  connectionName: string
  state: string
  expiresAt: number
}

const RECOMMENDED_PRODUCTS = [
  product('feishu', 'Feishu', 'Messages, documents, drive, calendars, tasks, and Base workflows.', ['feishu'], 'collaboration', 'device_registration_oauth'),
  product('dingtalk', 'DingTalk', 'Local robot messaging, documents, todos, AI Tables, and calendar workflows.', ['dingtalk'], 'collaboration', 'device_registration_app'),
  product('wecom', 'WeCom', 'Smart bot and group webhook workflows for enterprise collaboration.', ['wecom_bot'], 'collaboration', 'guided_credentials'),
  product('qq-mail', 'QQ Mail', 'Local QQ Mail access through an IMAP/SMTP authorization code.', ['qq_mail'], 'email', 'guided_credentials'),
  product('netease-mail', 'NetEase Mail', 'Local NetEase Mail access through an IMAP/SMTP authorization code.', ['netease_mail'], 'email', 'guided_credentials')
] as const

const OFFICIAL_SETUP_HELP_URLS: Record<string, string> = {
  wecom_bot: 'https://work.weixin.qq.com/wework_admin/frame#apps',
  qq_mail: 'https://help.mail.qq.com/detail/0/1087',
  netease_mail: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b'
}

export class OpenConnectorAdminClient {
  private catalogCache: OpenConnectorCatalog | null = null
  private readonly oauthSessions = new Map<string, OAuthSession>()

  constructor(
    private readonly sidecar: OpenConnectorSidecar,
    private readonly options: {
      port: () => number
      openExternal: (url: string) => Promise<void>
      fetchImpl?: typeof fetch
    }
  ) {}

  async catalog(): Promise<OpenConnectorCatalog> {
    if (this.catalogCache) return this.catalogCache
    const raw = z.array(RawProviderSchema).parse(await this.request('/api/providers'))
    const providers = raw.map(normalizeProvider)
    const availableServices = new Set(providers.filter((provider) => provider.available).map((provider) => provider.service))
    const products = RECOMMENDED_PRODUCTS.map((entry) => ({
      ...entry,
      available: entry.services.every((service) => availableServices.has(service))
    }))
    const catalog = OpenConnectorCatalogSchema.parse({
      products,
      providers,
      categories: [...new Set(products.map((product) => product.category))].sort(),
      generatedAt: new Date().toISOString()
    })
    this.catalogCache = catalog
    return catalog
  }

  async provider(service: string): Promise<OpenConnectorProvider> {
    return normalizeProvider(RawProviderSchema.parse(await this.request(`/api/providers/${encodeURIComponent(service)}`)))
  }

  async action(actionId: string): Promise<OpenConnectorActionDetail> {
    const action = RawActionSchema.parse(await this.request(`/api/actions/${encodeURIComponent(actionId)}`))
    return OpenConnectorActionDetailSchema.parse({
      ...normalizeAction(action),
      inputSchema: action.inputSchema ?? {},
      outputSchema: action.outputSchema ?? {}
    })
  }

  async connections(): Promise<OpenConnectorConnection[]> {
    const connections = z.array(RawConnectionSchema).parse(await this.request('/api/connections'))
    return connections.map(normalizeConnection)
  }

  async connect(input: OpenConnectorConnectInput): Promise<OpenConnectorConnection> {
    const result = RawConnectionSchema.parse(await this.request(
      `/api/connections/${encodeURIComponent(input.service)}`,
      {
        method: 'PUT',
        body: {
          authType: input.authType,
          connectionName: input.connectionName,
          values: input.values
        }
      }
    ))
    this.catalogCache = null
    return normalizeConnection(result)
  }

  async disconnect(input: OpenConnectorDisconnectInput): Promise<{ disconnected: true }> {
    await this.request(`/api/connections/${encodeURIComponent(input.service)}`, {
      method: 'DELETE',
      body: { connectionName: input.connectionName }
    })
    return { disconnected: true }
  }

  async setDefault(input: OpenConnectorDisconnectInput): Promise<OpenConnectorConnection> {
    const result = RawConnectionSchema.parse(await this.request(
      `/api/connections/${encodeURIComponent(input.service)}/default`,
      {
        method: 'POST',
        body: { connectionName: input.connectionName }
      }
    ))
    return normalizeConnection(result)
  }

  async oauthConfigs(): Promise<OpenConnectorOAuthConfig[]> {
    const configs = z.array(RawOAuthConfigSchema).parse(await this.request('/api/oauth/configs'))
    return configs.map(normalizeOAuthConfig)
  }

  async saveOAuthConfig(input: OpenConnectorOAuthConfigInput): Promise<OpenConnectorOAuthConfig> {
    const config = RawOAuthConfigSchema.parse(await this.request(
      `/api/oauth/configs/${encodeURIComponent(input.service)}`,
      {
        method: 'PUT',
        body: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          extra: input.extra,
          secretExtra: input.secretExtra
        }
      }
    ))
    return normalizeOAuthConfig(config)
  }

  async deleteOAuthConfig(service: string): Promise<{ deleted: true }> {
    await this.request(`/api/oauth/configs/${encodeURIComponent(service)}`, { method: 'DELETE' })
    return { deleted: true }
  }

  async startOAuth(input: OpenConnectorOAuthStartInput): Promise<OpenConnectorOAuthStartResult> {
    const result = RawOAuthStartSchema.parse(await this.request('/api/oauth/authorizations', {
      method: 'POST',
      body: input
    }))
    const authorizationUrl = new URL(result.authorizationUrl)
    if (authorizationUrl.protocol !== 'https:') {
      throw new OpenConnectorAdminError(502, 'unsafe_authorization_url', 'Provider authorization URL must use HTTPS.')
    }
    const expiresAt = Date.parse(result.expiresAt)
    this.oauthSessions.set(result.state, { ...input, state: result.state, expiresAt })
    try {
      await this.options.openExternal(result.authorizationUrl)
    } catch (error) {
      this.oauthSessions.delete(result.state)
      throw error
    }
    return {
      ...input,
      state: result.state,
      authorizationHost: authorizationUrl.host,
      expiresAt: new Date(expiresAt).toISOString()
    }
  }

  async pollOAuth(input: OpenConnectorOAuthPollInput): Promise<OpenConnectorOAuthPollResult> {
    const session = this.oauthSessions.get(input.state)
    if (!session || session.service !== input.service || session.connectionName !== input.connectionName) {
      return { status: 'expired' }
    }
    if (session.expiresAt <= Date.now()) {
      this.oauthSessions.delete(input.state)
      return { status: 'expired' }
    }
    let authorization: z.infer<typeof RawOAuthAuthorizationStatusSchema>
    try {
      authorization = RawOAuthAuthorizationStatusSchema.parse(
        await this.request(`/api/oauth/authorizations/${encodeURIComponent(input.state)}`)
      )
    } catch (error) {
      if (error instanceof OpenConnectorAdminError &&
          error.status === 404 &&
          error.code === 'oauth_authorization_not_found') {
        this.oauthSessions.delete(input.state)
        return { status: 'expired' }
      }
      throw error
    }
    if (!matchesOAuthAuthorization(authorization, input)) {
      this.oauthSessions.delete(input.state)
      return {
        status: 'failed',
        errorCode: 'oauth_state_mismatch',
        errorMessage: 'OpenConnector returned OAuth progress for a different authorization.'
      }
    }
    if (authorization.status === 'pending') return { status: 'pending' }

    this.oauthSessions.delete(input.state)
    if (authorization.status !== 'connected') {
      return OpenConnectorOAuthPollResultSchema.parse({
        status: authorization.status,
        ...(authorization.errorCode ? { errorCode: redactString(authorization.errorCode) } : {}),
        ...(authorization.errorMessage ? { errorMessage: redactString(authorization.errorMessage) } : {})
      })
    }

    const connection = (await this.connections()).find((item) =>
      item.service === input.service &&
      item.connectionName === input.connectionName &&
      item.configured
    )
    return connection
      ? { status: 'connected', connection }
      : {
          status: 'failed',
          errorCode: 'oauth_connection_missing',
          errorMessage: 'OAuth completed, but the named connection is unavailable.'
        }
  }

  async cancelOAuth(input: OpenConnectorOAuthCancelInput): Promise<OpenConnectorOAuthPollResult> {
    const session = this.oauthSessions.get(input.state)
    if (!session || session.service !== input.service || session.connectionName !== input.connectionName) {
      return { status: 'expired' }
    }
    if (session.expiresAt <= Date.now()) {
      this.oauthSessions.delete(input.state)
      return { status: 'expired' }
    }
    const authorization = RawOAuthAuthorizationStatusSchema.parse(
      await this.request(`/api/oauth/authorizations/${encodeURIComponent(input.state)}`, { method: 'DELETE' })
    )
    if (!matchesOAuthAuthorization(authorization, input)) {
      this.oauthSessions.delete(input.state)
      return {
        status: 'failed',
        errorCode: 'oauth_state_mismatch',
        errorMessage: 'OpenConnector returned OAuth progress for a different authorization.'
      }
    }
    this.oauthSessions.delete(input.state)
    return OpenConnectorOAuthPollResultSchema.parse({
      status: authorization.status,
      ...(authorization.errorCode ? { errorCode: redactString(authorization.errorCode) } : {}),
      ...(authorization.errorMessage ? { errorMessage: redactString(authorization.errorMessage) } : {})
    })
  }

  async startDeviceRegistration(
    input: OpenConnectorDeviceRegistrationStartInput
  ): Promise<OpenConnectorDeviceRegistrationStartResult> {
    const raw = RawDeviceRegistrationSchema.parse(await this.request('/api/device-registrations', {
      method: 'POST',
      body: input
    }))
    if (raw.status !== 'pending') {
      throw new OpenConnectorAdminError(502, 'invalid_contract', 'Device registration did not start as pending.')
    }
    assertOfficialDeviceVerificationUrl(raw.service, raw.verificationUri)
    assertOfficialDeviceVerificationUrl(raw.service, raw.verificationUriComplete)
    const result = OpenConnectorDeviceRegistrationStartResultSchema.parse({
      ...raw,
      status: 'pending'
    })
    await this.options.openExternal(result.verificationUriComplete)
    return result
  }

  async pollDeviceRegistration(
    input: OpenConnectorDeviceRegistrationPollInput
  ): Promise<OpenConnectorDeviceRegistrationResult> {
    const raw = RawDeviceRegistrationSchema.parse(await this.request(
      `/api/device-registrations/${encodeURIComponent(input.flowId)}`
    ))
    return normalizeDeviceRegistration(raw)
  }

  async cancelDeviceRegistration(
    input: OpenConnectorDeviceRegistrationPollInput
  ): Promise<OpenConnectorDeviceRegistrationResult> {
    const raw = RawDeviceRegistrationSchema.parse(await this.request(
      `/api/device-registrations/${encodeURIComponent(input.flowId)}`,
      { method: 'DELETE' }
    ))
    return normalizeDeviceRegistration(raw)
  }

  async openSetupHelp(service: string): Promise<OpenConnectorSetupHelpResult> {
    const value = OFFICIAL_SETUP_HELP_URLS[service]
    if (!value) {
      throw new OpenConnectorAdminError(404, 'setup_help_not_found', 'No official setup page is configured for this provider.')
    }
    const url = new URL(value)
    await this.options.openExternal(url.toString())
    return OpenConnectorSetupHelpResultSchema.parse({ opened: true, host: url.host })
  }

  async policy(): Promise<OpenConnectorPolicy> {
    return normalizePolicy(RawPolicySchema.parse(await this.request('/api/runtime-policy')))
  }

  async updatePolicy(input: OpenConnectorPolicyUpdateInput): Promise<OpenConnectorPolicy> {
    return normalizePolicy(RawPolicySchema.parse(await this.request('/api/runtime-policy', {
      method: 'PUT',
      body: input.rules
    })))
  }

  async runs(query: OpenConnectorRunQuery): Promise<OpenConnectorRunPage> {
    const search = new URLSearchParams()
    search.set('limit', String(query.limit))
    if (query.cursor) search.set('cursor', query.cursor)
    if (query.service) search.set('service', query.service)
    if (query.actionId) search.set('actionId', query.actionId)
    if (query.caller) search.set('caller', query.caller)
    if (query.ok !== undefined) search.set('ok', String(query.ok))
    return normalizeRunPage(RawRunPageSchema.parse(await this.request(`/api/runs?${search}`)))
  }

  async run(id: string): Promise<OpenConnectorRun> {
    return normalizeRun(RawRunSchema.parse(await this.request(`/api/runs/${encodeURIComponent(id)}`)))
  }

  private async request(
    path: string,
    init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
  ): Promise<unknown> {
    const health = await this.sidecar.start(this.options.port())
    if (health.state !== 'running' || !this.sidecar.adminToken) {
      throw new OpenConnectorAdminError(503, health.state, health.message ?? 'OpenConnector is unavailable.')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.sidecar.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.sidecar.adminToken}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal
      })
      const body = await readBoundedJson(response)
      if (!response.ok) throw adminResponseError(response.status, body)
      return body
    } catch (error) {
      if (error instanceof OpenConnectorAdminError) throw error
      if (controller.signal.aborted) {
        throw new OpenConnectorAdminError(504, 'timeout', 'OpenConnector request timed out.')
      }
      throw new OpenConnectorAdminError(503, 'unavailable', 'OpenConnector request failed.')
    } finally {
      clearTimeout(timer)
    }
  }
}

function matchesOAuthAuthorization(
  authorization: z.infer<typeof RawOAuthAuthorizationStatusSchema>,
  input: Pick<OpenConnectorOAuthPollInput, 'service' | 'connectionName' | 'state'>
): boolean {
  return authorization.state === input.state &&
    authorization.service === input.service &&
    (authorization.connectionName ?? 'default') === input.connectionName
}

export class OpenConnectorAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${redactString(message)}`)
    this.name = 'OpenConnectorAdminError'
  }
}

function normalizeProvider(raw: z.infer<typeof RawProviderSchema>): OpenConnectorProvider {
  const actions = raw.actions.map(normalizeAction)
  return OpenConnectorProviderSchema.parse({
    service: raw.service,
    displayName: raw.displayName,
    description: raw.description ?? '',
    i18nKey: raw.i18nKey ?? `connectors.providers.${raw.service}`,
    categories: raw.categories,
    authTypes: raw.authTypes,
    auth: raw.auth.map(normalizeAuth),
    homepageUrl: safeHttpsUrl(raw.homepageUrl),
    iconUrl: safeHttpsUrl(raw.iconUrl),
    actions,
    actionCount: raw.execution.actionCount,
    locallyExecutableActionCount: raw.execution.locallyExecutableActionCount,
    available: raw.execution.locallyExecutableActionCount > 0
  })
}

function normalizeAction(raw: z.infer<typeof RawActionSchema>) {
  return {
    id: raw.id,
    service: raw.service,
    name: raw.name,
    description: raw.description,
    i18nKey: raw.i18nKey ?? `connectors.actions.${raw.service}.${raw.name}`,
    sideEffect: raw.sideEffect ?? 'unknown',
    requiredScopes: raw.requiredScopes,
    providerPermissions: raw.providerPermissions,
    locallyExecutable: raw.execution.locallyExecutable
  }
}

function normalizeAuth(raw: z.infer<typeof RawAuthSchema>) {
  if (raw.type === 'no_auth') return { type: 'no_auth' as const }
  if (raw.type === 'api_key') {
    return {
      type: 'api_key' as const,
      ...(raw.label ? { label: raw.label } : {}),
      ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
      ...(raw.description ? { description: raw.description } : {}),
      fields: [
        {
          key: 'apiKey',
          i18nKey: `connectors.fields.api_key.apiKey`,
          label: raw.label ?? 'API key',
          inputType: 'password' as const,
          required: true,
          secret: true,
          ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
          ...(raw.description ? { description: raw.description } : {})
        },
        ...(raw.extraFields ?? []).map(normalizeCredentialField)
      ]
    }
  }
  if (raw.type === 'custom_credential') {
    return {
      type: 'custom_credential' as const,
      fields: (raw.fields ?? []).map(normalizeCredentialField)
    }
  }
  if (!raw.authorizationUrl || !raw.tokenUrl || !raw.tokenEndpointAuthMethod) {
    throw new OpenConnectorAdminError(502, 'invalid_contract', 'OpenConnector returned an invalid OAuth provider definition.')
  }
  return {
    type: 'oauth2' as const,
    authorizationUrl: raw.authorizationUrl,
    tokenUrl: raw.tokenUrl,
    scopes: raw.scopes ?? [],
    tokenEndpointAuthMethod: raw.tokenEndpointAuthMethod,
    clientConfigFields: (raw.clientConfigFields ?? []).map(normalizeCredentialField)
  }
}

function normalizeCredentialField(raw: z.infer<typeof RawCredentialFieldSchema>) {
  return {
    key: raw.key,
    i18nKey: raw.i18nKey ?? `connectors.fields.${raw.key}`,
    label: raw.label,
    inputType: raw.inputType,
    required: raw.required,
    secret: raw.secret,
    ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.location ? { location: raw.location } : {}),
    ...(raw.defaultValue ? { defaultValue: raw.defaultValue } : {})
  }
}

function normalizeConnection(raw: z.infer<typeof RawConnectionSchema>): OpenConnectorConnection {
  return OpenConnectorConnectionSchema.parse({
    id: raw.id,
    service: raw.service,
    connectionName: raw.connectionName,
    authType: raw.authType,
    configured: raw.configured,
    virtual: raw.virtual,
    isDefault: raw.default,
    accountId: raw.profile.accountId || null,
    accountLabel: raw.profile.displayName,
    displayName: raw.profile.displayName
  })
}

function normalizeOAuthConfig(raw: z.infer<typeof RawOAuthConfigSchema>): OpenConnectorOAuthConfig {
  if (raw.auth.type !== 'oauth2' || !raw.auth.tokenEndpointAuthMethod) {
    throw new OpenConnectorAdminError(502, 'invalid_contract', 'OpenConnector returned an invalid OAuth configuration.')
  }
  return OpenConnectorOAuthConfigSchema.parse({
    service: raw.service,
    configured: raw.configured,
    clientId: raw.clientId,
    expectedRedirectUri: raw.expectedRedirectUri,
    scopes: raw.auth.scopes ?? [],
    tokenEndpointAuthMethod: raw.auth.tokenEndpointAuthMethod,
    clientConfigFields: (raw.auth.clientConfigFields ?? []).map(normalizeCredentialField)
  })
}

function normalizeDeviceRegistration(
  raw: z.infer<typeof RawDeviceRegistrationSchema>
): OpenConnectorDeviceRegistrationResult {
  assertOfficialDeviceVerificationUrl(raw.service, raw.verificationUri)
  assertOfficialDeviceVerificationUrl(raw.service, raw.verificationUriComplete)
  return OpenConnectorDeviceRegistrationResultSchema.parse({
    flowId: raw.flowId,
    service: raw.service,
    connectionName: raw.connectionName,
    status: raw.status,
    verificationUri: raw.verificationUri,
    verificationUriComplete: raw.verificationUriComplete,
    ...(raw.userCode ? { userCode: raw.userCode } : {}),
    expiresAt: raw.expiresAt,
    intervalMs: raw.intervalMs,
    ...(raw.connection ? { connection: normalizeConnection(raw.connection) } : {}),
    ...(raw.errorCode ? { errorCode: redactString(raw.errorCode) } : {}),
    ...(raw.errorMessage ? { errorMessage: redactString(raw.errorMessage) } : {})
  })
}

function normalizePolicy(raw: z.infer<typeof RawPolicySchema>): OpenConnectorPolicy {
  return OpenConnectorPolicySchema.parse({
    deployment: raw.deployment,
    runtime: raw.runtime,
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {})
  })
}

function normalizeRunPage(raw: z.infer<typeof RawRunPageSchema>): OpenConnectorRunPage {
  return OpenConnectorRunPageSchema.parse({
    items: raw.items.map(normalizeRun),
    ...(raw.nextCursor ? { nextCursor: raw.nextCursor } : {})
  })
}

function normalizeRun(raw: z.infer<typeof RawRunSchema>): OpenConnectorRun {
  return OpenConnectorRunSchema.parse({
    id: raw.id,
    service: raw.service,
    actionId: raw.actionId,
    caller: raw.caller,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    durationMs: Math.max(0, raw.durationMs),
    ok: raw.ok,
    ...(raw.connectionId ? { connectionId: raw.connectionId } : {}),
    ...(raw.connectionProfile?.displayName
      ? { connectionLabel: redactString(raw.connectionProfile.displayName) }
      : {}),
    ...(raw.policy !== undefined ? { policy: redactUnknown(raw.policy) } : {}),
    ...(raw.inputSummary !== undefined ? { inputSummary: redactUnknown(raw.inputSummary) } : {}),
    ...(raw.outputSummary !== undefined ? { outputSummary: redactUnknown(raw.outputSummary) } : {}),
    ...(raw.errorCode ? { errorCode: redactString(raw.errorCode) } : {}),
    ...(raw.errorMessage ? { errorMessage: redactString(raw.errorMessage) } : {})
  })
}

function product(
  id: string,
  displayName: string,
  description: string,
  services: readonly string[],
  category: string,
  setupKind: 'device_registration_oauth' | 'device_registration_app' | 'guided_credentials'
) {
  return {
    id,
    displayName,
    description,
    i18nKey: `connectors.products.${id}`,
    region: 'cn' as const,
    logoAssetKey: id,
    setupKind,
    services: [...services],
    category,
    recommended: true,
    available: false,
    adminConsentRequired: false
  }
}

function assertOfficialDeviceVerificationUrl(service: string, value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OpenConnectorAdminError(502, 'unsafe_verification_url', 'Provider returned an invalid verification URL.')
  }
  const host = url.hostname.toLowerCase()
  const allowed = url.protocol === 'https:' && (
    (service === 'feishu' && (
      host === 'accounts.feishu.cn' || host.endsWith('.feishu.cn') ||
      host === 'accounts.larksuite.com' || host.endsWith('.larksuite.com')
    )) ||
    (service === 'dingtalk' && (host === 'dingtalk.com' || host.endsWith('.dingtalk.com')))
  )
  if (!allowed) {
    throw new OpenConnectorAdminError(502, 'unsafe_verification_url', 'Provider returned a non-official verification URL.')
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024 * 1024) {
    throw new OpenConnectorAdminError(502, 'response_too_large', 'OpenConnector response exceeded 64 MiB.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024 * 1024) {
    throw new OpenConnectorAdminError(502, 'response_too_large', 'OpenConnector response exceeded 64 MiB.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new OpenConnectorAdminError(502, 'invalid_json', 'OpenConnector returned invalid JSON.')
  }
}

function adminResponseError(status: number, body: unknown): OpenConnectorAdminError {
  const parsed = z.object({
    error: z.object({ code: z.string(), message: z.string() }).passthrough()
  }).passthrough().safeParse(body)
  return parsed.success
    ? new OpenConnectorAdminError(status, parsed.data.error.code, parsed.data.error.message)
    : new OpenConnectorAdminError(status, 'request_failed', `OpenConnector request failed with HTTP ${status}.`)
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactUnknown(item, depth + 1))
  if (typeof value !== 'object' || value === null) return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = /(?:token|secret|password|authorization|api[_-]?key|cookie|(?:download|callback)[_-]?url)/i.test(key)
      ? '[REDACTED]'
      : redactUnknown(item, depth + 1)
  }
  return output
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/kun_oc_(?:admin|runtime)_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|api[_-]?key|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]'
    )
    .slice(0, 16_384)
}
