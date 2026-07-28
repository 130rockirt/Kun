import type {
  AttachmentMetadata,
  GraphOrchestrationStrategy,
  GraphRunV1,
  ThreadGoalStatus,
  ThreadSummary,
  ThreadTodoItem,
  ThreadTodoStatus
} from '../contracts/index.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { ModelConnectionSnapshot } from '../contracts/model-connections.js'
import type { ModelReasoningEffort, ModelReasoningCapabilityMetadata } from '../contracts/capabilities.js'
import { redactSecretText } from '../config/secret-redaction.js'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename as renameFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UserInputAnswer } from './client.js'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  KunTuiClient,
  TuiClientError,
  type TuiConnection
} from './client.js'
import type { TuiOptions } from './options.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  matchingRequestContextSnapshot,
  projectThreadSnapshot,
  setProjectionRunningTurn,
  type ThreadProjection
} from './state.js'
import {
  emptyTuiPersistentState,
  modelStateKey,
  readTuiPersistentState,
  writeTuiPersistentState,
  type TuiPersistentState,
  type TuiRecentModel
} from './persistence.js'
import { modelCapabilitiesForProviderModel } from '../loop/model-context-profile.js'
import { setVisualTheme, type TuiThemeName } from './visual-system.js'
import {
  KunProjectConfigSchema,
  loadKunProjectConfig,
  writeKunProjectConfig
} from '../config/project-config.js'
import { readRuntimeDiscovery } from '../server/runtime-discovery.js'
import { parsePastedFilePaths } from './pasted-paths.js'
import type { ClipboardImage } from './clipboard-image.js'
import {
  isTerminalGraphRun,
  latestTuiGraphRun,
  summarizeTuiGraphRun
} from './graph-mode.js'

const execFile = promisify(execFileCallback)

export type ControllerView = 'threads' | 'chat' | 'help'
export type ControllerConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export type TuiControllerState = {
  view: ControllerView
  threads: ThreadSummary[]
  threadSearch: string
  selectedThreadIndex: number
  threadListMode: 'active' | 'archived'
  projection?: ThreadProjection
  connection: ControllerConnectionState
  busy: boolean
  busyLabel?: string
  busyStartedAt?: string
  notification?: { kind: 'info' | 'error'; message: string }
  inspection?: { title: string; lines: string[] }
  modelConnections?: ModelConnectionSnapshot
  reasoningEffort?: ModelReasoningEffort
  composerMode: 'agent' | 'plan'
  composerOrchestration: GraphOrchestrationStrategy
  graphAvailable?: boolean
  graphUnavailableReason?: string
  graphRuns: GraphRunV1[]
  graphBoard?: { runId: string }
  pendingAttachments: AttachmentMetadata[]
  attachmentMetadata: Record<string, AttachmentMetadata>
  theme: TuiThemeName
  quitRequested: boolean
}

export class TuiController {
  private stateValue: TuiControllerState = {
    // A bare `kun` starts on the guided composer. The conversation picker is
    // an explicit Ctrl+T action; opening it automatically leaves first-time
    // users staring at an empty modal with no explanation of what to do.
    view: 'chat',
    threads: [],
    threadSearch: '',
    selectedThreadIndex: 0,
    threadListMode: 'active',
    connection: 'connecting',
    busy: false,
    composerMode: 'agent',
    composerOrchestration: 'direct',
    graphRuns: [],
    pendingAttachments: [],
    attachmentMetadata: {},
    theme: 'kun',
    quitRequested: false
  }
  private readonly listeners = new Set<(state: TuiControllerState) => void>()
  private eventsAbort?: AbortController
  private activeSubscription?: Promise<void>
  private modelEventsAbort?: AbortController
  private modelEventsSubscription?: Promise<void>
  private persisted: TuiPersistentState = emptyTuiPersistentState()
  private persistenceInitialization?: Promise<void>
  private persistenceWrite: Promise<void> = Promise.resolve()
  private readonly redoTargets = new Map<string, string>()
  private readonly locallyEnabledCapabilities = new Set<'attachments' | 'memory'>()
  private readonly attachmentMetadataRequests = new Set<string>()
  private readonly graphRunRequests = new Set<string>()
  private readonly graphRunRefreshPending = new Set<string>()
  private attachmentHydrationGeneration = 0
  private readonly attachmentLeaseId = `tui_${randomUUID()}`
  /**
   * CLI overrides apply to newly created sessions only. `options` also holds
   * the active session selection for rendering and turn submission, so keep a
   * separate immutable copy before registry or thread hydration updates it.
   */
  private readonly newThreadSelectionOverride: {
    providerId?: string
    accountId?: string
    model?: string
  }

