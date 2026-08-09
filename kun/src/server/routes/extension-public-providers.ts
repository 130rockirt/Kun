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
  expandProviderPermissions,
  parseBody,
  parseQuery,
  selectExtension
} from './extension-public-common.js'
import { projectManagedAccount } from './extension-public-accounts.js'

export async function listManagedModelProviders(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const query = parseQuery(request, ManagedProviderCatalogQuerySchema)
  if (!query.ok) return query.response
  const workspaceRoot = query.data.workspace_root
    ? resolve(query.data.workspace_root)
    : undefined
  const scopeKey = providerBindingScope(platform, workspaceRoot)
  const registry = await platform.registry.read()
  const providers: unknown[] = []
  for (const entry of Object.values(registry.extensions).sort((left, right) => left.id.localeCompare(right.id))) {
    const selected = selectExtension(platform, entry, workspaceRoot)
    if (!selected || selected.selected.manifest.contributes.modelProviders.length === 0) continue
    const manifest = selected.selected.manifest
    let compatible = true
    try {
      platform.packageManager.admitManifest(manifest)
    } catch {
      compatible = false
    }
    const principal = await expandProviderPermissions(platform, {
      extensionId: entry.id,
      extensionVersion: manifest.version,
      permissions: [...selected.grantedPermissions],
      workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
      workspaceTrusted: selected.workspaceTrusted
    })
    for (const declaration of manifest.contributes.modelProviders) {
      const providerId = extensionProviderId(entry.id, declaration.id)
      const dataCategories = providerDataCategories()
      const dataAccessDigest = providerDataAccessDigest(entry.id, selected, declaration)
      const permissionReady = hasPermission(selected.grantedPermissions, 'providers.register') &&
        hasPermission(selected.grantedPermissions, 'accounts.read') &&
        hasPermission(selected.grantedPermissions, `accounts.use:${declaration.id}`)
      if (
        selected.enabled &&
        selected.workspaceTrusted &&
        compatible &&
        permissionReady &&
        manifest.main
      ) {
        await platform.manager.activate(
          entry.id,
          providerActivationEvent(manifest, declaration.id),
          { ...(workspaceRoot ? { workspaceRoot } : {}) }
        ).catch(() => undefined)
      }
      const [definition, storedBinding] = await Promise.all([
        platform.providerAccounts.getProvider(providerId),
        platform.providerAccounts.getBinding(scopeKey, providerId)
      ])
      const definitionReady = definition?.ownerExtensionId === entry.id &&
        definition.ownerExtensionVersion === manifest.version
      const accounts = permissionReady
        ? await platform.accounts.listAccounts(principal, providerId).catch(() => [])
        : []
      const connectedAccounts = accounts.filter((account) => account.status === 'connected')
      const boundAccount = storedBinding?.binding.accountId
        ? connectedAccounts.find((account) => account.id === storedBinding.binding.accountId)
        : undefined
      const acknowledgementCurrent = Boolean(
        storedBinding &&
        storedBinding.ownerExtensionId === entry.id &&
        storedBinding.ownerExtensionVersion === manifest.version &&
        storedBinding.dataAccessDigest === dataAccessDigest
      )
      const modelResult = boundAccount && definitionReady && platform.modelProviders.isAvailable(providerId)
        ? await listModelsWithDeclaredFallback(
            platform,
            providerId,
            boundAccount.id,
            declaration,
            request.signal
          )
        : { models: [...declaration.models], discoveryError: undefined }
      const bindingModelAvailable = Boolean(
        storedBinding && modelResult.models.some((model) => model.id === storedBinding.binding.modelId)
      )
      const bindingValid = Boolean(
        selected.enabled &&
        selected.workspaceTrusted &&
        compatible &&
        permissionReady &&
        definitionReady &&
        platform.modelProviders.isAvailable(providerId) &&
        boundAccount &&
        acknowledgementCurrent &&
        bindingModelAvailable
      )
      const unavailableReason = !selected.enabled
        ? 'extension-disabled'
        : !selected.workspaceTrusted
          ? 'workspace-untrusted'
          : !compatible
            ? 'extension-incompatible'
            : !permissionReady
              ? 'permissions-required'
              : !definitionReady || !platform.modelProviders.isAvailable(providerId)
                ? 'provider-unavailable'
                : connectedAccounts.length === 0
                  ? 'account-required'
                  : undefined
      providers.push({
        extensionId: entry.id,
        extensionVersion: manifest.version,
        extensionDisplayName: manifest.displayName ?? entry.id,
        localProviderId: declaration.id,
        providerId,
        displayName: declaration.displayName,
        models: modelResult.models,
        accounts: accounts.map(projectManagedAccount),
        dataAccess: {
          digest: dataAccessDigest,
          categories: dataCategories,
          requiresAcknowledgement: !acknowledgementCurrent
        },
        binding: storedBinding
          ? {
              accountId: storedBinding.binding.accountId,
              modelId: storedBinding.binding.modelId,
              acknowledgedAt: storedBinding.acknowledgedAt,
              valid: bindingValid
            }
          : null,
        selectable: Boolean(
          selected.enabled && selected.workspaceTrusted && compatible && permissionReady &&
          definitionReady && platform.modelProviders.isAvailable(providerId) && connectedAccounts.length > 0
        ),
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(modelResult.discoveryError ? { discoveryError: modelResult.discoveryError } : {})
      })
    }
  }
  return jsonResponse({ schemaVersion: 1, scope: workspaceRoot ? 'workspace' : 'global', providers })
}

