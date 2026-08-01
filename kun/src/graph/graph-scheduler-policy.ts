import {
  GRAPH_CONTRACT_VERSION,
  GraphArtifactReferenceV1Schema,
  GraphCheckResultV1Schema,
  GraphRelativePathSchema,
  GraphValidationResultV1Schema,
  GraphVerifiedCheckResultV1Schema,
  GraphWorkerResultV1Schema,
  type GraphCheckResultV1,
  type GraphNodeAttemptV1,
  type GraphNodeProjectionV1,
  type GraphReviewResultV1,
  type GraphRunSummaryV1,
  type GraphRunV1,
  type GraphVerifiedCheckResultV1,
  type GraphWorkerResultV1
} from '../contracts/graph.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { ChildRunRecord } from '../delegation/delegation-runtime.js'
import type { WorkerArtifactRefRejection } from './graph-artifact-policy.js'
import {
  loopGateHandlesNodeOutcome,
  loopGateWaivesIncompleteNode,
  outcomeOf
} from './graph-loop-policy.js'
import { graphHostRelativePathCovers } from './graph-platform-path.js'
import { normalizeGraphReviewResult } from './graph-review-normalizer.js'

export { outcomeOf } from './graph-loop-policy.js'

const MAX_GRAPH_SUMMARY_CHARS = 4_096
const MAX_GRAPH_VALIDATION_MESSAGE_CHARS = 2_048
const MAX_GRAPH_VALIDATION_ISSUES = 512
export const GRAPH_HOST_SHUTDOWN_ATTEMPT_FAILURE =
  'host shutdown suspended active Graph worker'
export const GRAPH_RUNTIME_RESTART_ATTEMPT_FAILURE =
  'runtime restart interrupted child execution'

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
      if (!outcome || !edge.requiredOutcomes.includes(outcome)) {
        if (isTerminalNodeStatus(source.status)) return 'unsatisfiable'
        return 'blocked'
      }
    } else {
      if (source.status !== 'accepted' && source.status !== 'superseded') {
        if (isTerminalNodeStatus(source.status)) return 'unsatisfiable'
        return 'blocked'
      }
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
    // Loop gates are scheduler-owned control nodes, not executable required
    // work. Their normal terminal state is `skipped` after choosing a branch.
    if (node.node.kind === 'loop_gate') return false
    if (!node.node.required && !completionIds.has(node.node.id)) return false
    if (loopGateHandlesNodeOutcome(run, node.node.id)) return false
    if (loopGateWaivesIncompleteNode(run, node.node.id)) return false
    if (node.status === 'cancelled' || node.status === 'skipped') return true
    if (node.status !== 'failed' && node.status !== 'repair_required') return false
    const maxAttempts = effectiveNodeMaxAttempts(run, node, config)
    return currentIterationAttemptCount(node) >= maxAttempts
  })
}

export function effectiveNodeMaxAttempts(
  run: GraphRunV1,
  node: GraphNodeProjectionV1,
  config?: GraphRuntimeConfig
): number {
  return Math.min(
    node.node.maxAttempts ?? run.budget.limits.maxAttemptsPerNode,
    run.budget.limits.maxAttemptsPerNode,
    config?.scheduler.maxAttemptsPerNode ?? run.budget.limits.maxAttemptsPerNode
  )
}

export function currentIterationAttemptCount(node: GraphNodeProjectionV1): number {
  return node.attempts.filter((attempt) =>
    attempt.iteration === node.loopIteration &&
    !isNonConsumingRuntimeInterruption(attempt)
  ).length
}

export function isNonConsumingRuntimeInterruption(
  attempt: GraphNodeAttemptV1
): boolean {
  if (
    attempt.failureClass === 'interrupted' &&
    attempt.status === 'interrupted' &&
    attempt.normalizedFailure === GRAPH_HOST_SHUTDOWN_ATTEMPT_FAILURE
  ) return true
  return (
    attempt.failureClass === 'interrupted' &&
    attempt.status === 'orphaned' &&
    attempt.normalizedFailure === GRAPH_RUNTIME_RESTART_ATTEMPT_FAILURE
  )
}

export function effectiveRunAttemptCount(run: GraphRunV1): number {
  return Object.values(run.nodes).reduce(
    (count, node) =>
      count + node.attempts.filter((attempt) =>
        !isNonConsumingRuntimeInterruption(attempt)).length,
    0
  )
}

