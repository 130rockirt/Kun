import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { RuntimeEvent, type RuntimeEvent as RuntimeEventValue } from '../contracts/events.js'
import { RuntimeInfoResponse, type RuntimeInfoResponse as RuntimeInfoValue } from '../contracts/runtime-info.js'
import { TurnReasoningEffortSchema } from '../contracts/turns.js'
import type { UsageSnapshot } from '../contracts/usage.js'

import {
  ReplayBudgetSchema,
  ReplayComparisonPolicySchema,
  ReplayComparisonThresholdsSchema,
  summarizeReplayRuns
} from './replay-benchmark-runner.js'
import type {
  ReplayBudget,
  ReplayBudgetEvaluation,
  ReplayBudgetViolation,
  ReplayComparison,
  ReplayComparisonPolicy,
  ReplayComparisonThresholds,
  ReplayModelComparison,
  ReplayReport,
  ReplayReportSummary,
  ReplayRunResult,
  ReplaySuite,
  ReplaySummaryComparison,
  ReplayTask
} from './replay-benchmark-runner.js'
import {
  addMaximumViolation,
  addMinimumViolation,
  appendList,
  formatBytes,
  formatOptionalMs,
  formatOptionalPercent,
  formatPercent,
  formatSignedFixed,
  formatSignedNumber,
  formatSignedOptionalMs,
  formatSignedOptionalPercent,
  formatSignedPercent,
  isIncreaseRegression,
  nullableDelta
} from './replay-benchmark-quality.js'

export function parseReplayComparisonPolicy(input: unknown): ReplayComparisonPolicy {
  return ReplayComparisonPolicySchema.parse(input ?? {})
}

export function compareReplayReports(
  current: ReplayReport,
  baseline: ReplayReport,
  policyInput: unknown = {}
): ReplayComparison {
  const configuredPolicy = parseReplayComparisonPolicy(policyInput)
  const pairs = assertReplayReportsComparable(current, baseline, configuredPolicy)
  const groupedPairs = groupReplayRunPairsByCurrentModel(pairs, current, baseline)
  const modelComparisons = [...groupedPairs.values()]
    .sort((left, right) => (left.model ?? '').localeCompare(right.model ?? ''))
    .map((group): ReplayModelComparison => {
      const policy = replayComparisonThresholdsForModel(configuredPolicy, group.model)
      const metrics = compareReplaySummaries(
        groupedPairs.size === 1 ? current.summary : summarizeReplayRuns(group.currentRuns),
        groupedPairs.size === 1 ? baseline.summary : summarizeReplayRuns(group.baselineRuns),
        policy,
        { includePeakRss: false }
      )
      return {
        ...(group.model ? { model: group.model } : {}),
        baselineModels: [...group.baselineModels].sort(),
        runCount: group.currentRuns.length,
        policy,
        successRateDelta: metrics.successRateDelta,
        ttftP95MsDelta: metrics.ttftP95MsDelta,
        totalP95MsDelta: metrics.totalP95MsDelta,
        promptTokensDelta: metrics.promptTokensDelta,
        cacheHitRateDelta: metrics.cacheHitRateDelta,
        costUsdDelta: metrics.costUsdDelta,
        regressions: metrics.regressions
      }
    })
  const onlyModel = modelComparisons.length === 1 ? modelComparisons[0] : undefined
  const policy = onlyModel?.policy ?? ReplayComparisonThresholdsSchema.parse(configuredPolicy.defaults)
  const globalPolicy = ReplayComparisonThresholdsSchema.parse(configuredPolicy.defaults)
  const metrics = compareReplaySummaries(current.summary, baseline.summary, globalPolicy)
  const modelRegressions = modelComparisons.flatMap((comparison) =>
    comparison.regressions.map((regression) =>
      modelComparisons.length === 1
        ? regression
        : `[model ${comparison.model ?? 'unknown'}] ${regression}`
    )
  )
  const regressions = [
    ...modelRegressions,
    ...metrics.regressions.filter((regression) => regression.startsWith('peak RSS'))
  ]
  return {
    baselineGeneratedAt: baseline.generatedAt,
    ...(onlyModel?.model ? { model: onlyModel.model } : {}),
    policy,
    modelComparisons,
    ...metrics,
    regressions
  }
}

