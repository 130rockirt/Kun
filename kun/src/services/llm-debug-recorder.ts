import { randomUUID } from 'node:crypto'
import type { UsageSnapshot } from '../contracts/usage.js'
import { redactBrowserUseActionForPersistence } from '../contracts/browser-use.js'
import { projectToolArgumentsForPersistence } from '../domain/tool-argument-envelope.js'
import {
  MAX_MODEL_REQUEST_TRACE_PROVIDER_ID_LENGTH,
  MAX_MODEL_REQUEST_TRACE_PROVIDER_KIND_LENGTH,
  MAX_MODEL_REQUEST_TRACE_TOOL_CATALOG_ENTRIES,
  MAX_MODEL_REQUEST_TRACE_TOOL_NAME_LENGTH,
  MODEL_REQUEST_TRACE_SCHEMA_VERSION,
  type ModelRequestTraceDecoded,
  type ModelRequestTraceDelegated,
  type ModelRequestTraceFailureOrigin,
  type ModelRequestTraceLimits,
  type ModelRequestTraceBody,
  type ModelRequestTracePage,
  type ModelRequestTracePhase,
  type ModelRequestTraceRecord,
  type ModelRequestTraceToolCatalogEntry
} from '../contracts/model-request-trace.js'
import type { ModelStreamChunk } from '../ports/model-client.js'
import {
  BoundedModelTraceBodyAccumulator,
  boundedModelTraceText,
  redactModelTraceValues,
  sanitizeModelTraceHeaders,
  sanitizeModelTraceUrl
} from './model-request-trace-safety.js'
import {
  MAX_MODEL_REQUEST_TRACE_PAGE_SIZE,
  ModelRequestTraceStore
} from './model-request-trace-store.js'

/** Legacy round projection retained for `/v1/debug/llm-rounds`. */
export type LlmDebugRound = {
  id: number
  threadId: string
  turnId: string
  provider: string
  model: string
  url: string
  startedAt: string
  finishedAt: string
  durationMs: number
  requestBody: Record<string, unknown> | null
  requestBodyTruncated?: boolean
  requestBodyOriginalBytes?: number
  output: LlmDebugOutput
  retainedBytes?: number
  exchanges: ModelRequestTraceRecord[]
}

export type LlmDebugToolCall = {
  callId: string
  toolName: string
  arguments: Record<string, unknown>
}

export type LlmDebugToolResult = {
  callId: string
  toolName: string
  output: string
  isError: boolean
}

export type LlmDebugOutputTruncation = Partial<Record<
  'text' | 'reasoning' | 'toolCalls' | 'toolResults' | 'usage' | 'stopReason' | 'error',
  true
>>

export type LlmDebugOutput = {
  text: string
  reasoning: string
  toolCalls: LlmDebugToolCall[]
  toolResults: LlmDebugToolResult[]
  usage?: UsageSnapshot
  stopReason?: string
  error?: string
  truncated?: LlmDebugOutputTruncation
}

export type LlmDebugRoundMeta = {
  threadId: string
  turnId: string
  provider: string
  model: string
  toolCatalog?: readonly ModelRequestTraceToolCatalogEntry[]
  /** Exact model-only values that must never enter retained request traces. */
  redactedRequestValues?: readonly string[]
}

export type LlmHttpAttemptReason = ModelRequestTraceRecord['attemptReason']

export type LlmHttpAttemptMeta = {
  endpointFormat: string
  attempt: number
  reason: LlmHttpAttemptReason
  url: string
  headers: Record<string, string>
  bodyText: string
  secretValues?: readonly string[]
  /** Pipeline stage; defaults to `model` for existing callers. */
  phase?: ModelRequestTracePhase
  failureOrigin?: ModelRequestTraceFailureOrigin
  /** Stable failure code, e.g. `gemini_cli_setup_failed`. */
  diagnosticCode?: string
}

export type LlmCliInvocationMeta = {
  endpointFormat: string
  target: string
  bodyText: string
  delegated?: ModelRequestTraceDelegated
  phase?: ModelRequestTracePhase
}

export type LlmSdkInvocationMeta = {
  endpointFormat: string
  target: string
  bodyText: string
  secretValues?: readonly string[]
  delegated?: ModelRequestTraceDelegated
  phase?: ModelRequestTracePhase
}

/**
 * A structured failure that happened *before* any transport was attempted —
 * for example a locally unavailable credential or an invalid provider setup.
 * It produces a `not_started` trace record with no fabricated URL/headers/body,
 * so the Agent Perspective can truthfully show "no model request was made".
 */
