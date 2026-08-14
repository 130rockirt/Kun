import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { RuntimeEvent, type RuntimeEvent as RuntimeEventValue } from '../contracts/events.js'
import { RuntimeInfoResponse, type RuntimeInfoResponse as RuntimeInfoValue } from '../contracts/runtime-info.js'
import { TurnReasoningEffortSchema } from '../contracts/turns.js'
import type { UsageSnapshot } from '../contracts/usage.js'

import {
  replaySuiteDefinitionHash
} from './replay-benchmark-report.js'
import {
  SseMessageDecoder,
  average,
  clampInteger,
  compactNumbers,
  createReplayHttpClient,
  errorMessage,
  errorReplayRun,
  evaluateReplayQuality,
  hasTerminalTurnEvent,
  isTerminalTurnEvent,
  maxNullable,
  parseRuntimeSseMessage,
  percentile,
  replayExpectationFailures,
  roundMetric,
  sum
} from './replay-benchmark-quality.js'

export const ReplayExpectationSchema = z.object({
  minAssistantChars: z.number().int().nonnegative().default(1),
  requiredTools: z.array(z.string().min(1)).default([]),
  requiredAnyTools: z.array(z.string().min(1)).default([]),
  requiredOutputs: z.array(z.string().min(1)).default([]),
  forbiddenBehaviors: z.array(z.string().min(1)).default([]),
  expectedChangedFiles: z.array(z.string().min(1)).default([]),
  maxErrorEvents: z.number().int().nonnegative().default(0),
  maxTotalMs: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional()
}).strict()

export const ReplayTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  prompt: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  reasoningEffort: TurnReasoningEffortSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  expect: ReplayExpectationSchema.default(() => ReplayExpectationSchema.parse({}))
}).strict()

export const ReplaySuiteSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  defaults: z.object({
    model: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    reasoningEffort: TurnReasoningEffortSchema.optional(),
    timeoutMs: z.number().int().positive().default(300_000)
  }).strict().default(() => ({ timeoutMs: 300_000 })),
  tasks: z.array(ReplayTaskSchema).min(1).max(100)
}).strict().superRefine((suite, context) => {
  const ids = new Set<string>()
  suite.tasks.forEach((task, index) => {
    if (ids.has(task.id)) {
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'id'],
        message: `duplicate replay task id: ${task.id}`
      })
    }
    ids.add(task.id)
  })
})

export type ReplaySuite = z.infer<typeof ReplaySuiteSchema>
export type ReplayTask = z.infer<typeof ReplayTaskSchema>

export type ObservedReplayEvent = {
  event: RuntimeEventValue
  receivedAtMs: number
  elapsedMs: number
}

export type ReplayRunMetrics = {
  ttftMs: number | null
  totalMs: number
  assistantChars: number
  eventCount: number
  errorEvents: number
  toolCalls: number
  toolDurationMs: number
  toolDurationP95Ms: number | null
  sseDelayP50Ms: number | null
  sseDelayP95Ms: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  cacheHitRate: number | null
  cacheableTokenHitRate: number | null
  totalInputTokenHitRate: number | null
  costUsd: number
  peakRssBytes: number | null
}

export type ReplayRunResult = {
  id: string
  taskId: string
  iteration: number
  tags: string[]
  /** Effective model used for this run, including task/suite overrides. */
  model?: string
  threadId?: string
  turnId?: string
  status: 'passed' | 'failed' | 'timeout' | 'error'
  failureReasons: string[]
  metrics: ReplayRunMetrics
  quality?: ReplayQualityResult
  error?: string
}

export type ReplayQualityDimension = {
  dimension: 'files' | 'forbidden' | 'outputs' | 'cost'
  score: number
  weight: number
  detail: string
}

export type ReplayQualityResult = {
  score: number
  passed: boolean
  violations: string[]
  breakdown: ReplayQualityDimension[]
}

export type ReplayReportSummary = {
  runCount: number
  passed: number
  failed: number
  timedOut: number
  errors: number
  successRate: number
  ttftP50Ms: number | null
  ttftP95Ms: number | null
  totalP50Ms: number | null
  totalP95Ms: number | null
  toolDurationP95Ms: number | null
  sseDelayP95Ms: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitRate: number | null
  cacheableTokenHitRate: number | null
  totalInputTokenHitRate: number | null
  costUsd: number
  peakRssBytes: number | null
}

export type ReplayComparison = {
  baselineGeneratedAt: string
  model?: string
  policy: ReplayComparisonThresholds
  modelComparisons: ReplayModelComparison[]
  successRateDelta: number
  ttftP95MsDelta: number | null
  totalP95MsDelta: number | null
  promptTokensDelta: number
  cacheHitRateDelta: number | null
  costUsdDelta: number
  peakRssBytesDelta: number | null
  regressions: string[]
}

