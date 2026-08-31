import type { TurnItem } from '../contracts/items.js'
import type { ModelRequestTraceRecord } from '../contracts/model-request-trace.js'
import {
  TRAJECTORY_SCHEMA_VERSION,
  TrajectoryDetailSchema,
  TrajectoryPageSchema,
  TrajectorySummarySchema,
  type TrajectoryDetail,
  type TrajectoryDetailSection,
  type TrajectoryFilter,
  type TrajectoryPage,
  type TrajectoryRecord,
  type TrajectoryRequestRecord,
  type TrajectoryStatus,
  type TrajectorySummary,
  type TrajectoryToolRecord
} from '../contracts/trajectory.js'
import type { SessionStore } from '../ports/session-store.js'
import type { LlmDebugRecorder } from './llm-debug-recorder.js'
import { TRAJECTORY_SEARCH_PREVIEW_BYTES } from './trajectory-content-store.js'

const MAX_QUERY_RECORDS = 20_000
const REQUEST_PAGE_SIZE = 200

export type TrajectoryQuery = {
  limit: number
  cursor?: string
  filter: TrajectoryFilter
  query: string
}

export class TrajectoryQueryService {
  constructor(
    private readonly recorder: LlmDebugRecorder,
    private readonly sessions: SessionStore
  ) {}

  async page(threadId: string, query: TrajectoryQuery): Promise<TrajectoryPage> {
    const source = await this.source(threadId)
    const filtered = source.records
      .filter((record) => matchesFilter(record, query.filter))
      .filter((record) => matchesQuery(record, query.query))
      .filter((record) => beforeCursor(record, query.cursor))
    const records = filtered.slice(0, query.limit)
    const nextCursor = filtered.length > query.limit && records.length
      ? encodeCursor(records.at(-1)!)
      : undefined
    return TrajectoryPageSchema.parse({
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      records,
      ...(nextCursor ? { nextCursor } : {}),
      summary: source.summary,
      warnings: source.warnings,
      historyIncomplete: source.truncated
    })
  }

  async summary(threadId: string): Promise<TrajectorySummary> {
    return (await this.source(threadId)).summary
  }

  async detail(
    threadId: string,
    recordId: string,
    section: TrajectoryDetailSection
  ): Promise<TrajectoryDetail | null> {
    const source = await this.source(threadId)
    const record = source.records.find((candidate) => candidate.id === recordId)
    if (!record) return null
    const trace = record.kind === 'llm_request'
      ? source.requests.find((candidate) => candidate.id === record.requestId)
      : undefined
    const base = {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      recordId,
      section,
      state: record.detailState,
      truncated: record.detailState === 'truncated'
    }
    if (section === 'overview' || section === 'raw') {
      return TrajectoryDetailSchema.parse({ ...base, content: section === 'raw' ? record : overview(record) })
    }
    if (record.kind === 'llm_request') {
      return TrajectoryDetailSchema.parse(await this.requestDetail(threadId, record, trace, section, source.items, base))
    }
    return TrajectoryDetailSchema.parse(this.itemDetail(record, section, source.items, base))
  }

  private async requestDetail(
    threadId: string,
    record: TrajectoryRequestRecord,
    trace: ModelRequestTraceRecord | undefined,
    section: TrajectoryDetailSection,
    items: TurnItem[],
    base: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (section === 'usage') return { ...base, content: record.usage ?? null }
    if (section === 'timing') return { ...base, content: timing(record) }
    if (section === 'output' || section === 'result') {
      return {
        ...base,
        state: 'available',
        content: items
          .filter((item) => item.turnId === record.turnId && outputItem(item))
          .map(publicItemDetail)
      }
    }
    if (section !== 'input' && section !== 'arguments') return base
    if (trace?.manifestId) {
      const captured = await this.recorder.loadPromptManifestContent(threadId, trace.manifestId)
      if (captured) {
        return {
          ...base,
          state: captured.parts.some((part) => part.truncated) ? 'truncated' : 'available',
          truncated: captured.parts.some((part) => part.truncated),
          content: { manifest: captured.manifest, parts: captured.parts }
        }
      }
      return { ...base, state: 'evicted', warning: 'captured prompt detail was evicted' }
    }
    if (trace?.request?.body && trace.request.body.originalBytes > 0) {
      return { ...base, state: 'legacy', content: legacyBody(trace.request.body.text) }
    }
    return { ...base, state: 'not_captured', warning: 'complete request content was not captured' }
  }