export type LlmPhaseDiagnosticMeta = {
  phase: ModelRequestTracePhase
  failureOrigin: ModelRequestTraceFailureOrigin
  /** Stable machine-readable failure code, e.g. `gemini_cli_login_required`. */
  code: string
  message: string
  /** Exact values that must never enter the retained diagnostic. */
  secretValues?: readonly string[]
}

/** Narrow sink used by model clients to retain bounded debug data. */
export interface LlmDebugSink {
  shouldCapture?(threadId: string): boolean | Promise<boolean>
  start(meta: LlmDebugRoundMeta): LlmDebugRound
  beginHttpAttempt(round: LlmDebugRound, meta: LlmHttpAttemptMeta): ModelRequestTraceRecord
  beginCliInvocation(round: LlmDebugRound, meta: LlmCliInvocationMeta): ModelRequestTraceRecord
  beginSdkInvocation?(round: LlmDebugRound, meta: LlmSdkInvocationMeta): ModelRequestTraceRecord
  recordPhaseDiagnostic?(round: LlmDebugRound, meta: LlmPhaseDiagnosticMeta): ModelRequestTraceRecord
  captureHttpResponse(round: LlmDebugRound, record: ModelRequestTraceRecord, response: Response): void
  captureHttpError(record: ModelRequestTraceRecord, error: unknown): void
  captureTransportError(record: ModelRequestTraceRecord, error: unknown): void
  captureChunk(round: LlmDebugRound, chunk: ModelStreamChunk): void
  captureToolResult?(round: LlmDebugRound, result: LlmDebugToolResult): void
  finish(round: LlmDebugRound): Promise<void>
}

export type LlmDebugRecorderLimits = {
  capacity: number
  maxRequestBodyBytes: number
  maxResponseBodyBytes: number
  maxRoundBytes: number
  maxTotalBytes: number
  maxPageSize: number
}

export const DEFAULT_LLM_DEBUG_RECORDER_LIMITS: LlmDebugRecorderLimits = {
  capacity: 25,
  maxRequestBodyBytes: 4 * 1024 * 1024,
  maxResponseBodyBytes: 4 * 1024 * 1024,
  maxRoundBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxPageSize: MAX_MODEL_REQUEST_TRACE_PAGE_SIZE
}

export type LlmDebugRecorderOptions = Partial<LlmDebugRecorderLimits> & {
  dataDir?: string
  shouldCapture?: (threadId: string) => boolean | Promise<boolean>
}

type CaptureState = {
  requestBytes: number
  outputBytes: number
  toolCatalog: ModelRequestTraceToolCatalogEntry[]
  redactedRequestValues: string[]
  text: StringBlockAccumulator
  reasoning: StringBlockAccumulator
  pendingCaptures: Promise<void>[]
  omitResponseBodiesForRawToolArguments: boolean
}

type StringBlockAccumulator = { blocks: string[]; parts: string[] }

const DEBUG_TEXT_BLOCK_FRAGMENT_WINDOW = 256
const RAW_TOOL_ARGUMENT_RESPONSE_OMISSION = '[response body omitted: raw tool argument envelope]'

/**
 * Count/byte-bounded live recorder plus private per-thread JSONL persistence.
 * Wire records never contain provider credentials: URL/header sanitization is
 * performed synchronously before a record is put into active memory.
 */
export class LlmDebugRecorder implements LlmDebugSink {
  private readonly rounds: LlmDebugRound[] = []
  private readonly states = new WeakMap<LlmDebugRound, CaptureState>()
  private readonly activeByThread = new Map<string, Set<LlmDebugRound>>()
  private readonly limits: LlmDebugRecorderLimits
  private readonly store?: ModelRequestTraceStore
  private readonly capturePolicy?: LlmDebugRecorderOptions['shouldCapture']
  private nextId = 1
  private nextTraceSequence = 1
  private totalRetainedBytes = 0
  private activeCaptureCountValue = 0

  constructor(options: LlmDebugRecorderOptions = {}) {
    this.limits = {
      capacity: positiveInteger(options.capacity, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.capacity),
      maxRequestBodyBytes: positiveInteger(
        options.maxRequestBodyBytes,
        DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxRequestBodyBytes
      ),
      maxResponseBodyBytes: positiveInteger(
        options.maxResponseBodyBytes,
        DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxResponseBodyBytes
      ),
      maxRoundBytes: positiveInteger(options.maxRoundBytes, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxRoundBytes),
      maxTotalBytes: positiveInteger(options.maxTotalBytes, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxTotalBytes),
      maxPageSize: positiveInteger(options.maxPageSize, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxPageSize)
    }
    if (options.dataDir) this.store = new ModelRequestTraceStore(options.dataDir)
    this.capturePolicy = options.shouldCapture
  }

