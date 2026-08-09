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

export const extensionHostBrokerMediaOperations = {
async mediaPickFiles(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    const request = MediaPickFilesRequestSchema.parse(params)
    const result = await this['requireUiOperation'](principal, 'media.pickFiles', request, signal)
    return MediaPickFilesResultSchema.parse(result)
  },

async mediaPickSaveTarget(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    const request = MediaPickSaveTargetRequestSchema.parse(params)
    const result = await this['requireUiOperation'](principal, 'media.pickSaveTarget', request, signal)
    return MediaPickSaveTargetResultSchema.parse(result)
  },

async mediaCreateCacheTarget(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue
  ) {
    if (!this['options'].mediaHandles) throw new Error('Media handle service is unavailable')
    const request = MediaCreateCacheTargetRequestSchema.parse(params)
    if (!principal.workspaceTrusted || principal.workspaceRoots.length !== 1) {
      throw extensionError(
        'MEDIA_SCOPE_DENIED',
        'Cache media requires exactly one active trusted workspace',
        { operation: 'media.createCacheTarget' }
      )
    }
    const workspaceRoot = principal.workspaceRoots[0]!
    const format = cacheFormat(request.format)
    const relativeDirectory = join(
      '.kun',
      'extension-cache',
      principal.extensionId,
      request.purpose
    )
    const displayName = `${request.purpose}-${randomUUID()}.${format.extension}`
    const handle = await this['options'].mediaHandles.registerCacheTarget(principal, {
      workspaceRoot,
      path: join(relativeDirectory, displayName),
      displayName,
      mimeType: format.mimeType
    })
    return MediaCreateCacheTargetResultSchema.parse({
      target: publicMediaMetadata(handle, false)
    })
  },

async mediaStat(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].mediaHandles) throw new Error('Media handle service is unavailable')
    const request = z.strictObject({ handleId: z.string().min(16).max(512) }).parse(params)
    const handle = await this['options'].mediaHandles.stat(principal, request.handleId)
    return publicMediaMetadata(handle)
  },

async mediaReadText(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].mediaHandles) throw new Error('Media handle service is unavailable')
    const request = MediaReadTextRequestSchema.parse(params)
    const handle = await this['options'].mediaHandles.resolve(principal, request.handleId, 'read')
    if (handle.byteSize !== undefined && handle.byteSize > request.maxBytes) {
      throw extensionError(
        'MEDIA_LIMIT_EXCEEDED',
        `Selected text file exceeds the ${request.maxBytes}-byte read limit`,
        { operation: 'media.readText', limitCategory: 'media_text_bytes' }
      )
    }
    const bytes = await readFile(handle.absolutePath)
    if (bytes.byteLength > request.maxBytes) {
      throw extensionError(
        'MEDIA_LIMIT_EXCEEDED',
        `Selected text file exceeds the ${request.maxBytes}-byte read limit`,
        { operation: 'media.readText', limitCategory: 'media_text_bytes' }
      )
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw extensionError(
        'MEDIA_INVALID_ARGUMENT',
        'Selected text file is not valid UTF-8',
        { operation: 'media.readText' }
      )
    }
    return MediaReadTextResultSchema.parse({
      handleId: handle.id,
      displayName: handle.displayName,
      mimeType: handle.mimeType,
      byteSize: bytes.byteLength,
      content
    })
  },

async mediaRelease(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    const request = MediaReleaseRequestSchema.parse(params)
    if (request.resource === 'handle') {
      if (!this['options'].mediaHandles) throw new Error('Media handle service is unavailable')
      return { released: await this['options'].mediaHandles.release(principal, request.handleId) }
    }
    const result = await this['requireUiOperation'](principal, 'media.release', request, signal)
    return z.strictObject({ released: z.boolean() }).parse(result)
  },

async mediaOpenViewResource(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    if (!principal.viewSessionId || !principal.viewContributionId) {
      throw new Error('Media View resources require an authenticated View Session')
    }
    const request = MediaOpenViewResourceRequestSchema.parse(params)
    const result = await this['requireUiOperation'](principal, 'media.openViewResource', request, signal)
    const lease = MediaResourceLeaseSchema.parse(result)
    if (lease.handleId !== request.handleId) {
      throw extensionError(
        'MEDIA_INVALID_ARGUMENT',
        'The protected View lease did not match the requested media handle',
        { operation: 'media.openViewResource' }
      )
    }
    await this['options'].mediaHandles?.touch(principal, request.handleId)
    return lease
  },

