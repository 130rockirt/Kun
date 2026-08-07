import type { ThreadRecord, ThreadStatus } from '../contracts/threads.js'
import type {
  CompactRequest,
  CompactResponse,
  RewindThreadResponse,
  StartTurnRequest,
  StartTurnResponse,
  SteeringEntry,
  Turn,
  GraphPlanningLifecycle,
  TurnStatus
} from '../contracts/turns.js'
import type { TurnItem, UserMessageSource } from '../contracts/items.js'
import type { RuntimeErrorSeverity } from '../contracts/errors.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { MigrationMaintenanceLock } from '../ports/migration-maintenance-lock.js'
import {
  ThreadExecutionBusyError,
  type ThreadExecutionLeasePort
} from '../ports/thread-execution-lease.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ModelClient } from '../ports/model-client.js'
import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { InflightTracker } from '../loop/inflight-tracker.js'
import type { SteeringQueue } from '../loop/steering-queue.js'
import { ContextCompactor, extractSkillPins } from '../loop/context-compactor.js'
import {
  effectiveHistoryAfterLatestCompaction,
  insertCompactionIntoVisibleHistory
} from '../loop/compaction-history.js'
import {
  resolveCoherentProviderAccount,
  resolveCompactionModel,
  summarizeCompactionWithModel
} from '../loop/compaction-summary.js'
import type { ContextCompactionConfig } from '../loop/model-context-profile.js'
import { reserveExtensionModelRequest } from '../loop/turn-budget-gate.js'
import { makeGoalContextItem, makeUserItem, makeErrorItem } from '../domain/item.js'
import { appendTurnItem, createTurnRecord, finishTurn, replaceTurnItem, startTurn as startTurnRecord } from '../domain/turn.js'
import { finalizeTurnItems } from '../domain/turn-item-finalization.js'
import { touchThread } from '../domain/thread.js'
import type { RuntimeEventRecorder } from './runtime-event-recorder.js'
import type { UsageService } from './usage-service.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { rewriteItemHistoryWithRetry } from './history-commit-coordinator.js'
import { withThreadStoreMutation } from './thread-mutation-coordinator.js'
import type { ThreadLifecycleFence } from './thread-lifecycle-fence.js'
import { ThreadItemProjectionService } from './thread-item-projection.js'
import { ComposerContextAttachmentSchema } from '../contracts/composer-context.js'
import {
  goalContextInstruction,
  goalContextKey
} from '../loop/continuation-instructions.js'

export type TurnServiceDeps = {
  threadStore: ThreadStore
  sessionStore: SessionStore
  events: RuntimeEventRecorder
  inflight: InflightTracker
  steering: SteeringQueue
  compactor: ContextCompactor
  model?: ModelClient
  usage?: UsageService
  prefix?: ImmutablePrefix
  attachmentStore?: () => AttachmentStore | undefined
  defaultModel?: string
  contextCompaction?: ContextCompactionConfig
  /** Maximum number of active turns this in-process runtime may admit. */
  maxConcurrentTurns?: number
  /** Reject turn admission while this thread is being destructively removed. */
  lifecycleFence?: ThreadLifecycleFence
  migrationMaintenance?: MigrationMaintenanceLock
  /** Cross-runtime ownership fence supplied by the stable Service Manager. */
  executionLeases?: ThreadExecutionLeasePort
  /** Dispose machine-local continuation state after a successful manual compaction. */
  onCompacted?: (threadId: string) => Promise<void>
  /** Resolve durable Graph ownership without coupling TurnService to the Graph store. */
  resolveGraphLeadRun?: (input: {
    threadId: string
    turnId: string
  }) => Promise<{
    runId: string
    lastEventSeq: number
    terminal: boolean
    supervisionPending?: boolean
  } | null>
  createGraphPlanningDraft?: (input: {
    threadId: string
    sourceTurnId: string
    goal: string
    workspace?: string
  }) => Promise<GraphPlanningLifecycle>
  /** Resolve the latest durable draft so stale turn metadata can self-heal after restart. */
  resolveGraphPlanningDraft?: (input: {
    threadId: string
    sourceTurnId: string
  }) => Promise<GraphPlanningLifecycle | null>
  transitionGraphPlanningDraft?: (input: {
    threadId: string
    sourceTurnId: string
    action: 'suspend' | 'resume' | 'cancel'
  }) => Promise<GraphPlanningLifecycle | null>
  /**
   * Durably cancel any GraphRun owned by this source turn before the source
   * turn itself is persisted as aborted. This ordering is the explicit Stop
   * fence: a process exit between the two writes can never leave an aborted
   * source turn attached to a still-completing run.
   */
  cancelGraphSourceRuns?: (input: {
    threadId: string
    sourceTurnId: string
  }) => Promise<void>
  ids: IdGenerator
  nowIso: () => string
}

export class TurnConflictError extends Error {}

/**
 * The serve runtime has accepted as many active turns as it is configured to
 * execute. Unlike a per-thread conflict, callers may retry this on another
 * thread after any active turn settles.
 */
export class TurnCapacityError extends Error {
  constructor(readonly maxConcurrentTurns: number) {
    super(`runtime turn capacity reached (${maxConcurrentTurns} active turns); retry after a turn finishes`)
    this.name = 'TurnCapacityError'
  }
}

export type TerminalTurnStatus = Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>

/**
 * Authoritative result of attempting to persist a terminal state. Callers
 * must use this rather than assuming their requested status won a race with
 * interrupt, delete, or another execution owner.
 */
export type TurnSettlement =
  | { kind: 'applied'; status: TerminalTurnStatus; error?: string }
  | { kind: 'already_terminal'; status: TerminalTurnStatus; error?: string }
  | { kind: 'missing' }

export type GraphLeadSuspensionResult =
  | 'not_graph'
  | 'graph_terminal'
  | 'pending_steering'
  | 'supervision_pending'
  | 'suspended'
  | 'suspended_pending_supervision'

export type GraphLeadResumeResult = 'resumed' | 'already_running'

const HOST_SHUTDOWN_TURN_SUSPENSION_CODE = 'host_shutdown_turn_suspension'

function hostShutdownTurnSuspensionReason(): { code: string } {
  return { code: HOST_SHUTDOWN_TURN_SUSPENSION_CODE }
}

/** True only for the process-local abort used to park work during host shutdown. */
export function isHostShutdownTurnSuspension(signal: AbortSignal): boolean {
  const reason = signal.reason
  return Boolean(
    reason &&
    typeof reason === 'object' &&
    'code' in reason &&
    reason.code === HOST_SHUTDOWN_TURN_SUSPENSION_CODE
  )
}

/**
 * Keep a finite backstop for one serve process while allowing a desktop user
 * to work across effectively all of their active conversations by default.
 */
export const DEFAULT_MAX_CONCURRENT_TURNS = 256

/**
 * Turn service: owns the turn lifecycle (start, finish, abort, steer,
 * compact). The service is the only place that emits turn lifecycle
 * events; the agent loop calls into it instead of mutating state
 * directly.
 */
export class TurnService {
  private deps: TurnServiceDeps
  private readonly threadItems: ThreadItemProjectionService
  private readonly inflightTurns = new Map<string, AbortController>()
  /** Turn ids that own one global admission slot. */
  private readonly admittedTurnThreads = new Map<string, string>()
  private readonly leasedTurns = new Set<string>()
  /** Steering requests that are restoring a parked Graph lease before enqueueing. */
  private readonly graphSteeringResumeFences = new Map<string, number>()
  private maxConcurrentTurns: number

  constructor(deps: TurnServiceDeps) {
    this.deps = deps
    this.threadItems = new ThreadItemProjectionService({
      threadStore: deps.threadStore,
      sessionStore: deps.sessionStore,
      nowIso: deps.nowIso
    })
    this.maxConcurrentTurns = normalizeMaxConcurrentTurns(deps.maxConcurrentTurns)
  }

  updateRuntimeConfig(
    patch: Partial<Pick<TurnServiceDeps, 'model' | 'defaultModel' | 'contextCompaction' | 'maxConcurrentTurns'>>
  ): void {
    this.deps = {
      ...this.deps,
      ...patch
    }
    if ('maxConcurrentTurns' in patch) {
      this.maxConcurrentTurns = normalizeMaxConcurrentTurns(patch.maxConcurrentTurns)
    }
  }