  shouldCapture(threadId: string): boolean | Promise<boolean> {
    return this.capturePolicy?.(threadId) ?? true
  }

  start(meta: LlmDebugRoundMeta): LlmDebugRound {
    const startedAt = new Date().toISOString()
    const round: LlmDebugRound = {
      id: this.nextId++,
      threadId: meta.threadId,
      turnId: meta.turnId,
      provider: meta.provider,
      model: meta.model,
      url: '',
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      requestBody: null,
      output: { text: '', reasoning: '', toolCalls: [], toolResults: [] },
      exchanges: []
    }
    this.states.set(round, createCaptureState(meta.toolCatalog, meta.redactedRequestValues))
    const active = this.activeByThread.get(meta.threadId) ?? new Set<LlmDebugRound>()
    active.add(round)
    this.activeByThread.set(meta.threadId, active)
    this.activeCaptureCountValue += 1
    return round
  }

  beginHttpAttempt(round: LlmDebugRound, meta: LlmHttpAttemptMeta): ModelRequestTraceRecord {
    return this.beginAttempt(round, {
      transport: 'http',
      method: 'POST',
      endpointFormat: meta.endpointFormat,
      attempt: meta.attempt,
      reason: meta.reason,
      target: meta.url,
      headers: meta.headers,
      bodyText: meta.bodyText,
      ...(meta.secretValues ? { secretValues: meta.secretValues } : {}),
      ...(meta.phase ? { phase: meta.phase } : {}),
      ...(meta.failureOrigin ? { failureOrigin: meta.failureOrigin } : {}),
      ...(meta.diagnosticCode ? { diagnosticCode: meta.diagnosticCode } : {})
    })
  }

  beginCliInvocation(round: LlmDebugRound, meta: LlmCliInvocationMeta): ModelRequestTraceRecord {
    return this.beginAttempt(round, {
      transport: 'cli',
      method: 'CLI',
      endpointFormat: meta.endpointFormat,
      attempt: 1,
      reason: 'initial',
      target: meta.target,
      headers: {},
      bodyText: meta.bodyText,
      ...(meta.delegated ? { delegated: meta.delegated } : {}),
      ...(meta.phase ? { phase: meta.phase } : {})
    })
  }

  beginSdkInvocation(round: LlmDebugRound, meta: LlmSdkInvocationMeta): ModelRequestTraceRecord {
    return this.beginAttempt(round, {
      transport: 'sdk',
      method: 'SDK',
      endpointFormat: meta.endpointFormat,
      attempt: 1,
      reason: 'initial',
      target: meta.target,
      headers: {},
      bodyText: meta.bodyText,
      ...(meta.secretValues ? { secretValues: meta.secretValues } : {}),
      ...(meta.delegated ? { delegated: meta.delegated } : {}),
      ...(meta.phase ? { phase: meta.phase } : {})
    })
  }

  recordPhaseDiagnostic(round: LlmDebugRound, meta: LlmPhaseDiagnosticMeta): ModelRequestTraceRecord {
    const startedAt = new Date().toISOString()
    const message = redactModelTraceValues(meta.message, meta.secretValues ?? [])
    const record: ModelRequestTraceRecord = {
      schemaVersion: MODEL_REQUEST_TRACE_SCHEMA_VERSION,
      id: randomUUID(),
      sequence: this.nextTraceSequence++,
      threadId: round.threadId,
      turnId: round.turnId,
      provider: round.provider,
      model: round.model,
      phase: meta.phase,
      failureOrigin: meta.failureOrigin,
      diagnosticCode: meta.code,
      endpointFormat: 'diagnostic',
      attempt: 1,
      attemptReason: 'initial',
      status: 'not_started',
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      error: message.slice(0, 2_048)
    }
    round.exchanges.push(record)
    return record
  }

