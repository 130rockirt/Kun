import {
  GRAPH_CONTRACT_VERSION,
  GraphValidationResultV1Schema,
  GraphWorkerResultV1Schema,
  type GraphCheckResultV1,
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphPlanV1,
  type GraphReviewResultV1,
  type GraphRunSummaryV1,
  type GraphRunV1,
  type GraphWorkerResultV1
} from '../contracts/graph.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { ChildRunRecord } from '../delegation/delegation-runtime.js'
import { graphHostRelativePathCovers } from './graph-platform-path.js'

export function dependencyDecision(
  run: GraphRunV1,
  incoming: GraphRunV1['plans'][number]['edges']
): 'ready' | 'blocked' | 'unsatisfiable' {
  for (const edge of incoming) {
    if (edge.kind === 'message') continue
    const source = run.nodes[edge.from]
    if (!source) return 'blocked'
    if (edge.kind === 'control') {
      const outcome = outcomeOf(source)
      if (!edge.requiredOutcomes.includes(outcome)) {
        if (isTerminalNodeStatus(source.status)) return 'unsatisfiable'
        return 'blocked'
      }
    } else {
      if (source.status !== 'accepted' && source.status !== 'superseded') {
        if (isTerminalNodeStatus(source.status)) return 'unsatisfiable'
        return 'blocked'
      }
      if (
        edge.required &&
        !run.artifacts.some((artifact) =>
          artifact.producerNodeId === edge.from &&
          artifact.visibility !== 'lead' &&
          artifact.visibility !== 'user' &&
          artifact.logicalNames?.includes(edge.artifactName))
      ) return 'unsatisfiable'
    }
  }
  return 'ready'
}

export function terminalRequiredFailure(
  run: GraphRunV1,
  config: GraphRuntimeConfig
): GraphNodeProjectionV1 | undefined {
  const completionIds = new Set(run.plans.at(-1)!.completionNodeIds)
  return Object.values(run.nodes).find((node) => {
    if (!node.node.required && !completionIds.has(node.node.id)) return false
    if (node.status === 'cancelled' || node.status === 'skipped') return true
    if (node.status !== 'failed' && node.status !== 'repair_required') return false
    const maxAttempts = Math.min(
      node.node.maxAttempts ?? run.budget.limits.maxAttemptsPerNode,
      config.scheduler.maxAttemptsPerNode
    )
    return node.attempts.length >= maxAttempts
  })
}

export function isTerminalNodeStatus(status: GraphNodeProjectionV1['status']): boolean {
  return ['accepted', 'failed', 'cancelled', 'skipped', 'superseded'].includes(status)
}

export function isTerminalRunStatus(status: GraphRunV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isTerminalAttemptStatus(status: GraphNodeAttemptV1['status']): boolean {
  return [
    'accepted',
    'repair_required',
    'failed',
    'interrupted',
    'cancelled',
    'orphaned'
  ].includes(status)
}

export function steeringTargetsNode(
  steering: GraphRunV1['steering'][number],
  projection: GraphNodeProjectionV1,
  attemptId?: string
): boolean {
  switch (steering.target.kind) {
    case 'run':
      return true
    case 'lead':
      return false
    case 'phase':
      return steering.target.phaseId === projection.node.phaseId
    case 'node':
      return steering.target.nodeId === projection.node.id
    case 'attempt':
      return steering.target.nodeId === projection.node.id &&
        attemptId !== undefined &&
        steering.target.attemptId === attemptId
  }
}

export function outcomeOf(node: GraphNodeProjectionV1):
  'accepted' | 'repair_required' | 'failed' | 'cancelled' | 'skipped' {
  if (node.status === 'accepted' || node.status === 'superseded') return 'accepted'
  if (node.status === 'repair_required') return 'repair_required'
  if (node.status === 'cancelled') return 'cancelled'
  if (node.status === 'skipped') return 'skipped'
  return 'failed'
}

export function deterministicReview(
  node: GraphNodeProjectionV1,
  attempt: GraphNodeAttemptV1,
  reviewId: string,
  createdAt: string
): GraphReviewResultV1 {
  const validation = attempt.validation
  const checkFailures = attempt.result?.verifiedChecks?.filter((check) => check.status !== 'passed') ?? []
  const configuredChecks = new Set(node.node.completion.review.deterministicChecks)
  const missingChecks = [...configuredChecks].filter((name) =>
    !attempt.result?.verifiedChecks?.some((check) => check.name === name && check.status === 'passed'))
  const passed = validation?.valid === true && checkFailures.length === 0 && missingChecks.length === 0
  return {
    version: GRAPH_CONTRACT_VERSION,
    reviewId,
    nodeId: node.node.id,
    attemptId: attempt.id,
    reviewerKind: 'deterministic',
    outcome: passed ? 'pass' : 'revise',
    summary: passed
      ? 'Structured result and deterministic completion checks passed.'
      : [
          validation?.valid ? '' : 'Structured result validation failed.',
          checkFailures.length ? `${checkFailures.length} check(s) failed.` : '',
          missingChecks.length ? `Missing passing checks: ${missingChecks.join(', ')}.` : ''
        ].filter(Boolean).join(' '),
    evidence: [
      ...(validation?.issues.map((issue) => `${issue.code}: ${issue.message}`) ?? []),
      ...checkFailures.map((check) => `${check.name}: ${check.summary}`)
    ],
    artifactRefs: attempt.result?.artifactRefs ?? [],
    ...(!passed ? { repairInstructions: 'Address validation and check failures, then resubmit.' } : {}),
    createdAt
  }
}

export function validateWorkerResult(
  node: GraphNodeProjectionV1,
  result: GraphWorkerResultV1,
  missingRequiredArtifactNames: readonly string[] = []
) {
  const issues: Array<{
    code: string
    path: Array<string | number>
    message: string
    severity: 'error' | 'warning'
  }> = []
  for (const field of node.node.completion.requiredResultFields) {
    const value = field === 'checks'
      ? (result.reportedChecks?.length ? result.reportedChecks : result.checks)
      : result[field]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      issues.push({
        code: 'required_result_field',
        path: [field],
        message: `required result field ${field} is empty`,
        severity: 'error'
      })
    }
  }
  for (const artifactName of missingRequiredArtifactNames) {
    issues.push({
      code: 'missing_required_artifact',
      path: ['artifactRefs'],
      message: `required downstream artifact ${artifactName} was not published`,
      severity: 'error'
    })
  }
  for (const changedFile of result.changedFiles) {
    if (!node.node.writeScopes.some((scope) =>
      graphHostRelativePathCovers(scope, changedFile))) {
      issues.push({
        code: 'changed_file_outside_scope',
        path: ['changedFiles'],
        message: `${changedFile} is outside the node write scopes`,
        severity: 'error'
      })
    }
  }
  return GraphValidationResultV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    normalizedNodeCount: 1,
    normalizedEdgeCount: 0
  })
}

