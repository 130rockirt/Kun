import { z } from 'zod'

export const DEFAULT_OPEN_CONNECTOR_PORT = 18_898
export const OPEN_CONNECTOR_PROTOCOL_VERSION = '1'

export const OpenConnectorSideEffectSchema = z.enum([
  'read',
  'write',
  'send',
  'delete',
  'unknown'
])
export type OpenConnectorSideEffect = z.infer<typeof OpenConnectorSideEffectSchema>

export const OpenConnectorCredentialFieldSchema = z.object({
  key: z.string().min(1),
  i18nKey: z.string().min(1),
  label: z.string().min(1),
  inputType: z.enum(['text', 'password', 'textarea', 'json']),
  required: z.boolean(),
  secret: z.boolean(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  location: z.enum(['extra', 'secretExtra']).optional(),
  defaultValue: z.string().optional()
}).strict()
export type OpenConnectorCredentialField = z.infer<typeof OpenConnectorCredentialFieldSchema>

const NoAuthSchema = z.object({ type: z.literal('no_auth') }).strict()
const ApiKeyAuthSchema = z.object({
  type: z.literal('api_key'),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(OpenConnectorCredentialFieldSchema)
}).strict()
const CustomCredentialAuthSchema = z.object({
  type: z.literal('custom_credential'),
  fields: z.array(OpenConnectorCredentialFieldSchema)
}).strict()
const OAuthAuthSchema = z.object({
  type: z.literal('oauth2'),
  authorizationUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  scopes: z.array(z.string()),
  tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'none']),
  clientConfigFields: z.array(OpenConnectorCredentialFieldSchema)
}).strict()

export const OpenConnectorAuthSchema = z.discriminatedUnion('type', [
  NoAuthSchema,
  ApiKeyAuthSchema,
  CustomCredentialAuthSchema,
  OAuthAuthSchema
])
export type OpenConnectorAuth = z.infer<typeof OpenConnectorAuthSchema>

export const OpenConnectorActionSummarySchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  i18nKey: z.string().min(1),
  sideEffect: OpenConnectorSideEffectSchema,
  requiredScopes: z.array(z.string()),
  providerPermissions: z.array(z.string()),
  locallyExecutable: z.boolean()
}).strict()
export type OpenConnectorActionSummary = z.infer<typeof OpenConnectorActionSummarySchema>

export const OpenConnectorActionDetailSchema = OpenConnectorActionSummarySchema.extend({
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown())
}).strict()
export type OpenConnectorActionDetail = z.infer<typeof OpenConnectorActionDetailSchema>

export const OpenConnectorProviderSchema = z.object({
  service: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  i18nKey: z.string().min(1),
  categories: z.array(z.string()),
  authTypes: z.array(z.enum(['no_auth', 'api_key', 'custom_credential', 'oauth2'])),
  auth: z.array(OpenConnectorAuthSchema),
  homepageUrl: z.string().url().nullable(),
  iconUrl: z.string().url().nullable(),
  actions: z.array(OpenConnectorActionSummarySchema),
  actionCount: z.number().int().nonnegative(),
  locallyExecutableActionCount: z.number().int().nonnegative(),
  available: z.boolean()
}).strict()
export type OpenConnectorProvider = z.infer<typeof OpenConnectorProviderSchema>

export const OpenConnectorProductSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  i18nKey: z.string().min(1),
  region: z.enum(['cn', 'global']),
  logoAssetKey: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  setupKind: z.enum([
    'device_registration_oauth',
    'device_registration_app',
    'guided_credentials'
  ]),
  services: z.array(z.string().min(1)).min(1),
  category: z.string().min(1),
  recommended: z.boolean(),
  available: z.boolean(),
  adminConsentRequired: z.boolean(),
  accountRequirement: z.string().optional()
}).strict()
export type OpenConnectorProduct = z.infer<typeof OpenConnectorProductSchema>

