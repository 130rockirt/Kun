import type { ThreadRecord } from '../contracts/threads.js'
import type {
  StartTurnRequest,
  StartTurnResponse,
  Turn
} from '../contracts/turns.js'
import { makeUserItem } from '../domain/item.js'
import { appendTurnItem, createTurnRecord, finishTurn, startTurn as startTurnRecord } from '../domain/turn.js'
import { resolveThreadAgentSurface, touchThread } from '../domain/thread.js'
import { ComposerContextAttachmentSchema } from '../contracts/composer-context.js'
import { withManagerDataMutex } from '../manager/data-mutex.js'
import {
  type TurnService,
  TurnConflictError,
  TurnCapacityError,
  ThreadClosingError,
  TaskSurfaceLockedError,
  DesignProfileLockedError,
  threadStatusAfterTurnTransition,
  firstNonBlank,
  fingerprintStartTurnRequest
} from './turn-service-core.js'
import { resolveDesignTurnAdmission } from './turn-service-design-admission.js'

export const QUEUE_CANCELLED_TURN_CODE = 'queue_cancelled'
export const QUEUE_ADMISSION_FAILED_CODE = 'queue_admission_failed'
/** Backstop against unbounded per-thread queue growth. */
export const MAX_QUEUED_TURNS_PER_THREAD = 50

function queuedTurns(thread: ThreadRecord): Turn[] {
  return thread.turns.filter((turn) => turn.status === 'queued')
}

function userItemId(turnId: string): string {
  return `item_${turnId}_user`
}

function queuedResponse(thread: ThreadRecord, turn: Turn): StartTurnResponse {
  const position = queuedTurns(thread).findIndex((candidate) => candidate.id === turn.id) + 1
  return {
    threadId: thread.id,
    turnId: turn.id,
    userMessageItemId: userItemId(turn.id),
    status: 'queued',
    queuedPosition: Math.max(1, position),
    threadAgentSurface: resolveThreadAgentSurface(thread),
    ...(turn.agentSurface ? { agentSurface: turn.agentSurface } : {}),
    ...(turn.designProfile ? { designProfile: turn.designProfile } : {}),
    ...(turn.designDocumentTarget ? { designDocumentTarget: turn.designDocumentTarget } : {})
  }
}

/**
 * Per-thread durable turn queue. Queued turns are ordinary turn records with
 * status `queued`; they hold no execution lease and no global admission slot
 * until `startNextQueuedTurn` promotes the oldest one to running.
 */