export function parseWorkerResult(child: ChildRunRecord): GraphWorkerResultV1 {
  const parsed = parseJsonObject(child.summary ?? '')
  const candidate = parsed
    ? {
        version: GRAPH_CONTRACT_VERSION,
        summary: typeof parsed.summary === 'string' ? parsed.summary : child.summary ?? '',
        artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs : [],
        changedFiles: stringArray(parsed.changedFiles),
        reportedChecks: normalizeChecks(parsed.reportedChecks ?? parsed.checks),
        verifiedChecks: [],
        evidence: stringArray(parsed.evidence).length
          ? stringArray(parsed.evidence)
          : child.evidence ?? [],
        risks: stringArray(parsed.risks),
        suggestedMessages: []
      }
    : {
        version: GRAPH_CONTRACT_VERSION,
        summary: (child.summary ?? 'Worker completed without a summary.').slice(0, 4_096),
        artifactRefs: [],
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: [],
        evidence: child.evidence ?? [],
        risks: [],
        suggestedMessages: []
      }
  const result = GraphWorkerResultV1Schema.safeParse(candidate)
  if (result.success) return result.data
  return GraphWorkerResultV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    summary: (child.summary ?? 'Worker result failed structured parsing.').slice(0, 4_096),
    artifactRefs: [],
    changedFiles: [],
    reportedChecks: [],
    verifiedChecks: [],
    evidence: child.evidence ?? [],
    risks: ['Worker output did not satisfy the structured result schema.'],
    suggestedMessages: []
  })
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    text.match(/\{[\s\S]*\}/)?.[0]
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null
}

function normalizeChecks(value: unknown): GraphCheckResultV1[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 128).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const status = ['passed', 'failed', 'skipped', 'not_run'].includes(String(item.status))
      ? item.status
      : 'not_run'
    return [{
      name: typeof item.name === 'string' ? item.name.slice(0, 256) : `check-${index + 1}`,
      status: status as GraphCheckResultV1['status'],
      summary: typeof item.summary === 'string'
        ? item.summary.slice(0, 4_096)
        : 'No check summary.',
      artifactRefs: []
    }]
  })
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 1_000)
    : []
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
  reset.add(continueTargetNodeId)
  reset.add(conditionSourceNodeId)
  reset.add(gateNodeId)
  return plan.nodes.map((node) => node.id).filter((nodeId) => reset.has(nodeId))
}

export function isLoopContinuationEdge(
  run: GraphRunV1,
  fromNodeId: string,
  toNodeId: string
): boolean {
  const source = run.nodes[fromNodeId]?.node
  return source?.kind === 'loop_gate' &&
    source.loopGate?.continueTargetNodeId === toNodeId
}

