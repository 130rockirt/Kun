import { isDeepStrictEqual } from 'node:util'
import {
  GRAPH_CONTRACT_VERSION,
  GraphPatchV1Schema,
  GraphReviewResultV1Schema,
  GraphSteeringV1Schema,
  type GraphCleanupRecordV1,
  type GraphCommandResultV1,
  type GraphPatchV1,
  type GraphPlanV1,
  type GraphReviewResultV1,
  type GraphRunStatus,
  type GraphRunV1,
  type GraphSteeringV1,
  type GraphValidationResultV1
} from '../contracts/graph.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import {
  type CreateGraphRunInput,
  type GraphRunListFilter,
  type GraphRunStore,
  GraphRunConflictError,
  GraphRunNotFoundError
} from './graph-run-store.js'
import {
  GraphPlanValidationError,
  parseAndValidateGraphPlan,
  validateGraphPlan
} from './graph-validator.js'
import {
  effectiveReviewKinds,
  isTerminalRunStatus
} from './graph-scheduler-policy.js'

export type GraphCommandContext = {
  commandId: string
  idempotencyKey: string
  expectedSeq?: number
  expectedRevision?: number
}

export type CreateValidatedGraphRunInput = CreateGraphRunInput & {
  start?: boolean
}

export type GraphControlServiceOptions = {
  store: GraphRunStore
  config: () => GraphRuntimeConfig
  authorizeCreate?: (input: CreateValidatedGraphRunInput) => Promise<void>
  pauseActive?: (run: GraphRunV1) => Promise<void>
  cancelActive?: (run: GraphRunV1) => Promise<void>
  resumeActive?: (run: GraphRunV1) => Promise<void> | void
  onSteering?: (run: GraphRunV1, steering: GraphSteeringV1) => Promise<void> | void
  onCancelled?: (run: GraphRunV1, reason?: string) => Promise<void> | void
  cleanupResources?: (run: GraphRunV1) => Promise<Array<Pick<
    GraphCleanupRecordV1,
    'resourceKind' | 'resourceId' | 'attemptId' | 'state' | 'lastError'
  >>>
  nowIso?: () => string
  nextId?: (prefix: string) => string
}

export class GraphControlService {
  private readonly nowIso: () => string
  private readonly nextId: (prefix: string) => string