export function validationFailureSummary(attempt: GraphNodeAttemptV1): string {
  const issues = attempt.validation?.issues
    .filter((issue) => issue.severity === 'error')
    .slice(0, 8)
    .map((issue) => `${issue.code}: ${issue.message}`)
  return boundedSummary(issues?.length
    ? `Host validation failed: ${issues.join('; ')}`
    : 'Host validation failed; repair the structured result before review.')
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
  return normalizeGraphReviewResult({
    reviewId,
    nodeId: node.node.id,
    attemptId: attempt.id,
    reviewerKind: 'deterministic',
    outcome: passed ? 'pass' : 'revise',
    summary: boundedSummary(passed
      ? 'Structured result and deterministic completion checks passed.'
      : [
          validation?.valid ? '' : 'Structured result validation failed.',
          checkFailures.length ? `${checkFailures.length} check(s) failed.` : '',
          missingChecks.length ? `Missing passing checks: ${missingChecks.join(', ')}.` : ''
        ].filter(Boolean).join(' ')),
    evidence: [
      ...(validation?.issues.map((issue) => `${issue.code}: ${issue.message}`) ?? []),
      ...checkFailures.map((check) => `${check.name}: ${check.summary}`)
    ],
    artifactRefs: attempt.result?.artifactRefs ?? [],
    ...(!passed ? { repairInstructions: 'Address validation and check failures, then resubmit.' } : {}),
    createdAt
  })
}

export function validateWorkerResult(
  node: GraphNodeProjectionV1,
  result: GraphWorkerResultV1,
  host: {
    observedChangedFiles?: readonly string[]
    changedFilesObservationError?: string
    checkVerificationError?: string
    rejectedArtifactRefs?: readonly WorkerArtifactRefRejection[]
  } = {}
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
    const emptyArrayIsValid =
      field === 'artifactRefs' ||
      field === 'changedFiles' ||
      field === 'risks'
    if (
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0 && !emptyArrayIsValid)
    ) {
      issues.push({
        code: 'required_result_field',
        path: [field],
        message: `required result field ${field} is empty`,
        severity: 'error'
      })
    }
  }
  const changedFiles = host.observedChangedFiles ?? result.changedFiles
  if (host.changedFilesObservationError) {
    issues.push({
      code: 'changed_files_observation_unavailable',
      path: ['changedFiles'],
      message: boundedValidationMessage(
        `Host could not establish the authoritative changed-file set: ` +
        host.changedFilesObservationError
      ),
      severity: 'error'
    })
  }
  if (host.checkVerificationError) {
    issues.push({
      code: 'host_check_verification_unavailable',
      path: ['verifiedChecks'],
      message: boundedValidationMessage(
        `Host completion checks could not run: ${host.checkVerificationError}`
      ),
      severity: 'error'
    })
  }
  if (host.observedChangedFiles && host.observedChangedFiles.length > 1_000) {
    issues.push({
      code: 'observed_changed_files_overflow',
      path: ['changedFiles'],
      message: boundedValidationMessage(
        `Host observed ${host.observedChangedFiles.length} changed files; ` +
        'the durable result limit is 1000, so acceptance is blocked until the change set is narrowed.'
      ),
      severity: 'error'
    })
  }
  const invalidChangedFiles = changedFiles.filter((changedFile) =>
    !GraphRelativePathSchema.safeParse(changedFile).success)
  if (invalidChangedFiles.length) {
    issues.push({
      code: 'observed_changed_file_invalid',
      path: ['changedFiles'],
      message: boundedPathIssue(
        `${invalidChangedFiles.length} changed file path(s) are not valid repository-relative paths`,
        invalidChangedFiles
      ),
      severity: 'error'
    })
  }
  const outsideScope = changedFiles.filter((changedFile) =>
    GraphRelativePathSchema.safeParse(changedFile).success &&
    !node.node.writeScopes.some((scope) =>
      graphHostRelativePathCovers(scope, changedFile)))
  if (outsideScope.length) {
    issues.push({
      code: 'changed_file_outside_scope',
      path: ['changedFiles'],
      message: boundedPathIssue(
        `${outsideScope.length} changed file(s) are outside the node write scopes`,
        outsideScope
      ),
      severity: 'error'
    })
  }
  if (host.rejectedArtifactRefs?.length) {
    issues.push({
      code: 'worker_artifact_ref_rejected',
      path: ['artifactRefs'],
      message: boundedValidationMessage(
        `${host.rejectedArtifactRefs.length} optional worker artifact reference(s) were discarded: ` +
        host.rejectedArtifactRefs
          .slice(0, 8)
          .map((entry) => `${entry.artifactId} (${entry.reason})`)
          .join(', ')
      ),
      severity: 'warning'
    })
  }
  const normalizedIssues = issues.slice(0, MAX_GRAPH_VALIDATION_ISSUES)
  const candidate = GraphValidationResultV1Schema.safeParse({
    version: GRAPH_CONTRACT_VERSION,
    valid: !normalizedIssues.some((issue) => issue.severity === 'error'),
    issues: normalizedIssues,
    normalizedNodeCount: 1,
    normalizedEdgeCount: 0
  })
  if (candidate.success) return candidate.data
  return GraphValidationResultV1Schema.parse({
    version: GRAPH_CONTRACT_VERSION,
    valid: false,
    issues: [{
      code: 'host_validation_normalization_error',
      path: [],
      message: 'Host could not safely normalize worker validation details.',
      severity: 'error'
    }],
    normalizedNodeCount: 1,
    normalizedEdgeCount: 0
  })
}