  private itemDetail(
    record: Exclude<TrajectoryRecord, TrajectoryRequestRecord>,
    section: TrajectoryDetailSection,
    items: TurnItem[],
    base: Record<string, unknown>
  ): Record<string, unknown> {
    if (section === 'timing') return { ...base, content: timing(record) }
    const itemIds = record.kind === 'tool'
      ? [record.argumentsItemId, record.resultItemId]
      : [record.itemId]
    const selected = items.filter((item) => itemIds.includes(item.id)).map(publicItemDetail)
    if (section === 'usage') return { ...base, content: null }
    return { ...base, state: 'available', content: selected }
  }

  private async source(threadId: string): Promise<{
    records: TrajectoryRecord[]
    requests: ModelRequestTraceRecord[]
    items: TurnItem[]
    summary: TrajectorySummary
    warnings: string[]
    truncated: boolean
  }> {
    const [requestSource, items] = await Promise.all([
      loadAllRequests(this.recorder, threadId),
      this.sessions.loadItems(threadId)
    ])
    const requestRecords = projectRequests(requestSource.records)
    const itemRecords = projectItems(items, requestRecords)
    const records = [...requestRecords, ...itemRecords]
      .sort(newestFirst)
      .slice(0, MAX_QUERY_RECORDS)
    return {
      records,
      requests: requestSource.records,
      items,
      summary: summarize(records),
      warnings: requestSource.warnings,
      truncated: requestSource.truncated || requestRecords.length + itemRecords.length > MAX_QUERY_RECORDS
    }
  }
}

