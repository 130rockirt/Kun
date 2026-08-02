import { z, type ZodType } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  ApprovalDecisionResponse,
  AttachmentReleaseResponse,
  AttachmentUploadRequest,
  AttachmentUploadResponse,
  BackgroundShellListResponse,
  BackgroundShellRecord,
  BackgroundShellStopResponse,
  ClearThreadGoalResponse,
  ClearThreadTodosResponse,
  CompactResponse,
  ClaudeSdkInstallStatusSchema,
  CreateThreadRequest,
  DeleteThreadResponse,
  ForkThreadRequest,
  GraphRunStatusSchema,
  GraphRunV1Schema,
  ListThreadsResponse,
  ModelConnectionConnectRequestSchema,
  ModelConnectionCliAuthRequestSchema,
  ModelConnectionCredentialRequestSchema,
  ModelConnectionOAuthStartRequestSchema,
  ModelConnectionOAuthStatusSchema,
  ModelConnectionOAuthSubmitRequestSchema,
  ModelConnectionPatchRequestSchema,
  ModelConnectionSelectRequestSchema,
  ModelConnectionSnapshotSchema,
  McpServerConfig,
  MemoryCreateRequest,
  MemoryRecord,
  MemoryUpdateRequest,
  RuntimeInfoResponse,
  RuntimeConfigApplyRequest,
  RuntimeConfigApplyResponse,
  ReplaceSteeringRequest,
  SetThreadGoalRequest,
  SetThreadTodosRequest,
  StartTurnRequest,
  StartTurnResponse,
  SteeringQueueResponse,
  ThreadGoalResponse,
  ThreadSchema,
  ThreadTodosResponse,
  ThreadUsageResponseSchema,
  ProviderQuotaListResponseSchema,
  UpdateThreadRequest,
  UserInputAnswerSchema,
  type ApprovalDecisionRequest,
  type CreateThreadRequest as CreateThreadRequestValue,
  type RuntimeEvent as RuntimeEventValue,
  type StartTurnRequest as StartTurnRequestValue,
  type ThreadRecord,
  type ThreadSummary
} from '../contracts/index.js'
import { createApprovalConsentToken, KUN_APPROVAL_CONSENT_HEADER } from '../server/approval-consent.js'
import { isLoopbackHost } from '../server/loopback-host.js'
import { readRuntimeDiscovery, type RuntimeDiscoveryRecord } from '../server/runtime-discovery.js'
import { ensureSharedRuntime, runtimeDiscoveryDirectory } from '../cli/shared-runtime.js'
import {
  allowsDevelopmentManagerBootstrap,
  runtimeBuildIdForFlavor
} from '../cli/runtime-flavor.js'
import { readRuntimeBuildIdForEntry } from '../server/runtime-build-identity.js'
import type { TuiOptions } from './options.js'
import { defaultKunControlDir } from '../manager/manager-discovery.js'
import { ensureServiceManager } from '../manager/manager-client.js'
import { IncrementalSseParser, parseRuntimeEventFrame } from './sse.js'

const ThreadDetailResponse = ThreadSchema.extend({
  latestSeq: z.number().int().nonnegative().default(0),
  pendingUserInputIds: z.array(z.string()).default([]),
  // Omitted by older servers. Keep omission distinct from an authoritative
  // empty gate so clients do not hide legacy pending approval records.
  pendingApprovalIds: z.array(z.string()).optional()
})

const UserInputResolutionResponse = z.object({
  inputId: z.string().min(1),
  status: z.enum(['submitted', 'cancelled']),
  answers: z.array(z.unknown()).optional()
})

const RuntimeToolsResponse = z.object({
  providers: z.array(z.object({
    id: z.string(), kind: z.string(), enabled: z.boolean(), available: z.boolean(),
    reason: z.string().optional()
  }).passthrough()).default([]),
  mcpServers: z.array(z.object({
    id: z.string(),
    enabled: z.boolean(),
    transport: z.string(),
    trustScope: z.string(),
    available: z.boolean(),
    status: z.enum(['disabled', 'connected', 'reconnecting', 'error', 'authorization_required']),
    toolCount: z.number().int().nonnegative(),
    toolNames: z.array(z.string()).default([]),
    lastError: z.string().optional()
  }).passthrough()).default([]),
  extensions: z.object({
    jobs: z.object({
      activeCount: z.number().int().nonnegative(),
      subscriptionCount: z.number().int().nonnegative(),
      recent: z.array(z.object({
        jobId: z.string(),
        ownerExtensionId: z.string(),
        kind: z.string(),
        state: z.string(),
        executionAttempt: z.number().int().nonnegative(),
        action: z.string(),
        code: z.string().optional()
      }).passthrough()).default([])
    }).optional()
  }).passthrough().optional()
}).passthrough()

const SkillsResponse = z.object({
  enabled: z.boolean(),
  roots: z.array(z.string()),
  skills: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string().optional(), version: z.string(),
    root: z.string(), source: z.enum(['project', 'global']), legacy: z.boolean(),
    allowedTools: z.array(z.string()).default([])
  }).passthrough()),
  validationErrors: z.array(z.object({ root: z.string(), message: z.string() }))
})

