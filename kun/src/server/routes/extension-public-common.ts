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

export function sessionRoute(
  platform: ExtensionPlatformRuntime,
  handler: (
    principal: ExtensionPrincipal,
    request: Request,
    context: RouteContext,
    sessionId: string
  ) => Promise<Response | JsonResponse> | Response | JsonResponse
): RouteHandler {
  return withErrors(async (request, context) => {
    const rawSessionId = request.headers.get(EXTENSION_SESSION_ID_HEADER)
    if (!rawSessionId) {
      throw new ExtensionViewSessionError('unauthorized', 'Extension view session identity is required')
    }
    const sessionId = SessionIdSchema.parse(rawSessionId)
    authenticateSession(platform, request, sessionId)
    const release = platform.viewSessions.beginRequest(sessionId)
    try {
      return await handler(platform.viewSessions.principal(sessionId), request, context, sessionId)
    } finally {
      release()
    }
  })
}

export function authenticateSession(
  platform: ExtensionPlatformRuntime,
  request: Request,
  sessionId: string
): void {
  const declaredSessionId = request.headers.get(EXTENSION_SESSION_ID_HEADER)
  if (declaredSessionId && declaredSessionId !== sessionId) {
    throw new ExtensionViewSessionError('unauthorized', 'Extension view session identity mismatch')
  }
  const nonce = request.headers.get(EXTENSION_SESSION_NONCE_HEADER) ?? bearerToken(request.headers)
  if (!nonce || nonce.length > 512) {
    throw new ExtensionViewSessionError('unauthorized', 'Extension view session credential is required')
  }
  platform.viewSessions.authenticate(sessionId, nonce)
}

export function withErrors(handler: RouteHandler): RouteHandler {
  return async (request, context) => {
    try {
      return await handler(request, context)
    } catch (error) {
      return publicRouteError(error)
    }
  }
}

export async function resolveViewTarget(
  platform: ExtensionPlatformRuntime,
  contributionId: string,
  workspaceRoot?: string
): Promise<{ target: ExtensionViewSessionTarget; manifest: ExtensionManifest }> {
  const parsed = parseQualifiedContributionId(contributionId)
  const entry = await platform.registry.get(parsed.extensionId)
  if (!entry) throw new ExtensionViewSessionError('not_found', 'Extension view was not found')
  const selected = selectExtension(platform, entry, workspaceRoot)
  if (!selected?.enabled || !selected.workspaceTrusted) {
    throw new ExtensionViewSessionError('not_found', 'Extension view was not found')
  }
  const manifest = selected.selected.manifest
  try {
    platform.packageManager.admitManifest(manifest)
  } catch {
    // View sessions are an execution boundary too: browser-only extensions
    // must fail admission before any Webview resource can load.
    throw new ExtensionViewSessionError('not_found', 'Extension view is incompatible with this Kun version')
  }
  const matches = VIEW_CONTRIBUTION_KEYS.flatMap((point) => {
    if (!hasContributionPermission(point, selected.grantedPermissions)) return []
    return manifest.contributes[point]
      .filter((contribution) => contribution.id === parsed.localId)
      .map((contribution) => ({ contribution, point }))
  })
  if (matches.length !== 1) throw new ExtensionViewSessionError('not_found', 'Extension view was not found')
  const match = matches[0]!
  return {
    manifest,
    target: {
      extensionId: parsed.extensionId,
      extensionVersion: manifest.version,
      contributionId,
      localContributionId: parsed.localId,
      entry: match.contribution.entry,
      activationEvent: activationEvent(manifest, parsed.localId, 'onView'),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      grantedPermissions: [...selected.grantedPermissions],
      workspaceTrusted: selected.workspaceTrusted
    }
  }
}

export function viewActivationOptions(
  platform: ExtensionPlatformRuntime,
  target: ExtensionViewSessionTarget
): NonNullable<Parameters<ExtensionPlatformRuntime['manager']['activate']>[2]> {
  const workspaceRoot = target.workspaceRoot
  if (!workspaceRoot) return {}
  return {
    workspaceRoot,
    workspaceContext: {
      id: platform.paths.workspaceKey(workspaceRoot),
      name: basename(workspaceRoot) || workspaceRoot,
      root: workspaceRoot,
      trusted: target.workspaceTrusted,
      active: target.workspaceTrusted
    }
  }
}