export function compareReplaySummaries(
  current: ReplayReportSummary,
  baseline: ReplayReportSummary,
  policy: ReplayComparisonThresholds,
  options: { includePeakRss?: boolean } = {}
): ReplaySummaryComparison {
  const successRateDelta = current.successRate - baseline.successRate
  const ttftP95MsDelta = nullableDelta(current.ttftP95Ms, baseline.ttftP95Ms)
  const totalP95MsDelta = nullableDelta(current.totalP95Ms, baseline.totalP95Ms)
  const cacheHitRateDelta = nullableDelta(current.cacheHitRate, baseline.cacheHitRate)
  const peakRssBytesDelta = nullableDelta(current.peakRssBytes, baseline.peakRssBytes)
  const regressions: string[] = []
  if (successRateDelta < -policy.maxSuccessRateDrop) {
    regressions.push(`success rate dropped by ${formatPercent(-successRateDelta)}`)
  }
  if (isIncreaseRegression(
    current.ttftP95Ms,
    baseline.ttftP95Ms,
    policy.maxTtftRelativeIncrease,
    policy.maxTtftAbsoluteIncreaseMs
  )) {
    regressions.push(`TTFT p95 increased by ${ttftP95MsDelta}ms`)
  }
  if (isIncreaseRegression(
    current.totalP95Ms,
    baseline.totalP95Ms,
    policy.maxTotalRelativeIncrease,
    policy.maxTotalAbsoluteIncreaseMs
  )) {
    regressions.push(`total latency p95 increased by ${totalP95MsDelta}ms`)
  }
  if (cacheHitRateDelta !== null && cacheHitRateDelta < -policy.maxCacheHitRateDrop) {
    regressions.push(`cache hit rate dropped by ${formatPercent(-cacheHitRateDelta)}`)
  }
  if (isIncreaseRegression(
    current.costUsd,
    baseline.costUsd,
    policy.maxCostRelativeIncrease,
    policy.maxCostAbsoluteIncreaseUsd
  )) {
    regressions.push(`cost increased by $${(current.costUsd - baseline.costUsd).toFixed(6)}`)
  }
  if (
    (policy.maxPromptTokensRelativeIncrease !== undefined ||
      policy.maxPromptTokensAbsoluteIncrease !== undefined) &&
    isIncreaseRegression(
      current.promptTokens,
      baseline.promptTokens,
      policy.maxPromptTokensRelativeIncrease,
      policy.maxPromptTokensAbsoluteIncrease
    )
  ) {
    regressions.push(`prompt tokens increased by ${current.promptTokens - baseline.promptTokens}`)
  }
  if (
    options.includePeakRss !== false &&
    (policy.maxPeakRssRelativeIncrease !== undefined ||
      policy.maxPeakRssAbsoluteIncreaseBytes !== undefined) &&
    isIncreaseRegression(
      current.peakRssBytes,
      baseline.peakRssBytes,
      policy.maxPeakRssRelativeIncrease,
      policy.maxPeakRssAbsoluteIncreaseBytes
    )
  ) {
    regressions.push(`peak RSS increased by ${formatBytes(peakRssBytesDelta ?? 0)}`)
  }
  return {
    successRateDelta,
    ttftP95MsDelta,
    totalP95MsDelta,
    promptTokensDelta: current.promptTokens - baseline.promptTokens,
    cacheHitRateDelta,
    costUsdDelta: current.costUsd - baseline.costUsd,
    peakRssBytesDelta,
    regressions
  }
}

export type ReplayRunPair = { current: ReplayRunResult; baseline: ReplayRunResult }