export function parseWorkerResult(child: ChildRunRecord): GraphWorkerResultV1 {
  const parsed = parseJsonObject(child.summary ?? '')
  const fallbackEvidence = child.evidence?.length
    ? boundedStringArray(child.evidence, 128)
    : child.summary?.trim()
      ? [boundedSummary(`Executor final response: ${child.summary}`)]
      : []
  return normalizeWorkerResult(parsed
    ? {
        version: GRAPH_CONTRACT_VERSION,
        summary: typeof parsed.summary === 'string' ? parsed.summary : child.summary ?? '',
        artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs : [],
        changedFiles: stringArray(parsed.changedFiles),
        reportedChecks: normalizeChecks(parsed.reportedChecks ?? parsed.checks),
        verifiedChecks: [],
        evidence: boundedStringArray(parsed.evidence, 128).length
          ? boundedStringArray(parsed.evidence, 128)
          : fallbackEvidence,
        risks: boundedStringArray(parsed.risks, 64),
        suggestedMessages: []
      }
    : {
        version: GRAPH_CONTRACT_VERSION,
        summary: child.summary ?? 'Worker completed without a summary.',
        artifactRefs: [],
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: [],
        evidence: fallbackEvidence,
        risks: [],
        suggestedMessages: []
      },
  child.summary ?? 'Worker completed without a summary.')
}

/**
 * Normalize untrusted worker prose and optional structured fields into the
 * bounded durable Graph result contract. This function is intentionally
 * total: malformed optional fields are dropped or clipped, never allowed to
 * turn completed work into a retryable executor failure.
 */
export function normalizeWorkerResult(
  input: unknown,
  fallbackSummary = 'Worker completed without a summary.'
): GraphWorkerResultV1 {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const candidate = {
    version: GRAPH_CONTRACT_VERSION,
    summary: boundedSummary(
      typeof value.summary === 'string' ? value.summary : fallbackSummary
    ),
    artifactRefs: validEntries(value.artifactRefs, GraphArtifactReferenceV1Schema, 128),
    changedFiles: validEntries(value.changedFiles, GraphRelativePathSchema, 1_000),
    reportedChecks: normalizeChecks(value.reportedChecks ?? value.checks),
    verifiedChecks: validEntries(
      value.verifiedChecks,
      GraphVerifiedCheckResultV1Schema,
      128
    ),
    evidence: boundedStringArray(value.evidence, 128),
    risks: boundedStringArray(value.risks, 64),
    suggestedMessages: []
  }
  const normalized = GraphWorkerResultV1Schema.safeParse(candidate)
  if (normalized.success) return normalized.data

  // Keep a schema-independent last line of defence. Every value below is
  // constructed locally and is valid for GraphWorkerResultV1.
  return {
    version: GRAPH_CONTRACT_VERSION,
    summary: boundedSummary(fallbackSummary),
    artifactRefs: [],
    changedFiles: [],
    reportedChecks: [],
    verifiedChecks: [],
    evidence: [],
    risks: [],
    suggestedMessages: []
  }
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
    if (typeof entry === 'string' && entry.trim()) {
      const summary = entry.trim().slice(0, 4_096)
      return [{
        name: summary.slice(0, 256),
        status: 'not_run',
        summary: `Unstructured worker-reported check: ${summary}`.slice(0, 4_096),
        artifactRefs: []
      }]
    }
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const status = ['passed', 'failed', 'skipped', 'not_run'].includes(String(item.status))
      ? item.status
      : 'not_run'
    const candidate = GraphCheckResultV1Schema.safeParse({
      name: typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 256)
        : `check-${index + 1}`,
      status: status as GraphCheckResultV1['status'],
      summary: typeof item.summary === 'string'
        ? item.summary.slice(0, 4_096)
        : 'No check summary.',
      artifactRefs: []
    })
    return candidate.success ? [candidate.data] : []
  })
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 1_000)
    : []
}

function boundedStringArray(value: unknown, maximumItems: number): string[] {
  return stringArray(value)
    .slice(0, maximumItems)
    .map(boundedSummary)
}

function boundedSummary(value: string): string {
  return value.slice(0, MAX_GRAPH_SUMMARY_CHARS)
}

function boundedValidationMessage(value: string): string {
  return value.slice(0, MAX_GRAPH_VALIDATION_MESSAGE_CHARS)
}

