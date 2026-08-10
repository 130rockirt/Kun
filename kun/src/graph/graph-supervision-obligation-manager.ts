import { isDeepStrictEqual } from 'node:util'
import type { GraphRunV1, GraphSupervisionObligationV1 } from '../contracts/graph.js'
import { redactSecretText } from '../config/secret-redaction.js'
import type { GraphLeadDeliveryResult, GraphSupervisionPort } from './graph-scheduler-types.js'
import { GraphRunConflictError, type GraphRunStore } from './graph-run-store.js'
import {
  graphLatestSemanticProgressSeq,
  graphSupervisionObligationForSignal,
  graphSupervisionObligationIsActionable,
  graphSupervisionRetryDelayMs
} from './graph-supervision-obligation.js'

const DELIVERY_LEASE_MS = 30_000
const MAX_NO_PROGRESS_EPISODES = 3
const MAX_TERMINAL_DELIVERY_ATTEMPTS = 2
const MAX_CONSECUTIVE_DELIVERY_FAILURES = 8
type Signal = Parameters<GraphSupervisionPort['signal']>[0]
type ObligationUpdate = (run: GraphRunV1, obligation: GraphSupervisionObligationV1) => GraphSupervisionObligationV1 | null
type ObligationEventType = ReturnType<typeof obligationEventType>

export class GraphSupervisionObligationManager {
  constructor(private readonly options: {
    store: GraphRunStore
    nowIso: () => string
    nowMs: () => number
    nextId: (prefix: string) => string
    isLeadTurnActive?: (run: GraphRunV1) => boolean
  }) {}

