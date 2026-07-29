import type {
  GraphNodeProjectionV1,
  GraphPlanV1,
  GraphRunV1
} from '../contracts/graph.js'

const ACTIVE_GATE_STATUSES = new Set(['pending', 'blocked', 'ready'])
const LOOP_GATE_CONDITION_OUTCOMES = new Set([
  'accepted',
  'repair_required',
  'failed',
  'skipped'
])

export const LOOP_GATE_EXIT_REASON = 'loop gate evaluated'
export const LOOP_GATE_EXHAUSTED_REASON = 'loop gate iteration limit exhausted'

export function loopUnselectedBranchReason(gateNodeId: string): string {
  return `LoopGate ${gateNodeId} branch not selected`
}

export function loopSelectedBranchReason(gateNodeId: string): string {
  return `LoopGate ${gateNodeId} branch selected`
}

export function outcomeOf(node: GraphNodeProjectionV1):
  'accepted' | 'repair_required' | 'failed' | 'cancelled' | 'skipped' | undefined {
  if (node.status === 'accepted' || node.status === 'superseded') return 'accepted'
  if (node.status === 'repair_required') return 'repair_required'
  if (node.status === 'failed') return 'failed'
  if (node.status === 'cancelled') return 'cancelled'
  if (node.status === 'skipped') return 'skipped'
  return undefined
}

/**
 * Preserve an explicit condition outcome until its active LoopGate chooses a
 * branch. Automatic retry or required-failure handling must not erase it.
 */
export function loopGateHandlesNodeOutcome(
  run: GraphRunV1,
  sourceNodeId: string
): boolean {
  const source = run.nodes[sourceNodeId]
  const outcome = source ? outcomeOf(source) : undefined
  if (!source || !outcome || !LOOP_GATE_CONDITION_OUTCOMES.has(outcome)) return false
  return Object.values(run.nodes).some((projection) => {
    const gate = projection.node.loopGate
    return projection.node.kind === 'loop_gate' &&
      gate?.condition.sourceNodeId === sourceNodeId &&
      projection.loopIteration === source.loopIteration &&
      ACTIVE_GATE_STATUSES.has(projection.status)
  })
}

/** Keep unchosen exit/exhaustion targets recoverable until the gate decides. */
export function loopGateControlsBranchTarget(
  run: GraphRunV1,
  targetNodeId: string
): boolean {
  return Object.values(run.nodes).some((projection) => {
    const gate = projection.node.loopGate
    return projection.node.kind === 'loop_gate' &&
      ACTIVE_GATE_STATUSES.has(projection.status) &&
      (
        gate?.exitTargetNodeId === targetNodeId ||
        gate?.exhaustionTargetNodeId === targetNodeId
      )
  })
}

/**
 * A LoopGate explicitly consumes its condition's terminal outcome. It also
 * owns the skipped state of the branch that it did not select. These are
 * successful control-flow decisions, not required-work failures.
 */
export function loopGateWaivesIncompleteNode(
  run: GraphRunV1,
  nodeId: string
): boolean {
  const node = run.nodes[nodeId]
  if (!node) return false
  return Object.values(run.nodes).some((projection) => {
    const gate = projection.node.loopGate
    if (projection.node.kind !== 'loop_gate' || !gate) return false
    const decided =
      projection.status === 'skipped' &&
      (
        projection.lastTransitionReason === LOOP_GATE_EXIT_REASON ||
        projection.lastTransitionReason === LOOP_GATE_EXHAUSTED_REASON
      )
    const conditionOutcome = outcomeOf(node)
    const consumedCondition =
      decided &&
      gate.condition.sourceNodeId === nodeId &&
      projection.loopIteration === node.loopIteration &&
      conditionOutcome !== undefined &&
      LOOP_GATE_CONDITION_OUTCOMES.has(conditionOutcome)
    const unselectedBranch =
      node.status === 'skipped' &&
      node.lastTransitionReason === loopUnselectedBranchReason(projection.node.id) &&
      (
        gate.exitTargetNodeId === nodeId ||
        gate.exhaustionTargetNodeId === nodeId
      )
    return consumedCondition || unselectedBranch
  })
}

export function loopResetNodeIds(
  plan: GraphPlanV1,
  gateNodeId: string,
  continueTargetNodeId: string,
  conditionSourceNodeId: string
): string[] {
  const outgoing = new Map(plan.nodes.map((node) => [node.id, [] as string[]]))
  const incoming = new Map(plan.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of plan.edges) {
    if (edge.kind === 'message') continue
    outgoing.get(edge.from)?.push(edge.to)
    incoming.get(edge.to)?.push(edge.from)
  }
  const forward = reachableNodeIds(continueTargetNodeId, outgoing)
  const reachesGate = reachableNodeIds(gateNodeId, incoming)
  const reset = new Set([...forward].filter((nodeId) => reachesGate.has(nodeId)))
  const gate = plan.nodes.find((node) => node.id === gateNodeId)?.loopGate
  reset.add(continueTargetNodeId)
  reset.add(conditionSourceNodeId)
  reset.add(gateNodeId)
  if (gate) {
    reset.add(gate.exitTargetNodeId)
    if (gate.exhaustionTargetNodeId) reset.add(gate.exhaustionTargetNodeId)
  }
  return plan.nodes.map((node) => node.id).filter((nodeId) => reset.has(nodeId))
}

export function isLoopSchedulerEdge(
  run: GraphRunV1,
  fromNodeId: string,
  toNodeId: string
): boolean {
  const source = run.nodes[fromNodeId]?.node
  return source?.kind === 'loop_gate' &&
    (
      source.loopGate?.continueTargetNodeId === toNodeId ||
      source.loopGate?.exitTargetNodeId === toNodeId ||
      source.loopGate?.exhaustionTargetNodeId === toNodeId
    )
}

function reachableNodeIds(
  start: string,
  edges: ReadonlyMap<string, readonly string[]>
): Set<string> {
  const reached = new Set<string>()
  const pending = [start]
  while (pending.length) {
    const nodeId = pending.pop()!
    if (reached.has(nodeId)) continue
    reached.add(nodeId)
    for (const target of edges.get(nodeId) ?? []) pending.push(target)
  }
  return reached
}