const DelegationDiagnosticsResponse = z.object({
  enabled: z.boolean(),
  active: z.number().int().nonnegative(),
  childRuns: z.array(z.object({
    id: z.string(), parentThreadId: z.string(), parentTurnId: z.string(),
    label: z.string().optional(), prompt: z.string(), profile: z.string().optional(),
    profileSnapshot: z.object({ name: z.string().optional() }).passthrough().optional(),
    model: z.string().optional(), providerId: z.string().optional(),
    reasoningEffort: z.string().optional(), toolPolicy: z.enum(['readOnly', 'inherit']).optional(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
    summary: z.string().optional(), error: z.string().optional(), detached: z.boolean().optional(),
    usage: z.object({
      promptTokens: z.number().int().nonnegative().default(0),
      completionTokens: z.number().int().nonnegative().default(0),
      totalTokens: z.number().int().nonnegative().default(0),
      cacheHitRate: z.number().min(0).max(1).nullable().optional(),
      costUsd: z.number().nonnegative().optional(),
      costCny: z.number().nonnegative().optional()
    }).passthrough().default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    prefixReused: z.boolean().optional(),
    inheritedHistoryItems: z.number().int().nonnegative().optional(),
    toolInvocations: z.number().int().nonnegative().optional(),
    activity: z.object({
      phase: z.enum(['starting', 'thinking', 'responding', 'tool', 'retrying', 'compacting', 'waiting']),
      label: z.string(),
      toolName: z.string().optional(),
      startedAt: z.string(),
      updatedAt: z.string()
    }).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    queuedMs: z.number().int().nonnegative().optional(),
    childSeq: z.number().int().nonnegative().optional(),
    createdAt: z.string(), startedAt: z.string().optional(), updatedAt: z.string()
  }).passthrough()),
  aggregates: z.array(z.object({
    key: z.string(),
    label: z.string().optional(),
    model: z.string().optional(),
    runs: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    aborted: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    costCny: z.number().nonnegative().optional(),
    averageTotalTokens: z.number().nonnegative(),
    averageCostUsd: z.number().nonnegative().optional(),
    averageCostCny: z.number().nonnegative().optional()
  }).passthrough()).default([])
})

const MemoryListResponse = z.object({
  memories: z.array(MemoryRecord)
})

const MemoryResponse = z.object({
  memory: MemoryRecord
})

const DelegationAbortResponse = z.object({
  childId: z.string().min(1),
  aborted: z.boolean()
})

const DelegationDetachResponse = z.object({
  childId: z.string().min(1),
  detached: z.boolean()
})

const McpOAuthServer = z.object({
  serverId: z.string().min(1),
  enabled: z.boolean(),
  configured: z.boolean(),
  transport: z.string(),
  url: z.string().optional(),
  status: z.enum(['disabled', 'empty', 'partial', 'authorized', 'expired', 'error']),
  hasClientInformation: z.boolean(),
  hasTokens: z.boolean(),
  hasRefreshToken: z.boolean(),
  hasCodeVerifier: z.boolean(),
  hasDiscoveryState: z.boolean(),
  grantedScopes: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional()
}).passthrough()

const McpOAuthDiagnosticsResponse = z.object({ servers: z.array(McpOAuthServer) })
const McpOAuthAuthorizeResponse = z.object({
  serverId: z.string(),
  status: z.enum(['disabled', 'empty', 'partial', 'authorized', 'expired', 'error']),
  authorized: z.boolean()
})
const McpOAuthClearResponse = z.object({ cleared: z.array(z.string()) })
const McpConfigResponse = z.object({
  enabled: z.boolean(),
  servers: z.array(z.object({
    id: z.string(),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'streamable-http', 'sse']),
    target: z.string(),
    trustScope: z.enum(['user', 'workspace']),
    oauth: z.boolean(),
    timeoutMs: z.number().int().positive()
  }))
})

const ExtensionVersion = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  requestedPermissions: z.array(z.string()).default([]),
  grantedPermissions: z.array(z.string()).default([])
}).passthrough()

const ExtensionEntry = z.object({
  id: z.string(),
  selectedVersion: z.string().optional(),
  globallyEnabled: z.boolean(),
  effectiveEnabled: z.boolean().optional(),
  versions: z.array(ExtensionVersion).default([]),
  development: ExtensionVersion.optional()
}).passthrough()

const ExtensionListResponse = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  extensions: z.array(ExtensionEntry),
  nextCursor: z.string().optional()
})

const ExtensionChangedResponse = z.object({
  schemaVersion: z.literal(1),
  extension: ExtensionEntry
})

const ExtensionVersionMutationResponse = z.object({
  schemaVersion: z.literal(1),
  extension: ExtensionVersion
}).passthrough()

const ExtensionInspectionResponse = z.object({
  schemaVersion: z.literal(1),
  inspection: z.object({
    manifest: z.object({
      publisher: z.string(),
      name: z.string(),
      version: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      permissions: z.array(z.string()).default([])
    }).passthrough(),
  }).passthrough()
})

const ExtensionDiagnosticResponse = z.object({
  schemaVersion: z.literal(1),
  diagnostic: z.object({
    extensionId: z.string(),
    state: z.string().optional(),
    lastError: z.string().optional()
  }).passthrough()
}).passthrough()

const ExtensionJob = z.object({
  id: z.string(),
  kind: z.string(),
  ownerExtensionId: z.string(),
  state: z.string(),
  executionAttempt: z.number().int().nonnegative(),
  initiatingOperation: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.object({
    message: z.string().optional(),
    completed: z.number().optional(),
    total: z.number().optional()
  }).passthrough().optional(),
  error: z.object({ message: z.string() }).passthrough().optional()
}).passthrough()

const ExtensionJobsResponse = z.object({
  schemaVersion: z.literal(1),
  jobs: z.array(ExtensionJob)
})

const ExtensionJobCancelResponse = z.object({
  schemaVersion: z.literal(1),
  accepted: z.boolean(),
  job: ExtensionJob
})

const GraphAvailabilityResponse = z.object({
  enabled: z.boolean()
}).passthrough()

const GraphRunSummary = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  status: GraphRunStatusSchema,
  currentRevision: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  title: z.string(),
  goal: z.string(),
  nodeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string()
})

const GraphRunsResponse = z.object({
  runs: z.array(GraphRunSummary),
  nextCursor: z.string().optional()
})

// The Graph detail route can include additive public projections such as
// supervision state. Keep the durable Graph contract strict while allowing
// clients to consume newer runtime projections without rejecting the run.
const PublicGraphRunResponse = GraphRunV1Schema.passthrough()