export type ReplayModelComparison = {
  model?: string
  baselineModels: string[]
  runCount: number
  policy: ReplayComparisonThresholds
  successRateDelta: number
  ttftP95MsDelta: number | null
  totalP95MsDelta: number | null
  promptTokensDelta: number
  cacheHitRateDelta: number | null
  costUsdDelta: number
  regressions: string[]
}

export type ReplaySummaryComparison = {
  successRateDelta: number
  ttftP95MsDelta: number | null
  totalP95MsDelta: number | null
  promptTokensDelta: number
  cacheHitRateDelta: number | null
  costUsdDelta: number
  peakRssBytesDelta: number | null
  regressions: string[]
}

export const ReplayComparisonThresholdFieldSchemas = {
  maxSuccessRateDrop: z.number().min(0).max(1),
  maxTtftRelativeIncrease: z.number().nonnegative(),
  maxTtftAbsoluteIncreaseMs: z.number().nonnegative(),
  maxTotalRelativeIncrease: z.number().nonnegative(),
  maxTotalAbsoluteIncreaseMs: z.number().nonnegative(),
  maxCacheHitRateDrop: z.number().min(0).max(1),
  maxCostRelativeIncrease: z.number().nonnegative(),
  maxCostAbsoluteIncreaseUsd: z.number().nonnegative().optional(),
  maxPromptTokensRelativeIncrease: z.number().nonnegative().optional(),
  maxPromptTokensAbsoluteIncrease: z.number().int().nonnegative().optional(),
  maxPeakRssRelativeIncrease: z.number().nonnegative().optional(),
  maxPeakRssAbsoluteIncreaseBytes: z.number().int().nonnegative().optional()
}

export const ReplayComparisonThresholdsSchema = z.object({
  ...ReplayComparisonThresholdFieldSchemas,
  maxSuccessRateDrop: ReplayComparisonThresholdFieldSchemas.maxSuccessRateDrop.default(0),
  maxTtftRelativeIncrease: ReplayComparisonThresholdFieldSchemas.maxTtftRelativeIncrease.default(0.2),
  maxTtftAbsoluteIncreaseMs: ReplayComparisonThresholdFieldSchemas.maxTtftAbsoluteIncreaseMs.default(300),
  maxTotalRelativeIncrease: ReplayComparisonThresholdFieldSchemas.maxTotalRelativeIncrease.default(0.2),
  maxTotalAbsoluteIncreaseMs: ReplayComparisonThresholdFieldSchemas.maxTotalAbsoluteIncreaseMs.default(500),
  maxCacheHitRateDrop: ReplayComparisonThresholdFieldSchemas.maxCacheHitRateDrop.default(0.05),
  maxCostRelativeIncrease: ReplayComparisonThresholdFieldSchemas.maxCostRelativeIncrease.default(0.1)
}).strict()

export const ReplayComparisonThresholdOverridesSchema = z
  .object(ReplayComparisonThresholdFieldSchemas)
  .omit({
    maxPeakRssRelativeIncrease: true,
    maxPeakRssAbsoluteIncreaseBytes: true
  })
  .partial()
  .strict()

export const ReplayComparisonPolicySchema = z.object({
  defaults: ReplayComparisonThresholdsSchema.default(() => ReplayComparisonThresholdsSchema.parse({})),
  models: z.record(z.string().min(1), ReplayComparisonThresholdOverridesSchema).default({}),
  allowModelChange: z.boolean().default(false)
}).strict()

export type ReplayComparisonThresholds = z.infer<typeof ReplayComparisonThresholdsSchema>
export type ReplayComparisonPolicy = z.infer<typeof ReplayComparisonPolicySchema>

export const ReplayBudgetSchema = z.object({
  minSuccessRate: z.number().min(0).max(1).optional(),
  maxTtftP95Ms: z.number().nonnegative().optional(),
  maxTotalP95Ms: z.number().nonnegative().optional(),
  maxToolDurationP95Ms: z.number().nonnegative().optional(),
  maxSseDelayP95Ms: z.number().nonnegative().optional(),
  maxPromptTokens: z.number().int().nonnegative().optional(),
  maxTotalTokens: z.number().int().nonnegative().optional(),
  minCacheHitRate: z.number().min(0).max(1).optional(),
  minCacheableTokenHitRate: z.number().min(0).max(1).optional(),
  minTotalInputTokenHitRate: z.number().min(0).max(1).optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  maxPeakRssBytes: z.number().int().nonnegative().optional()
}).strict()