export function assertReplayReportsComparable(
  current: ReplayReport,
  baseline: ReplayReport,
  policy: ReplayComparisonPolicy
): ReplayRunPair[] {
  const mismatches: string[] = []
  if (current.suite.name !== baseline.suite.name) mismatches.push('suite name')
  if (current.suite.taskCount !== baseline.suite.taskCount) mismatches.push('task count')
  if (current.suite.repeat !== baseline.suite.repeat) mismatches.push('repeat count')
  if ((current.suite.concurrency ?? 1) !== (baseline.suite.concurrency ?? 1)) mismatches.push('concurrency')
  if ((current.suite.keepThreads ?? false) !== (baseline.suite.keepThreads ?? false)) mismatches.push('thread retention')
  if ((current.suite.tag ?? '') !== (baseline.suite.tag ?? '')) mismatches.push('tag filter')
  if (
    (current.suite.definitionHash || baseline.suite.definitionHash) &&
    current.suite.definitionHash !== baseline.suite.definitionHash
  ) {
    mismatches.push('suite definition')
  }

  const currentByKey = replayRunsByIdentity(current.runs)
  const baselineByKey = replayRunsByIdentity(baseline.runs)
  const currentKeys = [...currentByKey.keys()].sort()
  const baselineKeys = [...baselineByKey.keys()].sort()
  if (currentByKey.size !== current.runs.length || baselineByKey.size !== baseline.runs.length) {
    mismatches.push('duplicate task iterations')
  } else if (currentKeys.length !== baselineKeys.length || currentKeys.some((key, index) => key !== baselineKeys[index])) {
    mismatches.push('task iterations')
  }

  const pairs = currentKeys.flatMap((key): ReplayRunPair[] => {
    const currentRun = currentByKey.get(key)
    const baselineRun = baselineByKey.get(key)
    return currentRun && baselineRun ? [{ current: currentRun, baseline: baselineRun }] : []
  })
  if (!policy.allowModelChange && pairs.some((pair) =>
    effectiveReplayRunModel(pair.current, current) !== effectiveReplayRunModel(pair.baseline, baseline)
  )) {
    mismatches.push('runtime model selection')
  }
  if (mismatches.length > 0) {
    throw new Error(`replay baseline is not comparable: ${mismatches.join(', ')} differ`)
  }
  return pairs
}

export function replayRunsByIdentity(runs: ReplayRunResult[]): Map<string, ReplayRunResult> {
  return new Map(runs.map((run) => [`${run.taskId}\u0000${run.iteration}`, run]))
}

export function effectiveReplayRunModel(run: ReplayRunResult, report: ReplayReport): string | undefined {
  return run.model ?? report.runtime.model
}

export function replayComparisonThresholdsForModel(
  policy: ReplayComparisonPolicy,
  model: string | undefined
): ReplayComparisonThresholds {
  return ReplayComparisonThresholdsSchema.parse({
    ...policy.defaults,
    ...(model ? policy.models[model] : {})
  })
}

export function groupReplayRunPairsByCurrentModel(
  pairs: ReplayRunPair[],
  currentReport: ReplayReport,
  baselineReport: ReplayReport
): Map<string, {
    model?: string
    baselineModels: Set<string>
    currentRuns: ReplayRunResult[]
    baselineRuns: ReplayRunResult[]
  }> {
  const groups = new Map<string, {
    model?: string
    baselineModels: Set<string>
    currentRuns: ReplayRunResult[]
    baselineRuns: ReplayRunResult[]
  }>()
  for (const pair of pairs) {
    const model = effectiveReplayRunModel(pair.current, currentReport)
    const key = model ?? ''
    const group = groups.get(key) ?? {
      ...(model ? { model } : {}),
      baselineModels: new Set<string>(),
      currentRuns: [],
      baselineRuns: []
    }
    group.currentRuns.push(pair.current)
    group.baselineRuns.push(pair.baseline)
    group.baselineModels.add(effectiveReplayRunModel(pair.baseline, baselineReport) ?? 'unknown')
    groups.set(key, group)
  }
  return groups
}

export function replaySuiteDefinitionHash(suite: ReplaySuite, tasks: ReplayTask[]): string {
  const defaultsWithoutModel = { ...suite.defaults }
  delete defaultsWithoutModel.model
  const tasksWithoutModel = tasks.map((task) => {
    const next = { ...task }
    delete next.model
    return next
  })
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeReplayDefinition({
      version: suite.version,
      defaults: defaultsWithoutModel,
      tasks: tasksWithoutModel
    })))
    .digest('hex')
}

export function canonicalizeReplayDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeReplayDefinition)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) output[key] = canonicalizeReplayDefinition(child)
  }
  return output
}

export function parseReplayBudget(input: unknown): ReplayBudget {
  return ReplayBudgetSchema.parse(input)
}

