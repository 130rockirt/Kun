import { z, type ZodType } from 'zod'
import {
  ApprovalDecisionResponse,
  BackgroundShellListResponse,
  ClearThreadGoalResponse,
  CompactResponse,
  ClaudeSdkInstallStatusSchema,
  CreateThreadRequest,
  DeleteThreadResponse,
  ForkThreadRequest,
  ListThreadsResponse,
  ModelConnectionConnectRequestSchema,
  ModelConnectionCredentialRequestSchema,
  ModelConnectionOAuthStartRequestSchema,
  ModelConnectionOAuthStatusSchema,
  ModelConnectionOAuthSubmitRequestSchema,
  ModelConnectionPatchRequestSchema,
  ModelConnectionSelectRequestSchema,
  ModelConnectionSnapshotSchema,
  RuntimeInfoResponse,
  RuntimeConfigApplyRequest,
  RuntimeConfigApplyResponse,
  SetThreadGoalRequest,
  StartTurnRequest,
  StartTurnResponse,
  ThreadGoalResponse,
  ThreadSchema,
  ThreadTodosResponse,
  ThreadUsageResponseSchema,
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
import { ensureSharedRuntime } from '../cli/shared-runtime.js'
import type { TuiOptions } from './options.js'
import { IncrementalSseParser, parseRuntimeEventFrame } from './sse.js'

const ThreadDetailResponse = ThreadSchema.extend({
  latestSeq: z.number().int().nonnegative().default(0),
  pendingUserInputIds: z.array(z.string()).default([])
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
    status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
    summary: z.string().optional(), error: z.string().optional(), detached: z.boolean().optional(),
    createdAt: z.string(), updatedAt: z.string()
  }).passthrough()),
  aggregates: z.array(z.unknown()).default([])
})

export type ThreadDetail = z.infer<typeof ThreadDetailResponse>
export type UserInputAnswer = z.infer<typeof UserInputAnswerSchema>
export type RuntimeTools = z.infer<typeof RuntimeToolsResponse>
export type SkillsSnapshot = z.infer<typeof SkillsResponse>
export type DelegationDiagnostics = z.infer<typeof DelegationDiagnosticsResponse>

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
  fetchImpl: typeof fetch = fetch
): Promise<TuiConnection> {
  if (options.url) {
    return validateConnection({
      baseUrl: options.url,
      runtimeToken: options.runtimeToken,
      discovered: false
    }, fetchImpl)
  }

  const discovery = await readRuntimeDiscovery(options.dataDir).catch(() => null)
  if (discovery) {
    assertSafeDiscovery(discovery)
    try {
      return await validateConnection({
        baseUrl: discovery.baseUrl.replace(/\/$/, ''),
        runtimeToken: options.runtimeToken || discovery.runtimeToken,
        discovered: true,
        discovery
      }, fetchImpl)
    } catch (error) {
      if (!options.noStart) {
        const started = await ensureSharedRuntime({ dataDir: options.dataDir, fetch: fetchImpl })
        return {
          baseUrl: started.discovery.baseUrl,
          runtimeToken: started.discovery.runtimeToken,
          runtimeInfo: started.info,
          discovered: true
        }
      }
      throw new TuiClientError(
        `Kun runtime discovery is stale or unavailable in ${options.dataDir}. Start the GUI or run kun serve, then retry.`,
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
  const started = await ensureSharedRuntime({ dataDir: options.dataDir, fetch: fetchImpl })
  return {
    baseUrl: started.discovery.baseUrl,
    runtimeToken: started.discovery.runtimeToken,
    runtimeInfo: started.info,
    discovered: true
  }
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
  readonly baseUrl: string
  readonly runtimeToken: string
  private readonly fetchImpl: typeof fetch
  private readonly modelConnectionTransport?: ModelConnectionTransport

  constructor(input: {
    baseUrl: string
    runtimeToken?: string
    fetch?: typeof fetch
    modelConnectionTransport?: ModelConnectionTransport
  }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, '')
    this.runtimeToken = input.runtimeToken ?? ''
    this.fetchImpl = input.fetch ?? fetch
    this.modelConnectionTransport = input.modelConnectionTransport
  }

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

  delegationDiagnostics(parentThreadId?: string) {
    const query = parentThreadId ? `?parent_thread_id=${encodeURIComponent(parentThreadId)}` : ''
    return this.request(`/v1/delegation/diagnostics${query}`, DelegationDiagnosticsResponse)
  }

  backgroundShells(threadId?: string) {
    const query = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ''
    return this.request(`/v1/background-shells${query}`, BackgroundShellListResponse)
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

  startTurn(threadId: string, input: StartTurnRequestValue) {
    return this.request(`/v1/threads/${segment(threadId)}/turns`, StartTurnResponse, {
      method: 'POST',
      body: StartTurnRequest.parse(input)
    })
  }

  steerTurn(threadId: string, turnId: string, text: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/threads/${segment(threadId)}/turns/${segment(turnId)}/steer`, z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: { text }
    })
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
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(init.headers),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      throw new TuiClientError(`Kun runtime request failed for ${safePath(path)}`, undefined, 'connection_failed', safePath(path))
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

  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers({ Accept: 'application/json', ...extra })
    if (this.runtimeToken) headers.set('Authorization', `Bearer ${this.runtimeToken}`)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return headers
  }
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