export type ThreadDetail = z.infer<typeof ThreadDetailResponse>
export type UserInputAnswer = z.infer<typeof UserInputAnswerSchema>
export type RuntimeTools = z.infer<typeof RuntimeToolsResponse>
export type SkillsSnapshot = z.infer<typeof SkillsResponse>
export type DelegationDiagnostics = z.infer<typeof DelegationDiagnosticsResponse>
export type McpOAuthSnapshot = z.infer<typeof McpOAuthDiagnosticsResponse>
export type ExtensionSnapshot = z.infer<typeof ExtensionListResponse>

export type TuiConnection = {
  baseUrl: string
  runtimeToken: string
  runtimeInfo: z.infer<typeof RuntimeInfoResponse>
  discovered: boolean
  /** Verified pre-discovery GUI runtime with no shared model-connection API. */
  legacyGui?: boolean
}

/**
 * Model connection operations can be provided by the shared runtime HTTP API
 * or, during a rolling upgrade, by the local compatibility coordinator that
 * writes the same protected registry and hot-applies the verified legacy
 * runtime. Thread/session operations always remain HTTP/SSE runtime calls.
 */
export type ModelConnectionTransport = {
  modelConnections(): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  subscribeModelConnections(input: {
    sinceRevision: number
    signal: AbortSignal
    onSnapshot: (snapshot: z.infer<typeof ModelConnectionSnapshotSchema>) => void | Promise<void>
    onError?: (error: Error) => void
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  }): Promise<void>
  connectModel(input: z.input<typeof ModelConnectionConnectRequestSchema>): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  patchModel(providerId: string, input: z.input<typeof ModelConnectionPatchRequestSchema>): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  replaceModelCredential(providerId: string, input: z.input<typeof ModelConnectionCredentialRequestSchema>): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  deleteModel(providerId: string, expectedRevision: number): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  probeModel(providerId: string): Promise<{ ok: true; models: string[] }>
  selectModel(input: z.input<typeof ModelConnectionSelectRequestSchema>): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  completeModelCliAuth(input: z.input<typeof ModelConnectionCliAuthRequestSchema>): Promise<z.infer<typeof ModelConnectionSnapshotSchema>>
  startModelOAuth(input: z.input<typeof ModelConnectionOAuthStartRequestSchema>): Promise<z.infer<typeof ModelConnectionOAuthStatusSchema>>
  modelOAuthStatus(sessionId: string): Promise<z.infer<typeof ModelConnectionOAuthStatusSchema>>
  submitModelOAuth(sessionId: string, code: string): Promise<z.infer<typeof ModelConnectionOAuthStatusSchema>>
  cancelModelOAuth(sessionId: string): Promise<z.infer<typeof ModelConnectionOAuthStatusSchema>>
  claudeSdkStatus(): Promise<z.infer<typeof ClaudeSdkInstallStatusSchema>>
  installClaudeSdk(): Promise<z.infer<typeof ClaudeSdkInstallStatusSchema>>
  close?(): Promise<void> | void
}

export class TuiClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly path?: string
  ) {
    super(message)
    this.name = 'TuiClientError'
  }
}

export async function resolveTuiConnection(
  options: TuiOptions,
  fetchImpl: typeof fetch = fetch,
  deps?: {
    expectedBuildId?: string
    ensureRuntime?: typeof ensureSharedRuntime
  }
): Promise<TuiConnection> {
  if (options.url) {
    return validateConnection({
      baseUrl: options.url,
      runtimeToken: options.runtimeToken,
      discovered: false
    }, fetchImpl)
  }

  const runtimeFlavor = options.runtimeFlavor ?? 'production'
  const sourceBuildId = deps?.expectedBuildId ?? await readRuntimeBuildIdForEntry(import.meta.url)
  const expectedBuildId = runtimeBuildIdForFlavor(
    sourceBuildId,
    runtimeFlavor
  )
  const ensureRuntime = deps?.ensureRuntime ?? ensureSharedRuntime
  const controlDir = process.env.KUN_MANAGER_CONTROL_DIR?.trim() || defaultKunControlDir()
  const managerSettingsPath = process.env.KUN_MANAGER_SETTINGS_PATH?.trim()
  const startExpectedRuntime = async (): Promise<TuiConnection> => {
    const manager = deps?.ensureRuntime
      ? undefined
      : await ensureServiceManager({
          flavor: runtimeFlavor,
          allowDevelopmentBootstrap: allowsDevelopmentManagerBootstrap({
            flavor: runtimeFlavor,
            env: process.env
          }),
          controlDir,
          dataDir: options.dataDir,
          ...(managerSettingsPath ? { settingsPath: managerSettingsPath } : {}),
          fetch: fetchImpl
        })
    const started = await ensureRuntime({
      dataDir: options.dataDir,
      fetch: fetchImpl,
      runtimeFlavor,
      controlDir,
      ...(manager ? { manager } : {}),
      ...(sourceBuildId ? { expectedBuildId: sourceBuildId } : {})
    })
    return {
      baseUrl: started.discovery.baseUrl,
      runtimeToken: started.discovery.runtimeToken,
      runtimeInfo: started.info,
      discovered: true
    }
  }
  const discoveryDir = runtimeDiscoveryDirectory(options.dataDir, runtimeFlavor, controlDir)
  const discovery = await readRuntimeDiscovery(discoveryDir, runtimeFlavor).catch(() => null)
  if (discovery) {
    assertSafeDiscovery(discovery)
    try {
      const connection = await validateConnection({
        baseUrl: discovery.baseUrl.replace(/\/$/, ''),
        runtimeToken: options.runtimeToken || discovery.runtimeToken,
        discovered: true,
        discovery
      }, fetchImpl)
      const buildMatches = !expectedBuildId || (
        discovery.buildId === expectedBuildId &&
        connection.runtimeInfo.buildId === expectedBuildId
      )
      if (buildMatches) return connection
      if (options.noStart) {
        throw new TuiClientError(
          'Kun runtime discovery belongs to an older application build; remove --no-start so this TUI can replace it.',
          undefined,
          'runtime_build_mismatch'
        )
      }
      return startExpectedRuntime()
    } catch (error) {
      if (!options.noStart) {
        return startExpectedRuntime()
      }
      if (error instanceof TuiClientError && error.code === 'runtime_build_mismatch') {
        throw error
      }
      throw new TuiClientError(
        `Kun runtime discovery is stale or unavailable in ${options.dataDir}. Run \`kun runtime restart\`, or remove --no-start so this client can start the shared runtime.`,
        error instanceof TuiClientError ? error.status : undefined,
        'stale_runtime_discovery'
      )
    }
  }
  if (options.noStart) {
    throw new TuiClientError(
      `No reachable Kun runtime was found in ${options.dataDir}; remove --no-start or run kun serve.`,
      undefined,
      'runtime_unavailable'
    )
  }
  return startExpectedRuntime()
}

