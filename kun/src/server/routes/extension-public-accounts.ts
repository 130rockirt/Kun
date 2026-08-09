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
import {
  EXTENSION_SESSION_ID_HEADER,
  EXTENSION_SESSION_NONCE_HEADER,
  MAX_EXTENSION_VIEW_BODY_BYTES,
  MAX_EXTENSION_AGENT_BODY_BYTES,
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  SessionIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  ProviderIdSchema,
  LocalProviderIdSchema,
  AccountIdSchema,
  WorkspaceRootSchema,
  CreateViewSessionSchema,
  QualifiedSettingContributionSchema,
  ConfigurationSnapshotRequestSchema,
  ConfigurationUpdateRequestSchema,
  WorkbenchEnvironmentSchema,
  ViewBrokerRequestSchema,
  ViewRequestIdSchema,
  InvokeExtensionCommandSchema,
  ManagedAccountSessionSchema,
  ManagedProviderCatalogQuerySchema,
  ManagedProviderModelsQuerySchema,
  ManagedProviderBindingSchema,
  ManagedAccountSessionActionSchema,
  ManagedAccountSessionCompletionSchema,
  ManagedApiKeyAccountSchema,
  ManagedDeleteAccountSchema,
  ManagedRenameAccountSchema,
  ManagedReplaceApiKeyAccountSchema,
  SecretRevealDecisionSchema,
  WorkbenchNotificationResponseSchema,
  WorkbenchNotificationIdSchema,
  ProtectedMediaViewBindingSchema,
  ProtectedMediaSelectionRegistrationSchema,
  ProtectedMediaLeaseResolutionSchema,
  ProtectedArtifactResolutionSchema,
  VIEW_BROKER_METHODS,
  ProviderProbeSchema,
  WORKBENCH_CONTRIBUTION_KEYS,
  VIEW_CONTRIBUTION_KEYS,
  SelectedExtension
} from './extension-public-schemas.js'
import {
  activationEvent,
  assertOwnedAccount,
  expandProviderPermissions,
  parseBody,
  parseQuery,
  resolveOwnedProviderId,
  selectExtension,
  sessionRoute,
  withErrors
} from './extension-public-common.js'
import {
  accountListResponse,
  listOwnAccounts
} from './extension-public-agent.js'

export function accountListRoute(
  runtime: ServerRuntime,
  platform: ExtensionPlatformRuntime
): RouteHandler {
  const guest = sessionRoute(platform, (principal, request) =>
    listOwnAccounts(platform, principal, request))
  return withErrors(async (request, context) => {
    if (!isRuntimeTokenAuthorized(request.headers, runtime.runtimeToken)) {
      return guest(request, context)
    }
    const query = parseQuery(request, z.strictObject({
      extension_id: ExtensionIdSchema,
      provider_id: ProviderIdSchema.optional(),
      include_unavailable: z.enum(['true', 'false']).transform((value) => value === 'true').optional()
    }))
    if (!query.ok) return query.response
    const { principal } = await resolveManagementContext(platform, query.data.extension_id)
    return accountListResponse(
      platform,
      principal,
      query.data.provider_id,
      query.data.include_unavailable ?? false
    )
  })
}

export async function createManagedAccountSession(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedAccountSessionSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal, manifest } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  assertProviderAuthenticationContribution(
    manifest,
    body.data.providerId,
    body.data.authenticationProviderId
  )
  await platform.manager.activate(
    principal.extensionId,
    activationEvent(manifest, body.data.authenticationProviderId, 'onAuthentication'),
    { ...(workspaceRoot ? { workspaceRoot } : {}) }
  )
  const result = await platform.broker.handleTrustedManagement({
    principal,
    method: 'authentication.createSession',
    params: {
      providerId: body.data.providerId,
      authenticationProviderId: body.data.authenticationProviderId,
      ...(body.data.label ? { label: body.data.label } : {}),
      ...(body.data.scopes ? { scopes: body.data.scopes } : {})
    },
    signal: request.signal,
    requestId: `account_session_${randomUUID()}`
  })
  return jsonResponse({ schemaVersion: 1, session: result }, 201)
}

export async function getManagedAccountSession(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const query = parseQuery(request, z.strictObject({ extension_id: ExtensionIdSchema }))
  if (!query.ok) return query.response
  const { principal } = await resolveManagementContext(platform, query.data.extension_id)
  const sessionId = z.string().min(1).max(256).parse(context.params.sessionId)
  const result = await platform.broker.handleTrustedManagement({
    principal,
    method: 'authentication.getSession',
    params: { sessionId },
    signal: request.signal,
    requestId: `account_session_get_${randomUUID()}`
  })
  return jsonResponse({ schemaVersion: 1, session: result })
}

export async function cancelManagedAccountSession(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedAccountSessionActionSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const { principal } = await resolveManagementContext(platform, body.data.extensionId)
  const sessionId = z.string().min(1).max(256).parse(context.params.sessionId)
  await platform.broker.handlePrincipal({
    principal,
    method: 'authentication.cancelSession',
    params: { sessionId },
    signal: request.signal,
    requestId: `account_session_cancel_${randomUUID()}`
  })
  return jsonResponse({ schemaVersion: 1, cancelled: true })
}

export async function completeManagedAccountSession(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedAccountSessionCompletionSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  const sessionId = z.string().min(1).max(256).parse(context.params.sessionId)
  const session = await platform.broker.completePkceAccountSession({
    principal,
    sessionId,
    callbackUrl: body.data.callbackUrl
  })
  return jsonResponse({ schemaVersion: 1, session })
}