function boundedPathIssue(prefix: string, paths: readonly string[]): string {
  const examples = paths
    .slice(0, 8)
    .map((path) => path.slice(0, 256))
    .join(', ')
  return boundedValidationMessage(
    `${prefix}${examples ? `; examples: ${examples}` : ''}`
  )
}

function validEntries<T>(
  value: unknown,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  maximumItems: number
): T[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, maximumItems).flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

export function effectiveReviewKinds(
  node: GraphNodeProjectionV1,
  config: GraphRuntimeConfig,
  _isCompletionNode: boolean
): Array<'deterministic' | 'peer' | 'lead' | 'human'> {
  const kinds = [...node.node.completion.review.kinds]
  // Every executor result is returned to the durable source Lead. No worker,
  // peer reviewer, or scheduler transition can accept a node on its behalf.
  if (!kinds.includes('lead')) kinds.push('lead')
  if (
    config.supervision.requireHumanForCriticalRisk &&
    node.node.riskClass === 'critical' &&
    !kinds.includes('human')
  ) kinds.push('human')
  return kinds
}

export function reviewDisposition(input: {
  requiredKinds: Array<'deterministic' | 'peer' | 'lead' | 'human'>
  requireAll: boolean
  validationValid: boolean
  reviews: readonly GraphReviewResultV1[]
}):
  | { kind: 'accept' }
  | { kind: 'awaiting_lead' | 'invalid' | 'awaiting_human' | 'awaiting_evidence' }
  | { kind: 'repair'; reason: string } {
  const lead = input.reviews.find((review) => review.reviewerKind === 'lead')
  if (!lead) return { kind: 'awaiting_lead' }
  if (lead.outcome === 'fail' || lead.outcome === 'revise') {
    return { kind: 'repair', reason: lead.summary }
  }
  if (!input.validationValid) return { kind: 'invalid' }
  const passed = (kind: typeof input.requiredKinds[number]) =>
    input.reviews.some((review) =>
      review.reviewerKind === kind && review.outcome === 'pass')
  const mandatory = input.requiredKinds.filter((kind) =>
    kind === 'lead' || kind === 'human')
  const evidence = input.requiredKinds.filter((kind) =>
    kind !== 'lead' && kind !== 'human')
  const sufficient =
    mandatory.every(passed) &&
    (
      evidence.length === 0 ||
      (input.requireAll ? evidence.every(passed) : evidence.some(passed))
    )
  if (
    input.reviews.some((review) => review.outcome === 'needs_human') ||
    (!sufficient && input.requiredKinds.includes('human') && !passed('human'))
  ) return { kind: 'awaiting_human' }
  const negative = !sufficient
    ? input.reviews.find((review) =>
        review.reviewerKind !== 'lead' &&
        (review.outcome === 'fail' || review.outcome === 'revise'))
    : undefined
  if (negative) return { kind: 'repair', reason: negative.summary }
  return sufficient ? { kind: 'accept' } : { kind: 'awaiting_evidence' }
}

export function hasPendingExternalReview(run: GraphRunV1): boolean {
  return Object.values(run.nodes).some((node) =>
    node.status === 'reviewing' || node.status === 'submitted')
}

export function totalAttemptLimit(run: GraphRunV1): number {
  return Object.keys(run.nodes).length * run.budget.limits.maxAttemptsPerNode
}

export function maxBudgetRatio(run: GraphRunV1): number {
  const attempts = effectiveRunAttemptCount(run)
  return Math.max(
    run.budget.elapsedMs / run.budget.limits.maxWallTimeMs,
    attempts / Math.max(1, totalAttemptLimit(run)),
    run.budget.artifactBytes / Math.max(1, run.budget.limits.maxArtifactBytes),
    run.budget.messages / Math.max(1, run.budget.limits.maxMessages),
    run.budget.revisions / Math.max(1, run.budget.limits.maxRevisions),
    run.budget.loopIterations / Math.max(1, run.budget.limits.maxLoopIterations)
  )
}

export function budgetWarningKinds(run: GraphRunV1): GraphRunV1['budget']['warningKinds'] {
  const threshold = run.budget.limits.warningRatio
  const attempts = effectiveRunAttemptCount(run)
  const entries: Array<[GraphRunV1['budget']['warningKinds'][number], number]> = [
    ['time', run.budget.elapsedMs / run.budget.limits.maxWallTimeMs],
    ['attempts', attempts / Math.max(1, totalAttemptLimit(run))],
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
      attempt.result?.verifiedChecks?.map(projectGraphVerifiedCheckResult) ?? []).slice(0, 512),
    totalTokens: run.budget.totalTokens,
    totalElapsedMs: run.budget.elapsedMs,
    completedAt
  }
}

export function projectGraphVerifiedCheckResult(
  check: GraphVerifiedCheckResultV1
): GraphCheckResultV1 {
  return {
    name: check.name,
    status: check.status,
    summary: check.summary,
    artifactRefs: check.artifactRefs
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
