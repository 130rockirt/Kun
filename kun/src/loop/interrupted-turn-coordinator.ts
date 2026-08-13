import { touchThread } from '../domain/thread.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnCapacityError, type TurnService } from '../services/turn-service.js'
import {
  InterruptedTurnResumeCoordinator,
  type InterruptedTurnResumeCoordinatorDeps
} from './interrupted-turn-resume-coordinator.js'
import type { TurnRunOutcome } from './turn-execution-types.js'
import { resolveTurnClientSurface } from './turn-context-resolver.js'

/**
 * Prompt used for the synthetic continuation turn launched after a restart
 * interrupted an ordinary (non-goal) thread. The `interruption_note` system
 * record carries the concrete checkpoint (original request, latest progress,
 * recent tool work); this message points the model at it.
 */
const INTERRUPTED_RESUME_PROMPT = [
  'Continue the task that was interrupted in this conversation.',
  'The previous attempt stopped before it was finished (the runtime stopped or restarted).',
  'Review the interruption note and the conversation history, verify the current state, and pick up where the work left off.',
  'Keep going until the original request is genuinely complete or clearly blocked.'
].join(' ')

export const DEFAULT_INTERRUPTED_RESUME_COOLDOWN_MS = 10 * 60_000

export type InterruptedTurnResumeOptions = Pick<
  InterruptedTurnResumeCoordinatorDeps,
  'setTimer' | 'log' | 'baseDelayMs' | 'maxDelayMs'
> & {
  /** Master switch; defaults to enabled. */
  enabled?: boolean
  /** Minimum gap between auto-resumes of one thread across restarts. */
  cooldownMs?: number
}

export type InterruptedTurnCoordinatorDeps = {
  threadStore: ThreadStore
  turns: Pick<TurnService, 'startTurn'>
  events: Pick<RuntimeEventRecorder, 'record'>
  nowIso: () => string
  nowMs: () => number
  runTurn: (threadId: string, turnId: string) => Promise<TurnRunOutcome>
  interruptedResume?: InterruptedTurnResumeOptions
}

/**
 * Owns the restart auto-resume policy for ordinary (non-goal) threads. Goal
 * threads keep using the goal resume coordinator; this service handles the
 * "翻帖/聊到一半" case the goal path never covered.
 */
export class InterruptedTurnCoordinator {
  private readonly resume: InterruptedTurnResumeCoordinator

  constructor(private readonly deps: InterruptedTurnCoordinatorDeps) {
    const options = deps.interruptedResume ?? {}
    this.resume = new InterruptedTurnResumeCoordinator({
      launch: (threadId) => this.launchResumeTurn(threadId),
      canResume: async (threadId) => this.canResume(threadId),
      isThreadBusy: async (threadId) =>
        (await this.deps.threadStore.get(threadId))?.status === 'running',
      markResumed: async (threadId) => this.markResumed(threadId),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
      ...(options.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {})
    })
    this.enabled = options.enabled !== false
    this.cooldownMs = options.cooldownMs ?? DEFAULT_INTERRUPTED_RESUME_COOLDOWN_MS
  }

  private readonly enabled: boolean
  private readonly cooldownMs: number

  shutdown(): void {
    this.resume.shutdown()
  }

  /**
   * Resume threads whose in-flight turn was just reconciled to `failed` after
   * a restart. Goal threads and threads still inside the cooldown window are
   * skipped; each process start resumes a given thread at most once.
   */
  async resumeInterruptedTurns(threadIds: readonly string[]): Promise<number> {
    if (!this.enabled) return 0
    let resumed = 0
    for (const threadId of threadIds) {
      if (await this.resume.resumeInterrupted(threadId)) resumed += 1
    }
    return resumed
  }

  private async canResume(threadId: string): Promise<boolean> {
    if (!this.enabled) return false
    const thread = await this.deps.threadStore.get(threadId)
    if (!thread) return false
    if (thread.relation === 'side') return false
    // A still-active goal owns its own resume path; never double-resume.
    if (thread.goal && thread.goal.status === 'active') return false
    const lastResumeAt = thread.lastAutoResumeAt
    if (!lastResumeAt) return true
    const elapsedMs = this.deps.nowMs() - Date.parse(lastResumeAt)
    if (!Number.isFinite(elapsedMs)) return true
    return elapsedMs >= this.cooldownMs
  }

  private async markResumed(threadId: string): Promise<void> {
    const thread = await this.deps.threadStore.get(threadId)
    if (!thread) return
    const now = this.deps.nowIso()
    await this.deps.threadStore.upsert(
      touchThread({ ...thread, lastAutoResumeAt: now }, now)
    ).catch(() => undefined)
  }

  private async launchResumeTurn(threadId: string): Promise<void> {
    const thread = await this.deps.threadStore.get(threadId)
    if (!thread) return
    const lastTurn = thread.turns[thread.turns.length - 1]
    let started
    try {
      started = await this.deps.turns.startTurn({
        threadId,
        request: {
          prompt: INTERRUPTED_RESUME_PROMPT,
          mode: 'agent',
          ...(lastTurn ? { clientSurface: resolveTurnClientSurface(lastTurn) } : {}),
          ...(lastTurn?.agentSurface ? { agentSurface: lastTurn.agentSurface } : {}),
          ...(lastTurn?.agentSurface === 'design'
            ? {
                messageSource: 'design_continuation' as const,
                ...(lastTurn.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
                ...(lastTurn.guiDesignMode ? { guiDesignMode: true } : {})
              }
            : {}),
          ...(lastTurn?.disableUserInput ? { disableUserInput: true } : {})
        }
      })
    } catch (error) {
      if (error instanceof TurnCapacityError) {
        this.resume.defer(threadId)
        return
      }
      throw error
    }
    await this.deps.events.record({
      kind: 'error',
      threadId,
      turnId: started.turnId,
      message: 'Auto-resuming the interrupted task after a runtime restart.',
      code: 'interrupted_turn_auto_resume',
      severity: 'warning'
    })
    void this.deps.runTurn(threadId, started.turnId)
  }
}
