import {
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphReviewResultV1,
  type GraphRunSummaryV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type {
  GraphLeadDeliveryResult,
  GraphSupervisionPort
} from './graph-scheduler-types.js'
import type { GraphRunStore } from './graph-run-store.js'
import { runGraphBackgroundTask } from './graph-background-task.js'
import { graphLeadLifecycleSupervisionEnabled } from './graph-rollout-policy.js'
import {
  errorMessage,
  isTerminalRunStatus,
  terminalRequiredFailure
} from './graph-scheduler-policy.js'
import {
  acknowledgeGraphLeadSteering,
  futureGraphTimestamp,
  replayGraphDeferredWithRetry,
  sweepGraphStalls,
  synthesizeGraphRunSummary
} from './graph-supervisor-runtime-support.js'
import { graphSupervisionObligationIsActionable, graphSupervisionSignalForObligation } from './graph-supervision-obligation.js'
import {
  graphSupervisionProjection,
  type GraphSupervisionProjectionV1
} from './graph-supervision-view.js'
import { GraphSupervisorReviewService } from './graph-supervisor-review-service.js'
import { GraphSupervisionObligationManager } from './graph-supervision-obligation-manager.js'

const SUPERVISION_OBLIGATION_SWEEP_MS = 1_000
type SupervisionSignal = Parameters<GraphSupervisionPort['signal']>[0]
type PendingSupervision = {
  reasons: Set<SupervisionSignal['reason']>
  nodeIds: Set<string>
  digests: string[]
  obligationIds: Set<string>
  timer?: NodeJS.Timeout
}
type ActiveFlush = {
  dirty: boolean
  promise: Promise<void>
}
type DeferredSupervision = {
  input: SupervisionSignal
  mode: 'signal' | 'redeliver'
}

export class GraphSupervisor implements GraphSupervisionPort {
  private started = false
  private readonly pending = new Map<string, PendingSupervision>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly flushes = new Map<string, ActiveFlush>()
  private readonly latestQueuedInputs = new Map<string, SupervisionSignal>()
  private readonly deferred = new Map<string, DeferredSupervision>()
  private readonly nowIso: () => string
  private readonly nowMs: () => number
  private readonly nextId: (prefix: string) => string
  private readonly reviewService: GraphSupervisorReviewService
  private readonly obligations: GraphSupervisionObligationManager
  private stopped = false
  private sweepTimer?: NodeJS.Timeout
  private obligationSweepTimer?: NodeJS.Timeout

  constructor(private readonly options: {
    store: GraphRunStore
    config: () => GraphRuntimeConfig
    delegation: () => DelegationRuntime | undefined
    leadTurn?: (input: {
      run: GraphRunV1
      reasons: string[]
      nodeIds: string[]
      digest: string
    }) => Promise<GraphLeadDeliveryResult | void>
    isLeadTurnActive?: (run: GraphRunV1) => boolean
    synthesize?: (run: GraphRunV1) => Promise<GraphRunSummaryV1>
    nowIso?: () => string
    nowMs?: () => number
    nextId?: (prefix: string) => string
  }) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.nowMs = options.nowMs ?? Date.now
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
    this.reviewService = new GraphSupervisorReviewService({
      config: options.config,
      delegation: options.delegation,
      nextId: this.nextId,
      nowIso: this.nowIso,
      nowMs: this.nowMs
    })
    this.obligations = new GraphSupervisionObligationManager({
      store: options.store,
      nowIso: this.nowIso,
      nowMs: this.nowMs,
      nextId: this.nextId,
      isLeadTurnActive: options.isLeadTurnActive
    })
  }

  start(): void {
    this.started = true
    this.reconfigure()
    for (const [runId, pending] of this.pending) this.schedulePending(runId, pending)
  }

  reconfigure(): void {
    if (this.stopped) return
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.obligationSweepTimer) clearInterval(this.obligationSweepTimer)
    this.sweepTimer = undefined
    this.obligationSweepTimer = undefined
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      const interrupted = new Set([...this.pending.keys(), ...this.flushes.keys()])
      for (const runId of interrupted) {
        const input = this.latestQueuedInputs.get(runId)
        if (input) this.deferred.set(runId, { input, mode: 'redeliver' })
      }
      this.clearPending()
      return
    }
    for (const [runId, deferred] of this.deferred) {
      this.deferred.delete(runId)
      runGraphBackgroundTask(
        `Graph supervisor disabled-pending reconciliation failed for ${runId}`,
        replayGraphDeferredWithRetry({
          replay: () => this.replayDeferred(deferred),
          enabled: () => graphLeadLifecycleSupervisionEnabled(this.options.config()),
          stopped: () => this.stopped,
          preserve: () => {
            if (!this.deferred.has(runId)) this.deferred.set(runId, deferred)
          }
        })
      )
    }
    const interval = Math.max(
      5_000,
      Math.min(60_000, Math.floor(this.options.config().supervision.stallTimeoutMs / 3))
    )
    this.sweepTimer = setInterval(() => {
      runGraphBackgroundTask(
        'Graph supervisor stall sweep failed',
        this.sweepStalls()
      )
    }, interval)
    this.sweepTimer.unref?.()
    this.obligationSweepTimer = setInterval(() => {
      runGraphBackgroundTask(
        'Graph supervisor obligation sweep failed',
        this.sweepObligations()
      )
    }, SUPERVISION_OBLIGATION_SWEEP_MS)
    this.obligationSweepTimer.unref?.()
  }

  async signal(
    input: Parameters<GraphSupervisionPort['signal']>[0]
  ): Promise<void> {
    if (this.stopped) return
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      this.deferred.set(input.runId, { input, mode: 'signal' })
      return
    }
    const obligation = await this.withRunQueue(input.runId, async () => {
      if (
        input.nodeIds.length === 0 &&
        (input.reason === 'completion' || input.reason === 'failure')
      ) {
        await this.obligations.reconcileTerminal(input.runId, false)
      }
      return this.obligations.persistSignal(input, true)
    })
    if (!obligation || !this.obligations.canQueue(obligation)) return
    this.queuePending(input, [obligation.id])
  }

  redeliver(
    input: Parameters<GraphSupervisionPort['signal']>[0]
  ): void {
    if (this.stopped) return
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      this.deferred.set(input.runId, { input, mode: 'redeliver' })
      return
    }
    runGraphBackgroundTask(
      `Graph supervisor redelivery preparation failed for ${input.runId}`,
      this.prepareRedelivery(input)
    )
  }

  async redeliverNow(
    input: Parameters<GraphSupervisionPort['signal']>[0]
  ): Promise<void> {
    if (this.stopped) return
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      this.deferred.set(input.runId, { input, mode: 'redeliver' })
      return
    }
    await this.prepareRedelivery(input, {
      recoverTerminalLease: true,
      reconcileTerminal: true
    })
    await this.flush(input.runId)
  }

  async reconcileTerminal(
    runId: string,
    options: { resolveLifecycle?: boolean } = {}
  ): Promise<void> {
    await this.withRunQueue(runId, () =>
      this.obligations.reconcileTerminal(runId, options.resolveLifecycle ?? false))
  }

  private async replayDeferred(deferred: DeferredSupervision): Promise<void> {
    if (deferred.mode === 'signal') {
      await this.signal(deferred.input)
      await this.flush(deferred.input.runId)
      return
    }
    await this.redeliverNow(deferred.input)
  }

  private prepareRedelivery(
    input: Parameters<GraphSupervisionPort['signal']>[0],
    options: {
      recoverTerminalLease?: boolean
      reconcileTerminal?: boolean
    } = {}
  ): Promise<void> {
    return this.withRunQueue(input.runId, async () => {
      if (options.reconcileTerminal) {
        if (input.recoveryKey) {
          await this.obligations.reconcileTerminalRecovery(input)
        } else {
          await this.obligations.reconcileTerminal(input.runId, false)
        }
      }
      let obligation = await this.obligations.persistSignal(input, false)
      if (obligation && options.recoverTerminalLease) {
        obligation = await this.obligations.recoverTerminalDelivery(
          input.runId,
          obligation.id
        )
      }
      if (obligation && this.obligations.canQueue(obligation)) {
        this.queuePending(input, [obligation.id])
      }
    })
  }

  private queuePending(
    input: Parameters<GraphSupervisionPort['signal']>[0],
    obligationIds: readonly string[]
  ): void {
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      this.deferred.set(input.runId, { input, mode: 'redeliver' })
      return
    }
    this.latestQueuedInputs.set(input.runId, input)
    const pending = this.pending.get(input.runId) ?? {
      reasons: new Set(),
      nodeIds: new Set(),
      digests: [],
      obligationIds: new Set()
    }
    pending.reasons.add(input.reason)
    for (const nodeId of input.nodeIds) pending.nodeIds.add(nodeId)
    for (const obligationId of obligationIds) pending.obligationIds.add(obligationId)
    pending.digests.push(input.digest.slice(0, 4_096))
    if (pending.digests.length > 32) pending.digests.shift()
    this.pending.set(input.runId, pending)
    const activeFlush = this.flushes.get(input.runId)
    if (activeFlush) {
      activeFlush.dirty = true
      return
    }
    if (this.started) this.schedulePending(input.runId, pending)
  }

  private schedulePending(
    runId: string,
    pending: { timer?: NodeJS.Timeout }
  ): void {
    if (pending.timer) return
    pending.timer = setTimeout(() => {
      pending.timer = undefined
      runGraphBackgroundTask(
        `Graph supervisor flush failed for ${runId}`,
        this.flush(runId)
      )
    }, this.options.config().supervision.coalesceWindowMs)
    pending.timer.unref?.()
  }

  async flush(runId: string): Promise<void> {
    const active = this.flushes.get(runId)
    if (active) {
      active.dirty = true
      return active.promise
    }
    const pending = this.pending.get(runId)
    if (!pending || this.stopped) return
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) {
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(runId)
      return
    }
    const state: ActiveFlush = { dirty: false, promise: Promise.resolve() }
    const operation = Promise.resolve().then(() => this.drainFlush(runId, state))
    state.promise = operation.finally(() => {
      if (this.flushes.get(runId) !== state) return
      this.flushes.delete(runId)
      const remaining = this.pending.get(runId)
      if (remaining && this.started && !this.stopped) {
        this.schedulePending(runId, remaining)
      } else if (!remaining && graphLeadLifecycleSupervisionEnabled(this.options.config())) {
        this.latestQueuedInputs.delete(runId)
      }
    })
    this.flushes.set(runId, state)
    return state.promise
  }

  private async drainFlush(runId: string, state: ActiveFlush): Promise<void> {
    do {
      state.dirty = false
      const pending = this.pending.get(runId)
      if (!pending) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(runId)
      if (this.stopped) continue
      if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) continue
      await this.deliverPending(runId, pending)
    } while (!this.stopped && (state.dirty || this.pending.has(runId)))
  }

  private async deliverPending(runId: string, pending: PendingSupervision): Promise<void> {
    const claimed = await this.withRunQueue(
      runId,
      () => this.obligations.claim(runId, [...pending.obligationIds])
    )
    if (!claimed || claimed.obligations.length === 0) return
    const { run, obligations } = claimed
    if (!this.options.leadTurn) {
      await this.scheduleDeliveryRetry(
        runId,
        obligations,
        'Graph source Lead delivery is unavailable.'
      )
      return
    }
    const deliveredSteeringIds = run.steering
      .filter((entry) =>
        (entry.target.kind === 'lead' || entry.target.kind === 'run') &&
        (entry.status === 'persisted' || entry.status === 'delivered'))
      .map((entry) => entry.steeringId)
    try {
      const rawDelivery = await this.options.leadTurn({
        run,
        reasons: [...pending.reasons],
        nodeIds: [...pending.nodeIds],
        digest: pending.digests.join('\n').slice(0, 16_384)
      })
      const delivery: GraphLeadDeliveryResult = rawDelivery ?? {
        status: 'delivered',
        sourceTurnId: run.sourceTurnId,
        deliveredSeq: run.lastEventSeq,
        executionActive: this.options.isLeadTurnActive?.(run) ?? false
      }
      if (delivery.status === 'delivered') {
        await acknowledgeGraphLeadSteering({
          store: this.options.store,
          runId,
          steeringIds: deliveredSteeringIds,
          nextId: this.nextId
        })
        await this.obligations.recordDelivered(runId, obligations, delivery)
        if (delivery.parkedWithPendingSupervision || !delivery.executionActive) {
          await this.rearmAfterNoProgress(runId, obligations.map((entry) => entry.id))
        }
        return
      }
      if (delivery.status === 'deferred') {
        await this.scheduleDeliveryRetry(runId, obligations, delivery.reason)
        return
      }
      if (delivery.status === 'orphaned') {
        await this.obligations.markNeedsAttention(runId, obligations, delivery.reason)
        return
      }
      await this.obligations.resolve(runId, obligations)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.scheduleDeliveryRetry(runId, obligations, message)
      console.warn(`[kun] Graph Lead supervision deferred: ${message.slice(0, 512)}`)
    }
  }

  private async scheduleDeliveryRetry(
    runId: string,
    obligations: Parameters<GraphSupervisionObligationManager['scheduleRetry']>[1],
    error: string
  ): Promise<void> {
    const retryable = await this.obligations.scheduleRetry(runId, obligations, error)
    for (const obligation of retryable) {
      if (!this.obligations.canQueue(obligation)) continue
      this.queuePending(
        graphSupervisionSignalForObligation(runId, obligation),
        [obligation.id]
      )
    }
  }

  async projection(runId: string): Promise<GraphSupervisionProjectionV1 | null> {
    const run = await this.options.store.get(runId)
    return run
      ? graphSupervisionProjection(run, {
          leadActive: this.options.isLeadTurnActive?.(run) ?? false,
          nowMs: this.nowMs(),
          peerReviewLeases: this.reviewService.leasesForRun(run.id)
        })
      : null
  }

  async wake(
    runId: string,
    obligationId?: string,
    idempotencyKey?: string
  ): Promise<GraphRunV1 | null> {
    const run = await this.options.store.get(runId)
    if (!run) return null
    if (isTerminalRunStatus(run.status)) return run
    const targets = run.supervisionObligations.filter((obligation) =>
      obligation.state !== 'resolved' &&
      (!obligationId || obligation.id === obligationId))
    for (const obligation of targets) {
      const updated = await this.obligations.update(
        runId,
        obligation.id,
        (_latest, current) => {
          if (current.state === 'resolved') return null
          if (current.state === 'delivering' && futureGraphTimestamp(current.leaseUntil, this.nowMs())) {
            return null
          }
          if (
            current.state === 'awaiting_action' &&
            this.options.isLeadTurnActive?.(_latest)
          ) return null
          const next = {
            ...current,
            state: 'retry_scheduled' as const,
            nextWakeAt: this.nowIso(),
            updatedAt: this.nowIso()
          }
          delete next.leaseUntil
          return next
        },
        'manual-wake',
        idempotencyKey
          ? `manual-wake:${idempotencyKey}:${obligation.id}`
          : undefined
      )
      if (updated?.changed) {
        this.queuePending(
          graphSupervisionSignalForObligation(runId, updated.obligation),
          [updated.obligation.id]
        )
      }
    }
    return this.options.store.get(runId)
  }

  private async rearmAfterNoProgress(
    runId: string,
    obligationIds: readonly string[]
  ): Promise<void> {
    const attention = await this.obligations.rearmAfterNoProgress(runId, obligationIds)
    if (attention.length > 0) {
      await this.obligations.transitionRunToHuman(
        runId,
        attention[0]!.attentionReason ?? 'Graph supervision requires human attention.'
      )
    }
  }

  review(input: {
    run: GraphRunV1
    node: GraphNodeProjectionV1
    attempt: GraphNodeAttemptV1
    kind: 'peer' | 'lead'
    signal?: AbortSignal
  }): Promise<GraphReviewResultV1> {
    return this.reviewService.review(input)
  }

  /** Abort reviewer children without waiting for source-Lead queues. */
  quiesceReviews(): void { this.reviewService.quiesce() }

  async synthesize(run: GraphRunV1): Promise<GraphRunSummaryV1> {
    if (this.options.synthesize) return this.options.synthesize(run)
    return synthesizeGraphRunSummary(run, this.nowIso())
  }

  async sweepObligations(): Promise<number> {
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) return 0
    const runs = await this.options.store.list({
      statuses: [
        'running',
        'paused',
        'awaiting_supervision',
        'awaiting_human',
        'completing'
      ]
    })
    let queued = 0
    for (const snapshot of runs) {
      if (this.stopped) break
      if (isTerminalRunStatus(snapshot.status)) continue
      for (const node of Object.values(snapshot.nodes)) {
        const attempt = node.attempts.at(-1)
        if (
          !attempt ||
          !['submitted', 'reviewing'].includes(node.status) ||
          !['submitted', 'reviewing'].includes(attempt.status) ||
          snapshot.reviews.some((review) =>
            review.attemptId === attempt.id && review.reviewerKind === 'lead') ||
          snapshot.supervisionObligations.some((obligation) =>
            obligation.kind === 'review_required' &&
            obligation.attemptIds.includes(attempt.id))
        ) continue
        await this.signal({
          runId: snapshot.id,
          reason: 'submitted',
          nodeIds: [node.node.id],
          digest: `Source Lead review is required for submitted attempt ${attempt.id}.`
        })
        queued += 1
      }
      const exhausted = terminalRequiredFailure(snapshot, this.options.config())
      if (
        exhausted &&
        !snapshot.supervisionObligations.some((obligation) =>
          obligation.kind === 'repair_required' &&
          obligation.graphRevision === snapshot.currentRevision &&
          obligation.nodeIds.includes(exhausted.node.id))
      ) {
        await this.signal({
          runId: snapshot.id,
          reason: 'failure',
          nodeIds: [exhausted.node.id],
          digest: `Required node ${exhausted.node.id} exhausted automatic attempts.`
        })
        queued += 1
      }

      let run = await this.options.store.get(snapshot.id)
      if (!run) continue
      if (isTerminalRunStatus(run.status)) continue
      const activeObligations = run.supervisionObligations.filter((obligation) =>
        obligation.state !== 'resolved' && obligation.state !== 'needs_attention')
      if (
        run.status === 'awaiting_supervision' &&
        activeObligations.length === 0 &&
        !isTerminalRunStatus(run.status)
      ) {
        await this.signal({
          runId: run.id,
          reason: 'recovery',
          nodeIds: [],
          digest: 'GraphRun is awaiting source Lead supervision without an active obligation.'
        })
        queued += 1
        run = await this.options.store.get(run.id) ?? run
      }

      for (const obligation of run.supervisionObligations) {
        if (obligation.state === 'resolved') continue
        if (obligation.state === 'needs_attention') {
          if (run.status !== 'awaiting_human' && !isTerminalRunStatus(run.status)) {
            await this.obligations.transitionRunToHuman(
              run.id,
              obligation.attentionReason ?? 'Graph supervision requires human attention.'
            )
            run = await this.options.store.get(run.id) ?? run
          }
          continue
        }
        if (!graphSupervisionObligationIsActionable(run, obligation)) {
          await this.obligations.resolve(run.id, [obligation])
          continue
        }
        if (obligation.state === 'delivering') {
          if (!futureGraphTimestamp(obligation.leaseUntil, this.nowMs())) {
            await this.obligations.scheduleRetry(
              run.id,
              [obligation],
              'Graph supervision delivery lease expired.'
            )
          }
          continue
        }
        if (obligation.state === 'awaiting_action') {
          if (this.options.isLeadTurnActive?.(run)) continue
          if (!futureGraphTimestamp(obligation.nextWakeAt, this.nowMs())) {
            await this.rearmAfterNoProgress(run.id, [obligation.id])
          }
          continue
        }
        if (
          (obligation.state === 'pending' || obligation.state === 'retry_scheduled') &&
          !futureGraphTimestamp(obligation.nextWakeAt, this.nowMs())
        ) {
          this.queuePending(
            graphSupervisionSignalForObligation(run.id, obligation),
            [obligation.id]
          )
          queued += 1
        }
      }
    }
    return queued
  }

  async sweepStalls(): Promise<number> {
    if (!graphLeadLifecycleSupervisionEnabled(this.options.config())) return 0
    return sweepGraphStalls({
      store: this.options.store,
      config: this.options.config,
      delegation: this.options.delegation,
      nowMs: this.nowMs,
      signal: (input) => this.signal(input)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.quiesceReviews()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.obligationSweepTimer) clearInterval(this.obligationSweepTimer)
    this.sweepTimer = undefined
    this.obligationSweepTimer = undefined
    this.clearPending()
    this.latestQueuedInputs.clear()
    this.deferred.clear()
    await Promise.allSettled([
      ...this.queues.values(),
      ...[...this.flushes.values()].map((state) => state.promise)
    ])
  }

  private clearPending(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.pending.clear()
  }

  private withRunQueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return this.withQueue(this.queues, runId, operation)
  }

  private withQueue<T>(
    queues: Map<string, Promise<unknown>>,
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = queues.get(runId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const guard = run.then(() => undefined, () => undefined)
    queues.set(runId, guard)
    return run.finally(() => {
      if (queues.get(runId) === guard) queues.delete(runId)
    })
  }
}
