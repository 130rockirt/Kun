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
import { isTerminal, notFound } from './fake-service-helpers.js'

export class FakeStorageService {
  readonly global = new Map<string, JsonValue>()
  readonly workspace = new Map<string, JsonValue>()

  install(transport: FakeHostTransport): void {
    const store = (params: JsonValue | undefined) => {
      const parsed = JsonObjectSchema.parse(params)
      return parsed.scope === 'global' ? this.global : this.workspace
    }
    transport.handle('storage.get', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const selected = store(params)
      const key = String(parsed.key)
      return selected.has(key) ? { found: true, value: selected.get(key) } : { found: false }
    })
    transport.handle('storage.set', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      store(params).set(String(parsed.key), JsonValueSchema.parse(parsed.value))
      return { ok: true }
    })
    transport.handle('storage.delete', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      return { deleted: store(params).delete(String(parsed.key)) }
    })
    transport.handle('storage.keys', (params) => [...store(params).keys()].sort())
  }
}

export class FakeSecretStorageService {
  readonly values = new Map<string, string>()

  install(transport: FakeHostTransport): void {
    transport.handle('secrets.get', (params) => {
      const key = String(JsonObjectSchema.parse(params).key)
      return this.values.has(key)
        ? { found: true, value: this.values.get(key) }
        : { found: false }
    })
    transport.handle('secrets.set', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      this.values.set(String(parsed.key), String(parsed.value))
      return null
    })
    transport.handle('secrets.delete', (params) => ({
      deleted: this.values.delete(String(JsonObjectSchema.parse(params).key))
    }))
  }
}

export class FakeWorkspaceService {
  readonly files = new Map<string, WorkspaceFile>()

  install(transport: FakeHostTransport): void {
    transport.handle('workspace.readFile', (params) => {
      const { path } = JsonObjectSchema.parse(params)
      const file = this.files.get(String(path))
      if (!file) throw notFound(`Workspace file ${String(path)} was not found`, 'workspace.readFile')
      return file
    })
    transport.handle('workspace.writeFile', (params) => {
      const file = params as unknown as WorkspaceFile
      this.files.set(file.path, file)
      return { ok: true }
    })
    transport.handle('workspace.stat', (params) => {
      const { path } = JsonObjectSchema.parse(params)
      const file = this.files.get(String(path))
      return file
        ? { path: file.path, type: 'file', size: file.content.length }
        : { path: String(path), type: 'directory', size: 0 }
    })
    transport.handle('workspace.list', (params) => {
      const { path = '.' } = JsonObjectSchema.parse(params)
      const prefix = String(path) === '.' ? '' : `${String(path).replace(/\/$/, '')}/`
      return [...this.files.values()]
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ path: file.path, type: 'file', size: file.content.length }))
    })
  }
}