  async startTurn(input: {
    threadId: string
    request: StartTurnRequest
  }, options: {
    /** Internal extension-broker accounting baseline; not part of StartTurnRequest. */
    extensionBudgetTokenBaseline?: number
  } = {}): Promise<StartTurnResponse> {
    if (this.deps.migrationMaintenance?.isLocked()) {
      throw new TurnConflictError('runtime migration maintenance is in progress')
    }
    const currentOwner = await this.deps.executionLeases?.owner(input.threadId)
    if (currentOwner) throw new ThreadExecutionBusyError(currentOwner)
    let attemptedTurnId: string | undefined
    try {
      const started = await this.withThreadMutation(input.threadId, async () => {
        if (this.deps.lifecycleFence?.isClosing(input.threadId)) {
          throw new TurnConflictError(`thread is being deleted: ${input.threadId}`)
        }
        const thread = await this.deps.threadStore.get(input.threadId)
        if (!thread) throw new Error(`thread not found: ${input.threadId}`)
        // Archival is an overlay on the execution-derived thread state. It
        // deliberately permits an already-running turn to settle, but it
        // must not admit a new one while the thread remains archived.
        if (thread.status === 'archived') {
          throw new TurnConflictError(`thread is archived: ${input.threadId}`)
        }
        if (thread.turns.some((turn) => turn.status === 'queued' || turn.status === 'running')) {
          throw new TurnConflictError(`thread already has an active turn: ${input.threadId}`)
        }
        // Allocate only an in-memory id before admission. A rejected request
        // still has no turn record, item, or event to persist.
        const turnId = this.deps.ids.next('turn')
        if (!this.tryAdmitTurn(turnId, input.threadId)) {
          throw new TurnCapacityError(this.maxConcurrentTurns)
        }
        attemptedTurnId = turnId
        try {
          if (this.deps.executionLeases) {
            await this.deps.executionLeases.acquire(input.threadId, turnId)
            this.leasedTurns.add(turnId)
          }
          const composerContexts = ComposerContextAttachmentSchema.array().parse(
            input.request.composerContexts ?? []
          )
          const attachmentIds = [...new Set(
            (input.request.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)
          )]
          if (attachmentIds.length > 0) {
            const attachmentStore = this.deps.attachmentStore?.()
            if (!attachmentStore) throw new Error('attachment store is unavailable')
            await attachmentStore.bindScopes(attachmentIds, {
              threadId: input.threadId,
              ...(thread.workspace ? { workspace: thread.workspace } : {})
            })
          }
          const approvalPolicy = input.request.approvalPolicy ?? thread.approvalPolicy
          const sandboxMode = input.request.sandboxMode ?? thread.sandboxMode
          const approvalReviewer = input.request.approvalReviewer ?? thread.approvalReviewer
          const graphPlanningLifecycle =
            input.request.orchestration === 'graph' && this.deps.createGraphPlanningDraft
              ? await this.deps.createGraphPlanningDraft({
                  threadId: input.threadId,
                  sourceTurnId: turnId,
                  goal: input.request.prompt,
                  workspace: thread.workspace
                })
              : undefined
          // Snapshot the effective selection at admission. Some clients omit
          // fields that merely inherit the thread. Without this copy a model
          // picker change could mutate `thread.model` between tool steps and
          // silently move an already-running turn onto a different protocol.
          const turnModel = firstNonBlank(
            input.request.model,
            thread.model,
            this.deps.defaultModel,
            this.deps.model?.model
          )
          const requestedProviderId = firstNonBlank(input.request.providerId)
          const threadProviderId = firstNonBlank(thread.providerId)
          // `undefined` means "consult the current thread/default" to older
          // consumers. Persist the default alias explicitly so a selection
          // change after admission cannot move this already-running turn.
          const turnProviderId = requestedProviderId ?? threadProviderId ?? 'default'
          const turnAccountId = firstNonBlank(input.request.accountId) ?? (
            !requestedProviderId || requestedProviderId === threadProviderId
              ? firstNonBlank(thread.accountId)
              : undefined
          )
          const turn = createTurnRecord({
            id: turnId,
            threadId: input.threadId,
            prompt: input.request.prompt,
            messageSource: input.request.messageSource,
            model: turnModel,
            providerId: turnProviderId,
            accountId: turnAccountId,
            reasoningEffort: input.request.reasoningEffort,
            serviceTier: input.request.serviceTier,
            clientSurface: input.request.clientSurface,
            approvalPolicy,
            sandboxMode,
            approvalReviewer,
            attachmentIds,
            composerContexts,
            guiPlan: input.request.guiPlan,
            guiDesignCanvas: input.request.guiDesignCanvas,
            guiDesignMode: input.request.guiDesignMode,
            agentSurface: input.request.agentSurface,
            guiDesignArtifact: input.request.guiDesignArtifact,
            mode: input.request.mode,
            orchestration: input.request.orchestration,
            graphPlanningLifecycle,
            disableUserInput: input.request.disableUserInput,
            imContext: input.request.imContext,
            workspaceCheckpointId: input.request.workspaceCheckpointId,
            workspaceCheckpointRequestId: input.request.workspaceCheckpointRequestId,
            ...(options.extensionBudgetTokenBaseline !== undefined
              ? { extensionBudgetTokenBaseline: options.extensionBudgetTokenBaseline }
              : {})
          })
          const userItem = makeUserItem({
            id: `item_${turnId}_user`,
            turnId,
            threadId: input.threadId,
            text: input.request.prompt,
            displayText: input.request.displayText,
            messageSource: input.request.messageSource,
            attachmentIds,
            composerContexts,
            fileReferences: input.request.fileReferences ?? [],
            workspaceCheckpointId: input.request.workspaceCheckpointId
          })
          const controller = new AbortController()
          const startedTurn = startTurnRecord(appendTurnItem(turn, userItem))
          const next = {
            ...touchThread(thread, this.deps.nowIso()),
            status: 'running' as const,
            ...(thread.agentSurface === undefined && thread.turns.length === 0 && input.request.agentSurface
              ? { agentSurface: input.request.agentSurface }
              : {}),
            ...(input.request.approvalPolicy !== undefined
              ? { approvalPolicy: input.request.approvalPolicy }
              : {}),
            ...(input.request.sandboxMode !== undefined
              ? { sandboxMode: input.request.sandboxMode }
              : {}),
            ...(input.request.approvalReviewer !== undefined
              ? { approvalReviewer: input.request.approvalReviewer }
              : {}),
            turns: [...thread.turns, startedTurn]
          }
          await this.deps.threadStore.upsert({ ...next, updatedAt: this.deps.nowIso() })
          await this.deps.sessionStore.appendItem(input.threadId, userItem)
          this.inflightTurns.set(turnId, controller)
          this.deps.inflight.begin({ id: turnId, kind: 'model', threadId: input.threadId, turnId })
          return { turnId, userItem, turn: startedTurn }
        } catch (error) {
          // A failed start has no loop to perform lifecycle cleanup. Release
          // its slot immediately; the outer catch best-effort marks any
          // already-persisted turn aborted so it cannot strand the thread.
          this.clearRuntimeTurnState(input.threadId, turnId, { abort: true })
          throw error
        }
      })
      await this.deps.events.record({
        kind: 'turn_started',
        threadId: input.threadId,
        turnId: started.turnId,
        ...(started.turn.model ? { model: started.turn.model } : {}),
        ...(started.turn.providerId ? { providerId: started.turn.providerId } : {}),
        ...(started.turn.accountId ? { accountId: started.turn.accountId } : {}),
        ...(input.request.reasoningEffort ? { reasoningEffort: input.request.reasoningEffort } : {}),
        ...(input.request.serviceTier ? { serviceTier: input.request.serviceTier } : {}),
        ...(started.turn.clientSurface ? { clientSurface: started.turn.clientSurface } : {}),
        ...(started.turn.approvalPolicy ? { approvalPolicy: started.turn.approvalPolicy } : {}),
        ...(started.turn.sandboxMode ? { sandboxMode: started.turn.sandboxMode } : {}),
        ...(started.turn.approvalReviewer ? { approvalReviewer: started.turn.approvalReviewer } : {}),
        ...(started.turn.mode ? { mode: started.turn.mode } : {})
      })
      await this.deps.events.record({
        kind: 'item_created',
        threadId: input.threadId,
        turnId: started.turnId,
        itemId: started.userItem.id,
        item: started.userItem
      })
      return { threadId: input.threadId, turnId: started.turnId, userMessageItemId: started.userItem.id }
    } catch (error) {
      if (attemptedTurnId) {
        // This is deliberately outside the per-thread mutation callback: the
        // latter must unwind before interruptTurn can take the same lock.
        await this.interruptTurn({ threadId: input.threadId, turnId: attemptedTurnId }).catch(() => undefined)
      }
      throw error
    }
  }