  private beginAttempt(
    round: LlmDebugRound,
    meta: {
      transport: 'http' | 'cli' | 'sdk'
      method: 'POST' | 'CLI' | 'SDK'
      endpointFormat: string
      attempt: number
      reason: LlmHttpAttemptReason
      target: string
      headers: Record<string, string>
      bodyText: string
      secretValues?: readonly string[]
      delegated?: ModelRequestTraceDelegated
      phase?: ModelRequestTracePhase
      failureOrigin?: ModelRequestTraceFailureOrigin
      diagnosticCode?: string
    }
  ): ModelRequestTraceRecord {
    const state = this.stateFor(round)
    const sanitizedUrl = sanitizeModelTraceUrl(meta.target)
    const body = boundedModelTraceText(
      redactModelTraceValues(
        redactBrowserUseDebugContent(meta.bodyText),
        state.redactedRequestValues
      ),
      this.limits.maxRequestBodyBytes
    )
    const record: ModelRequestTraceRecord = {
      schemaVersion: MODEL_REQUEST_TRACE_SCHEMA_VERSION,
      id: randomUUID(),
      sequence: this.nextTraceSequence++,
      threadId: round.threadId,
      turnId: round.turnId,
      provider: round.provider,
      model: round.model,
      transport: meta.transport,
      ...(meta.phase ? { phase: meta.phase } : {}),
      ...(meta.failureOrigin ? { failureOrigin: meta.failureOrigin } : {}),
      ...(meta.diagnosticCode ? { diagnosticCode: meta.diagnosticCode } : {}),
      endpointFormat: meta.endpointFormat,
      attempt: meta.attempt,
      attemptReason: meta.reason,
      status: 'pending',
      startedAt: new Date().toISOString(),
      ...(state.toolCatalog.length
        ? { toolCatalog: state.toolCatalog.map((tool) => ({ ...tool })) }
        : {}),
      request: {
        method: meta.method,
        url: sanitizedUrl.value,
        urlRedacted: sanitizedUrl.redacted,
        headers: sanitizeModelTraceHeaders(meta.headers, meta.secretValues),
        body
      },
      ...(meta.delegated
        ? {
            delegated: {
              ...meta.delegated,
              capabilities: { ...meta.delegated.capabilities }
            }
          }
        : {})
    }
    round.exchanges.push(record)
    round.url = sanitizedUrl.value
    round.requestBodyOriginalBytes = body.originalBytes
    round.requestBodyTruncated = body.truncated
    round.requestBody = parseLegacyRequestBody(body.text, body)
    state.requestBytes = Math.max(state.requestBytes, body.capturedBytes)
    return record
  }

  captureHttpResponse(round: LlmDebugRound, record: ModelRequestTraceRecord, response: Response): void {
    const responseStartedAt = new Date().toISOString()
    record.responseStartedAt = responseStartedAt
    record.timeToHeadersMs = elapsedMs(record.startedAt, responseStartedAt)
    record.response = {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeModelTraceHeaders(response.headers)
    }
    let clone: Response
    try {
      clone = response.clone()
    } catch (error) {
      record.status = 'capture_error'
      record.response.captureError = safeError(error)
      addCaptureWarning(record, 'response clone failed')
      finishRecord(record)
      return
    }
    const capture = this.captureResponseBody(round, record, clone)
    this.stateFor(round).pendingCaptures.push(capture)
  }

  captureHttpError(record: ModelRequestTraceRecord, error: unknown): void {
    this.captureTransportError(record, error)
  }

  captureTransportError(record: ModelRequestTraceRecord, error: unknown): void {
    record.status = 'transport_error'
    record.error = safeError(error)
    finishRecord(record)
  }

  captureChunk(round: LlmDebugRound, chunk: ModelStreamChunk): void {
    const state = this.stateFor(round)
    switch (chunk.kind) {
      case 'assistant_text_delta':
        this.captureText(round, state, 'text', chunk.text)
        break
      case 'assistant_reasoning_delta':
        this.captureText(round, state, 'reasoning', chunk.text)
        break
      case 'tool_call_complete':
        if (typeof chunk.arguments.__raw === 'string') {
          this.omitRawToolArgumentResponseBodies(round, state)
        }
        this.captureToolCall(round, state, {
          callId: chunk.callId,
          toolName: chunk.toolName,
          arguments: chunk.arguments
        })
        break
      case 'usage':
        this.captureValue(round, state, chunk.usage)
        break
      case 'completed':
        this.captureString(round, state, 'stopReason', chunk.stopReason)
        break
      case 'error':
        this.captureString(round, state, 'error', chunk.message)
        break
    }
  }

