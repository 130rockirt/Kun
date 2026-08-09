import {
  AccountSchema,
  ComposerContextAttachmentRequestSchema,
  ComposerContextAttachmentSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  ExtensionApiError,
  ExtensionHostClient,
  ExtensionToolDeclarationSchema,
  GeneratedArtifactSchema,
  HostMessageSchema,
  JobCancelRequestSchema,
  JobEventSchema,
  JobFilterSchema,
  JobListRequestSchema,
  JobResultSchema,
  JobSnapshotSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MediaAudioAnalysisCapabilitiesSchema,
  MediaAnalyzeVisualFramesRequestSchema,
  MediaEmbedVisualQueryRequestSchema,
  MediaCapabilitiesSchema,
  MediaCreateCacheTargetRequestSchema,
  MediaMetadataSchema,
  MediaOpenViewResourceRequestSchema,
  MediaPickFilesRequestSchema,
  MediaPickSaveTargetRequestSchema,
  MediaProbeRequestSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaReleaseRequestSchema,
  MediaStartFfmpegJobRequestSchema,
  MediaStartAudioAnalysisJobRequestSchema,
  MediaStartArchiveJobRequestSchema,
  MediaVisualModelStatusSchema,
  ModelProviderDeclarationSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ProviderStatusSchema,
  ThemeSchema,
  LocaleSchema,
  createExtensionContext,
  hasPermission,
  toDisposable,
  type Account,
  type Activate,
  type AgentCreateRunRequest,
  type AgentRun,
  type AgentRunEvent,
  type Deactivate,
  type Disposable,
  type ExtensionContext,
  type ExtensionIdentity,
  type ExtensionToolDeclaration,
  type HostNotification,
  type HostRequestContext,
  type HostRequestHandler,
  type HostRequestOptions,
  type HostTransport,
  type GeneratedArtifact,
  type JobEvent,
  type JobListRequest,
  type JobResult,
  type JobResultInput,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaAudioAnalysisCapabilities,
  type MediaVisualModelStatus,
  type MediaCapabilities,
  type ModelProviderDeclaration,
  type ModelProviderStreamEvent,
  type MediaMetadata,
  type MediaProbeResult,
  type NetworkResponse,
  type Permission,
  type ProviderStatus,
  type Theme,
  type Locale,
  type WorkspaceContext,
  type WorkspaceFile
} from '@kun/extension-api'
import { createHash } from 'node:crypto'


import { FakeClock, FakeHostTransport } from './fake-transport.js'
import { isTerminalJob, notFound } from './fake-service-helpers.js'

type FakeCancellationMode = 'immediate' | 'pending'