  async rewindThread(input: {
    threadId: string
    turnId: string
  }): Promise<RewindThreadResponse> {
    return this.withThreadMutation(input.threadId, async () => {
      const thread = await this.deps.threadStore.get(input.threadId)
      if (!thread) throw new Error(`thread not found: ${input.threadId}`)
      // `archived` is an overlay, so checking the thread marker alone lets a
      // caller rewrite history while a turn is still queued/running. The turn
      // records are the source of truth for execution state.
      if (thread.turns.some(isActiveTurn)) {
        throw new TurnConflictError(`cannot rewind while a turn is active: ${input.threadId}`)
      }
      const targetIndex = thread.turns.findIndex((turn) => turn.id === input.turnId)
      if (targetIndex < 0) throw new Error(`turn not found: ${input.turnId}`)

      const keptTurns = thread.turns.slice(0, targetIndex)
      const keptTurnIds = new Set(keptTurns.map((turn) => turn.id))
      const history = await rewriteItemHistoryWithRetry({
        sessionStore: this.deps.sessionStore,
        threadId: input.threadId,
        maxAttempts: 3,
        build: (snapshot) => {
          const keptItems = snapshot.items.filter((item) => keptTurnIds.has(item.turnId))
          return {
            changed: keptItems.length !== snapshot.items.length,
            items: keptItems,
            value: undefined
          }
        }
      })
      if (history.status === 'closed') {
        throw new TurnConflictError(`thread is being deleted: ${input.threadId}`)
      }
      if (history.status === 'conflict') {
        throw new TurnConflictError(`history changed while rewinding: ${input.threadId}`)
      }
      const now = this.deps.nowIso()
      await this.deps.threadStore.upsert({
        ...touchThread(thread, now),
        // Rewind must not implicitly unarchive a completed conversation.
        status: thread.status === 'archived' ? 'archived' : 'idle',
        turns: keptTurns,
        updatedAt: now
      })
      return {
        threadId: input.threadId,
        turnId: input.turnId,
        removedTurns: thread.turns.length - targetIndex,
        remainingTurns: keptTurns.length
      }
    })
  }

