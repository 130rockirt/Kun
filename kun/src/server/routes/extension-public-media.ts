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
import { parseBody } from './extension-public-common.js'

export class ProtectedMediaOperationTokenRegistry {
  private readonly consumed = new Set<string>()

  consume(token: string): void {
    const digest = createHash('sha256').update(token).digest('hex')
    if (this.consumed.has(digest)) {
      throw new ExtensionBrokerError(
        'conflict',
        'Protected media operation was already consumed'
      )
    }
    if (this.consumed.size >= 65_536) {
      throw new ExtensionBrokerError(
        'conflict',
        'Protected media operation capacity was reached; restart Kun before retrying'
      )
    }
    // Burn first. A mismatched binding cannot turn the token into an oracle or
    // retry it later with a different selection.
    this.consumed.add(digest)
  }
}

export async function registerProtectedMediaSelections(
  platform: ExtensionPlatformRuntime,
  tokens: ProtectedMediaOperationTokenRegistry,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(
    request,
    ProtectedMediaSelectionRegistrationSchema,
    MAX_EXTENSION_VIEW_BODY_BYTES
  )
  if (!body.ok) return body.response
  tokens.consume(body.data.operationToken)

  const binding = body.data.binding
  if (binding.sessionId !== binding.runtimeSessionId) {
    throw new ExtensionViewSessionError('unauthorized', 'Protected media View identity mismatch')
  }
  const projection = platform.viewSessions.authenticate(
    binding.runtimeSessionId,
    binding.sessionNonce
  )
  const target = platform.viewSessions.target(binding.runtimeSessionId)
  if (
    projection.sessionId !== binding.runtimeSessionId ||
    projection.extensionId !== binding.extensionId ||
    projection.extensionVersion !== binding.extensionVersion ||
    projection.contributionId !== binding.contributionId ||
    projection.workspaceRoot !== binding.workspaceRoot ||
    target.extensionId !== binding.extensionId ||
    target.extensionVersion !== binding.extensionVersion ||
    target.contributionId !== binding.contributionId ||
    target.workspaceRoot !== binding.workspaceRoot
  ) {
    throw new ExtensionViewSessionError('unauthorized', 'Protected media View binding mismatch')
  }

  const principal = platform.viewSessions.principal(binding.runtimeSessionId)
  const created: MediaHandleProjection[] = []
  try {
    for (const selection of body.data.selections) {
      if (basename(selection.absolutePath) !== selection.displayName) {
        throw new ExtensionBrokerError(
          'validation_error',
          'Protected media selection display name does not match the selected file'
        )
      }
      created.push(await platform.mediaHandles.register(principal, {
        workspaceRoot: binding.workspaceRoot,
        path: selection.absolutePath,
        mode: body.data.mode === 'export' ? 'write' : 'read',
        source: 'picker',
        displayName: selection.displayName,
        ...(selection.mimeType ? { mimeType: selection.mimeType } : {})
      }))
    }
  } catch (error) {
    await Promise.all(created.map((handle) =>
      platform.mediaHandles.release(principal, handle.id).catch(() => false)
    ))
    throw error
  }
  return jsonResponse({
    selections: created.map(protectedMediaMetadata)
  }, 201)
}

export function protectedMediaMetadata(handle: MediaHandleProjection) {
  const kind = handle.mimeType.startsWith('video/')
    ? 'video'
    : handle.mimeType.startsWith('audio/')
      ? 'audio'
      : handle.mimeType.startsWith('image/')
        ? 'image'
        : handle.mimeType === 'text/vtt' || handle.mimeType === 'application/x-subrip'
          ? 'subtitle'
          : handle.mimeType === 'application/octet-stream'
            ? 'unknown'
            : 'data'
  return MediaMetadataSchema.parse({
    handleId: handle.id,
    mode: handle.mode === 'write' ? 'export' : 'read',
    kind,
    displayName: handle.displayName,
    mimeType: handle.mimeType,
    ...(handle.byteSize !== undefined ? { byteSize: handle.byteSize } : {}),
    ...(handle.modifiedAt ? { modifiedAt: handle.modifiedAt } : {}),
    ...(handle.completionIdentity ? { completionIdentity: handle.completionIdentity } : {}),
    ...(handle.workspaceRelativePath
      ? { workspaceRelativeDisplayLocation: handle.workspaceRelativePath }
      : {}),
    revoked: !handle.available
  })
}

