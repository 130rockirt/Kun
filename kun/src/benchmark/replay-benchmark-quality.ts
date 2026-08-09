import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { RuntimeEvent, type RuntimeEvent as RuntimeEventValue } from '../contracts/events.js'
import { RuntimeInfoResponse, type RuntimeInfoResponse as RuntimeInfoValue } from '../contracts/runtime-info.js'
import { TurnReasoningEffortSchema } from '../contracts/turns.js'
import type { UsageSnapshot } from '../contracts/usage.js'

import type {
  ObservedReplayEvent,
  ReplayBudgetViolation,
  ReplayHttpClient,
  ReplayQualityDimension,
  ReplayQualityResult,
  ReplayRunMetrics,
  ReplayRunResult,
  ReplayTask
} from './replay-benchmark-runner.js'

export type SseMessage = { event?: string; id?: string; data: string }

export class SseMessageDecoder {
  private buffer = ''

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const messages: SseMessage[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const message = parseSseBlock(block)
      if (message) messages.push(message)
      boundary = this.buffer.indexOf('\n\n')
    }
    return messages
  }
}

export function createReplayHttpClient(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch
): ReplayHttpClient {
  const headers = (): Headers => {
    const value = new Headers({ accept: 'application/json' })
    if (token) value.set('authorization', `Bearer ${token}`)
    return value
  }
  const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const requestHeaders = headers()
    if (init.body) requestHeaders.set('content-type', 'application/json')
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value))
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders
    })
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 1_000)
      throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${body}`)
    }
    return await response.json() as T
  }
  return {
    async getRuntimeInfo() {
      return RuntimeInfoResponse.parse(await requestJson('/v1/runtime/info'))
    },
    createThread: (body) => requestJson('/v1/threads', { method: 'POST', body: JSON.stringify(body) }),
    startTurn: (threadId, body) => requestJson(`/v1/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    async openEvents(threadId, signal) {
      const requestHeaders = headers()
      requestHeaders.set('accept', 'text/event-stream')
      const response = await fetchImpl(`${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=0`, {
        headers: requestHeaders,
        signal
      })
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 1_000)
        throw new Error(`GET events failed (${response.status}): ${body}`)
      }
      return response
    },
    async interruptTurn(threadId, turnId) {
      await requestJson(`/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`, {
        method: 'POST'
      })
    },
    async deleteThread(threadId) {
      await requestJson(`/v1/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' })
    }
  }
}

export function parseSseBlock(block: string): SseMessage | null {
  if (!block.trim()) return null
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { ...(event ? { event } : {}), ...(id ? { id } : {}), data: data.join('\n') }
}

export function parseRuntimeSseMessage(message: SseMessage): RuntimeEventValue | null {
  let value: unknown
  try {
    value = JSON.parse(message.data)
  } catch {
    return null
  }
  const parsed = RuntimeEvent.safeParse(value)
  if (parsed.success) return parsed.data
  if (message.event === 'error') {
    const detail = value && typeof value === 'object' && 'message' in value
      ? String((value as { message?: unknown }).message ?? 'unknown SSE error')
      : 'unknown SSE error'
    throw new Error(`runtime SSE error: ${detail}`)
  }
  return null
}

export function replayExpectationFailures(
  task: ReplayTask,
  timedOut: boolean,
  metrics: ReplayRunMetrics,
  events: ObservedReplayEvent[]
): string[] {
  const failures: string[] = []
  if (timedOut) failures.push('turn timed out')
  const terminal = events.find(({ event }) => event.kind === 'turn_completed' || event.kind === 'turn_failed' || event.kind === 'turn_aborted')
  if (!terminal) failures.push('no terminal turn event')
  else if (terminal.event.kind !== 'turn_completed') failures.push(`turn ended with ${terminal.event.kind}`)
  if (metrics.assistantChars < task.expect.minAssistantChars) {
    failures.push(`assistant output ${metrics.assistantChars} chars is below ${task.expect.minAssistantChars}`)
  }
  if (metrics.errorEvents > task.expect.maxErrorEvents) {
    failures.push(`error event count ${metrics.errorEvents} exceeds ${task.expect.maxErrorEvents}`)
  }
  if (task.expect.maxTotalMs && metrics.totalMs > task.expect.maxTotalMs) {
    failures.push(`total latency ${metrics.totalMs}ms exceeds ${task.expect.maxTotalMs}ms`)
  }
  const usedTools = new Set(events.flatMap(({ event }) => {
    if (!('item' in event) || !('toolName' in event.item)) return []
    return [event.item.toolName]
  }))
  for (const tool of task.expect.requiredTools) {
    if (!usedTools.has(tool)) failures.push(`required tool was not used: ${tool}`)
  }
  if (task.expect.requiredAnyTools.length > 0 && !task.expect.requiredAnyTools.some((tool) => usedTools.has(tool))) {
    failures.push(`none of the required tools were used: ${task.expect.requiredAnyTools.join(', ')}`)
  }
  return failures
}

export function evaluateReplayQuality(
  task: ReplayTask,
  metrics: ReplayRunMetrics,
  events: ObservedReplayEvent[]
): ReplayQualityResult {
  const breakdown: ReplayQualityDimension[] = []
  const violations: string[] = []
  const observation = replayQualityObservation(events)

  if (task.expect.expectedChangedFiles.length > 0) {
    const expected = uniqueNormalizedPaths(task.expect.expectedChangedFiles)
    const actual = uniqueNormalizedPaths(observation.changedFiles)
    const score = jaccard(expected, actual)
    const missing = expected.filter((path) => !actual.includes(path))
    if (missing.length > 0) violations.push(`missing expected changed file(s): ${missing.join(', ')}`)
    breakdown.push({
      dimension: 'files',
      score,
      weight: 2,
      detail: `${Math.round(score * 100)}% changed-file overlap`
    })
  }

  let hardFail = false
  if (task.expect.forbiddenBehaviors.length > 0) {
    const haystack = `${observation.behaviors.join('\n')}\n${observation.finalOutput}`.toLowerCase()
    const hits = task.expect.forbiddenBehaviors.filter((value) => haystack.includes(value.toLowerCase()))
    if (hits.length > 0) {
      hardFail = true
      violations.push(`forbidden behavior(s) detected: ${hits.join(', ')}`)
    }
    breakdown.push({
      dimension: 'forbidden',
      score: hits.length === 0 ? 1 : 0,
      weight: 3,
      detail: hits.length === 0 ? 'none detected' : hits.join(', ')
    })
  }

  if (task.expect.requiredOutputs.length > 0) {
    const output = observation.finalOutput.toLowerCase()
    const missing = task.expect.requiredOutputs.filter((value) => !output.includes(value.toLowerCase()))
    const score = 1 - missing.length / task.expect.requiredOutputs.length
    if (missing.length > 0) violations.push(`missing required output(s): ${missing.join(', ')}`)
    breakdown.push({
      dimension: 'outputs',
      score,
      weight: 2,
      detail: `${task.expect.requiredOutputs.length - missing.length}/${task.expect.requiredOutputs.length} present`
    })
  }

  if (task.expect.maxCostUsd !== undefined) {
    const withinBudget = metrics.costUsd <= task.expect.maxCostUsd
    const score = withinBudget || metrics.costUsd === 0
      ? 1
      : Math.max(0, task.expect.maxCostUsd / metrics.costUsd)
    if (!withinBudget) {
      violations.push(`cost $${metrics.costUsd.toFixed(4)} exceeds $${task.expect.maxCostUsd.toFixed(4)}`)
    }
    breakdown.push({ dimension: 'cost', score, weight: 1, detail: `$${metrics.costUsd.toFixed(4)}` })
  }

  const totalWeight = breakdown.reduce((total, item) => total + item.weight, 0)
  const weightedScore = totalWeight === 0
    ? 1
    : breakdown.reduce((total, item) => total + item.score * item.weight, 0) / totalWeight
  return {
    score: hardFail ? 0 : weightedScore,
    passed: violations.length === 0,
    violations,
    breakdown
  }
}

export function replayQualityObservation(events: ObservedReplayEvent[]): {
  finalOutput: string
  behaviors: string[]
  changedFiles: string[]
} {
  const assistantText = new Map<string, string>()
  const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown>; toolKind: string }>()
  for (const { event } of events) {
    if ('item' in event && event.item.kind === 'assistant_text') {
      if (event.kind === 'assistant_text_delta') {
        assistantText.set(event.item.id, `${assistantText.get(event.item.id) ?? ''}${event.item.text}`)
      } else {
        assistantText.set(event.item.id, event.item.text)
      }
    }
    if ('item' in event && event.item.kind === 'tool_call') {
      toolCalls.set(event.item.callId, {
        name: event.item.toolName,
        arguments: event.item.arguments,
        toolKind: event.item.toolKind
      })
    }
  }
  const changedFiles = [...toolCalls.values()]
    .filter((call) => call.toolKind === 'file_change')
    .flatMap((call) => filePathsFromArguments(call.arguments))
  return {
    finalOutput: [...assistantText.values()].join('\n'),
    behaviors: [...toolCalls.values()].map((call) => `${call.name} ${JSON.stringify(call.arguments)}`),
    changedFiles
  }
}

export function filePathsFromArguments(args: Record<string, unknown>): string[] {
  return ['path', 'filePath', 'file_path', 'targetPath', 'target_path']
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

export function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim().replace(/\\/g, '/')).filter(Boolean))]
}

export function jaccard(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return 1
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  let intersection = 0
  for (const value of expectedSet) if (actualSet.has(value)) intersection += 1
  const union = new Set([...expectedSet, ...actualSet]).size
  return union === 0 ? 1 : intersection / union
}

export function errorReplayRun(
  id: string,
  task: ReplayTask,
  iteration: number,
  error: string,
  model?: string
): ReplayRunResult {
  return {
    id,
    taskId: task.id,
    iteration,
    tags: task.tags,
    ...(model ? { model } : {}),
    status: 'error',
    failureReasons: [error],
    metrics: emptyReplayMetrics(),
    error
  }
}

export function emptyReplayMetrics(): ReplayRunMetrics {
  return {
    ttftMs: null,
    totalMs: 0,
    assistantChars: 0,
    eventCount: 0,
    errorEvents: 0,
    toolCalls: 0,
    toolDurationMs: 0,
    toolDurationP95Ms: null,
    sseDelayP50Ms: null,
    sseDelayP95Ms: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: null,
    cacheMissTokens: null,
    cacheHitRate: null,
    cacheableTokenHitRate: null,
    totalInputTokenHitRate: null,
    costUsd: 0,
    peakRssBytes: null
  }
}

export function isTerminalTurnEvent(kind: RuntimeEventValue['kind']): boolean {
  return kind === 'turn_completed' || kind === 'turn_failed' || kind === 'turn_aborted'
}

export function hasTerminalTurnEvent(events: ObservedReplayEvent[], turnId: string): boolean {
  return events.some(({ event }) => event.turnId === turnId && isTerminalTurnEvent(event.kind))
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))
  return roundMetric(sorted[index] ?? 0)
}

export function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce(sum, 0) / values.length : null
}

export function maxNullable(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null
}

export function compactNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

export function nullableDelta(current: number | null, baseline: number | null): number | null {
  return current === null || baseline === null ? null : current - baseline
}

export function isIncreaseRegression(
  current: number | null,
  baseline: number | null,
  ratio: number | undefined,
  minimumDelta: number | undefined
): boolean {
  if (current === null || baseline === null) return false
  const delta = current - baseline
  if (delta <= 0) return false
  if (minimumDelta !== undefined && delta <= minimumDelta) return false
  if (baseline <= 0) return ratio !== undefined || minimumDelta !== undefined
  return ratio === undefined || current > baseline * (1 + ratio)
}

export function roundMetric(value: number): number {
  return Math.round(value * 100) / 100
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export function sum(left: number, right: number): number {
  return left + right
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

export function addMinimumViolation(
  violations: ReplayBudgetViolation[],
  metric: string,
  actual: number | null,
  limit: number | undefined
): void {
  if (limit === undefined) return
  if (actual === null) {
    violations.push({
      metric,
      actual,
      limit,
      message: `${metric} is unavailable; required at least ${formatBudgetValue(metric, limit)}`
    })
    return
  }
  if (actual < limit) {
    violations.push({
      metric,
      actual,
      limit,
      message: `${metric} ${formatBudgetValue(metric, actual)} is below ${formatBudgetValue(metric, limit)}`
    })
  }
}

export function addMaximumViolation(
  violations: ReplayBudgetViolation[],
  metric: string,
  actual: number | null,
  limit: number | undefined
): void {
  if (limit === undefined) return
  if (actual === null) {
    violations.push({
      metric,
      actual,
      limit,
      message: `${metric} is unavailable; required at most ${formatBudgetValue(metric, limit)}`
    })
    return
  }
  if (actual > limit) {
    violations.push({
      metric,
      actual,
      limit,
      message: `${metric} ${formatBudgetValue(metric, actual)} exceeds ${formatBudgetValue(metric, limit)}`
    })
  }
}

export function appendList(lines: string[], title: string, values: string[]): void {
  lines.push(`### ${title}`, '')
  if (values.length === 0) {
    lines.push('- None', '')
    return
  }
  for (const value of values) lines.push(`- ${value}`)
  lines.push('')
}

export function formatBudgetValue(metric: string, value: number): string {
  if (metric.endsWith('Rate')) return formatPercent(value)
  if (metric.endsWith('Ms')) return `${Math.round(value)}ms`
  if (metric === 'costUsd') return `$${value.toFixed(6)}`
  if (metric.endsWith('Bytes')) return formatBytes(value)
  return String(value)
}

export function formatOptionalMs(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)}ms`
}

export function formatSignedOptionalMs(value: number | null): string {
  return value === null ? 'n/a' : `${formatSignedNumber(Math.round(value))}ms`
}

export function formatOptionalPercent(value: number | null): string {
  return value === null ? 'n/a' : formatPercent(value)
}

export function formatSignedOptionalPercent(value: number | null): string {
  return value === null ? 'n/a' : formatSignedPercent(value)
}

export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatPercent(value)}`
}

export function formatSignedFixed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

export function formatSignedNumber(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`
}

export function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