export function evaluateReplayBudget(report: ReplayReport, budgetInput: unknown): ReplayBudgetEvaluation {
  const budget = parseReplayBudget(budgetInput)
  const { summary } = report
  const violations: ReplayBudgetViolation[] = []

  addMinimumViolation(violations, 'successRate', summary.successRate, budget.minSuccessRate)
  addMaximumViolation(violations, 'ttftP95Ms', summary.ttftP95Ms, budget.maxTtftP95Ms)
  addMaximumViolation(violations, 'totalP95Ms', summary.totalP95Ms, budget.maxTotalP95Ms)
  addMaximumViolation(violations, 'toolDurationP95Ms', summary.toolDurationP95Ms, budget.maxToolDurationP95Ms)
  addMaximumViolation(violations, 'sseDelayP95Ms', summary.sseDelayP95Ms, budget.maxSseDelayP95Ms)
  addMaximumViolation(violations, 'promptTokens', summary.promptTokens, budget.maxPromptTokens)
  addMaximumViolation(violations, 'totalTokens', summary.totalTokens, budget.maxTotalTokens)
  addMinimumViolation(violations, 'cacheHitRate', summary.cacheHitRate, budget.minCacheHitRate)
  addMinimumViolation(violations, 'cacheableTokenHitRate', summary.cacheableTokenHitRate, budget.minCacheableTokenHitRate)
  addMinimumViolation(violations, 'totalInputTokenHitRate', summary.totalInputTokenHitRate, budget.minTotalInputTokenHitRate)
  addMaximumViolation(violations, 'costUsd', summary.costUsd, budget.maxCostUsd)
  addMaximumViolation(violations, 'peakRssBytes', summary.peakRssBytes, budget.maxPeakRssBytes)

  return { passed: violations.length === 0, violations }
}

export function formatReplayReportMarkdown(report: ReplayReport): string {
  const lines = [
    `# Replay Benchmark Report`,
    '',
    `- Suite: ${report.suite.name}`,
    `- Generated: ${report.generatedAt}`,
    `- Runtime: ${report.runtime.baseUrl}`,
    `- Model: ${report.runtime.model ?? 'n/a'}`,
    `- Runs: ${report.summary.passed}/${report.summary.runCount} passed (${formatPercent(report.summary.successRate)})`,
    `- TTFT p50/p95: ${formatOptionalMs(report.summary.ttftP50Ms)} / ${formatOptionalMs(report.summary.ttftP95Ms)}`,
    `- Total p50/p95: ${formatOptionalMs(report.summary.totalP50Ms)} / ${formatOptionalMs(report.summary.totalP95Ms)}`,
    `- Tool p95: ${formatOptionalMs(report.summary.toolDurationP95Ms)}`,
    `- SSE delay p95: ${formatOptionalMs(report.summary.sseDelayP95Ms)}`,
    `- Tokens: ${report.summary.promptTokens} input + ${report.summary.completionTokens} output`,
    `- Cache hit: ${formatOptionalPercent(report.summary.cacheHitRate)}`,
    `- Cost: $${report.summary.costUsd.toFixed(6)}`,
    `- Peak RSS: ${report.summary.peakRssBytes === null ? 'n/a' : formatBytes(report.summary.peakRssBytes)}`,
    ''
  ]
  if (report.comparison) {
    lines.push('## Baseline Comparison', '')
    lines.push(`- Baseline: ${report.comparison.baselineGeneratedAt}`)
    lines.push(`- Comparison model: ${report.comparison.model ?? 'n/a'}`)
    lines.push(`- Success rate delta: ${formatSignedPercent(report.comparison.successRateDelta)}`)
    lines.push(`- TTFT p95 delta: ${formatSignedOptionalMs(report.comparison.ttftP95MsDelta)}`)
    lines.push(`- Total p95 delta: ${formatSignedOptionalMs(report.comparison.totalP95MsDelta)}`)
    lines.push(`- Prompt token delta: ${formatSignedNumber(report.comparison.promptTokensDelta)}`)
    lines.push(`- Cache hit delta: ${formatSignedOptionalPercent(report.comparison.cacheHitRateDelta)}`)
    lines.push(`- Cost delta: $${formatSignedFixed(report.comparison.costUsdDelta, 6)}`)
    lines.push('')
    appendList(lines, 'Regressions', report.comparison.regressions)
  }
  if (report.budget) {
    lines.push('## Budget Gate', '')
    lines.push(`- Result: ${report.budget.passed ? 'passed' : 'failed'}`)
    lines.push('')
    appendList(lines, 'Violations', report.budget.violations.map((violation) => violation.message))
  }
  lines.push('## Failed Runs', '')
  const failedRuns = report.runs.filter((run) => run.status !== 'passed')
  if (failedRuns.length === 0) {
    lines.push('- None')
  } else {
    for (const run of failedRuns) {
      lines.push(`- ${run.id}: ${run.status}${run.failureReasons.length ? ` - ${run.failureReasons.join('; ')}` : ''}`)
    }
  }
  lines.push('')
  return `${lines.join('\n').trimEnd()}\n`
}
