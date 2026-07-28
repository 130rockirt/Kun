import type { GraphRuntimeConfig } from '../config/kun-config.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphPlanV1Schema,
  GraphValidationResultV1Schema,
  type GraphEdgeV1,
  type GraphPlanV1,
  type GraphValidationIssueV1,
  type GraphValidationResultV1
} from '../contracts/graph.js'
import { graphAllowsLoops } from './graph-rollout-policy.js'

export type GraphPlanValidation = {
  result: GraphValidationResultV1
  plan?: GraphPlanV1
}

export class GraphPlanValidationError extends Error {
  readonly result: GraphValidationResultV1

  constructor(result: GraphValidationResultV1) {
    super(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '))
    this.name = 'GraphPlanValidationError'
    this.result = result
  }
}

export function parseAndValidateGraphPlan(
  input: unknown,
  config: GraphRuntimeConfig
): GraphPlanValidation {
  const parsed = GraphPlanV1Schema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 512).map((issue): GraphValidationIssueV1 => ({
      code: 'schema_invalid',
      path: issue.path.filter((part): part is string | number =>
        typeof part === 'string' || typeof part === 'number'),
      message: issue.message.slice(0, 2_048),
      severity: 'error'
    }))
    return {
      result: GraphValidationResultV1Schema.parse({
        version: GRAPH_CONTRACT_VERSION,
        valid: false,
        issues,
        normalizedNodeCount: 0,
        normalizedEdgeCount: 0
      })
    }
  }
  return validateGraphPlan(parsed.data, config)
}