  constructor(
    readonly client: KunTuiClient,
    readonly options: TuiOptions,
    readonly runtime: TuiConnection,
    private readonly onModelSelectionChanged?: (
      snapshot: ModelConnectionSnapshot
    ) => Promise<void> | void
  ) {
    this.newThreadSelectionOverride = {
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.model ? { model: options.model } : {})
    }
  }

  get state(): TuiControllerState {
    return this.stateValue
  }

  applyModelSelection(snapshot: ModelConnectionSnapshot, notify = true): void {
    const activeSession = this.stateValue.projection
    if (snapshot.defaultModel) this.runtime.runtimeInfo.model = snapshot.defaultModel
    else if (!activeSession) this.runtime.runtimeInfo.model = ''
    if (!activeSession) this.applySharedDefaultToActiveSelection(snapshot)
    const reasoningEffort = activeSession
      ? this.resolveReasoningEffort({
          snapshot,
          providerId: this.options.providerId ?? activeSession.thread.providerId,
          accountId: this.options.accountId ?? activeSession.thread.accountId,
          model: this.options.model ?? activeSession.thread.model,
          ...(this.stateValue.reasoningEffort ? { preferred: this.stateValue.reasoningEffort } : {})
        })
      : this.resolveReasoningEffort({
          snapshot,
          providerId: this.options.providerId,
          accountId: this.options.accountId,
          model: this.options.model,
          ...(this.stateValue.reasoningEffort ? { preferred: this.stateValue.reasoningEffort } : {})
        })
    this.patch({ modelConnections: snapshot, reasoningEffort })
    if (snapshot.defaultProviderId && snapshot.defaultAccountId && snapshot.defaultModel) {
      void this.recordRecentModel({
        providerId: snapshot.defaultProviderId,
        accountId: snapshot.defaultAccountId,
        model: snapshot.defaultModel
      })
    }
    if (this.onModelSelectionChanged) {
      void Promise.resolve(this.onModelSelectionChanged(snapshot)).catch((error) => {
        this.notify(`Could not persist the shared default model: ${safeMessage(error)}`, 'error')
      })
    }
    if (notify) this.notify(
      snapshot.defaultProviderId && snapshot.defaultModel
        ? `${this.runtime.legacyGui ? 'Shared model' : 'Default model'}: ${snapshot.defaultProviderId}/${snapshot.defaultModel}`
        : 'Model connection updated.'
    )
  }

  async initializeModelConnections(): Promise<ModelConnectionSnapshot> {
    await this.initializePersistence()
    const snapshot = await this.client.modelConnections()
    this.applyModelSelection(snapshot, false)
    return snapshot
  }

  watchModelConnections(initialSnapshot = this.stateValue.modelConnections): void {
    if (this.modelEventsSubscription) return
    const abort = new AbortController()
    this.modelEventsAbort = abort
    const subscription = (async () => {
      const initial = initialSnapshot ?? await this.client.modelConnections()
      if (abort.signal.aborted) return
      if (!initialSnapshot) this.applyModelSelection(initial, false)
      await this.client.subscribeModelConnections({
        sinceRevision: initial.revision,
        signal: abort.signal,
        onSnapshot: (snapshot) => this.applyModelSelection(snapshot),
        onError: (error) => this.notify(safeMessage(error), 'error')
      })
    })()
    this.modelEventsSubscription = subscription
    void subscription.catch((error) => {
      if (!abort.signal.aborted) this.notify(safeMessage(error), 'error')
    }).finally(() => {
      if (this.modelEventsAbort === abort) {
        this.modelEventsAbort = undefined
        this.modelEventsSubscription = undefined
      }
    })
  }

  subscribe(listener: (state: TuiControllerState) => void): () => void {
    this.listeners.add(listener)
    listener(this.stateValue)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    await this.initializePersistence()
    await this.refreshGraphAvailability(false)
    await this.refreshThreads()
    if (this.options.threadId) {
      await this.openThread(this.options.threadId)
    } else if (this.options.continueLatest && this.stateValue.threads[0]) {
      await this.openThread(this.stateValue.threads[0].id)
    }
  }

  async stop(): Promise<void> {
    this.eventsAbort?.abort()
    this.modelEventsAbort?.abort()
    const releasePendingAttachments = Promise.all(
      this.stateValue.pendingAttachments.map((attachment) =>
        this.releasePendingAttachment(attachment))
    )
    const closeModelConnections = typeof this.client.closeModelConnections === 'function'
      ? this.client.closeModelConnections().catch(() => undefined)
      : Promise.resolve()
    await Promise.all([
      this.activeSubscription?.catch(() => undefined),
      this.modelEventsSubscription?.catch(() => undefined),
      this.persistenceWrite.catch(() => undefined),
      releasePendingAttachments,
      closeModelConnections
    ])
  }

  async refreshThreads(
    search = this.stateValue.threadSearch,
    mode = this.stateValue.threadListMode
  ): Promise<void> {
    this.patch({ busy: true, busyLabel: 'Loading sessions', threadSearch: search })
    try {
      const threads = await this.client.listThreads({
        search,
        archivedOnly: mode === 'archived'
      })
      threads.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt))
      this.patch({
        threads,
        threadListMode: mode,
        selectedThreadIndex: Math.min(this.stateValue.selectedThreadIndex, Math.max(0, threads.length - 1)),
        busy: false,
        connection: 'connected'
      })
    } catch (error) {
      this.fail(error)
    }
  }

  selectThread(delta: number): void {
    const max = Math.max(0, this.stateValue.threads.length - 1)
    this.patch({ selectedThreadIndex: Math.max(0, Math.min(max, this.stateValue.selectedThreadIndex + delta)) })
  }

  async openSelectedThread(): Promise<void> {
    const selected = this.stateValue.threads[this.stateValue.selectedThreadIndex]
    if (selected) await this.openThread(selected.id)
  }

  async openQuickSession(slot: number): Promise<void> {
    const thread = this.stateValue.threads[slot - 1]
    if (!thread) {
      this.notify(`No session is assigned to quick slot ${slot}.`, 'error')
      return
    }
    await this.openThread(thread.id)
  }

  async toggleSelectedThreadPin(): Promise<void> {
    const selected = this.stateValue.threads[this.stateValue.selectedThreadIndex]
    if (!selected) return
    try {
      await this.client.updateThread(selected.id, { pinned: !selected.pinned })
      await this.refreshThreads(this.stateValue.threadSearch)
      this.notify(`${selected.pinned ? 'Unpinned' : 'Pinned'} session ${selected.title || selected.id}.`)
    } catch (error) {
      this.fail(error)
    }
  }

  async deleteSelectedThread(): Promise<void> {
    const selected = this.stateValue.threads[this.stateValue.selectedThreadIndex]
    if (!selected) return
    try {
      await this.client.deleteThread(selected.id)
      if (this.stateValue.projection?.thread.id === selected.id) {
        this.eventsAbort?.abort()
        this.patch({ projection: undefined, graphRuns: [] })
      }
      await this.refreshThreads(this.stateValue.threadSearch)
      this.notify(`Deleted session ${selected.title || selected.id}.`)
    } catch (error) {
      this.fail(error)
    }
  }

  async restoreSelectedThread(): Promise<void> {
    const selected = this.stateValue.threads[this.stateValue.selectedThreadIndex]
    if (!selected) return
    try {
      await this.client.updateThread(selected.id, { status: 'idle' })
      await this.refreshThreads(this.stateValue.threadSearch, 'archived')
      this.notify(`Restored session ${selected.title || selected.id}.`)
    } catch (error) {
      this.fail(error)
    }
  }

  async openThread(threadId: string): Promise<void> {
    this.eventsAbort?.abort()
    const attachmentHydrationGeneration = ++this.attachmentHydrationGeneration
    this.attachmentMetadataRequests.clear()
    this.patch({ busy: true, busyLabel: 'Opening session', connection: 'connecting' })
    try {
      const delegationRequest = typeof this.client.delegationDiagnostics === 'function'
        ? this.client.delegationDiagnostics(threadId).catch(() => undefined)
        : Promise.resolve(undefined)
      const graphRunsRequest = typeof this.client.listGraphRuns === 'function'
        ? this.client.listGraphRuns(threadId).catch(() => [])
        : Promise.resolve([])
      const [detail, delegation, graphRuns] = await Promise.all([
        this.client.getThread(threadId),
        delegationRequest,
        graphRunsRequest
      ])
      const projection = hydrateProjectedChildRuns(projectThreadSnapshot(detail), delegation)
      const latestConfiguredTurn = [...detail.turns].reverse().find((turn) =>
        turn.model || turn.providerId || turn.accountId || turn.reasoningEffort
      )
      this.options.model = latestConfiguredTurn?.model ?? detail.model
      this.options.providerId = latestConfiguredTurn?.providerId ?? detail.providerId ?? this.options.providerId
      this.options.accountId = latestConfiguredTurn?.accountId ?? detail.accountId ?? this.options.accountId
      const reasoningEffort = this.resolveReasoningEffort({
        model: this.options.model,
        providerId: this.options.providerId,
        accountId: this.options.accountId,
        preferred: latestConfiguredTurn?.reasoningEffort ?? this.stateValue.reasoningEffort
      })
      this.patch({
        view: 'chat',
        projection,
        reasoningEffort,
        composerMode: detail.mode,
        graphRuns,
        attachmentMetadata: {},
        busy: false,
        connection: 'connecting',
        notification: undefined,
        inspection: undefined,
        graphBoard: undefined
      })
      void this.hydrateAttachmentMetadata(
        attachmentIdsFromProjection(projection),
        threadId,
        attachmentHydrationGeneration
      )
      const abort = new AbortController()
      this.eventsAbort = abort
      const subscription = this.client.subscribeThreadEvents({
        threadId,
        sinceSeq: projection.lastSeq,
        signal: abort.signal,
        onConnection: (connection) => {
          if (this.eventsAbort === abort) {
            // Older GUI runtimes implement this endpoint as a long poll and
            // may not flush SSE headers until the next event exists. The
            // authenticated thread snapshot already proved the runtime is
            // reachable, so don't leave an idle legacy session looking
            // disconnected while that first read is intentionally pending.
            this.patch({ connection: this.runtime.legacyGui && connection === 'connecting' ? 'connected' : connection })
          }
        },
        onEvent: (event) => {
          if (this.eventsAbort !== abort || this.stateValue.projection?.thread.id !== threadId) return
          const projection = applyRuntimeEvent(this.stateValue.projection, event)
          if (event.kind === 'turn_started' && !event.child) {
            this.options.model = event.model ?? this.options.model
            this.options.providerId = event.providerId ?? this.options.providerId
            this.options.accountId = event.accountId ?? this.options.accountId
          }
          this.patch({
            projection,
            ...(event.kind === 'turn_started' && !event.child
              ? {
                  reasoningEffort: this.resolveReasoningEffort({
                    model: event.model ?? this.options.model,
                    providerId: event.providerId ?? this.options.providerId,
                    accountId: event.accountId ?? this.options.accountId,
                    preferred: event.reasoningEffort ?? this.stateValue.reasoningEffort
                  })
                }
              : {})
          })
          if (event.kind === 'graph_event') {
            void this.reconcileGraphRun(event.graph.runId, threadId)
          }
          void this.hydrateAttachmentMetadata(
            attachmentIdsFromProjection(projection),
            threadId,
            attachmentHydrationGeneration
          )
        },
        onError: (error) => {
          if (this.eventsAbort !== abort) return
          if (isMissingThread(error)) {
            abort.abort()
            if (this.stateValue.modelConnections) {
              this.applySharedDefaultToActiveSelection(this.stateValue.modelConnections)
            }
            this.patch({
              view: 'chat',
              projection: undefined,
              graphRuns: [],
              connection: 'disconnected',
              notification: { kind: 'error', message: 'This session was removed by another client. Choose or create a session.' }
            })
            void this.refreshThreads('')
            return
          }
          this.patch({ notification: { kind: 'error', message: safeMessage(error) } })
        }
      })
      this.activeSubscription = subscription
      void subscription.finally(() => {
        if (this.eventsAbort === abort && !abort.signal.aborted) this.patch({ connection: 'disconnected' })
      })
    } catch (error) {
      this.fail(error)
    }
  }

  async createThread(title = 'Terminal chat'): Promise<void> {
    this.patch({ busy: true, busyLabel: 'Creating session' })
    try {
      const selection = this.newThreadSelection()
      const snapshot = this.stateValue.modelConnections
      const selectedProfile = snapshot?.providers.find((profile) =>
        profile.id === selection.providerId &&
        (!selection.accountId || profile.accountId === selection.accountId)
      )
      if (
        snapshot &&
        (!selection.providerId || !selection.model || !selectedProfile?.configured)
      ) {
        this.patch({
          busy: false,
          busyLabel: undefined,
          notification: {
            kind: 'error',
            message: 'No connected default model. Use /connect to connect a provider before creating a session.'
          }
        })
        return
      }
      const thread = await this.client.createThread({
        title,
        workspace: this.options.workspace,
        model: selection.model ?? this.runtime.runtimeInfo.model ?? 'deepseek-chat',
        ...(selection.providerId ? { providerId: selection.providerId } : {}),
        ...(selection.accountId ? { accountId: selection.accountId } : {}),
        mode: this.stateValue.composerMode,
        ...(this.options.approvalPolicy
          ? { approvalPolicy: this.options.approvalPolicy }
          : {}),
        ...(this.options.sandboxMode
          ? { sandboxMode: this.options.sandboxMode }
          : {})
      })
      await this.refreshThreads('')
      await this.openThread(thread.id)
    } catch (error) {
      this.fail(error)
    }
  }

  async submit(text: string, modeOverride?: 'agent' | 'plan'): Promise<void> {
    const prompt = text.trim()
    if (!prompt) return
    if (!this.stateValue.projection) {
      await this.createThread(prompt.slice(0, 80))
      if (!this.stateValue.projection) return
    }
    const { thread, runningTurnId } = this.stateValue.projection
    const orchestration = (modeOverride ?? thread.mode) === 'agent'
      ? this.stateValue.composerOrchestration
      : 'direct'
    const activeGraphRun = orchestration === 'graph'
      ? latestTuiGraphRun(this.stateValue.graphRuns, thread.id)
      : undefined
    const steeringGraph = Boolean(
      activeGraphRun && !isTerminalGraphRun(activeGraphRun) && !runningTurnId
    )
    if ((runningTurnId || steeringGraph) && this.stateValue.pendingAttachments.length) {
      this.notify('Attachments are kept for the next new turn; they cannot be added to queued guidance or Graph steering.', 'error')
      return
    }
    this.patch({
      busy: true,
      busyLabel: runningTurnId
        ? 'Queuing guidance'
        : steeringGraph
          ? 'Steering Graph'
          : 'Sending message',
      notification: undefined
    })
    try {
      if (runningTurnId) {
        await this.client.steerTurn(thread.id, runningTurnId, prompt)
        this.patch({ busy: false, notification: { kind: 'info', message: 'Guidance queued for the running turn.' } })
      } else if (steeringGraph && activeGraphRun) {
        const run = await this.client.steerGraphRun(activeGraphRun.id, prompt)
        this.patch({
          busy: false,
          graphRuns: replaceGraphRun(this.stateValue.graphRuns, run),
          notification: {
            kind: 'info',
            message: `Guidance persisted for Graph ${activeGraphRun.id}.`
          }
        })
      } else {
        const pendingAttachments = this.stateValue.pendingAttachments
        const model = this.options.model ?? thread.model
        const providerId = this.options.providerId ?? thread.providerId
        const accountId = this.options.accountId ?? thread.accountId
        const reasoningEffort = this.stateValue.reasoningEffort
        const started = await this.client.startTurn(thread.id, {
          prompt,
          clientSurface: 'tui',
          model,
          ...(providerId ? { providerId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          mode: modeOverride ?? thread.mode,
          orchestration,
          approvalPolicy: thread.approvalPolicy,
          sandboxMode: thread.sandboxMode,
          attachmentIds: pendingAttachments.map((attachment) => attachment.id)
        })
        void Promise.all(
          pendingAttachments.map((attachment) => this.releasePendingAttachment(attachment))
        )
        this.patch({
          projection: setProjectionRunningTurn(
            this.stateValue.projection,
            started.turnId,
            prompt,
            new Date().toISOString(),
            {
              model,
              ...(providerId ? { providerId } : {}),
              ...(accountId ? { accountId } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              mode: modeOverride ?? thread.mode,
              orchestration,
              attachmentIds: pendingAttachments.map((attachment) => attachment.id)
            }
          ),
          busy: false,
          attachmentMetadata: mergeAttachmentMetadata(
            this.stateValue.attachmentMetadata,
            pendingAttachments
          ),
          pendingAttachments: []
        })
      }
    } catch (error) {
      if (isRefreshConflict(error)) await this.refreshActiveThread(error)
      else this.fail(error)
    }
  }

  async interrupt(): Promise<boolean> {
    const projection = this.stateValue.projection
    if (!projection?.runningTurnId) return false
    this.patch({ busy: true, busyLabel: 'Stopping turn' })
    try {
      await this.client.interruptTurn(projection.thread.id, projection.runningTurnId)
      this.patch({ busy: false, notification: { kind: 'info', message: 'Interrupt requested.' } })
      return true
    } catch (error) {
      await this.refreshActiveThread(error)
      return true
    }
  }

  async compact(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    this.patch({ busy: true, busyLabel: 'Compacting conversation' })
    try {
      await this.client.compactThread(projection.thread.id)
      this.patch({ busy: false, notification: { kind: 'info', message: 'Conversation compacted.' } })
      await this.reloadActiveThread()
    } catch (error) {
      this.fail(error)
    }
  }

  async rename(title: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const thread = await this.client.updateThread(projection.thread.id, { title, titleAuto: false })
      this.patch({ projection: { ...projection, thread: { ...projection.thread, ...thread } } })
      await this.refreshThreads(this.stateValue.threadSearch)
    } catch (error) {
      this.fail(error)
    }
  }

  async archive(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      await this.client.updateThread(projection.thread.id, { status: 'archived' })
      this.eventsAbort?.abort()
      this.patch({ view: 'threads', projection: undefined, notification: { kind: 'info', message: 'Session archived.' } })
      await this.refreshThreads('')
    } catch (error) {
      this.fail(error)
    }
  }

  async fork(title?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const fork = await this.client.forkThread(projection.thread.id, { relation: 'fork', ...(title ? { title } : {}) })
      await this.refreshThreads('')
      await this.openThread(fork.id)
    } catch (error) {
      this.fail(error)
    }
  }

  async forkAtTurn(turnId: string, title?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const fork = await this.client.forkThread(projection.thread.id, {
        relation: 'fork', turnId, ...(title ? { title } : {})
      })
      await this.refreshThreads('')
      await this.openThread(fork.id)
    } catch (error) {
      this.fail(error)
    }
  }

  async undoLastTurn(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    if (projection.runningTurnId) {
      this.notify('Interrupt the running turn before undoing.', 'error')
      return
    }
    const turns = projection.thread.turns
    let targetIndex = -1
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.items.some((item) => item.kind === 'user_message')) {
        targetIndex = index
        break
      }
    }
    if (targetIndex < 0) {
      this.notify('There is no user turn to undo.', 'error')
      return
    }
    this.patch({ busy: true })
    try {
      const source = projection.thread
      const branch = await this.client.forkThread(source.id, {
        relation: 'fork',
        turnId: turns[targetIndex]!.id,
        beforeTurn: true,
        title: `${source.title} undo`
      })
      this.redoTargets.set(branch.id, source.id)
      this.persisted = {
        ...this.persisted,
        redoTargets: { ...this.persisted.redoTargets, [branch.id]: source.id }
      }
      await this.savePersistentState()
      await this.refreshThreads('')
      await this.openThread(branch.id)
      this.notify(`Undid the last user turn in a new branch; source ${source.id} is unchanged.`)
    } catch (error) {
      this.fail(error)
    }
  }

  async redoBranch(): Promise<void> {
    const currentId = this.stateValue.projection?.thread.id
    if (!currentId) {
      this.notify('Open a session first.', 'error')
      return
    }
    const explicitTarget = this.redoTargets.get(currentId)
    if (explicitTarget) {
      await this.openThread(explicitTarget)
      this.notify('Restored the source session that was preserved by undo.')
      return
    }
    await this.refreshThreads(this.stateValue.threadSearch, 'active')
    const next = this.stateValue.threads
      .filter((thread) => thread.parentThreadId === currentId && thread.relation === 'fork')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (!next) {
      this.notify('There is no preserved child branch to redo.', 'error')
      return
    }
    await this.openThread(next.id)
    this.notify(`Moved to preserved branch ${next.title || next.id}.`)
  }

  async navigateSessionRelation(direction: 'parent' | 'child' | 'next-sibling' | 'previous-sibling'): Promise<void> {
    const current = this.stateValue.projection?.thread
    if (!current) {
      this.notify('Open a session first.', 'error')
      return
    }
    await this.refreshThreads(this.stateValue.threadSearch)
    let target: ThreadSummary | undefined
    if (direction === 'parent') {
      target = this.stateValue.threads.find((thread) => thread.id === current.parentThreadId)
    } else if (direction === 'child') {
      target = this.stateValue.threads
        .filter((thread) => thread.parentThreadId === current.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    } else {
      const siblings = this.stateValue.threads
        .filter((thread) => thread.parentThreadId && thread.parentThreadId === current.parentThreadId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const index = siblings.findIndex((thread) => thread.id === current.id)
      if (index >= 0 && siblings.length > 1) {
        const delta = direction === 'next-sibling' ? 1 : -1
        target = siblings[(index + delta + siblings.length) % siblings.length]
      }
    }
    if (!target) {
      this.notify(`No ${direction.replace('-', ' ')} session is available.`, 'error')
      return
    }
    await this.openThread(target.id)
  }

  async setPermissions(approvalPolicy: ApprovalPolicy, sandboxMode: SandboxMode): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection) return false
    try {
      const thread = await this.client.updateThread(projection.thread.id, { approvalPolicy, sandboxMode })
      this.patch({
        projection: { ...projection, thread: { ...projection.thread, ...thread } },
        notification: { kind: 'info', message: `Permissions: ${approvalPolicy} · ${sandboxMode}` }
      })
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async setPlanMode(mode: 'agent' | 'plan'): Promise<void> {
    const projection = this.stateValue.projection
    if (!projection) {
      this.patch({ composerMode: mode, composerOrchestration: 'direct' })
      this.notify(`New session mode: ${mode}`)
      return
    }
    try {
      if (projection.thread.goal?.status === 'active') {
        await this.client.setThreadGoal(projection.thread.id, { status: 'paused' })
      }
      const thread = await this.client.updateThread(projection.thread.id, { mode })
      this.patch({
        projection: { ...projection, thread: { ...projection.thread, ...thread } },
        composerMode: mode,
        composerOrchestration: 'direct',
        notification: {
          kind: 'info',
          message: projection.thread.goal?.status === 'active'
            ? `Goal paused · session mode: ${mode}`
            : `Session mode: ${mode}`
        }
      })
    } catch (error) {
      this.fail(error)
    }
  }

  async manageGraphMode(action?: string): Promise<boolean> {
    const requested = action?.trim().toLowerCase() ?? ''
    if (requested === 'status' || requested === 'list') {
      await this.showGraphStatus()
      return true
    }
    if (requested === 'off' || requested === 'direct' || requested === 'agent') {
      this.patch({ composerOrchestration: 'direct' })
      this.notify('Graph mode off · subsequent turns use Direct orchestration.')
      return true
    }
    if (requested && requested !== 'on' && requested !== 'start') {
      this.notify('Usage: /graph [status|off|requirement]', 'error')
      return false
    }
    if (!await this.refreshGraphAvailability(false)) {
      this.patch({ composerOrchestration: 'direct' })
      this.notify(
        this.stateValue.graphUnavailableReason ??
          'Graph Mode is disabled in the shared Kun runtime.',
        'error'
      )
      return false
    }
    const current = this.stateValue.projection
    if (
      current &&
      (current.thread.mode !== 'agent' || current.thread.goal?.status === 'active')
    ) {
      await this.setPlanMode('agent')
    } else {
      this.patch({ composerMode: 'agent', composerOrchestration: 'direct' })
    }
    const active = this.stateValue.projection
    if (active && (
      active.thread.mode !== 'agent' ||
      active.thread.goal?.status === 'active'
    )) return false
    this.patch({
      composerMode: 'agent',
      composerOrchestration: 'graph',
      notification: {
        kind: 'info',
        message: 'Graph mode active · type a requirement and press Enter.'
      }
    })
    return true
  }

  async submitGraphRequirement(prompt: string): Promise<boolean> {
    const requirement = prompt.trim()
    if (!requirement) return false
    if (!await this.manageGraphMode('on')) return false
    await this.submit(requirement)
    return true
  }

  async showGraphStatus(): Promise<void> {
    const threadId = this.stateValue.projection?.thread.id
    if (threadId && typeof this.client.listGraphRuns === 'function') {
      try {
        const graphRuns = await this.client.listGraphRuns(threadId)
        if (this.stateValue.projection?.thread.id === threadId) {
          this.patch({ graphRuns })
        }
      } catch (error) {
        this.notify(`Could not load Graph status: ${safeMessage(error)}`, 'error')
        return
      }
    }
    const run = latestTuiGraphRun(this.stateValue.graphRuns, threadId)
    if (!run) {
      this.notify(
        'No GraphRun is attached to this session. Use /graph <requirement> to start one.',
        'error'
      )
      return
    }
    this.patch({ graphBoard: { runId: run.id }, inspection: undefined })
  }

  dismissGraphBoard(): void {
    this.patch({ graphBoard: undefined })
  }

  openGraphBoard(runId: string): boolean {
    const run = this.stateValue.graphRuns.find((candidate) => candidate.id === runId)
    if (!run) return false
    this.patch({ graphBoard: { runId }, inspection: undefined })
    return true
  }

  reasoningOptions(): readonly ModelReasoningEffort[] {
    return this.reasoningCapability()?.supportedEfforts ?? []
  }

  selectReasoningEffort(effort: ModelReasoningEffort): boolean {
    const options = this.reasoningOptions()
    if (!options.includes(effort)) {
      this.notify(options.length
        ? `Reasoning effort ${effort} is unavailable. Supported: ${options.join(', ')}.`
        : 'The selected model does not expose reasoning variants.', 'error')
      return false
    }
    this.patch({ reasoningEffort: effort })
    this.rememberReasoningEffort(effort)
    this.notify(`Reasoning effort: ${effort}`)
    return true
  }

  cycleReasoningEffort(direction: 1 | -1 = 1): boolean {
    const options = this.reasoningOptions()
    if (options.length <= 1) {
      this.notify(options.length === 1
        ? `This model only supports reasoning effort ${options[0]}.`
        : 'The selected model does not support selectable reasoning effort.', 'error')
      return false
    }
    const current = this.stateValue.reasoningEffort
    const index = Math.max(0, options.indexOf(current ?? options[0]!))
    const next = options[(index + direction + options.length) % options.length]!
    this.patch({ reasoningEffort: next })
    this.rememberReasoningEffort(next)
    this.notify(`Reasoning effort: ${next}`)
    return true
  }

  favoriteModelKeys(): ReadonlySet<string> {
    return new Set(this.persisted.favoriteModels)
  }

  isModelFavorite(providerId: string, accountId: string, model: string): boolean {
    return this.persisted.favoriteModels.includes(modelStateKey(providerId, accountId, model))
  }

  toggleModelFavorite(providerId: string, accountId: string, model: string): boolean {
    const key = modelStateKey(providerId, accountId, model)
    const favorites = new Set(this.persisted.favoriteModels)
    const added = !favorites.delete(key)
    if (added) favorites.add(key)
    this.persisted = { ...this.persisted, favoriteModels: [...favorites] }
    void this.savePersistentState()
    this.notify(`${added ? 'Favorited' : 'Unfavorited'} ${model}.`)
    return added
  }

  recentModels(): readonly TuiRecentModel[] {
    return this.persisted.recentModels
  }

  async selectModel(input: {
    providerId: string
    accountId: string
    model: string
  }): Promise<ModelConnectionSnapshot> {
    const snapshot = this.stateValue.modelConnections
    if (!snapshot) throw new Error('No model catalog is available.')
    if (this.runtime.legacyGui) {
      const profile = snapshot.providers.find((candidate) =>
        candidate.id === input.providerId &&
        candidate.accountId === input.accountId &&
        candidate.models.includes(input.model)
      )
      if (!profile) throw new Error('The selected model is no longer available.')
      const updated: ModelConnectionSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        defaultProviderId: input.providerId,
        defaultAccountId: input.accountId,
        defaultModel: input.model,
        providers: snapshot.providers.map((candidate) => candidate.id === profile.id && candidate.accountId === profile.accountId
          ? { ...candidate, selectedModel: input.model }
          : candidate)
      }
      this.applyModelSelection(updated)
      return updated
    }
    try {
      const updated = await this.client.selectModel({
        expectedRevision: snapshot.revision,
        ...input
      })
      this.applyModelSelection(updated)
      return updated
    } catch (error) {
      if (error instanceof TuiClientError && error.status === 409) {
        const refreshed = await this.client.modelConnections()
        this.applyModelSelection(refreshed, false)
        throw new Error('Model connections changed in another client. The selector was refreshed; choose again.')
      }
      throw error
    }
  }

  async cycleRecentModel(direction: 1 | -1): Promise<boolean> {
    const snapshot = this.stateValue.modelConnections
    const recent = this.persisted.recentModels.filter((entry) => snapshot?.providers.some((profile) =>
      profile.id === entry.providerId && profile.accountId === entry.accountId && profile.models.includes(entry.model)
    ))
    if (!snapshot || recent.length < 2) {
      this.notify('Use /model to select at least two models before cycling recent models.', 'error')
      return false
    }
    const current = recent.findIndex((entry) =>
      entry.providerId === snapshot.defaultProviderId &&
      entry.accountId === snapshot.defaultAccountId &&
      entry.model === snapshot.defaultModel
    )
    const index = (Math.max(0, current) + direction + recent.length) % recent.length
    const target = recent[index]!
    try {
      await this.selectModel(target)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async showPlan(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const { todos } = await this.client.threadTodos(projection.thread.id)
      this.inspect('Plan', [
        `Mode: ${projection.thread.mode}`,
        ...(todos?.items.length
          ? todos.items.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
          : ['No persisted plan tasks.'])
      ])
    } catch (error) {
      this.fail(error)
    }
  }

  async manageAttachments(value?: string): Promise<void> {
    const action = value?.trim() ?? ''
    if (!action || action === 'list') {
      this.inspect('Attachments', this.stateValue.pendingAttachments.length
        ? this.stateValue.pendingAttachments.map((attachment, index) =>
            `${index + 1}. ${attachment.name} · ${attachment.mimeType} · ${formatBytes(attachment.byteSize)}`
          )
        : ['No files are attached to the next message.', 'Usage: /attach <path>'])
      return
    }
    if (action === 'clear') {
      this.clearPendingAttachments()
      return
    }
    if (action.startsWith('remove ')) {
      const index = Number(action.slice('remove '.length).trim()) - 1
      if (!Number.isSafeInteger(index) || !this.stateValue.pendingAttachments[index]) {
        this.notify('Usage: /attach remove <number>', 'error')
        return
      }
      const removed = this.stateValue.pendingAttachments[index]!
      this.patch({
        pendingAttachments: this.stateValue.pendingAttachments.filter((_attachment, itemIndex) => itemIndex !== index)
      })
      void this.releasePendingAttachment(removed)
      this.notify(`Removed ${removed.name} from the next message.`)
      return
    }
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const candidate = isAbsolute(action) ? action : resolve(workspace, action)
    if (this.stateValue.pendingAttachments.length >= 8) {
      this.notify('A turn can contain at most 8 attachments; remove one before uploading another.', 'error')
      return
    }
    this.patch({ busy: true, busyLabel: 'Uploading attachment' })
    try {
      const attachment = await this.uploadLocalAttachment(candidate, workspace)
      const pending = [...this.stateValue.pendingAttachments, attachment]
        .filter((attachment, index, all) => all.findIndex((entry) => entry.id === attachment.id) === index)
      if (pending.length > 8) throw new Error('a turn can contain at most 8 attachments')
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(`Attached ${attachment.name} to the next message.`)
    } catch (error) {
      this.fail(error)
    }
  }

  removeLastPendingAttachment(): boolean {
    const removed = this.stateValue.pendingAttachments.at(-1)
    if (!removed) return false
    this.patch({
      pendingAttachments: this.stateValue.pendingAttachments.slice(0, -1)
    })
    void this.releasePendingAttachment(removed)
    this.notify(`Removed ${removed.name} from the next message.`)
    return true
  }

  clearPendingAttachments(): boolean {
    if (this.stateValue.pendingAttachments.length === 0) return false
    const removed = this.stateValue.pendingAttachments
    this.patch({ pendingAttachments: [] })
    void Promise.all(removed.map((attachment) => this.releasePendingAttachment(attachment)))
    this.notify('Pending attachments cleared.')
    return true
  }

  /**
   * Convert a bracketed paste that consists entirely of local file paths into
   * pending attachments. Returning false tells the composer to preserve the
   * original paste as ordinary text.
   */
  async attachPastedPaths(pastedText: string): Promise<boolean> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const paths = parsePastedFilePaths(pastedText, workspace)
    if (paths.length === 0) return false
    if (this.stateValue.pendingAttachments.length + paths.length > 8) {
      this.notify('The pasted files exceed the 8-attachment limit; their paths were kept in the composer.', 'error')
      return false
    }
    if (paths.some(isVideoPath)) {
      this.notify(
        'Kun does not support video input yet. The pasted video path was kept in the composer.',
        'error'
      )
      return false
    }

    this.patch({ busy: true, busyLabel: paths.length === 1 ? 'Attaching pasted file' : 'Attaching pasted files' })
    try {
      const uploaded: AttachmentMetadata[] = []
      for (const path of paths) {
        uploaded.push(await this.uploadLocalAttachment(path, workspace))
      }
      const pending = [...this.stateValue.pendingAttachments, ...uploaded]
        .filter((attachment, index, all) => all.findIndex((entry) => entry.id === attachment.id) === index)
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(
        uploaded.length === 1
          ? `Attached ${uploaded[0]!.name} from the pasted path.`
          : `Attached ${uploaded.length} files from pasted paths.`
      )
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  /** Upload an image read directly from the operating-system clipboard. */
  async attachClipboardImage(image: ClipboardImage): Promise<boolean> {
    if (this.stateValue.pendingAttachments.length >= 8) {
      this.notify('A turn can contain at most 8 attachments; remove one before pasting another image.', 'error')
      return false
    }
    if (image.bytes.length === 0) {
      this.notify('The clipboard image was empty.', 'error')
      return false
    }
    if (image.bytes.length > 10 * 1024 * 1024) {
      this.notify('The clipboard image exceeds Kun’s 10 MiB upload limit.', 'error')
      return false
    }

    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    this.patch({ busy: true, busyLabel: 'Pasting clipboard image' })
    try {
      const extension = image.mimeType === 'image/jpeg'
        ? 'jpg'
        : image.mimeType === 'image/webp'
          ? 'webp'
          : 'png'
      const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 14)
      const attachment = await this.uploadMemoryAttachment(
        `clipboard-${timestamp}.${extension}`,
        image.mimeType,
        image.bytes,
        workspace
      )
      const pending = [...this.stateValue.pendingAttachments, attachment]
        .filter((candidate, index, all) => all.findIndex((entry) => entry.id === candidate.id) === index)
      this.patch({ busy: false, pendingAttachments: pending })
      this.notify(`Pasted clipboard image as ${attachment.name}.`)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  private async hydrateAttachmentMetadata(
    attachmentIds: readonly string[],
    threadId: string,
    generation: number
  ): Promise<void> {
    if (typeof this.client.getAttachment !== 'function') return
    const pending = [...new Set(attachmentIds)].filter((id) =>
      !this.stateValue.attachmentMetadata[id] && !this.attachmentMetadataRequests.has(id)
    )
    if (pending.length === 0) return
    for (const id of pending) this.attachmentMetadataRequests.add(id)
    const results = await Promise.allSettled(pending.map(async (id) => {
      const response = await this.client.getAttachment(id)
      return response.attachment
    }))
    for (const id of pending) this.attachmentMetadataRequests.delete(id)
    if (
      generation !== this.attachmentHydrationGeneration ||
      this.stateValue.projection?.thread.id !== threadId
    ) return
    const resolved = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    if (resolved.length === 0) return
    this.patch({
      attachmentMetadata: mergeAttachmentMetadata(this.stateValue.attachmentMetadata, resolved)
    })
  }

  /**
   * Keep image attachments queued when the selected model is text-only. This
   * mirrors Kimi Code's send-time capability gate and lets the user switch
   * model without having to paste the path again.
   */
  validatePendingAttachmentsForCurrentModel(): boolean {
    const images = this.stateValue.pendingAttachments.filter((attachment) => attachment.kind === 'image')
    if (images.length === 0) return true
    const snapshot = this.stateValue.modelConnections
    const providerId = this.options.providerId ?? this.stateValue.projection?.thread.providerId ?? snapshot?.defaultProviderId
    const accountId = this.options.accountId ?? this.stateValue.projection?.thread.accountId ?? snapshot?.defaultAccountId
    const model = this.options.model ?? this.stateValue.projection?.thread.model ?? snapshot?.defaultModel
    if (!model) return true
    const profile = snapshot?.providers.find((candidate) =>
      candidate.id === providerId && (!accountId || candidate.accountId === accountId)
    )
    const capabilities = profile?.modelCapabilities?.[model] ?? modelCapabilitiesForProviderModel({
      providerId: profile?.id ?? providerId,
      presetSource: profile?.presetSource,
      baseUrl: profile?.baseUrl,
      kind: profile?.kind,
      model
    })
    if (capabilities.inputModalities.includes('image')) return true
    const label = providerId ? `${providerId}/${model}` : model
    this.notify(
      `${label} does not support image input. The image is still attached; switch with /model or remove it with /attach remove <number>.`,
      'error'
    )
    return false
  }

  async manageMemory(action?: string): Promise<void> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const value = action?.trim() ?? ''
    try {
      await this.ensureLocalCapability('memory')
      if (!value || value === 'list') {
        const { memories } = await this.client.listMemories({ workspace })
        this.inspect('Memory', memories.length
          ? memories.map((memory, index) =>
              `${index + 1}. ${memory.disabledAt ? '[disabled] ' : ''}${memory.content}\n   ${memory.id} · ${memory.scope} · ${memory.tags.join(', ') || 'no tags'}`
            )
          : ['No persistent memories for this workspace.', 'Usage: /memory add <text>'])
        return
      }
      const [verb = '', id = '', ...rest] = splitWords(value)
      if (verb === 'add') {
        const content = [id, ...rest].join(' ').trim()
        if (!content) throw new Error('Usage: /memory add <text>')
        await this.client.createMemory({ content, scope: 'workspace', workspace, tags: [] })
        this.notify('Workspace memory added.')
        return
      }
      if (verb === 'edit') {
        const content = rest.join(' ').trim()
        if (!id || !content) throw new Error('Usage: /memory edit <id> <text>')
        await this.client.updateMemory(id, workspace, { content })
        this.notify('Memory updated.')
        return
      }
      if (verb === 'disable' || verb === 'enable') {
        if (!id) throw new Error(`Usage: /memory ${verb} <id>`)
        await this.client.updateMemory(id, workspace, { disabled: verb === 'disable' })
        this.notify(`Memory ${verb}d.`)
        return
      }
      if (verb === 'delete') {
        if (!id) throw new Error('Usage: /memory delete <id>')
        await this.client.deleteMemory(id, workspace)
        this.notify('Memory deleted.')
        return
      }
      throw new Error('Usage: /memory [list|add <text>|edit <id> <text>|enable <id>|disable <id>|delete <id>]')
    } catch (error) {
      this.fail(error)
    }
  }

  async manageTodos(action?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const value = action?.trim() ?? ''
    try {
      const current = (await this.client.threadTodos(projection.thread.id)).todos?.items ?? []
      if (!value || value === 'list') {
        this.inspect('Plan', current.length
          ? current.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}\n   ${todo.id}`)
          : ['No persisted plan tasks.', 'Usage: /tasks add <task>'])
        return
      }
      const [verb = '', target = '', ...rest] = splitWords(value)
      if (verb === 'clear') {
        await this.client.clearThreadTodos(projection.thread.id)
        this.notify('Plan tasks cleared.')
        return
      }
      let next: Array<{
        id?: string
        content: string
        status: ThreadTodoStatus
        source?: ThreadTodoItem['source']
      }> = current.map(todoInput)
      if (verb === 'add') {
        const content = [target, ...rest].join(' ').trim()
        if (!content) throw new Error('Usage: /tasks add <task>')
        next.push({ content, status: 'pending' })
      } else if (['start', 'done', 'pending'].includes(verb)) {
        const selected = resolveTodo(current, target)
        if (!selected) throw new Error(`Unknown task: ${target}`)
        const status: ThreadTodoStatus = verb === 'start'
          ? 'in_progress'
          : verb === 'done'
            ? 'completed'
            : 'pending'
        next = next.map((todo) => todo.id === selected.id
          ? { ...todo, status }
          : status === 'in_progress' && todo.status === 'in_progress'
            ? { ...todo, status: 'pending' }
            : todo)
      } else if (verb === 'edit') {
        const selected = resolveTodo(current, target)
        const content = rest.join(' ').trim()
        if (!selected || !content) throw new Error('Usage: /tasks edit <number|id> <text>')
        next = next.map((todo) => todo.id === selected.id ? { ...todo, content } : todo)
      } else if (verb === 'delete') {
        const selected = resolveTodo(current, target)
        if (!selected) throw new Error(`Unknown task: ${target}`)
        next = next.filter((todo) => todo.id !== selected.id)
      } else if (verb === 'move') {
        const from = Number(target) - 1
        const to = Number(rest[0]) - 1
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !next[from] || to < 0 || to >= next.length) {
          throw new Error('Usage: /tasks move <from-number> <to-number>')
        }
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved!)
      } else {
        throw new Error('Usage: /tasks [list|add|edit|start|done|pending|delete|move|clear]')
      }
      await this.client.setThreadTodos(projection.thread.id, { todos: next })
      this.notify('Plan tasks updated.')
    } catch (error) {
      this.fail(error)
    }
  }

  async manageGoal(action?: string): Promise<void> {
    const value = action?.trim() ?? ''
    const projection = this.stateValue.projection
    if (!projection) {
      const lowered = value.toLowerCase()
      if (value && !['status', 'pause', 'resume', 'clear', 'cancel'].includes(lowered)) {
        await this.activateGoal(lowered.startsWith('set ') ? value.slice(4).trim() : value)
      } else {
        this.notify('No session goal exists yet. Use /goal <objective> to create one.', 'error')
      }
      return
    }
    try {
      if (!value || value.toLowerCase() === 'status') {
        const { goal } = await this.client.threadGoal(projection.thread.id)
        this.inspect('Goal', goal
          ? [
              `Status: ${goal.status}`,
              `Objective: ${goal.objective}`,
              `Tokens: ${goal.tokensUsed.toLocaleString()}${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''}`,
              `Time: ${goal.timeUsedSeconds}s`
            ]
          : ['No active goal. Use /goal <objective> to create one.'])
        return
      }
      const lowered = value.toLowerCase()
      if (lowered === 'clear' || lowered === 'cancel') {
        await this.clearGoal()
        return
      }
      if (lowered === 'pause' || lowered === 'resume') {
        await this.setGoalStatus(lowered === 'pause' ? 'paused' : 'active')
        return
      }
      const objective = lowered.startsWith('set ') ? value.slice(4).trim() : value
      await this.activateGoal(objective)
    } catch (error) {
      this.fail(error)
    }
  }

  /**
   * Goal is a persistent execution workflow layered on top of agent turns,
   * not a third value in the runtime's ThreadMode contract. Activating it
   * therefore returns the thread to agent mode, saves the durable objective,
   * and launches (or steers) the first goal turn just like the GUI.
   */
  async activateGoal(objective: string, tokenBudget?: number | null): Promise<boolean> {
    const trimmed = objective.trim()
    if (!trimmed) return false
    this.patch({ composerMode: 'agent', composerOrchestration: 'direct' })
    if (!this.stateValue.projection) {
      await this.createThread(trimmed.slice(0, 80))
    }
    const projection = this.requireProjection()
    if (!projection) return false
    this.patch({ busy: true, busyLabel: 'Starting goal' })
    try {
      if (projection.thread.mode !== 'agent') {
        await this.client.updateThread(projection.thread.id, { mode: 'agent' })
      }
      await this.client.setThreadGoal(projection.thread.id, {
        objective: trimmed,
        status: 'active',
        ...(tokenBudget !== undefined ? { tokenBudget } : {})
      })
      await this.reloadActiveThread()
      await this.submit(trimmed, 'agent')
      this.notify('Goal mode active · Kun will keep working until complete, paused, or blocked.')
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async setGoalStatus(status: ThreadGoalStatus): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection?.thread.goal) {
      this.notify('No goal exists yet. Choose Goal mode and enter an objective.', 'error')
      return false
    }
    this.patch({ busy: true, busyLabel: status === 'active' ? 'Resuming goal' : 'Updating goal' })
    try {
      if (status === 'active') {
        this.patch({ composerMode: 'agent', composerOrchestration: 'direct' })
      }
      if (status === 'active' && projection.thread.mode !== 'agent') {
        await this.client.updateThread(projection.thread.id, { mode: 'agent' })
      }
      await this.client.setThreadGoal(projection.thread.id, { status })
      await this.reloadActiveThread()
      if (status === 'active' && !this.stateValue.projection?.runningTurnId) {
        await this.submit('Continue working toward the active goal.', 'agent')
      }
      this.notify(status === 'active' ? 'Goal resumed.' : `Goal ${status}.`)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async setGoalBudget(tokenBudget: number | null): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection?.thread.goal) return false
    try {
      await this.client.setThreadGoal(projection.thread.id, { tokenBudget })
      await this.reloadActiveThread()
      this.notify(tokenBudget === null ? 'Goal token budget removed.' : `Goal token budget: ${tokenBudget.toLocaleString()}`)
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async clearGoal(): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection?.thread.goal) return false
    try {
      await this.client.clearThreadGoal(projection.thread.id)
      await this.reloadActiveThread()
      this.notify('Goal cleared.')
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async showStatus(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const thread = projection.thread
    const graph = latestTuiGraphRun(this.stateValue.graphRuns, thread.id)
    const graphProgress = graph ? summarizeTuiGraphRun(graph) : undefined
    this.inspect('Status', [
      `Connection: ${this.stateValue.connection}`,
      `Runtime: ${this.runtime.runtimeInfo.serviceVersion ?? 'unknown'} · ${this.runtime.runtimeInfo.instanceId ?? 'unknown'} · PID ${this.runtime.runtimeInfo.pid ?? 'unknown'}`,
      `URL: ${this.runtime.baseUrl}`,
      `Session: ${thread.title} (${thread.id})`,
      `State: ${thread.status}${projection.runningTurnId ? ` · turn ${projection.runningTurnId}` : ''}`,
      `Model: ${thread.providerId ? `${thread.providerId}/` : ''}${thread.model}`,
      `Reasoning: ${this.stateValue.reasoningEffort ?? 'model default'}`,
      `Workspace: ${thread.workspace}`,
      `Mode: ${thread.goal?.status === 'active' ? 'goal' : thread.mode}`,
      `Orchestration: ${this.stateValue.composerOrchestration}`,
      ...(graphProgress ? [
        `Graph: ${graphProgress.status} · ${graphProgress.accepted}/${graphProgress.total} accepted · ${graphProgress.activeAgents} active agents · revision ${graphProgress.revision}`
      ] : []),
      ...(thread.goal ? [
        `Goal: ${thread.goal.status} · ${thread.goal.objective}`,
        `Goal usage: ${thread.goal.tokensUsed.toLocaleString()} tokens · ${thread.goal.timeUsedSeconds}s`
      ] : []),
      ...(thread.additionalWorkspaces ?? []).map((path) => `Additional workspace: ${path}`),
      `Permissions: ${thread.approvalPolicy} · ${thread.sandboxMode}`
    ])
  }

  async showMcp(action?: string): Promise<void> {
    try {
      const value = action?.trim() ?? ''
      const [verb = '', serverId = '', transportOrTarget = '', ...arguments_] = splitWords(value)
      if (verb === 'authorize') {
        if (!serverId) throw new Error('Usage: /mcp authorize <server-id>')
        this.patch({ busy: true, busyLabel: 'Authorizing MCP server' })
        const result = await this.client.authorizeMcp(serverId)
        this.patch({ busy: false })
        this.notify(result.authorized
          ? `MCP server ${serverId} authorized.`
          : `MCP server ${serverId} authorization did not complete.`, result.authorized ? 'info' : 'error')
        return
      }
      if (verb === 'reset') {
        const result = await this.client.clearMcpOAuth(serverId || undefined)
        this.notify(result.cleared.length
          ? `Cleared MCP OAuth state: ${result.cleared.join(', ')}`
          : 'No MCP OAuth state needed clearing.')
        return
      }
      if (verb === 'add' || verb === 'edit') {
        if (!serverId || !transportOrTarget || !arguments_.length) {
          throw new Error('Usage: /mcp add <id> <stdio|http|sse|http-oauth> <command-or-url> [args...]')
        }
        const target = arguments_[0]!
        if (transportOrTarget === 'stdio') {
          await this.client.putMcpServer(serverId, {
            enabled: true,
            transport: 'stdio',
            command: target,
            args: arguments_.slice(1),
            env: {},
            headers: {},
            workspaceRoots: [],
            trustScope: 'user',
            trustedWorkspaceRoots: [],
            timeoutMs: 30_000
          })
        } else if (['http', 'sse', 'http-oauth'].includes(transportOrTarget)) {
          await this.client.putMcpServer(serverId, {
            enabled: true,
            transport: transportOrTarget === 'sse' ? 'sse' : 'streamable-http',
            url: target,
            args: [],
            env: {},
            headers: {},
            workspaceRoots: [],
            ...(transportOrTarget === 'http-oauth' ? { oauth: { enabled: true, scopes: [], callbackTimeoutMs: 120_000 } } : {}),
            trustScope: 'user',
            trustedWorkspaceRoots: [],
            timeoutMs: 30_000
          })
        } else {
          throw new Error('Transport must be stdio, http, sse, or http-oauth.')
        }
        this.notify(`MCP server ${serverId} saved and hot-applied.`)
        return
      }
      if (verb === 'enable' || verb === 'disable') {
        if (!serverId) throw new Error(`Usage: /mcp ${verb} <server-id>`)
        await this.client.setMcpServerEnabled(serverId, verb === 'enable')
        this.notify(`MCP server ${serverId} ${verb}d.`)
        return
      }
      if (verb === 'reconnect') {
        if (!serverId) throw new Error('Usage: /mcp reconnect <server-id>')
        const current = await this.client.mcpConfig()
        const configured = current.servers.find((server) => server.id === serverId)
        if (!configured) throw new Error(`Unknown MCP server: ${serverId}`)
        await this.client.setMcpServerEnabled(serverId, false)
        await this.client.setMcpServerEnabled(serverId, true)
        if (configured.oauth) {
          const authorization = await this.client.authorizeMcp(serverId)
          this.notify(authorization.authorized
            ? `MCP server ${serverId} reconnected and authorized.`
            : `MCP server ${serverId} restarted; OAuth still needs authorization.`, authorization.authorized ? 'info' : 'error')
        } else {
          this.notify(`MCP server ${serverId} reconnected.`)
        }
        return
      }
      if (verb === 'delete' || verb === 'remove') {
        if (!serverId) throw new Error(`Usage: /mcp ${verb} <server-id>`)
        await this.client.deleteMcpServer(serverId)
        this.notify(`MCP server ${serverId} removed.`)
        return
      }
      if (value && value !== 'list') {
        throw new Error('Usage: /mcp [list|add|edit|enable|disable|reconnect|delete|authorize|reset]')
      }
      const tools = await this.client.runtimeTools()
      const config = typeof this.client.mcpConfig === 'function'
        ? await this.client.mcpConfig().catch(() => ({ enabled: false, servers: [] }))
        : { enabled: false, servers: [] }
      const oauth = typeof this.client.mcpOAuth === 'function'
        ? await this.client.mcpOAuth().catch(() => ({ servers: [] }))
        : { servers: [] }
      const oauthById = new Map(oauth.servers.map((server) => [server.serverId, server]))
      const diagnosticsById = new Map(tools.mcpServers.map((server) => [server.id, server]))
      this.inspect('MCP servers', config.servers.length || tools.mcpServers.length
        ? [...new Set([...config.servers.map((server) => server.id), ...tools.mcpServers.map((server) => server.id)])]
          .flatMap((id) => {
            const server = diagnosticsById.get(id)
            const configured = config.servers.find((entry) => entry.id === id)
            return [
              `${id}: ${server?.status ?? (configured?.enabled ? 'reloading' : 'disabled')} · ${server?.toolCount ?? 0} tools · ${server?.transport ?? configured?.transport ?? 'unknown'}` +
                (oauthById.get(id) ? ` · OAuth ${oauthById.get(id)!.status}` : ''),
              ...(configured ? [`  Target: ${configured.target} · ${configured.trustScope}`] : []),
              ...(server?.toolNames.length ? [`  Tools: ${server.toolNames.join(', ')}`] : []),
              ...(server?.lastError ? [`  ${server.lastError}`] : []),
              ...(oauthById.get(id)?.lastError ? [`  OAuth: ${oauthById.get(id)!.lastError}`] : [])
            ]
          })
        : [
            'No MCP servers are configured.',
            'Use /mcp add <id> <stdio|http|sse|http-oauth> <target> [args...]'
          ])
    } catch (error) {
      this.fail(error)
    }
  }

  async showTasks(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const [delegation, shells, todos, goal, tools] = await Promise.all([
        this.client.delegationDiagnostics(projection.thread.id),
        this.client.backgroundShells(projection.thread.id),
        this.client.threadTodos(projection.thread.id),
        this.client.threadGoal(projection.thread.id),
        this.client.runtimeTools()
      ])
      const jobs = tools.extensions?.jobs
      const lines = [
        `Subagents: ${delegation.active} active / ${delegation.childRuns.length} total`,
        ...delegation.childRuns.map((run) => `  ${run.status} · ${run.label ?? run.profile ?? run.id} · ${run.prompt}`),
        `Background shells: ${shells.running} active / ${shells.sessions.length} total`,
        ...shells.sessions.map((shell) => `  ${shell.status} · ${shell.command}`),
        `Plan tasks: ${todos.todos?.items.length ?? 0}`,
        ...(todos.todos?.items.map((todo) => `  [${todo.status}] ${todo.content}`) ?? []),
        `Goal: ${goal.goal ? `${goal.goal.status} · ${goal.goal.objective}` : 'none'}`,
        `Extension jobs: ${jobs?.activeCount ?? 0} active / ${jobs?.recent.length ?? 0} recent`,
        ...(jobs?.recent.map((job) => `  ${job.state} · ${job.ownerExtensionId}/${job.kind} · ${job.action}`) ?? [])
      ]
      this.inspect('Tasks', lines)
    } catch (error) {
      this.fail(error)
    }
  }

  async manageSubagents(action?: string): Promise<boolean> {
    const projection = this.requireProjection()
    if (!projection) return false
    const value = action?.trim() ?? ''
    if (!value) return false
    const [verb = '', childId = '', ...arguments_] = splitWords(value)
    try {
      if (verb === 'abort') {
        if (!childId) throw new Error('Usage: /subagents abort <child-id>')
        const result = await this.client.abortDelegation(childId)
        if (!result.aborted) {
          const detail = projectThreadSnapshot(await this.client.getThread(childId))
          if (detail.runningTurnId) {
            await this.client.interruptTurn(childId, detail.runningTurnId)
            this.notify(`Subagent ${childId} interrupted.`)
          } else {
            this.notify(`Subagent ${childId} was not running.`)
          }
        } else {
          this.notify(`Subagent ${childId} aborted.`)
        }
        await this.reloadActiveThread()
        return true
      }
      if (verb === 'detach' || verb === 'background') {
        if (!childId) throw new Error('Usage: /subagents background <child-id>')
        const result = await this.client.detachDelegation(childId)
        this.notify(result.detached
          ? `Subagent ${childId} is continuing in the background.`
          : `Subagent ${childId} cannot be moved to the background.`)
        await this.reloadActiveThread()
        return true
      }
      if (verb === 'retry') {
        if (!childId) throw new Error('Usage: /subagents retry <child-id>')
        const diagnostics = await this.client.delegationDiagnostics(projection.thread.id)
        const child = diagnostics.childRuns.find((run) => run.id === childId)
        if (!child) throw new Error(`Unknown subagent: ${childId}`)
        await this.submit(`Retry the delegated task${child.profile ? ` with profile ${child.profile}` : ''}: ${child.prompt}`)
        return true
      }
      if (verb === 'steer') {
        const guidance = arguments_.join(' ').trim()
        if (!childId || !guidance) throw new Error('Usage: /subagents steer <child-id> <guidance>')
        const detail = projectThreadSnapshot(await this.client.getThread(childId))
        if (!detail.runningTurnId) throw new Error(`Subagent ${childId} is not running.`)
        await this.client.steerTurn(childId, detail.runningTurnId, guidance)
        this.notify(`Guidance queued for subagent ${childId}.`)
        return true
      }
      throw new Error('Usage: /subagents [abort|background|retry|steer] <child-id> [guidance]')
    } catch (error) {
      this.fail(error)
      return true
    }
  }

  async manageShells(action?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const value = action?.trim() ?? ''
    try {
      const [verb = '', sessionId = ''] = splitWords(value)
      if (verb === 'stop') {
        if (!sessionId) throw new Error('Usage: /shells stop <session-id>')
        const result = await this.client.stopBackgroundShell(sessionId)
        this.notify(result.stopped ? `Stopped background shell ${sessionId}.` : `Shell ${sessionId} was not running.`)
        return
      }
      if (verb === 'open' || verb === 'tail') {
        if (!sessionId) throw new Error(`Usage: /shells ${verb} <session-id>`)
        const shell = await this.client.backgroundShell(sessionId)
        this.inspect('Background shell', [
          `ID: ${shell.id}`,
          `Status: ${shell.status}${shell.exitCode !== null ? ` · exit ${shell.exitCode}` : ''}`,
          `Command: ${shell.command}`,
          `CWD: ${shell.cwd}`,
          '',
          shell.output || '(no output)',
          ...(shell.outputTruncated ? ['', '[output truncated]'] : []),
          ...(shell.error ? ['', `Error: ${shell.error}`] : [])
        ])
        return
      }
      if (value && value !== 'list') throw new Error('Usage: /shells [list|open <id>|tail <id>|stop <id>]')
      const shells = await this.client.backgroundShells(projection.thread.id)
      this.inspect('Background shells', shells.sessions.length
        ? shells.sessions.map((shell) =>
            `${shell.id} · ${shell.status}${shell.exitCode !== null ? ` · exit ${shell.exitCode}` : ''}\n  ${shell.command}`
          )
        : ['No background shell sessions for this session.'])
    } catch (error) {
      this.fail(error)
    }
  }

  async manageExtensions(action?: string): Promise<void> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    const value = action?.trim() ?? ''
    try {
      const [verb = '', id = '', ...arguments_] = splitWords(value)
      if (verb === 'inspect') {
        if (!id) throw new Error('Usage: /extensions inspect <archive.kunx>')
        const path = isAbsolute(id) ? id : resolve(workspace, id)
        const result = await this.client.inspectExtension(path)
        const manifest = result.inspection.manifest
        this.inspect('Extension inspection', [
          `${manifest.publisher}.${manifest.name} · ${manifest.version}`,
          manifest.displayName ?? '',
          manifest.description ?? '',
          '',
          `Requested permissions: ${manifest.permissions.join(', ') || 'none'}`,
          'Install with: /extensions install <archive> [--grant=permission,...]'
        ].filter((line, index) => line.length > 0 || index === 3))
        return
      }
      if (verb === 'jobs') {
        const result = await this.client.extensionJobs()
        this.inspect('Extension jobs', result.jobs.length
          ? result.jobs.map((job) =>
              `${job.id} · ${job.state} · ${job.ownerExtensionId}/${job.kind} · attempt ${job.executionAttempt}\n  ${job.progress?.message ?? job.initiatingOperation}${job.error?.message ? `\n  Error: ${job.error.message}` : ''}`
            )
          : ['No extension jobs have been recorded.'])
        return
      }
      if (verb === 'cancel-job') {
        if (!id) throw new Error('Usage: /extensions cancel-job <job-id>')
        const result = await this.client.cancelExtensionJob(id)
        this.notify(result.accepted
          ? `Extension job ${id} cancellation requested.`
          : `Extension job ${id} is already ${result.job.state}.`)
        return
      }
      if (verb === 'install' || verb === 'dev') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <path> [--grant=permission,...]`)
        const path = isAbsolute(id) ? id : resolve(workspace, id)
        const permissions = extensionGrantArguments(arguments_)
        const result = await this.client.installExtension({
          source: verb === 'dev' ? 'development' : 'archive',
          path,
          grantedPermissions: permissions
        })
        this.notify(`Extension ${result.extension.id}@${result.extension.version} installed and enabled.`)
        return
      }
      if (verb === 'index') {
        const [extensionId = '', extensionVersion = '', ...grantFlags] = arguments_
        if (!id || !extensionId || !extensionVersion) {
          throw new Error('Usage: /extensions index <index-url> <publisher.name> <version> [--grant=permission,...]')
        }
        const result = await this.client.installExtension({
          source: 'index',
          indexUrl: id,
          extensionId,
          version: extensionVersion,
          grantedPermissions: extensionGrantArguments(grantFlags)
        })
        this.notify(`Extension ${result.extension.id}@${result.extension.version} installed from index.`)
        return
      }
      if (verb === 'select') {
        if (!id || !arguments_[0]) throw new Error('Usage: /extensions select <publisher.name> <version>')
        await this.client.selectExtensionVersion(id, arguments_[0]!)
        this.notify(`Extension ${id} selected version ${arguments_[0]}.`)
        return
      }
      if (verb === 'permissions') {
        if (!id || !arguments_[0]) {
          throw new Error('Usage: /extensions permissions <publisher.name> <version> [permission,...|none]')
        }
        const permissions = arguments_[1] === undefined || arguments_[1] === 'none'
          ? null
          : arguments_[1]!.split(',').map((entry) => entry.trim()).filter(Boolean)
        await this.client.setExtensionPermissions(id, workspace, arguments_[0]!, permissions)
        this.notify(`Extension ${id} workspace permissions updated.`)
        return
      }
      if (verb === 'enable' || verb === 'disable') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <publisher.name>`)
        await this.client.setExtensionEnabled(id, verb === 'enable', workspace)
        this.notify(`Extension ${id} ${verb}d for this workspace.`)
        return
      }
      if (verb === 'remove' || verb === 'uninstall') {
        if (!id) throw new Error(`Usage: /extensions ${verb} <publisher.name>`)
        await this.client.uninstallExtension(id)
        this.notify(`Extension ${id} removed; extension data was preserved.`)
        return
      }
      if (verb === 'rollback') {
        if (!id) throw new Error('Usage: /extensions rollback <publisher.name>')
        await this.client.rollbackExtension(id)
        this.notify(`Extension ${id} rolled back to its previous selected version.`)
        return
      }
      if (verb === 'reload') {
        if (!id) throw new Error('Usage: /extensions reload <publisher.name>')
        await this.client.reloadExtension(id)
        this.notify(`Development extension ${id} reloaded.`)
        return
      }
      if (verb === 'retry') {
        if (!id) throw new Error('Usage: /extensions retry <publisher.name>')
        const result = await this.client.retryExtension(id)
        this.notify(`Extension ${id} activation retry requested${result.diagnostic.state ? `: ${result.diagnostic.state}` : '.'}`)
        return
      }
      if (value && value !== 'list') {
        throw new Error('Usage: /extensions [list|jobs|cancel-job|inspect|install|dev|index|select|permissions|enable|disable|rollback|reload|retry|remove]')
      }
      const snapshot = await this.client.extensions(workspace)
      this.inspect('Extensions', snapshot.extensions.length
        ? snapshot.extensions.map((extension) => {
            const selected = extension.versions.find((version) => version.version === extension.selectedVersion) ??
              extension.development
            return `${extension.id} · ${(extension.effectiveEnabled ?? extension.globallyEnabled) ? 'enabled' : 'disabled'} · ${extension.selectedVersion ?? 'development'}\n  ${selected?.displayName ?? extension.id}${selected?.description ? ` — ${selected.description}` : ''}`
          })
        : ['No Kun extensions are installed.'])
    } catch (error) {
      this.fail(error)
    }
  }

  setTheme(value?: string): void {
    const themes: TuiThemeName[] = ['kun', 'ocean', 'mono']
    const requested = value?.trim().toLowerCase()
    const next = requested
      ? themes.find((theme) => theme === requested)
      : themes[(themes.indexOf(this.stateValue.theme) + 1) % themes.length]
    if (!next) {
      this.notify(`Unknown theme: ${value}. Available: ${themes.join(', ')}.`, 'error')
      return
    }
    setVisualTheme(next)
    this.persisted = { ...this.persisted, theme: next }
    this.patch({ theme: next })
    void this.savePersistentState()
    this.notify(`TUI theme: ${next}`)
  }

  async showRuntimeConsole(): Promise<void> {
    try {
      const discovery = await readRuntimeDiscovery(this.options.dataDir)
      if (!discovery?.logPath) {
        this.inspect('Runtime console', ['The active runtime did not publish a log path.'])
        return
      }
      const handle = await open(discovery.logPath, 'r')
      let content = ''
      try {
        const metadata = await handle.stat()
        const maxBytes = 1024 * 1024
        const start = Math.max(0, metadata.size - maxBytes)
        const buffer = Buffer.alloc(Math.min(metadata.size, maxBytes))
        if (buffer.length) await handle.read(buffer, 0, buffer.length, start)
        content = buffer.toString('utf8')
      } finally {
        await handle.close()
      }
      const lines = content.split(/\r?\n/u)
      this.inspect('Runtime console', [
        `Log: ${discovery.logPath}`,
        '',
        ...lines.slice(-500)
      ])
    } catch (error) {
      this.fail(error)
    }
  }

  async showWorkspaceDiff(): Promise<void> {
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    this.patch({ busy: true, busyLabel: 'Loading Git diff' })
    try {
      const [{ stdout: unstaged }, { stdout: staged }] = await Promise.all([
        execFile('git', ['diff', '--no-ext-diff', '--no-color'], {
          cwd: workspace,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf8'
        }),
        execFile('git', ['diff', '--cached', '--no-ext-diff', '--no-color'], {
          cwd: workspace,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf8'
        })
      ])
      this.patch({ busy: false })
      const lines = [
        ...(staged.trim() ? ['Staged', ...staged.split(/\r?\n/u), ''] : []),
        ...(unstaged.trim() ? ['Unstaged', ...unstaged.split(/\r?\n/u)] : [])
      ]
      this.inspect('Workspace diff', lines.length ? lines : ['Working tree has no staged or unstaged diff.'])
    } catch (error) {
      this.fail(error)
    }
  }

  async showContext(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const usage = await this.client.usage()
      const bucket = usage.buckets.find((entry) => entry.thread_id === projection.thread.id)
      const providerId = this.options.providerId ?? projection.thread.providerId
      const accountId = this.options.accountId ?? projection.thread.accountId
      const model = this.options.model ?? projection.thread.model
      const contextSnapshot = matchingRequestContextSnapshot(projection, {
        model,
        providerId
      })
      const configuredContextWindow = this.stateValue.modelConnections?.providers.find((provider) =>
        provider.id === providerId && provider.accountId === accountId
      )?.modelCapabilities?.[model]?.contextWindowTokens
      const contextWindow = configuredContextWindow ??
        modelCapabilitiesForProviderModel({ providerId, model }).contextWindowTokens
      const requestLines = contextSnapshot
        ? [
            `Latest request (estimated): ${contextSnapshot.estimatedInputTokens.toLocaleString()} / ${contextSnapshot.contextWindowTokens.toLocaleString()} tokens`,
            `Auto-compact threshold: ${contextSnapshot.softThresholdTokens.toLocaleString()} tokens`,
            `Hard threshold: ${contextSnapshot.hardThresholdTokens.toLocaleString()} tokens`
          ]
        : [
            'Latest request: no request-local context snapshot yet',
            `Context window: ${contextWindow ? `${contextWindow.toLocaleString()} tokens` : 'unknown'}`
          ]
      const usageLines = bucket
        ? [
            'Cumulative usage (not context occupancy):',
            `Input: ${bucket.input_tokens.toLocaleString()} tokens`,
            `Output: ${bucket.output_tokens.toLocaleString()} tokens`,
            `Reasoning: ${bucket.reasoning_tokens.toLocaleString()} tokens`,
            `Cached: ${bucket.cached_tokens.toLocaleString()} tokens`,
            `Total: ${bucket.total_tokens.toLocaleString()} tokens`,
            `Turns: ${bucket.turns}`
          ]
        : ['No cumulative usage has been recorded for this thread.']
      this.inspect('Context', [...requestLines, '', ...usageLines])
    } catch (error) {
      this.fail(error)
    }
  }

  showCapabilities(): void {
    const capabilities = this.runtime.runtimeInfo.capabilities
    const rows: Array<{
      name: string
      state: { enabled: boolean; available: boolean; reason?: string }
      action: string
      details?: string
    }> = [
      {
        name: 'Model chat',
        state: { enabled: true, available: true },
        action: '/connect · /model',
        details: capabilities.model.id
      },
      { name: 'Attachments', state: capabilities.attachments, action: '/attach <path>' },
      { name: 'Memory', state: capabilities.memory, action: '/memory' },
      {
        name: 'Skills',
        state: capabilities.skills,
        action: '/skills',
        details: `${capabilities.skills.discoveredSkills} discovered`
      },
      {
        name: 'MCP tools',
        state: capabilities.mcp,
        action: '/mcp',
        details: `${capabilities.mcp.connectedServers}/${capabilities.mcp.configuredServers} connected · ${capabilities.mcp.toolCount} tools`
      },
      {
        name: 'Subagents',
        state: capabilities.subagents,
        action: '/subagents',
        details: `${capabilities.subagents.maxParallel} parallel`
      },
      { name: 'Web fetch', state: capabilities.web.fetch, action: 'shared runtime config' },
      { name: 'Web search', state: capabilities.web.search, action: 'shared runtime config' },
      { name: 'Image generation', state: capabilities.imageGen, action: '/connect' },
      { name: 'Speech generation', state: capabilities.speechGen, action: '/connect' },
      { name: 'Music generation', state: capabilities.musicGen, action: '/connect' },
      { name: 'Video generation', state: capabilities.videoGen, action: '/connect' }
    ]
    this.inspect('Capabilities', rows.flatMap((row) => [
      `${row.state.available ? '✓' : row.state.enabled ? '!' : '○'} ${row.name} · ${row.state.available ? 'available' : row.state.enabled ? 'unavailable' : 'disabled'}${row.details ? ` · ${row.details}` : ''}`,
      `  ${row.state.available ? row.action : row.state.reason ?? `Enable it through ${row.action}.`}`
    ]))
  }

  async showQueue(action?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    if (!projection.runningTurnId) {
      this.inspect('Queued guidance', ['No turn is running.'])
      return
    }
    try {
      const current = await this.client.steeringQueue(projection.thread.id, projection.runningTurnId)
      const value = action?.trim() ?? ''
      if (!value || value === 'list') {
        this.inspect('Queued guidance', current.entries.length
          ? current.entries.map((entry, index) => `${index + 1}. ${entry.displayText ?? entry.text}`)
          : ['No queued steer messages.'])
        return
      }
      const [verb = '', target = '', ...rest] = splitWords(value)
      let entries = current.entries.map((entry) => ({ ...entry }))
      if (verb === 'clear') {
        entries = []
      } else if (verb === 'delete') {
        const index = Number(target) - 1
        if (!Number.isSafeInteger(index) || !entries[index]) throw new Error('Usage: /queue delete <number>')
        entries.splice(index, 1)
      } else if (verb === 'edit') {
        const index = Number(target) - 1
        const text = rest.join(' ').trim()
        if (!Number.isSafeInteger(index) || !entries[index] || !text) {
          throw new Error('Usage: /queue edit <number> <text>')
        }
        entries[index] = { text, displayText: text }
      } else if (verb === 'move') {
        const from = Number(target) - 1
        const to = Number(rest[0]) - 1
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !entries[from] || to < 0 || to >= entries.length) {
          throw new Error('Usage: /queue move <from-number> <to-number>')
        }
        const [moved] = entries.splice(from, 1)
        entries.splice(to, 0, moved!)
      } else {
        throw new Error('Usage: /queue [list|delete <n>|edit <n> <text>|move <from> <to>|clear]')
      }
      await this.client.replaceSteeringQueue(projection.thread.id, projection.runningTurnId, { entries })
      this.notify('Queued guidance updated.')
    } catch (error) {
      this.fail(error)
    }
  }

  async initializeWorkspace(extra?: string): Promise<void> {
    const suffix = extra?.trim() ? `\nAdditional user guidance: ${extra.trim()}` : ''
    await this.submit(
      'Analyze this repository and create or update the workspace-root AGENTS.md with accurate project structure, development commands, conventions, validation steps, and safety constraints. Preserve useful existing instructions, verify facts from the repository, and keep the file concise and actionable.' + suffix
    )
  }

  async invokeSkill(name: string, prompt?: string): Promise<void> {
    try {
      const skills = await this.client.skills(this.stateValue.projection?.thread.workspace ?? this.options.workspace)
      const normalized = name.toLowerCase()
      const skill = skills.skills.find((entry) => entry.id.toLowerCase() === normalized || entry.name.toLowerCase() === normalized)
      if (!skill) {
        this.notify(`Unknown skill: ${name}. Run /skills to browse available skills.`, 'error')
        return
      }
      await this.submit(`/skill:${skill.id} ${prompt?.trim() || 'Apply this skill and ask for any task details you still need.'}`)
    } catch (error) {
      this.fail(error)
    }
  }

  async manageSkills(
    action?: string,
    editText?: (initial: string) => Promise<string>
  ): Promise<boolean> {
    const value = action?.trim() ?? ''
    const [verb = '', idOrPath = '', ...rest] = splitWords(value)
    if (!['create', 'import', 'edit', 'enable', 'disable', 'delete'].includes(verb)) return false
    const workspace = this.stateValue.projection?.thread.workspace ?? this.options.workspace
    try {
      const workspaceRoot = await realpath(workspace)
      const managedRoot = join(workspaceRoot, '.kun', 'skills')
      const snapshot = await this.client.skills(workspaceRoot)
      if (!snapshot.enabled && ['create', 'import', 'enable'].includes(verb)) {
        await this.client.setSkillsEnabled(true)
      }
      if (verb === 'create') {
        const id = normalizeSkillId(idOrPath)
        if (!id) throw new Error('Usage: /skills create <id> [description]')
        const destination = join(managedRoot, id)
        await assertPathMissing(destination)
        await mkdir(destination, { recursive: true, mode: 0o700 })
        const description = rest.join(' ').trim() || `Workspace skill ${id}`
        await writeFile(join(destination, 'SKILL.md'), skillTemplate(id, description), {
          encoding: 'utf8',
          mode: 0o600
        })
        await this.client.refreshSkills()
        this.notify(`Created skill ${id}. Use /skills edit ${id} to add instructions.`)
        return true
      }
      if (verb === 'import') {
        if (!idOrPath) throw new Error('Usage: /skills import <directory>')
        const source = await realpath(isAbsolute(idOrPath) ? idOrPath : resolve(workspaceRoot, idOrPath))
        if (!(await stat(source)).isDirectory()) throw new Error('Skill import source must be a directory.')
        await stat(join(source, 'SKILL.md'))
        await validateSkillImportTree(source)
        const id = normalizeSkillId(rest[0] || basename(source))
        if (!id) throw new Error('Skill directory name is not a valid id.')
        const destination = join(managedRoot, id)
        await assertPathMissing(destination)
        await mkdir(managedRoot, { recursive: true, mode: 0o700 })
        try {
          await cp(source, destination, {
            recursive: true,
            errorOnExist: true,
            force: false,
            filter: (sourcePath) => basename(sourcePath) !== '.git'
          })
        } catch (error) {
          await rm(destination, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        await this.client.refreshSkills()
        this.notify(`Imported skill ${id}.`)
        return true
      }
      if (verb === 'enable' || verb === 'disable') {
        const id = normalizeSkillId(idOrPath)
        if (!id) throw new Error(`Usage: /skills ${verb} <id>`)
        const loaded = await loadKunProjectConfig(workspaceRoot)
        if (loaded.status === 'invalid') throw new Error(loaded.message)
        const config = loaded.status === 'valid'
          ? loaded.config
          : KunProjectConfigSchema.parse({ version: 1 })
        const disabled = new Set(config.skills.disabledIds.map(normalizeSkillId).filter(Boolean))
        if (verb === 'disable') disabled.add(id)
        else disabled.delete(id)
        const next = {
          ...config,
          skills: { ...config.skills, disabledIds: [...disabled].sort() }
        }
        await writeKunProjectConfig(workspaceRoot, `${JSON.stringify(next, null, 2)}\n`)
        await this.client.refreshSkills()
        this.notify(`Skill ${id} ${verb}d for this workspace.`)
        return true
      }
      const skill = snapshot.skills.find((entry) =>
        entry.id === normalizeSkillId(idOrPath) || entry.name.toLowerCase() === idOrPath.toLowerCase()
      )
      if (!skill) throw new Error(`Unknown visible skill: ${idOrPath}`)
      if (verb === 'edit') {
        if (!editText) throw new Error('External editor integration is unavailable.')
        const path = join(skill.root, 'SKILL.md')
        const original = await readFile(path, 'utf8')
        const edited = await editText(original)
        await writeTextAtomically(path, edited)
        await this.client.refreshSkills()
        this.notify(`Updated skill ${skill.id}.`)
        return true
      }
      if (verb === 'delete') {
        if (rest[0] !== '--yes') {
          throw new Error(`Deleting a skill is permanent. Re-run: /skills delete ${skill.id} --yes`)
        }
        const canonicalManagedRoot = await realpath(managedRoot)
        const canonicalSkillRoot = await realpath(skill.root)
        if (!isPathInside(canonicalManagedRoot, canonicalSkillRoot) || canonicalSkillRoot === canonicalManagedRoot) {
          throw new Error('Only skills managed under <workspace>/.kun/skills can be deleted from TUI.')
        }
        await rm(canonicalSkillRoot, { recursive: true, force: false })
        await this.client.refreshSkills()
        this.notify(`Deleted managed skill ${skill.id}.`)
        return true
      }
      return false
    } catch (error) {
      this.fail(error)
      return true
    }
  }

  async addDirectory(path: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const candidate = isAbsolute(path) ? path : resolve(projection.thread.workspace, path)
      const canonical = await realpath(candidate)
      if (!(await stat(canonical)).isDirectory()) throw new Error(`not a directory: ${canonical}`)
      const roots = new Set(await Promise.all(
        [projection.thread.workspace, ...(projection.thread.additionalWorkspaces ?? [])]
          .map((entry) => realpath(entry).catch(() => resolve(entry)))
      ))
      if (roots.has(canonical)) {
        this.notify(`Workspace already available: ${canonical}`)
        return
      }
      const thread = await this.client.updateThread(projection.thread.id, {
        additionalWorkspaces: [...(projection.thread.additionalWorkspaces ?? []), canonical]
      })
      this.patch({
        projection: { ...projection, thread: { ...projection.thread, ...thread } },
        notification: { kind: 'info', message: `Additional workspace added: ${canonical}` }
      })
    } catch (error) {
      this.fail(error)
    }
  }

  async askSideQuestion(question: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const side = await this.client.forkThread(projection.thread.id, {
        relation: 'side', title: `${projection.thread.title} · side`
      })
      await this.client.startTurn(side.id, {
        prompt: question,
        clientSurface: 'tui',
        model: side.model,
        mode: side.mode,
        approvalPolicy: side.approvalPolicy,
        sandboxMode: side.sandboxMode
      })
      await this.openThread(side.id)
      this.notify(`Side question started in ${side.id}; the main thread is unchanged.`)
    } catch (error) {
      this.fail(error)
    }
  }

  inspect(title: string, lines: string[]): void {
    this.patch({ inspection: { title, lines } })
  }

  dismissInspection(): void {
    this.patch({ inspection: undefined })
  }

  async decideApproval(decision: 'allow' | 'deny'): Promise<void> {
    const pending = this.stateValue.projection?.pendingApproval
    if (!pending) return
    this.patch({ busy: true, busyLabel: decision === 'allow' ? 'Approving tool' : 'Denying tool' })
    try {
      await this.client.decideApproval(pending.approvalId, decision)
      this.patch({ busy: false })
    } catch (error) {
      await this.refreshActiveThread(error)
    }
  }

  async resolveUserInput(answers: UserInputAnswer[]): Promise<void> {
    const pending = this.stateValue.projection?.pendingUserInput
    if (!pending) return
    this.patch({ busy: true, busyLabel: 'Sending your answer' })
    try {
      await this.client.resolveUserInput(pending.inputId, answers)
      this.patch({ busy: false })
    } catch (error) {
      await this.refreshActiveThread(error)
    }
  }

  async cancelUserInput(): Promise<void> {
    const pending = this.stateValue.projection?.pendingUserInput
    if (!pending) return
    this.patch({ busy: true, busyLabel: 'Cancelling question' })
    try {
      await this.client.cancelUserInput(pending.inputId)
      this.patch({ busy: false })
    } catch (error) {
      await this.refreshActiveThread(error)
    }
  }

  showThreads(search = '', mode: 'active' | 'archived' = 'active'): void {
    this.patch({ view: 'threads', threadListMode: mode, selectedThreadIndex: 0 })
    void this.refreshThreads(search, mode)
  }

  async resumeLatest(search = ''): Promise<void> {
    if (search.trim()) {
      this.showThreads(search, 'active')
      return
    }
    await this.refreshThreads('', 'active')
    const latest = this.stateValue.threads[0]
    if (latest) await this.openThread(latest.id)
    else this.notify('No saved session is available. Start typing to create one.', 'error')
  }

  showHelp(): void {
    this.patch({ view: 'help' })
  }

  showChat(): void {
    this.patch({ view: 'chat' })
  }

  requestQuit(): void {
    this.patch({ quitRequested: true })
  }

  notify(message: string, kind: 'info' | 'error' = 'info'): void {
    this.patch({ notification: { kind, message } })
  }

  private async refreshGraphAvailability(notify: boolean): Promise<boolean> {
    if (typeof this.client.graphAvailability !== 'function') {
      const reason = 'The connected Kun runtime does not support TUI Graph mode.'
      this.patch({
        graphAvailable: false,
        graphUnavailableReason: reason,
        composerOrchestration: 'direct'
      })
      if (notify) this.notify(reason, 'error')
      return false
    }
    try {
      const availability = await this.client.graphAvailability()
      const reason = availability.enabled
        ? undefined
        : 'Graph Mode is disabled in the shared Kun runtime configuration.'
      this.patch({
        graphAvailable: availability.enabled,
        graphUnavailableReason: reason,
        ...(!availability.enabled ? { composerOrchestration: 'direct' as const } : {})
      })
      if (notify && reason) this.notify(reason, 'error')
      return availability.enabled
    } catch (error) {
      const reason = error instanceof TuiClientError && error.status === 404
        ? 'The connected Kun runtime does not support TUI Graph mode.'
        : `Graph Mode availability could not be verified: ${safeMessage(error)}`
      this.patch({
        graphAvailable: false,
        graphUnavailableReason: reason,
        composerOrchestration: 'direct'
      })
      if (notify) this.notify(reason, 'error')
      return false
    }
  }

  private async reconcileGraphRun(runId: string, threadId: string): Promise<void> {
    if (typeof this.client.getGraphRun !== 'function') return
    if (this.graphRunRequests.has(runId)) {
      this.graphRunRefreshPending.add(runId)
      return
    }
    this.graphRunRequests.add(runId)
    try {
      do {
        this.graphRunRefreshPending.delete(runId)
        const run = await this.client.getGraphRun(runId)
        if (
          this.stateValue.projection?.thread.id !== threadId ||
          run.threadId !== threadId
        ) return
        this.patch({ graphRuns: replaceGraphRun(this.stateValue.graphRuns, run) })
      } while (this.graphRunRefreshPending.has(runId))
    } catch (error) {
      if (this.stateValue.projection?.thread.id === threadId) {
        this.notify(`Graph progress refresh failed: ${safeMessage(error)}`, 'error')
      }
    } finally {
      this.graphRunRequests.delete(runId)
      this.graphRunRefreshPending.delete(runId)
    }
  }

  private async reloadActiveThread(): Promise<void> {
    const id = this.stateValue.projection?.thread.id
    if (id) await this.openThread(id)
  }

  private async refreshActiveThread(error: unknown): Promise<void> {
    this.patch({ notification: { kind: 'error', message: safeMessage(error) }, busy: false })
    await this.reloadActiveThread()
  }

  private requireProjection(): ThreadProjection | undefined {
    const projection = this.stateValue.projection
    if (!projection) this.notify('Open or create a session first.', 'error')
    return projection
  }

  private reasoningCapability(input: {
    snapshot?: ModelConnectionSnapshot
    providerId?: string
    accountId?: string
    model?: string
  } = {}): ModelReasoningCapabilityMetadata | undefined {
    const snapshot = input.snapshot ?? this.stateValue.modelConnections
    const providerId = input.providerId ?? this.options.providerId ?? snapshot?.defaultProviderId
    const model = input.model ?? this.options.model ?? this.stateValue.projection?.thread.model ?? snapshot?.defaultModel
    if (!model) return undefined
    const profile = snapshot?.providers.find((entry) =>
      (entry.id === providerId && (!input.accountId || entry.accountId === input.accountId)) ||
      (!providerId && entry.models.includes(model))
    )
    const derived = profile?.modelCapabilities?.[model]?.reasoning
    const builtIn = modelCapabilitiesForProviderModel({
      providerId: profile?.id ?? providerId,
      presetSource: profile?.presetSource,
      baseUrl: profile?.baseUrl,
      kind: profile?.kind,
      model
    }).reasoning
    if (derived) {
      if (
        builtIn &&
        (
          (
            profile?.endpointFormat === 'chat_completions' &&
            derived.requestProtocol === 'openai-responses' &&
            builtIn.requestProtocol === 'openai-chat-completions' &&
            (
              (
                profile.id.toLowerCase().includes('kimi-code') &&
                model.trim().toLowerCase() === 'k3'
              ) ||
              (
                profile.id.toLowerCase().includes('opencode-go') &&
                model.trim().toLowerCase().endsWith('grok-4.5')
              )
            )
          ) ||
          (
            builtIn.requestProtocol !== 'none' &&
            derived.requestProtocol === 'none' &&
            derived.defaultEffort === 'auto' &&
            derived.supportedEfforts.every((effort) => effort === 'auto' || effort === 'off')
          )
        )
      ) {
        return builtIn
      }
      return derived
    }
    const runtimeCapability = this.runtime.runtimeInfo.capabilities?.model
    const runtimeReasoning = runtimeCapability?.id === model
      ? runtimeCapability.reasoning
      : undefined
    if (runtimeReasoning) return runtimeReasoning
    // Older GUI runtimes and early registry snapshots did not publish
    // per-model capabilities. Fall back only to Kun's audited built-in model
    // profiles; unknown/custom model ids still resolve without reasoning.
    return builtIn
  }

  private resolveReasoningEffort(input: {
    snapshot?: ModelConnectionSnapshot
    providerId?: string
    accountId?: string
    model?: string
    preferred?: ModelReasoningEffort
  }): ModelReasoningEffort | undefined {
    const capability = this.reasoningCapability(input)
    if (!capability) return input.preferred
    if (input.preferred && capability.supportedEfforts.includes(input.preferred)) return input.preferred
    const providerId = input.providerId ?? this.options.providerId
    const accountId = input.accountId ?? this.options.accountId
    const model = input.model ?? this.options.model
    if (providerId && accountId && model) {
      const remembered = this.persisted.reasoningByModel[modelStateKey(providerId, accountId, model)]
      if (remembered && capability.supportedEfforts.includes(remembered)) return remembered
    }
    return capability.defaultEffort
  }

  private rememberReasoningEffort(effort: ModelReasoningEffort): void {
    const providerId = this.options.providerId
    const accountId = this.options.accountId
    const model = this.options.model
    if (!providerId || !accountId || !model) return
    const key = modelStateKey(providerId, accountId, model)
    this.persisted = {
      ...this.persisted,
      reasoningByModel: { ...this.persisted.reasoningByModel, [key]: effort }
    }
    void this.savePersistentState()
  }

  private async recordRecentModel(entry: TuiRecentModel): Promise<void> {
    const key = modelStateKey(entry.providerId, entry.accountId, entry.model)
    this.persisted = {
      ...this.persisted,
      recentModels: [
        entry,
        ...this.persisted.recentModels.filter((candidate) =>
          modelStateKey(candidate.providerId, candidate.accountId, candidate.model) !== key
        )
      ].slice(0, 20)
    }
    await this.savePersistentState()
  }

  private async savePersistentState(): Promise<void> {
    const snapshot = this.persisted
    const write = this.persistenceWrite.catch(() => undefined).then(async () => {
      await writeTuiPersistentState(this.options.dataDir, snapshot)
    }).catch((error) => {
      this.notify(`Could not save TUI state: ${safeMessage(error)}`, 'error')
    })
    this.persistenceWrite = write
    await write
  }

  private initializePersistence(): Promise<void> {
    this.persistenceInitialization ??= (async () => {
      this.persisted = await readTuiPersistentState(this.options.dataDir)
      this.redoTargets.clear()
      for (const [branchId, sourceId] of Object.entries(this.persisted.redoTargets)) {
        this.redoTargets.set(branchId, sourceId)
      }
      setVisualTheme(this.persisted.theme)
      this.patch({ theme: this.persisted.theme })
    })()
    return this.persistenceInitialization
  }

  private newThreadSelection(snapshot = this.stateValue.modelConnections): {
    providerId?: string
    accountId?: string
    model?: string
  } {
    const override = this.newThreadSelectionOverride
    let providerId = override.providerId ?? snapshot?.defaultProviderId
    let accountId = override.accountId ??
      (providerId === snapshot?.defaultProviderId ? snapshot?.defaultAccountId : undefined)
    let profile = snapshot?.providers.find((entry) =>
      entry.id === providerId && (!accountId || entry.accountId === accountId)
    )

    if (!override.providerId && override.model && profile && !profile.models.includes(override.model)) {
      profile = snapshot?.providers.find((entry) =>
        entry.models.includes(override.model!) &&
        (!override.accountId || entry.accountId === override.accountId)
      )
      providerId = profile?.id ?? providerId
      accountId = override.accountId ?? profile?.accountId ?? accountId
    }

    const model = override.model ??
      (providerId === snapshot?.defaultProviderId ? snapshot?.defaultModel : undefined) ??
      profile?.selectedModel ??
      profile?.models[0]
    const resolvedAccountId = accountId ?? profile?.accountId
    return {
      ...(providerId ? { providerId } : {}),
      ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
      ...(model ? { model } : {})
    }
  }

  private applySharedDefaultToActiveSelection(snapshot: ModelConnectionSnapshot): void {
    const selection = this.newThreadSelection(snapshot)
    this.options.providerId = selection.providerId
    this.options.accountId = selection.accountId
    this.options.model = selection.model
  }

  private async ensureLocalCapability(id: 'attachments' | 'memory'): Promise<void> {
    if (this.locallyEnabledCapabilities.has(id) || this.runtime.runtimeInfo.capabilities[id].available) return
    await this.client.setLocalCapabilityEnabled(id, true)
    this.locallyEnabledCapabilities.add(id)
  }

  private async uploadLocalAttachment(candidate: string, workspace: string): Promise<AttachmentMetadata> {
    await this.ensureLocalCapability('attachments')
    const canonical = await realpath(candidate)
    const metadata = await stat(canonical)
    if (!metadata.isFile()) throw new Error('attachment path must be a regular file')
    if (metadata.size > 10 * 1024 * 1024) throw new Error('attachment exceeds the 10 MiB upload limit')
    const data = await readFile(canonical)
    const mimeType = attachmentMimeType(canonical, data)
    if (mimeType === 'application/octet-stream') {
      throw new Error(`unsupported attachment type: ${basename(canonical)}`)
    }
    const response = await this.client.uploadAttachment({
      name: basename(canonical),
      mimeType,
      dataBase64: data.toString('base64'),
      localFilePath: canonical,
      leaseId: this.attachmentLeaseId,
      ...(this.stateValue.projection?.thread.id
        ? { threadId: this.stateValue.projection.thread.id }
        : {}),
      workspace
    })
    return response.attachment
  }

  private async uploadMemoryAttachment(
    name: string,
    mimeType: ClipboardImage['mimeType'],
    data: Buffer,
    workspace: string
  ): Promise<AttachmentMetadata> {
    await this.ensureLocalCapability('attachments')
    const response = await this.client.uploadAttachment({
      name,
      mimeType,
      dataBase64: data.toString('base64'),
      leaseId: this.attachmentLeaseId,
      ...(this.stateValue.projection?.thread.id
        ? { threadId: this.stateValue.projection.thread.id }
        : {}),
      workspace
    })
    return response.attachment
  }

  private async releasePendingAttachment(attachment: AttachmentMetadata): Promise<void> {
    if (typeof this.client.releaseAttachment !== 'function') return
    await this.client.releaseAttachment(attachment.id, this.attachmentLeaseId).catch(() => undefined)
  }

  private fail(error: unknown): void {
    this.patch({ busy: false, notification: { kind: 'error', message: safeMessage(error) } })
  }

  private patch(patch: Partial<TuiControllerState>): void {
    const normalized = { ...patch }
    if (patch.busy === true) {
      const busyLabel = patch.busyLabel ?? this.stateValue.busyLabel ?? 'Working'
      const phaseChanged = !this.stateValue.busy || busyLabel !== this.stateValue.busyLabel
      normalized.busyLabel = busyLabel
      normalized.busyStartedAt = phaseChanged
        ? new Date().toISOString()
        : this.stateValue.busyStartedAt ?? new Date().toISOString()
    } else if (patch.busy === false) {
      normalized.busyLabel = undefined
      normalized.busyStartedAt = undefined
    }
    this.stateValue = { ...this.stateValue, ...normalized }
    for (const listener of this.listeners) listener(this.stateValue)
  }
}

function safeMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error))
}

function isRefreshConflict(error: unknown): boolean {
  return error instanceof TuiClientError && (error.status === 404 || error.status === 409)
}

function isMissingThread(error: unknown): boolean {
  return error instanceof TuiClientError && (error.status === 404 || error.status === 410)
}

function replaceGraphRun(
  runs: readonly GraphRunV1[],
  run: GraphRunV1
): GraphRunV1[] {
  return [run, ...runs.filter((candidate) => candidate.id !== run.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function splitWords(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean)
}

function extensionGrantArguments(arguments_: string[]): string[] {
  const grant = arguments_.find((argument) => argument.startsWith('--grant='))
  if (!grant) return []
  return [...new Set(grant.slice('--grant='.length).split(',')
    .map((permission) => permission.trim())
    .filter(Boolean))]
}

function todoInput(todo: ThreadTodoItem): {
  id: string
  content: string
  status: ThreadTodoStatus
  source?: ThreadTodoItem['source']
} {
  return {
    id: todo.id,
    content: todo.content,
    status: todo.status,
    ...(todo.source ? { source: todo.source } : {})
  }
}

function resolveTodo(items: ThreadTodoItem[], target: string): ThreadTodoItem | undefined {
  const ordinal = Number(target)
  if (Number.isSafeInteger(ordinal) && ordinal > 0) return items[ordinal - 1]
  return items.find((item) => item.id === target)
}

function attachmentIdsFromProjection(projection: ThreadProjection): string[] {
  return [...new Set([
    ...projection.thread.turns.flatMap((turn) => turn.attachmentIds),
    ...projection.items.flatMap((item) => item.kind === 'user_message' ? item.attachmentIds ?? [] : [])
  ])]
}

function mergeAttachmentMetadata(
  current: Readonly<Record<string, AttachmentMetadata>>,
  attachments: readonly AttachmentMetadata[]
): Record<string, AttachmentMetadata> {
  if (attachments.length === 0) return { ...current }
  const next = { ...current }
  for (const attachment of attachments) next[attachment.id] = attachment
  return next
}

function attachmentMimeType(path: string, data?: Buffer): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.md': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.csv': return 'text/csv'
    default: return data && isLikelyUtf8Text(data) ? 'text/plain' : 'application/octet-stream'
  }
}

function isLikelyUtf8Text(data: Buffer): boolean {
  if (data.includes(0)) return false
  return !data.toString('utf8').includes('\uFFFD')
}

function isVideoPath(path: string): boolean {
  return new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']).has(extname(path).toLowerCase())
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
}

function normalizeSkillId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(normalized) ? normalized : ''
}

function skillTemplate(id: string, description: string): string {
  return [
    '---',
    `name: ${id}`,
    `description: ${description.replaceAll('\n', ' ').trim()}`,
    '---',
    '',
    `# ${id}`,
    '',
    'Describe when this skill should be used and the exact workflow Kun should follow.',
    ''
  ].join('\n')
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`Path already exists: ${path}`)
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await renameFile(temporary, path)
}

function isPathInside(parent: string, target: string): boolean {
  const value = relative(parent, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function validateSkillImportTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('Skill imports may not contain symbolic links.')
    if (metadata.isFile()) {
      files += 1
      bytes += metadata.size
      if (files > 256 || bytes > 10 * 1024 * 1024) {
        throw new Error('Skill import exceeds the 256 file / 10 MiB safety limit.')
      }
      return
    }
    if (!metadata.isDirectory()) throw new Error('Skill imports may contain only regular files and directories.')
    for (const entry of await readdir(path)) {
      if (entry === '.git') continue
      await visit(join(path, entry))
    }
  }
  await visit(root)
}