export async function resolveProtectedMediaLease(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(
    request,
    ProtectedMediaLeaseResolutionSchema,
    MAX_EXTENSION_VIEW_BODY_BYTES
  )
  if (!body.ok) return body.response
  const binding = body.data.binding
  if (binding.sessionId !== binding.runtimeSessionId) {
    throw new ExtensionViewSessionError('unauthorized', 'Protected media View identity mismatch')
  }
  const projection = platform.viewSessions.authenticate(binding.runtimeSessionId, binding.sessionNonce)
  const target = platform.viewSessions.target(binding.runtimeSessionId)
  if (
    projection.extensionId !== binding.extensionId ||
    projection.extensionVersion !== binding.extensionVersion ||
    projection.contributionId !== binding.contributionId ||
    projection.workspaceRoot !== binding.workspaceRoot ||
    target.extensionId !== binding.extensionId ||
    target.extensionVersion !== binding.extensionVersion ||
    target.contributionId !== binding.contributionId ||
    target.workspaceRoot !== binding.workspaceRoot
  ) {
    throw new ExtensionViewSessionError('unauthorized', 'Protected media View binding mismatch')
  }
  const principal = platform.viewSessions.principal(binding.runtimeSessionId)
  const media = await platform.mediaHandles.resolve(principal, body.data.handleId, 'read')
  if (!media.identity) {
    throw new ExtensionBrokerError('not_found', 'Media resource is unavailable')
  }
  const ttlMs = Math.min(body.data.requestedTtlMs ?? 5 * 60_000, 5 * 60_000)
  return jsonResponse({
    binding,
    handleId: media.id,
    absolutePath: media.absolutePath,
    mimeType: media.mimeType,
    fileIdentity: {
      byteSize: media.identity.size,
      modifiedAtMs: media.identity.mtimeMs,
      device: media.identity.device,
      inode: media.identity.inode
    },
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  })
}

export async function resolveProtectedArtifact(
  platform: ExtensionPlatformRuntime,
  request: Request
): Promise<JsonResponse> {
  const body = await parseBody(
    request,
    ProtectedArtifactResolutionSchema,
    MAX_EXTENSION_VIEW_BODY_BYTES
  )
  if (!body.ok) return body.response
  if (platform.paths.workspaceKey(body.data.workspaceRoot) !== body.data.workspaceId) {
    throw new ExtensionBrokerError('not_found', 'Generated artifact is unavailable')
  }
  const principal: ExtensionPrincipal = {
    extensionId: body.data.ownerExtensionId,
    extensionVersion: body.data.ownerExtensionVersion,
    permissions: ['media.read', 'workspace.read'],
    workspaceRoots: [body.data.workspaceRoot],
    workspaceTrusted: true
  }
  const artifact = await platform.artifacts.getOwned(principal, body.data.artifactId)
  if (artifact.workspaceId !== body.data.workspaceId || artifact.availability !== 'available') {
    throw new ExtensionBrokerError('not_found', 'Generated artifact is unavailable')
  }
  const media = await platform.mediaHandles.resolve(principal, artifact.mediaHandleId, 'read')
  if (media.completionIdentity !== artifact.completionIdentity) {
    throw new ExtensionBrokerError('not_found', 'Generated artifact is unavailable')
  }
  return jsonResponse({
    artifactId: artifact.artifactId,
    absolutePath: media.absolutePath,
    displayName: artifact.displayName,
    mimeType: artifact.mimeType
  })
}
