import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  AccountSchema,
  ArtifactHostActionRequestSchema,
  ArtifactHostActionResultSchema,
  AgentCancelRequestSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  AgentRunSchema,
  AgentSteerRequestSchema,
  AgentSubscribeRequestSchema,
  AuthenticatedFetchRequestSchema,
  CreateAccountSessionRequestSchema,
  ExtensionToolDeclarationSchema,
  JsonObjectSchema,
  JsonValueSchema,
  ListAccountsRequestSchema,
  ListOwnThreadsRequestSchema,
  JobCancelRequestSchema,
  JobGetRequestSchema,
  JobListRequestSchema,
  JobSnapshotSchema,
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaAnalyzeVisualFramesResultSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaEmbedVisualQueryResultSchema,
  MediaInstallVisualModelRequestSchema,
  MediaMetadataSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaCreateCacheTargetResultSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickFilesResultSchema,
  MediaPickSaveTargetRequestSchema,
  MediaPickSaveTargetResultSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaResourceLeaseSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartAudioAnalysisJobResultSchema,
  MediaStartArchiveJobRequestSchema,
  MediaStartArchiveJobResultSchema,
  MediaVisualModelStatusSchema,
  ModelProviderDeclarationSchema,
  ModelProviderStreamEventSchema,
  NetworkRequestSchema,
  ProviderBindingSchema,
  RevealSecretRequestSchema,
  ToolProgressSchema,
  ToolResultSchema,
  WorkspaceFileSchema,
  type Account,
  type AccountSession,
  type AgentRun,
  type AgentRunEvent,
  type AuthenticationProviderDeclaration,
  type CommandContribution,
  type ExtensionManifest,
  type JsonValue as PublicJsonValue,
  type ModelProviderAdapter,
  type ModelProviderRequest,
  type ModelProviderStreamEvent,
  type ProviderBinding
} from '@kun/extension-api'
import type { ExtensionModelProviderRegistry } from '../adapters/model/extension-model-provider.js'
import type { ExtensionToolRegistry } from '../adapters/tool/extension-tool-provider.js'
import type { ToolExecutionUpdate } from '../ports/tool-host.js'
import type {
  ExtensionBrokerRequest,
  ExtensionPrincipal as HostExtensionPrincipal
} from '../extensions/host-process.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { JsonValue } from '../extensions/types.js'
import type { ExtensionStateStore } from '../extensions/state-store.js'
import {
  assertBrokeredNetworkUrl,
  createSafeNetworkFetch,
  normalizedBrokerHostname
} from '../extensions/safe-network-fetch.js'
import {
  extensionProviderBindingScope,
  extensionProviderId,
  type ExtensionProviderAccountStore
} from './extension-provider-account-store.js'
import type { ExtensionAccountBroker } from './extension-account-broker.js'
import type { ExtensionCredentialStore } from './extension-credential-store.js'
import type { ExtensionConfigurationService } from './extension-configuration-service.js'
import type { ExtensionArtifactService } from './extension-artifact-service.js'
import type { ExtensionMediaHandleService, MediaHandleProjection } from './extension-media-handle-service.js'
import type { ExtensionMediaProcessService } from './extension-media-process-service.js'
import type { ExtensionMediaJobService } from './extension-media-job-service.js'
import type { ExtensionAudioAnalysisJobService } from './extension-audio-analysis-job-service.js'
import type { ExtensionMediaArchiveJobService } from './extension-media-archive-job-service.js'
import type { ExtensionVisualAnalysisService } from './extension-visual-analysis-service.js'
import type { ExtensionJobService } from './extension-job-service.js'
import type { ExtensionJobSubscription } from './extension-job-subscription.js'
import type {
  ExtensionAgentEvent,
  ExtensionAgentRun,
  ExtensionAgentService,
  ExtensionAgentSubscription,
  ExtensionOwnedThread,
  ExtensionPrincipal
} from './extension-agent-service.js'
import type { ExtensionAgentProfileRegistry } from './extension-agent-profile-registry.js'
import {
  compileExtensionJsonSchema,
  type ExtensionJsonSchemaValidator
} from '../extensions/json-schema-validator.js'
import { extensionError } from '../extensions/errors.js'
import { type ExtensionHostBroker, RegistrationIdSchema, RegistrationRequestSchema, RunIdSchema, ThreadIdSchema, SubscriptionIdSchema, StorageRequestSchema, StorageKeysRequestSchema, StorageSetRequestSchema, ConfigurationSectionSchema, ConfigurationRequestSchema, ConfigurationUpdateRequestSchema, CommandRegisterSchema, CommandExecuteSchema, ModelStreamNotificationSchema, ModelStreamEnvelopePayloadSchema, DEFAULT_PROVIDER_STREAM_QUEUE_EVENTS, DEFAULT_PROVIDER_STREAM_QUEUE_BYTES, type ExtensionHostBrokerOptions, type ToolRegistration, type ProviderRegistration, type AgentSubscription, type JobSubscription, type CommandRegistration, type StoredAccountSession, type ExtensionBrokerDispatchRequest, type ProviderStreamEntry, requiredExtensionBrokerPermission, publicMediaMetadata, cacheFormat, publicMediaCapability, jobCaller, hostOwnsRegistration, registrationOwnedByPrincipal, normalizedRegistrationWorkspaceRoots, registrationIncludesWorkspace, sameRegistrationWorkspace, hostPrincipal, publicAgentRun, publicAgentEvent, publicOwnedThread, publicBudget, publicUsage, publicRunState, publicAccount, publicAccountSession, boundedError, providerCapabilities, resolveAuthentication, effectiveAuthenticationScopes, internalAuthenticationType, toolSideEffect, activationEventFor, requireManifestContribution, assertManifestDeclarationMatches, canonicalizeJson, expandProviderPermissions, requiredWorkspaceKey, viewStateKey, confinedWorkspacePath, verifyWorkspaceTarget, inside, assertNetworkPermission, responseProjection, readBoundedResponseBody, linkedAbortController, agentInputText, cancellationSignal, providerStreamKey, providerQueueLimitError, serializedQueueBytes, positiveQueueLimit, safeJsonObject, toPublicJson, toJson, isObject, AsyncEventQueue } from './extension-host-broker-core.js'

