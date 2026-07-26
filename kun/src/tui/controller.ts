import type { ThreadSummary } from '../contracts/threads.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { ModelConnectionSnapshot } from '../contracts/model-connections.js'
import type { ModelReasoningEffort, ModelReasoningCapabilityMetadata } from '../contracts/capabilities.js'
import { redactSecretText } from '../config/secret-redaction.js'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { UserInputAnswer } from './client.js'
import {
  KunTuiClient,
  TuiClientError,
  type TuiConnection
} from './client.js'
import type { TuiOptions } from './options.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
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

export type ControllerView = 'threads' | 'chat' | 'help'
export type ControllerConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export type TuiControllerState = {
  view: ControllerView
  threads: ThreadSummary[]
  threadSearch: string
  selectedThreadIndex: number
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
    connection: 'connecting',
    busy: false,
    composerMode: 'agent',
    quitRequested: false
  }
  private readonly listeners = new Set<(state: TuiControllerState) => void>()
  private eventsAbort?: AbortController
  private activeSubscription?: Promise<void>
  private modelEventsAbort?: AbortController
  private modelEventsSubscription?: Promise<void>
  private persisted: TuiPersistentState = emptyTuiPersistentState()
  private persistenceWrite: Promise<void> = Promise.resolve()

  constructor(
    readonly client: KunTuiClient,
    readonly options: TuiOptions,
    readonly runtime: TuiConnection
  ) {}

  get state(): TuiControllerState {
    return this.stateValue
  }

  applyModelSelection(snapshot: ModelConnectionSnapshot, notify = true): void {
    const selectionChanged = snapshot.defaultProviderId !== this.options.providerId ||
      snapshot.defaultAccountId !== this.options.accountId ||
      snapshot.defaultModel !== this.options.model
    this.options.providerId = snapshot.defaultProviderId
    this.options.accountId = snapshot.defaultAccountId
    this.options.model = snapshot.defaultModel
    if (snapshot.defaultModel) this.runtime.runtimeInfo.model = snapshot.defaultModel
    const reasoningEffort = this.resolveReasoningEffort({
      snapshot,
      providerId: snapshot.defaultProviderId,
      accountId: snapshot.defaultAccountId,
      model: snapshot.defaultModel,
      ...(!selectionChanged && this.stateValue.reasoningEffort
        ? { preferred: this.stateValue.reasoningEffort }
        : {})
    })
    this.patch({ modelConnections: snapshot, reasoningEffort })
    if (snapshot.defaultProviderId && snapshot.defaultAccountId && snapshot.defaultModel) {
      void this.recordRecentModel({
        providerId: snapshot.defaultProviderId,
        accountId: snapshot.defaultAccountId,
        model: snapshot.defaultModel
      })
    }
    if (notify) this.notify(
      snapshot.defaultProviderId && snapshot.defaultModel
        ? `${this.runtime.legacyGui ? 'Shared model' : 'Default model'}: ${snapshot.defaultProviderId}/${snapshot.defaultModel}`
        : 'Model connection updated.'
    )
  }

  watchModelConnections(): void {
    if (this.modelEventsSubscription) return
    const abort = new AbortController()
    this.modelEventsAbort = abort
    const subscription = (async () => {
      const initial = await this.client.modelConnections()
      if (abort.signal.aborted) return
      this.applyModelSelection(initial, false)
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
    this.persisted = await readTuiPersistentState(this.options.dataDir)
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
    const closeModelConnections = typeof this.client.closeModelConnections === 'function'
      ? this.client.closeModelConnections().catch(() => undefined)
      : Promise.resolve()
    await Promise.all([
      this.activeSubscription?.catch(() => undefined),
      this.modelEventsSubscription?.catch(() => undefined),
      this.persistenceWrite.catch(() => undefined),
      closeModelConnections
    ])
  }

  async refreshThreads(search = this.stateValue.threadSearch): Promise<void> {
    this.patch({ busy: true, busyLabel: 'Loading sessions', threadSearch: search })
    try {
      const threads = await this.client.listThreads({ search, limit: 200 })
      threads.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt))
      this.patch({
        threads,
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
        this.patch({ projection: undefined })
      }
      await this.refreshThreads(this.stateValue.threadSearch)
      this.notify(`Deleted session ${selected.title || selected.id}.`)
    } catch (error) {
      this.fail(error)
    }
  }

  async openThread(threadId: string): Promise<void> {
    this.eventsAbort?.abort()
    this.patch({ busy: true, busyLabel: 'Opening session', connection: 'connecting' })
    try {
      const delegationRequest = typeof this.client.delegationDiagnostics === 'function'
        ? this.client.delegationDiagnostics(threadId).catch(() => undefined)
        : Promise.resolve(undefined)
      const [detail, delegation] = await Promise.all([
        this.client.getThread(threadId),
        delegationRequest
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
        busy: false,
        connection: 'connecting',
        notification: undefined,
        inspection: undefined
      })
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
        },
        onError: (error) => {
          if (this.eventsAbort !== abort) return
          if (isMissingThread(error)) {
            abort.abort()
            this.patch({
              view: 'chat',
              projection: undefined,
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
      const thread = await this.client.createThread({
        title,
        workspace: this.options.workspace,
        model: this.options.model ?? this.runtime.runtimeInfo.model ?? 'deepseek-chat',
        ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
        ...(this.options.accountId ? { accountId: this.options.accountId } : {}),
        mode: this.stateValue.composerMode,
        ...(this.options.approvalPolicy ?? this.runtime.runtimeInfo.approvalPolicy
          ? { approvalPolicy: this.options.approvalPolicy ?? this.runtime.runtimeInfo.approvalPolicy }
          : {}),
        ...(this.options.sandboxMode ?? this.runtime.runtimeInfo.sandboxMode
          ? { sandboxMode: this.options.sandboxMode ?? this.runtime.runtimeInfo.sandboxMode }
          : {})
      })
      await this.refreshThreads('')
      await this.openThread(thread.id)
    } catch (error) {
      this.fail(error)
    }
  }

  async submit(text: string): Promise<void> {
    const prompt = text.trim()
    if (!prompt) return
    if (!this.stateValue.projection) {
      await this.createThread(prompt.slice(0, 80))
      if (!this.stateValue.projection) return
    }
    const { thread, runningTurnId } = this.stateValue.projection
    this.patch({
      busy: true,
      busyLabel: runningTurnId ? 'Queuing guidance' : 'Sending message',
      notification: undefined
    })
    try {
      if (runningTurnId) {
        await this.client.steerTurn(thread.id, runningTurnId, prompt)
        this.patch({ busy: false, notification: { kind: 'info', message: 'Guidance queued for the running turn.' } })
      } else {
        const model = this.options.model ?? thread.model
        const providerId = this.options.providerId ?? thread.providerId
        const accountId = this.options.accountId ?? thread.accountId
        const reasoningEffort = this.stateValue.reasoningEffort
        const started = await this.client.startTurn(thread.id, {
          prompt,
          model,
          ...(providerId ? { providerId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          mode: thread.mode,
          approvalPolicy: thread.approvalPolicy,
          sandboxMode: thread.sandboxMode
        })
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
              mode: thread.mode
            }
          ),
          busy: false
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
    await this.refreshThreads(this.stateValue.threadSearch)
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
      this.patch({ composerMode: mode })
      this.notify(`New session mode: ${mode}`)
      return
    }
    try {
      const thread = await this.client.updateThread(projection.thread.id, { mode })
      this.patch({
        projection: { ...projection, thread: { ...projection.thread, ...thread } },
        composerMode: mode,
        notification: { kind: 'info', message: `Session mode: ${mode}` }
      })
    } catch (error) {
      this.fail(error)
    }
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
      entry.providerId === this.options.providerId && entry.accountId === this.options.accountId && entry.model === this.options.model
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

  async manageGoal(action?: string): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const value = action?.trim() ?? ''
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
        await this.client.clearThreadGoal(projection.thread.id)
        await this.reloadActiveThread()
        this.notify('Goal cleared.')
        return
      }
      if (lowered === 'pause' || lowered === 'resume') {
        await this.client.setThreadGoal(projection.thread.id, { status: lowered === 'pause' ? 'paused' : 'active' })
        await this.reloadActiveThread()
        this.notify(`Goal ${lowered === 'pause' ? 'paused' : 'resumed'}.`)
        return
      }
      const objective = lowered.startsWith('set ') ? value.slice(4).trim() : value
      await this.client.setThreadGoal(projection.thread.id, { objective, status: 'active' })
      await this.reloadActiveThread()
      this.notify('Goal saved and active.')
    } catch (error) {
      this.fail(error)
    }
  }

  async showStatus(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    const thread = projection.thread
    this.inspect('Status', [
      `Connection: ${this.stateValue.connection}`,
      `Runtime: ${this.runtime.runtimeInfo.serviceVersion ?? 'unknown'} · ${this.runtime.runtimeInfo.instanceId ?? 'unknown'} · PID ${this.runtime.runtimeInfo.pid ?? 'unknown'}`,
      `URL: ${this.runtime.baseUrl}`,
      `Session: ${thread.title} (${thread.id})`,
      `State: ${thread.status}${projection.runningTurnId ? ` · turn ${projection.runningTurnId}` : ''}`,
      `Model: ${thread.providerId ? `${thread.providerId}/` : ''}${thread.model}`,
      `Reasoning: ${this.stateValue.reasoningEffort ?? 'model default'}`,
      `Workspace: ${thread.workspace}`,
      `Mode: ${thread.mode}`,
      ...(thread.additionalWorkspaces ?? []).map((path) => `Additional workspace: ${path}`),
      `Permissions: ${thread.approvalPolicy} · ${thread.sandboxMode}`
    ])
  }

  async showMcp(): Promise<void> {
    try {
      const tools = await this.client.runtimeTools()
      this.inspect('MCP servers', tools.mcpServers.length
        ? tools.mcpServers.flatMap((server) => [
            `${server.id}: ${server.status} · ${server.toolCount} tools · ${server.transport}`,
            ...(server.toolNames.length ? [`  Tools: ${server.toolNames.join(', ')}`] : []),
            ...(server.lastError ? [`  ${server.lastError}`] : [])
          ])
        : ['No MCP servers are configured.'])
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

  async showContext(): Promise<void> {
    const projection = this.requireProjection()
    if (!projection) return
    try {
      const usage = await this.client.usage()
      const bucket = usage.buckets.find((entry) => entry.thread_id === projection.thread.id)
      this.inspect('Context', bucket
        ? [
            `Input: ${bucket.input_tokens.toLocaleString()} tokens`,
            `Output: ${bucket.output_tokens.toLocaleString()} tokens`,
            `Reasoning: ${bucket.reasoning_tokens.toLocaleString()} tokens`,
            `Cached: ${bucket.cached_tokens.toLocaleString()} tokens`,
            `Total: ${bucket.total_tokens.toLocaleString()} tokens`,
            `Turns: ${bucket.turns}`,
            `Context window: not reported by the selected provider`
          ]
        : ['No usage has been recorded for this thread.'])
    } catch (error) {
      this.fail(error)
    }
  }

  showQueue(): void {
    const projection = this.requireProjection()
    if (!projection) return
    const running = projection.thread.turns.find((turn) => turn.id === projection.runningTurnId)
    this.inspect('Queued guidance', running?.steering.length
      ? running.steering.map((text, index) => `${index + 1}. ${text}`)
      : ['No queued steer messages.'])
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

  showThreads(search = ''): void {
    this.patch({ view: 'threads' })
    void this.refreshThreads(search)
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