export type ReplayBudget = z.infer<typeof ReplayBudgetSchema>

export type ReplayBudgetViolation = {
  metric: string
  actual: number | null
  limit: number
  message: string
}

export type ReplayBudgetEvaluation = {
  passed: boolean
  violations: ReplayBudgetViolation[]
}

export type ReplayReport = {
  version: 1
  generatedAt: string
  suite: {
    name: string
    taskCount: number
    repeat: number
    concurrency?: number
    keepThreads?: boolean
    definitionHash?: string
    tag?: string
  }
  runtime: {
    baseUrl: string
    model?: string
    startedAt: string
    pid?: number
  }
  summary: ReplayReportSummary
  runs: ReplayRunResult[]
  comparison?: ReplayComparison
  budget?: ReplayBudgetEvaluation
}

export type RunReplaySuiteOptions = {
  baseUrl: string
  token?: string
  workspace: string
  repeat?: number
  concurrency?: number
  tag?: string
  keepThreads?: boolean
  fetchImpl?: typeof fetch
  onProgress?: (completed: number, total: number, run: ReplayRunResult) => void
}

export type ReplayHttpClient = {
  getRuntimeInfo(): Promise<RuntimeInfoValue>
  createThread(body: Record<string, unknown>): Promise<{ id: string }>
  startTurn(threadId: string, body: Record<string, unknown>): Promise<{ turnId: string }>
  openEvents(threadId: string, signal: AbortSignal): Promise<Response>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  deleteThread(threadId: string): Promise<void>
}

export async function runReplaySuite(
  suiteInput: unknown,
  options: RunReplaySuiteOptions
): Promise<ReplayReport> {
  const suite = ReplaySuiteSchema.parse(suiteInput)
  const repeat = clampInteger(options.repeat ?? 1, 1, 20)
  const concurrency = clampInteger(options.concurrency ?? 1, 1, 8)
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const client = createReplayHttpClient(baseUrl, options.token, options.fetchImpl ?? fetch)
  const runtime = await client.getRuntimeInfo()
  const selectedTasks = options.tag
    ? suite.tasks.filter((task) => task.tags.includes(options.tag!))
    : suite.tasks
  if (selectedTasks.length === 0) {
    throw new Error(`replay suite has no tasks tagged "${options.tag}"`)
  }
  const jobs = selectedTasks.flatMap((task) =>
    Array.from({ length: repeat }, (_, index) => ({ task, iteration: index + 1 }))
  )
  const runs = new Array<ReplayRunResult>(jobs.length)
  let cursor = 0
  let completed = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const jobIndex = cursor
      cursor += 1
      const job = jobs[jobIndex]
      if (!job) return
      const run = await runReplayTask({
        suite,
        task: job.task,
        iteration: job.iteration,
        runtime,
        client,
        workspace: options.workspace,
        keepThread: options.keepThreads === true
      })
      runs[jobIndex] = run
      completed += 1
      options.onProgress?.(completed, jobs.length, run)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
  const report: ReplayReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    suite: {
      name: suite.name,
      taskCount: selectedTasks.length,
      repeat,
      concurrency,
      keepThreads: options.keepThreads === true,
      definitionHash: replaySuiteDefinitionHash(suite, selectedTasks),
      ...(options.tag ? { tag: options.tag } : {})
    },
    runtime: {
      baseUrl,
      ...(runtime.model ? { model: runtime.model } : {}),
      startedAt: runtime.startedAt,
      ...(runtime.pid ? { pid: runtime.pid } : {})
    },
    summary: summarizeReplayRuns(runs),
    runs
  }
  return report
}