  captureToolResult(round: LlmDebugRound, result: LlmDebugToolResult): void {
    const state = this.stateFor(round)
    const safeOutput = result.toolName === 'browser_use'
      ? redactBrowserUseDebugContent(result.output)
      : result.output
    const base = {
      callId: result.callId,
      toolName: result.toolName,
      output: '',
      isError: result.isError
    }
    const available = Math.max(0, this.remainingOutputBytes(state) - jsonBytes(base))
    const output = truncateJsonStringContent(safeOutput, available)
    const retained = { ...base, output }
    const bytes = jsonBytes(retained)
    if (bytes <= this.remainingOutputBytes(state)) {
      round.output.toolResults.push(retained)
      state.outputBytes += bytes
    } else {
      markTruncated(round.output, 'toolResults')
      return
    }
    if (output !== safeOutput) markTruncated(round.output, 'toolResults')
  }

  async finish(round: LlmDebugRound): Promise<void> {
    const state = this.stateFor(round)
    await Promise.allSettled(state.pendingCaptures)
    if (state.omitResponseBodiesForRawToolArguments) {
      this.omitRawToolArgumentResponseBodies(round, state)
    }
    round.output.text = joinStringBlocks(state.text)
    round.output.reasoning = joinStringBlocks(state.reasoning)
    const lastExchange = round.exchanges.at(-1)
    if (lastExchange) lastExchange.decoded = cloneDecoded(round.output)
    for (const record of round.exchanges) {
      if (record.status === 'pending') {
        record.status = record.response?.captureError ? 'capture_error' : 'completed'
        finishRecord(record)
      }
      await this.store?.append(record)
    }
    if (this.states.delete(round)) this.activeCaptureCountValue = Math.max(0, this.activeCaptureCountValue - 1)
    const active = this.activeByThread.get(round.threadId)
    active?.delete(round)
    if (active?.size === 0) this.activeByThread.delete(round.threadId)
    round.finishedAt = new Date().toISOString()
    round.durationMs = elapsedMs(round.startedAt, round.finishedAt)
    round.retainedBytes = jsonBytes(round)
    this.totalRetainedBytes += round.retainedBytes
    this.rounds.push(round)
    while (this.rounds.length > this.limits.capacity || this.totalRetainedBytes > this.limits.maxTotalBytes) {
      const removed = this.rounds.shift()
      if (!removed) break
      this.totalRetainedBytes = Math.max(0, this.totalRetainedBytes - (removed.retainedBytes ?? jsonBytes(removed)))
    }
  }

  /** Most-recent-first compatibility projection. */
  snapshot(): LlmDebugRound[] {
    return [...this.rounds].reverse()
  }

