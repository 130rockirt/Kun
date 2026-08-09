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
  parseBody,
  parseQualifiedContributionId,
  parseQuery,
  projectRightRailDiscovery,
  sanitizeWorkbenchContributions,
  selectExtension
} from './extension-public-common.js'

export async function workbenchSnapshot(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const query = parseQuery(request, z.strictObject({
    workspace_root: WorkspaceRootSchema.optional(),
    locale: ManifestLocaleTagSchema.optional()
  }), {
    workspace_root: 'workspace_root',
    locale: 'locale'
  })
  if (!query.ok) return query.response
  const workspaceRoot = query.data.workspace_root === undefined
    ? undefined
    : resolve(query.data.workspace_root)
  const registry = await platform.registry.read()
  const extensions = Object.values(registry.extensions)
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((entry) => {
      const resolved = selectExtension(platform, entry, workspaceRoot)
      if (!resolved?.enabled) return []
      const compatibility = platform.packageManager.compatibilityReport(
        resolved.selected.manifest
      )
      const compatible = compatibility.api.compatible &&
        compatibility.kunEngine.compatible &&
        compatibility.rpc.compatible &&
        compatibility.diagnostics.every((diagnostic) => diagnostic.compatible)
      const localizedManifest = resolveExtensionManifestLocale(
        resolved.selected.manifest,
        query.data.locale
      )
      const contributes = sanitizeWorkbenchContributions(
        localizedManifest,
        resolved.grantedPermissions
      )
      const rightRailDiscovery = resolved.workspaceTrusted
        ? { views: [], containers: [] }
        : projectRightRailDiscovery(localizedManifest)
      const hasContribution = WORKBENCH_CONTRIBUTION_KEYS.some((key) => contributes[key].length > 0)
      if (!hasContribution && rightRailDiscovery.views.length === 0) return []
      return [{
        id: entry.id,
        version: resolved.selected.manifest.version,
        contributes,
        rightRailDiscovery,
        grantedPermissions: [...resolved.grantedPermissions],
        enabled: true,
        compatible,
        workspaceTrusted: resolved.workspaceTrusted,
        source: {
          type: resolved.selected.source.type,
          mutable: resolved.selected.mutable
        },
        compatibility,
        diagnostics: compatibility.diagnostics
          .filter((diagnostic) => !diagnostic.compatible)
          .map(({ code, message }) => ({ code, message }))
      }]
    })
  return jsonResponse({
    schemaVersion: 1,
    revision: registry.revision,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    extensions
  })
}

export async function configurationSnapshot(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, ConfigurationSnapshotRequestSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const grouped = new Map<string, string[]>()
  for (const contributionId of new Set(body.data.contributionIds)) {
    const parsed = parseQualifiedContributionId(contributionId)
    const current = grouped.get(parsed.extensionId) ?? []
    current.push(contributionId)
    grouped.set(parsed.extensionId, current)
  }
  const values: Record<string, Record<string, JsonValue>> = {}
  const revisions: Record<string, number> = {}
  for (const [extensionId, contributionIds] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const entry = await platform.registry.get(extensionId)
    if (!entry) throw new ExtensionBrokerError('not_found', 'Extension configuration was not found')
    const selected = selectExtension(platform, entry, workspaceRoot)
    if (!selected?.enabled || !selected.workspaceTrusted || !hasPermission(selected.grantedPermissions, 'ui.actions')) {
      throw new ExtensionBrokerError('permission_denied', 'Extension configuration is not available in this workspace')
    }
    for (const contributionId of contributionIds) {
      const localId = parseQualifiedContributionId(contributionId).localId
      if (!selected.selected.manifest.contributes.settings.some(({ id }) => id === localId)) {
        throw new ExtensionBrokerError('not_found', 'Extension configuration section was not found')
      }
    }
    const snapshot = await platform.configuration.snapshot({
      extensionId,
      manifest: selected.selected.manifest,
      contributionIds,
      ...(selected.workspaceKey ? { workspaceKey: selected.workspaceKey } : {})
    })
    Object.assign(values, snapshot.values)
    revisions[extensionId] = snapshot.revision
  }
  return jsonResponse({ schemaVersion: 1, values, revisions })
}