export function selectExtension(
  platform: ExtensionPlatformRuntime,
  entry: ExtensionRegistryEntry,
  workspaceRoot?: string
): SelectedExtension | undefined {
  const selected = entry.useDevelopment
    ? entry.development
    : entry.selectedVersion ? entry.versions[entry.selectedVersion] : undefined
  if (!selected) return undefined
  const workspaceKey = workspaceRoot ? platform.paths.workspaceKey(workspaceRoot) : undefined
  const enabled = workspaceKey && workspaceKey in entry.workspaceEnablement
    ? entry.workspaceEnablement[workspaceKey]!
    : entry.globallyEnabled
  const workspaceTrusted = workspaceKey === undefined || Object.prototype.hasOwnProperty.call(
    entry.workspacePermissionGrants,
    workspaceKey
  )
  const grantedPermissions = workspaceKey === undefined
    ? selected.grantedPermissions
    : workspaceTrusted ? entry.workspacePermissionGrants[workspaceKey]! : []
  return {
    entry,
    selected,
    enabled,
    grantedPermissions: [...grantedPermissions],
    workspaceTrusted,
    ...(workspaceKey ? { workspaceKey } : {})
  }
}

export function sanitizeWorkbenchContributions(
  manifest: ExtensionManifest,
  grantedPermissions: readonly string[]
): ExtensionContributions {
  const result: Partial<Record<keyof ExtensionContributions, unknown>> = {}
  for (const key of WORKBENCH_CONTRIBUTION_KEYS) {
    result[key] = hasContributionPermission(key, grantedPermissions)
      ? structuredClone(manifest.contributes[key])
      : []
  }
  return ExtensionContributionsSchema.parse(result)
}

/**
 * Projects inert, Host-rendered rail metadata for an untrusted workspace.
 * Entry paths and resource roots deliberately stay on the trusted runtime
 * side so this projection can never be mistaken for an executable View.
 */
export function projectRightRailDiscovery(manifest: ExtensionManifest): {
  views: Array<{
    id: string
    title: string
    icon?: string
    container?: string
    when?: string
    showInRightRail?: boolean
    order: number
  }>
  containers: Array<{
    id: string
    title: string
    icon?: string
    location: 'rightSidebar'
    order: number
  }>
} {
  return {
    views: manifest.contributes['views.rightSidebar'].map((view) => ({
      id: view.id,
      title: view.title,
      ...(view.icon ? { icon: view.icon } : {}),
      ...(view.container ? { container: view.container } : {}),
      ...(view.when ? { when: view.when } : {}),
      ...(view.showInRightRail ? {} : { showInRightRail: false }),
      order: view.order
    })),
    containers: manifest.contributes['views.containers']
      .filter((container) => container.location === 'rightSidebar')
      .map((container) => ({
        id: container.id,
        title: container.title,
        ...(container.icon ? { icon: container.icon } : {}),
        location: 'rightSidebar' as const,
        order: container.order
      }))
  }
}

export function hasContributionPermission(
  key: keyof ExtensionContributions,
  grantedPermissions: readonly string[]
): boolean {
  const required = MANIFEST_CONTRIBUTION_PERMISSION_REQUIREMENTS[key]
  return required.every((permission) => grantedPermissions.includes(permission))
}

export function activationEvent(
  manifest: ExtensionManifest,
  localId: string,
  kind: 'onView' | 'onCommand' | 'onAuthentication'
): string {
  const preferred = `${kind}:${localId}`
  if (manifest.activationEvents.includes(preferred)) return preferred
  if (manifest.activationEvents.includes('onStartup')) return 'onStartup'
  throw new Error(`extension has no declared activation event for ${preferred}`)
}

export async function expandProviderPermissions(
  platform: ExtensionPlatformRuntime,
  principal: ExtensionPrincipal
): Promise<ExtensionPrincipal> {
  const permissions = new Set(principal.permissions)
  const entry = await platform.registry.get(principal.extensionId)
  const manifest = entry
    ? (entry.useDevelopment
        ? entry.development?.manifest
        : entry.selectedVersion ? entry.versions[entry.selectedVersion]?.manifest : undefined)
    : undefined
  for (const declaration of manifest?.contributes.modelProviders ?? []) {
    const providerId = extensionProviderId(principal.extensionId, declaration.id)
    for (const operation of ['use', 'manage'] as const) {
      if (permissions.has(`accounts.${operation}:${declaration.id}`)) {
        permissions.add(`accounts.${operation}:${providerId}`)
      }
    }
    if (permissions.has(`accounts.secrets.read:${declaration.id}`)) {
      permissions.add(`accounts.secrets.read:${providerId}`)
    }
  }
  return { ...principal, permissions: [...permissions] }
}

export async function resolveOwnedProviderId(
  platform: ExtensionPlatformRuntime,
  principal: ExtensionPrincipal,
  providerIdInput: string
): Promise<string> {
  const direct = await platform.providerAccounts.getProvider(providerIdInput)
  if (direct?.ownerExtensionId === principal.extensionId) return direct.id
  const canonical = extensionProviderId(principal.extensionId, providerIdInput)
  const provider = await platform.providerAccounts.getProvider(canonical)
  if (!provider || provider.ownerExtensionId !== principal.extensionId) {
    throw new ExtensionBrokerError('not_found', 'Extension-owned resource was not found')
  }
  return provider.id
}