  async steerTurn(input: {
    threadId: string
    turnId: string
    text: string
    displayText?: string
    messageSource?: UserMessageSource
  }): Promise<void> {
    let holdsGraphResumeFence = false
    try {
      for (;;) {
        const action = await this.withThreadMutation(input.threadId, async () => {
          const current = await this.deps.threadStore.get(input.threadId)
          const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
          if (!turn) throw new Error(`turn not found: ${input.turnId}`)
          if (turn.status !== 'running') {
            throw new TurnConflictError(`turn is not active: ${input.turnId}`)
          }
          if (!this.inflightTurns.has(input.turnId)) {
            if (turn.orchestration !== 'graph') {
              throw new TurnConflictError(`turn is not active: ${input.turnId}`)
            }
            if (!holdsGraphResumeFence) {
              this.beginGraphSteeringResume(input.turnId)
              holdsGraphResumeFence = true
            }
            return 'resume_graph' as const
          }
          const accepted = this.deps.steering.enqueue(input.turnId, {
            text: input.text,
            ...(input.displayText ? { displayText: input.displayText } : {}),
            ...(input.messageSource ? { messageSource: input.messageSource } : {})
          })
          if (!accepted) {
            if (this.deps.steering.isSealed(input.turnId)) {
              throw new TurnConflictError(`turn is no longer accepting steering: ${input.turnId}`)
            }
            throw new TurnConflictError(
              `steering queue capacity reached for active turn: ${input.turnId}`
            )
          }
          return 'accepted' as const
        })
        if (action === 'accepted') break
        await this.resumeGraphTurnForSteering({
          threadId: input.threadId,
          turnId: input.turnId
        })
      }
    } finally {
      if (holdsGraphResumeFence) {
        this.endGraphSteeringResume(input.turnId)
      }
    }
    await this.deps.events.record({
      kind: 'turn_steered',
      threadId: input.threadId,
      turnId: input.turnId,
      text: input.text,
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.messageSource ? { messageSource: input.messageSource } : {})
    })
  }

  private async resumeGraphTurnForSteering(input: {
    threadId: string
    turnId: string
  }): Promise<void> {
    const attached = await this.deps.resolveGraphLeadRun?.(input)
    if (attached) {
      await this.resumeGraphLeadTurn({
        ...input,
        runId: attached.runId,
        lastDeliveredSeq: attached.lastEventSeq,
        terminal: attached.terminal
      })
      return
    }
    const durablePlanning = await this.deps.resolveGraphPlanningDraft?.({
      threadId: input.threadId,
      sourceTurnId: input.turnId
    })
    const lifecycle = durablePlanning ??
      (await this.getTurn(input.threadId, input.turnId))?.graphPlanningLifecycle
    if (
      lifecycle?.state === 'planning' ||
      lifecycle?.state === 'repairing' ||
      lifecycle?.state === 'needs_correction'
    ) {
      await this.resumeGraphPlanningTurn(input)
      return
    }
    throw new TurnConflictError(`Graph source turn is not resumable: ${input.turnId}`)
  }

  private beginGraphSteeringResume(turnId: string): void {
    this.graphSteeringResumeFences.set(
      turnId,
      (this.graphSteeringResumeFences.get(turnId) ?? 0) + 1
    )
  }

  private endGraphSteeringResume(turnId: string): void {
    const remaining = (this.graphSteeringResumeFences.get(turnId) ?? 0) - 1
    if (remaining > 0) this.graphSteeringResumeFences.set(turnId, remaining)
    else this.graphSteeringResumeFences.delete(turnId)
  }

  private hasGraphSteeringResume(turnId: string): boolean {
    return (this.graphSteeringResumeFences.get(turnId) ?? 0) > 0
  }

  async steeringQueue(input: { threadId: string; turnId: string }): Promise<SteeringEntry[]> {
    const current = await this.deps.threadStore.get(input.threadId)
    const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
    if (!turn) throw new Error(`turn not found: ${input.turnId}`)
    return this.deps.steering.peek(input.turnId)
  }

  async replaceSteering(input: {
    threadId: string
    turnId: string
    entries: readonly SteeringEntry[]
  }): Promise<SteeringEntry[]> {
    let entries: SteeringEntry[] = []
    await this.withThreadMutation(input.threadId, async () => {
      const current = await this.deps.threadStore.get(input.threadId)
      const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
      if (!turn) throw new Error(`turn not found: ${input.turnId}`)
      if (turn.status !== 'running' || !this.inflightTurns.has(input.turnId)) {
        throw new TurnConflictError(`turn is not active: ${input.turnId}`)
      }
      if (!this.deps.steering.replace(input.turnId, input.entries)) {
        throw new TurnConflictError(`turn is no longer accepting steering or the replacement exceeds its capacity: ${input.turnId}`)
      }
      entries = this.deps.steering.peek(input.turnId)
    })
    await this.deps.events.record({
      kind: 'turn_steering_updated',
      threadId: input.threadId,
      turnId: input.turnId,
      entries
    })
    return entries
  }

  async interruptTurn(input: { threadId: string; turnId: string; discard?: boolean }): Promise<{ status: TurnStatus }> {
    let transition: boolean
    try {
      transition = await this.withThreadMutation(input.threadId, async () => {
        const current = await this.deps.threadStore.get(input.threadId)
        if (!current) throw new Error(`thread not found: ${input.threadId}`)
        const turn = current.turns.find((candidate) => candidate.id === input.turnId)
        if (!turn) throw new Error(`turn not found: ${input.turnId}`)
        if (!isActiveTurn(turn)) {
          throw new TurnConflictError(`turn is not active: ${input.turnId}`)
        }
        if (turn.orchestration === 'graph') {
          // Keep this inside the thread mutation fence. A racing AgentLoop
          // settlement cannot overtake explicit Stop while Graph cancellation
          // is being made durable.
          // Cancel the pre-run draft first. If graph_define_plan is between
          // creating its paused run and committing the draft, its CAS will then
          // lose and clean up that run. Listing/cancelling runs second closes the
          // opposite ordering where commit won first.
          await this.deps.transitionGraphPlanningDraft?.({
            threadId: input.threadId,
            sourceTurnId: input.turnId,
            action: 'cancel'
          })
          await this.deps.cancelGraphSourceRuns?.({
            threadId: input.threadId,
            sourceTurnId: input.turnId
          })
        }
        const turns = current.turns.map((candidate) =>
          candidate.id === input.turnId
            ? this.finalizeOpenItems(
                finishTurn(input.discard ? { ...candidate, items: this.keepUserItems(candidate.items) } : candidate, 'aborted'),
                'aborted'
              )
            : candidate
        )
        await this.deps.threadStore.upsert({
          ...touchThread(current, this.deps.nowIso()),
          turns,
          status: threadStatusAfterTurnTransition(current.status, turns),
          updatedAt: this.deps.nowIso()
        })
        return true
      })
    } catch (error) {
      // If persistence is unavailable, the caller still asked to interrupt
      // execution. Abort and free its admission slot; restart reconciliation
      // can settle the durable running record later.
      this.clearRuntimeTurnState(input.threadId, input.turnId, { abort: true })
      throw error
    }
    if (!transition) return { status: 'aborted' }

    this.clearRuntimeTurnState(input.threadId, input.turnId, { abort: true })
    await this.deps.events.record({
      kind: 'turn_aborted',
      threadId: input.threadId,
      turnId: input.turnId
    })
    if (input.discard) {
      await this.discardTurnItems(input.threadId, input.turnId)
    } else {
      await this.finalizePersistedOpenItems(input.threadId, input.turnId, 'aborted')
    }
    return { status: 'aborted' }
  }

  /** Abort every in-process turn before runtime shutdown closes its stores. */
  async interruptActiveTurns(): Promise<number> {
    const active = this.deps.inflight.list()
      .filter((record) => record.kind === 'model' && Boolean(record.turnId))
      .map((record) => ({ threadId: record.threadId, turnId: record.turnId! }))
    const settled = await Promise.allSettled(
      active.map(({ threadId, turnId }) => this.interruptTurn({ threadId, turnId }))
    )
    return settled.filter((result) => result.status === 'fulfilled').length
  }

  /**
   * Stop process-local work for shutdown without turning a durable Graph Lead
   * into a user cancellation. Direct turns keep their existing abort behavior;
   * Graph turns remain running and are resumed from durable state on restart.
   */
  async suspendActiveTurnsForShutdown(): Promise<number> {
    const active = this.deps.inflight.list()
      .filter((record) => record.kind === 'model' && Boolean(record.turnId))
      .map((record) => ({ threadId: record.threadId, turnId: record.turnId! }))
    const settled = await Promise.allSettled(
      active.map((input) => this.suspendTurnForHostShutdown(input))
    )
    return settled.filter((result) => result.status === 'fulfilled').length
  }

  async suspendTurnForHostShutdown(input: {
    threadId: string
    turnId: string
  }): Promise<void> {
    const turn = await this.getTurn(input.threadId, input.turnId)
    if (
      turn?.status !== 'running' ||
      turn.orchestration !== 'graph'
    ) {
      if (turn?.status === 'running' || turn?.status === 'queued') {
        await this.interruptTurn(input)
      }
      return
    }
    const controller = this.inflightTurns.get(input.turnId)
    controller?.abort(hostShutdownTurnSuspensionReason())
    try {
      const attached = await this.deps.resolveGraphLeadRun?.(input)
      if (attached) {
        await this.suspendGraphLeadTurn({
          ...input,
          force: true,
          preserveDeliveryCursor: true,
          allowPendingSupervision: true
        })
      } else {
        // A planning draft is not invalid merely because its host exits.
        // Preserve the exact draft state and only record that execution
        // was parked; user-driven suspension may still request correction.
        const lifecycle =
          await this.deps.resolveGraphPlanningDraft?.({
            threadId: input.threadId,
            sourceTurnId: input.turnId
          }) ??
          turn.graphPlanningLifecycle
        if (lifecycle) {
          await this.updateTurnMetadata(input.threadId, input.turnId, {
            graphPlanningLifecycle: {
              ...lifecycle,
              suspendedAt: this.deps.nowIso()
            }
          })
        }
      }
    } finally {
      // suspendGraphLeadTurn normally releases this lease. Keep this
      // idempotent fallback for terminal/recovery races and store errors.
      this.releaseRuntimeTurnExecution(input.threadId, input.turnId)
    }
  }

  async compact(input: {
    threadId: string
    turnId?: string
    request: CompactRequest
    signal?: AbortSignal
  }): Promise<CompactResponse> {
    const thread = await this.deps.threadStore.get(input.threadId)
    if (!thread) throw new Error(`thread not found: ${input.threadId}`)
    const turnId = input.turnId ?? thread.turns[thread.turns.length - 1]?.id ?? this.deps.ids.next('turn')
    const bindingTurn = thread.turns.find((candidate) => candidate.id === turnId)
    const {
      providerId: fallbackProviderId,
      accountId: fallbackAccountId
    } = resolveCoherentProviderAccount({
      turnProviderId: bindingTurn?.providerId,
      turnAccountId: bindingTurn?.accountId,
      threadProviderId: thread.providerId,
      threadAccountId: thread.accountId
    })
    const prefix = this.deps.prefix ?? createImmutablePrefix({
      pinnedConstraints: ['user: preserve recent turns']
    })
    const summaryItemId = this.deps.ids.next('compaction')
    let started = false
    const committed = await rewriteItemHistoryWithRetry({
      sessionStore: this.deps.sessionStore,
      threadId: input.threadId,
      maxAttempts: 2,
      build: async (snapshot, attempt) => {
        const history = effectiveHistoryAfterLatestCompaction(snapshot.items)
          .filter((item) => item.kind !== 'error')
        let result = this.deps.compactor.compact({
          threadId: input.threadId,
          turnId,
          history,
          prefix,
          budgetTokens: input.request.budgetTokens,
          reason: input.request.reason,
          summaryItemId,
          // Mark this as a user-requested (`/compact`) compaction so the GUI
          // renders it as a manual rather than automatic compaction.
          auto: false
        })
        if (result.replacedTokens === 0) {
          return { changed: false, items: snapshot.items, value: result }
        }
        if (!started) {
          started = true
          // Keep the existing live lifecycle signal, but only persist the
          // corresponding completion after a conditional history commit wins.
          await this.deps.events.record({
            kind: 'compaction_started',
            threadId: input.threadId,
            turnId,
            itemId: result.summaryItem.id,
            auto: false
          })
        }
        // A conflicting model-backed summary describes the old snapshot, so
        // retry with the deterministic heuristic instead of reusing it (or
        // issuing a second expensive summary request).
        if (attempt === 1 && this.deps.contextCompaction?.summaryMode === 'model' && this.deps.model) {
          const fallbackModel = modelForManualCompaction({
            turnModel: bindingTurn?.model,
            threadModel: thread.model,
            defaultModel: this.deps.defaultModel,
            clientModel: this.deps.model.model
          })
          const compactionModel = resolveCompactionModel({
            contextCompaction: this.deps.contextCompaction,
            fallbackModel,
            fallbackProviderId,
            fallbackAccountId
          })
          const model = compactionModel.model
          const recordFallback = async (message: string): Promise<void> => {
            await this.deps.events.record({
              kind: 'error',
              threadId: input.threadId,
              turnId,
              message,
              code: 'compaction_summary_fallback',
              severity: 'warning'
            })
          }
          let modelSummary: string | undefined
          if (compactionModel.bindingError) {
            await recordFallback(compactionModel.bindingError)
          } else {
            const reservation = this.deps.usage
              ? await reserveExtensionModelRequest({
                  threadStore: this.deps.threadStore,
                  usage: this.deps.usage,
                  nowIso: this.deps.nowIso,
                  threadId: input.threadId,
                  turnId
                })
              : thread.extensionBudget
                ? {
                    allowed: false as const,
                    reason: 'Extension model-request accounting is unavailable.'
                  }
                : { allowed: true as const, counted: false as const }
            if (!reservation.allowed) {
              await recordFallback(
                `${reservation.reason} Model compaction summary was not sent; using heuristic summary.`
              )
            } else {
              const foldedItemIds = new Set(
                result.summaryItem.kind === 'compaction'
                  ? result.summaryItem.sourceItemIds ?? []
                  : []
              )
              // Keep the manual compaction summarizer aligned with the
              // automatic path: recent tail items are sent verbatim after the
              // summary and must not be summarized a second time.
              const summaryItems = history.filter((item) => foldedItemIds.has(item.id))
              if (summaryItems.length === 0) {
                await recordFallback(
                  'Model compaction summary skipped because no folded source items were available; using heuristic summary.'
                )
              } else {
                modelSummary = await summarizeCompactionWithModel({
                  threadId: input.threadId,
                  turnId,
                  model,
                  ...(compactionModel.providerId ? { providerId: compactionModel.providerId } : {}),
                  ...(compactionModel.accountId ? { accountId: compactionModel.accountId } : {}),
                  modelClient: this.deps.model,
                  prefix,
                  contextCompaction: this.deps.contextCompaction,
                  items: summaryItems,
                  pinnedSkillPins: extractSkillPins(summaryItems),
                  heuristicSummary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
                  signal: input.signal ?? new AbortController().signal,
                  recordUsage: async (usageSnapshot) => {
                    const usage = this.deps.usage?.record(input.threadId, usageSnapshot) ?? usageSnapshot
                    await this.deps.events.record({
                      kind: 'usage',
                      threadId: input.threadId,
                      turnId,
                      model,
                      usage
                    })
                  },
                  recordFallback
                })
              }
            }
          }
          if (modelSummary) {
            result = this.deps.compactor.compact({
              threadId: input.threadId,
              turnId,
              history,
              prefix,
              budgetTokens: input.request.budgetTokens,
              reason: input.request.reason,
              auto: false,
              summaryOverride: modelSummary,
              summaryItemId
            })
          }
        }
        return {
          changed: true,
          items: insertCompactionIntoVisibleHistory({
            visibleItems: snapshot.items,
            compactedItems: result.next,
            summaryItem: result.summaryItem
          }),
          value: result
        }
      }
    })
    if (committed.status !== 'applied' && committed.status !== 'unchanged') {
      // Preserve every newer append rather than making a stale compaction
      // appear successful. The next request can compact a fresh snapshot.
      return {
        threadId: input.threadId,
        replacedTokens: 0,
        summary: '',
        pinnedConstraints: prefix.pinnedConstraints
      }
    }
    const result = committed.value
    if (committed.status === 'applied') {
      await this.threadItems.syncFromSession(input.threadId)
      await this.deps.events.record({
        kind: 'compaction_completed',
        threadId: input.threadId,
        turnId,
        itemId: result.summaryItem.id,
        summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
        replacedTokens: result.replacedTokens,
        auto: false,
        pinnedConstraints: prefix.pinnedConstraints,
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
          ? { sourceDigest: result.summaryItem.sourceDigest }
          : {}),
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
          ? { digestMarker: result.summaryItem.digestMarker }
          : {}),
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
          ? { sourceItemIds: result.summaryItem.sourceItemIds }
          : {})
      })
      await this.deps.onCompacted?.(input.threadId)
    }
    return {
      threadId: input.threadId,
      replacedTokens: result.replacedTokens,
      summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
      pinnedConstraints: prefix.pinnedConstraints,
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
        ? { sourceDigest: result.summaryItem.sourceDigest }
        : {}),
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
        ? { digestMarker: result.summaryItem.digestMarker }
        : {}),
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
        ? { sourceItemIds: result.summaryItem.sourceItemIds }
        : {})
    }
  }

  /**
   * Persist a final turn state (running -> completed/failed/aborted).
   * Called by the agent loop when a model stream finishes.
   */
  async finishTurn(input: {
    threadId: string
    turnId: string
    status: TerminalTurnStatus
    error?: string
    code?: string
    details?: unknown
    severity?: RuntimeErrorSeverity
  }): Promise<TurnSettlement> {
    let settlement: TurnSettlement
    try {
      settlement = await this.withThreadMutation(input.threadId, async () => {
        const current = await this.deps.threadStore.get(input.threadId)
        if (!current) return { kind: 'missing' }
        const turn = current.turns.find((candidate) => candidate.id === input.turnId)
        if (!turn) return { kind: 'missing' }
        if (!isActiveTurn(turn)) {
          return {
            kind: 'already_terminal',
            status: terminalStatus(turn.status),
            ...(turn.error ? { error: turn.error } : {})
          }
        }
        const turns = current.turns.map((candidate) => {
          if (candidate.id !== input.turnId) return candidate
          const finished = this.finalizeOpenItems(finishTurn(candidate, input.status), input.status)
          return input.error ? { ...finished, error: input.error } : finished
        })
        await this.deps.threadStore.upsert({
          ...touchThread(current, this.deps.nowIso()),
          turns,
          status: threadStatusAfterTurnTransition(current.status, turns),
          updatedAt: this.deps.nowIso()
        })
        return {
          kind: 'applied',
          status: input.status,
          ...(input.error ? { error: input.error } : {})
        }
      })
    } catch (error) {
      // The model loop has already settled. Do not keep its in-process slot
      // forever just because its terminal status could not be persisted.
      this.clearRuntimeTurnState(input.threadId, input.turnId)
      throw error
    }
    if (settlement.kind !== 'applied') {
      // A thread can disappear while a loop is unwinding. It no longer has a
      // durable turn to update, but its in-process admission must not leak.
      this.clearRuntimeTurnState(input.threadId, input.turnId)
      return settlement
    }

    this.clearRuntimeTurnState(input.threadId, input.turnId)
    await this.finalizePersistedOpenItems(input.threadId, input.turnId, input.status)
    const errorItem = input.error
      ? makeErrorItem({
          id: `item_${input.turnId}_error`,
          turnId: input.turnId,
          threadId: input.threadId,
          message: input.error,
          ...(input.code ? { code: input.code } : {}),
          ...(input.details !== undefined ? { details: input.details } : {}),
          ...(input.severity ? { severity: input.severity } : {})
        })
      : null
    await this.deps.events.record({
      kind: input.status === 'completed' ? 'turn_completed' : input.status === 'aborted' ? 'turn_aborted' : 'turn_failed',
      threadId: input.threadId,
      turnId: input.turnId,
      ...(errorItem ? { itemId: errorItem.id } : {}),
      ...(input.error ? { message: input.error } : {}),
      ...(input.code ? { code: input.code } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.severity ? { severity: input.severity } : {})
    })
    if (errorItem) {
      await this.appendItem(input.threadId, errorItem)
    }
    return settlement
  }

  /**
   * Park a Graph source Lead between material events. The durable turn stays
   * running, but its process-local execution lease and capacity slot are
   * released. The per-thread mutation lock makes the empty-steering check
   * race-safe with steerTurn.
   */
  async suspendGraphLeadTurn(input: {
    threadId: string
    turnId: string
    /** Host shutdown must park even when in-memory steering is pending. */
    force?: boolean
    /** Host shutdown must not acknowledge Graph events the Lead has not handled. */
    preserveDeliveryCursor?: boolean
    /** Permit parking while durable Graph review/supervision work remains pending. */
    allowPendingSupervision?: boolean
  }): Promise<GraphLeadSuspensionResult> {
    const turn = await this.getTurn(input.threadId, input.turnId)
    if (!turn || turn.status !== 'running' || turn.orchestration !== 'graph') return 'not_graph'
    const attached = await this.deps.resolveGraphLeadRun?.(input)
    if (!attached) return this.suspendGraphPlanningTurn(input)
    if (attached.terminal) return 'graph_terminal'
    const planningLifecycle = await this.deps.resolveGraphPlanningDraft?.({
      threadId: input.threadId,
      sourceTurnId: input.turnId
    })

    return this.withThreadMutation(input.threadId, async () => {
      const current = await this.deps.threadStore.get(input.threadId)
      const latest = current?.turns.find((candidate) => candidate.id === input.turnId)
      if (!current || !latest || latest.status !== 'running' || latest.orchestration !== 'graph') {
        return 'not_graph'
      }
      if (
        input.force !== true &&
        (
          this.hasGraphSteeringResume(input.turnId) ||
          this.deps.steering.peek(input.turnId).length > 0
        )
      ) return 'pending_steering'
      if (attached.supervisionPending && input.allowPendingSupervision !== true) {
        return 'supervision_pending'
      }

      const now = this.deps.nowIso()
      const graphLeadLifecycle = {
        version: 1 as const,
        runId: attached.runId,
        state: 'supervising' as const,
        // Delivery is acknowledged when a bounded Lead episode starts from a
        // specific GraphRun snapshot. Never jump to the latest sequence while
        // parking: events written during the episode must remain redeliverable.
        lastDeliveredSeq: latest.graphLeadLifecycle?.lastDeliveredSeq ?? 0,
        suspendedAt: now,
        ...(latest.graphLeadLifecycle?.resumedAt
          ? { resumedAt: latest.graphLeadLifecycle.resumedAt }
          : {})
      }
      await this.deps.threadStore.upsert({
        ...current,
        turns: current.turns.map((candidate) =>
          candidate.id === input.turnId
            ? {
                ...candidate,
                graphLeadLifecycle,
                ...(planningLifecycle
                  ? { graphPlanningLifecycle: planningLifecycle }
                  : {})
              }
            : candidate),
        updatedAt: now
      })
      this.releaseRuntimeTurnExecution(input.threadId, input.turnId)
      return attached.supervisionPending
        ? 'suspended_pending_supervision'
        : 'suspended'
    })
  }

  async suspendGraphPlanningTurn(input: {
    threadId: string
    turnId: string
    /** Host shutdown must park even when in-memory steering is pending. */
    force?: boolean
  }): Promise<GraphLeadSuspensionResult> {
    let lifecycle = await this.deps.transitionGraphPlanningDraft?.({
      threadId: input.threadId,
      sourceTurnId: input.turnId,
      action: 'suspend'
    })
    if (!lifecycle && this.deps.createGraphPlanningDraft) {
      const thread = await this.deps.threadStore.get(input.threadId)
      const turn = thread?.turns.find((candidate) => candidate.id === input.turnId)
      if (thread && turn?.orchestration === 'graph') {
        await this.deps.createGraphPlanningDraft({
          threadId: input.threadId,
          sourceTurnId: input.turnId,
          goal: turn.prompt,
          workspace: thread.workspace
        })
        lifecycle = await this.deps.transitionGraphPlanningDraft?.({
          threadId: input.threadId,
          sourceTurnId: input.turnId,
          action: 'suspend'
        })
      }
    }
    if (!lifecycle) return 'not_graph'
    if (
      lifecycle.state === 'committed' ||
      lifecycle.state === 'cancelled' ||
      lifecycle.state === 'host_error'
    ) return 'graph_terminal'
    return this.withThreadMutation(input.threadId, async () => {
      const current = await this.deps.threadStore.get(input.threadId)
      const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
      if (!current || !turn || turn.status !== 'running') return 'not_graph'
      if (
        input.force !== true &&
        (
          this.hasGraphSteeringResume(input.turnId) ||
          this.deps.steering.peek(input.turnId).length > 0
        )
      ) return 'pending_steering'
      await this.deps.threadStore.upsert({
        ...current,
        turns: current.turns.map((candidate) =>
          candidate.id === input.turnId
            ? {
                ...candidate,
                graphPlanningLifecycle: lifecycle,
                requiredToolGate: undefined
              }
            : candidate),
        updatedAt: this.deps.nowIso()
      })
      this.releaseRuntimeTurnExecution(input.threadId, input.turnId)
      return 'suspended'
    })
  }

  async resumeGraphPlanningTurn(input: {
    threadId: string
    turnId: string
  }): Promise<GraphLeadResumeResult> {
    return this.withThreadMutation(input.threadId, async () => {
      const current = await this.deps.threadStore.get(input.threadId)
      const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
      let correctionRestored = false
      const restoreCorrection = async (): Promise<void> => {
        if (correctionRestored) return
        correctionRestored = true
        let lifecycle: GraphPlanningLifecycle | null | undefined
        try {
          lifecycle = await this.deps.transitionGraphPlanningDraft?.({
            threadId: input.threadId,
            sourceTurnId: input.turnId,
            action: 'suspend'
          })
        } finally {
          this.releaseRuntimeTurnExecution(input.threadId, input.turnId)
        }
        if (
          current &&
          turn?.status === 'running' &&
          turn.orchestration === 'graph' &&
          lifecycle?.state === 'needs_correction'
        ) {
          await this.deps.threadStore.upsert({
            ...current,
            turns: current.turns.map((candidate) =>
              candidate.id === input.turnId
                ? {
                    ...candidate,
                    graphPlanningLifecycle: lifecycle,
                    requiredToolGate: undefined
                  }
                : candidate),
            updatedAt: this.deps.nowIso()
          })
        }
      }

      try {
        if (!current || !turn) throw new Error(`turn not found: ${input.turnId}`)
        if (turn.status !== 'running' || turn.orchestration !== 'graph') {
          throw new TurnConflictError(`Graph source turn is not active: ${input.turnId}`)
        }
        if (this.inflightTurns.has(input.turnId)) return 'already_running'
        if (!this.tryAdmitTurn(input.turnId, input.threadId)) {
          throw new TurnCapacityError(this.maxConcurrentTurns)
        }
        const lifecycle = await this.deps.transitionGraphPlanningDraft?.({
          threadId: input.threadId,
          sourceTurnId: input.turnId,
          action: 'resume'
        })
        if (!lifecycle || lifecycle.state !== 'planning') {
          throw new TurnConflictError(`Graph planning draft is not resumable: ${input.turnId}`)
        }
        const controller = new AbortController()
        this.inflightTurns.set(input.turnId, controller)
        this.deps.inflight.begin({
          id: input.turnId,
          kind: 'model',
          threadId: input.threadId,
          turnId: input.turnId
        })
        this.deps.steering.reopen(input.turnId)
        await this.deps.threadStore.upsert({
          ...current,
          turns: current.turns.map((candidate) =>
            candidate.id === input.turnId
              ? { ...candidate, graphPlanningLifecycle: lifecycle }
              : candidate),
          updatedAt: this.deps.nowIso()
        })
        return 'resumed'
      } catch (error) {
        // Keep the compensating transition inside the same thread mutation
        // fence. A concurrent steering retry cannot acquire a fresh lease and
        // then be suspended by this older failed resume.
        await restoreCorrection()
        throw error
      }
    })
  }

  /**
   * Return true only while this exact durable source turn owns a nonterminal
   * GraphRun. AgentLoop uses this at ordinary direct-turn limit boundaries so
   * a live Graph is governed by its own ledger without granting an unlimited
   * pre-creation or post-terminal turn.
   */
  async graphRunOwnsLeadLimits(input: {
    threadId: string
    turnId: string
  }): Promise<boolean> {
    const turn = await this.getTurn(input.threadId, input.turnId)
    if (!turn || turn.status !== 'running' || turn.orchestration !== 'graph') return false
    const attached = await this.deps.resolveGraphLeadRun?.(input)
    return attached?.terminal === false
  }

  /**
   * Reacquire a process-local execution lease for an already-running Graph
   * source turn. Duplicate wake-ups share the active execution instead of
   * admitting a second model loop.
   */
  async resumeGraphLeadTurn(input: {
    threadId: string
    turnId: string
    runId: string
    lastDeliveredSeq: number
    terminal: boolean
  }): Promise<GraphLeadResumeResult> {
    const planningLifecycle = await this.deps.resolveGraphPlanningDraft?.({
      threadId: input.threadId,
      sourceTurnId: input.turnId
    })
    return this.withThreadMutation(input.threadId, async () => {
      const current = await this.deps.threadStore.get(input.threadId)
      const turn = current?.turns.find((candidate) => candidate.id === input.turnId)
      if (!current || !turn) throw new Error(`turn not found: ${input.turnId}`)
      if (turn.status !== 'running' || turn.orchestration !== 'graph') {
        throw new TurnConflictError(`Graph source turn is not active: ${input.turnId}`)
      }
      if (
        turn.graphLeadLifecycle?.runId &&
        turn.graphLeadLifecycle.runId !== input.runId
      ) {
        throw new TurnConflictError(
          `Graph source turn ${input.turnId} already owns ${turn.graphLeadLifecycle.runId}`
        )
      }
      if (this.inflightTurns.has(input.turnId)) {
        const now = this.deps.nowIso()
        await this.deps.threadStore.upsert({
          ...current,
          turns: current.turns.map((candidate) =>
            candidate.id === input.turnId
              ? {
                  ...candidate,
                  graphLeadLifecycle: {
                    version: 1 as const,
                    runId: input.runId,
                    state: input.terminal ? 'finalizing' as const : 'supervising' as const,
                    lastDeliveredSeq: Math.max(
                      candidate.graphLeadLifecycle?.lastDeliveredSeq ?? 0,
                      input.lastDeliveredSeq
                    ),
                    resumedAt: now,
                    ...(candidate.graphLeadLifecycle?.suspendedAt
                      ? { suspendedAt: candidate.graphLeadLifecycle.suspendedAt }
                      : {})
                  },
                  ...(planningLifecycle
                    ? { graphPlanningLifecycle: planningLifecycle }
                    : {})
                }
              : candidate),
          updatedAt: now
        })
        return 'already_running'
      }
      if (!this.tryAdmitTurn(input.turnId, input.threadId)) {
        throw new TurnCapacityError(this.maxConcurrentTurns)
      }
      try {
        const now = this.deps.nowIso()
        const controller = new AbortController()
        this.inflightTurns.set(input.turnId, controller)
        this.deps.inflight.begin({
          id: input.turnId,
          kind: 'model',
          threadId: input.threadId,
          turnId: input.turnId
        })
        this.deps.steering.reopen(input.turnId)
        await this.deps.threadStore.upsert({
          ...current,
          turns: current.turns.map((candidate) =>
            candidate.id === input.turnId
              ? {
                  ...candidate,
                  graphLeadLifecycle: {
                    version: 1 as const,
                    runId: input.runId,
                    state: input.terminal ? 'finalizing' as const : 'supervising' as const,
                    lastDeliveredSeq: Math.max(
                      candidate.graphLeadLifecycle?.lastDeliveredSeq ?? 0,
                      input.lastDeliveredSeq
                    ),
                    resumedAt: now,
                    ...(candidate.graphLeadLifecycle?.suspendedAt
                      ? { suspendedAt: candidate.graphLeadLifecycle.suspendedAt }
                      : {})
                  },
                  ...(planningLifecycle
                    ? { graphPlanningLifecycle: planningLifecycle }
                    : {})
                }
              : candidate),
          updatedAt: now
        })
        return 'resumed'
      } catch (error) {
        this.releaseRuntimeTurnExecution(input.threadId, input.turnId)
        throw error
      }
    })
  }

  isTurnExecutionActive(turnId: string): boolean {
    return this.inflightTurns.has(turnId)
  }

  getAbortController(turnId: string): AbortSignal | undefined {
    return this.inflightTurns.get(turnId)?.signal
  }

  /** Abort active turn work without changing its persisted lifecycle state. */
  abortTurnExecution(turnId: string): boolean {
    const controller = this.inflightTurns.get(turnId)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  }

  /**
   * Abort only the active executions owned by one thread. Persistence is not
   * touched here because delete has already closed the lifecycle fence and
   * will remove the thread once writers drain.
   */
  abortThreadExecution(threadId: string): number {
    let aborted = 0
    for (const [turnId, ownerThreadId] of this.admittedTurnThreads) {
      if (ownerThreadId !== threadId) continue
      const controller = this.inflightTurns.get(turnId)
      if (!controller || controller.signal.aborted) continue
      controller.abort()
      aborted += 1
    }
    return aborted
  }

  /**
   * Mark turns left 'queued'/'running' by a previous process as failed
   * so clients stop waiting on them after a crash or restart. Turns
   * owned by this process (inflight) are skipped, so the sweep is safe
   * to run in the background after the server starts listening.
   *
   * Returns the ids of threads that had at least one turn reconciled, so the
   * caller can resume goals that were interrupted mid-run (KunAgent/Kun#370).
   */
  async reconcileOrphanedTurns(): Promise<string[]> {
    // Include `side` threads: a delegated subagent runs on a hidden side thread
    // whose own turn is left `running` when the runtime is interrupted. Without
    // includeSide it is never swept, so its turn (and the parent's delegate_task
    // tool item) stay pending forever, wedging the thread (KunAgent/Kun#621).
    const summaries = await this.deps.threadStore.list({ includeSide: true })
    const reconciledThreadIds = new Set<string>()
    for (const summary of summaries) {
      const metadata = await (
        this.deps.threadStore.getMetadata?.(summary.id) ??
        this.deps.threadStore.get(summary.id)
      ).catch(() => null)
      if (!metadata?.turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) {
        continue
      }
      await this.deps.sessionStore.compactItems?.(summary.id).catch((error) => {
        console.warn(
          `[kun] item history compaction skipped for ${summary.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
        )
      })
      const thread = await this.deps.threadStore.get(summary.id).catch(() => null)
      if (!thread) continue
      for (const turn of thread.turns) {
        if (turn.status !== 'running' && turn.status !== 'queued') continue
        if (this.inflightTurns.has(turn.id)) continue
        if (turn.status === 'running' && turn.orchestration === 'graph') {
          const durablePlanning = await this.deps.resolveGraphPlanningDraft?.({
            threadId: thread.id,
            sourceTurnId: turn.id
          }).catch(() => null)
          if (durablePlanning?.state === 'cancelled') {
            // A cancel endpoint may have durably fenced the draft immediately
            // before the process exited. Complete the idempotent source/run
            // cancellation instead of leaving a spinner with no resume action.
            await this.interruptTurn({
              threadId: thread.id,
              turnId: turn.id
            }).catch(() => undefined)
            continue
          }
          if (turn.graphPlanningLifecycle?.suspendedAt) {
            // A clean host shutdown already parked this planning turn without
            // declaring the draft invalid. Keep it resumable in the same state.
            continue
          }
          let suspension = await this.suspendGraphLeadTurn({
            threadId: thread.id,
            turnId: turn.id
          }).catch(() => 'not_graph' as const)
          if (suspension === 'supervision_pending') {
            // Submitted/reviewing nodes are durable recovery work, not an
            // orphan failure. Park without acknowledging their event cursor;
            // GraphRuntime recovery will redeliver supervision to the Lead.
            suspension = await this.suspendGraphLeadTurn({
              threadId: thread.id,
              turnId: turn.id,
              force: true,
              preserveDeliveryCursor: true,
              allowPendingSupervision: true
            }).catch(() => 'not_graph' as const)
          }
          if (
            suspension === 'suspended' ||
            suspension === 'suspended_pending_supervision' ||
            suspension === 'pending_steering' ||
            suspension === 'graph_terminal'
          ) {
            continue
          }
        }
        try {
          await this.finishTurn({
            threadId: thread.id,
            turnId: turn.id,
            status: 'failed',
            error: 'Turn was interrupted by a runtime restart.',
            code: 'orphaned_after_restart',
            severity: 'warning'
          })
          reconciledThreadIds.add(thread.id)
        } catch {
          // Best-effort sweep; one unreadable thread must not stop the rest.
        }
      }
    }
    return [...reconciledThreadIds]
  }

  async getTurn(threadId: string, turnId: string): Promise<Turn | null> {
    const thread = await this.deps.threadStore.get(threadId)
    return thread?.turns.find((turn) => turn.id === turnId) ?? null
  }

  /**
   * Append the stable active-goal context exactly once before a model request.
   * This deliberately bypasses applyItem(): it is canonical model history,
   * not renderer content, so it must not create an SSE item event or enter the
   * renderer-facing thread mirror.
   */
  async ensureGoalContext(threadId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    await this.withThreadMutation(threadId, async () => {
      // The caller can wait behind another mutation while its execution lease
      // is cancelled. Check again inside the serialized section so an aborted
      // turn never gains model-only history after that wait.
      if (signal?.aborted) return
      const current = await this.deps.threadStore.get(threadId)
      const turn = current?.turns.find((candidate) => candidate.id === turnId)
      if (!current || !turn || (turn.status !== 'queued' && turn.status !== 'running')) return
      const text = goalContextInstruction(current.goal)
      const goalKey = goalContextKey(current.goal)
      if (!text || !goalKey) return

      const existing = await this.deps.sessionStore.loadItems(threadId)
      // The goal record is a thread-level cache prefix, not a per-turn
      // instruction. One active generation must therefore be represented
      // exactly once even when the goal spans many user turns.
      if (existing.some((item) => item.kind === 'goal_context' && item.goalKey === goalKey)) {
        return
      }
      if (signal?.aborted) return
      const itemId = `item_${turnId}_goal_context_${goalKey}`
      await this.deps.sessionStore.appendItem(threadId, makeGoalContextItem({
        id: itemId,
        threadId,
        turnId,
        goalKey,
        text,
        createdAt: this.deps.nowIso()
      }))
    })
  }

  async updateTurnMetadata(
    threadId: string,
    turnId: string,
    patch: Omit<Pick<
      Partial<Turn>,
      | 'activeSkillIds'
      | 'injectedMemoryIds'
      | 'injectedMemorySummaries'
      | 'skillInjectionBytes'
      | 'injectedInstructionSources'
      | 'instructionInjectionBytes'
      | 'toolCatalogFingerprint'
      | 'toolCatalogToolCount'
      | 'toolCatalogDrift'
      | 'requiredToolGate'
      | 'extensionModelRequests'
      | 'extensionToolInvocations'
      | 'workspaceCheckpointId'
      | 'actingModelRoute'
      | 'graphPlanningLifecycle'
    >, 'requiredToolGate'>
      & { requiredToolGate?: Turn['requiredToolGate'] | null }
  ): Promise<void> {
    await this.upsertThread(threadId, (current) => ({
      ...current,
      turns: current.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              ...(patch.activeSkillIds ? { activeSkillIds: [...patch.activeSkillIds] } : {}),
              ...(patch.injectedMemoryIds ? { injectedMemoryIds: [...patch.injectedMemoryIds] } : {}),
              ...(patch.injectedMemorySummaries
                ? { injectedMemorySummaries: [...patch.injectedMemorySummaries] }
                : {}),
              ...(patch.skillInjectionBytes !== undefined ? { skillInjectionBytes: patch.skillInjectionBytes } : {}),
              ...(patch.injectedInstructionSources
                ? { injectedInstructionSources: [...patch.injectedInstructionSources] }
                : {}),
              ...(patch.instructionInjectionBytes !== undefined
                ? { instructionInjectionBytes: patch.instructionInjectionBytes }
                : {}),
              ...(patch.toolCatalogFingerprint ? { toolCatalogFingerprint: patch.toolCatalogFingerprint } : {}),
              ...(patch.toolCatalogToolCount !== undefined ? { toolCatalogToolCount: patch.toolCatalogToolCount } : {}),
              ...(patch.toolCatalogDrift !== undefined ? { toolCatalogDrift: patch.toolCatalogDrift } : {}),
              ...(patch.requiredToolGate === null
                ? { requiredToolGate: undefined }
                : patch.requiredToolGate
                  ? { requiredToolGate: patch.requiredToolGate }
                  : {}),
              ...(patch.extensionModelRequests !== undefined
                ? { extensionModelRequests: patch.extensionModelRequests }
                : {}),
              ...(patch.extensionToolInvocations !== undefined
                ? { extensionToolInvocations: patch.extensionToolInvocations }
                : {}),
              ...(patch.workspaceCheckpointId
                ? { workspaceCheckpointId: patch.workspaceCheckpointId }
                : {}),
              // The first resolved model/provider/account tuple owns the turn.
              // Later steps and settings changes cannot replace it.
              ...(!turn.actingModelRoute && patch.actingModelRoute
                ? { actingModelRoute: { ...patch.actingModelRoute } }
                : {}),
              ...(patch.graphPlanningLifecycle
                ? { graphPlanningLifecycle: { ...patch.graphPlanningLifecycle } }
                : {})
            }
          : turn
      )
    }))
  }

  /**
   * Apply a tool or assistant item to the current turn. The agent loop
   * calls this after each chunk so SSE consumers see live updates.
   */
  async applyItem(threadId: string, item: TurnItem): Promise<void> {
    await this.appendItem(threadId, item)
    await this.deps.events.record({
      kind: 'item_created',
      threadId,
      turnId: item.turnId,
      itemId: item.id,
      item
    })
  }

  /**
   * Persist the cumulative assistant item before exposing its next replay
   * fragment. The ordering closes the hydrate event-before-state window; the
   * offset makes the opposite state-before-event window safe to replay.
   */
  async applyAssistantDelta(
    threadId: string,
    item: TurnItem,
    deltaText: string,
    deltaOffset: number
  ): Promise<void> {
    if (item.kind !== 'assistant_text' && item.kind !== 'assistant_reasoning') {
      throw new TypeError(`assistant delta requires assistant item: ${item.kind}`)
    }
    if (!Number.isSafeInteger(deltaOffset) || deltaOffset < 0) {
      throw new RangeError(`assistant delta offset must be a non-negative safe integer: ${deltaOffset}`)
    }
    // Do not rewrite the full thread mirror for every ~40 ms stream fragment.
    // The session item stream is the hydration source of truth; applyItem()
    // publishes the final authoritative item into both stores at round end.
    await this.deps.sessionStore.appendItem(threadId, item)
    await this.deps.events.record({
      kind: item.kind === 'assistant_text'
        ? 'assistant_text_delta'
        : 'assistant_reasoning_delta',
      threadId,
      turnId: item.turnId,
      itemId: item.id,
      deltaOffset,
      item: { ...item, text: deltaText }
    })
  }

  async publishTransientItem(threadId: string, item: TurnItem): Promise<void> {
    await this.deps.events.publishTransient({
      kind: 'item_updated',
      threadId,
      turnId: item.turnId,
      itemId: item.id,
      item
    })
  }

  async compactItemHistory(threadId: string): Promise<void> {
    if (!this.deps.sessionStore.compactItems) return
    await this.deps.sessionStore.compactItems(threadId).catch((error) => {
      console.warn(
        `[kun] item history compaction skipped for ${threadId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  async updateItem(
    threadId: string,
    itemId: string,
    patch: Partial<TurnItem>
  ): Promise<TurnItem | null> {
    const updatedInSession = await this.deps.sessionStore.updateItem(threadId, itemId, patch)
    const updatedItems: TurnItem[] = []
    if (this.deps.threadStore.touch) {
      await this.deps.threadStore.touch(threadId, this.deps.nowIso())
    } else {
      await this.upsertThread(threadId, (current) => {
        const turns = current.turns.map((turn) => {
          const existing = turn.items.find((item) => item.id === itemId)
          if (!existing) return turn
          updatedItems[0] = { ...existing, ...patch } as TurnItem
          return replaceTurnItem(turn, itemId, patch)
        })
        return { ...current, turns }
      })
    }
    const updated = updatedItems[0] ?? updatedInSession
    if (!updated) return null
    await this.deps.events.record({
      kind: 'item_updated',
      threadId,
      turnId: updated.turnId,
      itemId: updated.id,
      item: updated
    })
    return updated
  }

  private async appendItem(threadId: string, item: TurnItem): Promise<void> {
    await this.deps.sessionStore.appendItem(threadId, item)
    await this.upsertThread(threadId, (current) => {
      const turn = current.turns.find((t) => t.id === item.turnId)
      if (!turn) return current
      const nextTurn = appendTurnItem(turn, item)
      const turns = current.turns.map((t) => (t.id === item.turnId ? nextTurn : t))
      return { ...current, turns }
    })
  }

  private async upsertThread(
    threadId: string,
    mutator: (current: ThreadRecord) => ThreadRecord
  ): Promise<void> {
    await this.withThreadMutation(threadId, async () => {
      const current = await this.deps.threadStore.get(threadId)
      if (!current) return
      const next = mutator(current)
      await this.deps.threadStore.upsert({ ...next, updatedAt: this.deps.nowIso() })
    })
  }

  private async withThreadMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return withThreadStoreMutation(this.deps.threadStore, threadId, operation)
  }

  private tryAdmitTurn(turnId: string, threadId: string): boolean {
    if (this.admittedTurnThreads.size >= this.maxConcurrentTurns) {
      return false
    }
    // There is no await between capacity check and this map insertion, so
    // starts serialized on different thread locks cannot over-admit.
    this.admittedTurnThreads.set(turnId, threadId)
    return true
  }

  private clearRuntimeTurnState(
    threadId: string,
    turnId: string,
    options: { abort?: boolean } = {}
  ): void {
    this.releaseRuntimeTurnExecution(threadId, turnId, options)
    this.deps.steering.clear(turnId)
  }

  private releaseRuntimeTurnExecution(
    threadId: string,
    turnId: string,
    options: { abort?: boolean } = {}
  ): void {
    const admittedThreadId = this.admittedTurnThreads.get(turnId)
    if (admittedThreadId !== threadId) {
      // An external interrupt may already have released admission before the
      // model loop observes the abort and seals its terminal boundary. The
      // loop's later idempotent finish must still clear that transient seal.
      return
    }
    if (options.abort) this.inflightTurns.get(turnId)?.abort()
    this.inflightTurns.delete(turnId)
    this.deps.inflight.end(turnId)
    this.admittedTurnThreads.delete(turnId)
    if (this.leasedTurns.delete(turnId)) {
      void this.deps.executionLeases?.release(threadId, turnId).catch(() => undefined)
    }
  }

  private finalizeOpenItems(
    turn: Turn,
    status: Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>
  ): Turn {
    const finishedAt = this.deps.nowIso()
    const items = finalizeTurnItems(turn.items, { turnId: turn.id, status, finishedAt })
    return items === turn.items ? turn : { ...turn, items }
  }

  private async discardTurnItems(threadId: string, turnId: string): Promise<void> {
    const history = await rewriteItemHistoryWithRetry({
      sessionStore: this.deps.sessionStore,
      threadId,
      maxAttempts: 3,
      build: (snapshot) => {
        const items = snapshot.items.filter((item) => item.turnId !== turnId || item.kind === 'user_message')
        return {
          changed: items.length !== snapshot.items.length,
          items,
          value: undefined
        }
      }
    })
    if (history.status === 'applied' || history.status === 'unchanged') {
      await this.threadItems.syncFromSession(threadId)
    }
  }

  private async finalizePersistedOpenItems(
    threadId: string,
    turnId: string,
    status: Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>
  ): Promise<void> {
    const items = await this.deps.sessionStore.loadItems(threadId)
    const finishedAt = this.deps.nowIso()
    const finalizedItems = finalizeTurnItems(items, { turnId, status, finishedAt })
    if (finalizedItems === items) return
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const finalized = finalizedItems[index]
      if (!item || !finalized || finalized === item) continue
      await this.updateItem(threadId, item.id, finalized)
    }
  }

  private keepUserItems(items: TurnItem[]): TurnItem[] {
    return items.filter((item) => item.kind === 'user_message')
  }

}

function isActiveTurn(turn: Turn): turn is Turn & { status: 'queued' | 'running' } {
  return turn.status === 'queued' || turn.status === 'running'
}

function terminalStatus(status: TurnStatus): TerminalTurnStatus {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'aborted':
      return status
    default:
      throw new Error(`expected terminal turn status, got ${status}`)
  }
}

function threadStatusFromTurns(turns: Turn[]): ThreadStatus {
  return turns.some(isActiveTurn) ? 'running' : 'idle'
}

/**
 * `archived` is a visibility/lifecycle overlay rather than a turn-derived
 * execution state. A turn may finish or be interrupted after archival, but
 * that settlement must not implicitly unarchive the thread.
 */
function threadStatusAfterTurnTransition(currentStatus: ThreadStatus, turns: Turn[]): ThreadStatus {
  return currentStatus === 'archived' ? 'archived' : threadStatusFromTurns(turns)
}

function normalizeMaxConcurrentTurns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_TURNS
  return Math.max(1, Math.floor(value))
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  return undefined
}

function modelForManualCompaction(input: {
  turnModel?: string
  threadModel?: string
  defaultModel?: string
  clientModel?: string
}): string {
  for (const candidate of [input.turnModel, input.threadModel, input.defaultModel, input.clientModel]) {
    const normalized = candidate?.trim()
    if (!normalized || normalized.toLowerCase() === 'auto') continue
    return normalized
  }
  return input.turnModel?.trim() || input.threadModel?.trim() || input.defaultModel?.trim() || input.clientModel?.trim() || ''
}
