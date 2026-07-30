import type { GraphRunV1 } from '../../contracts/index.js'
import type { GraphRuntimeConfig } from '../../config/kun-config.js'
import {
  currentIterationAttemptCount,
  dependencyDecision,
  effectiveNodeMaxAttempts,
  isTerminalRunStatus
} from '../../graph/graph-scheduler-policy.js'

const MAX_CONTROL_SNAPSHOT_NODES = 50
const MAX_CONTROL_FAILURE_CHARS = 256
const MAX_CONTROL_SUMMARY_CHARS = 512

export function graphControlSnapshot(
  run: GraphRunV1,
  config?: GraphRuntimeConfig
): Record<string, unknown> {
  const plan = run.plans.at(-1)!
  const orderedNodeIds = plan.nodes.map((node) => node.id)
  const completionNodeIds = new Set(plan.completionNodeIds)
  const decisions = new Map(orderedNodeIds.map((nodeId) => {
    const projection = run.nodes[nodeId]
    if (!projection) return [nodeId, {
      effectiveMaxAttempts: 0,
      attemptsRemaining: 0,
      canRetry: false,
      canSupersede: false
    }] as const
    const effectiveMaxAttempts = effectiveNodeMaxAttempts(run, projection, config)
    const currentAttempts = currentIterationAttemptCount(projection)
    const attemptsRemaining = Math.max(
      0,
      effectiveMaxAttempts - currentAttempts
    )
    const incoming = plan.edges.filter((edge) =>
      edge.to === nodeId && edge.kind !== 'message')
    const mutableRun =
      !isTerminalRunStatus(run.status) &&
      run.status !== 'completing' &&
      run.status !== 'pausing'
    const canRetry =
      mutableRun &&
      ['failed', 'repair_required', 'cancelled', 'skipped'].includes(
        projection.status
      ) &&
      attemptsRemaining > 0 &&
      dependencyDecision(run, incoming) === 'ready'
    const canSupersede =
      mutableRun &&
      ['failed', 'repair_required'].includes(projection.status) &&
      attemptsRemaining === 0 &&
      projection.node.kind !== 'loop_gate' &&
      (projection.node.required || completionNodeIds.has(nodeId)) &&
      canRedirectSupersededNode(run, nodeId)
    return [nodeId, {
      effectiveMaxAttempts,
      attemptsRemaining,
      canRetry,
      canSupersede
    }] as const
  }))
  const nodeStatusCounts: Record<string, number> = {}
  for (const node of Object.values(run.nodes)) {
    nodeStatusCounts[node.status] = (nodeStatusCounts[node.status] ?? 0) + 1
  }
  const allLiveNodeIds = orderedNodeIds.filter((nodeId) =>
    ['queued', 'running'].includes(run.nodes[nodeId]?.status ?? 'missing'))
  const allAwaitingReviewNodeIds = orderedNodeIds.filter((nodeId) =>
    ['submitted', 'reviewing'].includes(run.nodes[nodeId]?.status ?? 'missing'))
  const allRepairableNodeIds = orderedNodeIds.filter((nodeId) =>
    ['repair_required', 'failed', 'cancelled', 'skipped'].includes(
      run.nodes[nodeId]?.status ?? 'missing'
    ))
  const liveNodeIds = allLiveNodeIds.slice(0, MAX_CONTROL_SNAPSHOT_NODES)
  const awaitingReviewNodeIds = allAwaitingReviewNodeIds.slice(
    0,
    MAX_CONTROL_SNAPSHOT_NODES
  )
  const repairableNodeIds = allRepairableNodeIds.slice(
    0,
    MAX_CONTROL_SNAPSHOT_NODES
  )
  const selectedNodeIds = orderedNodeIds.slice(0, MAX_CONTROL_SNAPSHOT_NODES)
  const nodes = selectedNodeIds.map((nodeId) => {
    const projection = run.nodes[nodeId]
    const attempt = projection?.attempts.at(-1)
    return {
      nodeId,
      title: boundedControlText(projection?.node.title ?? nodeId, 256),
      kind: projection?.node.kind ?? 'missing',
      status: projection?.status ?? 'missing',
      attemptCount: projection?.attempts.length ?? 0,
      currentIterationAttemptCount: projection
        ? currentIterationAttemptCount(projection)
        : 0,
      effectiveMaxAttempts: decisions.get(nodeId)?.effectiveMaxAttempts ?? 0,
      attemptsRemaining: decisions.get(nodeId)?.attemptsRemaining ?? 0,
      canRetry: decisions.get(nodeId)?.canRetry ?? false,
      canSupersede: decisions.get(nodeId)?.canSupersede ?? false,
      acceptedAttemptId: projection?.acceptedAttemptId ?? null,
      supersededByNodeId: projection?.supersededByNodeId ?? null,
      lastAttempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            attemptNumber: attempt.attemptNumber,
            childThreadId: attempt.childThreadId ?? null,
            normalizedFailure: boundedControlText(
              attempt.normalizedFailure,
              MAX_CONTROL_FAILURE_CHARS
            ),
            resultSummary: boundedControlText(
              attempt.result?.summary,
              MAX_CONTROL_SUMMARY_CHARS
            ),
            validation: attempt.validation
              ? {
                  valid: attempt.validation.valid,
                  issueCount: attempt.validation.issues.length,
                  issues: attempt.validation.issues.slice(0, 2).map((issue) => ({
                    code: issue.code,
                    path: issue.path.map((segment) =>
                      typeof segment === 'string'
                        ? boundedControlText(segment, 128)
                        : segment),
                    severity: issue.severity,
                    message: boundedControlText(issue.message, MAX_CONTROL_FAILURE_CHARS)
                  }))
                }
              : null
          }
        : null
    }
  })
  const allRetryableNodeIds = orderedNodeIds.filter((nodeId) =>
    decisions.get(nodeId)?.canRetry === true)
  const allSupersedableNodeIds = orderedNodeIds.filter((nodeId) =>
    decisions.get(nodeId)?.canSupersede === true)
  const recommendedActions: string[] = []
  if (allAwaitingReviewNodeIds.length) {
    recommendedActions.push(
      'Review submitted nodes with graph_review_node; only Lead acceptance unlocks downstream work.'
    )
  }
  if (allRetryableNodeIds.length) {
    recommendedActions.push(
      `Retry only nodes with canRetry=true: ${allRetryableNodeIds
        .slice(0, MAX_CONTROL_SNAPSHOT_NODES).join(', ')}.`
    )
  }
  if (allSupersedableNodeIds.length) {
    recommendedActions.push(
      `Use graph_patch_run supersede_node for exhausted nodes with canSupersede=true: ` +
      `${allSupersedableNodeIds.slice(0, MAX_CONTROL_SNAPSHOT_NODES).join(', ')}.`
    )
  }
  if (
    !allLiveNodeIds.length &&
    !allAwaitingReviewNodeIds.length &&
    allRepairableNodeIds.length
  ) {
    recommendedActions.push(
      'No worker is active. Repair or supersede a failed node now; do not poll this unchanged snapshot.'
    )
  }
  if (!recommendedActions.length && allLiveNodeIds.length) {
    recommendedActions.push(
      'Use graph_supervise_node overview/wait for live progress; avoid repeatedly polling this control snapshot.'
    )
  }
  return {
    runId: run.id,
    status: run.status,
    currentRevision: run.currentRevision,
    lastEventSeq: run.lastEventSeq,
    updatedAt: run.updatedAt,
    plan: {
      title: plan.title,
      strategy: plan.strategy?.kind ?? null,
      nodeCount: orderedNodeIds.length,
      edgeCount: plan.edges.length,
      completionNodeIds: plan.completionNodeIds.slice(0, MAX_CONTROL_SNAPSHOT_NODES),
      omittedCompletionNodeCount: Math.max(
        0,
        plan.completionNodeIds.length - MAX_CONTROL_SNAPSHOT_NODES
      )
    },
    nodeStatusCounts,
    liveNodeIds,
    liveNodeCount: allLiveNodeIds.length,
    awaitingReviewNodeIds,
    awaitingReviewNodeCount: allAwaitingReviewNodeIds.length,
    repairableNodeIds,
    repairableNodeCount: allRepairableNodeIds.length,
    nodes,
    page: {
      returnedNodeCount: nodes.length,
      omittedNodeCount: Math.max(0, orderedNodeIds.length - nodes.length)
    },
    budget: {
      totalTokens: run.budget.totalTokens,
      elapsedMs: run.budget.elapsedMs,
      artifactBytes: run.budget.artifactBytes,
      messages: run.budget.messages,
      attempts: run.budget.attempts,
      revisions: run.budget.revisions
    },
    recommendedActions
  }
}

function boundedControlText(value: string | undefined, limit: number): string | null {
  if (!value) return null
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}

function canRedirectSupersededNode(run: GraphRunV1, nodeId: string): boolean {
  const plan = run.plans.at(-1)!
  const affectedNodeIds = new Set(
    plan.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to)
  )
  for (const node of plan.nodes) {
    const gate = node.loopGate
    if (!gate) continue
    if (
      gate.condition.sourceNodeId === nodeId ||
      gate.continueTargetNodeId === nodeId ||
      gate.exitTargetNodeId === nodeId ||
      gate.exhaustionTargetNodeId === nodeId
    ) {
      affectedNodeIds.add(node.id)
    }
  }
  affectedNodeIds.delete(nodeId)
  return [...affectedNodeIds].every((affectedNodeId) => {
    const status = run.nodes[affectedNodeId]?.status
    return !status || ['pending', 'blocked', 'ready'].includes(status)
  })
}