  async listThread(
    threadId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<ModelRequestTracePage> {
    const limit = Math.min(this.limits.maxPageSize, Math.max(1, Math.floor(options.limit ?? 50)))
    const active = options.cursor ? [] : this.activeRecords(threadId)
    if (active.length >= limit) {
      return {
        schemaVersion: MODEL_REQUEST_TRACE_SCHEMA_VERSION,
        records: active.slice(0, limit),
        activeCount: active.length,
        limits: this.traceLimits(),
        warnings: this.store?.warnings() ?? []
      }
    }
    const remaining = limit - active.length
    const persisted = this.store
      ? await this.store.list(threadId, { limit: remaining, cursor: options.cursor })
      : {
          records: this.rounds
            .filter((round) => round.threadId === threadId)
            .flatMap((round) => round.exchanges)
            .sort(newestRecordFirst)
            .slice(0, remaining),
          warnings: []
        }
    return {
      schemaVersion: MODEL_REQUEST_TRACE_SCHEMA_VERSION,
      records: [...active, ...persisted.records].sort(newestRecordFirst).slice(0, limit),
      ...(persisted.nextCursor ? { nextCursor: persisted.nextCursor } : {}),
      activeCount: active.length,
      limits: this.traceLimits(),
      warnings: persisted.warnings
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const active = this.activeByThread.get(threadId)
    if (active) {
      for (const round of active) {
        for (const record of round.exchanges) addCaptureWarning(record, 'thread deleted during capture')
      }
      this.activeByThread.delete(threadId)
    }
    for (let index = this.rounds.length - 1; index >= 0; index -= 1) {
      if (this.rounds[index].threadId !== threadId) continue
      this.totalRetainedBytes = Math.max(
        0,
        this.totalRetainedBytes - (this.rounds[index].retainedBytes ?? jsonBytes(this.rounds[index]))
      )
      this.rounds.splice(index, 1)
    }
    await this.store?.deleteThread(threadId)
  }

  async shutdown(): Promise<void> {
    await this.store?.shutdown()
  }

  clear(): void {
    this.rounds.length = 0
    this.totalRetainedBytes = 0
  }

  get activeCaptureCount(): number {
    return this.activeCaptureCountValue
  }

  traceLimits(): ModelRequestTraceLimits {
    return {
      maxRequestBodyBytes: this.limits.maxRequestBodyBytes,
      maxResponseBodyBytes: this.limits.maxResponseBodyBytes,
      maxPageSize: this.limits.maxPageSize
    }
  }

  private activeRecords(threadId: string): ModelRequestTraceRecord[] {
    return [...(this.activeByThread.get(threadId) ?? [])]
      .flatMap((round) => round.exchanges.map((record) => ({
        ...record,
        ...(record === round.exchanges.at(-1) ? { decoded: cloneDecodedLive(round, this.states.get(round)) } : {})
      })))
      .sort(newestRecordFirst)
  }

  private async captureResponseBody(
    round: LlmDebugRound,
    record: ModelRequestTraceRecord,
    response: Response
  ): Promise<void> {
    const accumulator = new BoundedModelTraceBodyAccumulator(this.limits.maxResponseBodyBytes)
    try {
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) accumulator.append(value)
          }
        } finally {
          try { reader.releaseLock() } catch { /* already released */ }
        }
      }
      if (record.response) {
        const body = accumulator.finish()
        record.response.body = this.stateFor(round).omitResponseBodiesForRawToolArguments
          ? omittedRawToolArgumentResponseBody(body)
          : body
      }
      record.status = 'completed'
    } catch (error) {
      if (record.response) {
        const body = accumulator.finish()
        record.response.body = this.stateFor(round).omitResponseBodiesForRawToolArguments
          ? omittedRawToolArgumentResponseBody(body)
          : body
        record.response.captureError = safeError(error)
      }
      record.status = 'capture_error'
      addCaptureWarning(record, 'response body capture failed')
    } finally {
      finishRecord(record)
    }
  }

  private captureText(
    round: LlmDebugRound,
    state: CaptureState,
    field: 'text' | 'reasoning',
    value: string
  ): void {
    if (!value) return
    const retained = truncateJsonStringContent(value, this.remainingOutputBytes(state))
    if (retained) {
      appendStringBlock(field === 'text' ? state.text : state.reasoning, retained)
      state.outputBytes += jsonStringContentBytes(retained)
    }
    if (retained !== value) markTruncated(round.output, field)
  }

  private captureToolCall(round: LlmDebugRound, state: CaptureState, call: LlmDebugToolCall): void {
    const safeCall = {
      ...call,
      arguments: projectToolArgumentsForPersistence(call.toolName === 'browser_use'
        ? redactBrowserUseActionForPersistence(call.arguments) as Record<string, unknown>
        : call.arguments).arguments
    }
    const bytes = jsonBytes(safeCall)
    if (bytes > this.remainingOutputBytes(state)) {
      markTruncated(round.output, 'toolCalls')
      return
    }
    round.output.toolCalls.push(safeCall)
    state.outputBytes += bytes
  }

  private omitRawToolArgumentResponseBodies(round: LlmDebugRound, state: CaptureState): void {
    state.omitResponseBodiesForRawToolArguments = true
    for (const record of round.exchanges) {
      if (record.response?.body) {
        record.response.body = omittedRawToolArgumentResponseBody(record.response.body)
      }
      addCaptureWarning(record, 'response body omitted because a raw tool argument envelope was observed')
    }
  }

  private captureValue(round: LlmDebugRound, state: CaptureState, value: UsageSnapshot): void {
    if (round.output.usage !== undefined) return
    const bytes = jsonBytes(value)
    if (bytes > this.remainingOutputBytes(state)) {
      markTruncated(round.output, 'usage')
      return
    }
    round.output.usage = value
    state.outputBytes += bytes
  }

  private captureString(
    round: LlmDebugRound,
    state: CaptureState,
    field: 'stopReason' | 'error',
    value: string
  ): void {
    if (round.output[field] !== undefined) return
    const retained = truncateJsonStringContent(value, this.remainingOutputBytes(state))
    if (retained) {
      round.output[field] = retained
      state.outputBytes += jsonStringContentBytes(retained)
    }
    if (retained !== value) markTruncated(round.output, field)
  }

  private remainingOutputBytes(state: CaptureState): number {
    return Math.max(0, this.limits.maxRoundBytes - state.requestBytes - state.outputBytes)
  }

  private stateFor(round: LlmDebugRound): CaptureState {
    const existing = this.states.get(round)
    if (existing) return existing
    const created = createCaptureState()
    this.states.set(round, created)
    this.activeCaptureCountValue += 1
    return created
  }
}

