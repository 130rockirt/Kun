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
import { RegistrationIdSchema, RegistrationRequestSchema, RunIdSchema, ThreadIdSchema, SubscriptionIdSchema, StorageRequestSchema, StorageKeysRequestSchema, StorageSetRequestSchema, ConfigurationSectionSchema, ConfigurationRequestSchema, ConfigurationUpdateRequestSchema, CommandRegisterSchema, CommandExecuteSchema, ModelStreamNotificationSchema, ModelStreamEnvelopePayloadSchema, DEFAULT_PROVIDER_STREAM_QUEUE_EVENTS, DEFAULT_PROVIDER_STREAM_QUEUE_BYTES, type ExtensionHostBrokerOptions, type ToolRegistration, type ProviderRegistration, type AgentSubscription, type JobSubscription, type CommandRegistration, type StoredAccountSession, type ExtensionBrokerDispatchRequest, type ProviderStreamEntry, requiredExtensionBrokerPermission, publicMediaMetadata, cacheFormat, publicMediaCapability, jobCaller, hostOwnsRegistration, registrationOwnedByPrincipal, normalizedRegistrationWorkspaceRoots, registrationIncludesWorkspace, sameRegistrationWorkspace, hostPrincipal, publicAgentRun, publicAgentEvent, publicOwnedThread, publicBudget, publicUsage, publicRunState, publicAccount, publicAccountSession, providerStreamKey, providerQueueLimitError, positiveQueueLimit, toJson, isObject, AsyncEventQueue } from './extension-host-broker-core.js'

export function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Account authorization failed').slice(0, 4_096)
}

export function providerCapabilities(declaration: z.infer<typeof ModelProviderDeclarationSchema>) {
  const models = declaration.models
  return {
    streaming: models.length === 0 || models.some((model) => model.capabilities.streaming),
    toolCalls: models.some((model) => model.capabilities.tools),
    reasoning: models.some((model) => model.capabilities.reasoning),
    images: models.some((model) => model.capabilities.input.includes('image')),
    documents: models.some((model) => model.capabilities.input.includes('file')),
    tokenCounting: false
  }
}

export function resolveAuthentication(
  manifest: ExtensionManifest | undefined,
  localId: string | undefined
): AuthenticationProviderDeclaration | undefined {
  if (!localId) return undefined
  const declaration = manifest?.contributes.authentication.find((entry) => entry.id === localId)
  if (!declaration) throw new Error(`authentication contribution is not declared: ${localId}`)
  return declaration
}

export function effectiveAuthenticationScopes(
  declared: readonly string[],
  requested: readonly string[] | undefined
): string[] {
  const effective = [...new Set(requested ?? declared)]
  if (effective.some((scope) => !declared.includes(scope))) {
    throw new Error('requested authentication scope is not declared by the provider')
  }
  return effective
}

export function internalAuthenticationType(type: AuthenticationProviderDeclaration['type'] | undefined) {
  if (type === 'oauth2-pkce') return 'oauth-pkce' as const
  if (type === 'device-code') return 'oauth-device' as const
  return 'api-key' as const
}

export function toolSideEffect(value: z.infer<typeof ExtensionToolDeclarationSchema>['sideEffects']) {
  switch (value) {
    case 'read': return 'workspace-read' as const
    case 'write': return 'workspace-write' as const
    case 'external':
    case 'destructive': return 'external' as const
    default: return 'none' as const
  }
}

export function activationEventFor(manifest: ExtensionManifest | undefined, preferred: string): string {
  const events = manifest?.activationEvents ?? []
  if (events.includes(preferred)) return preferred
  if (events.includes('onStartup')) return 'onStartup'
  throw new Error(`extension has no declared activation event for ${preferred}`)
}

export function requireManifestContribution<T extends { id: string }>(
  entries: readonly T[] | undefined,
  id: string,
  kind: string
): T {
  const entry = entries?.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`${kind} is not declared in the active manifest: ${id}`)
  return structuredClone(entry)
}

export function assertManifestDeclarationMatches(
  requested: unknown,
  declared: unknown,
  kind: string
): void {
  if (JSON.stringify(canonicalizeJson(requested)) !== JSON.stringify(canonicalizeJson(declared))) {
    throw new Error(`${kind} registration does not match its active manifest declaration`)
  }
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeJson(child)])
  )
}

export function expandProviderPermissions(
  principal: ExtensionPrincipal,
  localId: string,
  providerId: string
): ExtensionPrincipal {
  const permissions = new Set(principal.permissions)
  for (const operation of ['use', 'manage'] as const) {
    if (permissions.has(`accounts.${operation}:${localId}`)) {
      permissions.add(`accounts.${operation}:${providerId}`)
    }
  }
  if (permissions.has(`accounts.secrets.read:${localId}`)) {
    permissions.add(`accounts.secrets.read:${providerId}`)
  }
  return { ...principal, permissions: [...permissions] }
}

