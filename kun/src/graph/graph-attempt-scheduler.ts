import { createHash } from 'node:crypto'
import {
  GRAPH_CONTRACT_VERSION,
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { ChildRunRecord } from '../delegation/delegation-runtime.js'
import { buildGraphWorkerContext } from './graph-worker-context.js'
import type { GraphPathLease } from './graph-write-coordinator.js'
import {
  downstreamNodeIds,
  errorMessage,
  findAttempt,
  isTerminalAttemptStatus,
  isTerminalRunStatus,
  parseWorkerResult,
  totalAttemptLimit,
  validateWorkerResult
} from './graph-scheduler-policy.js'
import type {
  GraphSchedulerOptions,
  GraphSupervisionPort
} from './graph-scheduler-types.js'
import { canonicalWorkerArtifactRefs } from './graph-artifact-policy.js'
import { graphWorkerSecuritySnapshot } from './graph-worker-security.js'
import { resolveGraphAttemptAssignment } from './graph-attempt-routing.js'

type ActiveAttempt = {
  runId: string
  nodeId: string
  attemptId: string
  abort: AbortController
  timeout: NodeJS.Timeout
  deadlineAt: number
  promise: Promise<void>
}

export abstract class GraphAttemptScheduler {
  protected readonly active = new Map<string, ActiveAttempt>()
  protected readonly fencedRuns = new Set<string>()
  private readonly cancellingRuns = new Set<string>()
  private readonly leases = new Map<string, GraphPathLease>()
  private readonly leaseHeartbeats = new Map<string, {
    runId: string
    timer: NodeJS.Timeout
  }>()
  private readonly retryNotBefore = new Map<string, number>()
  protected readonly nowIso: () => string
  protected readonly nextId: (prefix: string) => string

  constructor(protected readonly options: GraphSchedulerOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
  }

  protected retryReady(runId: string, nodeId: string): boolean {
    return (this.retryNotBefore.get(`${runId}:${nodeId}`) ?? 0) <= Date.now()
  }

  async cancelRun(
    runId: string,
    disposition: 'pause' | 'cancel' = 'pause'
  ): Promise<number> {
    this.fencedRuns.add(runId)
    if (disposition === 'cancel') this.cancellingRuns.add(runId)
    else this.cancellingRuns.delete(runId)
    const attempts = [...this.active.values()].filter((attempt) => attempt.runId === runId)
    for (const attempt of attempts) attempt.abort.abort()
    await Promise.allSettled(attempts.map((attempt) => attempt.promise))
    if (disposition === 'cancel') this.stopRunLeaseHeartbeats(runId)
    return attempts.length
  }

  resumeRun(runId: string): void {
    this.fencedRuns.delete(runId)
    this.cancellingRuns.delete(runId)
  }

  protected async scheduleNode(runId: string, nodeId: string): Promise<boolean> {
    const delegation = this.options.delegation()
    if (!delegation?.enabled()) {
      let paused = false
      await this.withRunQueue(runId, async () => {
        const run = await this.requireRun(runId)
        if (run.status !== 'running') return
        await this.transitionRun(run, 'paused', 'Subagent runtime is unavailable.')
        paused = true
      })
      if (paused) {
        await this.requestSupervision(
          runId,
          'failure',
          [nodeId],
          'Subagent runtime is unavailable; the GraphRun was paused safely.'
        )
      }
      return false
    }
    let writeLease: GraphPathLease | undefined
    let preparation: {
      run: GraphRunV1
      nodeId: string
      attempt: GraphNodeAttemptV1
      lease: GraphPathLease
    } | null
    try {
      preparation = await this.withRunQueue(runId, async () => {
      let run = await this.requireRun(runId)
      const node = run.nodes[nodeId]
      if (!node || node.status !== 'ready') return null
      run = await this.deliverSteering(run, nodeId)
      if (run.budget.attempts >= totalAttemptLimit(run)) {
        run = await this.failForBudget(run, 'attempt budget exhausted')
        return null
      }
      const assignment = await resolveGraphAttemptAssignment(this.options, run, node)
      const attemptId = this.nextId('graph_attempt')
      const attemptNumber = node.attempts.length + 1
      const writeClaim = await this.options.writes.acquire({
        runId,
        nodeId,
        attemptId,
        workspaceRoot: assignment.workspaceRoot,
        scopes: assignment.writeScopes
      })
      if (!writeClaim.acquired) {
        await this.requestSupervision(
          runId,
          'conflict',
          [nodeId],
          `Write scopes are waiting on ${writeClaim.conflicts.length} active lease(s).`
        )
        return null
      }
      writeLease = writeClaim.lease
      const attempt: GraphNodeAttemptV1 = {
        version: GRAPH_CONTRACT_VERSION,
        id: attemptId,
        runId,
        nodeId,
        revision: run.currentRevision,
        attemptNumber,
        iteration: node.loopIteration,
        commandId: this.nextId('graph_command'),
        idempotencyKey: `attempt:${runId}:${nodeId}:${attemptNumber}:${node.loopIteration}`,
        status: 'queued',
        assignment: {
          ...assignment,
          workspaceRoot: writeClaim.workspaceRoot
        },
        queuedAt: this.nowIso(),
        tokenUsage: 0,
        elapsedMs: 0
      }
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: attempt.commandId,
        idempotencyKey: attempt.idempotencyKey,
        event: { type: 'attempt_created', payload: { attempt } }
      })).state
      return { run, nodeId, attempt, lease: writeClaim.lease }
      })
    } catch (error) {
      if (writeLease) {
        await this.options.writes.rollback(writeLease.leaseId).catch((rollbackError) => {
          console.warn(
            `[kun] Graph admission rollback failed for ${writeLease!.attemptId}: ` +
            errorMessage(rollbackError)
          )
        })
      }
      await this.handleAdmissionFailure(runId, nodeId, error)
      return false
    }
    if (!preparation) return false
    const abort = new AbortController()
    this.leases.set(preparation.attempt.id, preparation.lease)
    this.startLeaseHeartbeat(
      runId,
      nodeId,
      preparation.attempt.id,
      preparation.lease,
      abort
    )
    const active: ActiveAttempt = {
      runId,
      nodeId,
      attemptId: preparation.attempt.id,
      abort,
      timeout: setTimeout(() => {
        abort.abort(new Error('Graph node wall-time budget exhausted'))
      }, preparation.attempt.assignment.maxWallTimeMs),
      deadlineAt: Date.now() + preparation.attempt.assignment.maxWallTimeMs,
      promise: Promise.resolve()
    }
    active.promise = this.executeAttempt(
      preparation.run,
      preparation.nodeId,
      preparation.attempt,
      preparation.lease,
      abort.signal
    ).catch((error) => {
      console.warn(
        `[kun] Graph attempt ${preparation.attempt.id} failed outside its state boundary: ` +
        errorMessage(error)
      )
    }).finally(() => {
      clearTimeout(active.timeout)
      this.active.delete(preparation.attempt.id)
      void this.tick().catch((error) => {
        console.warn(`[kun] Graph scheduler follow-up tick failed: ${errorMessage(error)}`)
      })
    })
    this.active.set(preparation.attempt.id, active)
    return true
  }

  private async handleAdmissionFailure(
    runId: string,
    nodeId: string,
    error: unknown
  ): Promise<void> {
    const message = `Graph node admission failed: ${errorMessage(error)}`
    let settled = false
    try {
      await this.withRunQueue(runId, async () => {
        let run = await this.requireRun(runId)
        const node = run.nodes[nodeId]
        if (!node || node.status !== 'ready' || run.status !== 'running') return
        run = await this.transitionNode(run, nodeId, 'failed', message)
        await this.transitionRun(run, 'awaiting_supervision', message)
        settled = true
      })
    } catch (stateError) {
      this.fencedRuns.add(runId)
      console.warn(
        `[kun] Graph admission failure could not be persisted; fenced ${runId}/${nodeId}: ` +
        errorMessage(stateError)
      )
      throw stateError
    }
    if (settled) await this.requestSupervision(runId, 'failure', [nodeId], message)
  }

  private async executeAttempt(
    initialRun: GraphRunV1,
    nodeId: string,
    attempt: GraphNodeAttemptV1,
    lease: GraphPathLease,
    signal: AbortSignal
  ): Promise<void> {
    const delegation = this.options.delegation()
    if (!delegation) return
    const context = buildGraphWorkerContext(initialRun, nodeId, this.options.config())
    let boundChildId: string | undefined
    try {
      const child = await delegation.runChild({
        parentThreadId: initialRun.threadId,
        parentTurnId: initialRun.sourceTurnId,
        label: initialRun.nodes[nodeId].node.title,
        prompt: context.prompt,
        workspace: attempt.assignment.workspaceRoot,
        inheritedModel: attempt.assignment.model,
        inheritedProviderId: attempt.assignment.providerId,
        inheritedReasoningEffort: attempt.assignment.reasoningEffort,
        approvalPolicy: attempt.assignment.approvalPolicy,
        sandboxMode: attempt.assignment.sandboxMode,
        inlineProfile: {
          id: attempt.assignment.profileId,
          source: attempt.assignment.profileOrigin === 'ephemeral' ? 'custom' : 'configured',
          profile: {
            name: attempt.assignment.name,
            description: initialRun.nodes[nodeId].node.objective.slice(0, 500),
            mode: 'subagent',
            model: attempt.assignment.model,
            providerId: attempt.assignment.providerId,
            systemPrompt: attempt.assignment.systemPrompt,
            toolPolicy: attempt.assignment.toolPolicy,
            ...(attempt.assignment.allowedTools.length
              ? { allowedTools: attempt.assignment.allowedTools }
              : {}),
            blockedTools: attempt.assignment.blockedTools,
            blockedSkills: attempt.assignment.blockedSkills,
            blockedMcpServers: attempt.assignment.blockedMcpServers,
            skillsEnabled: attempt.assignment.allowedSkills.length > 0,
            reasoningEffort: attempt.assignment.reasoningEffort
          }
        },
        security: graphWorkerSecuritySnapshot(attempt.assignment, context.artifactRefs),
        toolPolicyCeiling: attempt.assignment.toolPolicy === 'readOnly' ? 'readOnly' : undefined,
        returnFormat: 'evidence',
        onQueued: (childId) => {
          boundChildId = childId
          this.options.workerSessions.bind(childId, {
            runId: initialRun.id,
            nodeId,
            attemptId: attempt.id
          })
        },
        onRunning: async (childId) => {
          await this.withRunQueue(initialRun.id, async () => {
            let run = await this.requireRun(initialRun.id)
            if (isTerminalRunStatus(run.status)) return
            const current = findAttempt(run, nodeId, attempt.id)
            if (current.status === 'queued') {
              run = await this.transitionAttempt(
                run,
                nodeId,
                attempt.id,
                'running',
                undefined,
                undefined,
                childId
              )
            }
            if (run.nodes[nodeId].status === 'queued') {
              await this.transitionNode(run, nodeId, 'running', 'child agent started')
            }
          })
        },
        signal
      })
      await this.finishChild(initialRun.id, nodeId, attempt.id, child, lease)
    } catch (error) {
      const timedOut = signal.aborted && signal.reason instanceof Error &&
        signal.reason.message === 'Graph node wall-time budget exhausted'
      await this.failAttempt(
        initialRun.id,
        nodeId,
        attempt.id,
        lease,
        timedOut ? signal.reason : error,
        signal.aborted && !timedOut
      )
    } finally {
      if (boundChildId) this.options.workerSessions.release(boundChildId)
    }
  }

  private async finishChild(
    runId: string,
    nodeId: string,
    attemptId: string,
    child: ChildRunRecord,
    lease: GraphPathLease
  ): Promise<void> {
    if (child.status !== 'completed') {
      await this.failAttempt(
        runId,
        nodeId,
        attemptId,
        lease,
        child.error ?? `child ended with ${child.status}`,
        child.status === 'aborted'
      )
      return
    }
    await this.withRunQueue(runId, async () => {
      let run = await this.requireRun(runId)
      const projection = run.nodes[nodeId]
      const attempt = findAttempt(run, nodeId, attemptId)
      if (isTerminalRunStatus(run.status)) {
        if (!isTerminalAttemptStatus(attempt.status)) {
          run = await this.transitionAttempt(run, nodeId, attemptId, 'cancelled')
        }
        const currentNode = run.nodes[nodeId]
        if (currentNode.status === 'queued' || currentNode.status === 'running') {
          await this.transitionNode(run, nodeId, 'cancelled', 'run ended before worker result')
        }
        return
      }
      if (attempt.status === 'queued') {
        run = await this.transitionAttempt(
          run,
          nodeId,
          attemptId,
          'running',
          undefined,
          undefined,
          child.id
        )
      }
      if (run.nodes[nodeId].status === 'queued') {
        run = await this.transitionNode(run, nodeId, 'running', 'child completed before running callback')
      }
      let result = attempt.result ?? parseWorkerResult(child)
      result = {
        ...result,
        artifactRefs: canonicalWorkerArtifactRefs(
          run,
          nodeId,
          attemptId,
          result.artifactRefs
        )
      }
      const downstreamDataEdges = run.plans.at(-1)!.edges.filter((edge) =>
        edge.kind === 'data' && edge.from === nodeId)
      const missingArtifactNames = [...new Set(downstreamDataEdges
        .flatMap((edge) => edge.kind === 'data' ? [edge.artifactName] : [])
        .filter((name) => !result.artifactRefs.some((artifact) =>
          artifact.logicalNames?.includes(name))))]
      let generatedArtifactBytes = 0
      if (
        missingArtifactNames.length &&
        this.options.artifactStore
      ) {
        const content = JSON.stringify(result)
        const stored = await this.options.artifactStore.put({
          content,
          mimeType: 'application/json',
          source: 'other',
          origin: `graph-result:${attemptId}`,
          maxInlineChars: 2_048
        })
        const artifact = {
          version: GRAPH_CONTRACT_VERSION,
          artifactId: stored.meta.id,
          contentHash: createHash('sha256').update(content).digest('hex'),
          mimeType: 'application/json',
          byteLength: stored.meta.byteSize,
          summary: result.summary,
          logicalNames: missingArtifactNames,
          producerNodeId: nodeId,
          producerAttemptId: attemptId,
          visibility: 'dependency',
          retention: 'run',
          createdAt: stored.meta.createdAt
        } as const
        run = (await this.options.store.append(run.id, {
          expectedSeq: run.lastEventSeq,
          graphRevision: run.currentRevision,
          commandId: `artifact_${artifact.artifactId}_${attemptId}`,
          idempotencyKey: `artifact:${attemptId}:${artifact.artifactId}`,
          event: {
            type: 'artifact_published',
            payload: { artifact, consumerNodeIds: downstreamNodeIds(run, nodeId) }
          }
        })).state
        generatedArtifactBytes = artifact.byteLength
        result = { ...result, artifactRefs: [...result.artifactRefs, artifact] }
      }
      const validation = validateWorkerResult(projection, result)
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `result_${attemptId}`,
        idempotencyKey: attempt.result ? `result-final:${attemptId}` : `result:${attemptId}`,
        event: {
          type: 'result_submitted',
          payload: {
            nodeId,
            attemptId,
            result,
            validation,
            tokenUsage: child.usage.totalTokens,
            elapsedMs: child.durationMs ?? 0
          }
        }
      })).state
      run = await this.transitionAttempt(
        run,
        nodeId,
        attemptId,
        'submitted',
        undefined,
        undefined,
        child.id
      )
      run = await this.transitionNode(run, nodeId, 'submitted', 'worker result submitted')
      run = await this.updateBudget(run, {
        totalTokens: run.budget.totalTokens + child.usage.totalTokens,
        elapsedMs: Math.max(run.budget.elapsedMs, Date.now() - Date.parse(run.createdAt)),
        artifactBytes: run.budget.artifactBytes + generatedArtifactBytes
      }, 'worker attempt completed')
      run = await this.handleAttemptSteering(run, nodeId, attemptId)
      await this.requestSupervision(run.id, 'submitted', [nodeId], result.summary)
      return run
    })
    const latest = await this.requireRun(runId)
    if (isTerminalRunStatus(latest.status)) {
      await this.releaseWrite(attemptId, 'cancelled')
      return
    }
    await this.options.writes.captureWorktree(attemptId).catch(() => null)
  }

  private async failAttempt(
    runId: string,
    nodeId: string,
    attemptId: string,
    lease: GraphPathLease,
    error: unknown,
    interrupted: boolean
  ): Promise<void> {
    await this.withRunQueue(runId, async () => {
      let run = await this.requireRun(runId)
      const attempt = findAttempt(run, nodeId, attemptId)
      if (isTerminalRunStatus(run.status)) {
        if (!isTerminalAttemptStatus(attempt.status)) {
          run = await this.transitionAttempt(run, nodeId, attemptId, 'cancelled')
        }
        const currentNode = run.nodes[nodeId]
        if (currentNode.status === 'queued' || currentNode.status === 'running') {
          await this.transitionNode(run, nodeId, 'cancelled', 'run ended while worker was active')
        }
        return
      }
      const cancelling = interrupted && this.cancellingRuns.has(runId)
      const terminal = cancelling
        ? 'cancelled'
        : interrupted || attempt.status === 'queued'
          ? 'interrupted'
          : 'failed'
      if (
        !['accepted', 'repair_required', 'failed', 'interrupted', 'cancelled', 'orphaned']
          .includes(attempt.status) &&
        (attempt.status === 'queued' || attempt.status === 'running' || attempt.status === 'waiting')
      ) {
        run = await this.transitionAttempt(
          run,
          nodeId,
          attemptId,
          terminal,
          cancelling ? undefined : interrupted ? 'interrupted' : 'retryable',
          errorMessage(error)
        )
      }
      const node = run.nodes[nodeId]
      if (node.status === 'queued' || node.status === 'running') {
        run = await this.transitionNode(
          run,
          nodeId,
          cancelling ? 'cancelled' : 'failed',
          errorMessage(error)
        )
      }
      if (!cancelling) {
        run = await this.maybeRetry(run, nodeId)
        await this.requestSupervision(run.id, 'failure', [nodeId], errorMessage(error))
      }
      return run
    })
    await this.options.writes.release(lease.leaseId, interrupted ? 'cancelled' : 'failed')
    this.stopLeaseHeartbeat(attemptId)
    this.leases.delete(attemptId)
  }

  protected async integrateWrite(attemptId: string): Promise<'applied' | 'conflict'> {
    const lease = this.leases.get(attemptId)
    if (lease && !await this.options.writes.isActive(lease.leaseId)) return 'conflict'
    const worktree = await this.options.writes.captureWorktree(attemptId).catch(() => null)
    if (worktree) {
      const integrated = await this.options.writes.integrate(attemptId)
      if (integrated.outcome !== 'applied') return 'conflict'
    }
    if (lease) await this.options.writes.release(lease.leaseId, 'accepted')
    this.stopLeaseHeartbeat(attemptId)
    this.leases.delete(attemptId)
    return 'applied'
  }

  protected async releaseWrite(
    attemptId: string,
    disposition: 'failed' | 'cancelled'
  ): Promise<void> {
    const lease = this.leases.get(attemptId)
    if (lease) await this.options.writes.release(lease.leaseId, disposition)
    this.stopLeaseHeartbeat(attemptId)
    this.leases.delete(attemptId)
  }

  protected stopRunLeaseHeartbeats(runId: string): void {
    for (const [attemptId, heartbeat] of this.leaseHeartbeats) {
      if (heartbeat.runId === runId) this.stopLeaseHeartbeat(attemptId)
    }
  }

  protected stopAllLeaseHeartbeats(): void {
    for (const attemptId of this.leaseHeartbeats.keys()) this.stopLeaseHeartbeat(attemptId)
  }

  protected abortOverdueAttempts(now = Date.now()): void {
    for (const attempt of this.active.values()) {
      if (attempt.deadlineAt <= now && !attempt.abort.signal.aborted) {
        attempt.abort.abort(new Error('Graph node wall-time budget exhausted'))
      }
    }
  }

  private startLeaseHeartbeat(
    runId: string,
    nodeId: string,
    attemptId: string,
    lease: GraphPathLease,
    abort: AbortController
  ): void {
    const timer = setInterval(() => {
      void this.options.writes.renew(lease.leaseId).catch((error) => {
        this.stopLeaseHeartbeat(attemptId)
        abort.abort(new Error(`Graph write lease renewal failed: ${errorMessage(error)}`))
        void this.requestSupervision(
          runId,
          'conflict',
          [nodeId],
          `Write lease renewal failed for ${attemptId}: ${errorMessage(error)}`
        )
      })
    }, Math.max(
      250,
      Math.min(60_000, Math.floor(this.options.config().writeIsolation.leaseTtlMs / 3))
    ))
    timer.unref?.()
    this.leaseHeartbeats.set(attemptId, { runId, timer })
  }

  private stopLeaseHeartbeat(attemptId: string): void {
    const heartbeat = this.leaseHeartbeats.get(attemptId)
    if (heartbeat) clearInterval(heartbeat.timer)
    this.leaseHeartbeats.delete(attemptId)
  }

  protected async maybeRetry(runInput: GraphRunV1, nodeId: string): Promise<GraphRunV1> {
    let run = runInput
    const node = run.nodes[nodeId]
    const maxAttempts = Math.min(
      node.node.maxAttempts ?? run.budget.limits.maxAttemptsPerNode,
      this.options.config().scheduler.maxAttemptsPerNode
    )
    if (node.attempts.length >= maxAttempts) return run
    const delay = Math.min(30_000, 500 * 2 ** Math.max(0, node.attempts.length - 1))
    this.retryNotBefore.set(`${run.id}:${nodeId}`, Date.now() + delay)
    if (node.status === 'failed' || node.status === 'repair_required') {
      run = await this.transitionNode(
        run,
        nodeId,
        'ready',
        `retry ${node.attempts.length + 1} scheduled`
      )
    }
    return run
  }

  abstract tick(): Promise<void>
  protected abstract failForBudget(run: GraphRunV1, reason: string): Promise<GraphRunV1>
  protected abstract deliverSteering(run: GraphRunV1, nodeId: string): Promise<GraphRunV1>
  protected abstract handleAttemptSteering(
    run: GraphRunV1,
    nodeId: string,
    attemptId: string
  ): Promise<GraphRunV1>
  protected abstract updateBudget(
    run: GraphRunV1,
    fields: Partial<Pick<GraphRunV1['budget'], 'totalTokens' | 'elapsedMs' | 'artifactBytes'>>,
    reason: string
  ): Promise<GraphRunV1>
  protected abstract transitionRun(
    run: GraphRunV1,
    to: GraphRunV1['status'],
    reason: string
  ): Promise<GraphRunV1>
  protected abstract transitionNode(
    run: GraphRunV1,
    nodeId: string,
    to: GraphNodeProjectionV1['status'],
    reason: string
  ): Promise<GraphRunV1>
  protected abstract transitionAttempt(
    run: GraphRunV1,
    nodeId: string,
    attemptId: string,
    to: GraphNodeAttemptV1['status'],
    failureClass?: GraphNodeAttemptV1['failureClass'],
    normalizedFailure?: string,
    childThreadId?: string
  ): Promise<GraphRunV1>
  protected abstract requestSupervision(
    runId: string,
    reason: Parameters<GraphSupervisionPort['signal']>[0]['reason'],
    nodeIds: string[],
    digest: string
  ): Promise<void>
  protected abstract withRunQueue<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T>
  protected abstract requireRun(runId: string): Promise<GraphRunV1>
}