  async persistSignal(input: Signal, recordRequest: boolean): Promise<GraphSupervisionObligationV1 | null> {
    for (let retry = 0; retry < 5; retry += 1) {
      let run = await this.options.store.get(input.runId)
      if (!run) return null
      if (isTerminal(run.status) && !isTerminalLifecycleSignal(run, input)) return null
      let candidate = graphSupervisionObligationForSignal(run, input, this.options.nowIso())
      const status = run.status
      const exact = run.supervisionObligations.find((entry) => entry.id === candidate.id)
      const terminalLifecycle = isTerminal(run.status)
        ? run.supervisionObligations.filter((entry) =>
            isTerminalLifecycleObligation(status, entry))
        : []
      let obligation = exact ?? (isTerminal(run.status)
        ? input.recoveryKey
          ? undefined
          : terminalLifecycle.at(-1)
        : undefined)
      if (obligation) candidate = obligation
      try {
        if (!obligation) {
          run = (await this.options.store.append(run.id, {
            expectedSeq: run.lastEventSeq, graphRevision: run.currentRevision,
            commandId: this.options.nextId('graph_supervision'), idempotencyKey: `supervision-obligation:${candidate.id}`,
            event: { type: 'supervision_obligation_opened', payload: { obligation: candidate } }
          })).state
          obligation = run.supervisionObligations.find((entry) => entry.id === candidate.id)
        }
        if (recordRequest) {
          run = (await this.options.store.append(run.id, {
            expectedSeq: run.lastEventSeq, graphRevision: run.currentRevision,
            commandId: this.options.nextId('graph_supervision'), idempotencyKey: `supervision:${run.id}:${candidate.id}`,
            event: { type: 'supervision_requested', payload: {
              signalId: this.options.nextId('graph_signal'), reason: input.reason,
              nodeIds: input.nodeIds, digest: input.digest.slice(0, 4_096)
            } }
          })).state
          obligation = run.supervisionObligations.find((entry) => entry.id === candidate.id)
        }
        return obligation ?? null
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || retry === 4) throw error
      }
    }
    return null
  }

  canQueue(obligation: GraphSupervisionObligationV1): boolean {
    if (obligation.state === 'resolved' || obligation.state === 'needs_attention') return false
    const now = this.options.nowMs()
    if (obligation.state === 'delivering' && future(obligation.leaseUntil, now)) return false
    return !((obligation.state === 'retry_scheduled' || obligation.state === 'awaiting_action') && future(obligation.nextWakeAt, now))
  }

  async recoverTerminalDelivery(
    runId: string,
    obligationId: string
  ): Promise<GraphSupervisionObligationV1 | null> {
    const result = await this.update(runId, obligationId, (run, current) => {
      if (!isTerminal(run.status) || current.state === 'resolved' || current.state === 'needs_attention') {
        return null
      }
      if (
        !isTerminalLifecycleObligation(run.status, current) ||
        current.state === 'awaiting_action' ||
        current.deliveryAttempts >= MAX_TERMINAL_DELIVERY_ATTEMPTS
      ) return resolved(current, this.options.nowIso())
      if (current.state === 'pending') return null
      const next = {
        ...current,
        state: 'retry_scheduled' as const,
        nextWakeAt: this.options.nowIso(),
        updatedAt: this.options.nowIso()
      }
      delete next.leaseUntil
      delete next.deliveryLeaseId
      return next
    }, 'terminal-recovery')
    return result?.obligation ?? null
  }

  async reconcileTerminal(
    runId: string,
    resolveLifecycle: boolean
  ): Promise<GraphSupervisionObligationV1[]> {
    const run = await this.options.store.get(runId)
    if (!run || !isTerminal(run.status)) return []
    const stale = run.supervisionObligations.filter((obligation) =>
      obligation.state !== 'resolved' &&
      (
        resolveLifecycle ||
        obligation.state === 'needs_attention' ||
        !isTerminalLifecycleObligation(run.status, obligation)
      ))
    if (stale.length > 0) await this.resolve(run.id, stale)
    const latest = await this.options.store.get(runId)
    if (!latest || !isTerminal(latest.status)) return []
    return latest.supervisionObligations.filter((obligation) =>
      obligation.state !== 'resolved' &&
      obligation.state !== 'needs_attention' &&
      isTerminalLifecycleObligation(latest.status, obligation))
  }

  async reconcileTerminalRecovery(input: Signal): Promise<void> {
    const run = await this.options.store.get(input.runId)
    if (!run || !isTerminal(run.status)) return
    const exact = graphSupervisionObligationForSignal(run, input, this.options.nowIso())
    const stale = run.supervisionObligations.filter((obligation) =>
      obligation.id !== exact.id && obligation.state !== 'resolved')
    if (stale.length > 0) await this.resolve(run.id, stale)
  }

  async claim(runId: string, obligationIds: readonly string[]): Promise<{ run: GraphRunV1; obligations: GraphSupervisionObligationV1[] } | null> {
    const claimed: GraphSupervisionObligationV1[] = []
    for (const obligationId of obligationIds) {
      const deliveryLeaseId = this.options.nextId('graph_delivery_lease')
      const result = await this.update(runId, obligationId, (run, current) => {
        if (current.state === 'needs_attention' || current.state === 'resolved') return null
        if (
          run.status === 'awaiting_human' &&
          run.supervisionObligations.some((entry) => entry.state === 'needs_attention')
        ) return null
        if (isTerminal(run.status)) {
          if (
            !isTerminalLifecycleObligation(run.status, current) ||
            current.state === 'awaiting_action' ||
            current.deliveryAttempts >= MAX_TERMINAL_DELIVERY_ATTEMPTS
          ) return resolved(current, this.options.nowIso())
        } else if (!graphSupervisionObligationIsActionable(run, current)) {
          return resolved(current, this.options.nowIso())
        }
        if (current.state === 'delivering' && future(current.leaseUntil, this.options.nowMs())) return null
        if ((current.state === 'retry_scheduled' || current.state === 'awaiting_action') && future(current.nextWakeAt, this.options.nowMs())) return null
        if (current.state === 'awaiting_action' && this.options.isLeadTurnActive?.(run)) return null
        const next = {
          ...current,
          state: 'delivering' as const,
          deliveryAttempts: current.deliveryAttempts + 1,
          deliveryLeaseId,
          leaseUntil: this.timestampAfter(DELIVERY_LEASE_MS),
          updatedAt: this.options.nowIso()
        }
        delete next.nextWakeAt
        delete next.lastError
        delete next.attentionReason
        return next
      }, 'claim')
      if (result?.changed && result.obligation.state === 'delivering') claimed.push(result.obligation)
    }
    const run = await this.options.store.get(runId)
    return run ? { run, obligations: claimed } : null
  }

  async renewDeliveryLeases(
    runId: string,
    obligations: readonly GraphSupervisionObligationV1[]
  ): Promise<number> {
    let renewed = 0
    for (const obligation of obligations) {
      const result = await this.update(runId, obligation.id, (_run, current) => {
        if (!ownsDelivery(current, obligation)) return null
        if (!future(current.leaseUntil, this.options.nowMs())) return null
        return {
          ...current,
          leaseUntil: this.timestampAfter(DELIVERY_LEASE_MS),
          updatedAt: this.options.nowIso()
        }
      }, `renew-${obligation.deliveryAttempts}`, undefined, 'supervision_obligation_updated')
      if (result && ownsDelivery(result.obligation, obligation)) renewed += 1
    }
    return renewed
  }

  async recordDelivered(
    runId: string,
    obligations: readonly GraphSupervisionObligationV1[],
    delivery: Extract<GraphLeadDeliveryResult, { status: 'delivered' }>
  ): Promise<GraphSupervisionObligationV1[]> {
    const recorded: GraphSupervisionObligationV1[] = []
    for (const obligation of obligations) {
      const result = await this.update(runId, obligation.id, (run, current) => {
        if (!ownsDelivery(current, obligation)) return null
        if (isTerminal(run.status)) return resolved(current, this.options.nowIso())
        if (!graphSupervisionObligationIsActionable(run, current)) return resolved(current, this.options.nowIso())
        const next = {
          ...current, state: 'awaiting_action' as const,
          consecutiveDeliveryFailures: 0,
          lastDeliveredSeq: Math.max(current.lastDeliveredSeq ?? 0, delivery.deliveredSeq),
          lastDeliveredAt: this.options.nowIso(),
          nextWakeAt: this.timestampAfter(graphSupervisionRetryDelayMs(current.noProgressCount)),
          updatedAt: this.options.nowIso()
        }
        delete next.leaseUntil
        delete next.deliveryLeaseId
        delete next.lastError
        delete next.attentionReason
        return next
      }, `delivered-${obligation.deliveryAttempts}`)
      if (result?.changed) recorded.push(result.obligation)
    }
    return recorded
  }

  async scheduleRetry(
    runId: string,
    obligations: readonly GraphSupervisionObligationV1[],
    error: string,
    options: { requireExpiredLease?: boolean } = {}
  ): Promise<GraphSupervisionObligationV1[]> {
    const retryable: GraphSupervisionObligationV1[] = []
    const attention: GraphSupervisionObligationV1[] = []
    const sanitizedError = sanitizeError(error)
    for (const obligation of obligations) {
      const result = await this.update(runId, obligation.id, (run, current) => {
        if (!ownsDelivery(current, obligation)) return null
        if (
          options.requireExpiredLease &&
          future(current.leaseUntil, this.options.nowMs())
        ) return null
        const consecutiveDeliveryFailures = current.consecutiveDeliveryFailures + 1
        if (isTerminal(run.status)) {
          if (
            !isTerminalLifecycleObligation(run.status, current) ||
            current.deliveryAttempts >= MAX_TERMINAL_DELIVERY_ATTEMPTS
          ) return resolved(current, this.options.nowIso())
          const next = {
            ...current,
            state: 'retry_scheduled' as const,
            consecutiveDeliveryFailures,
            nextWakeAt: this.options.nowIso(),
            lastError: sanitizedError,
            updatedAt: this.options.nowIso()
          }
          delete next.leaseUntil
          delete next.deliveryLeaseId
          return next
        }
        if (!graphSupervisionObligationIsActionable(run, current)) return resolved(current, this.options.nowIso())
        if (consecutiveDeliveryFailures >= MAX_CONSECUTIVE_DELIVERY_FAILURES) {
          const attentionReason =
            `Graph source Lead delivery failed ${consecutiveDeliveryFailures} consecutive times: ${sanitizedError}`
              .slice(0, 4_096)
          const next = {
            ...current,
            state: 'needs_attention' as const,
            consecutiveDeliveryFailures,
            lastError: sanitizedError,
            attentionReason,
            updatedAt: this.options.nowIso()
          }
          delete next.nextWakeAt
          delete next.leaseUntil
          delete next.deliveryLeaseId
          return next
        }
        const next = {
          ...current, state: 'retry_scheduled' as const,
          consecutiveDeliveryFailures,
          nextWakeAt: this.timestampAfter(graphSupervisionRetryDelayMs(Math.max(0, current.deliveryAttempts - 1))),
          lastError: sanitizedError, updatedAt: this.options.nowIso()
        }
        delete next.leaseUntil
        delete next.deliveryLeaseId
        return next
      }, `delivery-retry-${obligation.deliveryAttempts}`)
      if (result?.changed && result.obligation.state === 'retry_scheduled') {
        retryable.push(result.obligation)
      } else if (result?.changed && result.obligation.state === 'needs_attention') {
        attention.push(result.obligation)
      }
    }
    if (attention.length > 0) {
      await this.transitionRunToHuman(
        runId,
        attention[0]!.attentionReason ?? 'Graph source Lead delivery requires human attention.'
      )
    }
    return retryable
  }

  async expireDeliveryLeases(
    runId: string,
    obligations: readonly GraphSupervisionObligationV1[]
  ): Promise<GraphSupervisionObligationV1[]> {
    return this.scheduleRetry(
      runId,
      obligations,
      'Graph supervision delivery lease expired.',
      { requireExpiredLease: true }
    )
  }

  async wake(
    runId: string,
    obligationId?: string,
    idempotencyKey?: string
  ): Promise<GraphSupervisionObligationV1[] | null> {
    const run = await this.options.store.get(runId)
    if (!run) return null
    if (isTerminal(run.status)) return []
    const targets = run.supervisionObligations.filter((obligation) =>
      obligation.state !== 'resolved' &&
      (!obligationId || obligation.id === obligationId))
    if (run.status === 'awaiting_human') {
      const targetIds = new Set(targets.map((obligation) => obligation.id))
      if (run.supervisionObligations.some((obligation) =>
        obligation.state === 'needs_attention' && !targetIds.has(obligation.id))) {
        return []
      }
    }
    const attentionTargetIds = targets
      .filter((obligation) => obligation.state === 'needs_attention')
      .map((obligation) => obligation.id)
    if (attentionTargetIds.length > 0) {
      const prepared = await this.transitionRunAfterManualWake(runId, {
        idempotencyKey,
        phase: 'prepare',
        ignoreAttentionObligationIds: attentionTargetIds
      })
      if (!prepared) return []
    }
    const ready: GraphSupervisionObligationV1[] = []
    for (const obligation of targets) {
      const updated = await this.update(
        runId,
        obligation.id,
        (latest, current) => {
          if (current.state === 'resolved') return null
          if (current.state === 'delivering' && future(current.leaseUntil, this.options.nowMs())) {
            return null
          }
          if (
            current.state === 'awaiting_action' &&
            this.options.isLeadTurnActive?.(latest)
          ) return null
          const next = current.state === 'needs_attention'
            ? {
                ...current,
                state: 'pending' as const,
                consecutiveDeliveryFailures: 0,
                updatedAt: this.options.nowIso()
              }
            : {
                ...current,
                state: 'retry_scheduled' as const,
                consecutiveDeliveryFailures: 0,
                nextWakeAt: this.options.nowIso(),
                updatedAt: this.options.nowIso()
              }
          if (next.state === 'pending') delete next.nextWakeAt
          delete next.leaseUntil
          delete next.deliveryLeaseId
          delete next.lastError
          delete next.attentionReason
          return next
        },
        'manual-wake',
        idempotencyKey
          ? `manual-wake:${idempotencyKey}:${obligation.id}`
          : undefined
      )
      if (updated?.changed) ready.push(updated.obligation)
    }
    if (attentionTargetIds.length > 0) {
      const latest = await this.options.store.get(runId)
      const remainingAttention = latest?.supervisionObligations.find((entry) =>
        entry.state === 'needs_attention')
      if (remainingAttention) {
        await this.abortManualWake(
          runId,
          targets,
          remainingAttention.attentionReason ?? 'Graph supervision requires human attention.'
        )
        return []
      }
      const settled = await this.transitionRunAfterManualWake(runId, {
        idempotencyKey,
        phase: 'settle'
      })
      const verified = settled ? await this.options.store.get(runId) : null
      const concurrentAttention = verified?.supervisionObligations.find((entry) =>
        entry.state === 'needs_attention')
      if (!settled || !verified || concurrentAttention) {
        await this.abortManualWake(
          runId,
          targets,
          concurrentAttention?.attentionReason ?? 'Concurrent Graph supervision attention prevented manual wake.'
        )
        return []
      }
    }
    return ready
  }

  async rearmAfterNoProgress(runId: string, obligationIds: readonly string[]): Promise<GraphSupervisionObligationV1[]> {
    const attention: GraphSupervisionObligationV1[] = []
    for (const obligationId of obligationIds) {
      const before = await this.options.store.get(runId)
      const current = before?.supervisionObligations.find((entry) => entry.id === obligationId)
      const latestProgress = before && current &&
        current.state === 'awaiting_action' &&
        !isTerminal(before.status) &&
        graphSupervisionObligationIsActionable(before, current)
        ? graphLatestSemanticProgressSeq(
            await this.options.store.events(runId, current.lastProgressSeq),
            current.lastProgressSeq
          )
        : undefined
      const result = await this.update(runId, obligationId, (run, obligation) => {
        if (obligation.state === 'needs_attention' || obligation.state === 'resolved') return null
        if (isTerminal(run.status)) return resolved(obligation, this.options.nowIso())
        if (!graphSupervisionObligationIsActionable(run, obligation)) return resolved(obligation, this.options.nowIso())
        if (obligation.state !== 'awaiting_action') return null
        if (latestProgress !== undefined && latestProgress > obligation.lastProgressSeq) {
          const next = { ...obligation, state: 'retry_scheduled' as const, noProgressCount: 0, lastProgressSeq: latestProgress, nextWakeAt: this.timestampAfter(graphSupervisionRetryDelayMs(0)), updatedAt: this.options.nowIso() }
          delete next.leaseUntil
          delete next.deliveryLeaseId
          return next
        }
        const noProgressCount = obligation.noProgressCount + 1
        if (noProgressCount >= MAX_NO_PROGRESS_EPISODES) {
          const next = { ...obligation, state: 'needs_attention' as const, noProgressCount, attentionReason: 'The source Lead completed three supervision episodes without resolving the required action.', updatedAt: this.options.nowIso() }
          delete next.nextWakeAt
          delete next.leaseUntil
          delete next.deliveryLeaseId
          return next
        }
        const next = { ...obligation, state: 'retry_scheduled' as const, noProgressCount, nextWakeAt: this.timestampAfter(graphSupervisionRetryDelayMs(noProgressCount - 1)), updatedAt: this.options.nowIso() }
        delete next.leaseUntil
        delete next.deliveryLeaseId
        return next
      }, `no-progress-${obligationId}`)
      if (result?.obligation.state === 'needs_attention') attention.push(result.obligation)
    }
    return attention
  }

  async markNeedsAttention(runId: string, obligations: readonly GraphSupervisionObligationV1[], reason: string): Promise<void> {
    let changed = false
    for (const obligation of obligations) {
      const result = await this.update(runId, obligation.id, (run, current) => {
        if (!ownsDelivery(current, obligation)) return null
        if (isTerminal(run.status)) return resolved(current, this.options.nowIso())
        const next = { ...current, state: 'needs_attention' as const, attentionReason: sanitizeError(reason), updatedAt: this.options.nowIso() }
        delete next.nextWakeAt
        delete next.leaseUntil
        delete next.deliveryLeaseId
        return next
      }, 'attention')
      changed ||= result?.changed === true
    }
    if (changed) await this.transitionRunToHuman(runId, reason)
  }

  async resolveDelivery(
    runId: string,
    obligations: readonly GraphSupervisionObligationV1[]
  ): Promise<void> {
    for (const obligation of obligations) {
      await this.update(
        runId,
        obligation.id,
        (_run, current) => ownsDelivery(current, obligation)
          ? resolved(current, this.options.nowIso())
          : null,
        `delivery-resolved-${obligation.deliveryAttempts}`
      )
    }
  }

  async resolve(runId: string, obligations: readonly GraphSupervisionObligationV1[]): Promise<void> {
    for (const obligation of obligations) {
      await this.update(runId, obligation.id, (_run, current) => current.state === 'resolved' ? null : resolved(current, this.options.nowIso()), 'resolved')
    }
  }

  async update(
    runId: string,
    obligationId: string,
    update: ObligationUpdate,
    operation: string,
    stableIdempotencyKey?: string,
    eventTypeOverride?: ObligationEventType
  ): Promise<{ run: GraphRunV1; obligation: GraphSupervisionObligationV1; changed: boolean } | null> {
    for (let retry = 0; retry < 5; retry += 1) {
      const run = await this.options.store.get(runId)
      if (!run) return null
      const current = run.supervisionObligations.find((entry) => entry.id === obligationId)
      if (!current) return null
      const next = update(run, current)
      if (!next) return { run, obligation: current, changed: false }
      if (obligationsSemanticallyEqual(current, next)) {
        return { run, obligation: current, changed: false }
      }
      try {
        const appended = await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq, graphRevision: run.currentRevision,
          commandId: this.options.nextId('graph_supervision'),
          idempotencyKey: next.state === 'resolved'
            ? `supervision-obligation:${obligationId}:resolved`
            : stableIdempotencyKey ?? ['supervision-obligation', obligationId, operation, String(run.lastEventSeq)].join(':').slice(0, 256),
          event: {
            type: eventTypeOverride ?? obligationEventType(next.state),
            payload: { obligation: next }
          }
        })
        const obligation = appended.state.supervisionObligations.find((entry) => entry.id === obligationId)!
        return { run: appended.state, obligation, changed: !appended.duplicate }
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || retry === 4) throw error
      }
    }
    return null
  }

  async transitionRunToHuman(runId: string, reason: string): Promise<void> {
    for (let retry = 0; retry < 5; retry += 1) {
      const run = await this.options.store.get(runId)
      if (
        !run ||
        run.status === 'awaiting_human' ||
        isTerminal(run.status) ||
        !['running', 'paused', 'pausing', 'awaiting_supervision', 'completing'].includes(run.status) ||
        !run.supervisionObligations.some((entry) => entry.state === 'needs_attention')
      ) return
      try {
        await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq, graphRevision: run.currentRevision,
          commandId: this.options.nextId('graph_supervision'),
          idempotencyKey: `supervision-attention:${run.id}:${run.currentRevision}:${run.lastEventSeq}`,
          event: { type: 'run_status_changed', payload: { from: run.status, to: 'awaiting_human', reason: sanitizeError(reason) } }
        })
        return
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || retry === 4) throw error
      }
    }
  }

  async transitionRunAfterManualWake(
    runId: string,
    options: {
      idempotencyKey?: string
      phase: 'prepare' | 'settle'
      ignoreAttentionObligationIds?: readonly string[]
    }
  ): Promise<boolean> {
    const ignored = new Set(options.ignoreAttentionObligationIds ?? [])
    for (let retry = 0; retry < 5; retry += 1) {
      const run = await this.options.store.get(runId)
      if (!run) return false
      if (run.supervisionObligations.some((entry) =>
        entry.state === 'needs_attention' && !ignored.has(entry.id))) return false
      if (run.status === 'awaiting_supervision') return true
      if (run.status !== 'awaiting_human') return false
      try {
        await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: this.options.nextId('graph_supervision'),
          idempotencyKey: options.idempotencyKey
            ? `manual-wake-run:${options.idempotencyKey}:${options.phase}`
            : `manual-wake-run:${run.id}:${options.phase}:${run.lastEventSeq}`,
          event: {
            type: 'run_status_changed',
            payload: {
              from: 'awaiting_human',
              to: 'awaiting_supervision',
              reason: 'Manual Graph supervision wake requested.'
            }
          }
        })
        return true
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) || retry === 4) throw error
      }
    }
    return false
  }

  private async abortManualWake(
    runId: string,
    targets: readonly GraphSupervisionObligationV1[],
    reason: string
  ): Promise<void> {
    for (const original of targets) {
      if (original.state !== 'needs_attention') continue
      await this.update(runId, original.id, (_run, current) => {
        if (current.state !== 'pending') return null
        const next = {
          ...current,
          state: 'needs_attention' as const,
          consecutiveDeliveryFailures: original.consecutiveDeliveryFailures,
          attentionReason: original.attentionReason ?? reason,
          updatedAt: this.options.nowIso()
        }
        if (original.lastError) next.lastError = original.lastError
        else delete next.lastError
        delete next.nextWakeAt
        delete next.deliveryLeaseId
        delete next.leaseUntil
        return next
      }, 'manual-wake-aborted')
    }
    await this.transitionRunToHuman(runId, reason)
  }

  private timestampAfter(delayMs: number): string { return new Date(this.options.nowMs() + Math.max(0, delayMs)).toISOString() }
}