export async function listManagedProviderModels(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const query = parseQuery(request, ManagedProviderModelsQuerySchema)
  if (!query.ok) return query.response
  const workspaceRoot = query.data.workspace_root
    ? resolve(query.data.workspace_root)
    : undefined
  const context = await managedProviderContext(platform, {
    extensionId: query.data.extension_id,
    extensionVersion: query.data.extension_version,
    localProviderId: query.data.provider_id,
    accountId: query.data.account_id,
    workspaceRoot
  })
  const result = await listModelsWithDeclaredFallback(
    platform,
    context.providerId,
    query.data.account_id,
    context.declaration,
    request.signal
  )
  return jsonResponse({
    schemaVersion: 1,
    providerId: context.providerId,
    models: result.models,
    ...(result.discoveryError ? { discoveryError: result.discoveryError } : {})
  })
}

export async function setManagedProviderBinding(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(request, ManagedProviderBindingSchema, MAX_EXTENSION_VIEW_BODY_BYTES)
  if (!body.ok) return body.response
  const workspaceRoot = body.data.workspaceRoot
    ? resolve(body.data.workspaceRoot)
    : undefined
  const context = await managedProviderContext(platform, {
    extensionId: body.data.extensionId,
    extensionVersion: body.data.extensionVersion,
    localProviderId: body.data.providerId,
    accountId: body.data.accountId,
    workspaceRoot
  })
  const models = await listModelsWithDeclaredFallback(
    platform,
    context.providerId,
    body.data.accountId,
    context.declaration,
    request.signal
  )
  if (!models.models.some((model) => model.id === body.data.modelId)) {
    throw new ExtensionBrokerError('not_found', 'Model is not owned by the selected extension provider')
  }
  const selected = selectExtension(platform, context.entry, workspaceRoot)
  if (!selected) throw new ExtensionBrokerError('not_found', 'Extension version was not found')
  const dataCategories = providerDataCategories()
  const record = await platform.providerAccounts.setBinding({
    scopeKey: providerBindingScope(platform, workspaceRoot),
    ownerExtensionId: body.data.extensionId,
    ownerExtensionVersion: body.data.extensionVersion,
    binding: {
      providerId: context.providerId,
      accountId: body.data.accountId,
      modelId: body.data.modelId
    },
    dataAccessDigest: providerDataAccessDigest(
      body.data.extensionId,
      selected,
      context.declaration
    ),
    dataCategories: [...dataCategories]
  })
  return jsonResponse({
    schemaVersion: 1,
    binding: {
      providerId: record.binding.providerId,
      accountId: record.binding.accountId,
      modelId: record.binding.modelId,
      ownerExtensionId: record.ownerExtensionId,
      ownerExtensionVersion: record.ownerExtensionVersion,
      dataAccessDigest: record.dataAccessDigest,
      dataCategories: record.dataCategories,
      acknowledgedAt: record.acknowledgedAt
    }
  })
}