export async function assertOwnedAccount(
  platform: ExtensionPlatformRuntime,
  principal: ExtensionPrincipal,
  providerId: string,
  accountId: string
): Promise<void> {
  const account = await platform.providerAccounts.getAccount(accountId)
  if (!account || account.ownerExtensionId !== principal.extensionId || account.providerId !== providerId) {
    throw new ExtensionBrokerError('not_found', 'Extension-owned resource was not found')
  }
}

export function requireAccountUse(principal: ExtensionPrincipal, providerId: string): void {
  requirePermission(principal, `accounts.use:${providerId}`)
}

export function requirePermission(principal: ExtensionPrincipal, permission: string): void {
  if (!principal.permissions.includes(permission)) {
    throw new ExtensionBrokerError('permission_denied', `Missing permission: ${permission}`)
  }
}

export function parseQualifiedContributionId(input: string): { extensionId: string; localId: string } {
  const match = /^extension:([^/]+)\/(.+)$/.exec(input)
  if (!match) throw new ExtensionViewSessionError('not_found', 'Extension view was not found')
  return {
    extensionId: ExtensionIdSchema.parse(match[1]),
    localId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).parse(match[2])
  }
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes: number
): Promise<{ ok: true; data: z.output<T> } | { ok: false; response: JsonResponse }> {
  const body = await readJsonBody(request, maxBytes)
  if (!body.ok) return body
  const parsed = schema.safeParse(body.value)
  if (!parsed.success) {
    return { ok: false, response: ERRORS.validation('invalid extension request', parsed.error.issues) }
  }
  return { ok: true, data: parsed.data }
}

export function parseQuery<T extends z.ZodType>(
  request: Request,
  schema: T,
  aliases: Record<string, string> = {}
): { ok: true; data: z.output<T> } | { ok: false; response: JsonResponse } {
  const url = new URL(request.url)
  const input: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    const resolvedKey = aliases[key] ?? key
    if (resolvedKey in input) {
      return { ok: false, response: ERRORS.validation(`duplicate extension query parameter: ${resolvedKey}`) }
    }
    input[resolvedKey] = value
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, response: ERRORS.validation('invalid extension query', parsed.error.issues) }
  }
  return { ok: true, data: parsed.data }
}

export function publicRouteError(error: unknown): JsonResponse {
  if (error instanceof z.ZodError) return ERRORS.validation('invalid extension request', error.issues)
  if (error instanceof ExtensionConfigurationConflictError) {
    return jsonResponse({
      code: 'extension_configuration_conflict',
      message: error.message,
      currentRevision: error.currentRevision
    }, 409)
  }
  if (error instanceof ExtensionViewSessionError) {
    if (error.code === 'not_found') return ERRORS.notFound(error.message)
    if (error.code === 'unauthorized') return ERRORS.unauthorized(error.message)
    if (error.code === 'rate_limited' || error.code === 'session_limit') return ERRORS.rateLimited(error.message)
    if (error.code === 'payload_too_large') {
      return jsonResponse({ code: error.code, message: error.message }, 413)
    }
  }
  if (error instanceof ExtensionBrokerError) {
    if (error.code === 'permission_denied' || error.code === 'workspace_denied') return ERRORS.forbidden(error.message)
    if (error.code === 'not_found') return ERRORS.notFound(error.message)
    if (error.code === 'conflict') return ERRORS.conflict(error.message)
    return ERRORS.validation(error.message)
  }
  if (error instanceof ExtensionMediaHandleError) {
    if (
      error.code === 'permission_denied' ||
      error.code === 'workspace_untrusted' ||
      error.code === 'workspace_denied' ||
      error.code === 'mode_denied'
    ) return ERRORS.forbidden(error.message)
    if (
      error.code === 'not_found' ||
      error.code === 'file_changed' ||
      error.code === 'handle_consumed'
    ) return ERRORS.notFound('Protected media selection is not available')
    if (error.code === 'handle_limit') return ERRORS.rateLimited(error.message)
    return ERRORS.validation(error.message)
  }
  return jsonResponse(safeErrorBody(error), 500)
}

export function safeErrorBody(error: unknown): { code: string; message: string } {
  return {
    code: 'extension_operation_failed',
    message: redactSecretText(error instanceof Error ? error.message : 'Extension operation failed').slice(0, 4096)
  }
}

export function safeJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (key, current) => {
    if (/(?:token|secret|authorization|cookie|credential|nonce)/i.test(key)) return '[REDACTED]'
    return current
  })) as JsonValue
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
