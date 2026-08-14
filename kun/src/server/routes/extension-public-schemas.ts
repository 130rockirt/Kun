import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  AccountSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  AgentRunSchema,
  AgentSteerRequestSchema,
  ExtensionContributionsSchema,
  ExtensionIdSchema,
  EXTENSION_VIEW_SAFE_METHODS,
  HostMessageSchema,
  JsonValueSchema,
  LocaleSchema,
  MANIFEST_CONTRIBUTION_PERMISSION_REQUIREMENTS,
  ManifestLocaleTagSchema,
  MediaMetadataSchema,
  ProviderBindingSchema,
  ThemeSchema,
  hasPermission,
  resolveExtensionManifestLocale,
  type AgentRun,
  type AgentRunEvent,
  type ExtensionContributions,
  type ExtensionManifest,
  type JsonValue,
  type ModelProviderDeclaration,
  type ProviderModel
} from '@kun/extension-api'
import { redactSecretText } from '../../config/secret-redaction.js'
import type { ExtensionProviderDefinition } from '../../contracts/extension-providers.js'
import type {
  DevelopmentExtensionRecord,
  ExtensionRegistryEntry,
  InstalledExtensionVersion
} from '../../extensions/index.js'
import {
  extensionProviderBindingScope,
  extensionProviderId
} from '../../services/extension-provider-account-store.js'
import { requiredExtensionBrokerPermission } from '../../services/extension-host-broker.js'
import { ExtensionConfigurationConflictError } from '../../services/extension-configuration-service.js'
import {
  ExtensionMediaHandleError,
  type MediaHandleProjection
} from '../../services/extension-media-handle-service.js'
import {
  ExtensionBrokerError,
  type ExtensionAgentEvent,
  type ExtensionAgentRun,
  type ExtensionAgentSubscription,
  type ExtensionOwnedThread,
  type ExtensionPrincipal
} from '../../services/extension-agent-service.js'
import {
  ExtensionViewSessionError,
  type ExtensionViewSessionEvent,
  type ExtensionViewSessionTarget
} from '../../services/extension-view-session-service.js'
import { bearerToken, isRuntimeTokenAuthorized } from '../auth.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { Router, type RouteContext, type RouteHandler } from '../router.js'
import type { ExtensionPlatformRuntime, ServerRuntime } from './server-runtime.js'
import { ERRORS } from './runtime-error.js'
export const EXTENSION_SESSION_ID_HEADER = 'x-kun-extension-session-id'
export const EXTENSION_SESSION_NONCE_HEADER = 'x-kun-extension-session-nonce'

export const MAX_EXTENSION_VIEW_BODY_BYTES = 256 * 1024
export const MAX_EXTENSION_AGENT_BODY_BYTES = 1024 * 1024
export const DEFAULT_EVENT_LIMIT = 50
export const MAX_EVENT_LIMIT = 100
export const HEARTBEAT_INTERVAL_MS = 15_000

export const SessionIdSchema = z.string().regex(/^view_[0-9a-f-]{36}$/i).max(64)
export const RunIdSchema = z.string().min(1).max(256)
export const ThreadIdSchema = z.string().min(1).max(256)
export const ProviderIdSchema = z.string().min(1).max(129)
export const LocalProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const AccountIdSchema = z.string().min(1).max(256)
export const WorkspaceRootSchema = z.string().trim().min(1).max(4096).refine(isAbsolute, 'workspaceRoot must be absolute')

export const CreateViewSessionSchema = z.strictObject({
  contributionId: z.string().regex(/^extension:[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/),
  workspaceRoot: WorkspaceRootSchema.optional()
})

export const QualifiedSettingContributionSchema = z.string().regex(
  /^extension:[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/
)
export const ConfigurationSnapshotRequestSchema = z.strictObject({
  contributionIds: z.array(QualifiedSettingContributionSchema).max(256),
  workspaceRoot: WorkspaceRootSchema.optional()
})
export const ConfigurationUpdateRequestSchema = z.strictObject({
  contributionId: QualifiedSettingContributionSchema,
  key: z.string().min(1).max(256),
  value: JsonValueSchema,
  expectedRevision: z.number().int().nonnegative(),
  workspaceRoot: WorkspaceRootSchema.optional()
})

export const WorkbenchEnvironmentSchema = z.strictObject({
  theme: ThemeSchema,
  locale: LocaleSchema
})

export const ViewBrokerRequestSchema = z.strictObject({
  requestId: z.string().trim().min(8).max(256),
  method: z.string().trim().min(1).max(128),
  params: JsonValueSchema.optional(),
  timeoutMs: z.number().int().min(1).max(300_000).default(60_000)
})

export const ViewRequestIdSchema = z.string().trim().min(8).max(256)

export const InvokeExtensionCommandSchema = z.strictObject({
  commandId: z.string().regex(/^extension:[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/),
  context: JsonValueSchema,
  workspaceRoot: WorkspaceRootSchema.optional()
})

export const ManagedAccountSessionSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  extensionVersion: z.string().min(1).max(64),
  providerId: ProviderIdSchema,
  authenticationProviderId: z.string().min(1).max(129),
  label: z.string().trim().min(1).max(128).optional(),
  scopes: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  workspaceRoot: WorkspaceRootSchema.optional()
})

export const ManagedProviderCatalogQuerySchema = z.strictObject({
  workspace_root: WorkspaceRootSchema.optional()
})

export const ManagedProviderModelsQuerySchema = z.strictObject({
  extension_id: ExtensionIdSchema,
  extension_version: z.string().min(1).max(64),
  provider_id: LocalProviderIdSchema,
  account_id: AccountIdSchema,
  workspace_root: WorkspaceRootSchema.optional()
})

export const ManagedProviderBindingSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  extensionVersion: z.string().min(1).max(64),
  providerId: LocalProviderIdSchema,
  accountId: AccountIdSchema,
  modelId: z.string().trim().min(1).max(256),
  workspaceRoot: WorkspaceRootSchema.optional(),
  acknowledgedDataAccess: z.literal(true)
})