/**
 * Fail-closed trace preflight shared by every model transport. The policy is
 * checked exactly once at request start so a mid-stream toggle cannot produce
 * a partial record.
 */
export async function startLlmDebugRoundIfEnabled(
  sink: LlmDebugSink | undefined,
  meta: LlmDebugRoundMeta,
  onError?: () => void
): Promise<LlmDebugRound | undefined> {
  if (!sink) return undefined
  try {
    if (sink.shouldCapture && !(await sink.shouldCapture(meta.threadId))) return undefined
    return sink.start(meta)
  } catch {
    onError?.()
    return undefined
  }
}

function createCaptureState(
  toolCatalog?: readonly ModelRequestTraceToolCatalogEntry[],
  redactedRequestValues?: readonly string[]
): CaptureState {
  return {
    requestBytes: 0,
    outputBytes: 0,
    toolCatalog: normalizeTraceToolCatalog(toolCatalog),
    redactedRequestValues: normalizeRedactedRequestValues(redactedRequestValues),
    text: { blocks: [], parts: [] },
    reasoning: { blocks: [], parts: [] },
    pendingCaptures: [],
    omitResponseBodiesForRawToolArguments: false
  }
}

function omittedRawToolArgumentResponseBody(body: ModelRequestTraceBody): ModelRequestTraceBody {
  return {
    text: RAW_TOOL_ARGUMENT_RESPONSE_OMISSION,
    capturedBytes: Buffer.byteLength(RAW_TOOL_ARGUMENT_RESPONSE_OMISSION, 'utf8'),
    originalBytes: body.originalBytes,
    truncated: true
  }
}

function normalizeRedactedRequestValues(input: readonly string[] | undefined): string[] {
  if (!input?.length) return []
  return [...new Set(input.filter((value) => value.trim().length > 0))]
    .sort((left, right) => right.length - left.length)
}

function normalizeTraceToolCatalog(
  input: readonly ModelRequestTraceToolCatalogEntry[] | undefined
): ModelRequestTraceToolCatalogEntry[] {
  if (!input?.length) return []
  const out: ModelRequestTraceToolCatalogEntry[] = []
  for (const entry of input.slice(0, MAX_MODEL_REQUEST_TRACE_TOOL_CATALOG_ENTRIES)) {
    const name = boundedCatalogValue(entry.name, MAX_MODEL_REQUEST_TRACE_TOOL_NAME_LENGTH)
    if (!name) continue
    const providerKind = boundedCatalogValue(
      entry.providerKind,
      MAX_MODEL_REQUEST_TRACE_PROVIDER_KIND_LENGTH
    )
    const providerId = boundedCatalogValue(
      entry.providerId,
      MAX_MODEL_REQUEST_TRACE_PROVIDER_ID_LENGTH
    )
    out.push({
      name,
      ...(providerKind ? { providerKind } : {}),
      ...(providerId ? { providerId } : {})
    })
  }
  return out
}

function boundedCatalogValue(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function appendStringBlock(accumulator: StringBlockAccumulator, value: string): void {
  accumulator.parts.push(value)
  if (accumulator.parts.length < DEBUG_TEXT_BLOCK_FRAGMENT_WINDOW) return
  accumulator.blocks.push(accumulator.parts.join(''))
  accumulator.parts = []
}

function joinStringBlocks(accumulator: StringBlockAccumulator): string {
  if (accumulator.parts.length === 0) return accumulator.blocks.join('')
  return [...accumulator.blocks, accumulator.parts.join('')].join('')
}

function cloneDecoded(output: LlmDebugOutput): ModelRequestTraceDecoded {
  return {
    text: output.text,
    reasoning: output.reasoning,
    toolCalls: output.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })),
    ...(output.toolResults.length
      ? { toolResults: output.toolResults.map((result) => ({ ...result })) }
      : {}),
    ...(output.usage ? { usage: { ...output.usage } } : {}),
    ...(output.stopReason ? { stopReason: output.stopReason } : {}),
    ...(output.error ? { error: output.error } : {}),
    ...(output.truncated ? { truncated: { ...output.truncated } } : {})
  }
}