export class FakeJobService {
  readonly snapshots = new Map<string, JobSnapshot>()
  readonly events = new Map<string, JobEvent[]>()
  readonly #subscriptions = new Map<string, string>()
  cancellationMode: FakeCancellationMode = 'immediate'
  #nextJob = 1
  #nextSubscription = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly clock: FakeClock,
    private readonly identity: ExtensionIdentity,
    private readonly workspaceId: string
  ) {}

  install(): void {
    this.transport.handle('jobs.get', (params) =>
      this.get(String(JsonObjectSchema.parse(params).jobId)))
    this.transport.handle('jobs.list', (params) => this.list(JobListRequestSchema.parse(params)))
    this.transport.handle('jobs.subscribe', (params) => {
      const input = JsonObjectSchema.parse(params)
      const jobId = String(input.jobId)
      const snapshot = this.get(jobId)
      const subscriptionId = `job-subscription-${this.#nextSubscription++}`
      this.#subscriptions.set(subscriptionId, jobId)
      const retained = this.events.get(jobId) ?? []
      const afterCursor = input.afterCursor === undefined ? undefined : String(input.afterCursor)
      const afterIndex = afterCursor === undefined
        ? -1
        : retained.findIndex((event) => event.cursor === afterCursor)
      const gap = afterCursor !== undefined && afterIndex < 0
      const replay = retained.slice(gap ? 0 : afterIndex + 1)
      return {
        subscriptionId,
        snapshot,
        replay,
        cursor: snapshot.latestCursor,
        gap,
        complete: isTerminalJob(snapshot.state)
      }
    })
    this.transport.handle('jobs.unsubscribe', (params) => {
      this.#subscriptions.delete(String(JsonObjectSchema.parse(params).subscriptionId))
      return { ok: true }
    })
    this.transport.handle('jobs.cancel', (params) => {
      const request = JobCancelRequestSchema.parse(params)
      const snapshot = this.get(request.jobId)
      if (isTerminalJob(snapshot.state)) return { accepted: false, snapshot }
      const cancelRequestedAt = this.clock.nowIso()
      this.#replace({ ...snapshot, cancelRequestedAt, updatedAt: cancelRequestedAt })
      this.#append(request.jobId, 'cancellation-requested', snapshot.state)
      if (this.cancellationMode === 'immediate') this.settleCancellation(request.jobId)
      return { accepted: true, snapshot: this.get(request.jobId) }
    })
  }

  create(kind: string, initiatingOperation: string): JobSnapshot {
    const id = `fake-job-${this.#nextJob++}`
    const timestamp = this.clock.nowIso()
    const cursor = `${id}.1`
    const snapshot = JobSnapshotSchema.parse({
      schemaVersion: 1,
      id,
      kind,
      kindSchemaVersion: 1,
      ownerExtensionId: this.identity.id,
      ownerExtensionVersion: this.identity.version,
      workspaceId: this.workspaceId,
      initiatingOperation,
      state: 'queued',
      executionAttempt: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      latestCursor: cursor
    })
    this.snapshots.set(id, snapshot)
    this.events.set(id, [])
    this.#append(id, 'created', 'queued')
    return this.get(id)
  }

  get(jobId: string): JobSnapshot {
    const snapshot = this.snapshots.get(jobId)
    if (!snapshot) throw notFound(`Job ${jobId} was not found`, 'jobs.get')
    return structuredClone(snapshot)
  }

  list(request: JobListRequest = {}): {
    items: JobSnapshot[]
    page: { nextCursor?: string; hasMore: boolean }
  } {
    const parsed = JobListRequestSchema.parse(request)
    const filter = parsed.filter ? JobFilterSchema.parse(parsed.filter) : undefined
    const offset = parsed.cursor ? Number(parsed.cursor.slice('page_'.length)) : 0
    const matches = [...this.snapshots.values()]
      .filter((job) => !filter?.states || filter.states.includes(job.state))
      .filter((job) => !filter?.kinds || filter.kinds.includes(job.kind))
      .filter((job) => !filter?.workspaceId || filter.workspaceId === job.workspaceId)
      .filter((job) => !filter?.createdAfter || job.createdAt >= filter.createdAfter)
      .filter((job) => !filter?.createdBefore || job.createdAt <= filter.createdBefore)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    const items = matches.slice(offset, offset + parsed.limit).map((item) => structuredClone(item))
    const nextOffset = offset + items.length
    return {
      items,
      page: nextOffset < matches.length
        ? { nextCursor: `page_${String(nextOffset).padStart(4, '0')}`, hasMore: true }
        : { hasMore: false }
    }
  }

  start(jobId: string): JobSnapshot {
    const snapshot = this.get(jobId)
    if (snapshot.state !== 'queued') return snapshot
    const timestamp = this.clock.nowIso()
    this.#replace({
      ...snapshot,
      state: 'running',
      executionAttempt: snapshot.executionAttempt + 1,
      startedAt: timestamp,
      updatedAt: timestamp
    })
    this.#append(jobId, 'state', 'running')
    return this.get(jobId)
  }

  reportProgress(
    jobId: string,
    progress: Omit<NonNullable<JobSnapshot['progress']>, 'updatedAt'>
  ): JobSnapshot {
    const snapshot = this.get(jobId)
    if (snapshot.state !== 'running') return snapshot
    const normalized = { ...progress, updatedAt: this.clock.nowIso() }
    this.#replace({ ...snapshot, progress: normalized, updatedAt: normalized.updatedAt })
    this.#append(jobId, 'progress', 'running', { progress: normalized })
    return this.get(jobId)
  }

  complete(jobId: string, result: JobResultInput = { schemaVersion: 1 }): JobSnapshot {
    const snapshot = this.get(jobId)
    if (isTerminalJob(snapshot.state) || snapshot.cancelRequestedAt) return snapshot
    const timestamp = this.clock.nowIso()
    const normalized = JobResultSchema.parse(result)
    this.#replace({
      ...snapshot,
      state: 'completed',
      result: normalized,
      updatedAt: timestamp,
      terminalAt: timestamp
    })
    this.#append(jobId, 'completed', 'completed', { result: normalized })
    return this.get(jobId)
  }

  fail(jobId: string, code = 'FAKE_JOB_FAILED', message = 'Fake job failed'): JobSnapshot {
    return this.#terminate(jobId, 'failed', 'failed', { code, message, retryable: false })
  }

  interrupt(jobId: string, message = 'Fake runtime restarted'): JobSnapshot {
    return this.#terminate(jobId, 'interrupted', 'interrupted', {
      code: 'FAKE_JOB_INTERRUPTED',
      message,
      retryable: true
    })
  }

  settleCancellation(jobId: string): JobSnapshot {
    const snapshot = this.get(jobId)
    if (isTerminalJob(snapshot.state)) return snapshot
    return this.#terminate(jobId, 'cancelled', 'cancelled')
  }

  simulateRestart(): void {
    this.#subscriptions.clear()
    for (const snapshot of [...this.snapshots.values()]) {
      if (snapshot.cancelRequestedAt) this.settleCancellation(snapshot.id)
      else if (snapshot.state === 'running') this.interrupt(snapshot.id)
    }
  }

  #terminate(
    jobId: string,
    state: 'failed' | 'cancelled' | 'interrupted',
    type: 'failed' | 'cancelled' | 'interrupted',
    error?: { code: string; message: string; retryable: boolean }
  ): JobSnapshot {
    const snapshot = this.get(jobId)
    if (isTerminalJob(snapshot.state)) return snapshot
    const timestamp = this.clock.nowIso()
    this.#replace({ ...snapshot, state, error, updatedAt: timestamp, terminalAt: timestamp })
    this.#append(jobId, type, state, error ? { error } : {})
    return this.get(jobId)
  }

  #replace(snapshot: JobSnapshot): void {
    this.snapshots.set(snapshot.id, JobSnapshotSchema.parse(snapshot))
  }

  #append(
    jobId: string,
    type: JobEvent['type'],
    state: JobSnapshot['state'],
    fields: Pick<JobEvent, 'progress' | 'result' | 'error'> | {} = {}
  ): JobEvent {
    const snapshot = this.snapshots.get(jobId)
    if (!snapshot) throw notFound(`Job ${jobId} was not found`, 'jobs.event')
    const list = this.events.get(jobId) ?? []
    const sequence = list.length + 1
    const cursor = `${jobId}.${sequence}`
    const event = JobEventSchema.parse({
      schemaVersion: 1,
      jobId,
      kind: snapshot.kind,
      type,
      state,
      timestamp: this.clock.nowIso(),
      executionAttempt: snapshot.executionAttempt,
      sequence,
      cursor,
      ...fields
    })
    list.push(event)
    this.events.set(jobId, list)
    this.#replace({ ...this.get(jobId), latestCursor: cursor })
    for (const [subscriptionId, subscribedJobId] of this.#subscriptions) {
      if (subscribedJobId === jobId) this.transport.emit('jobs.event', { subscriptionId, event })
    }
    return structuredClone(event)
  }
}