export const OpenConnectorCatalogSchema = z.object({
  products: z.array(OpenConnectorProductSchema),
  providers: z.array(OpenConnectorProviderSchema),
  categories: z.array(z.string()),
  generatedAt: z.string().datetime()
}).strict()
export type OpenConnectorCatalog = z.infer<typeof OpenConnectorCatalogSchema>

export const OpenConnectorConnectionSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  connectionName: z.string().min(1),
  authType: z.enum(['no_auth', 'api_key', 'custom_credential', 'oauth2']),
  configured: z.boolean(),
  virtual: z.boolean(),
  isDefault: z.boolean(),
  accountId: z.string().nullable(),
  accountLabel: z.string(),
  displayName: z.string()
}).strict()
export type OpenConnectorConnection = z.infer<typeof OpenConnectorConnectionSchema>

export const OpenConnectorOAuthConfigSchema = z.object({
  service: z.string().min(1),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  expectedRedirectUri: z.string().url(),
  scopes: z.array(z.string()),
  tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'none']),
  clientConfigFields: z.array(OpenConnectorCredentialFieldSchema)
}).strict()
export type OpenConnectorOAuthConfig = z.infer<typeof OpenConnectorOAuthConfigSchema>

export const OpenConnectorPolicyRulesSchema = z.object({
  allowedActions: z.array(z.string()),
  blockedActions: z.array(z.string()),
  allowedProxies: z.array(z.string()),
  blockedProxies: z.array(z.string())
}).strict()
export type OpenConnectorPolicyRules = z.infer<typeof OpenConnectorPolicyRulesSchema>

export const OpenConnectorPolicySchema = z.object({
  deployment: OpenConnectorPolicyRulesSchema,
  runtime: OpenConnectorPolicyRulesSchema,
  updatedAt: z.string().datetime().optional()
}).strict()
export type OpenConnectorPolicy = z.infer<typeof OpenConnectorPolicySchema>

export const OpenConnectorRunSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  actionId: z.string().min(1),
  caller: z.enum(['http', 'mcp', 'web']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  ok: z.boolean(),
  connectionId: z.string().optional(),
  connectionLabel: z.string().optional(),
  policy: z.unknown().optional(),
  inputSummary: z.unknown().optional(),
  outputSummary: z.unknown().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional()
}).strict()
export type OpenConnectorRun = z.infer<typeof OpenConnectorRunSchema>

export const OpenConnectorRunPageSchema = z.object({
  items: z.array(OpenConnectorRunSchema),
  nextCursor: z.string().optional()
}).strict()
export type OpenConnectorRunPage = z.infer<typeof OpenConnectorRunPageSchema>

export const OpenConnectorHealthSchema = z.object({
  state: z.enum([
    'stopped',
    'starting',
    'running',
    'unavailable',
    'incompatible',
    'port_conflict',
    'failed'
  ]),
  enabled: z.boolean(),
  managed: z.boolean(),
  baseUrl: z.string().url(),
  port: z.number().int().min(10_000).max(65_535),
  version: z.string().optional(),
  protocolVersion: z.string().optional(),
  pid: z.number().int().positive().optional(),
  message: z.string().optional(),
  checkedAt: z.string().datetime()
}).strict()
export type OpenConnectorHealth = z.infer<typeof OpenConnectorHealthSchema>

const ServiceSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)
const ConnectionNameSchema = z.string().trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, {
    message: 'Account name must start with a letter or digit and use at most 64 letters, digits, underscores, or hyphens.'
  })

export const OpenConnectorConnectInputSchema = z.object({
  service: ServiceSchema,
  authType: z.enum(['no_auth', 'api_key', 'custom_credential']),
  connectionName: ConnectionNameSchema,
  values: z.record(z.string().min(1).max(128), z.string().max(64 * 1024)).default({})
}).strict()
export type OpenConnectorConnectInput = z.infer<typeof OpenConnectorConnectInputSchema>