export async function runReplayTask(input: {
  suite: ReplaySuite
  task: ReplayTask
  iteration: number
  runtime: RuntimeInfoValue
  client: ReplayHttpClient
  workspace: string
  keepThread: boolean
}): Promise<ReplayRunResult> {
  const { suite, task, iteration, runtime, client } = input
  const runId = `${task.id}#${iteration}`
  const model = task.model ?? suite.defaults.model ?? runtime.model
  if (!model) return errorReplayRun(runId, task, iteration, 'runtime did not report a default model')
  const workspace = resolve(input.workspace, task.workspace ?? '.')
  let threadId: string | undefined
  let turnId: string | undefined
  let shouldInterrupt = false
  try {
    const thread = await client.createThread({
      title: `[replay] ${runId}`,
      titleAuto: false,
      workspace,
      model,
      ...(task.providerId ?? suite.defaults.providerId
        ? { providerId: task.providerId ?? suite.defaults.providerId }
        : {}),
      mode: 'agent',
      approvalPolicy: 'auto',
      sandboxMode: 'read-only'
    })
    threadId = thread.id
    const startedAt = performance.now()
    const turn = await client.startTurn(threadId, {
      prompt: task.prompt,
      clientSurface: 'api',
      reasoningEffort: task.reasoningEffort ?? suite.defaults.reasoningEffort ?? 'off',
      approvalPolicy: 'auto',
      sandboxMode: 'read-only',
      disableUserInput: true
    })
    turnId = turn.turnId
    const timeoutMs = task.timeoutMs ?? suite.defaults.timeoutMs
    const collected = await collectReplayEvents({
      client,
      threadId,
      turnId,
      startedAt,
      timeoutMs
    })
    shouldInterrupt = collected.timedOut || !hasTerminalTurnEvent(collected.events, turnId)
    const after = await client.getRuntimeInfo().catch(() => runtime)
    const metrics = summarizeReplayEvents(
      collected.events,
      collected.elapsedMs,
      after.memoryUsage?.peakRssBytes
    )
    const quality = evaluateReplayQuality(task, metrics, collected.events)
    const failureReasons = [
      ...replayExpectationFailures(task, collected.timedOut, metrics, collected.events),
      ...quality.violations
    ]
    return {
      id: runId,
      taskId: task.id,
      iteration,
      tags: task.tags,
      model,
      threadId,
      turnId,
      status: collected.timedOut ? 'timeout' : failureReasons.length > 0 ? 'failed' : 'passed',
      failureReasons,
      metrics,
      quality
    }
  } catch (error) {
    shouldInterrupt = turnId !== undefined
    return {
      ...errorReplayRun(runId, task, iteration, errorMessage(error), model),
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    }
  } finally {
    if (threadId && turnId && shouldInterrupt) {
      await client.interruptTurn(threadId, turnId).catch(() => undefined)
    }
    if (threadId && !input.keepThread) {
      await client.deleteThread(threadId).catch(() => undefined)
    }
  }
}

