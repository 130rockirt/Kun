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

export const turnServiceRuntimeStateOperations = {
isTurnExecutionActive(this: TurnService, turnId: string): boolean {
    return this['inflightTurns'].has(turnId)
  },

getAbortController(this: TurnService, turnId: string): AbortSignal | undefined {
    return this['inflightTurns'].get(turnId)?.signal
  },

/** Abort active turn work without changing its persisted lifecycle state. */
abortTurnExecution(this: TurnService, turnId: string): boolean {
    const controller = this['inflightTurns'].get(turnId)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  },

/**
   * Abort only the active executions owned by one thread. Persistence is not
   * touched here because delete has already closed the lifecycle fence and
   * will remove the thread once writers drain.
   */
abortThreadExecution(this: TurnService, threadId: string): number {
    let aborted = 0
    for (const [turnId, ownerThreadId] of this['admittedTurnThreads']) {
      if (ownerThreadId !== threadId) continue
      const controller = this['inflightTurns'].get(turnId)
      if (!controller || controller.signal.aborted) continue
      controller.abort()
      aborted += 1
    }
    return aborted
  },

/**
   * Mark turns left 'queued'/'running' by a previous process as failed
   * so clients stop waiting on them after a crash or restart. Turns
   * owned by this process (inflight) are skipped, so the sweep is safe
   * to run in the background after the server starts listening.
   *
   * Returns the ids of threads that had at least one turn reconciled, so the
   * caller can resume goals that were interrupted mid-run (KunAgent/Kun#370).
   */
async reconcileOrphanedTurns(this: TurnService): Promise<string[]> {
    // Include `side` threads: a delegated subagent runs on a hidden side thread
    // whose own turn is left `running` when the runtime is interrupted. Without
    // includeSide it is never swept, so its turn (and the parent's delegate_task
    // tool item) stay pending forever, wedging the thread (KunAgent/Kun#621).
    const summaries = await this['deps'].threadStore.list({ includeSide: true })
    const reconciledThreadIds = new Set<string>()
    for (const summary of summaries) {
      const metadata = await (
        this['deps'].threadStore.getMetadata?.(summary.id) ??
        this['deps'].threadStore.get(summary.id)
      ).catch(() => null)
      if (!metadata?.turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) {
        continue
      }
      const store = this['deps'].sessionStore
      if (store.scheduleItemHistoryCompaction) {
        store.scheduleItemHistoryCompaction(summary.id)
      } else {
        await store.compactItems?.(summary.id).catch((error) => {
          console.warn(
            `[kun] item history compaction skipped for ${summary.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`
          )
        })
      }
      const thread = await this['deps'].threadStore.get(summary.id).catch(() => null)
      if (!thread) continue
      for (const turn of thread.turns) {
        if (turn.status !== 'running' && turn.status !== 'queued') continue
        if (this['inflightTurns'].has(turn.id)) continue
        if (turn.status === 'running' && turn.orchestration === 'graph') {
          const durablePlanning = await this['deps'].resolveGraphPlanningDraft?.({
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
  },

async getTurn(this: TurnService, threadId: string, turnId: string): Promise<Turn | null> {
    const thread = await this['deps'].threadStore.get(threadId)
    return thread?.turns.find((turn) => turn.id === turnId) ?? null
  },

/**
   * Append the stable active-goal context exactly once before a model request.
   * This deliberately bypasses applyItem(): it is canonical model history,
   * not renderer content, so it must not create an SSE item event or enter the
   * renderer-facing thread mirror.
   */
async ensureGoalContext(this: TurnService, threadId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    await this['withThreadMutation'](threadId, async () => {
      // The caller can wait behind another mutation while its execution lease
      // is cancelled. Check again inside the serialized section so an aborted
      // turn never gains model-only history after that wait.
      if (signal?.aborted) return
      const current = await this['deps'].threadStore.get(threadId)
      const turn = current?.turns.find((candidate) => candidate.id === turnId)
      if (!current || !turn || (turn.status !== 'queued' && turn.status !== 'running')) return
      const text = goalContextInstruction(current.goal)
      const goalKey = goalContextKey(current.goal)
      if (!text || !goalKey) return

      const existing = await this['deps'].sessionStore.loadItems(threadId)
      // The goal record is a thread-level cache prefix, not a per-turn
      // instruction. One active generation must therefore be represented
      // exactly once even when the goal spans many user turns.
      if (existing.some((item) => item.kind === 'goal_context' && item.goalKey === goalKey)) {
        return
      }
      if (signal?.aborted) return
      const itemId = `item_${turnId}_goal_context_${goalKey}`
      await this['deps'].sessionStore.appendItem(threadId, makeGoalContextItem({
        id: itemId,
        threadId,
        turnId,
        goalKey,
        text,
        createdAt: this['deps'].nowIso()
      }))
    })
  },

async updateTurnMetadata(this: TurnService,
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
    await this['upsertThread'](threadId, (current) => ({
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
  },
}
