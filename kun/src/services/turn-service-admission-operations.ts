import { createHash } from 'node:crypto'
import type { ThreadRecord, ThreadStatus } from '../contracts/threads.js'
import { StartTurnRequest as StartTurnRequestSchema } from '../contracts/turns.js'
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
import { type TurnService, type TurnServiceDeps, TurnConflictError, TurnCapacityError, type TerminalTurnStatus, type TurnSettlement, type GraphLeadSuspensionResult, type GraphLeadResumeResult, HOST_SHUTDOWN_TURN_SUSPENSION_CODE, hostShutdownTurnSuspensionReason, isHostShutdownTurnSuspension, DEFAULT_MAX_CONCURRENT_TURNS, fingerprintStartTurnRequest, canonicalizeFingerprintValue, isActiveTurn, terminalStatus, threadStatusFromTurns, threadStatusAfterTurnTransition, normalizeMaxConcurrentTurns, firstNonBlank, modelForManualCompaction } from './turn-service-core.js'

export const turnServiceAdmissionOperations = {
updateRuntimeConfig(this: TurnService,
    patch: Partial<Pick<TurnServiceDeps, 'model' | 'defaultModel' | 'contextCompaction' | 'maxConcurrentTurns'>>
  ): void {
    this['deps'] = {
      ...this['deps'],
      ...patch
    }
    if ('maxConcurrentTurns' in patch) {
      this['maxConcurrentTurns'] = normalizeMaxConcurrentTurns(patch.maxConcurrentTurns)
    }
  },

async startTurn(this: TurnService, input: {
    threadId: string
    request: StartTurnRequest
  }, options: {
    /** Internal extension-broker accounting baseline; not part of StartTurnRequest. */
    extensionBudgetTokenBaseline?: number
    /** Runs only for a newly admitted turn, never for an idempotent replay. */
    onAdmitted?: (response: StartTurnResponse) => void
  } = {}): Promise<StartTurnResponse> {
    const requestFingerprint = fingerprintStartTurnRequest(input.request)
    const replay = await this['findIdempotentStart'](input, requestFingerprint)
    if (replay) return replay
    if (this['deps'].migrationMaintenance?.isLocked()) {
      throw new TurnConflictError('runtime migration maintenance is in progress')
    }
    const currentOwner = await this['deps'].executionLeases?.owner(input.threadId)
    if (currentOwner) throw new ThreadExecutionBusyError(currentOwner)
    let attemptedTurnId: string | undefined
    try {
      const started = await this['withThreadMutation'](input.threadId, async () => {
        if (this['deps'].lifecycleFence?.isClosing(input.threadId)) {
          throw new TurnConflictError(`thread is being deleted: ${input.threadId}`)
        }
        const thread = await this['deps'].threadStore.get(input.threadId)
        if (!thread) throw new Error(`thread not found: ${input.threadId}`)
        const replay = this['idempotentStartFromThread'](thread, input.request, requestFingerprint)
        if (replay) return { kind: 'replay' as const, response: replay }
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
        const turnId = this['deps'].ids.next('turn')
        if (!this['tryAdmitTurn'](turnId, input.threadId)) {
          throw new TurnCapacityError(this['maxConcurrentTurns'])
        }
        attemptedTurnId = turnId
        try {
          if (this['deps'].executionLeases) {
            await this['deps'].executionLeases.acquire(input.threadId, turnId)
            this['leasedTurns'].add(turnId)
          }
          const composerContexts = ComposerContextAttachmentSchema.array().parse(
            input.request.composerContexts ?? []
          )
          const attachmentIds = [...new Set(
            (input.request.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)
          )]
          if (attachmentIds.length > 0) {
            const attachmentStore = this['deps'].attachmentStore?.()
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
            input.request.orchestration === 'graph' && this['deps'].createGraphPlanningDraft
              ? await this['deps'].createGraphPlanningDraft({
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
            this['deps'].defaultModel,
            this['deps'].model?.model
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
            clientRequestId: input.request.clientRequestId,
            clientRequestFingerprint: requestFingerprint,
            prompt: input.request.prompt,
            messageSource: input.request.messageSource,
            subagentResume: input.request.subagentResume,
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
            persona: input.request.persona,
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
            ...touchThread(thread, this['deps'].nowIso()),
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
          await this['deps'].threadStore.upsert({ ...next, updatedAt: this['deps'].nowIso() })
          await this['deps'].sessionStore.appendItem(input.threadId, userItem)
          this['inflightTurns'].set(turnId, controller)
          this['deps'].inflight.begin({ id: turnId, kind: 'model', threadId: input.threadId, turnId })
          return { kind: 'admitted' as const, turnId, userItem, turn: startedTurn }
        } catch (error) {
          // A failed start has no loop to perform lifecycle cleanup. Release
          // its slot immediately; the outer catch best-effort marks any
          // already-persisted turn aborted so it cannot strand the thread.
          this['clearRuntimeTurnState'](input.threadId, turnId, { abort: true })
          throw error
        }
      })
      if (started.kind === 'replay') return started.response
      await this['deps'].events.record({
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
      await this['deps'].events.record({
        kind: 'item_created',
        threadId: input.threadId,
        turnId: started.turnId,
        itemId: started.userItem.id,
        item: started.userItem
      })
      await this['markTurnAdmissionCompleted'](input.threadId, started.turnId)
      const response = {
        threadId: input.threadId,
        turnId: started.turnId,
        userMessageItemId: started.userItem.id
      }
      options.onAdmitted?.(response)
      return response
    } catch (error) {
      if (attemptedTurnId) {
        // This is deliberately outside the per-thread mutation callback: the
        // latter must unwind before interruptTurn can take the same lock.
        await this.interruptTurn({ threadId: input.threadId, turnId: attemptedTurnId }).catch(() => undefined)
      }
      throw error
    }
  },

async findIdempotentStart(this: TurnService, input: {
    threadId: string
    request: StartTurnRequest
  }, requestFingerprint: string | undefined): Promise<StartTurnResponse | null> {
    const clientRequestId = input.request.clientRequestId?.trim()
    if (!clientRequestId) return null
    const projection = this['deps'].threadStore.getMetadata
      ? await this['deps'].threadStore.getMetadata(input.threadId)
      : await this['deps'].threadStore.get(input.threadId)
    const projectedTurn = projection?.turns.find((turn) =>
      turn.clientRequestId === clientRequestId && !this['isRetryableFailedAdmission'](turn)
    )
    if (!projectedTurn) return null
    if (projectedTurn.prompt) {
      return this['idempotentStartFromTurn'](projectedTurn, input.request, requestFingerprint)
    }
    const hydrated = await this['deps'].threadStore.get(input.threadId)
    const turn = hydrated?.turns.find((candidate) =>
      candidate.clientRequestId === clientRequestId && !this['isRetryableFailedAdmission'](candidate)
    )
    return turn ? this['idempotentStartFromTurn'](turn, input.request, requestFingerprint) : null
  },

idempotentStartFromThread(this: TurnService,
    thread: ThreadRecord,
    request: StartTurnRequest,
    requestFingerprint: string | undefined
  ): StartTurnResponse | null {
    const clientRequestId = request.clientRequestId?.trim()
    if (!clientRequestId) return null
    const turn = thread.turns.find((candidate) =>
      candidate.clientRequestId === clientRequestId && !this['isRetryableFailedAdmission'](candidate)
    )
    return turn ? this['idempotentStartFromTurn'](turn, request, requestFingerprint) : null
  },

isRetryableFailedAdmission(this: TurnService, turn: Turn): boolean {
    return !turn.admissionCompletedAt && (turn.status === 'aborted' || turn.status === 'failed')
  },

idempotentStartFromTurn(this: TurnService,
    turn: Turn,
    request: StartTurnRequest,
    requestFingerprint: string | undefined
  ): StartTurnResponse | null {
    const userItem = turn.items.find((item) => item.kind === 'user_message')
    const originalPrompt = userItem?.text || turn.prompt
    // A different runtime may observe the metadata write in the narrow window
    // before the canonical user item is durable. Treat that as not yet
    // admitted so the execution lease remains authoritative for the retry.
    if (!originalPrompt) return null
    if (turn.clientRequestFingerprint) {
      if (turn.clientRequestFingerprint !== requestFingerprint) {
        throw new TurnConflictError('clientRequestId is already associated with a different request')
      }
    } else if (originalPrompt !== request.prompt) {
      throw new TurnConflictError('clientRequestId is already associated with a different prompt')
    }
    return {
      threadId: turn.threadId,
      turnId: turn.id,
      userMessageItemId: userItem?.id ?? `item_${turn.id}_user`
    }
  },

async rewindThread(this: TurnService, input: {
    threadId: string
    turnId: string
  }): Promise<RewindThreadResponse> {
    return this['withThreadMutation'](input.threadId, async () => {
      const thread = await this['deps'].threadStore.get(input.threadId)
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
        sessionStore: this['deps'].sessionStore,
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
      const now = this['deps'].nowIso()
      await this['deps'].threadStore.upsert({
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
  },
}