export const extensionHostBrokerWorkspacePrincipalOperations = {
async workspace(this: ExtensionHostBroker, principal: ExtensionPrincipal, method: string, params: JsonValue) {
    if (method === 'workspace.writeFile') {
      const input = WorkspaceFileSchema.parse(params)
      const target = await confinedWorkspacePath(principal, input.path, true)
      const content = input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content)
      if (content.byteLength > 8 * 1024 * 1024) throw new Error('workspace write exceeds 8 MiB')
      await writeFile(target, content)
      return null
    }
    const input = z.strictObject({
      path: z.string().min(1).max(4096),
      encoding: z.enum(['utf8', 'base64']).optional()
    }).parse(params)
    const target = await confinedWorkspacePath(principal, input.path, false)
    if (method === 'workspace.readFile') {
      const content = await readFile(target)
      if (content.byteLength > 8 * 1024 * 1024) throw new Error('workspace read exceeds 8 MiB')
      return {
        path: input.path,
        content: (input.encoding ?? 'utf8') === 'base64' ? content.toString('base64') : content.toString('utf8'),
        encoding: input.encoding ?? 'utf8'
      }
    }
    if (method === 'workspace.stat') {
      const info = await stat(target)
      return {
        path: input.path,
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      }
    }
    const entries = await readdir(target, { withFileTypes: true })
    return entries.slice(0, 10_000).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
  },

async expandPrincipalForBinding(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    binding?: ProviderBinding
  ): Promise<ExtensionPrincipal> {
    if (!binding) return principal
    return this['expandPrincipalForProviderId'](principal, binding.providerId)
  },

async ensureProfiles(this: ExtensionHostBroker, principal: ExtensionPrincipal, force = false): Promise<void> {
    const manifest = await this['options'].resolveManifest?.(principal.extensionId)
    if (!manifest) return
    const definitions = manifest.contributes.agentProfiles.map((profile) => ({
      id: profile.id,
      displayName: profile.title,
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.instructions ? { instructionOverlay: profile.instructions } : {}),
      ...(profile.providerBinding ? {
        providerBinding: {
          ...profile.providerBinding,
          providerId: this['resolveProviderId'](principal, profile.providerBinding.providerId)
        }
      } : {}),
      ...(profile.allowedTools ? { allowedToolScopes: profile.allowedTools } : {}),
      ...(profile.budget ? {
        defaultBudget: {
          ...profile.budget,
          ...(profile.budget.maxEvents ? { maxRetainedEvents: profile.budget.maxEvents } : {})
        }
      } : {}),
      visibility: profile.visibility
    }))
    const signature = JSON.stringify(definitions)
    const current = this['profileRegistrations'].get(principal.extensionId)
    if (!force && current?.signature === signature) return
    current?.dispose()
    const dispose = this['options'].profiles.register({
      extensionId: principal.extensionId,
      extensionVersion: principal.extensionVersion,
      profiles: definitions
    })
    this['profileRegistrations'].set(principal.extensionId, { signature, dispose })
  },

expandPrincipalForProviderId(this: ExtensionHostBroker, principal: ExtensionPrincipal, providerId: string): ExtensionPrincipal {
    const registration = [...this['providers'].values()].find((entry) =>
      entry.extensionId === principal.extensionId &&
      (entry.providerId === providerId || entry.localId === providerId)
    )
    return registration
      ? expandProviderPermissions(principal, registration.localId, registration.providerId)
      : principal
  },

resolveProviderId(this: ExtensionHostBroker, principal: ExtensionPrincipal, providerId: string): string {
    return [...this['providers'].values()].find((entry) =>
      entry.extensionId === principal.extensionId &&
      (entry.providerId === providerId || entry.localId === providerId)
    )?.providerId ?? providerId
  },

expandPrincipalForAllProviders(this: ExtensionHostBroker, principal: ExtensionPrincipal): ExtensionPrincipal {
    let expanded = principal
    for (const registration of this['providers'].values()) {
      if (registration.extensionId === principal.extensionId) {
        expanded = expandProviderPermissions(expanded, registration.localId, registration.providerId)
      }
    }
    return expanded
  },

principalWithProviderPermissions(this: ExtensionHostBroker,
    extensionId: string,
    permissions: readonly string[],
    providerId: string
  ): ExtensionPrincipal {
    return {
      extensionId,
      extensionVersion: 'unknown',
      permissions: [...permissions],
      workspaceRoots: [],
      workspaceTrusted: false
    }
  },
}
