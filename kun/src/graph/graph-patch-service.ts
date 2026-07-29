import type {
  GraphPatchV1,
  GraphPlanV1,
  GraphRunV1
} from '../contracts/graph.js'
import {
  GraphRunConflictError,
  GraphRunNotFoundError
} from './graph-run-store.js'

export function applyPatchToPlan(
  run: GraphRunV1,
  patch: GraphPatchV1,
  createdAt: string
): { plan: GraphPlanV1; supersededNodeIds: string[] } {
  const current = run.plans.at(-1)
  if (!current) throw new GraphRunConflictError('GraphRun has no current plan')
  const next = structuredClone(current)
  const supersededNodeIds: string[] = []
  const replacedNodeIds = new Set<string>()
  for (const operation of patch.operations) {
    switch (operation.op) {
      case 'add_node':
        if (next.nodes.some((node) => node.id === operation.node.id)) {
          throw new GraphRunConflictError(`duplicate patched node ${operation.node.id}`)
        }
        next.nodes.push(operation.node)
        break
      case 'replace_node': {
        if (replacedNodeIds.has(operation.nodeId)) {
          throw new GraphRunConflictError(
            `patch replaces node more than once: ${operation.nodeId}`
          )
        }
        replacedNodeIds.add(operation.nodeId)
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId)
        if (index < 0) throw new GraphRunNotFoundError(`${run.id}/${operation.nodeId}`)
        const projection = run.nodes[operation.nodeId]
        if (projection?.status === 'accepted') {
          if (!operation.supersedesAcceptedWork || operation.replacement.id === operation.nodeId) {
            throw new GraphRunConflictError(
              `accepted node ${operation.nodeId} requires a distinct superseding node`
            )
          }
          assertNewReplacement(next, operation.replacement.id)
          assertSupersessionCanRedirect(run, next, operation.nodeId)
          next.nodes.push(operation.replacement)
          redirectTerminalNodeRole(next, operation.nodeId, operation.replacement.id)
          supersededNodeIds.push(operation.nodeId)
        } else if (operation.replacement.id !== operation.nodeId) {
          if (
            !projection ||
            !['failed', 'repair_required', 'cancelled', 'skipped'].includes(projection.status)
          ) {
            throw new GraphRunConflictError(
              `distinct replacement for ${operation.nodeId} requires terminal exhausted work`
            )
          }
          assertNewReplacement(next, operation.replacement.id)
          assertSupersessionCanRedirect(run, next, operation.nodeId)
          next.nodes.push(operation.replacement)
          redirectTerminalNodeRole(next, operation.nodeId, operation.replacement.id)
          supersededNodeIds.push(operation.nodeId)
        } else {
          assertNodeNotActive(projection, 'replace')
          next.nodes[index] = operation.replacement
        }
        break
      }
      case 'rebind_node': {
        const node = next.nodes.find((entry) => entry.id === operation.nodeId)
        if (!node) throw new GraphRunNotFoundError(`${run.id}/${operation.nodeId}`)
        const projection = run.nodes[operation.nodeId]
        if (
          projection &&
          !['pending', 'blocked', 'ready', 'failed', 'repair_required'].includes(
            projection.status
          )
        ) {
          throw new GraphRunConflictError(
            `cannot rebind node ${operation.nodeId} from ${projection.status}`
          )
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
        if (!edge) throw new GraphRunNotFoundError(`${run.id}/${operation.edgeId}`)
        assertNodeNotActive(run.nodes[edge.from], 'remove an edge from')
        assertNodeNotActive(run.nodes[edge.to], 'remove an edge to')
        next.edges = next.edges.filter((candidate) => candidate.id !== operation.edgeId)
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

function assertNewReplacement(plan: GraphPlanV1, replacementNodeId: string): void {
  if (plan.nodes.some((node) => node.id === replacementNodeId)) {
    throw new GraphRunConflictError(`duplicate superseding node ${replacementNodeId}`)
  }
}

function redirectTerminalNodeRole(
  plan: GraphPlanV1,
  previousNodeId: string,
  replacementNodeId: string
): void {
  plan.edges = plan.edges.map((edge) => ({
    ...edge,
    from: edge.from === previousNodeId ? replacementNodeId : edge.from,
    to: edge.to === previousNodeId ? replacementNodeId : edge.to
  }))
  plan.completionNodeIds = plan.completionNodeIds.map((nodeId) =>
    nodeId === previousNodeId ? replacementNodeId : nodeId)
  plan.nodes = plan.nodes.map((node) => {
    if (!node.loopGate) return node
    return {
      ...node,
      loopGate: {
        ...node.loopGate,
        condition: {
          ...node.loopGate.condition,
          sourceNodeId:
            node.loopGate.condition.sourceNodeId === previousNodeId
              ? replacementNodeId
              : node.loopGate.condition.sourceNodeId
        },
        continueTargetNodeId:
          node.loopGate.continueTargetNodeId === previousNodeId
            ? replacementNodeId
            : node.loopGate.continueTargetNodeId,
        exitTargetNodeId:
          node.loopGate.exitTargetNodeId === previousNodeId
            ? replacementNodeId
            : node.loopGate.exitTargetNodeId,
        ...(node.loopGate.exhaustionTargetNodeId
          ? {
              exhaustionTargetNodeId:
                node.loopGate.exhaustionTargetNodeId === previousNodeId
                  ? replacementNodeId
                  : node.loopGate.exhaustionTargetNodeId
            }
          : {})
      }
    }
  })
}

function assertSupersessionCanRedirect(
  run: GraphRunV1,
  plan: GraphPlanV1,
  previousNodeId: string
): void {
  const affectedNodeIds = new Set(
    plan.edges
      .filter((edge) => edge.from === previousNodeId)
      .map((edge) => edge.to)
  )
  for (const node of plan.nodes) {
    const gate = node.loopGate
    if (!gate) continue
    if (
      gate.condition.sourceNodeId === previousNodeId ||
      gate.continueTargetNodeId === previousNodeId ||
      gate.exitTargetNodeId === previousNodeId ||
      gate.exhaustionTargetNodeId === previousNodeId
    ) {
      affectedNodeIds.add(node.id)
    }
  }
  affectedNodeIds.delete(previousNodeId)
  for (const nodeId of affectedNodeIds) {
    const status = run.nodes[nodeId]?.status
    if (status && !['pending', 'blocked', 'ready'].includes(status)) {
      throw new GraphRunConflictError(
        `cannot supersede ${previousNodeId} after affected node ${nodeId} reached ${status}`
      )
    }
  }
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