function future(value: string | undefined, nowMs: number): boolean {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed > nowMs
}
function resolved(current: GraphSupervisionObligationV1, nowIso: string): GraphSupervisionObligationV1 {
  const next = { ...current, state: 'resolved' as const, updatedAt: nowIso, resolvedAt: nowIso }
  delete next.deliveryLeaseId; delete next.leaseUntil; delete next.nextWakeAt; delete next.lastError; delete next.attentionReason
  return next
}
function ownsDelivery(
  current: GraphSupervisionObligationV1,
  claimed: GraphSupervisionObligationV1
): boolean {
  if (current.state !== 'delivering') return false
  if (claimed.deliveryLeaseId) return current.deliveryLeaseId === claimed.deliveryLeaseId
  return current.deliveryLeaseId === undefined &&
    current.deliveryAttempts === claimed.deliveryAttempts
}
function sanitizeError(value: string): string {
  return redactSecretText(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4_096) || 'Graph supervision failed without a diagnostic.'
}
function obligationEventType(state: GraphSupervisionObligationV1['state']): 'supervision_delivery_started' | 'supervision_retry_scheduled' | 'supervision_obligation_resolved' | 'supervision_attention_required' | 'supervision_obligation_updated' {
  switch (state) {
    case 'delivering': return 'supervision_delivery_started'
    case 'retry_scheduled': return 'supervision_retry_scheduled'
    case 'resolved': return 'supervision_obligation_resolved'
    case 'needs_attention': return 'supervision_attention_required'
    default: return 'supervision_obligation_updated'
  }
}
function isTerminal(status: GraphRunV1['status']): boolean { return status === 'completed' || status === 'failed' || status === 'cancelled' }
function isTerminalLifecycleSignal(run: GraphRunV1, input: Signal): boolean {
  if (input.nodeIds.length > 0) return false
  return run.status === 'failed' ? input.reason === 'failure' : input.reason === 'completion'
}
function isTerminalLifecycleObligation(status: GraphRunV1['status'], obligation: GraphSupervisionObligationV1): boolean {
  if (obligation.nodeIds.length > 0) return false
  return status === 'failed' ? obligation.reason === 'failure' : obligation.reason === 'completion'
}
function obligationsSemanticallyEqual(
  left: GraphSupervisionObligationV1,
  right: GraphSupervisionObligationV1
): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftSemantic } = left
  const { updatedAt: _rightUpdatedAt, ...rightSemantic } = right
  return isDeepStrictEqual(leftSemantic, rightSemantic)
}
