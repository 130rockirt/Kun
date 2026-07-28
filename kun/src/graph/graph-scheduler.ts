import {
  type GraphDomainEventV1,
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphReviewResultV1,
  type GraphRunV1
} from '../contracts/graph.js'
import {
  GraphRunConflictError,
} from './graph-run-store.js'
import { GraphAttemptScheduler } from './graph-attempt-scheduler.js'
import {
  budgetWarningKinds,
  dependencyDecision,
  deterministicReview,
  deterministicSummary,
  effectiveReviewKinds,
  errorMessage,
  findAttempt,
  hasPendingExternalReview,
  isLoopContinuationEdge,
  loopResetNodeIds,
  maxBudgetRatio,
  outcomeOf,
  reviewDisposition,
  rotate,
  terminalRequiredFailure,
  validationFailureSummary
} from './graph-scheduler-policy.js'
import type {
  GraphSchedulerOptions,
  GraphSupervisionPort
} from './graph-scheduler-types.js'
import { recordGraphTerminalCleanup } from './graph-terminal-cleanup.js'
import {
  deliverNodeSteering,
  handleNodeAttemptSteering
} from './graph-steering-delivery.js'
export type {
  GraphSchedulerOptions,
  GraphSupervisionPort
} from './graph-scheduler-types.js'
export {
  parseWorkerResult,
  validateWorkerResult
} from './graph-scheduler-policy.js'

export class GraphScheduler extends GraphAttemptScheduler {
  private readonly runQueues = new Map<string, Promise<unknown>>()
  private readonly cleanupTasks = new Set<Promise<void>>()
  private timer?: NodeJS.Timeout
  private ticking = false
  private currentTick?: Promise<void>
  private fairCursor = 0