export class FakeAgentService {
  readonly runs = new Map<string, AgentRun>()
  readonly events = new Map<string, AgentRunEvent[]>()
  readonly #subscriptions = new Map<string, string>()
  #nextRun = 1
  #nextSubscription = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly clock: FakeClock,
    private readonly identity: ExtensionIdentity
  ) {}

  install(): void {
    this.transport.handle('agent.createRun', (params) => this.createRun(AgentCreateRunRequestSchema.parse(params)))
    this.transport.handle('agent.getRun', (params) => this.getRun(String(JsonObjectSchema.parse(params).runId)))
    this.transport.handle('agent.subscribe', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const runId = String(parsed.runId)
      this.getRun(runId)
      const subscriptionId = `subscription-${this.#nextSubscription++}`
      this.#subscriptions.set(subscriptionId, runId)
      const after = Number(parsed.afterSequence ?? 0)
      return {
        subscriptionId,
        replay: (this.events.get(runId) ?? []).filter((event) => event.sequence > after)
      }
    })
    this.transport.handle('agent.unsubscribe', (params) => {
      this.#subscriptions.delete(String(JsonObjectSchema.parse(params).subscriptionId))
      return { ok: true }
    })
    this.transport.handle('agent.steer', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const run = this.getRun(String(parsed.runId))
      this.emit(run.id, 'steering-accepted', { steeringId: `steering-${this.clock.now()}` })
      return { accepted: true, run }
    })
    this.transport.handle('agent.cancel', (params) => {
      const run = this.getRun(String(JsonObjectSchema.parse(params).runId))
      if (!isTerminal(run.state)) {
        const updated: AgentRun = {
          ...run,
          state: 'cancelled',
          updatedAt: this.clock.nowIso(),
          terminalAt: this.clock.nowIso()
        }
        this.runs.set(run.id, updated)
        this.emit(run.id, 'terminal', { state: 'cancelled' })
      }
      return { accepted: true, run: this.getRun(run.id) }
    })
    this.transport.handle('threads.listOwn', () => ({
      items: [...this.runs.values()].map((run) => ({
        id: run.threadId,
        ownerExtensionId: run.ownerExtensionId,
        ownerExtensionVersion: run.ownerExtensionVersion,
        extensionVisibility: run.extensionVisibility,
        latestRun: run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      })),
      page: { hasMore: false }
    }))
    this.transport.handle('threads.getOwn', (params) => {
      const threadId = String(JsonObjectSchema.parse(params).threadId)
      const run = [...this.runs.values()].find((candidate) => candidate.threadId === threadId)
      if (!run) throw notFound(`Thread ${threadId} was not found`, 'threads.getOwn')
      return {
        id: threadId,
        ownerExtensionId: run.ownerExtensionId,
        ownerExtensionVersion: run.ownerExtensionVersion,
        extensionVisibility: run.extensionVisibility,
        latestRun: run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      }
    })
  }

  createRun(request: AgentCreateRunRequest): { run: AgentRun; createdThread: boolean } {
    const id = `run-${this.#nextRun++}`
    const threadId = request.threadId ?? `thread-${id}`
    const run: AgentRun = {
      id,
      threadId,
      ownerExtensionId: this.identity.id,
      ownerExtensionVersion: this.identity.version,
      accountId: request.providerBinding?.accountId,
      extensionVisibility: request.visibility ?? 'private',
      extensionProfile: request.profileId
        ? {
            id: request.profileId,
            instructionDigest: 'fake-profile-digest',
            providerBinding: request.providerBinding,
            allowedTools: request.allowedTools ?? [],
            budget: request.budget ?? {}
          }
        : undefined,
      extensionBudget: request.budget ?? {},
      toolCatalogEpoch: 'fake-epoch-1',
      state: 'running',
      providerBinding: request.providerBinding,
      createdAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso()
    }
    this.runs.set(id, run)
    this.events.set(id, [])
    this.emit(id, 'state', { state: 'running' })
    return { run, createdThread: !request.threadId }
  }

  getRun(runId: string): AgentRun {
    const run = this.runs.get(runId)
    if (!run) throw notFound(`Run ${runId} was not found`, 'agent.getRun')
    return run
  }

  emit(runId: string, type: AgentRunEvent['type'], fields: JsonObject = {}): AgentRunEvent {
    const run = this.getRun(runId)
    const list = this.events.get(runId) ?? []
    const event = AgentRunEventSchema.parse({
      runId,
      threadId: run.threadId,
      sequence: list.length + 1,
      timestamp: this.clock.nowIso(),
      type,
      ...fields
    })
    list.push(event)
    this.events.set(runId, list)
    for (const [subscriptionId, subscribedRun] of this.#subscriptions) {
      if (subscribedRun === runId) this.transport.emit('agent.event', { subscriptionId, event })
    }
    return event
  }
}

export function createGeneratedArtifactFixture(
  overrides: Partial<GeneratedArtifact> = {}
): GeneratedArtifact {
  return GeneratedArtifactSchema.parse({
    schemaVersion: 1,
    artifactId: 'fake_artifact_000001',
    ownerExtensionId: 'test.extension',
    ownerExtensionVersion: '1.1.0',
    workspaceId: 'test-workspace',
    mediaHandleId: 'fake_media_output_0001',
    displayName: 'output.mp4',
    mediaKind: 'video',
    mimeType: 'video/mp4',
    byteSize: 4096,
    completionIdentity: 'fake-completion-identity-0001',
    provenance: { jobId: 'fake-job-1', operation: 'media.ffmpeg' },
    ...overrides
  })
}

type FakeCancellationMode = 'immediate' | 'pending'