export async function collectReplayEvents(input: {
  client: ReplayHttpClient
  threadId: string
  turnId: string
  startedAt: number
  timeoutMs: number
}): Promise<{ events: ObservedReplayEvent[]; elapsedMs: number; timedOut: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs)
  timer.unref?.()
  const observed: ObservedReplayEvent[] = []
  try {
    const response = await input.client.openEvents(input.threadId, controller.signal)
    if (!response.body) throw new Error('runtime SSE response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = new SseMessageDecoder()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      for (const message of sse.push(decoder.decode(chunk.value, { stream: true }))) {
        const parsed = parseRuntimeSseMessage(message)
        if (!parsed) continue
        const receivedAtMs = Date.now()
        observed.push({
          event: parsed,
          receivedAtMs,
          elapsedMs: Math.max(0, performance.now() - input.startedAt)
        })
        if (parsed.turnId === input.turnId && isTerminalTurnEvent(parsed.kind)) {
          controller.abort()
          return {
            events: observed,
            elapsedMs: Math.max(0, performance.now() - input.startedAt),
            timedOut: false
          }
        }
      }
    }
    return {
      events: observed,
      elapsedMs: Math.max(0, performance.now() - input.startedAt),
      timedOut
    }
  } catch (error) {
    if (!timedOut && !controller.signal.aborted) throw error
    return {
      events: observed,
      elapsedMs: Math.max(0, performance.now() - input.startedAt),
      timedOut
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export function summarizeReplayEvents(
  observed: ObservedReplayEvent[],
  elapsedMs: number,
  peakRssBytes?: number
): ReplayRunMetrics {
  const firstText = observed.find(({ event }) =>
    event.kind === 'assistant_text_delta' && event.item.kind === 'assistant_text' && event.item.text.length > 0
  ) ?? observed.find(({ event }) =>
    (event.kind === 'item_created' || event.kind === 'item_completed') &&
    event.item.kind === 'assistant_text' &&
    event.item.text.length > 0
  )
  const assistantTextByItem = new Map<string, string>()
  const toolStarted = new Map<string, number>()
  const toolDurations: number[] = []
  const toolCallIds = new Set<string>()
  const sseDelays: number[] = []
  let errorEvents = 0
  let usage: UsageSnapshot | undefined
  for (const record of observed) {
    const eventTime = Date.parse(record.event.timestamp)
    if (Number.isFinite(eventTime)) sseDelays.push(Math.max(0, record.receivedAtMs - eventTime))
    if (record.event.kind === 'error' || record.event.kind === 'turn_failed') errorEvents += 1
    if (record.event.kind === 'usage') usage = record.event.usage
    if ('item' in record.event && record.event.item.kind === 'assistant_text') {
      const itemId = record.event.item.id
      if (record.event.kind === 'assistant_text_delta') {
        assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ''}${record.event.item.text}`)
      } else {
        assistantTextByItem.set(itemId, record.event.item.text)
      }
    }
    if (record.event.kind === 'tool_call_started' && 'item' in record.event && 'callId' in record.event.item) {
      toolStarted.set(record.event.item.callId, record.elapsedMs)
      toolCallIds.add(record.event.item.callId)
    }
    if (record.event.kind === 'tool_call_finished' && 'item' in record.event && 'callId' in record.event.item) {
      const started = toolStarted.get(record.event.item.callId)
      if (started !== undefined) toolDurations.push(Math.max(0, record.elapsedMs - started))
      toolCallIds.add(record.event.item.callId)
    }
  }
  const assistantChars = [...assistantTextByItem.values()].reduce((total, text) => total + text.length, 0)
  const hit = usage?.cacheHitTokens
  const miss = usage?.cacheMissTokens
  const cacheTotal = (hit ?? 0) + (miss ?? 0)
  return {
    ttftMs: firstText ? roundMetric(firstText.elapsedMs) : null,
    totalMs: roundMetric(elapsedMs),
    assistantChars,
    eventCount: observed.length,
    errorEvents,
    toolCalls: toolCallIds.size,
    toolDurationMs: roundMetric(toolDurations.reduce((total, value) => total + value, 0)),
    toolDurationP95Ms: percentile(toolDurations, 0.95),
    sseDelayP50Ms: percentile(sseDelays, 0.5),
    sseDelayP95Ms: percentile(sseDelays, 0.95),
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cacheHitTokens: hit ?? null,
    cacheMissTokens: miss ?? null,
    cacheHitRate: usage?.cacheHitRate ?? (cacheTotal > 0 ? (hit ?? 0) / cacheTotal : null),
    cacheableTokenHitRate: usage?.cacheableTokenHitRate ?? null,
    totalInputTokenHitRate: usage?.totalInputTokenHitRate ?? null,
    costUsd: usage?.costUsd ?? 0,
    peakRssBytes: peakRssBytes ?? null
  }
}

export function summarizeReplayRuns(runs: ReplayRunResult[]): ReplayReportSummary {
  const ttft = compactNumbers(runs.map((run) => run.metrics.ttftMs))
  const total = runs.map((run) => run.metrics.totalMs)
  const toolP95 = compactNumbers(runs.map((run) => run.metrics.toolDurationP95Ms))
  const sseP95 = compactNumbers(runs.map((run) => run.metrics.sseDelayP95Ms))
  const hitTokens = compactNumbers(runs.map((run) => run.metrics.cacheHitTokens)).reduce(sum, 0)
  const missTokens = compactNumbers(runs.map((run) => run.metrics.cacheMissTokens)).reduce(sum, 0)
  const cacheableRates = compactNumbers(runs.map((run) => run.metrics.cacheableTokenHitRate))
  const totalInputRates = compactNumbers(runs.map((run) => run.metrics.totalInputTokenHitRate))
  const passed = runs.filter((run) => run.status === 'passed').length
  return {
    runCount: runs.length,
    passed,
    failed: runs.filter((run) => run.status === 'failed').length,
    timedOut: runs.filter((run) => run.status === 'timeout').length,
    errors: runs.filter((run) => run.status === 'error').length,
    successRate: runs.length > 0 ? passed / runs.length : 0,
    ttftP50Ms: percentile(ttft, 0.5),
    ttftP95Ms: percentile(ttft, 0.95),
    totalP50Ms: percentile(total, 0.5),
    totalP95Ms: percentile(total, 0.95),
    toolDurationP95Ms: percentile(toolP95, 0.95),
    sseDelayP95Ms: percentile(sseP95, 0.95),
    promptTokens: runs.reduce((totalValue, run) => totalValue + run.metrics.promptTokens, 0),
    completionTokens: runs.reduce((totalValue, run) => totalValue + run.metrics.completionTokens, 0),
    totalTokens: runs.reduce((totalValue, run) => totalValue + run.metrics.totalTokens, 0),
    cacheHitRate: hitTokens + missTokens > 0 ? hitTokens / (hitTokens + missTokens) : null,
    cacheableTokenHitRate: average(cacheableRates),
    totalInputTokenHitRate: average(totalInputRates),
    costUsd: runs.reduce((totalValue, run) => totalValue + run.metrics.costUsd, 0),
    peakRssBytes: maxNullable(compactNumbers(runs.map((run) => run.metrics.peakRssBytes)))
  }
}
