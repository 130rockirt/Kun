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

export const extensionHostBrokerAccountsOperations = {
async listAccounts(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue): Promise<Account[]> {
    const input = ListAccountsRequestSchema.parse(params)
    const resolvedProviderId = input.providerId
      ? this['resolveProviderId'](principal, input.providerId)
      : undefined
    const expanded = resolvedProviderId
      ? this['expandPrincipalForProviderId'](principal, resolvedProviderId)
      : this['expandPrincipalForAllProviders'](principal)
    const accounts = await this['options'].accounts.listAccounts(expanded, resolvedProviderId)
    const protection = await this['options'].credentials.protection()
    const publicProtection: Account['protection'] = protection.mode === 'primary'
      ? 'system'
      : protection.mode === 'encrypted-fallback' ? 'encrypted-fallback' : 'unavailable'
    return accounts
      .filter((account) => input.includeUnavailable || account.status !== 'unavailable')
      .map((account) => AccountSchema.parse(publicAccount(account, publicProtection)))
  },

async createAccountSession(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    exposeInteractiveMaterial: boolean
  ): Promise<AccountSession> {
    this['pruneAccountSessions']()
    const ownedSessionCount = [...this['accountSessions'].values()].filter(
      (session) => session.extensionId === principal.extensionId
    ).length
    if (ownedSessionCount >= this['maxAccountSessionsPerExtension']) {
      throw new Error('extension account-session limit reached')
    }
    const input = CreateAccountSessionRequestSchema.parse(params)
    const providerId = this['resolveProviderId'](principal, input.providerId)
    const expanded = this['expandPrincipalForProviderId'](principal, providerId)
    const provider = await this['options'].providerAccounts.requireOwnedProvider(expanded, providerId)
    if (
      provider.authenticationProviderId &&
      provider.authenticationProviderId !== input.authenticationProviderId
    ) throw new Error('authentication contribution does not match the selected provider')
    const effectiveScopes = effectiveAuthenticationScopes(
      provider.authenticationScopes ?? [],
      input.scopes
    )
    const label = input.label ?? provider.displayName
    const id = `accountsession_${randomUUID()}`
    const now = this['now']().getTime()
    let session: StoredAccountSession
    if (provider.oauthPkce) {
      const pending = await this['options'].accounts.beginPkceAuthorization({
        principal: expanded,
        providerId: provider.id,
        label,
        scopes: effectiveScopes,
        headless: true
      })
      session = {
        id, extensionId: principal.extensionId,
        workspaceRoots: normalizedRegistrationWorkspaceRoots(principal.workspaceRoots),
        lastTouchedAt: now,
        transactionId: pending.transactionId,
        providerId: provider.id, kind: 'oauth-pkce',
        status: 'pending', verificationUrl: pending.authorizationUrl,
        expiresAt: pending.expiresAt,
        message: 'Complete authorization in the protected Kun account window.'
      }
    } else if (provider.oauthDevice) {
      const pending = await this['options'].accounts.beginDeviceAuthorization({
        principal: expanded,
        providerId: provider.id,
        label,
        scopes: effectiveScopes
      })
      session = {
        id, extensionId: principal.extensionId,
        workspaceRoots: normalizedRegistrationWorkspaceRoots(principal.workspaceRoots),
        lastTouchedAt: now,
        transactionId: pending.transactionId,
        providerId: provider.id, kind: 'oauth-device',
        status: 'pending', verificationUrl: pending.verificationUri, userCode: pending.userCode,
        expiresAt: pending.expiresAt,
        message: 'Complete device authorization, then return to Kun.'
      }
    } else {
      session = {
        id, extensionId: principal.extensionId,
        workspaceRoots: normalizedRegistrationWorkspaceRoots(principal.workspaceRoots),
        lastTouchedAt: now,
        providerId: provider.id, kind: 'api-key', status: 'pending',
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
        message: 'API keys must be entered in the protected Kun account window.'
      }
    }
    this['accountSessions'].set(id, session)
    if (session.kind === 'oauth-device' && session.transactionId) {
      void this['options'].accounts.completeDeviceAuthorization({
        principal: expanded,
        transactionId: session.transactionId
      }).then(async (account) => {
        if (this['accountSessions'].get(id) !== session || session.status !== 'pending') return
        session.status = 'completed'
        session.lastTouchedAt = this['now']().getTime()
        session.account = publicAccount(account, await this['publicCredentialProtection']())
        session.message = 'Account connected.'
      }).catch((error) => {
        if (this['accountSessions'].get(id) !== session || session.status !== 'pending') return
        session.status = 'failed'
        session.lastTouchedAt = this['now']().getTime()
        session.message = boundedError(error)
      })
    }
    return publicAccountSession(session, exposeInteractiveMaterial)
  },

async publicCredentialProtection(this: ExtensionHostBroker): Promise<Account['protection']> {
    const protection = await this['options'].credentials.protection()
    return protection.mode === 'primary'
      ? 'system'
      : protection.mode === 'encrypted-fallback' ? 'encrypted-fallback' : 'unavailable'
  },

getAccountSession(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    exposeInteractiveMaterial: boolean
  ): AccountSession {
    this['pruneAccountSessions']()
    const { sessionId } = z.strictObject({ sessionId: z.string().min(1).max(256) }).parse(params)
    const session = this['accountSessions'].get(sessionId)
    if (!session || session.extensionId !== principal.extensionId) throw new Error('account session not found')
    if (session.expiresAt && Date.parse(session.expiresAt) <= this['now']().getTime() && session.status === 'pending') {
      session.status = 'expired'
    }
    session.lastTouchedAt = this['now']().getTime()
    return publicAccountSession(session, exposeInteractiveMaterial)
  },

cancelAccountSession(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const { sessionId } = z.strictObject({ sessionId: z.string().min(1).max(256) }).parse(params)
    const session = this['accountSessions'].get(sessionId)
    if (!session || session.extensionId !== principal.extensionId) return null
    const cancelled = session.transactionId
      ? this['options'].accounts.cancelAuthorization(principal, session.transactionId)
      : session.kind === 'api-key'
    if (cancelled) {
      session.status = 'cancelled'
      session.lastTouchedAt = this['now']().getTime()
      session.message = 'Account authorization cancelled.'
    } else if (session.status === 'pending') {
      session.message = 'Authorization is already completing and can no longer be cancelled.'
    }
    return null
  },

pruneAccountSessions(this: ExtensionHostBroker): void {
    const now = this['now']().getTime()
    for (const [id, session] of this['accountSessions']) {
      if (
        session.status === 'pending' &&
        session.expiresAt &&
        Date.parse(session.expiresAt) <= now
      ) {
        if (session.transactionId) {
          this['options'].accounts.cancelAuthorization(
            this['principalWithProviderPermissions'](session.extensionId, [], session.providerId ?? ''),
            session.transactionId
          )
        }
        session.status = 'expired'
        session.lastTouchedAt = now
      }
      if (
        session.status !== 'pending' &&
        now - session.lastTouchedAt >= this['accountSessionRetentionMs']
      ) this['accountSessions'].delete(id)
    }
  },

async deleteAccount(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue) {
    const { accountId } = z.strictObject({ accountId: z.string().min(1).max(256) }).parse(params)
    const account = await this['options'].providerAccounts.getAccount(accountId)
    if (!account || account.ownerExtensionId !== principal.extensionId) return null
    await this['options'].accounts.deleteAccount(
      this['expandPrincipalForProviderId'](principal, account.providerId),
      accountId
    )
    for (const [sessionId, session] of this['accountSessions']) {
      if (session.extensionId === principal.extensionId && session.account?.id === accountId) {
        this['accountSessions'].delete(sessionId)
      }
    }
    return null
  },

async authenticatedFetch(this: ExtensionHostBroker, principal: ExtensionPrincipal, params: JsonValue, signal: AbortSignal) {
    const input = AuthenticatedFetchRequestSchema.parse(params)
    const account = await this['options'].providerAccounts.getAccount(input.accountId)
    if (!account || account.ownerExtensionId !== principal.extensionId) throw new Error('account not found')
    const response = await this['options'].accounts.authenticatedFetch({
      principal: this['expandPrincipalForProviderId'](principal, account.providerId),
      accountId: input.accountId,
      url: input.url,
      init: {
        method: input.method,
        headers: input.headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
        signal: input.timeoutMs
          ? AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)])
          : signal
      }
    })
    return responseProjection(response)
  },

async revealSecret(this: ExtensionHostBroker,
    principal: ExtensionPrincipal,
    params: JsonValue,
    signal: AbortSignal,
    nodeHost: boolean
  ) {
    const input = RevealSecretRequestSchema.parse(params)
    const account = await this['options'].providerAccounts.getAccount(input.accountId)
    if (!account || account.ownerExtensionId !== principal.extensionId) throw new Error('account not found')
    const expanded = this['expandPrincipalForProviderId'](principal, account.providerId)
    if (!nodeHost) throw new Error('Raw account secret access is available only to the Node Extension Host')
    const permission = `accounts.secrets.read:${account.providerId}`
    if (!expanded.permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`)
    const allowed = await this['options'].authorizeSecretReveal?.({
      principal: expanded,
      accountId: input.accountId,
      operation: input.operation,
      signal
    }) ?? false
    const value = await this['options'].accounts.revealSecret({
      principal: expanded,
      accountId: input.accountId,
      nodeHost,
      protectedConsent: allowed,
      operation: input.operation
    })
    const secret = value.apiKey ?? value.accessToken
    if (!secret) throw new Error('account has no revealable primary secret')
    return { secret }
  },
}