export const ManagedAccountSessionActionSchema = z.strictObject({
  extensionId: ExtensionIdSchema
})

export const ManagedAccountSessionCompletionSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  extensionVersion: z.string().min(1).max(64),
  workspaceRoot: WorkspaceRootSchema.optional(),
  callbackUrl: z.string().url().max(16 * 1024)
})

export const ManagedApiKeyAccountSchema = ManagedAccountSessionSchema.extend({
  extensionVersion: z.string().min(1).max(64),
  workspaceRoot: WorkspaceRootSchema.optional(),
  secret: z.string().min(1).max(64 * 1024)
}).strict()

export const ManagedDeleteAccountSchema = z.strictObject({
  extensionId: ExtensionIdSchema,
  extensionVersion: z.string().min(1).max(64),
  providerId: ProviderIdSchema,
  workspaceRoot: WorkspaceRootSchema.optional()
})

export const ManagedRenameAccountSchema = ManagedDeleteAccountSchema.extend({
  label: z.string().trim().min(1).max(128)
}).strict()

export const ManagedReplaceApiKeyAccountSchema = ManagedDeleteAccountSchema.extend({
  secret: z.string().min(1).max(64 * 1024)
}).strict()

export const SecretRevealDecisionSchema = z.strictObject({
  decision: z.enum(['allow', 'deny'])
})
export const WorkbenchNotificationResponseSchema = z.strictObject({
  actionId: z.string().min(1).max(64).optional()
})
export const WorkbenchNotificationIdSchema = z.string().regex(/^notification_[0-9a-f-]{36}$/i)

export const ProtectedMediaViewBindingSchema = z.strictObject({
  sessionId: SessionIdSchema,
  runtimeSessionId: SessionIdSchema,
  sessionNonce: z.string().min(32).max(256),
  extensionId: ExtensionIdSchema,
  extensionVersion: z.string().trim().min(1).max(128),
  contributionId: z.string().regex(
    /^extension:[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/
  ),
  workspaceRoot: WorkspaceRootSchema,
  senderWebContentsId: z.number().int().positive(),
  senderMainFrameProcessId: z.number().int().nonnegative(),
  senderMainFrameRoutingId: z.number().int()
})
export const ProtectedMediaSelectionRegistrationSchema = z.strictObject({
  operationToken: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
  binding: ProtectedMediaViewBindingSchema,
  mode: z.enum(['read', 'export']),
  selections: z.array(z.strictObject({
    absolutePath: z.string().trim().min(1).max(16_384).refine(isAbsolute),
    displayName: z.string().trim().min(1).max(256),
    mimeType: z.string().min(3).max(128)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
      .optional()
  })).min(1).max(128)
})
export const ProtectedMediaLeaseResolutionSchema = z.strictObject({
  binding: ProtectedMediaViewBindingSchema,
  handleId: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
  requestedTtlMs: z.number().int().min(1_000).max(60 * 60 * 1_000).optional()
})
export const ProtectedArtifactResolutionSchema = z.strictObject({
  artifactId: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
  ownerExtensionId: ExtensionIdSchema,
  ownerExtensionVersion: z.string().min(1).max(64),
  workspaceId: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceRoot: WorkspaceRootSchema
})

/** Guest-safe broker methods. Protected account/secret operations stay in Main-owned UI. */
export const VIEW_BROKER_METHODS: ReadonlySet<string> = new Set(EXTENSION_VIEW_SAFE_METHODS)

export const ProviderProbeSchema = z.strictObject({
  accountId: AccountIdSchema,
  modelId: z.string().min(1).max(256).optional()
})

export const WORKBENCH_CONTRIBUTION_KEYS = [
  'commands',
  'views.containers',
  'views.leftSidebar',
  'views.rightSidebar',
  'views.auxiliaryPanel',
  'views.editorTab',
  'views.fullPage',
  'actions.topBar',
  'actions.composer',
  'actions.message',
  'message.resultPreviews',
  'settings',
  'contextMenus',
  'notifications',
  'hostContentScripts'
] as const satisfies readonly (keyof ExtensionContributions)[]

export const VIEW_CONTRIBUTION_KEYS = [
  'views.leftSidebar',
  'views.rightSidebar',
  'views.auxiliaryPanel',
  'views.editorTab',
  'views.fullPage',
  'message.resultPreviews'
] as const satisfies readonly (keyof ExtensionContributions)[]

export type SelectedExtension = {
  entry: ExtensionRegistryEntry
  selected: InstalledExtensionVersion | DevelopmentExtensionRecord
  enabled: boolean
  grantedPermissions: string[]
  workspaceTrusted: boolean
  workspaceKey?: string
}

/**
 * Public extension routes used by trusted Main and sender-bound Webviews.
 * Register these before `/v1/extensions/:id`, because the Router is first-match.
 */