export async function createManagedApiKeyAccount(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedApiKeyAccountSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal: basePrincipal, manifest } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  assertProviderAuthenticationContribution(
    manifest,
    body.data.providerId,
    body.data.authenticationProviderId
  )
  await platform.manager.activate(
    basePrincipal.extensionId,
    activationEvent(manifest, body.data.authenticationProviderId, 'onAuthentication'),
    { ...(workspaceRoot ? { workspaceRoot } : {}) }
  )
  const principal = await expandProviderPermissions(platform, basePrincipal)
  const providerId = await resolveOwnedProviderId(platform, principal, body.data.providerId)
  const account = await platform.accounts.createApiKeyAccount({
    principal,
    providerId,
    label: body.data.label ?? 'API key',
    apiKey: body.data.secret,
    protectedInput: true
  })
  return jsonResponse({ schemaVersion: 1, account }, 201)
}

export async function deleteManagedAccount(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedDeleteAccountSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal: basePrincipal } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  const principal = await expandProviderPermissions(platform, basePrincipal)
  const providerId = await resolveOwnedProviderId(platform, principal, body.data.providerId)
  const accountId = AccountIdSchema.parse(context.params.accountId)
  await assertOwnedAccount(platform, principal, providerId, accountId)
  const deleted = await platform.accounts.deleteAccount(principal, accountId)
  return jsonResponse({ schemaVersion: 1, deleted })
}

export async function renameManagedAccount(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedRenameAccountSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal: basePrincipal } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  const principal = await expandProviderPermissions(platform, basePrincipal)
  const providerId = await resolveOwnedProviderId(platform, principal, body.data.providerId)
  const accountId = AccountIdSchema.parse(context.params.accountId)
  await assertOwnedAccount(platform, principal, providerId, accountId)
  const account = await platform.accounts.renameAccount({
    principal,
    accountId,
    label: body.data.label
  })
  return jsonResponse({ schemaVersion: 1, account })
}

export async function replaceManagedApiKeyAccount(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedReplaceApiKeyAccountSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const { principal: basePrincipal } = await resolveManagementContext(
    platform,
    body.data.extensionId,
    workspaceRoot,
    body.data.extensionVersion
  )
  const principal = await expandProviderPermissions(platform, basePrincipal)
  const providerId = await resolveOwnedProviderId(platform, principal, body.data.providerId)
  const accountId = AccountIdSchema.parse(context.params.accountId)
  await assertOwnedAccount(platform, principal, providerId, accountId)
  const account = await platform.accounts.replaceApiKeyAccount({
    principal,
    accountId,
    apiKey: body.data.secret,
    protectedInput: true
  })
  return jsonResponse({ schemaVersion: 1, account })
}

export function projectManagedAccount(account: Awaited<ReturnType<ExtensionPlatformRuntime['accounts']['listAccounts']>>[number]) {
  return AccountSchema.parse({
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    authenticationType: account.authType === 'oauth-pkce'
      ? 'oauth2-pkce'
      : account.authType === 'oauth-device' ? 'device-code' : 'api-key',
    status: account.status,
    metadata: account.metadata,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    ...(account.expiresAt ? { expiresAt: account.expiresAt } : {})
  })
}

export async function decideSecretReveal(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const requestId = z.string().regex(/^secret_reveal_[0-9a-f-]{36}$/i).parse(context.params.requestId)
  const body = await parseBody(request, SecretRevealDecisionSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  if (!platform.secretReveals.decide(requestId, body.data.decision)) {
    throw new ExtensionBrokerError('not_found', 'Secret reveal request was not found or expired')
  }
  return jsonResponse({ schemaVersion: 1, decided: true })
}

export async function resolveManagementContext(
  platform: ExtensionPlatformRuntime,
  extensionId: string,
  workspaceRoot?: string,
  expectedVersion?: string
): Promise<{ principal: ExtensionPrincipal; manifest: ExtensionManifest }> {
  const entry = await platform.registry.get(extensionId)
  if (!entry) throw new ExtensionBrokerError('not_found', 'Extension was not found')
  const selected = selectExtension(platform, entry, workspaceRoot)
  if (!selected) throw new ExtensionBrokerError('not_found', 'Extension version was not found')
  const manifest = selected.selected.manifest
  if (expectedVersion && expectedVersion !== manifest.version) {
    throw new ExtensionBrokerError('conflict', 'Extension version changed; repeat the protected action')
  }
  return {
    manifest,
    principal: {
      extensionId,
      extensionVersion: manifest.version,
      permissions: [...selected.grantedPermissions],
      workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
      workspaceTrusted: selected.workspaceTrusted
    }
  }
}

export function assertAuthenticationContribution(manifest: ExtensionManifest, localId: string): void {
  if (!manifest.contributes.authentication.some(({ id }) => id === localId)) {
    throw new ExtensionBrokerError('not_found', 'Authentication provider was not found')
  }
}

export function assertProviderAuthenticationContribution(
  manifest: ExtensionManifest,
  providerId: string,
  authenticationProviderId: string
): void {
  assertAuthenticationContribution(manifest, authenticationProviderId)
  const provider = manifest.contributes.modelProviders.find(({ id }) => id === providerId)
  if (!provider || provider.authenticationProviderId !== authenticationProviderId) {
    throw new ExtensionBrokerError(
      'not_found',
      'Authentication provider does not match the selected model provider'
    )
  }
  // The broker repeats scope-subset validation against the persisted provider
  // definition immediately before beginning authorization.
}