export function validateGraphPlan(
  plan: GraphPlanV1,
  config: GraphRuntimeConfig
): GraphPlanValidation {
  const issues: GraphValidationIssueV1[] = []
  const error = (
    code: string,
    path: Array<string | number>,
    message: string
  ): void => {
    if (issues.length >= 512) return
    issues.push({ code, path, message: message.slice(0, 2_048), severity: 'error' })
  }

  if (!config.enabled) {
    error('graph_disabled', [], 'Graph Mode is disabled by host configuration')
  }
  if (plan.nodes.length > config.scheduler.maxNodes) {
    error(
      'node_limit_exceeded',
      ['nodes'],
      `plan has ${plan.nodes.length} nodes; host limit is ${config.scheduler.maxNodes}`
    )
  }
  if (plan.edges.length > config.scheduler.maxEdges) {
    error(
      'edge_limit_exceeded',
      ['edges'],
      `plan has ${plan.edges.length} edges; host limit is ${config.scheduler.maxEdges}`
    )
  }

  validateUnique(plan.phases, 'id', 'phase', error)
  validateUnique(plan.nodes, 'id', 'node', error)
  validateUnique(plan.edges, 'id', 'edge', error)

  const phaseIds = new Set(plan.phases.map((phase) => phase.id))
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]))
  const schedulingEdges = plan.edges.filter(isSchedulingEdge)
  for (const [index, node] of plan.nodes.entries()) {
    if (!phaseIds.has(node.phaseId)) {
      error(
        'missing_phase',
        ['nodes', index, 'phaseId'],
        `node ${node.id} references missing phase ${node.phaseId}`
      )
    }
    if (node.maxAttempts !== undefined && node.maxAttempts > config.scheduler.maxAttemptsPerNode) {
      error(
        'attempt_limit_exceeded',
        ['nodes', index, 'maxAttempts'],
        `node ${node.id} exceeds the host attempt limit`
      )
    }
    if (node.timeoutMs !== undefined && node.timeoutMs > config.scheduler.maxNodeWallTimeMs) {
      error(
        'node_time_limit_exceeded',
        ['nodes', index, 'timeoutMs'],
        `node ${node.id} exceeds the host node wall-time limit`
      )
    }
  }

  for (const [index, edge] of plan.edges.entries()) {
    if (!nodes.has(edge.from)) {
      error('missing_edge_source', ['edges', index, 'from'], `edge ${edge.id} has missing source ${edge.from}`)
    }
    if (!nodes.has(edge.to)) {
      error('missing_edge_target', ['edges', index, 'to'], `edge ${edge.id} has missing target ${edge.to}`)
    }
  }

  validateBudget(plan, config, error)

  const completionIds = new Set<string>()
  for (const [index, nodeId] of plan.completionNodeIds.entries()) {
    if (completionIds.has(nodeId)) {
      error('duplicate_completion_node', ['completionNodeIds', index], `duplicate completion node ${nodeId}`)
    }
    completionIds.add(nodeId)
    if (!nodes.has(nodeId)) {
      error('missing_completion_node', ['completionNodeIds', index], `missing completion node ${nodeId}`)
    }
    if (schedulingEdges.some((edge) => edge.from === nodeId)) {
      error(
        'completion_node_not_terminal',
        ['completionNodeIds', index],
        `completion node ${nodeId} has an outgoing scheduling edge`
      )
    }
  }

  const validSchedulingEdges = schedulingEdges.filter((edge) =>
    nodes.has(edge.from) && nodes.has(edge.to))
  const incoming = new Map(plan.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(plan.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of validSchedulingEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const entries = plan.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id)
  if (entries.length === 0) {
    error('missing_entry_node', ['nodes'], 'graph must have at least one scheduling entry node')
  }
  const reachable = reachableFrom(entries, outgoing)
  for (const [index, node] of plan.nodes.entries()) {
    if (node.required && !reachable.has(node.id)) {
      error('unreachable_required_node', ['nodes', index], `required node ${node.id} is unreachable`)
    }
  }

  const loopContinuationEdgeIds = new Set<string>()
  for (const [nodeIndex, node] of plan.nodes.entries()) {
    if (node.kind !== 'loop_gate' || !node.loopGate) continue
    const gate = node.loopGate
    if (!graphAllowsLoops(config)) {
      error(
        'rollout_loop_not_enabled',
        ['nodes', nodeIndex, 'loopGate'],
        `bounded loops require beta rollout or later; current stage is ${config.rolloutStage}`
      )
    }
    if (gate.maxIterations > plan.budget.maxLoopIterations ||
      gate.maxIterations > config.scheduler.maxLoopIterations) {
      error(
        'loop_limit_exceeded',
        ['nodes', nodeIndex, 'loopGate', 'maxIterations'],
        `LoopGate ${node.id} exceeds the effective loop limit`
      )
    }
    for (const [field, target] of [
      ['sourceNodeId', gate.condition.sourceNodeId],
      ['continueTargetNodeId', gate.continueTargetNodeId],
      ['exitTargetNodeId', gate.exitTargetNodeId],
      ['exhaustionTargetNodeId', gate.exhaustionTargetNodeId]
    ] as const) {
      if (target && !nodes.has(target)) {
        error(
          'missing_loop_target',
          ['nodes', nodeIndex, 'loopGate', field],
          `LoopGate ${node.id} references missing node ${target}`
        )
      }
    }
    if (gate.continueTargetNodeId === gate.exitTargetNodeId) {
      error(
        'invalid_loop_exit',
        ['nodes', nodeIndex, 'loopGate'],
        `LoopGate ${node.id} must use distinct continue and exit targets`
      )
    }
    const continuations = validSchedulingEdges.filter((edge) =>
      edge.from === node.id && edge.to === gate.continueTargetNodeId)
    const exits = validSchedulingEdges.filter((edge) =>
      edge.from === node.id && edge.to === gate.exitTargetNodeId)
    if (continuations.length !== 1) {
      error(
        'invalid_loop_continuation_edge',
        ['nodes', nodeIndex, 'loopGate', 'continueTargetNodeId'],
        `LoopGate ${node.id} must have exactly one scheduling edge to ${gate.continueTargetNodeId}`
      )
    }
    if (exits.length < 1) {
      error(
        'missing_loop_exit_edge',
        ['nodes', nodeIndex, 'loopGate', 'exitTargetNodeId'],
        `LoopGate ${node.id} has no scheduling edge to ${gate.exitTargetNodeId}`
      )
    }
    for (const continuation of continuations) loopContinuationEdgeIds.add(continuation.id)
  }

  const residualEdges = validSchedulingEdges.filter((edge) =>
    !loopContinuationEdgeIds.has(edge.id))
  if (containsDirectedCycle(plan.nodes.map((node) => node.id), residualEdges)) {
    error(
      'unbounded_cycle',
      ['edges'],
      'scheduling graph remains cyclic after removing declared LoopGate continuation edges'
    )
  }

  const result = GraphValidationResultV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
    normalizedNodeCount: plan.nodes.length,
    normalizedEdgeCount: plan.edges.length
  })
  return { result, ...(result.valid ? { plan } : {}) }
}

