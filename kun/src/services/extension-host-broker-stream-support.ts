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
import { RegistrationIdSchema, RegistrationRequestSchema, RunIdSchema, ThreadIdSchema, SubscriptionIdSchema, StorageRequestSchema, StorageKeysRequestSchema, StorageSetRequestSchema, ConfigurationSectionSchema, ConfigurationRequestSchema, ConfigurationUpdateRequestSchema, CommandRegisterSchema, CommandExecuteSchema, ModelStreamNotificationSchema, ModelStreamEnvelopePayloadSchema, DEFAULT_PROVIDER_STREAM_QUEUE_EVENTS, DEFAULT_PROVIDER_STREAM_QUEUE_BYTES, type ExtensionHostBrokerOptions, type ToolRegistration, type ProviderRegistration, type AgentSubscription, type JobSubscription, type CommandRegistration, type StoredAccountSession, type ExtensionBrokerDispatchRequest, type ProviderStreamEntry, requiredExtensionBrokerPermission, publicMediaMetadata, cacheFormat, publicMediaCapability, jobCaller, hostOwnsRegistration, registrationOwnedByPrincipal, normalizedRegistrationWorkspaceRoots, registrationIncludesWorkspace, sameRegistrationWorkspace, hostPrincipal, publicAgentRun, publicAgentEvent, publicOwnedThread, publicBudget, publicUsage, publicRunState, publicAccount, publicAccountSession, boundedError, providerCapabilities, resolveAuthentication, effectiveAuthenticationScopes, internalAuthenticationType, toolSideEffect, activationEventFor, requireManifestContribution, assertManifestDeclarationMatches, canonicalizeJson, expandProviderPermissions, requiredWorkspaceKey, viewStateKey, confinedWorkspacePath, verifyWorkspaceTarget, inside, assertNetworkPermission, responseProjection, readBoundedResponseBody, linkedAbortController, agentInputText, cancellationSignal, providerStreamKey, providerQueueLimitError, serializedQueueBytes, positiveQueueLimit, safeJsonObject, toPublicJson, toJson } from './extension-host-broker-core.js'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{
    value: T
    bytes: number
    accepted?: (accepted: boolean) => void
  }> = []
  private readonly waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = []
  private bufferedBytes = 0
  private terminal = false
  private error: unknown

  constructor(private readonly options: {
    maximumItems: number
    maximumBytes: number
    sizeOf(value: T): number
  }) {}

  pushLegacy(value: T): boolean {
    return this.enqueue(value)
  }

  pushBackpressured(value: T): Promise<boolean> {
    if (this.terminal) return Promise.resolve(false)
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return Promise.resolve(true)
    }
    const bytes = this.options.sizeOf(value)
    if (!this.hasCapacity(bytes)) return Promise.resolve(false)
    return new Promise((resolve) => {
      this.values.push({ value, bytes, accepted: resolve })
      this.bufferedBytes += bytes
    })
  }

  end(): void {
    if (this.terminal) return
    this.terminal = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: unknown): void {
    if (this.terminal) return
    this.terminal = true
    this.error = error
    for (const entry of this.values.splice(0)) entry.accepted?.(false)
    this.bufferedBytes = 0
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  close(): void {
    if (this.terminal && this.values.length === 0) return
    this.terminal = true
    for (const entry of this.values.splice(0)) entry.accepted?.(false)
    this.bufferedBytes = 0
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.values.shift()
        if (entry !== undefined) {
          this.bufferedBytes -= entry.bytes
          entry.accepted?.(true)
          return Promise.resolve({ value: entry.value, done: false })
        }
        if (this.error !== undefined) return Promise.reject(this.error)
        if (this.terminal) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      }
    }
  }

  private enqueue(value: T): boolean {
    if (this.terminal) return false
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return true
    }
    const bytes = this.options.sizeOf(value)
    if (!this.hasCapacity(bytes)) return false
    this.values.push({ value, bytes })
    this.bufferedBytes += bytes
    return true
  }

  private hasCapacity(bytes: number): boolean {
    return this.values.length < this.options.maximumItems &&
      this.bufferedBytes + bytes <= this.options.maximumBytes
  }
}