async function validateConnection(
  input: {
    baseUrl: string
    runtimeToken: string
    discovered: boolean
    discovery?: RuntimeDiscoveryRecord
  },
  fetchImpl: typeof fetch
): Promise<TuiConnection> {
  const client = new KunTuiClient({
    baseUrl: input.baseUrl,
    runtimeToken: input.runtimeToken,
    fetch: fetchImpl
  })
  const runtimeInfo = await client.runtimeInfo()
  if (input.discovery) {
    if (runtimeInfo.pid !== undefined && runtimeInfo.pid !== input.discovery.pid) {
      throw new TuiClientError('discovered runtime process does not match the live server')
    }
    if (runtimeInfo.startedAt !== input.discovery.startedAt) {
      throw new TuiClientError('discovered runtime start time does not match the live server')
    }
    if (runtimeInfo.instanceId !== input.discovery.instanceId) {
      throw new TuiClientError('discovered runtime instance does not match the live server')
    }
  }
  return {
    baseUrl: input.baseUrl,
    runtimeToken: input.runtimeToken,
    runtimeInfo,
    discovered: input.discovered
  }
}

function assertSafeDiscovery(record: RuntimeDiscoveryRecord): void {
  let url: URL
  try {
    url = new URL(record.baseUrl)
  } catch {
    throw new TuiClientError('runtime discovery contains an invalid URL', undefined, 'unsafe_runtime_discovery')
  }
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new TuiClientError('runtime discovery must reference a loopback HTTP endpoint', undefined, 'unsafe_runtime_discovery')
  }
}

export class KunTuiClient {
  private endpoint: { baseUrl: string; runtimeToken: string }
  private readonly fetchImpl: typeof fetch
  private readonly modelConnectionTransport?: ModelConnectionTransport
  private readonly connectionResolver?: () => Promise<{ baseUrl: string; runtimeToken: string }>
  private connectionRefresh?: Promise<boolean>

  constructor(input: {
    baseUrl: string
    runtimeToken?: string
    fetch?: typeof fetch
    modelConnectionTransport?: ModelConnectionTransport
    resolveConnection?: () => Promise<{ baseUrl: string; runtimeToken: string }>
  }) {
    this.endpoint = {
      baseUrl: input.baseUrl.replace(/\/$/, ''),
      runtimeToken: input.runtimeToken ?? ''
    }
    this.fetchImpl = input.fetch ?? fetch
    this.modelConnectionTransport = input.modelConnectionTransport
    this.connectionResolver = input.resolveConnection
  }

  get baseUrl(): string { return this.endpoint.baseUrl }
  get runtimeToken(): string { return this.endpoint.runtimeToken }

  runtimeInfo() {
    return this.request('/v1/runtime/info', RuntimeInfoResponse)
  }

  applyRuntimeConfig(input: z.input<typeof RuntimeConfigApplyRequest>) {
    return this.request('/v1/runtime/config/apply', RuntimeConfigApplyResponse, {
      method: 'POST',
      body: RuntimeConfigApplyRequest.parse(input)
    })
  }

  runtimeTools() {
    return this.request('/v1/runtime/tools', RuntimeToolsResponse)
  }

  skills(workspace?: string) {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return this.request(`/v1/skills${query}`, SkillsResponse)
  }

  refreshSkills() {
    return this.request('/v1/skills/refresh', z.object({ refreshed: z.boolean(), message: z.string().optional() }), {
      method: 'POST'
    })
  }

  setSkillsEnabled(enabled: boolean) {
    return this.request('/v1/skills/config', z.object({ enabled: z.boolean() }), {
      method: 'PATCH',
      body: { enabled }
    })
  }

  setLocalCapabilityEnabled(id: 'attachments' | 'memory', enabled: boolean) {
    return this.request(`/v1/runtime/capabilities/${id}`, z.object({
      id: z.enum(['attachments', 'memory']),
      enabled: z.boolean()
    }), {
      method: 'PATCH',
      body: { enabled }
    })
  }

  delegationDiagnostics(parentThreadId?: string) {
    const query = parentThreadId ? `?parent_thread_id=${encodeURIComponent(parentThreadId)}` : ''
    return this.request(`/v1/delegation/diagnostics${query}`, DelegationDiagnosticsResponse)
  }

  backgroundShells(threadId?: string) {
    const query = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ''
    return this.request(`/v1/background-shells${query}`, BackgroundShellListResponse)
  }

  backgroundShell(sessionId: string) {
    return this.request(`/v1/background-shells/${segment(sessionId)}`, BackgroundShellRecord)
  }

  stopBackgroundShell(sessionId: string) {
    return this.request(`/v1/background-shells/${segment(sessionId)}/stop`, BackgroundShellStopResponse, {
      method: 'POST'
    })
  }

  abortDelegation(childId: string) {
    return this.request(`/v1/delegation/abort/${segment(childId)}`, DelegationAbortResponse, {
      method: 'POST'
    })
  }

  detachDelegation(childId: string) {
    return this.request(`/v1/delegation/detach/${segment(childId)}`, DelegationDetachResponse, {
      method: 'POST'
    })
  }