function cloneDecodedLive(round: LlmDebugRound, state: CaptureState | undefined): ModelRequestTraceDecoded {
  if (!state) return cloneDecoded(round.output)
  return cloneDecoded({
    ...round.output,
    text: joinStringBlocks(state.text),
    reasoning: joinStringBlocks(state.reasoning)
  })
}

function parseLegacyRequestBody(
  value: string,
  body: { truncated: boolean; originalBytes: number }
): Record<string, unknown> | null {
  if (body.truncated) return { __debugTruncated: true, originalBytes: body.originalBytes, jsonPrefix: value }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return { __debugInvalidJson: true, raw: value }
  }
}

function finishRecord(record: ModelRequestTraceRecord): void {
  const finishedAt = new Date().toISOString()
  record.finishedAt = finishedAt
  record.durationMs = elapsedMs(record.startedAt, finishedAt)
}

function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start))
}

function addCaptureWarning(record: ModelRequestTraceRecord, warning: string): void {
  const warnings = record.captureWarnings ?? (record.captureWarnings = [])
  if (!warnings.includes(warning)) warnings.push(warning)
}

function markTruncated(output: LlmDebugOutput, field: keyof LlmDebugOutputTruncation): void {
  const truncated = output.truncated ?? (output.truncated = {})
  truncated[field] = true
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') } catch { return 0 }
}

function truncateJsonStringContent(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (jsonStringContentBytes(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const prefix = safeStringPrefix(value, middle)
    if (jsonStringContentBytes(prefix) <= maxBytes) {
      best = prefix
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function jsonStringContentBytes(value: string): number {
  const serialized = JSON.stringify(value)
  return Buffer.byteLength(serialized.slice(1, -1), 'utf8')
}

function safeStringPrefix(value: string, length: number): string {
  let end = Math.min(value.length, Math.max(0, length))
  if (end > 0) {
    const last = value.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
  }
  return value.slice(0, end)
}

export function redactBrowserUseDebugContent(value: string): string {
  const withoutImages = value.replace(
    /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi,
    'data:image/[redacted];base64,[redacted]'
  )
  try {
    const parsed = JSON.parse(withoutImages)
    return JSON.stringify(redactBrowserUseDebugValue(parsed, 0))
  } catch {
    return withoutImages
  }
}

function redactBrowserUseDebugValue(value: unknown, depth: number): unknown {
  if (depth > 64) return '[redacted:depth-limit]'
  if (typeof value === 'string') {
    const withoutImages = value.replace(
      /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi,
      'data:image/[redacted];base64,[redacted]'
    )
    if (
      withoutImages.includes('browser_snapshot') ||
      withoutImages.includes('browser_screenshot') ||
      withoutImages.includes('"browser_use"')
    ) {
      try {
        const nested = JSON.parse(withoutImages)
        if (nested !== withoutImages) {
          return JSON.stringify(redactBrowserUseDebugValue(nested, depth + 1))
        }
      } catch {
        // Plain untrusted page text is retained only within the normal trace limit.
      }
    }
    return withoutImages
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactBrowserUseDebugValue(entry, depth + 1))
  }
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    output[key] = redactBrowserUseDebugValue(child, depth + 1)
  }
  if (record.kind === 'browser_screenshot') {
    delete output.images
    delete output.data_base64
    output.images_omitted = Array.isArray(record.images) ? record.images.length : 1
  }
  if (record.kind === 'browser_snapshot' && output.snapshot && typeof output.snapshot === 'object') {
    const snapshot = output.snapshot as Record<string, unknown>
    output.snapshot = {
      ...snapshot,
      title: '[redacted]',
      nodes: [],
      truncated: true
    }
  }
  if (record.name === 'browser_use' || record.toolName === 'browser_use') {
    if (typeof record.arguments === 'string') {
      try {
        output.arguments = JSON.stringify(
          redactBrowserUseActionForPersistence(JSON.parse(record.arguments))
        )
      } catch {
        output.arguments = '{"action":"invalid"}'
      }
    } else if (record.arguments !== undefined) {
      output.arguments = redactBrowserUseActionForPersistence(record.arguments)
    }
    if (record.input !== undefined) {
      output.input = redactBrowserUseActionForPersistence(record.input)
    }
  }
  return output
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096)
}

function newestRecordFirst(left: ModelRequestTraceRecord, right: ModelRequestTraceRecord): number {
  const timestamp = right.startedAt.localeCompare(left.startedAt)
  if (timestamp !== 0) return timestamp
  const sequence = right.sequence - left.sequence
  return sequence === 0 ? right.id.localeCompare(left.id) : sequence
}