export function requiredWorkspaceKey(principal: ExtensionPrincipal): string {
  const root = principal.workspaceRoots[0]
  if (!root) throw new Error('workspace-scoped operation requires an active granted workspace')
  // Matches ExtensionPaths.workspaceKey without coupling persisted state to a path.
  return createHash('sha256').update(resolve(root)).digest('hex')
}

export function viewStateKey(principal: ExtensionPrincipal): string {
  return `__kun_view_state__:${principal.viewContributionId ?? 'default'}`
}

export async function confinedWorkspacePath(
  principal: ExtensionPrincipal,
  requested: string,
  forWrite: boolean
): Promise<string> {
  if (isAbsolute(requested)) {
    for (const root of principal.workspaceRoots) {
      if (inside(root, requested)) return verifyWorkspaceTarget(root, requested, forWrite)
    }
    throw new Error('workspace path is outside granted roots')
  }
  const root = principal.workspaceRoots[0]
  if (!root) throw new Error('workspace path requires a granted root')
  return verifyWorkspaceTarget(root, resolve(root, requested), forWrite)
}

export async function verifyWorkspaceTarget(rootInput: string, targetInput: string, forWrite: boolean): Promise<string> {
  const root = await realpath(rootInput)
  const target = resolve(targetInput)
  if (!inside(root, target)) throw new Error('workspace path escapes the granted root')
  if (!forWrite) {
    const resolved = await realpath(target)
    if (!inside(root, resolved)) throw new Error('workspace symlink escapes the granted root')
    return resolved
  }
  const parent = await realpath(resolve(target, '..'))
  if (!inside(root, parent)) throw new Error('workspace write parent escapes the granted root')
  const existing = await realpath(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  })
  if (existing && !inside(root, existing)) throw new Error('workspace write symlink escapes the granted root')
  return target
}

export function inside(rootInput: string, targetInput: string): boolean {
  const root = resolve(rootInput)
  const target = resolve(targetInput)
  const child = relative(root, target)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

export function assertNetworkPermission(principal: ExtensionPrincipal, hostnameInput: string): void {
  const hostname = hostnameInput.toLowerCase()
  const allowed = principal.permissions.some((permission) => {
    if (!permission.startsWith('network:')) return false
    const pattern = permission.slice('network:'.length).toLowerCase()
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return hostname.endsWith(suffix) && hostname !== pattern.slice(2)
    }
    return hostname === pattern
  })
  if (!allowed) throw new Error(`Missing network permission for ${hostname}`)
}

export async function responseProjection(response: Response) {
  const maximum = 8 * 1024 * 1024
  const { content, truncated } = await readBoundedResponseBody(response, maximum)
  const contentType = response.headers.get('content-type') ?? ''
  const text = /^text\/|json|xml|javascript/i.test(contentType)
  const headers = new Headers(response.headers)
  for (const name of [
    'authorization', 'proxy-authorization', 'proxy-authenticate',
    'cookie', 'set-cookie', 'x-api-key'
  ]) headers.delete(name)
  return {
    status: response.status,
    headers: Object.fromEntries(headers.entries()),
    body: text ? content.toString('utf8') : content.toString('base64'),
    bodyEncoding: text ? 'utf8' : 'base64',
    truncated
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maximum: number
): Promise<{ content: Buffer; truncated: boolean }> {
  if (!response.body) return { content: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let retained = 0
  let truncated = false
  try {
    while (retained <= maximum) {
      const next = await reader.read()
      if (next.done) break
      const value = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      const remaining = maximum - retained
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        retained = maximum
        truncated = true
        break
      }
      chunks.push(value)
      retained += value.byteLength
      if (retained === maximum) {
        const probe = await reader.read()
        if (!probe.done) truncated = true
        break
      }
    }
  } finally {
    if (truncated) await reader.cancel('Kun response limit reached').catch(() => undefined)
    reader.releaseLock()
  }
  return { content: Buffer.concat(chunks, retained), truncated }
}

export function linkedAbortController(signal: AbortSignal, timeoutMs?: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs) : undefined
  timer?.unref?.()
  return Object.assign(controller, {
    dispose() {
      signal.removeEventListener('abort', abort)
      if (timer) clearTimeout(timer)
    }
  })
}

export function agentInputText(input: z.infer<typeof AgentCreateRunRequestSchema>['input']): string {
  if (typeof input === 'string') return input
  return input.content.map((part) => {
    if (part.type === 'text') return part.text
    return `[${part.type}${'name' in part && part.name ? `: ${part.name}` : ''}; ${part.mimeType}]`
  }).join('\n')
}

export function cancellationSignal(token: { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else token.onCancellationRequested(() => controller.abort())
  return controller.signal
}

export function serializedQueueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function safeJsonObject(value: unknown): Record<string, PublicJsonValue> {
  const parsed = toPublicJson(value)
  return isObject(parsed) ? parsed as Record<string, PublicJsonValue> : { value: parsed }
}

export function toPublicJson(value: unknown): PublicJsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value ?? null)))
}