  uploadAttachment(input: z.input<typeof AttachmentUploadRequest>) {
    return this.request('/v1/attachments', AttachmentUploadResponse, {
      method: 'POST',
      body: AttachmentUploadRequest.parse(input)
    })
  }

  releaseAttachment(attachmentId: string, leaseId: string) {
    return this.request(`/v1/attachments/${segment(attachmentId)}`, AttachmentReleaseResponse, {
      method: 'DELETE',
      body: { leaseId }
    })
  }

  getAttachment(attachmentId: string) {
    return this.request(`/v1/attachments/${segment(attachmentId)}`, AttachmentUploadResponse)
  }

  listMemories(input: { workspace?: string; includeDeleted?: boolean; all?: boolean } = {}) {
    const query = new URLSearchParams()
    if (input.workspace) query.set('workspace', input.workspace)
    if (input.includeDeleted) query.set('include_deleted', 'true')
    if (input.all) query.set('all', 'true')
    return this.request(`/v1/memory${query.size ? `?${query}` : ''}`, MemoryListResponse)
  }

  createMemory(input: z.input<typeof MemoryCreateRequest>) {
    return this.request('/v1/memory', MemoryResponse, {
      method: 'POST',
      body: MemoryCreateRequest.parse(input)
    })
  }

  updateMemory(id: string, workspace: string | undefined, input: z.input<typeof MemoryUpdateRequest>) {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return this.request(`/v1/memory/${segment(id)}${query}`, MemoryResponse, {
      method: 'PATCH',
      body: MemoryUpdateRequest.parse(input)
    })
  }

  deleteMemory(id: string, workspace?: string) {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return this.request(`/v1/memory/${segment(id)}${query}`, MemoryResponse, { method: 'DELETE' })
  }

  mcpOAuth() {
    return this.request('/v1/mcp/oauth', McpOAuthDiagnosticsResponse)
  }

  authorizeMcp(serverId: string) {
    return this.request(`/v1/mcp/oauth/${segment(serverId)}`, McpOAuthAuthorizeResponse, { method: 'POST' })
  }

  clearMcpOAuth(serverId?: string) {
    return this.request(serverId ? `/v1/mcp/oauth/${segment(serverId)}` : '/v1/mcp/oauth', McpOAuthClearResponse, {
      method: 'DELETE'
    })
  }

  mcpConfig() {
    return this.request('/v1/mcp/config', McpConfigResponse)
  }

  putMcpServer(serverId: string, input: z.input<typeof McpServerConfig>) {
    return this.request(`/v1/mcp/config/${segment(serverId)}`, McpConfigResponse, {
      method: 'PUT',
      body: McpServerConfig.parse(input)
    })
  }

  deleteMcpServer(serverId: string) {
    return this.request(`/v1/mcp/config/${segment(serverId)}`, McpConfigResponse, { method: 'DELETE' })
  }

  setMcpServerEnabled(serverId: string, enabled: boolean) {
    return this.request(`/v1/mcp/config/${segment(serverId)}`, McpConfigResponse, {
      method: 'PATCH',
      body: { enabled }
    })
  }

  extensions(workspaceRoot?: string) {
    const query = workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : ''
    return this.request(`/v1/extensions${query}`, ExtensionListResponse)
  }

  inspectExtension(path: string) {
    return this.request('/v1/extensions/inspect', ExtensionInspectionResponse, {
      method: 'POST',
      body: { path }
    })
  }

  installExtension(input:
    | { source: 'archive' | 'development'; path: string; grantedPermissions: string[]; select?: boolean; enable?: boolean }
    | { source: 'index'; indexUrl: string; extensionId: string; version: string; grantedPermissions: string[]; select?: boolean; enable?: boolean }
  ) {
    return this.request('/v1/extensions/install', ExtensionVersionMutationResponse, {
      method: 'POST',
      body: { select: true, enable: true, ...input }
    })
  }

  selectExtensionVersion(id: string, version: string) {
    return this.request(`/v1/extensions/${segment(id)}/select`, ExtensionChangedResponse, {
      method: 'POST',
      body: { version }
    })
  }

  setExtensionEnabled(id: string, enabled: boolean, workspaceRoot?: string) {
    return this.request(`/v1/extensions/${segment(id)}/${enabled ? 'enable' : 'disable'}`, ExtensionChangedResponse, {
      method: 'POST',
      body: workspaceRoot ? { workspaceRoot } : {}
    })
  }

  setExtensionPermissions(id: string, workspaceRoot: string, expectedVersion: string, permissions: string[] | null) {
    return this.request(`/v1/extensions/${segment(id)}/permissions`, ExtensionChangedResponse, {
      method: 'PUT',
      body: { workspaceRoot, expectedVersion, permissions }
    })
  }

  rollbackExtension(id: string) {
    return this.request(`/v1/extensions/${segment(id)}/rollback`, ExtensionChangedResponse, { method: 'POST' })
  }

  reloadExtension(id: string) {
    return this.request(`/v1/extensions/${segment(id)}/reload`, ExtensionVersionMutationResponse, { method: 'POST' })
  }

  retryExtension(id: string) {
    return this.request(`/v1/extensions/${segment(id)}/retry`, ExtensionDiagnosticResponse, { method: 'POST' })
  }

  extensionJobs(limit = 100) {
    return this.request(`/v1/extensions/jobs?limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`, ExtensionJobsResponse)
  }

  cancelExtensionJob(jobId: string) {
    return this.request(`/v1/extensions/jobs/${segment(jobId)}/cancel`, ExtensionJobCancelResponse, {
      method: 'POST'
    })
  }

  uninstallExtension(id: string) {
    return this.request(`/v1/extensions/${segment(id)}`, z.object({
      schemaVersion: z.literal(1),
      removed: z.object({ extensionId: z.string() }),
      dataPreserved: z.boolean()
    }), { method: 'DELETE' })
  }

  modelConnections() {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.modelConnections()
    return this.request('/v1/model-connections', ModelConnectionSnapshotSchema)
  }

