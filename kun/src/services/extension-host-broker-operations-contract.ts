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
import type { RegistrationIdSchema, RegistrationRequestSchema, RunIdSchema, ThreadIdSchema, SubscriptionIdSchema, StorageRequestSchema, StorageKeysRequestSchema, StorageSetRequestSchema, ConfigurationSectionSchema, ConfigurationRequestSchema, ConfigurationUpdateRequestSchema, CommandRegisterSchema, CommandExecuteSchema, ModelStreamNotificationSchema, ModelStreamEnvelopePayloadSchema, DEFAULT_PROVIDER_STREAM_QUEUE_EVENTS, DEFAULT_PROVIDER_STREAM_QUEUE_BYTES, ExtensionHostBrokerOptions, ToolRegistration, ProviderRegistration, AgentSubscription, JobSubscription, CommandRegistration, StoredAccountSession, ExtensionBrokerDispatchRequest, ProviderStreamEntry, requiredExtensionBrokerPermission, publicMediaMetadata, cacheFormat, publicMediaCapability, jobCaller, hostOwnsRegistration, registrationOwnedByPrincipal, normalizedRegistrationWorkspaceRoots, registrationIncludesWorkspace, sameRegistrationWorkspace, hostPrincipal, publicAgentRun, publicAgentEvent, publicOwnedThread, publicBudget, publicUsage, publicRunState, publicAccount, publicAccountSession, boundedError, providerCapabilities, resolveAuthentication, effectiveAuthenticationScopes, internalAuthenticationType, toolSideEffect, activationEventFor, requireManifestContribution, assertManifestDeclarationMatches, canonicalizeJson, expandProviderPermissions, requiredWorkspaceKey, viewStateKey, confinedWorkspacePath, verifyWorkspaceTarget, inside, assertNetworkPermission, responseProjection, readBoundedResponseBody, linkedAbortController, agentInputText, cancellationSignal, providerStreamKey, providerQueueLimitError, serializedQueueBytes, positiveQueueLimit, safeJsonObject, toPublicJson, toJson, isObject, AsyncEventQueue } from './extension-host-broker-core.js'

export interface ExtensionHostBrokerOperations {
  completePkceAccountSession(input: {
    principal: ExtensionPrincipal
    sessionId: string
    callbackUrl: string
  }): Promise<AccountSession>;
  disposeExtension(extensionId: string): Promise<void>;
  disposeExtensionWorkspace(extensionId: string, workspaceId: string): Promise<void>;
  disposeHost(hostPrincipalValue: HostExtensionPrincipal): Promise<void>;
  disposeViewSession(viewSessionId: string): number;
  dispose(): Promise<void>;
}