export const turnServiceQueueOperations = {
  /**
   * Persist a start request as a queued turn. Used when the thread already
   * has an active turn and the caller passed `enqueueIfBusy`. The durable
   * record freezes the model/provider/profile snapshot at enqueue time, and
   * its user item is appended to the session so the queued message is
   * visible to every client immediately.
   */
  async enqueueTurn(this: TurnService, input: {
    threadId: string
    request: StartTurnRequest
  }): Promise<StartTurnResponse> {
    const finishAdmission = this['beginExecutionAdmission']()
    let attemptedTurnId: string | undefined
    let admissionAccepted = false
    try {
      if (this['deps'].migrationMaintenance?.isLocked()) {
        throw new TurnConflictError('runtime migration maintenance is in progress')
      }
      const started = await withManagerDataMutex(`thread:${input.threadId}`, () =>
        this['withThreadMutation'](input.threadId, async () => {
          if (this['deps'].lifecycleFence?.isClosing(input.threadId)) {
            throw new ThreadClosingError(input.threadId)
          }
          const thread = await this['deps'].threadStore.get(input.threadId)
          if (!thread) throw new Error(`thread not found: ${input.threadId}`)
          if (thread.status === 'archived') {
            throw new TurnConflictError(`thread is archived: ${input.threadId}`)
          }
          const running = thread.turns.filter((turn) => turn.status === 'running').length
          if (running === 0 && !await this['deps'].executionLeases?.owner(input.threadId)) {
            throw new TurnConflictError(
              `cannot enqueue: no active turn on thread ${input.threadId}`
            )
          }
          if (queuedTurns(thread).length >= MAX_QUEUED_TURNS_PER_THREAD) {
            throw new TurnConflictError(
              `queued turn limit reached (${MAX_QUEUED_TURNS_PER_THREAD}) for thread ${input.threadId}`
            )
          }
          const turnId = this['deps'].ids.next('turn')
          const designAdmission = resolveDesignTurnAdmission({
            thread,
            request: input.request,
            turnId
          })
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
          const turnModel = firstNonBlank(
            input.request.model,
            thread.model,
            this['deps'].defaultModel,
            this['deps'].model?.model
          )
          const requestedProviderId = firstNonBlank(input.request.providerId)
          const threadProviderId = firstNonBlank(thread.providerId)
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
            clientRequestFingerprint: fingerprintStartTurnRequest(input.request),
            admissionPending: true,
            prompt: input.request.prompt,
            messageSource: input.request.messageSource,
            subagentResume: input.request.subagentResume,
            model: turnModel,
            providerId: turnProviderId,
            accountId: turnAccountId,
            reasoningEffort: input.request.reasoningEffort,
            serviceTier: input.request.serviceTier,
            clientSurface: input.request.clientSurface,
            approvalPolicy: input.request.approvalPolicy ?? thread.approvalPolicy,
            sandboxMode: input.request.sandboxMode ?? thread.sandboxMode,
            approvalReviewer: input.request.approvalReviewer ?? thread.approvalReviewer,
            attachmentIds,
            composerContexts,
            guiPlan: input.request.guiPlan,
            guiDesignCanvas: input.request.guiDesignCanvas,
            guiDesignMode: input.request.guiDesignMode,
            agentSurface: designAdmission.effectiveSurface,
            designProfile: designAdmission.effectiveProfile,
            designDocumentTarget: designAdmission.effectiveDocumentTarget,
            persona: input.request.persona,
            guiDesignArtifact: input.request.guiDesignArtifact,
            mode: input.request.mode,
            orchestration: input.request.orchestration,
            disableUserInput: input.request.disableUserInput,
            imContext: input.request.imContext,
            workspaceCheckpointId: input.request.workspaceCheckpointId,
            workspaceCheckpointRequestId: input.request.workspaceCheckpointRequestId
          })
          const userItem = makeUserItem({
            id: userItemId(turnId),
            turnId,
            threadId: input.threadId,
            text: input.request.prompt,
            displayText: input.request.displayText,
            messageSource: input.request.messageSource,
            attachmentIds,
            composerContexts,
            fileReferences: input.request.fileReferences ?? [],
            workspaceCheckpointId: input.request.workspaceCheckpointId,
            workspace: thread.workspace,
            threadAgentSurface: designAdmission.locksSurface && designAdmission.effectiveSurface
              ? designAdmission.effectiveSurface
              : resolveThreadAgentSurface(thread),
            agentSurface: designAdmission.effectiveSurface,
            designProfile: designAdmission.effectiveProfile,
            designDocumentTarget: designAdmission.effectiveDocumentTarget,
            designImagePlacementTarget: input.request.designImagePlacementTarget
          })
          const now = this['deps'].nowIso()
          // Phase 1: persist the queued turn as a pending admission. Its user
          // item has not crossed the durable commit boundary yet.
          const queuedTurn = appendTurnItem(turn, userItem)
          const next: ThreadRecord = {
            ...touchThread(thread, now),
            status: 'running',
            turns: [...thread.turns, queuedTurn],
            updatedAt: now
          }
          attemptedTurnId = turnId
          await this['deps'].threadStore.upsert(next)
          // Phase 2: persist the session user item, the commit boundary.
          await this['deps'].sessionStore.appendItem(input.threadId, userItem)
          return { turnId, userItem }
        })
      )
      // Commit phase (outside the thread mutation lock): once the user item is
      // durable the queued admission is final and a retry becomes an idempotent
      // replay. If append failed above, the catch below rolls the turn back.
      const committedThread = await this['markTurnAdmissionCompleted'](input.threadId, started.turnId, {})
      admissionAccepted = true
      const committed = committedThread.turns.find((candidate) => candidate.id === started.turnId)
      if (!committed) throw new Error(`queued turn not found after commit: ${started.turnId}`)
      await this['deps'].events.record({
        kind: 'turn_queued',
        threadId: input.threadId,
        turnId: started.turnId,
        text: input.request.prompt,
        ...(input.request.displayText ? { displayText: input.request.displayText } : {}),
        ...(committed.model ? { model: committed.model } : {}),
        ...(committed.providerId ? { providerId: committed.providerId } : {}),
        ...(committed.accountId ? { accountId: committed.accountId } : {}),
        ...(committed.mode ? { mode: committed.mode } : {}),
        threadAgentSurface: resolveThreadAgentSurface(committedThread),
        ...(committed.agentSurface ? { agentSurface: committed.agentSurface } : {})
      }).catch(() => undefined)
      await this['deps'].events.record({
        kind: 'item_created',
        threadId: input.threadId,
        turnId: started.turnId,
        itemId: started.userItem.id,
        item: started.userItem
      }).catch(() => undefined)
      return queuedResponse(committedThread, committed)
    } catch (error) {
      if (attemptedTurnId && !admissionAccepted) {
        const rolledBack = await this['rollbackPendingAdmission'](
          input.threadId,
          attemptedTurnId
        ).catch(() => false)
        if (!rolledBack) {
          await this.interruptTurn({
            threadId: input.threadId,
            turnId: attemptedTurnId
          }).catch(() => undefined)
        }
        this['clearRuntimeTurnState'](input.threadId, attemptedTurnId, { abort: true, releaseLease: false })
      }
      throw error
    } finally {
      finishAdmission()
    }
  },

  /**
   * Promote the oldest queued turn to running. Returns the promoted turn id,
   * or null when no queued turn can start right now (no queue, another turn
   * still running, capacity exhausted, or execution owned elsewhere). A
   * queued turn whose durable admission snapshot can no longer be applied
   * (surface/profile lock moved on) is failed in place and the next queued
   * candidate is tried instead.
   */
  async startNextQueuedTurn(this: TurnService, threadIdOrInput: string | {
    threadId: string
  }): Promise<{ turnId: string } | null> {
    const input = typeof threadIdOrInput === 'string' ? { threadId: threadIdOrInput } : threadIdOrInput
    const finishAdmission = this['beginExecutionAdmission']()
    try {
      return await withManagerDataMutex(`thread:${input.threadId}`, () =>
        this['withThreadMutation'](input.threadId, async () => {
          const failCandidateInPlace = async (
            thread: ThreadRecord,
            candidate: Turn,
            message: string
          ): Promise<void> => {
            const now = this['deps'].nowIso()
            const failedTurn = finishTurn(candidate, 'failed', now)
            const turns = thread.turns.map((turn) =>
              turn.id === candidate.id
                ? {
                    ...this['finalizeOpenItems'](failedTurn, 'failed'),
                    error: message,
                    terminalCode: QUEUE_ADMISSION_FAILED_CODE
                  }
                : turn
            )
            await this['deps'].threadStore.upsert({
              ...touchThread(thread, now),
              turns,
              status: threadStatusAfterTurnTransition(thread.status, turns),
              updatedAt: now
            })
            await this['deps'].events.record({
              kind: 'turn_failed',
              threadId: input.threadId,
              turnId: candidate.id,
              message,
              code: QUEUE_ADMISSION_FAILED_CODE,
              severity: 'warning'
            }).catch(() => undefined)
          }
          while (true) {
            if (this['deps'].lifecycleFence?.isClosing(input.threadId)) return null
            const thread = await this['deps'].threadStore.get(input.threadId)
            if (!thread || thread.status === 'archived') return null
            if (thread.turns.some((turn) => turn.status === 'running')) return null
            if (await this['deps'].executionLeases?.owner(input.threadId)) return null
            const candidate = queuedTurns(thread)[0]
            if (!candidate) return null
            if (candidate.admissionPending) {
              // The queued admission never reached its commit boundary before
              // this promotion was reached (e.g. a manual start before restart
              // reconciliation finished). The session user item is the commit
              // boundary: commit it inline, or fail the candidate in place.
              const sessionItems = await this['deps'].sessionStore
                .loadItems(input.threadId)
                .catch(() => null)
              const hasUserItem = Boolean(
                sessionItems?.some((item) => item.turnId === candidate.id && item.kind === 'user_message')
              )
              if (!hasUserItem) {
                await failCandidateInPlace(thread, candidate, 'queued admission never crossed the durable boundary')
                continue
              }
            }
            const requestSnapshot: StartTurnRequest = {
              prompt: candidate.prompt,
              orchestration: candidate.orchestration ?? 'direct',
              attachmentIds: candidate.attachmentIds ?? [],
              composerContexts: candidate.composerContexts ?? [],
              fileReferences: [],
              ...(candidate.agentSurface ? { agentSurface: candidate.agentSurface } : {}),
              ...(candidate.designProfile ? { designProfile: candidate.designProfile } : {}),
              ...(candidate.designDocumentTarget
                ? { designDocumentTarget: candidate.designDocumentTarget }
                : {})
            }
            let designAdmission
            try {
              designAdmission = resolveDesignTurnAdmission({
                thread,
                request: requestSnapshot,
                turnId: candidate.id
              })
            } catch (error) {
              if (
                error instanceof TaskSurfaceLockedError ||
                error instanceof DesignProfileLockedError
              ) {
                await failCandidateInPlace(thread, candidate, error.message)
                continue
              }
              throw error
            }
            if (!this['tryAdmitTurn'](candidate.id, input.threadId)) {
              return null
            }
            try {
              if (this['deps'].executionLeases) {
                const lease = await this['deps'].executionLeases.acquire(input.threadId, candidate.id)
                this['leasedTurns'].set(candidate.id, lease)
              }
              const now = this['deps'].nowIso()
              const startedTurn = candidate.admissionPending
                ? (() => {
                    const { admissionPending: _pending, ...committed } = startTurnRecord(candidate, now)
                    return { ...committed, admissionCompletedAt: now }
                  })()
                : startTurnRecord(candidate, now)
              const next: ThreadRecord = {
                ...touchThread(thread, now),
                ...(designAdmission.locksSurface && designAdmission.effectiveSurface
                  ? { agentSurface: designAdmission.effectiveSurface }
                  : {}),
                ...(designAdmission.locksProfile && designAdmission.effectiveProfile
                  ? { designProfile: designAdmission.effectiveProfile }
                  : {}),
                status: 'running',
                turns: thread.turns.map((turn) => turn.id === candidate.id ? startedTurn : turn),
                updatedAt: now
              }
              await this['deps'].threadStore.upsert(next)
              this['inflightTurns'].set(candidate.id, new AbortController())
              this['deps'].inflight.begin({
                id: candidate.id,
                kind: 'model',
                threadId: input.threadId,
                turnId: candidate.id
              })
              await this['deps'].events.record({
                kind: 'turn_started',
                threadId: input.threadId,
                turnId: candidate.id,
                ...(startedTurn.model ? { model: startedTurn.model } : {}),
                ...(startedTurn.providerId ? { providerId: startedTurn.providerId } : {}),
                ...(startedTurn.accountId ? { accountId: startedTurn.accountId } : {}),
                ...(startedTurn.mode ? { mode: startedTurn.mode } : {}),
                threadAgentSurface: resolveThreadAgentSurface(next),
                ...(startedTurn.agentSurface ? { agentSurface: startedTurn.agentSurface } : {}),
                ...(startedTurn.designProfile ? { designProfile: startedTurn.designProfile } : {}),
                ...(startedTurn.designDocumentTarget
                  ? { designDocumentTarget: startedTurn.designDocumentTarget }
                  : {})
              }).catch(() => undefined)
              return { turnId: candidate.id }
            } catch (error) {
              this['clearRuntimeTurnState'](input.threadId, candidate.id, {
                abort: true,
                releaseLease: true
              })
              throw error
            }
          }
        })
      )
    } finally {
      finishAdmission()
    }
  },

  /**
   * Cancel a queued turn. Returns true when the queued turn was aborted.
   * A turn that already left the queue (running or terminal) returns false
   * so the caller can fall back to interrupt semantics.
   */
  async cancelQueuedTurn(this: TurnService, input: {
    threadId: string
    turnId: string
  }): Promise<{ threadId: string; turnId: string; status: 'aborted' }> {
    return this['withThreadMutation'](input.threadId, async () => {
      const thread = await this['deps'].threadStore.get(input.threadId)
      if (!thread) throw new Error(`thread not found: ${input.threadId}`)
      const turn = thread.turns.find((candidate) => candidate.id === input.turnId)
      if (!turn) throw new Error(`turn not found: ${input.turnId}`)
      if (turn.status !== 'queued') {
        throw new TurnConflictError(`turn is not queued: ${input.turnId}`)
      }
      const now = this['deps'].nowIso()
      const abortedTurn = this['finalizeOpenItems'](finishTurn(turn, 'aborted', now), 'aborted')
      const turns = thread.turns.map((candidate) =>
        candidate.id === input.turnId
          ? { ...abortedTurn, terminalCode: QUEUE_CANCELLED_TURN_CODE }
          : candidate
      )
      await this['deps'].threadStore.upsert({
        ...touchThread(thread, now),
        turns,
        status: threadStatusAfterTurnTransition(thread.status, turns),
        updatedAt: now
      })
      await this['deps'].events.record({
        kind: 'turn_aborted',
        threadId: input.threadId,
        turnId: input.turnId,
        code: QUEUE_CANCELLED_TURN_CODE
      }).catch(() => undefined)
      return { threadId: input.threadId, turnId: input.turnId, status: 'aborted' }
    })
  },

  /**
   * Reorder a queued turn relative to a queued sibling. Only queued turns
   * may move; terminal/running records keep their history order. Returns
   * false when the move is a no-op.
   */
  async moveQueuedTurn(this: TurnService, input: {
    threadId: string
    turnId: string
    beforeTurnId?: string
    afterTurnId?: string
  }): Promise<{ threadId: string; turnId: string; queuedPosition: number }> {
    return this['withThreadMutation'](input.threadId, async () => {
      const thread = await this['deps'].threadStore.get(input.threadId)
      if (!thread) throw new Error(`thread not found: ${input.threadId}`)
      const moving = thread.turns.find((candidate) => candidate.id === input.turnId)
      if (!moving) throw new Error(`turn not found: ${input.turnId}`)
      if (moving.status !== 'queued') {
        throw new TurnConflictError(`turn is not queued: ${input.turnId}`)
      }
      const targetId = input.beforeTurnId ?? input.afterTurnId
      const target = thread.turns.find((candidate) => candidate.id === targetId)
      if (!target) throw new Error(`turn not found: ${targetId}`)
      if (target.status !== 'queued') {
        throw new TurnConflictError(`queue position target is not queued: ${targetId}`)
      }
      const remaining = thread.turns.filter((candidate) => candidate.id !== moving.id)
      const targetIndex = remaining.findIndex((candidate) => candidate.id === target.id)
      const insertionIndex = input.beforeTurnId ? targetIndex : targetIndex + 1
      const turns = [
        ...remaining.slice(0, insertionIndex),
        moving,
        ...remaining.slice(insertionIndex)
      ]
      if (!turns.every((turn, index) => turn === thread.turns[index])) {
        const now = this['deps'].nowIso()
        await this['deps'].threadStore.upsert({
          ...touchThread(thread, now),
          turns,
          updatedAt: now
        })
      }
      const queuedPosition =
        turns.filter((turn) => turn.status === 'queued')
          .findIndex((turn) => turn.id === moving.id) + 1
      return { threadId: input.threadId, turnId: moving.id, queuedPosition }
    })
  }
}
