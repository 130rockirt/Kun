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

export const extensionHostBrokerProvidersOperations = {
async registerTool(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const requestedDeclaration = ExtensionToolDeclarationSchema.parse(params)
    const manifest = await this['options'].resolveManifest?.(principal.extensionId)
    const declaration = requireManifestContribution(
      manifest?.contributes.tools,
      requestedDeclaration.id,
      'tool'
    )
    assertManifestDeclarationMatches(requestedDeclaration, declaration, 'tool')
    const registrationId = `tool_${randomUUID()}`
    const activationEvent = activationEventFor(manifest, `onTool:${declaration.id}`)
    const registration = await this['options'].tools.register(principal, {
      name: declaration.id,
      description: declaration.description,
      inputSchema: declaration.inputSchema,
      ...(declaration.outputSchema ? { outputSchema: declaration.outputSchema } : {}),
      sideEffect: toolSideEffect(declaration.sideEffects),
      idempotent: declaration.idempotent,
      ...(declaration.maxOutputBytes ? { maxOutputBytes: declaration.maxOutputBytes } : {})
    }, async (invocation) => {
      this['toolProgress'].set(invocation.invocationId, invocation.reportProgress)
      try {
        const result = ToolResultSchema.parse(await this['options'].invokeExtension(
          principal.extensionId,
          activationEvent,
          `tools.invoke:${registrationId}`,
          toJson({
            invocationId: invocation.invocationId,
            toolId: invocation.canonicalToolId,
            input: invocation.arguments,
            workspaceId: invocation.workspace,
            runId: invocation.turnId,
            threadId: invocation.threadId
          }),
          {
            signal: invocation.signal,
            workspaceRoots: [...principal.workspaceRoots]
          }
        ))
        if (result.generatedArtifacts?.length) {
          if (!this['options'].artifacts) {
            throw new Error('Generated artifact validation service is unavailable')
          }
          result.generatedArtifacts = await this['options'].artifacts.validateToolResult(
            principal,
            extensionWorkspaceKey(invocation.workspace),
            result.generatedArtifacts
          )
        }
        return { output: result, declaredOutput: result.content, isError: false }
      } finally {
        this['toolProgress'].delete(invocation.invocationId)
      }
    })
    this['tools'].set(registrationId, {
      extensionId: principal.extensionId,
      ...(principal.hostLifecycleNonce
        ? { hostLifecycleNonce: principal.hostLifecycleNonce }
        : {}),
      workspaceRoots: normalizedRegistrationWorkspaceRoots(principal.workspaceRoots),
      localId: declaration.id,
      activationEvent,
      dispose: registration.dispose
    })
    return { registrationId }
  },

unregisterTool(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const { registrationId } = RegistrationRequestSchema.parse(params)
    const registration = this['tools'].get(registrationId)
    if (registration && registrationOwnedByPrincipal(registration, principal)) {
      registration.dispose()
      this['tools'].delete(registrationId)
    }
    return null
  },

async registerProvider(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const requestedDeclaration = ModelProviderDeclarationSchema.parse(params)
    const manifest = await this['options'].resolveManifest?.(principal.extensionId)
    const declaration = requireManifestContribution(
      manifest?.contributes.modelProviders,
      requestedDeclaration.id,
      'model provider'
    )
    assertManifestDeclarationMatches(requestedDeclaration, declaration, 'model provider')
    const authentication = resolveAuthentication(manifest, declaration.authenticationProviderId)
    const definition = await this['options'].providerAccounts.registerProvider(principal, {
      id: declaration.id,
      displayName: declaration.displayName,
      ...(declaration.authenticationProviderId ? {
        authenticationProviderId: declaration.authenticationProviderId
      } : {}),
      authenticationScopes: authentication?.scopes ?? [],
      credentialHosts: declaration.credentialHosts,
      authTypes: [internalAuthenticationType(authentication?.type)],
      ...(authentication?.apiKey ? {
        apiKey: { headerName: authentication.apiKey.header, prefix: authentication.apiKey.prefix }
      } : authentication?.type === 'api-key' || authentication === undefined ? {
        apiKey: { headerName: 'Authorization', prefix: 'Bearer ' }
      } : {}),
      ...(authentication?.type === 'oauth2-pkce' ? {
        oauthPkce: {
          authorizationUrl: authentication.authorizationUrl!,
          tokenUrl: authentication.tokenUrl!,
          clientId: authentication.clientId!,
          redirectUri: authentication.redirectUri!,
          scopes: authentication.scopes ?? []
        }
      } : {}),
      ...(authentication?.type === 'device-code' ? {
        oauthDevice: {
          deviceAuthorizationUrl: authentication.deviceAuthorizationUrl!,
          tokenUrl: authentication.tokenUrl!,
          clientId: authentication.clientId!,
          scopes: authentication.scopes ?? []
        }
      } : {}),
      capabilities: providerCapabilities(declaration)
    })
    const registrationId = `provider_${randomUUID()}`
    const activationEvent = activationEventFor(manifest, `onProvider:${declaration.id}`)
    const adapter = this['remoteProviderAdapter'](
      principal,
      registrationId,
      activationEvent
    )
    let registration
    try {
      registration = await this['options'].modelProviders.register(principal, declaration, adapter)
    } catch (error) {
      await this['options'].providerAccounts.unregisterProvider(principal, definition.id).catch(() => undefined)
      throw error
    }
    this['providers'].set(registrationId, {
      extensionId: principal.extensionId,
      ...(principal.hostLifecycleNonce
        ? { hostLifecycleNonce: principal.hostLifecycleNonce }
        : {}),
      workspaceRoots: normalizedRegistrationWorkspaceRoots(principal.workspaceRoots),
      localId: declaration.id,
      providerId: definition.id,
      activationEvent,
      dispose: registration.dispose
    })
    await this['ensureProfiles'](principal, true)
    return { registrationId }
  },

async unregisterProvider(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const { registrationId } = RegistrationRequestSchema.parse(params)
    const registration = this['providers'].get(registrationId)
    if (registration && registrationOwnedByPrincipal(registration, principal)) {
      await registration.dispose()
      await this['options'].providerAccounts.unregisterProvider(principal, registration.providerId)
      this['providers'].delete(registrationId)
    }
    return null
  },

providerStatus(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const { providerId } = z.strictObject({ providerId: z.string().min(1).max(129) }).parse(params)
    const entry = [...this['providers'].values()].find((registration) =>
      registration.extensionId === principal.extensionId &&
      (registration.providerId === providerId || registration.localId === providerId)
    )
    return {
      providerId: entry?.providerId ?? providerId,
      status: entry ? 'available' : 'unavailable',
      ...(entry ? {} : { message: 'Provider is not registered in the active Extension Host.' }),
      checkedAt: this['now']().toISOString()
    }
  },

remoteProviderAdapter(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    registrationId: string,
    activationEvent: string
  ): ModelProviderAdapter {
    const invoke = (params: JsonValue, signal?: AbortSignal) => this['options'].invokeExtension(
      principal.extensionId,
      activationEvent,
      `modelProviders.invoke:${registrationId}`,
      params,
      { signal, workspaceRoots: [...principal.workspaceRoots] }
    )
    return {
      probe: async (binding, context) => z.object({
        ok: z.boolean(), latencyMs: z.number().optional(), message: z.string().optional(),
        details: JsonObjectSchema.optional()
      }).parse(await invoke(toJson({ operation: 'probe', binding }), cancellationSignal(context.cancellation))),
      listModels: async (binding, context) => z.array(z.unknown()).parse(
        await invoke(toJson({ operation: 'listModels', binding }), cancellationSignal(context.cancellation))
      ) as never,
      stream: (providerRequest, context) => this['remoteProviderStream'](
        principal,
        registrationId,
        activationEvent,
        providerRequest,
        cancellationSignal(context.cancellation)
      ),
      cancel: async (requestId) => {
        await invoke(toJson({ operation: 'cancel', requestId })).catch(() => undefined)
      },
      countTokens: async (providerRequest, context) => {
        const value = z.strictObject({ count: z.number().int().nonnegative() }).parse(await invoke(
          toJson({ operation: 'countTokens', request: providerRequest }),
          cancellationSignal(context.cancellation)
        ))
        return value.count
      }
    }
  },

async *remoteProviderStream(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    registrationId: string,
    activationEvent: string,
    request: ModelProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelProviderStreamEvent> {
    const key = providerStreamKey(registrationId, request.requestId)
    if (this['providerStreams'].has(key)) throw new Error(`duplicate extension provider request: ${request.requestId}`)
    const queue = new AsyncEventQueue<ModelProviderStreamEvent>({
      maximumItems: this['providerStreamQueueEvents'],
      maximumBytes: this['providerStreamQueueBytes'],
      sizeOf: serializedQueueBytes
    })
    const controller = new AbortController()
    const forwardCancellation = () => controller.abort(signal.reason)
    if (signal.aborted) forwardCancellation()
    else signal.addEventListener('abort', forwardCancellation, { once: true })
    const entry: ProviderStreamEntry = {
      extensionId: principal.extensionId,
      ...(principal.hostLifecycleNonce
        ? { hostLifecycleNonce: principal.hostLifecycleNonce }
        : {}),
      registrationId,
      requestId: request.requestId,
      queue,
      controller,
      transportTerminal: false,
      invocationSettled: false
    }
    this['providerStreams'].set(key, entry)
    const invocation = this['options'].invokeExtension(
      principal.extensionId,
      activationEvent,
      `modelProviders.invoke:${registrationId}`,
      toJson({ operation: 'stream', request }),
      {
        signal: controller.signal,
        resetTimeoutOnStream: true,
        workspaceRoots: [...principal.workspaceRoots]
      }
    )
    void invocation.then(
      () => {
        entry.invocationSettled = true
        queue.end()
      },
      (error) => {
        entry.invocationSettled = true
        queue.fail(error)
      }
    )
    try {
      for await (const event of queue) yield event
    } finally {
      signal.removeEventListener('abort', forwardCancellation)
      if (this['providerStreams'].get(key) === entry) this['providerStreams'].delete(key)
      if (!entry.invocationSettled && !entry.transportTerminal && !controller.signal.aborted) {
        controller.abort(new Error('extension provider stream consumer closed'))
      }
      queue.close()
    }
  },
}