export function assertValidGraphPlan(
  input: unknown,
  config: GraphRuntimeConfig
): GraphPlanV1 {
  const validated = parseAndValidateGraphPlan(input, config)
  if (!validated.plan) throw new GraphPlanValidationError(validated.result)
  return validated.plan
}

function isSchedulingEdge(edge: GraphEdgeV1): edge is Extract<GraphEdgeV1, { kind: 'control' | 'data' }> {
  return edge.kind === 'control' || edge.kind === 'data'
}

function validateUnique<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  label: string,
  error: (code: string, path: Array<string | number>, message: string) => void
): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    const id = value[key]
    if (seen.has(id)) {
      error(
        `duplicate_${label}_id`,
        [`${label}s`, index, String(key)],
        `duplicate ${label} id ${id}`
      )
    }
    seen.add(id)
  }
}

function validateBudget(
  plan: GraphPlanV1,
  config: GraphRuntimeConfig,
  error: (code: string, path: Array<string | number>, message: string) => void
): void {
  const checks: Array<[keyof GraphPlanV1['budget'], number, number]> = [
    ['maxNodes', plan.budget.maxNodes, config.scheduler.maxNodes],
    ['maxEdges', plan.budget.maxEdges, config.scheduler.maxEdges],
    ['maxConcurrentNodes', plan.budget.maxConcurrentNodes, config.scheduler.maxConcurrentNodesPerRun],
    ['maxAttemptsPerNode', plan.budget.maxAttemptsPerNode, config.scheduler.maxAttemptsPerNode],
    ['maxRevisions', plan.budget.maxRevisions, config.scheduler.maxRevisions],
    ['maxLoopIterations', plan.budget.maxLoopIterations, config.scheduler.maxLoopIterations],
    ['maxWallTimeMs', plan.budget.maxWallTimeMs, config.scheduler.maxRunWallTimeMs],
    ['maxNodeWallTimeMs', plan.budget.maxNodeWallTimeMs, config.scheduler.maxNodeWallTimeMs],
    ['maxMessages', plan.budget.maxMessages, config.mailbox.maxMessagesPerRun],
    ['maxArtifactBytes', plan.budget.maxArtifactBytes, config.scheduler.maxArtifactBytes]
  ]
  for (const [field, requested, maximum] of checks) {
    if (requested > maximum) {
      error(
        'budget_exceeds_host_limit',
        ['budget', field],
        `${field} requests ${requested}; host limit is ${maximum}`
      )
    }
  }
}

function reachableFrom(entries: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reachable = new Set<string>()
  const stack = [...entries]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (reachable.has(current)) continue
    reachable.add(current)
    stack.push(...(outgoing.get(current) ?? []))
  }
  return reachable
}

function containsDirectedCycle(
  nodeIds: readonly string[],
  edges: readonly GraphEdgeV1[]
): boolean {
  const incoming = new Map(nodeIds.map((nodeId) => [nodeId, 0]))
  const outgoing = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]))
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue
    incoming.set(edge.to, incoming.get(edge.to)! + 1)
    outgoing.get(edge.from)!.push(edge.to)
  }
  const ready = nodeIds.filter((nodeId) => incoming.get(nodeId) === 0)
  let visited = 0
  while (ready.length > 0) {
    const nodeId = ready.pop()!
    visited += 1
    for (const target of outgoing.get(nodeId) ?? []) {
      const next = incoming.get(target)! - 1
      incoming.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  return visited !== nodeIds.length
}