  async subscribeModelConnections(input: {
    sinceRevision: number
    signal: AbortSignal
    onSnapshot: (snapshot: z.infer<typeof ModelConnectionSnapshotSchema>) => void | Promise<void>
    onError?: (error: Error) => void
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  }): Promise<void> {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.subscribeModelConnections(input)
    let revision = Math.max(0, input.sinceRevision)
    let failures = 0
    const sleep = input.sleep ?? abortableDelay
    while (!input.signal.aborted) {
      try {
        await this.refreshConnection()
        const response = await this.fetchImpl(
          `${this.baseUrl}/v1/model-connections/events?since_revision=${revision}`,
          {
            headers: this.headers({ Accept: 'text/event-stream', 'Last-Event-ID': String(revision) }),
            signal: input.signal
          }
        )
        if (!response.ok || !response.body) {
          throw await responseError(response, '/v1/model-connections/events', this.runtimeToken)
        }
        failures = 0
        const parser = new IncrementalSseParser()
        const reader = response.body.getReader()
        const consume = async (frames: ReturnType<IncrementalSseParser['push']>): Promise<void> => {
          for (const frame of frames) {
            if (frame.event !== 'model_connections' || !frame.data.trim()) continue
            let body: unknown
            try { body = JSON.parse(frame.data) } catch { throw new Error('model connection stream returned invalid JSON') }
            const snapshot = ModelConnectionSnapshotSchema.parse(body)
            if (snapshot.revision <= revision) continue
            revision = snapshot.revision
            await input.onSnapshot(snapshot)
          }
        }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            await consume(parser.push(value))
          }
          await consume(parser.finish())
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } catch (error) {
        if (input.signal.aborted) return
        input.onError?.(error instanceof Error ? error : new Error(String(error)))
        failures += 1
      }
      if (input.signal.aborted) return
      await sleep(Math.min(5_000, 200 * 2 ** Math.min(failures, 5)), input.signal)
    }
  }

  connectModel(input: z.input<typeof ModelConnectionConnectRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.connectModel(input)
    return this.request('/v1/model-connections/connect', ModelConnectionSnapshotSchema, {
      method: 'POST',
      body: ModelConnectionConnectRequestSchema.parse(input)
    })
  }

  patchModel(providerId: string, input: z.input<typeof ModelConnectionPatchRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.patchModel(providerId, input)
    return this.request(`/v1/model-connections/${segment(providerId)}`, ModelConnectionSnapshotSchema, {
      method: 'PATCH',
      body: ModelConnectionPatchRequestSchema.parse(input)
    })
  }

  replaceModelCredential(providerId: string, input: z.input<typeof ModelConnectionCredentialRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.replaceModelCredential(providerId, input)
    return this.request(`/v1/model-connections/${segment(providerId)}/credential`, ModelConnectionSnapshotSchema, {
      method: 'PUT',
      body: ModelConnectionCredentialRequestSchema.parse(input)
    })
  }

  deleteModel(providerId: string, expectedRevision: number) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.deleteModel(providerId, expectedRevision)
    return this.request(
      `/v1/model-connections/${segment(providerId)}?expected_revision=${expectedRevision}`,
      ModelConnectionSnapshotSchema,
      { method: 'DELETE' }
    )
  }

  probeModel(providerId: string) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.probeModel(providerId)
    return this.request(
      `/v1/model-connections/${segment(providerId)}/probe`,
      z.object({ ok: z.literal(true), models: z.array(z.string()) }),
      { method: 'POST' }
    )
  }

  selectModel(input: z.input<typeof ModelConnectionSelectRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.selectModel(input)
    return this.request('/v1/model-connections/select', ModelConnectionSnapshotSchema, {
      method: 'POST',
      body: ModelConnectionSelectRequestSchema.parse(input)
    })
  }

  completeModelCliAuth(input: z.input<typeof ModelConnectionCliAuthRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.completeModelCliAuth(input)
    return this.request('/v1/model-connections/cli/complete', ModelConnectionSnapshotSchema, {
      method: 'POST',
      body: ModelConnectionCliAuthRequestSchema.parse(input)
    })
  }

  startModelOAuth(input: z.input<typeof ModelConnectionOAuthStartRequestSchema>) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.startModelOAuth(input)
    return this.request('/v1/model-connections/oauth/start', ModelConnectionOAuthStatusSchema, {
      method: 'POST',
      body: ModelConnectionOAuthStartRequestSchema.parse(input)
    })
  }

  modelOAuthStatus(sessionId: string) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.modelOAuthStatus(sessionId)
    return this.request(`/v1/model-connections/oauth/${segment(sessionId)}`, ModelConnectionOAuthStatusSchema)
  }

  submitModelOAuth(sessionId: string, code: string) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.submitModelOAuth(sessionId, code)
    return this.request(
      `/v1/model-connections/oauth/${segment(sessionId)}/submit`,
      ModelConnectionOAuthStatusSchema,
      {
        method: 'POST',
        body: ModelConnectionOAuthSubmitRequestSchema.parse({ code })
      }
    )
  }

  cancelModelOAuth(sessionId: string) {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.cancelModelOAuth(sessionId)
    return this.request(`/v1/model-connections/oauth/${segment(sessionId)}`, ModelConnectionOAuthStatusSchema, {
      method: 'DELETE'
    })
  }

  claudeSdkStatus() {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.claudeSdkStatus()
    return this.request('/v1/model-connections/claude/sdk', ClaudeSdkInstallStatusSchema)
  }

  installClaudeSdk() {
    if (this.modelConnectionTransport) return this.modelConnectionTransport.installClaudeSdk()
    return this.request('/v1/model-connections/claude/sdk/install', ClaudeSdkInstallStatusSchema, {
      method: 'POST'
    })
  }

  async closeModelConnections(): Promise<void> {
    await this.modelConnectionTransport?.close?.()
  }

  async listThreads(input: {
    search?: string
    includeArchived?: boolean
    archivedOnly?: boolean
    includeSide?: boolean
    limit?: number
  } = {}): Promise<ThreadSummary[]> {
    const query = new URLSearchParams()
    if (input.search) query.set('search', input.search)
    if (input.includeArchived) query.set('include_archived', 'true')
    if (input.archivedOnly) query.set('archived_only', 'true')
    if (input.includeSide) query.set('include', 'side')
    if (input.limit) query.set('limit', String(input.limit))
    const suffix = query.size ? `?${query}` : ''
    return (await this.request(`/v1/threads${suffix}`, ListThreadsResponse)).threads
  }

  getThread(threadId: string): Promise<ThreadDetail> {
    return this.request(`/v1/threads/${segment(threadId)}`, ThreadDetailResponse)
  }

  createThread(input: CreateThreadRequestValue): Promise<ThreadRecord> {
    return this.request('/v1/threads', ThreadSchema, { method: 'POST', body: CreateThreadRequest.parse(input) })
  }

  updateThread(threadId: string, input: z.input<typeof UpdateThreadRequest>): Promise<ThreadRecord> {
    return this.request(`/v1/threads/${segment(threadId)}`, ThreadSchema, {
      method: 'PATCH',
      body: UpdateThreadRequest.parse(input)
    })
  }

  deleteThread(threadId: string) {
    return this.request(`/v1/threads/${segment(threadId)}`, DeleteThreadResponse, { method: 'DELETE' })
  }

  forkThread(threadId: string, input: z.input<typeof ForkThreadRequest> = {}): Promise<ThreadRecord> {
    return this.request(`/v1/threads/${segment(threadId)}/fork`, ThreadSchema, {
      method: 'POST',
      body: input ?? {}
    })
  }

  threadGoal(threadId: string) {
    return this.request(`/v1/threads/${segment(threadId)}/goal`, ThreadGoalResponse)
  }

  setThreadGoal(threadId: string, input: z.input<typeof SetThreadGoalRequest>) {
    return this.request(`/v1/threads/${segment(threadId)}/goal`, ThreadGoalResponse, {
      method: 'POST', body: SetThreadGoalRequest.parse(input)
    })
  }

  clearThreadGoal(threadId: string) {
    return this.request(`/v1/threads/${segment(threadId)}/goal`, ClearThreadGoalResponse, {
      method: 'DELETE'
    })
  }

  threadTodos(threadId: string) {
    return this.request(`/v1/threads/${segment(threadId)}/todos`, ThreadTodosResponse)
  }

  setThreadTodos(threadId: string, input: z.input<typeof SetThreadTodosRequest>) {
    return this.request(`/v1/threads/${segment(threadId)}/todos`, ThreadTodosResponse, {
      method: 'POST',
      body: SetThreadTodosRequest.parse(input)
    })
  }

  clearThreadTodos(threadId: string) {
    return this.request(`/v1/threads/${segment(threadId)}/todos`, ClearThreadTodosResponse, {
      method: 'DELETE'
    })
  }

  startTurn(threadId: string, input: StartTurnRequestValue) {
    return this.request(`/v1/threads/${segment(threadId)}/turns`, StartTurnResponse, {
      method: 'POST',
      body: StartTurnRequest.parse(input)
    })
  }

  graphAvailability() {
    return this.request('/v1/graphs/diagnostics', GraphAvailabilityResponse)
  }

  async listGraphRuns(threadId: string) {
    const summaries: z.infer<typeof GraphRunSummary>[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.request(
        `/v1/graphs?thread_id=${encodeURIComponent(threadId)}&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
        GraphRunsResponse
      )
      summaries.push(...page.runs)
      cursor = page.nextCursor
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('Kun runtime repeated a Graph list cursor')
      }
      if (cursor) seenCursors.add(cursor)
    } while (cursor)
    const selected = summaries.sort((left, right) =>
      Number(isTerminalGraphStatus(left.status)) - Number(isTerminalGraphStatus(right.status)) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    )[0]
    return selected ? [await this.getGraphRun(selected.id)] : []
  }

  getGraphRun(runId: string) {
    return this.request(`/v1/graphs/${segment(runId)}`, PublicGraphRunResponse)
  }

  steerGraphRun(runId: string, text: string) {
    const commandId = `tui_steer_${randomUUID()}`
    return this.request(`/v1/graphs/${segment(runId)}/steer`, PublicGraphRunResponse, {
      method: 'POST',
      body: {
        commandId,
        idempotencyKey: commandId,
        target: { kind: 'run' },
        text
      }
    })
  }

  steerTurn(threadId: string, turnId: string, text: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/threads/${segment(threadId)}/turns/${segment(turnId)}/steer`, z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: { text }
    })
  }

  steeringQueue(threadId: string, turnId: string) {
    return this.request(
      `/v1/threads/${segment(threadId)}/turns/${segment(turnId)}/steering`,
      SteeringQueueResponse
    )
  }

  replaceSteeringQueue(
    threadId: string,
    turnId: string,
    input: z.input<typeof ReplaceSteeringRequest>
  ) {
    return this.request(
      `/v1/threads/${segment(threadId)}/turns/${segment(turnId)}/steering`,
      SteeringQueueResponse,
      { method: 'PATCH', body: ReplaceSteeringRequest.parse(input) }
    )
  }

  interruptTurn(threadId: string, turnId: string, discard = false) {
    return this.request(
      `/v1/threads/${segment(threadId)}/turns/${segment(turnId)}/interrupt`,
      z.object({ threadId: z.string(), turnId: z.string(), status: z.string() }),
      { method: 'POST', body: { discard } }
    )
  }

  compactThread(threadId: string, reason = 'manual terminal compaction') {
    return this.request(`/v1/threads/${segment(threadId)}/compact`, CompactResponse, {
      method: 'POST',
      body: { reason }
    })
  }

  decideApproval(approvalId: string, decision: ApprovalDecisionRequest['decision']) {
    const headers: Record<string, string> = {}
    if (this.runtimeToken) {
      headers[KUN_APPROVAL_CONSENT_HEADER] = createApprovalConsentToken({
        runtimeToken: this.runtimeToken,
        approvalId,
        decision,
        expiresAt: Date.now() + 30_000
      })
    }
    return this.request(`/v1/approvals/${segment(approvalId)}`, ApprovalDecisionResponse, {
      method: 'POST',
      body: { decision },
      headers
    })
  }

  resolveUserInput(inputId: string, answers: UserInputAnswer[]) {
    return this.request(`/v1/user-inputs/${segment(inputId)}`, UserInputResolutionResponse, {
      method: 'POST',
      body: { answers }
    })
  }

  cancelUserInput(inputId: string) {
    return this.request(`/v1/user-inputs/${segment(inputId)}`, UserInputResolutionResponse, {
      method: 'POST',
      body: { cancelled: true }
    })
  }

  usage() {
    return this.request('/v1/usage?group_by=thread', ThreadUsageResponseSchema)
  }

  providerQuotas() {
    return this.request('/v1/provider-quotas', ProviderQuotaListResponseSchema)
  }

  async subscribeThreadEvents(input: {
    threadId: string
    sinceSeq: number
    signal: AbortSignal
    onEvent: (event: RuntimeEventValue) => void | Promise<void>
    onConnection?: (state: 'connecting' | 'connected' | 'reconnecting') => void
    onError?: (error: Error) => void
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  }): Promise<void> {
    let cursor = Math.max(0, input.sinceSeq)
    let failures = 0
    const sleep = input.sleep ?? abortableDelay
    while (!input.signal.aborted) {
      input.onConnection?.(failures === 0 ? 'connecting' : 'reconnecting')
      try {
        await this.refreshConnection()
        const response = await this.fetchImpl(
          `${this.baseUrl}/v1/threads/${segment(input.threadId)}/events?since_seq=${cursor}`,
          {
            method: 'GET',
            headers: this.headers({ Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) }),
            signal: input.signal
          }
        )
        if (!response.ok || !response.body) {
          throw await responseError(response, '/v1/threads/:id/events', this.runtimeToken)
        }
        input.onConnection?.('connected')
        failures = 0
        const parser = new IncrementalSseParser()
        const reader = response.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (const frame of parser.push(value)) {
              const event = parseRuntimeEventFrame(frame)
              if (!event || event.kind === 'heartbeat' || event.seq <= cursor) continue
              cursor = event.seq
              await input.onEvent(event)
            }
          }
          for (const frame of parser.finish()) {
            const event = parseRuntimeEventFrame(frame)
            if (!event || event.kind === 'heartbeat' || event.seq <= cursor) continue
            cursor = event.seq
            await input.onEvent(event)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } catch (error) {
        if (input.signal.aborted) return
        const safe = error instanceof Error ? error : new Error(String(error))
        input.onError?.(safe)
        if (safe instanceof TuiClientError && (safe.status === 404 || safe.status === 410)) return
        failures += 1
      }
      if (input.signal.aborted) return
      const delay = Math.min(5_000, 200 * 2 ** Math.min(failures, 5))
      await sleep(delay, input.signal)
    }
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const method = init.method ?? 'GET'
    const initialEndpoint = this.endpoint
    let response: Response
    try {
      response = await this.fetchImpl(`${initialEndpoint.baseUrl}${path}`, {
        method,
        headers: this.headers(init.headers),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      const changed = await this.refreshConnection().catch(() => false)
      if (changed && (method === 'GET' || method === 'HEAD')) {
        return this.request(path, schema, init)
      }
      throw new TuiClientError(`Kun runtime request failed for ${safePath(path)}`, undefined, 'connection_failed', safePath(path))
    }
    if (response.status === 401) {
      const changed = await this.refreshConnection().catch(() => false)
      if (changed && (method === 'GET' || method === 'HEAD')) {
        return this.request(path, schema, init)
      }
    }
    if (!response.ok) throw await responseError(response, safePath(path), this.runtimeToken)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new TuiClientError(`Kun runtime returned invalid JSON for ${safePath(path)}`, response.status, 'invalid_response', safePath(path))
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new TuiClientError(`Kun runtime response did not match the client contract for ${safePath(path)}`, response.status, 'invalid_response', safePath(path))
    }
    return parsed.data
  }

  private refreshConnection(): Promise<boolean> {
    if (!this.connectionResolver) return Promise.resolve(false)
    if (this.connectionRefresh) return this.connectionRefresh
    const previous = this.endpoint
    let refresh: Promise<boolean>
    refresh = this.connectionResolver()
      .then((connection) => {
        const next = {
          baseUrl: connection.baseUrl.replace(/\/$/, ''),
          runtimeToken: connection.runtimeToken
        }
        this.endpoint = next
        return next.baseUrl !== previous.baseUrl || next.runtimeToken !== previous.runtimeToken
      })
      .finally(() => {
        if (this.connectionRefresh === refresh) this.connectionRefresh = undefined
      })
    this.connectionRefresh = refresh
    return refresh
  }

  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers({ Accept: 'application/json', ...extra })
    if (this.runtimeToken) headers.set('Authorization', `Bearer ${this.runtimeToken}`)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return headers
  }
}

function isTerminalGraphStatus(status: z.infer<typeof GraphRunStatusSchema>): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

async function responseError(response: Response, path: string, runtimeToken = ''): Promise<TuiClientError> {
  let code: string | undefined
  let message = `Kun runtime request failed (${response.status}) for ${safePath(path)}`
  try {
    const body = await response.json() as { code?: unknown; message?: unknown }
    if (typeof body.code === 'string') code = body.code.slice(0, 128)
    if (typeof body.message === 'string' && body.message.trim()) {
      message = redactKnownSecret(body.message.slice(0, 1_024), runtimeToken)
    }
  } catch {
    // Do not echo arbitrary upstream HTML/text into the terminal.
  }
  return new TuiClientError(message, response.status, code, safePath(path))
}

function redactKnownSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function safePath(path: string): string {
  return path.split('?')[0] ?? path
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