  constructor(options: GraphSchedulerOptions) {
    super(options)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`[kun] Graph scheduler tick failed: ${errorMessage(error)}`)
      })
    }, this.options.tickIntervalMs ?? 5_000)
    this.timer.unref?.()
    void this.tick().catch((error) => {
      console.warn(`[kun] Graph scheduler initial tick failed: ${errorMessage(error)}`)
    })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.currentTick?.catch(() => undefined)
    for (const attempt of this.active.values()) attempt.abort.abort()
    await Promise.allSettled([...this.active.values()].map((attempt) => attempt.promise))
    this.stopAllLeaseHeartbeats()
    await Promise.allSettled([...this.cleanupTasks])
  }
  async tick(): Promise<void> {
    if (this.ticking || !this.options.config().enabled) return
    this.ticking = true
    const operation = this.tickOnce()
    this.currentTick = operation
    try {
      await operation
    } finally {
      this.ticking = false
      if (this.currentTick === operation) this.currentTick = undefined
    }
  }
  private async tickOnce(): Promise<void> {
    this.abortOverdueAttempts()
    const runs = await this.options.store.list({
      statuses: ['running', 'awaiting_supervision', 'awaiting_human', 'completing']
    })
    if (!runs.length) return
    const ordered = rotate(runs, this.fairCursor++ % runs.length)
    const configuredRunCapacity = this.options.config().scheduler.maxConcurrentRuns
    const activeRunIds = new Set([...this.active.values()].map((attempt) => attempt.runId))
    const admittedRunIds = new Set([...activeRunIds].slice(0, configuredRunCapacity))
    for (const run of ordered) {
      if (admittedRunIds.size >= configuredRunCapacity) break
      admittedRunIds.add(run.id)
    }
    for (const initial of ordered) {
      if (!admittedRunIds.has(initial.id)) continue
      if (this.fencedRuns.has(initial.id)) continue
      let run = await this.reconcileRun(initial.id)
      if (run.status === 'completing') continue
      if (run.status !== 'running') continue
      if (this.active.size >= this.options.config().scheduler.maxConcurrentNodes) break
      const perRunActive = [...this.active.values()].filter((item) => item.runId === run.id).length
      const capacity = Math.min(
        run.budget.limits.maxConcurrentNodes,
        this.options.config().scheduler.maxConcurrentNodesPerRun
      ) - perRunActive
      if (capacity <= 0) continue
      const ready = Object.values(run.nodes)
        .filter((node) => node.status === 'ready' && node.node.kind !== 'loop_gate')
        .sort((a, b) =>
          b.node.priority - a.node.priority ||
          a.node.id.localeCompare(b.node.id))
        .slice(0, capacity)
      for (const node of ready) {
        if (this.active.size >= this.options.config().scheduler.maxConcurrentNodes) break
        if (!this.retryReady(run.id, node.node.id)) continue
        const scheduled = await this.scheduleNode(run.id, node.node.id)
        if (scheduled) run = await this.requireRun(run.id)
      }
    }
  }
  diagnostics(): {
    active: Array<{ runId: string; nodeId: string; attemptId: string }>
    fairCursor: number
  } {
    return {
      active: [...this.active.values()].map(({ runId, nodeId, attemptId }) => ({
        runId,
        nodeId,
        attemptId
      })),
      fairCursor: this.fairCursor
    }
  }
  private async reconcileRun(runId: string): Promise<GraphRunV1> {
    return this.withRunQueue(runId, async () => {
      let run = await this.requireRun(runId)
      if (
        run.status !== 'running' &&
        run.status !== 'awaiting_supervision' &&
        run.status !== 'awaiting_human' &&
        run.status !== 'completing'
      ) return run
      if (run.status === 'completing') return this.finishCompletion(run)
      run = await this.options.mailbox.expire(run, `scheduler_${run.id}_${run.lastEventSeq}`)
      run = await this.reconcileSubmitted(run)
      const exhaustedRequiredNode = terminalRequiredFailure(run, this.options.config())
      if (exhaustedRequiredNode) {
        return this.holdRequiredFailure(run, exhaustedRequiredNode)
      }
      if (
        (run.status === 'awaiting_supervision' || run.status === 'awaiting_human') &&
        !hasPendingExternalReview(run) &&
        this.options.delegation()?.enabled() === true
      ) {
        run = await this.transitionRun(run, 'running', 'reviews resolved')
      }
      if (run.status !== 'running') return run
      run = await this.reconcileReadiness(run)
      const failedGate = terminalRequiredFailure(run, this.options.config())
      if (failedGate) {
        return this.holdRequiredFailure(run, failedGate)
      }
      run = await this.evaluateLoopGates(run)
      run = await this.enforceBudgets(run)
      if (run.status === 'running') run = await this.tryComplete(run)
      return run
    })
  }
  private async reconcileReadiness(runInput: GraphRunV1): Promise<GraphRunV1> {
    let run = runInput
    const plan = run.plans.at(-1)!
    for (const projection of Object.values(run.nodes)) {
      if (projection.status !== 'pending' && projection.status !== 'blocked') continue
      const incoming = plan.edges.filter((edge) =>
        edge.to === projection.node.id &&
        !isLoopContinuationEdge(run, edge.from, edge.to))
      const decision = dependencyDecision(run, incoming)
      if (decision === 'unsatisfiable') {
        run = await this.transitionNode(
          run,
          projection.node.id,
          'skipped',
          'a required dependency ended without an accepted outcome or artifact'
        )
        continue
      }
      const target = decision === 'ready' ? 'ready' : 'blocked'
      if (projection.status !== target) {
        run = await this.transitionNode(
          run,
          projection.node.id,
          target,
          decision === 'blocked' ? 'waiting for dependencies' : 'dependencies satisfied'
        )
      }
    }
    return run
  }
  private async evaluateLoopGates(runInput: GraphRunV1): Promise<GraphRunV1> {
    let run = runInput
    for (const projection of Object.values(run.nodes)) {
      if (projection.node.kind !== 'loop_gate' || projection.status !== 'ready') continue
      const gate = projection.node.loopGate!
      const source = run.nodes[gate.condition.sourceNodeId]
      const continues = Boolean(
        source && new Set<string>(gate.condition.outcomeIn).has(outcomeOf(source))
      )
      const iterationExhausted = projection.loopIteration >= Math.min(
        gate.maxIterations,
        run.budget.limits.maxLoopIterations
      )
      const exhausted = iterationExhausted
      if (continues && !exhausted) {
        const resetNodeIds = loopResetNodeIds(
          run.plans.at(-1)!,
          projection.node.id,
          gate.continueTargetNodeId,
          gate.condition.sourceNodeId
        )
        run = (await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: `loop_advance_${run.id}_${projection.loopIteration + 1}`,
          idempotencyKey: `loop-advance:${run.id}:${projection.node.id}:${projection.loopIteration + 1}`,
          event: {
            type: 'loop_iteration_advanced',
            payload: {
              gateNodeId: projection.node.id,
              continueTargetNodeId: gate.continueTargetNodeId,
              resetNodeIds,
              iteration: projection.loopIteration + 1
            }
          }
        })).state
        run = await this.bumpLoopBudget(run)
      } else {
        const targetId = exhausted
          ? gate.exhaustionTargetNodeId ?? gate.exitTargetNodeId
          : gate.exitTargetNodeId
        const target = run.nodes[targetId]
        if (target && (target.status === 'pending' || target.status === 'blocked')) {
          run = await this.transitionNode(run, target.node.id, 'ready', exhausted
            ? 'loop exhausted'
            : 'loop exit condition met')
        }
      }
      if (!continues || exhausted) {
        run = await this.transitionNode(run, projection.node.id, 'skipped',
          exhausted
            ? 'loop gate iteration limit exhausted'
            : 'loop gate evaluated')
      }
    }
    return run
  }
  private async reconcileSubmitted(runInput: GraphRunV1): Promise<GraphRunV1> {
    let run = runInput
    for (const projection of Object.values(run.nodes)) {
      if (projection.status !== 'submitted' && projection.status !== 'reviewing') continue
      const attempt = projection.attempts.at(-1)
      if (!attempt?.result || !attempt.validation) continue
      if (projection.status === 'submitted') {
        run = await this.transitionNode(run, projection.node.id, 'reviewing', 'review started')
      }
      if (attempt.status === 'submitted') {
        run = await this.transitionAttempt(run, projection.node.id, attempt.id, 'reviewing')
      }
      const currentNode = run.nodes[projection.node.id]
      const currentAttempt = currentNode.attempts.find((entry) => entry.id === attempt.id)!
      run = await this.ensureReviews(run, projection.node.id, attempt.id)
      const reviewedNode = run.nodes[projection.node.id]
      const reviewedAttempt = reviewedNode.attempts.find((entry) => entry.id === attempt.id)!
      const requiredKinds = effectiveReviewKinds(
        reviewedNode,
        this.options.config(),
        run.plans.at(-1)!.completionNodeIds.includes(reviewedNode.node.id)
      )
      const reviews = run.reviews.filter((review) =>
        review.nodeId === reviewedNode.node.id &&
        review.attemptId === reviewedAttempt.id)
      const disposition = reviewDisposition({
        requiredKinds,
        requireAll: reviewedNode.node.completion.review.requireAll,
        validationValid: reviewedAttempt.validation?.valid === true,
        reviews
      })
      if (disposition.kind === 'awaiting_lead' || disposition.kind === 'invalid') {
        if (run.status === 'running') {
          run = await this.transitionRun(
            run,
            'awaiting_supervision',
            disposition.kind === 'awaiting_lead' && reviewedAttempt.validation?.valid === true
              ? 'source Lead review pending'
              : validationFailureSummary(reviewedAttempt)
          )
        }
        continue
      }
      if (disposition.kind === 'repair') {
        run = await this.requireRepair(run, reviewedNode, reviewedAttempt, disposition.reason)
        continue
      }
      if (disposition.kind === 'awaiting_human') {
        if (run.status === 'running') {
          run = await this.transitionRun(run, 'awaiting_human', 'review requires human decision')
        }
        continue
      }
      if (disposition.kind === 'awaiting_evidence') {
        if (run.status === 'running') {
          run = await this.transitionRun(run, 'awaiting_supervision', 'external review pending')
        }
        continue
      }
      const integration = await this.integrateWrite(reviewedAttempt.id)
      if (integration !== 'applied') {
        if (run.status === 'running' || run.status === 'awaiting_supervision') {
          run = await this.transitionRun(run, 'awaiting_human', 'write integration requires human resolution')
        }
        await this.requestSupervision(
          run.id,
          'conflict',
          [reviewedNode.node.id],
          'Accepted worker result could not be integrated safely.'
        )
        continue
      }
      run = await this.transitionAttempt(run, reviewedNode.node.id, reviewedAttempt.id, 'accepted')
      run = await this.transitionNode(
        run,
        reviewedNode.node.id,
        'accepted',
        'source Lead accepted the executor result'
      )
    }
    return run
  }
  private async requireRepair(
    run: GraphRunV1,
    node: GraphNodeProjectionV1,
    attempt: GraphNodeAttemptV1,
    reason: string
  ): Promise<GraphRunV1> {
    run = await this.transitionAttempt(
      run,
      node.node.id,
      attempt.id,
      'repair_required',
      'retryable',
      reason
    )
    run = await this.transitionNode(run, node.node.id, 'repair_required', reason)
    await this.releaseWrite(attempt.id, 'failed')
    return this.maybeRetry(run, node.node.id)
  }
  private async holdRequiredFailure(
    run: GraphRunV1,
    node: GraphNodeProjectionV1
  ): Promise<GraphRunV1> {
    if (run.status === 'running' || run.status === 'awaiting_human') {
      const reason =
        `Required node ${node.node.id} exhausted automatic attempts: ${node.status}`
      run = await this.transitionRun(run, 'awaiting_supervision', reason)
      await this.requestSupervision(run.id, 'failure', [node.node.id], reason)
    }
    return run
  }
  private async ensureReviews(
    runInput: GraphRunV1,
    nodeId: string,
    attemptId: string
  ): Promise<GraphRunV1> {
    let run = runInput
    const node = run.nodes[nodeId]
    const attempt = node.attempts.find((entry) => entry.id === attemptId)!
    const kinds = effectiveReviewKinds(
      node,
      this.options.config(),
      run.plans.at(-1)!.completionNodeIds.includes(nodeId)
    )
    for (const kind of kinds) {
      if (run.reviews.some((review) =>
        review.nodeId === nodeId &&
        review.attemptId === attemptId &&
        review.reviewerKind === kind)) continue
      if (kind === 'human' || kind === 'lead') continue
      let review: GraphReviewResultV1
      if (kind === 'deterministic') {
        review = deterministicReview(node, attempt, this.nextId('graph_review'), this.nowIso())
      } else {
        const reviewer = this.options.supervision?.()?.review
        if (!reviewer) continue
        review = await reviewer({ run, node, attempt, kind })
      }
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `review_${review.reviewId}`,
        idempotencyKey: `review:${review.reviewId}`,
        event: { type: 'review_recorded', payload: { review } }
      })).state
    }
    return run
  }
  private async enforceBudgets(run: GraphRunV1): Promise<GraphRunV1> {
    const elapsedMs = Math.max(run.budget.elapsedMs, Date.now() - Date.parse(run.createdAt))
    if (
      elapsedMs >= run.budget.limits.maxWallTimeMs ||
      elapsedMs - run.budget.elapsedMs >= 1_000
    ) {
      run = await this.updateBudget(run, { elapsedMs }, 'scheduler wall time accounting')
    }
    const exhausted =
      run.budget.elapsedMs >= run.budget.limits.maxWallTimeMs ||
      run.budget.artifactBytes >= run.budget.limits.maxArtifactBytes
    // Creating an attempt consumes one slot, but reaching the exact attempt
    // limit must not abort that in-flight worker. scheduleNode fences any
    // subsequent attempt before creation, and terminalRequiredFailure handles
    // a node that finishes unsuccessfully without retry capacity.
    if (exhausted) return this.failForBudget(run, 'GraphRun hard budget exhausted')
    const ratio = maxBudgetRatio(run)
    if (ratio >= run.budget.limits.warningRatio) {
      const warningKinds = budgetWarningKinds(run)
      if (warningKinds.some((kind) => !run.budget.warningKinds.includes(kind))) {
        const ledger = {
          ...run.budget,
          warningKinds: [...new Set([...run.budget.warningKinds, ...warningKinds])]
        }
        run = (await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: `budget_warning_${run.lastEventSeq + 1}`,
          idempotencyKey: `budget-warning:${run.id}:${warningKinds.join(',')}`,
          event: {
            type: 'budget_warning',
            payload: { ledger, reason: 'GraphRun budget warning threshold reached' }
          }
        })).state
        await this.requestSupervision(run.id, 'budget', [], 'GraphRun budget warning threshold reached.')
      }
    }
    return run
  }
  protected async failForBudget(run: GraphRunV1, reason: string): Promise<GraphRunV1> {
    const next = await this.failRun(run, reason)
    if (next === run) return run
    await this.requestSupervision(run.id, 'budget', [], reason)
    return next
  }
  private async failRun(run: GraphRunV1, reason: string): Promise<GraphRunV1> {
    if (run.status !== 'running') return run
    this.fencedRuns.add(run.id)
    const attempts = [...this.active.values()].filter((attempt) => attempt.runId === run.id)
    for (const attempt of attempts) attempt.abort.abort(new Error(reason))
    if (attempts.length) {
      const fenced = await this.transitionRun(
        run,
        'awaiting_supervision',
        `failure dispatch fenced: ${reason}`
      )
      this.scheduleFailureFinalization(run.id, reason, attempts.map((attempt) => attempt.promise))
      return fenced
    }
    return this.finalizeFailure(run, reason)
  }
  private async finalizeFailure(run: GraphRunV1, reason: string): Promise<GraphRunV1> {
    if (run.status !== 'running' && run.status !== 'awaiting_supervision') return run
    run = await this.recordTerminalCleanup(run)
    const next = await this.transitionRun(run, 'failed', reason)
    await this.requestSupervision(run.id, 'failure', [], reason)
    await this.options.onTerminal?.(next)
    return next
  }
  private scheduleFailureFinalization(
    runId: string,
    reason: string,
    attemptPromises: readonly Promise<void>[]
  ): void {
    const task = Promise.allSettled(attemptPromises).then(() =>
      this.withRunQueue(runId, async () => {
        const run = await this.requireRun(runId)
        await this.finalizeFailure(run, reason)
      })
    ).catch((error) => {
      console.warn(`[kun] Graph failure finalization failed for ${runId}: ${errorMessage(error)}`)
    })
    this.cleanupTasks.add(task)
    void task.finally(() => this.cleanupTasks.delete(task))
  }
  private async tryComplete(runInput: GraphRunV1): Promise<GraphRunV1> {
    let run = runInput
    const required = Object.values(run.nodes).filter((node) => node.node.required)
    if (!required.length || !required.every((node) =>
      node.status === 'accepted' || node.status === 'superseded')) return run
    if (this.options.mailbox.unresolvedBlockers(run).length) return run
    if (!run.plans.at(-1)!.completionNodeIds.every((id) =>
      run.nodes[id]?.status === 'accepted' || run.nodes[id]?.status === 'superseded')) return run
    if (Object.values(run.nodes).some((node) =>
      ['pending', 'blocked', 'ready', 'queued', 'running', 'submitted', 'reviewing'].includes(
        node.status
      ))) return run
    run = await this.transitionRun(run, 'completing', 'all completion gates passed')
    return this.finishCompletion(run)
  }
  private async finishCompletion(initialRun: GraphRunV1): Promise<GraphRunV1> {
    let run = initialRun
    if (run.status !== 'completing') return run
    if (!run.summary) {
      const summary = this.options.supervision?.()?.synthesize
        ? await this.options.supervision()!.synthesize!(run)
        : deterministicSummary(run, this.nowIso())
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `summary_${run.id}`,
        idempotencyKey: `summary:${run.id}:${run.currentRevision}`,
        event: { type: 'run_summary_recorded', payload: { summary } }
      })).state
    }
    run = await this.recordTerminalCleanup(run)
    run = await this.transitionRun(run, 'completed', 'final synthesis recorded')
    await this.requestSupervision(
      run.id,
      'completion',
      [],
      run.summary!.finalAnswer.slice(0, 4_096)
    )
    await this.options.onTerminal?.(run)
    return run
  }
  private recordTerminalCleanup(run: GraphRunV1): Promise<GraphRunV1> {
    this.stopRunLeaseHeartbeats(run.id)
    return recordGraphTerminalCleanup({
      run,
      writes: this.options.writes,
      nextId: this.nextId,
      nowIso: this.nowIso,
      append: (current, event, key) => this.append(current, event, key)
    })
  }

  protected async deliverSteering(
    initialRun: GraphRunV1,
    nodeId: string
  ): Promise<GraphRunV1> {
    return deliverNodeSteering(
      initialRun,
      nodeId,
      (run, event, key) => this.append(run, event, key)
    )
  }

  protected async handleAttemptSteering(
    initialRun: GraphRunV1,
    nodeId: string,
    attemptId: string
  ): Promise<GraphRunV1> {
    return handleNodeAttemptSteering(
      initialRun,
      nodeId,
      attemptId,
      (run, event, key) => this.append(run, event, key)
    )
  }

  protected async updateBudget(
    run: GraphRunV1,
    fields: Partial<Pick<GraphRunV1['budget'], 'totalTokens' | 'elapsedMs' | 'artifactBytes'>>,
    reason: string
  ): Promise<GraphRunV1> {
    const ledger = { ...run.budget, ...fields }
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: `budget_${run.id}_${run.lastEventSeq + 1}`,
      idempotencyKey: `budget:${run.id}:${run.lastEventSeq + 1}`,
      event: { type: 'budget_updated', payload: { ledger, reason } }
    })).state
  }

  private async bumpLoopBudget(run: GraphRunV1): Promise<GraphRunV1> {
    const ledger = { ...run.budget, loopIterations: run.budget.loopIterations + 1 }
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: `loop_${run.id}_${ledger.loopIterations}`,
      idempotencyKey: `loop:${run.id}:${ledger.loopIterations}`,
      event: {
        type: 'budget_updated',
        payload: { ledger, reason: 'bounded LoopGate continuation' }
      }
    })).state
  }

  protected transitionRun(
    run: GraphRunV1,
    to: GraphRunV1['status'],
    reason: string
  ): Promise<GraphRunV1> {
    return this.append(run, {
      type: 'run_status_changed',
      payload: { from: run.status, to, reason }
    }, `run:${run.id}:${run.status}:${to}:${run.lastEventSeq + 1}`)
  }

  protected transitionNode(
    run: GraphRunV1,
    nodeId: string,
    to: GraphNodeProjectionV1['status'],
    reason: string
  ): Promise<GraphRunV1> {
    const from = run.nodes[nodeId].status
    return this.append(run, {
      type: 'node_status_changed',
      payload: { nodeId, from, to, reason }
    }, `node:${run.id}:${nodeId}:${from}:${to}:${run.lastEventSeq + 1}`)
  }

  protected transitionAttempt(
    run: GraphRunV1,
    nodeId: string,
    attemptId: string,
    to: GraphNodeAttemptV1['status'],
    failureClass?: GraphNodeAttemptV1['failureClass'],
    normalizedFailure?: string,
    childThreadId?: string
  ): Promise<GraphRunV1> {
    const attempt = findAttempt(run, nodeId, attemptId)
    return this.append(run, {
      type: 'attempt_status_changed',
      payload: {
        nodeId,
        attemptId,
        from: attempt.status,
        to,
        ...(childThreadId ? { childThreadId } : {}),
        ...(failureClass ? { failureClass } : {}),
        ...(normalizedFailure ? { normalizedFailure: normalizedFailure.slice(0, 512) } : {})
      }
    }, `attempt:${attemptId}:${attempt.status}:${to}`)
  }

  private async append(
    run: GraphRunV1,
    event: GraphDomainEventV1,
    idempotencyKey: string
  ): Promise<GraphRunV1> {
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: this.nextId('graph_command'),
      idempotencyKey,
      event
    })).state
  }

  protected async requestSupervision(
    runId: string,
    reason: Parameters<GraphSupervisionPort['signal']>[0]['reason'],
    nodeIds: string[],
    digest: string
  ): Promise<void> {
    await this.options.supervision?.()?.signal({
      runId,
      reason,
      nodeIds,
      digest: digest.slice(0, 4_096)
    })
  }

  protected withRunQueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runQueues.get(runId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const guard = run.then(() => undefined, () => undefined)
    this.runQueues.set(runId, guard)
    return run.finally(() => {
      if (this.runQueues.get(runId) === guard) this.runQueues.delete(runId)
    })
  }

  protected async requireRun(runId: string): Promise<GraphRunV1> {
    const run = await this.options.store.get(runId)
    if (!run) throw new Error(`GraphRun not found: ${runId}`)
    return run
  }
}