export const OpenConnectorDisconnectInputSchema = z.object({
  service: ServiceSchema,
  connectionName: ConnectionNameSchema
}).strict()
export type OpenConnectorDisconnectInput = z.infer<typeof OpenConnectorDisconnectInputSchema>

export const OpenConnectorOAuthConfigInputSchema = z.object({
  service: ServiceSchema,
  clientId: z.string().trim().min(1).max(4_096),
  clientSecret: z.string().max(64 * 1024),
  extra: z.record(z.string().min(1).max(128), z.string().max(64 * 1024)).default({}),
  secretExtra: z.record(z.string().min(1).max(128), z.string().max(64 * 1024)).default({})
}).strict()
export type OpenConnectorOAuthConfigInput = z.infer<typeof OpenConnectorOAuthConfigInputSchema>

export const OpenConnectorOAuthStartInputSchema = z.object({
  service: ServiceSchema,
  connectionName: ConnectionNameSchema
}).strict()
export type OpenConnectorOAuthStartInput = z.infer<typeof OpenConnectorOAuthStartInputSchema>

export const OpenConnectorOAuthStartResultSchema = z.object({
  service: ServiceSchema,
  connectionName: ConnectionNameSchema,
  state: z.string().min(1),
  authorizationHost: z.string().min(1),
  expiresAt: z.string().datetime()
}).strict()
export type OpenConnectorOAuthStartResult = z.infer<typeof OpenConnectorOAuthStartResultSchema>

export const OpenConnectorOAuthPollInputSchema = z.object({
  service: ServiceSchema,
  connectionName: ConnectionNameSchema,
  state: z.string().min(1).max(4_096)
}).strict()
export type OpenConnectorOAuthPollInput = z.infer<typeof OpenConnectorOAuthPollInputSchema>

export const OpenConnectorOAuthCancelInputSchema = OpenConnectorOAuthPollInputSchema
export type OpenConnectorOAuthCancelInput = z.infer<typeof OpenConnectorOAuthCancelInputSchema>

export const OpenConnectorOAuthPollResultSchema = z.object({
  status: z.enum(['pending', 'connected', 'failed', 'expired', 'cancelled', 'denied']),
  connection: OpenConnectorConnectionSchema.optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional()
}).strict()
export type OpenConnectorOAuthPollResult = z.infer<typeof OpenConnectorOAuthPollResultSchema>

export const OpenConnectorDeviceRegistrationStatusSchema = z.enum([
  'pending',
  'authorized',
  'connected',
  'denied',
  'expired',
  'cancelled',
  'failed'
])
export type OpenConnectorDeviceRegistrationStatus = z.infer<
  typeof OpenConnectorDeviceRegistrationStatusSchema
>

export const OpenConnectorDeviceRegistrationStartInputSchema = z.object({
  service: ServiceSchema,
  connectionName: ConnectionNameSchema
}).strict()
export type OpenConnectorDeviceRegistrationStartInput = z.infer<
  typeof OpenConnectorDeviceRegistrationStartInputSchema
>

export const OpenConnectorDeviceRegistrationPollInputSchema = z.object({
  flowId: z.string().uuid()
}).strict()
export type OpenConnectorDeviceRegistrationPollInput = z.infer<
  typeof OpenConnectorDeviceRegistrationPollInputSchema
>

export const OpenConnectorDeviceRegistrationStartResultSchema = z.object({
  flowId: z.string().uuid(),
  service: ServiceSchema,
  connectionName: ConnectionNameSchema,
  status: z.literal('pending'),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url(),
  userCode: z.string().min(1).optional(),
  expiresAt: z.string().datetime(),
  intervalMs: z.number().int().min(500).max(60_000)
}).strict()
export type OpenConnectorDeviceRegistrationStartResult = z.infer<
  typeof OpenConnectorDeviceRegistrationStartResultSchema
>