export async function managedProviderContext(
  platform: ExtensionPlatformRuntime,
  input: {
    extensionId: string
    extensionVersion: string
    localProviderId: string
    accountId: string
    workspaceRoot?: string
  }
): Promise<{
  entry: ExtensionRegistryEntry
  declaration: ModelProviderDeclaration
  providerId: string
}> {
  const entry = await platform.registry.get(input.extensionId)
  if (!entry) throw new ExtensionBrokerError('not_found', 'Extension was not found')
  const selected = selectExtension(platform, entry, input.workspaceRoot)
  if (!selected || selected.selected.manifest.version !== input.extensionVersion) {
    throw new ExtensionBrokerError('conflict', 'Extension version changed; repeat the protected action')
  }
  if (!selected.enabled || !selected.workspaceTrusted) {
    throw new ExtensionBrokerError('permission_denied', 'Extension is not enabled and trusted for this workspace')
  }
  platform.packageManager.admitManifest(selected.selected.manifest)
  const declaration = selected.selected.manifest.contributes.modelProviders.find(
    ({ id }) => id === input.localProviderId
  )
  if (!declaration) throw new ExtensionBrokerError('not_found', 'Model provider was not found')
  for (const permission of [
    'providers.register',
    'accounts.read',
    `accounts.use:${declaration.id}`
  ]) {
    if (!hasPermission(selected.grantedPermissions, permission)) {
      throw new ExtensionBrokerError('permission_denied', `Missing permission: ${permission}`)
    }
  }
  await platform.manager.activate(
    input.extensionId,
    providerActivationEvent(selected.selected.manifest, declaration.id),
    { ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}) }
  )
  const providerId = extensionProviderId(input.extensionId, declaration.id)
  const definition = await platform.providerAccounts.getProvider(providerId)
  if (
    !definition ||
    definition.ownerExtensionId !== input.extensionId ||
    definition.ownerExtensionVersion !== input.extensionVersion ||
    !platform.modelProviders.isAvailable(providerId)
  ) {
    throw new ExtensionBrokerError('not_found', 'Extension model provider is unavailable')
  }
  const account = await platform.providerAccounts.getAccount(input.accountId)
  if (
    !account ||
    account.ownerExtensionId !== input.extensionId ||
    account.providerId !== providerId ||
    account.status !== 'connected'
  ) {
    throw new ExtensionBrokerError('not_found', 'A connected account for this provider is required')
  }
  return { entry, declaration, providerId }
}

export async function listModelsWithDeclaredFallback(
  platform: ExtensionPlatformRuntime,
  providerId: string,
  accountId: string,
  declaration: ModelProviderDeclaration,
  signal: AbortSignal
): Promise<{ models: ProviderModel[]; discoveryError?: string }> {
  try {
    const models = await platform.modelProviders.listModels(providerId, accountId, signal)
    return { models }
  } catch (error) {
    if (declaration.models.length === 0) throw error
    return {
      models: [...declaration.models],
      discoveryError: redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 1_024)
    }
  }
}

export function providerBindingScope(
  _platform: ExtensionPlatformRuntime,
  workspaceRoot?: string
): string {
  return extensionProviderBindingScope(workspaceRoot)
}

export function providerDataCategories() {
  return [
    'conversation-history',
    'system-and-mode-instructions',
    'attachments',
    'tool-schemas'
  ] as const
}

export function providerDataAccessDigest(
  extensionId: string,
  selected: SelectedExtension,
  declaration: ModelProviderDeclaration
): string {
  return createHash('sha256').update(JSON.stringify({
    extensionId,
    extensionVersion: selected.selected.manifest.version,
    provider: declaration,
    requestedPermissions: [...selected.selected.requestedPermissions].sort(),
    dataCategories: providerDataCategories()
  })).digest('hex')
}

export function providerActivationEvent(manifest: ExtensionManifest, localId: string): string {
  const preferred = `onProvider:${localId}`
  if (manifest.activationEvents.includes(preferred)) return preferred
  if (manifest.activationEvents.includes('onStartup')) return 'onStartup'
  throw new ExtensionBrokerError(
    'not_found',
    `Extension has no declared activation event for model provider: ${localId}`
  )
}