async function loadAllRequests(recorder: LlmDebugRecorder, threadId: string): Promise<{
  records: ModelRequestTraceRecord[]
  warnings: string[]
  truncated: boolean
}> {
  const records = new Map<string, ModelRequestTraceRecord>()
  const warnings = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await recorder.listThread(threadId, { limit: REQUEST_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    for (const record of page.records) records.set(record.id, record)
    page.warnings.forEach((warning) => warnings.add(warning))
    cursor = page.nextCursor
  } while (cursor && records.size < MAX_QUERY_RECORDS)
  return { records: [...records.values()], warnings: [...warnings], truncated: Boolean(cursor) }
}

function projectRequests(records: ModelRequestTraceRecord[]): TrajectoryRequestRecord[] {
  const steps = new Map<string, Map<string, number>>()
  return [...records].sort(oldestTraceFirst).map((trace) => {
    const roundId = trace.roundId ?? trace.id
    const turnSteps = steps.get(trace.turnId) ?? new Map<string, number>()
    const step = trace.step ?? turnSteps.get(roundId) ?? turnSteps.size
    turnSteps.set(roundId, step)
    steps.set(trace.turnId, turnSteps)
    const usage = trace.decoded?.usage
    return {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      id: `request:${trace.id}`,
      kind: 'llm_request',
      threadId: trace.threadId,
      turnId: trace.turnId,
      roundId,
      requestId: trace.id,
      step,
      attempt: trace.attempt,
      attemptReason: trace.attemptReason,
      purpose: trace.purpose ?? (trace.turnId.endsWith('_title') ? 'title' : 'assistant'),
      provider: trace.provider,
      model: trace.model,
      endpointFormat: trace.endpointFormat,
      status: trajectoryStatus(trace),
      startedAt: trace.startedAt,
      ...(trace.firstTokenAt ? { firstTokenAt: trace.firstTokenAt } : {}),
      ...(trace.finishedAt ? { completedAt: trace.finishedAt } : {}),
      ...(trace.durationMs !== undefined ? { durationMs: trace.durationMs } : {}),
      ...(trace.response?.status ? { responseStatus: trace.response.status } : {}),
      ...(usage ? { usage } : {}),
      ...(trace.manifestId ? { manifestId: trace.manifestId } : {}),
      preview: boundedPreview(trace.error || trace.decoded?.error || `${trace.model} · ${trace.provider}`),
      detailState: trace.manifestId
        ? 'available'
        : trace.captureMode !== 'metadata' && (trace.request?.body.originalBytes ?? 0) > 0
          ? 'legacy'
          : 'not_captured',
      ...(trace.diagnosticCode ? { errorCode: trace.diagnosticCode } : {}),
      ...((trace.error || trace.decoded?.error)
        ? { errorMessage: boundedPreview(trace.error || trace.decoded?.error || '') }
        : {})
    }
  })
}

function projectItems(items: TurnItem[], requests: TrajectoryRequestRecord[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = []
  const resultByCall = new Map(items
    .filter((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
    .map((item) => [item.callId, item]))
  const turns = new Map<string, number>()
  for (const item of items) {
    const request = latestRequestBefore(requests, item.turnId, item.createdAt)
    const roundId = request?.roundId ?? `turn:${item.turnId}`
    const step = request?.step ?? turns.get(item.turnId) ?? 0
    turns.set(item.turnId, step)
    if (item.kind === 'tool_call') {
      const result = resultByCall.get(item.callId)
      records.push(projectTool(item, result, request, roundId, step))
      continue
    }
    if (item.kind === 'tool_result' || !['user_message', 'assistant_text', 'assistant_reasoning', 'compaction'].includes(item.kind)) continue
    const kind = item.kind === 'user_message'
      ? 'input'
      : item.kind === 'compaction'
        ? 'compaction'
        : 'assistant'
    records.push({
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      id: `item:${item.id}`,
      kind,
      threadId: item.threadId,
      turnId: item.turnId,
      roundId,
      step,
      status: item.status === 'failed' ? 'failed' : item.status === 'aborted' ? 'cancelled' : 'completed',
      startedAt: item.createdAt,
      ...(item.finishedAt ? { completedAt: item.finishedAt } : {}),
      ...(item.finishedAt ? { durationMs: elapsed(item.createdAt, item.finishedAt) } : {}),
      itemId: item.id,
      ...(request ? { parentRequestId: request.requestId } : {}),
      preview: boundedPreview(itemPreview(item)),
      detailState: 'available'
    })
  }
  return records
}

function projectTool(
  call: Extract<TurnItem, { kind: 'tool_call' }>,
  result: Extract<TurnItem, { kind: 'tool_result' }> | undefined,
  request: TrajectoryRequestRecord | undefined,
  roundId: string,
  step: number
): TrajectoryToolRecord {
  const status: TrajectoryStatus = result?.isError
    ? 'failed'
    : result
      ? 'completed'
      : call.status === 'aborted'
        ? 'cancelled'
        : 'running'
  const completedAt = result?.finishedAt ?? result?.createdAt ?? call.finishedAt
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    id: `tool:${call.callId}`,
    kind: 'tool',
    threadId: call.threadId,
    turnId: call.turnId,
    roundId,
    step,
    status,
    startedAt: call.createdAt,
    ...(completedAt ? { completedAt, durationMs: elapsed(call.createdAt, completedAt) } : {}),
    callId: call.callId,
    ...(request ? { parentRequestId: request.requestId } : {}),
    toolName: call.toolName,
    argumentsItemId: call.id,
    ...(result ? { resultItemId: result.id } : {}),
    isError: result?.isError === true,
    preview: boundedPreview(`${call.toolName} ${call.summary ?? stringifyPreview(call.arguments)}`),
    detailState: 'available',
    ...(result?.isError ? { errorMessage: boundedPreview(stringifyPreview(result.output)) } : {})
  }
}

function summarize(records: TrajectoryRecord[]): TrajectorySummary {
  const requests = records.filter((record): record is TrajectoryRequestRecord => record.kind === 'llm_request')
  let inputTokens = 0; let outputTokens = 0; let reasoningTokens = 0
  let cacheReadTokens = 0; let cacheWriteTokens = 0; let totalDurationMs = 0
  let costUsd = 0; let costCny = 0; let valueEstimateUsd = 0; let valueEstimateCny = 0
  let ttftTotal = 0; let ttftCount = 0; let tpsTotal = 0; let tpsCount = 0
  for (const request of requests) {
    const usage = request.usage
    inputTokens += usage?.promptTokens ?? 0
    outputTokens += usage?.completionTokens ?? 0
    reasoningTokens += usage?.reasoningTokens ?? 0
    cacheReadTokens += usage?.cacheHitTokens ?? usage?.cachedTokens ?? 0
    cacheWriteTokens += usage?.cacheWriteTokens ?? 0
    totalDurationMs += request.durationMs ?? 0
    costUsd += usage?.costUsd ?? 0; costCny += usage?.costCny ?? 0
    valueEstimateUsd += usage?.valueEstimateUsd ?? 0; valueEstimateCny += usage?.valueEstimateCny ?? 0
    if (usage?.requestTtftMs !== undefined) { ttftTotal += usage.requestTtftMs; ttftCount += 1 }
    if (usage?.requestGenerationMs && usage.completionTokens > 0) {
      tpsTotal += usage.completionTokens / (usage.requestGenerationMs / 1_000); tpsCount += 1
    }
  }
  const cacheTotal = cacheReadTokens + Math.max(0, inputTokens - cacheReadTokens)
  return TrajectorySummarySchema.parse({
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    requestCount: requests.length,
    toolCount: records.filter((record) => record.kind === 'tool').length,
    runningCount: records.filter((record) => record.status === 'running').length,
    failedCount: records.filter((record) => record.status === 'failed').length,
    inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
    cacheHitRate: cacheTotal > 0 ? cacheReadTokens / cacheTotal : null,
    avgTtftMs: ttftCount ? ttftTotal / ttftCount : null,
    avgTokensPerSecond: tpsCount ? tpsTotal / tpsCount : null,
    totalDurationMs, costUsd, costCny, valueEstimateUsd, valueEstimateCny,
    lastStatus: requests[0]?.status ?? null
  })
}

function matchesFilter(record: TrajectoryRecord, filter: TrajectoryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'llm') return record.kind === 'llm_request' || record.kind === 'assistant'
  if (filter === 'tool') return record.kind === 'tool'
  return record.status === 'failed' || record.status === 'cancelled' || record.status === 'interrupted'
}

function matchesQuery(record: TrajectoryRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return JSON.stringify(record).slice(0, 16_384).toLowerCase().includes(normalized)
}

function beforeCursor(record: TrajectoryRecord, cursor: string | undefined): boolean {
  if (!cursor) return true
  const decoded = decodeCursor(cursor)
  if (!decoded) return true
  const byTime = record.startedAt.localeCompare(decoded.startedAt)
  return byTime < 0 || (byTime === 0 && record.id.localeCompare(decoded.id) < 0)
}

function encodeCursor(record: TrajectoryRecord): string {
  return Buffer.from(JSON.stringify({ v: 1, startedAt: record.startedAt, id: record.id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { startedAt: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
    return value.v === 1 && typeof value.startedAt === 'string' && typeof value.id === 'string'
      ? { startedAt: value.startedAt, id: value.id }
      : null
  } catch { return null }
}

function trajectoryStatus(trace: ModelRequestTraceRecord): TrajectoryStatus {
  if (trace.status === 'pending') return 'running'
  if (trace.status === 'cancelled') return 'cancelled'
  if (trace.status === 'interrupted') return 'interrupted'
  if (['transport_error', 'capture_error', 'failed', 'not_started'].includes(trace.status)) return 'failed'
  return trace.decoded?.error ? 'failed' : 'completed'
}

function latestRequestBefore(
  requests: TrajectoryRequestRecord[],
  turnId: string,
  timestamp: string
): TrajectoryRequestRecord | undefined {
  return requests
    .filter((request) => request.turnId === turnId && request.startedAt <= timestamp)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

function newestFirst(left: TrajectoryRecord, right: TrajectoryRecord): number {
  return right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)
}

function oldestTraceFirst(left: ModelRequestTraceRecord, right: ModelRequestTraceRecord): number {
  return left.startedAt.localeCompare(right.startedAt) || left.sequence - right.sequence
}

function outputItem(item: TurnItem): boolean {
  return item.kind === 'assistant_text' || item.kind === 'assistant_reasoning' ||
    item.kind === 'tool_call' || item.kind === 'tool_result'
}

function publicItemDetail(item: TurnItem): unknown {
  if (item.kind === 'tool_result') return { ...item, output: boundedPreview(stringifyPreview(item.output), 16_384) }
  if (item.kind === 'tool_call') return { ...item, arguments: boundedPreview(stringifyPreview(item.arguments), 16_384) }
  return item
}

function overview(record: TrajectoryRecord): unknown {
  const { preview: _preview, ...rest } = record
  return rest
}

function timing(record: TrajectoryRecord): unknown {
  return {
    startedAt: record.startedAt,
    firstTokenAt: record.firstTokenAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    ttftMs: record.firstTokenAt ? elapsed(record.startedAt, record.firstTokenAt) : undefined
  }
}

function itemPreview(item: TurnItem): string {
  if (item.kind === 'user_message' || item.kind === 'assistant_text' || item.kind === 'assistant_reasoning') return item.text
  if (item.kind === 'compaction') return item.summary
  return item.kind
}

function legacyBody(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return value }
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function boundedPreview(value: string, max = TRAJECTORY_SEARCH_PREVIEW_BYTES): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 20))}… [truncated]`
}

function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start))
}