  constructor(private readonly options: GraphControlServiceOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    let next = 0
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${Date.now()}_${++next}`)
  }

  allocateId(prefix: string): string { return this.nextId(prefix) }

  validate(input: unknown): GraphValidationResultV1 {
    return parseAndValidateGraphPlan(input, this.options.config()).result
  }

  async create(input: CreateValidatedGraphRunInput): Promise<GraphCommandResultV1> {
    this.assertGraphCreationEnabled()
    await this.options.authorizeCreate?.(input)
    const created = await this.options.store.create(input)
    let run = await this.ensureReady(created.run, {
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey
    })
    if (input.start || input.plan.autoStart) {
      run = await this.start(run.id, {
        commandId: `${input.commandId}_start`,
        idempotencyKey: `${input.idempotencyKey}:start`,
        expectedRevision: run.currentRevision
      })
    }
    return { ...created, run }
  }

  async get(runId: string): Promise<GraphRunV1> {
    const run = await this.options.store.get(runId)
    if (!run) throw new GraphRunNotFoundError(runId)
    return run
  }

  list(filter?: GraphRunListFilter): Promise<GraphRunV1[]> {
    return this.options.store.list(filter)
  }

  async start(runId: string, command: GraphCommandContext): Promise<GraphRunV1> {
    this.assertGraphCreationEnabled()
    let run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (run.status === 'running') {
      await this.options.resumeActive?.(run)
      return run
    }
    if (run.status === 'draft' || run.status === 'validating') {
      run = await this.ensureReady(run, command)
    }
    if (run.status !== 'ready' && run.status !== 'paused' && run.status !== 'awaiting_supervision') {
      throw new GraphRunConflictError(`cannot start GraphRun ${runId} from ${run.status}`)
    }
    const started = await this.transitionRun(run, 'running', command)
    await this.options.resumeActive?.(started)
    return started
  }

  async pause(runId: string, command: GraphCommandContext): Promise<GraphRunV1> {
    let run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (run.status === 'paused') return run
    if (run.status === 'draft' || run.status === 'validating') {
      run = await this.ensureReady(run, {
        ...command,
        commandId: `${command.commandId}_validate`,
        idempotencyKey: `${command.idempotencyKey}:validate`
      })
    }
    if (run.status === 'running') {
      run = await this.transitionRun(run, 'pausing', {
        ...command,
        commandId: `${command.commandId}_fence`,
        idempotencyKey: `${command.idempotencyKey}:fence`
      })
    }
    if (![
      'pausing',
      'ready',
      'awaiting_supervision',
      'awaiting_human',
      'completing'
    ].includes(run.status)) {
      throw new GraphRunConflictError(`cannot pause GraphRun ${runId} from ${run.status}`)
    }
    await this.options.pauseActive?.(run)
    run = await this.get(runId)
    if (run.status === 'paused') return run
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return run
    }
    return this.transitionRun(run, 'paused', command)
  }

  async resume(runId: string, command: GraphCommandContext): Promise<GraphRunV1> {
    return this.start(runId, command)
  }

  async cancel(
    runId: string,
    command: GraphCommandContext & { reason?: string }
  ): Promise<GraphRunV1> {
    let run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (run.status === 'cancelled') return this.notifyCancelled(run, command.reason)
    if (run.status === 'completed' || run.status === 'failed') {
      throw new GraphRunConflictError(`cannot cancel terminal GraphRun ${runId}`)
    }
    run = await this.fenceCancellation(run, command)
    await this.options.cancelActive?.(run)
    run = await this.get(runId)
    if (run.status === 'cancelled') return this.notifyCancelled(run, command.reason)
    if (run.status === 'completed' || run.status === 'failed') {
      throw new GraphRunConflictError(`cannot cancel terminal GraphRun ${runId}`)
    }
    run = await this.recordCleanup(
      run,
      await this.options.cleanupResources?.(run) ?? [],
      {
        commandId: `${command.commandId}_cleanup`,
        idempotencyKey: `${command.idempotencyKey}:cleanup`
      },
      true
    )
    let cancelled: GraphRunV1
    try {
      cancelled = await this.transitionRun(run, 'cancelled', command, command.reason)
    } catch (error) {
      if (!(error instanceof GraphRunConflictError) || command.expectedSeq !== undefined) throw error
      run = await this.get(runId)
      if (run.status === 'cancelled') return this.notifyCancelled(run, command.reason)
      if (run.status === 'completed' || run.status === 'failed') {
        throw new GraphRunConflictError(`cannot cancel terminal GraphRun ${runId}`)
      }
      cancelled = await this.transitionRun(run, 'cancelled', command, command.reason)
    }
    await this.options.onCancelled?.(cancelled, command.reason)
    return cancelled
  }

  async steer(
    runId: string,
    steeringInput: GraphSteeringV1,
    command: GraphCommandContext
  ): Promise<GraphRunV1> {
    const run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    const steering = GraphSteeringV1Schema.parse(steeringInput)
    if (steering.runId !== run.id) throw new GraphRunConflictError('steering run id mismatch')
    if (steering.status !== 'persisted') {
      throw new GraphRunConflictError('new steering must start in persisted state')
    }
    const target = steering.target
    if (target.kind === 'phase') {
      const phaseId = target.phaseId
      if (!run.plans.at(-1)!.phases.some((phase) => phase.id === phaseId)) {
        throw new GraphRunNotFoundError(`${runId}/phase/${phaseId}`)
      }
    }
    if (
      (target.kind === 'node' || target.kind === 'attempt') &&
      !run.nodes[target.nodeId]
    ) {
      throw new GraphRunNotFoundError(`${runId}/${target.nodeId}`)
    }
    if (target.kind === 'attempt') {
      const attemptId = target.attemptId
      if (!run.nodes[target.nodeId]!.attempts.some((attempt) =>
        attempt.id === attemptId)) {
        throw new GraphRunNotFoundError(
          `${runId}/${target.nodeId}/${attemptId}`
        )
      }
    }
    const appended = await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: { type: 'steering_recorded', payload: { steering } }
    })
    await this.options.onSteering?.(appended.state, steering)
    return appended.state
  }

  private async notifyCancelled(run: GraphRunV1, reason?: string): Promise<GraphRunV1> {
    await this.options.onCancelled?.(run, reason)
    return run
  }

  async retryNode(
    runId: string,
    nodeId: string,
    command: GraphCommandContext
  ): Promise<GraphRunV1> {
    const run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    const node = run.nodes[nodeId]
    if (!node) throw new GraphRunNotFoundError(`${runId}/${nodeId}`)
    if (!['failed', 'repair_required', 'cancelled', 'skipped', 'blocked'].includes(node.status)) {
      throw new GraphRunConflictError(`cannot retry node ${nodeId} from ${node.status}`)
    }
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: {
        type: 'node_status_changed',
        payload: { nodeId, from: node.status, to: 'ready', reason: 'authorized retry' }
      }
    })).state
  }

  async recordReview(
    runId: string,
    reviewInput: GraphReviewResultV1,
    command: GraphCommandContext,
    reviewerAuthority: 'human' | 'lead' | 'system' = 'human'
  ): Promise<GraphRunV1> {
    const run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (isTerminalRunStatus(run.status)) {
      throw new GraphRunConflictError(`cannot review terminal GraphRun ${runId}`)
    }
    const review = GraphReviewResultV1Schema.parse(reviewInput)
    const node = run.nodes[review.nodeId]
    if (!node) {
      throw new GraphRunNotFoundError(`${runId}/${review.nodeId}`)
    }
    const attempt = node.attempts.find((entry) => entry.id === review.attemptId)
    if (!attempt) {
      throw new GraphRunNotFoundError(`${runId}/${review.nodeId}/${review.attemptId}`)
    }
    if (node.attempts.at(-1)?.id !== attempt.id) {
      throw new GraphRunConflictError(`cannot review stale attempt ${attempt.id}`)
    }
    if (!['submitted', 'reviewing'].includes(node.status) ||
        !['submitted', 'reviewing'].includes(attempt.status) ||
        !attempt.result ||
        !attempt.validation) {
      throw new GraphRunConflictError(
        `attempt ${attempt.id} is not a submitted result awaiting review`
      )
    }
    const requiredKinds = effectiveReviewKinds(
      node,
      this.options.config(),
      run.plans.at(-1)!.completionNodeIds.includes(node.node.id)
    )
    if (!requiredKinds.includes(review.reviewerKind)) {
      throw new GraphRunConflictError(
        `${review.reviewerKind} review is not required for node ${node.node.id}`
      )
    }
    const allowedKind = reviewerAuthority === 'system'
      ? 'deterministic'
      : reviewerAuthority
    if (review.reviewerKind !== allowedKind) {
      throw new GraphRunConflictError(
        `${reviewerAuthority} authority cannot submit ${review.reviewerKind} review`
      )
    }
    if (
      review.reviewerInstanceId &&
      review.reviewerInstanceId === attempt.childThreadId
    ) {
      throw new GraphRunConflictError('a worker cannot independently review its own attempt')
    }
    const existing = run.reviews.find((entry) =>
      entry.nodeId === review.nodeId &&
      entry.attemptId === review.attemptId &&
      entry.reviewerKind === review.reviewerKind)
    if (existing) {
      if (existing.reviewId === review.reviewId && isDeepStrictEqual(existing, review)) return run
      throw new GraphRunConflictError(
        `${review.reviewerKind} review already exists for attempt ${attempt.id}`
      )
    }
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: { type: 'review_recorded', payload: { review } }
    })).state
  }

  async applyPatch(
    runId: string,
    patchInput: GraphPatchV1,
    command: GraphCommandContext
  ): Promise<GraphRunV1> {
    const run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (isTerminalRunStatus(run.status) ||
        run.status === 'completing' ||
        run.status === 'pausing') {
      throw new GraphRunConflictError(`cannot patch GraphRun ${runId} from ${run.status}`)
    }
    const patch = GraphPatchV1Schema.parse(patchInput)
    if (patch.runId !== run.id) throw new GraphRunConflictError('patch run id mismatch')
    if (patch.baseRevision !== run.currentRevision) {
      throw new GraphRunConflictError(
        `stale GraphPatch revision ${patch.baseRevision}; current is ${run.currentRevision}`
      )
    }
    const { plan, supersededNodeIds } = applyPatchToPlan(run, patch, this.nowIso())
    const validation = validateGraphPlan(plan, this.options.config())
    if (!validation.plan) throw new GraphPlanValidationError(validation.result)
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: plan.revision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: {
        type: 'plan_revised',
        payload: { patch, plan: validation.plan, supersededNodeIds }
      }
    })).state
  }

  async cleanup(runId: string, command: GraphCommandContext): Promise<GraphRunV1> {
    let run = await this.get(runId)
    this.assertCommandPreconditions(run, command)
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new GraphRunConflictError(`cannot clean up nonterminal GraphRun ${runId}`)
    }
    const resources = await this.options.cleanupResources?.(run) ?? []
    return this.options.store.snapshot((await this.recordCleanup(
      run,
      resources,
      command,
      true
    )).id)
  }

  private async recordCleanup(
    initialRun: GraphRunV1,
    resources: Array<Pick<
      GraphCleanupRecordV1,
      'resourceKind' | 'resourceId' | 'attemptId' | 'state' | 'lastError'
    >>,
    command: Pick<GraphCommandContext, 'commandId' | 'idempotencyKey'>,
    includeJournal: boolean
  ): Promise<GraphRunV1> {
    let run = initialRun
    const cleanupInputs = includeJournal
      ? [
          ...resources,
          {
            resourceKind: 'journal' as const,
            resourceId: run.id,
            state: 'completed' as const
          }
        ]
      : resources
    for (const [index, input] of cleanupInputs.entries()) {
      const alreadyRecorded = run.cleanup.some((entry) =>
        entry.resourceKind === input.resourceKind &&
        entry.resourceId === input.resourceId &&
        entry.state === input.state
      )
      if (alreadyRecorded) continue
      const cleanup: GraphCleanupRecordV1 = {
        version: GRAPH_CONTRACT_VERSION,
        id: this.nextId('graph_cleanup'),
        runId: run.id,
        ...input,
        retryCount: 0,
        updatedAt: this.nowIso()
      }
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `${command.commandId}_${index}`,
        idempotencyKey: `${command.idempotencyKey}:${input.resourceKind}:${input.resourceId}`,
        event: { type: 'cleanup_updated', payload: { cleanup } }
      })).state
    }
    return run
  }

  private async ensureReady(
    initial: GraphRunV1,
    command: Pick<GraphCommandContext, 'commandId' | 'idempotencyKey'>
  ): Promise<GraphRunV1> {
    let run = initial
    if (run.status === 'draft') {
      run = await this.transitionRun(run, 'validating', {
        ...command,
        commandId: `${command.commandId}_validating`,
        idempotencyKey: `${command.idempotencyKey}:validating`
      })
    }
    if (run.status === 'validating') {
      const validation = validateGraphPlan(run.plans.at(-1)!, this.options.config())
      if (!validation.result.valid) throw new GraphPlanValidationError(validation.result)
      run = (await this.options.store.append(run.id, {
        expectedSeq: run.lastEventSeq,
        graphRevision: run.currentRevision,
        commandId: `${command.commandId}_validated`,
        idempotencyKey: `${command.idempotencyKey}:validated`,
        event: {
          type: 'plan_validated',
          payload: { revision: run.currentRevision, validation: validation.result }
        }
      })).state
      run = await this.transitionRun(run, 'ready', {
        ...command,
        commandId: `${command.commandId}_ready`,
        idempotencyKey: `${command.idempotencyKey}:ready`
      })
    }
    return run
  }

  private async transitionRun(
    run: GraphRunV1,
    to: GraphRunStatus,
    command: Pick<GraphCommandContext, 'commandId' | 'idempotencyKey'>,
    reason?: string
  ): Promise<GraphRunV1> {
    return (await this.options.store.append(run.id, {
      expectedSeq: run.lastEventSeq,
      graphRevision: run.currentRevision,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      event: {
        type: 'run_status_changed',
        payload: { from: run.status, to, ...(reason ? { reason } : {}) }
      }
    })).state
  }

  private async fenceCancellation(
    initialRun: GraphRunV1,
    command: GraphCommandContext
  ): Promise<GraphRunV1> {
    let run = initialRun
    while (run.status === 'running') {
      try {
        return await this.transitionRun(run, 'pausing', {
          commandId: `${command.commandId}_fence`,
          idempotencyKey: `${command.idempotencyKey}:fence`
        }, 'cancellation dispatch fence')
      } catch (error) {
        if (!(error instanceof GraphRunConflictError) ||
            command.expectedSeq !== undefined ||
            command.expectedRevision !== undefined) {
          throw error
        }
        run = await this.get(run.id)
      }
    }
    if (run.status === 'completed' || run.status === 'failed') {
      throw new GraphRunConflictError(`cannot cancel terminal GraphRun ${run.id}`)
    }
    return run
  }

  private assertCommandPreconditions(run: GraphRunV1, command: GraphCommandContext): void {
    if (command.expectedSeq !== undefined && command.expectedSeq !== run.lastEventSeq) {
      throw new GraphRunConflictError(
        `stale GraphRun sequence ${command.expectedSeq}; current is ${run.lastEventSeq}`
      )
    }
    if (
      command.expectedRevision !== undefined &&
      command.expectedRevision !== run.currentRevision
    ) {
      throw new GraphRunConflictError(
        `stale GraphRun revision ${command.expectedRevision}; current is ${run.currentRevision}`
      )
    }
  }

  private assertGraphCreationEnabled(): void {
    if (!this.options.config().enabled) {
      throw new GraphRunConflictError(
        'Graph Mode is disabled; existing durable runs remain inspectable and cancellable'
      )
    }
  }
}

export function applyPatchToPlan(
  run: GraphRunV1,
  patch: GraphPatchV1,
  createdAt: string
): { plan: GraphPlanV1; supersededNodeIds: string[] } {
  const current = run.plans.at(-1)
  if (!current) throw new GraphRunConflictError('GraphRun has no current plan')
  const next = structuredClone(current)
  const supersededNodeIds: string[] = []
  for (const operation of patch.operations) {
    switch (operation.op) {
      case 'add_node':
        if (next.nodes.some((node) => node.id === operation.node.id)) {
          throw new GraphRunConflictError(`duplicate patched node ${operation.node.id}`)
        }
        next.nodes.push(operation.node)
        break
      case 'replace_node': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId)
        if (index < 0) throw new GraphRunNotFoundError(`${run.id}/${operation.nodeId}`)
        const projection = run.nodes[operation.nodeId]
        if (projection?.status === 'accepted') {
          if (!operation.supersedesAcceptedWork || operation.replacement.id === operation.nodeId) {
            throw new GraphRunConflictError(
              `accepted node ${operation.nodeId} requires a distinct superseding node`
            )
          }
          if (next.nodes.some((node) => node.id === operation.replacement.id)) {
            throw new GraphRunConflictError(`duplicate superseding node ${operation.replacement.id}`)
          }
          next.nodes.push(operation.replacement)
          supersededNodeIds.push(operation.nodeId)
        } else {
          assertNodeNotActive(projection, 'replace')
          if (operation.replacement.id !== operation.nodeId) {
            throw new GraphRunConflictError(
              `in-place replacement for ${operation.nodeId} must preserve its node id`
            )
          }
          next.nodes[index] = operation.replacement
        }
        break
      }
      case 'rebind_node': {
        const node = next.nodes.find((entry) => entry.id === operation.nodeId)
        if (!node) throw new GraphRunNotFoundError(`${run.id}/${operation.nodeId}`)
        const projection = run.nodes[operation.nodeId]
        if (projection && !['pending', 'blocked', 'ready', 'failed', 'repair_required'].includes(projection.status)) {
          throw new GraphRunConflictError(`cannot rebind node ${operation.nodeId} from ${projection.status}`)
        }
        node.assignment = operation.assignment
        break
      }
      case 'add_edge':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) {
          throw new GraphRunConflictError(`duplicate patched edge ${operation.edge.id}`)
        }
        assertNodeNotActive(run.nodes[operation.edge.from], 'add an edge from')
        assertNodeNotActive(run.nodes[operation.edge.to], 'add an edge to')
        next.edges.push(operation.edge)
        break
      case 'remove_edge': {
        const edge = next.edges.find((entry) => entry.id === operation.edgeId)
        if (!edge) {
          throw new GraphRunNotFoundError(`${run.id}/${operation.edgeId}`)
        }
        assertNodeNotActive(run.nodes[edge.from], 'remove an edge from')
        assertNodeNotActive(run.nodes[edge.to], 'remove an edge to')
        next.edges = next.edges.filter((edge) => edge.id !== operation.edgeId)
        break
      }
      case 'update_budget':
        assertBudgetNotBelowUsage(run, operation.budget)
        next.budget = operation.budget
        break
      case 'update_review': {
        const node = next.nodes.find((entry) => entry.id === operation.nodeId)
        if (!node) throw new GraphRunNotFoundError(`${run.id}/${operation.nodeId}`)
        const projection = run.nodes[operation.nodeId]
        assertNodeNotActive(projection, 'change review policy for')
        if (projection?.status === 'accepted' || projection?.status === 'superseded') {
          throw new GraphRunConflictError(
            `cannot change review policy for ${projection.status} node ${operation.nodeId}`
          )
        }
        node.completion.review = operation.review
        break
      }
    }
  }
  next.revision = current.revision + 1
  next.createdAt = createdAt
  return { plan: next, supersededNodeIds }
}

const ACTIVE_PATCH_NODE_STATUSES = new Set([
  'queued',
  'running',
  'submitted',
  'reviewing'
])

function assertNodeNotActive(
  projection: GraphRunV1['nodes'][string] | undefined,
  action: string
): void {
  if (projection && ACTIVE_PATCH_NODE_STATUSES.has(projection.status)) {
    throw new GraphRunConflictError(
      `cannot ${action} active node ${projection.node.id} from ${projection.status}`
    )
  }
}

function assertBudgetNotBelowUsage(
  run: GraphRunV1,
  budget: GraphPlanV1['budget']
): void {
  const activeNodes = Object.values(run.nodes).filter((node) =>
    node.status === 'queued' || node.status === 'running').length
  const maximumAttempts = Math.max(
    0,
    ...Object.values(run.nodes).map((node) => node.attempts.length)
  )
  const activeNodeWallTime = Math.max(0, ...Object.values(run.nodes)
    .flatMap((node) => node.attempts)
    .filter((attempt) => ['queued', 'running', 'waiting'].includes(attempt.status))
    .map((attempt) => attempt.assignment.maxWallTimeMs))
  const minimums: Array<[keyof GraphPlanV1['budget'], number]> = [
    ['maxNodes', run.plans.at(-1)!.nodes.length],
    ['maxEdges', run.plans.at(-1)!.edges.length],
    ['maxConcurrentNodes', activeNodes],
    ['maxAttemptsPerNode', maximumAttempts],
    ['maxRevisions', run.budget.revisions + 1],
    ['maxLoopIterations', run.budget.loopIterations],
    ['maxWallTimeMs', run.budget.elapsedMs],
    ['maxNodeWallTimeMs', activeNodeWallTime],
    ['maxMessages', run.budget.messages],
    ['maxArtifactBytes', run.budget.artifactBytes]
  ]
  for (const [field, minimum] of minimums) {
    if (budget[field] < minimum) {
      throw new GraphRunConflictError(
        `cannot reduce ${field} below already consumed value ${minimum}`
      )
    }
  }
}