function reachableNodeIds(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
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

export function effectiveReviewKinds(
  node: GraphNodeProjectionV1,
  config: GraphRuntimeConfig,
  isCompletionNode: boolean
): Array<'deterministic' | 'peer' | 'lead' | 'human'> {
  const kinds = [...node.node.completion.review.kinds]
  if (
    (
      (config.supervision.requireFinalReview && isCompletionNode) ||
      (
        node.node.writeScopes.length > 0 &&
        (node.node.riskClass === 'high' || node.node.riskClass === 'critical')
      )
    ) &&
    !kinds.includes('lead')
  ) kinds.push('lead')
  if (
    config.supervision.requireHumanForCriticalRisk &&
    node.node.riskClass === 'critical' &&
    !kinds.includes('human')
  ) kinds.push('human')
  return kinds
}

export function hasPendingExternalReview(run: GraphRunV1): boolean {
  return Object.values(run.nodes).some((node) =>
    node.status === 'reviewing' || node.status === 'submitted')
}

export function totalAttemptLimit(run: GraphRunV1): number {
  return Object.keys(run.nodes).length * run.budget.limits.maxAttemptsPerNode
}

export function maxBudgetRatio(run: GraphRunV1): number {
  return Math.max(
    run.budget.elapsedMs / run.budget.limits.maxWallTimeMs,
    run.budget.attempts / Math.max(1, totalAttemptLimit(run)),
    run.budget.artifactBytes / Math.max(1, run.budget.limits.maxArtifactBytes),
    run.budget.messages / Math.max(1, run.budget.limits.maxMessages),
    run.budget.revisions / Math.max(1, run.budget.limits.maxRevisions),
    run.budget.loopIterations / Math.max(1, run.budget.limits.maxLoopIterations)
  )
}

export function budgetWarningKinds(run: GraphRunV1): GraphRunV1['budget']['warningKinds'] {
  const threshold = run.budget.limits.warningRatio
  const entries: Array<[GraphRunV1['budget']['warningKinds'][number], number]> = [
    ['time', run.budget.elapsedMs / run.budget.limits.maxWallTimeMs],
    ['attempts', run.budget.attempts / Math.max(1, totalAttemptLimit(run))],
    ['revisions', run.budget.revisions / run.budget.limits.maxRevisions],
    ['loops', run.budget.loopIterations / Math.max(1, run.budget.limits.maxLoopIterations)],
    ['messages', run.budget.messages / Math.max(1, run.budget.limits.maxMessages)],
    ['artifacts', run.budget.artifactBytes / Math.max(1, run.budget.limits.maxArtifactBytes)]
  ]
  return entries.filter(([, ratio]) => ratio >= threshold).map(([kind]) => kind)
}

export function deterministicSummary(run: GraphRunV1, completedAt: string): GraphRunSummaryV1 {
  const acceptedAttempts = Object.values(run.nodes).flatMap((node) =>
    node.attempts.filter((attempt) => attempt.id === node.acceptedAttemptId))
  const completionSummaries = run.plans.at(-1)!.completionNodeIds
    .map((nodeId) => run.nodes[nodeId])
    .flatMap((node) => node?.attempts.filter((attempt) => attempt.id === node.acceptedAttemptId) ?? [])
    .map((attempt) => attempt.result?.summary)
    .filter((summary): summary is string => Boolean(summary))
  return {
    version: GRAPH_CONTRACT_VERSION,
    finalAnswer: (completionSummaries.join('\n\n') || 'GraphRun completed successfully.').slice(0, 32_768),
    evidenceRefs: acceptedAttempts.flatMap((attempt) => attempt.result?.artifactRefs ?? []).slice(0, 256),
    unresolvedRisks: acceptedAttempts.flatMap((attempt) => attempt.result?.risks ?? []).slice(0, 128),
    changedFiles: [...new Set(acceptedAttempts.flatMap((attempt) =>
      attempt.result?.changedFiles ?? []))].slice(0, 10_000),
    validationResults: acceptedAttempts.flatMap((attempt) =>
      attempt.result?.verifiedChecks ?? []).slice(0, 512),
    totalTokens: run.budget.totalTokens,
    totalElapsedMs: run.budget.elapsedMs,
    completedAt
  }
}

export function downstreamNodeIds(run: GraphRunV1, nodeId: string): string[] {
  return [...new Set(run.plans.at(-1)!.edges
    .filter((edge) => edge.from === nodeId)
    .map((edge) => edge.to))]
}

export function findAttempt(
  run: GraphRunV1,
  nodeId: string,
  attemptId: string
): GraphNodeAttemptV1 {
  const attempt = run.nodes[nodeId]?.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) throw new Error(`Graph attempt not found: ${attemptId}`)
  return attempt
}

export function rotate<T>(values: readonly T[], offset: number): T[] {
  if (!values.length) return []
  return [...values.slice(offset), ...values.slice(0, offset)]
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512)
}