async mediaPerformArtifactAction(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    if (!principal.viewSessionId || !principal.viewContributionId) {
      throw new Error('Artifact actions require an authenticated View Session')
    }
    const request = ArtifactHostActionRequestSchema.parse(params)
    const result = await this['requireUiOperation'](
      principal,
      'media.performArtifactAction',
      request,
      signal
    )
    return ArtifactHostActionResultSchema.parse(result)
  },

async mediaGetCapabilities(this: ExtensionHostBroker, principal: ExtensionPrincipal) {
    if (!this['options'].mediaProcesses) throw new Error('Media process service is unavailable')
    const capabilities = await this['options'].mediaProcesses.capabilities(principal)
    return MediaCapabilitiesSchema.parse({
      probedAt: capabilities.probedAt,
      ffprobe: publicMediaCapability(capabilities.ffprobe),
      ffmpeg: publicMediaCapability(capabilities.ffmpeg)
    })
  },

async mediaGetAudioAnalysisCapabilities(this: ExtensionHostBroker, principal: ExtensionPrincipal) {
    if (!this['options'].audioAnalysisJobs) {
      throw new Error('Audio-analysis job service is unavailable')
    }
    return MediaAudioAnalysisCapabilitiesSchema.parse(
      await this['options'].audioAnalysisJobs.capabilities(principal)
    )
  },

async mediaGetVisualModelStatus(this: ExtensionHostBroker, principal: ExtensionPrincipal) {
    if (!this['options'].visualAnalysis) throw new Error('Visual-analysis service is unavailable')
    return MediaVisualModelStatusSchema.parse(
      await this['options'].visualAnalysis.status(principal)
    )
  },

async mediaInstallVisualModel(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].visualAnalysis) throw new Error('Visual-analysis service is unavailable')
    MediaInstallVisualModelRequestSchema.parse(params)
    return MediaVisualModelStatusSchema.parse(
      await this['options'].visualAnalysis.install(principal)
    )
  },

async mediaAnalyzeVisualFrames(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    if (!this['options'].visualAnalysis) throw new Error('Visual-analysis service is unavailable')
    const request = MediaAnalyzeVisualFramesRequestSchema.parse(params)
    return MediaAnalyzeVisualFramesResultSchema.parse(
      await this['options'].visualAnalysis.analyzeFrames(principal, request, signal)
    )
  },

async mediaEmbedVisualQuery(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal
  ) {
    if (!this['options'].visualAnalysis) throw new Error('Visual-analysis service is unavailable')
    const request = MediaEmbedVisualQueryRequestSchema.parse(params)
    return MediaEmbedVisualQueryResultSchema.parse(
      await this['options'].visualAnalysis.embedQuery(principal, request, signal)
    )
  },

async mediaProbe(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].mediaProcesses) throw new Error('Media process service is unavailable')
    const request = MediaProbeRequestSchema.parse(params)
    return MediaProbeResultSchema.parse(await this['options'].mediaProcesses.probe(
      principal,
      request.handleId
    ))
  },

async mediaStartFfmpegJob(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].mediaJobs) throw new Error('Media job service is unavailable')
    const request = MediaStartFfmpegJobRequestSchema.parse(params)
    return { job: await this['options'].mediaJobs.start(principal, request) }
  },

async mediaStartAudioAnalysisJob(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue
  ) {
    if (!this['options'].audioAnalysisJobs) {
      throw new Error('Audio-analysis job service is unavailable')
    }
    const request = MediaStartAudioAnalysisJobRequestSchema.parse(params)
    return MediaStartAudioAnalysisJobResultSchema.parse(
      await this['options'].audioAnalysisJobs.start(principal, request)
    )
  },

async mediaStartArchiveJob(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    if (!this['options'].archiveJobs) throw new Error('Media archive job service is unavailable')
    const request = MediaStartArchiveJobRequestSchema.parse(params)
    return MediaStartArchiveJobResultSchema.parse(
      await this['options'].archiveJobs.start(principal, request)
    )
  },
}