export async function updateConfiguration(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, ConfigurationUpdateRequestSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const parsed = parseQualifiedContributionId(body.data.contributionId)
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const entry = await platform.registry.get(parsed.extensionId)
  if (!entry) throw new ExtensionBrokerError('not_found', 'Extension configuration was not found')
  const selected = selectExtension(platform, entry, workspaceRoot)
  if (!selected?.enabled || !selected.workspaceTrusted || !hasPermission(selected.grantedPermissions, 'ui.actions')) {
    throw new ExtensionBrokerError('permission_denied', 'Extension configuration is not available in this workspace')
  }
  if (!selected.selected.manifest.contributes.settings.some(({ id }) => id === parsed.localId)) {
    throw new ExtensionBrokerError('not_found', 'Extension configuration section was not found')
  }
  const principal: ExtensionPrincipal = {
    extensionId: parsed.extensionId,
    extensionVersion: selected.selected.manifest.version,
    permissions: [...selected.grantedPermissions],
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    workspaceTrusted: selected.workspaceTrusted
  }
  const snapshot = await platform.configuration.update({
    principal,
    manifest: selected.selected.manifest,
    sectionId: parsed.localId,
    key: body.data.key,
    value: body.data.value,
    expectedRevision: body.data.expectedRevision
  })
  return jsonResponse({
    schemaVersion: 1,
    extensionId: parsed.extensionId,
    revision: snapshot.revision,
    values: snapshot.values
  })
}

export async function invokeExtensionCommand(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, InvokeExtensionCommandSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const parsed = parseQualifiedContributionId(body.data.commandId)
  const workspaceRoot = body.data.workspaceRoot ? resolve(body.data.workspaceRoot) : undefined
  const entry = await platform.registry.get(parsed.extensionId)
  if (!entry) throw new ExtensionBrokerError('not_found', 'Extension command was not found')
  const selected = selectExtension(platform, entry, workspaceRoot)
  const command = selected?.selected.manifest.contributes.commands.find(({ id }) => id === parsed.localId)
  if (!selected?.enabled || !selected.workspaceTrusted || !command || !selected.selected.manifest.main) {
    throw new ExtensionBrokerError('not_found', 'Extension command was not found')
  }
  if (!hasPermission(selected.grantedPermissions, 'commands.register')) {
    throw new ExtensionBrokerError('permission_denied', 'Missing permission: commands.register')
  }
  await platform.manager.activate(
    parsed.extensionId,
    activationEvent(selected.selected.manifest, parsed.localId, 'onCommand'),
    { ...(workspaceRoot ? { workspaceRoot } : {}) }
  )
  const principal: ExtensionPrincipal = {
    extensionId: parsed.extensionId,
    extensionVersion: selected.selected.manifest.version,
    permissions: [...selected.grantedPermissions],
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    workspaceTrusted: selected.workspaceTrusted
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  timeout.unref?.()
  try {
    const result = await platform.broker.handlePrincipal({
      principal,
      method: 'commands.execute',
      params: { id: parsed.localId, args: body.data.context },
      signal: controller.signal,
      requestId: `command_${randomUUID()}`
    })
    return jsonResponse({ schemaVersion: 1, result })
  } finally {
    clearTimeout(timeout)
  }
}

export function listWorkbenchNotifications(platform: ExtensionPlatformRuntime): JsonResponse {
  platform.viewSessions.touchWorkbench()
  return jsonResponse({
    schemaVersion: 1,
    notifications: platform.viewSessions.listWorkbenchNotifications()
  })
}

export async function respondWorkbenchNotification(
  platform: ExtensionPlatformRuntime,
  request: Request,
  context: RouteContext
): Promise<JsonResponse> {
  const notificationId = WorkbenchNotificationIdSchema.parse(context.params.notificationId)
  const body = await parseBody(
    request,
    WorkbenchNotificationResponseSchema,
    MAX_EXTENSION_VIEW_BODY_BYTES
  )
  if (!body.ok) return body.response
  if (!platform.viewSessions.respondWorkbenchNotification(notificationId, body.data.actionId)) {
    throw new ExtensionViewSessionError('not_found', 'Extension notification was not found or expired')
  }
  return jsonResponse({ schemaVersion: 1, responded: true })
}