export const OpenConnectorDeviceRegistrationResultSchema =
  OpenConnectorDeviceRegistrationStartResultSchema.omit({ status: true }).extend({
    status: OpenConnectorDeviceRegistrationStatusSchema,
    connection: OpenConnectorConnectionSchema.optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional()
  }).strict()
export type OpenConnectorDeviceRegistrationResult = z.infer<
  typeof OpenConnectorDeviceRegistrationResultSchema
>

export const OpenConnectorRunQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(8_192).optional(),
  service: ServiceSchema.optional(),
  actionId: z.string().trim().min(1).max(256).optional(),
  caller: z.enum(['http', 'mcp', 'web']).optional(),
  ok: z.boolean().optional()
}).strict()
export type OpenConnectorRunQuery = z.infer<typeof OpenConnectorRunQuerySchema>

export const OpenConnectorServiceInputSchema = z.object({ service: ServiceSchema }).strict()
export const OpenConnectorSetupHelpResultSchema = z.object({
  opened: z.literal(true),
  host: z.string().min(1)
}).strict()
export type OpenConnectorSetupHelpResult = z.infer<typeof OpenConnectorSetupHelpResultSchema>
export const OpenConnectorActionInputSchema = z.object({
  actionId: z.string().trim().min(1).max(256)
}).strict()
export const OpenConnectorRunInputSchema = z.object({
  id: z.string().trim().min(1).max(256)
}).strict()

export const OpenConnectorPolicyUpdateInputSchema = z.object({
  rules: OpenConnectorPolicyRulesSchema
}).strict()
export type OpenConnectorPolicyUpdateInput = z.infer<typeof OpenConnectorPolicyUpdateInputSchema>

export type OpenConnectorApi = {
  health: () => Promise<OpenConnectorHealth>
  start: () => Promise<OpenConnectorHealth>
  stop: () => Promise<OpenConnectorHealth>
  catalog: () => Promise<OpenConnectorCatalog>
  provider: (service: string) => Promise<OpenConnectorProvider>
  action: (actionId: string) => Promise<OpenConnectorActionDetail>
  connections: () => Promise<OpenConnectorConnection[]>
  connect: (input: OpenConnectorConnectInput) => Promise<OpenConnectorConnection>
  disconnect: (input: OpenConnectorDisconnectInput) => Promise<{ disconnected: true }>
  setDefault: (input: OpenConnectorDisconnectInput) => Promise<OpenConnectorConnection>
  oauthConfigs: () => Promise<OpenConnectorOAuthConfig[]>
  saveOAuthConfig: (input: OpenConnectorOAuthConfigInput) => Promise<OpenConnectorOAuthConfig>
  deleteOAuthConfig: (service: string) => Promise<{ deleted: true }>
  startOAuth: (input: OpenConnectorOAuthStartInput) => Promise<OpenConnectorOAuthStartResult>
  pollOAuth: (input: OpenConnectorOAuthPollInput) => Promise<OpenConnectorOAuthPollResult>
  cancelOAuth: (input: OpenConnectorOAuthCancelInput) => Promise<OpenConnectorOAuthPollResult>
  startDeviceRegistration: (
    input: OpenConnectorDeviceRegistrationStartInput
  ) => Promise<OpenConnectorDeviceRegistrationStartResult>
  pollDeviceRegistration: (
    input: OpenConnectorDeviceRegistrationPollInput
  ) => Promise<OpenConnectorDeviceRegistrationResult>
  cancelDeviceRegistration: (
    input: OpenConnectorDeviceRegistrationPollInput
  ) => Promise<OpenConnectorDeviceRegistrationResult>
  openSetupHelp: (service: string) => Promise<OpenConnectorSetupHelpResult>
  policy: () => Promise<OpenConnectorPolicy>
  updatePolicy: (input: OpenConnectorPolicyUpdateInput) => Promise<OpenConnectorPolicy>
  runs: (query?: OpenConnectorRunQuery) => Promise<OpenConnectorRunPage>
  run: (id: string) => Promise<OpenConnectorRun>
}
