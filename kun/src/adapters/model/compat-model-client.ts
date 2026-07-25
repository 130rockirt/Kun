import { randomUUID } from 'node:crypto'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import type { ModelCapabilityMetadata } from '../../contracts/capabilities.js'
import type { LlmDebugRound, LlmDebugSink } from '../../services/llm-debug-recorder.js'
import { repairToolArguments } from './tool-argument-repair.js'
import type { ModelRequestRetryConfig } from '../../config/kun-config.js'
import {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  isCustomModelEndpointFormat,
  modelEndpointPath,
  normalizeModelEndpointFormat,
  resolveModelEndpointFormat,
  usesChatCompletionsShape,
  type ModelEndpointFormat
} from '../../contracts/model-endpoint-format.js'
import { createProxyFetch } from './proxy-fetch.js'
import { resolveCompatModelCapabilities } from './compat-capabilities.js'
import {
  DEFAULT_MODEL_STREAM_LIMITS,
  ModelStreamResourceBudget,
  ModelStreamResourceLimitError,
  type ModelStreamLimits,
  type PendingToolCall
} from './model-stream-resource-budget.js'
import { normalizeCompatUsage } from './compat-usage-normalizer.js'
import {
  normalizeModelRequestRetryConfig,
  retryDelayMs,
  sleepWithAbort
} from './compat-retry-policy.js'
import {
  buildCompatRequestHeaders,
  classifyCompatHttpError,
  compatHttpFailureLog,
  redactUrlForLog
} from './compat-http-diagnostics.js'
import type { CompatChatMessage } from './compat-request-codecs.js'
import { projectCompatMessages } from './compat-message-projector.js'
import {
  codexModelSupportsNativeImageGeneration,
  createCompatRequestCodecs,
  normalizeToolSpecs,
  requiresReasoningRoundTrip
} from './compat-request-builder.js'
import { decodeChatCompletionsStreamPayload } from './chat-completions-stream-decoder.js'
import { decodeResponsesStreamPayload } from './responses-stream-decoder.js'
import { decodeAnthropicMessagesStreamPayload } from './anthropic-messages-stream-decoder.js'
import { decodeCompatNonStreamingResponse } from './compat-non-streaming-decoder.js'
import { IncrementalSseFrameBuffer } from './incremental-sse-frame-buffer.js'

export { redactUrlForLog } from './compat-http-diagnostics.js'

export {
  DEFAULT_MODEL_STREAM_LIMITS,
  type ModelStreamLimits
} from './model-stream-resource-budget.js'

/**
 * Configuration for the compatible HTTP model client. Chat
 * completions remains the default, while custom providers can opt into
 * OpenAI Responses or Anthropic Messages request/response shapes.
 */
export type CompatModelClientConfig = {
  baseUrl: string
  apiKey: string
  model: string
  /** Compatible request/response protocol to use for custom providers. */
  endpointFormat?: ModelEndpointFormat
  /** Optional extra headers, e.g. project or session ids. */
  headers?: Record<string, string>
  /**
   * Resolves protected request credentials immediately before each HTTP call.
   * Passing the rejected access token after a 401 lets OAuth implementations
   * rotate it once without racing concurrent requests.
   */
  resolveCredentials?: (
    rejectedAccessToken?: string
  ) => Promise<{ apiKey: string; headers?: Record<string, string>; refreshable: boolean }>
  /** HTTP fetch implementation. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Optional proxy URL used only for model HTTP requests. */
  modelProxyUrl?: string
  /** Maximum number of messages to send. Defaults to the entire history. */
  historyLimit?: number
  /** When true, the client requests a non-streaming response. */
  nonStreaming?: boolean
  /** Maximum idle time between streaming chunks before the turn fails. */
  streamIdleTimeoutMs?: number
  /** Resource ceilings for one provider SSE response. */
  streamLimits?: Partial<ModelStreamLimits>
  /** 流式响应开始前,遇到临时失败或限流响应时使用的 HTTP 重试策略。 */
  retry?: ModelRequestRetryConfig
  /** Optional model capability resolver used for provider-specific reasoning translation. */
  modelCapabilities?: (model: string) => ModelCapabilityMetadata
  /** Optional troubleshooting sink that captures each request body + raw output. */
  debugSink?: LlmDebugSink
}

type ChatMessage = CompatChatMessage
type ModelStopReason = Extract<ModelStreamChunk, { kind: 'completed' }>['stopReason']

function mergeStreamFinishReason(current: string | null, next: string): string {
  if (current && current !== 'stop' && next === 'stop') return current
  return next
}

type ChatCompletionResponse = {
  id: string
  model: string
  choices: {
    index: number
    finish_reason: string
    message: ChatMessage & {
      tool_calls?: {
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_eval_count?: number
    eval_count?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type StreamReadResult =
  | { kind: 'chunk'; value?: Uint8Array; done: boolean }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }
type StreamPayloadResult = {
  chunks: ModelStreamChunk[]
  sawTextDelta: boolean
  finishReason: string | null
  usage: UsageSnapshot | null
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000

function isCodexEndpoint(baseUrl: string): boolean {
  return baseUrl.includes('chatgpt.com/backend-api/codex')
}

/**
 * Multi-provider HTTP model client.
 *
 * Speaks the streaming chat completions shape by default, and can switch
 * to OpenAI Responses or Anthropic Messages request/response shapes per
 * provider via `endpointFormat`. It supports tool calls, cache hit/miss
 * counters (when the provider reports them), and abort-signal
 * cancellation. The client is deliberately small so the rest of the
 * runtime can be built around the `ModelClient` port.
 */
export class CompatModelClient implements ModelClient {
  readonly provider = 'compat'
  readonly model: string

  private readonly config: CompatModelClientConfig
  private readonly fetchImpl: typeof fetch
  private readonly codexSessionId: string | undefined

  constructor(config: CompatModelClientConfig) {
    this.config = config
    this.model = config.model
    this.fetchImpl = config.fetchImpl ?? createProxyFetch(config.modelProxyUrl ?? '') ?? fetch
    this.codexSessionId = isCodexEndpoint(config.baseUrl)
      ? config.headers?.session_id?.trim() || randomUUID()
      : undefined
  }

  /**
   * Streams the model response for a turn. Each yielded chunk is one
   * of the kinds defined by `ModelStreamChunk`. The stream respects
   * the request's `abortSignal` between chunks.
   */
  /**
   * Public entry point. When a `debugSink` is configured, captures the
   * literal request body and accumulates the raw output for the
   * troubleshooting view; otherwise forwards with zero overhead.
   */
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const sink = this.config.debugSink
    if (!sink) {
      yield* this.streamInner(request, null)
      return
    }
    const round = ignoreModelTraceFailure(() => sink.start({
      threadId: request.threadId,
      turnId: request.turnId,
      provider: this.provider,
      model: request.model?.trim() || this.config.model,
      toolCatalog: request.tools.map((tool) => ({
        name: tool.name,
        ...(tool.providerKind ? { providerKind: tool.providerKind } : {}),
        ...(tool.providerId ? { providerId: tool.providerId } : {})
      }))
    })) ?? null
    if (!round) {
      yield* this.streamInner(request, null)
      return
    }
    try {
      for await (const chunk of this.streamInner(request, round)) {
        ignoreModelTraceFailure(() => sink.captureChunk(round, chunk))
        yield chunk
      }
    } finally {
      try {
        await sink.finish(round)
      } catch {
        warnModelTraceFailure()
      }
    }
  }

  private async *streamInner(
    request: ModelRequest,
    round: LlmDebugRound | null
  ): AsyncIterable<ModelStreamChunk> {
    if (request.abortSignal.aborted) {
      yield { kind: 'error', message: 'request was aborted before start' }
      return
    }
    const requestModel = request.model?.trim() || this.config.model
    // Resolve the wire format per request model: a single provider (e.g.
    // OpenCode Go) can route some models to chat completions and others to
    // Anthropic Messages. Falls back to the provider/runtime format.
    const configuredEndpointFormat = this.endpointFormatForModel(requestModel)
    const endpointFormat = resolveModelEndpointFormat(configuredEndpointFormat, this.config.baseUrl)
    if (!endpointFormat) {
      yield {
        kind: 'error',
        message: 'custom full endpoint URL must end with /chat/completions, /completions, /responses, or /messages'
      }
      return
    }
    const url = buildModelEndpointUrl(this.config.baseUrl, configuredEndpointFormat)
    const stream = request.stream ?? !this.config.nonStreaming
    const body = this.buildRequestBody(request, stream, { endpointFormat })
    let credentials: { apiKey: string; headers?: Record<string, string>; refreshable: boolean }
    try {
      credentials = this.config.resolveCredentials
        ? await this.config.resolveCredentials()
        : { apiKey: this.config.apiKey, headers: this.config.headers, refreshable: false }
    } catch (error) {
      yield {
        kind: 'error',
        code: 'credential_refresh_failed',
        message: error instanceof Error ? error.message : String(error)
      }
      return
    }
    const responsesLite = isCodexEndpoint(this.config.baseUrl) &&
      this.capabilitiesForModel(requestModel).responsesMode === 'lite'
    let headers = this.buildHeaders(stream, endpointFormat, responsesLite, credentials)
    const retry = normalizeModelRequestRetryConfig(this.config.retry)
    const modelStreamLimits = normalizeModelStreamLimits(this.config.streamLimits)
    const maxErrorBodyBytes = Math.min(modelStreamLimits.maxTotalBytes, 1 * 1024 * 1024)
    const retryStatuses = new Set(retry.httpStatusCodes)
    let attemptOrdinal = 0
    const post = (
      requestBody: Record<string, unknown>,
      reason: 'initial' | 'transport_retry' | 'credential_refresh' | 'stream_options_fallback'
    ) => this.postChatCompletion(url, headers, requestBody, request.abortSignal, {
      round,
      endpointFormat,
      attempt: ++attemptOrdinal,
      reason,
      apiKey: credentials.apiKey
    })
    let result = await post(body, 'initial')
    let transportRetryAttempt = 0
    let credentialRefreshAttempted = false
    while (result.kind === 'response' && !result.response.ok) {
      if (
        result.response.status === 401 &&
        credentials.refreshable &&
        this.config.resolveCredentials &&
        !credentialRefreshAttempted
      ) {
        credentialRefreshAttempted = true
        await result.response.body?.cancel().catch(() => {})
        try {
          credentials = await this.config.resolveCredentials(credentials.apiKey)
        } catch (error) {
          yield {
            kind: 'error',
            code: 'credential_refresh_failed',
            message: error instanceof Error ? error.message : String(error)
          }
          return
        }
        headers = this.buildHeaders(stream, endpointFormat, responsesLite, credentials)
        result = await post(body, 'credential_refresh')
        continue
      }
      if (
        transportRetryAttempt >= retry.maxAttempts ||
        !retryStatuses.has(result.response.status)
      ) break
      const delayMs = retryDelayMs(result.response, retry.initialDelayMs, transportRetryAttempt)
      const status = result.response.status
      await result.response.body?.cancel().catch(() => {})
      yield {
        kind: 'retrying',
        status,
        attempt: transportRetryAttempt + 1,
        maxAttempts: retry.maxAttempts,
        delayMs
      }
      const aborted = await sleepWithAbort(delayMs, request.abortSignal)
      if (aborted || request.abortSignal.aborted) {
        yield { kind: 'error', message: 'request was aborted during retry backoff' }
        return
      }
      transportRetryAttempt += 1
      result = await post(body, 'transport_retry')
    }
    if (result.kind === 'error') {
      yield { kind: 'error', message: result.message, failure: result.failure }
      return
    }
    let response = result.response
    if (!response.ok) {
      const errorBody = await readLimitedResponseText(response, maxErrorBodyBytes)
      if (errorBody.exceeded) {
        yield {
          kind: 'error',
          message: `model error response exceeded ${maxErrorBodyBytes} bytes`,
          code: 'response_body_too_large'
        }
        return
      }
      const text = errorBody.text
      if (usesChatCompletionsShape(endpointFormat) && shouldRetryWithoutStreamUsage(response.status, text, body)) {
        const retryBody = this.buildRequestBody(request, stream, { endpointFormat, includeStreamUsage: false })
        const retry = await post(retryBody, 'stream_options_fallback')
        if (retry.kind === 'error') {
          yield { kind: 'error', message: retry.message, failure: retry.failure }
          return
        }
        response = retry.response
        if (response.ok) {
          if (this.config.nonStreaming || response.headers.get('content-type')?.includes('application/json')) {
            const json = await readLimitedResponseJson(response, modelStreamLimits.maxTotalBytes)
            if (json.kind === 'limit') {
              yield {
                kind: 'error',
                message: `model response exceeded ${json.maxBytes} bytes`,
                code: 'stream_resource_limit'
              }
              return
            }
            if (json.kind === 'invalid_json') {
              yield { kind: 'error', message: `model response contained invalid JSON: ${json.message}` }
              return
            }
            yield* this.materializeNonStreaming(
              json.value as ChatCompletionResponse,
              endpointFormat,
              requestModel,
              modelStreamLimits
            )
            return
          }
          if (!response.body) {
            yield { kind: 'error', message: 'model response had no body' }
            return
          }
          yield* this.streamSse(response.body, request.abortSignal, endpointFormat, requestModel)
          return
        }
        const retryErrorBody = await readLimitedResponseText(response, maxErrorBodyBytes)
        if (retryErrorBody.exceeded) {
          yield {
            kind: 'error',
            message: `model error response exceeded ${maxErrorBodyBytes} bytes`,
            code: 'response_body_too_large'
          }
          return
        }
        const retryText = retryErrorBody.text
        this.logHttpFailure({
          url,
          status: response.status,
          body: retryText,
          endpointFormat,
          configuredEndpointFormat,
          model: requestModel
        })
        const retryClassified = await this.classifyHttpError(response.status, retryText, response.headers.get('retry-after'))
        yield {
          kind: 'error',
          message: retryClassified.message,
          code: retryClassified.code,
          failure: retryClassified.failure
        }
        return
      }
      this.logHttpFailure({
        url,
        status: response.status,
        body: text,
        endpointFormat,
        configuredEndpointFormat,
        model: requestModel
      })
      const classified = await this.classifyHttpError(response.status, text, response.headers.get('retry-after'))
      yield {
        kind: 'error',
        message: classified.message,
        code: classified.code,
        failure: classified.failure
      }
      return
    }
    if (this.config.nonStreaming || response.headers.get('content-type')?.includes('application/json')) {
      const json = await readLimitedResponseJson(response, modelStreamLimits.maxTotalBytes)
      if (json.kind === 'limit') {
        yield {
          kind: 'error',
          message: `model response exceeded ${json.maxBytes} bytes`,
          code: 'stream_resource_limit'
        }
        return
      }
      if (json.kind === 'invalid_json') {
        yield { kind: 'error', message: `model response contained invalid JSON: ${json.message}` }
        return
      }
      yield* this.materializeNonStreaming(
        json.value as ChatCompletionResponse,
        endpointFormat,
        requestModel,
        modelStreamLimits
      )
      return
    }
    if (!response.body) {
      yield { kind: 'error', message: 'model response had no body' }
      return
    }
    yield* this.streamSse(response.body, request.abortSignal, endpointFormat, requestModel)
  }

  private endpointFormat(): ModelEndpointFormat {
    return normalizeModelEndpointFormat(this.config.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT)
  }

  /**
   * The wire format for a specific model: a per-model override (carried on
   * the model's capability metadata) takes precedence over the
   * provider/runtime format. Lets one provider mix chat completions and
   * Anthropic Messages models (e.g. OpenCode Go's minimax/qwen entries).
   */
  private endpointFormatForModel(model: string): ModelEndpointFormat {
    return this.capabilitiesForModel(model).endpointFormat
  }

  private modelReasoningFor(model: string): ModelCapabilityMetadata['reasoning'] | undefined {
    return this.capabilitiesForModel(model).reasoning
  }

  /** Per-model output-token cap from capability metadata, if declared. */
  private maxOutputTokensFor(model: string): number | undefined {
    return this.capabilitiesForModel(model).maxOutputTokens
  }

  private capabilitiesForModel(model: string) {
    return resolveCompatModelCapabilities({
      model,
      providerEndpointFormat: this.config.endpointFormat,
      modelCapabilities: this.config.modelCapabilities
    })
  }

  /**
   * Resolves the output-token cap for a request: an explicit request value
   * wins, then the per-model capability override, then the supplied default.
   */
  private resolveMaxTokens(
    request: ModelRequest,
    model: string,
    fallback?: number
  ): number | undefined {
    return request.maxTokens ?? this.maxOutputTokensFor(model) ?? fallback
  }

  private async postChatCompletion(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal,
    trace: {
      round: LlmDebugRound | null
      endpointFormat: ModelEndpointFormat
      attempt: number
      reason: 'initial' | 'transport_retry' | 'credential_refresh' | 'stream_options_fallback'
      apiKey: string
    }
  ): Promise<{ kind: 'response'; response: Response } | { kind: 'error'; message: string; failure: import('../../contracts/model-route-pool.js').ModelFailureMetadata }> {
    const bodyText = JSON.stringify(body)
    const traceRound = trace.round
    const traceSink = this.config.debugSink
    const traceRecord = traceRound && traceSink
      ? ignoreModelTraceFailure(() => traceSink.beginHttpAttempt(traceRound, {
          endpointFormat: trace.endpointFormat,
          attempt: trace.attempt,
          reason: trace.reason,
          url,
          headers,
          bodyText,
          secretValues: [trace.apiKey]
        }))
      : undefined
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: bodyText,
        signal
      })
      if (traceRound && traceSink && traceRecord) {
        ignoreModelTraceFailure(() => {
          traceSink.captureHttpResponse(traceRound, traceRecord, response)
        })
      }
      return { kind: 'response', response }
    } catch (error) {
      if (traceRecord) {
        ignoreModelTraceFailure(() => traceSink?.captureHttpError(traceRecord, error))
      }
      const message = error instanceof Error ? error.message : String(error)
      // Only blame the proxy for genuine transport failures. A user-initiated
      // abort (turn cancelled, idle-timeout watchdog) also surfaces here as an
      // AbortError but has nothing to do with the proxy — don't send the user
      // chasing a proxy that is working fine.
      const aborted = error instanceof Error && error.name === 'AbortError'
      const proxyHint = !aborted && this.config.modelProxyUrl?.trim()
        ? '. Check the configured model-request proxy in Settings > Providers.'
        : ''
      const timeout = /timeout|timed out/i.test(message)
      return {
        kind: 'error',
        message: `model request failed: ${message}${proxyHint}`,
        failure: { category: timeout ? 'timeout' : 'network', failoverAllowed: !aborted }
      }
    }
  }

  private buildHeaders(
    stream: boolean,
    endpointFormat: ModelEndpointFormat,
    responsesLite = false,
    credentials: {
      apiKey: string
      headers?: Record<string, string>
    } = {
      apiKey: this.config.apiKey,
      headers: this.config.headers
    }
  ): Record<string, string> {
    const configuredHeaders = {
      ...(this.config.headers ?? {}),
      ...(credentials.headers ?? {})
    }
    // Protected credentials are resolved before every request and may
    // materialize a fresh session_id. Keep transport identity owned by this
    // client so credential refresh cannot invalidate Codex prompt routing.
    if (this.codexSessionId) configuredHeaders.session_id = this.codexSessionId
    return buildCompatRequestHeaders({
      apiKey: credentials.apiKey,
      configuredHeaders,
      stream,
      endpointFormat,
      responsesLite
    })
  }

  private async classifyHttpError(status: number, text: string, retryAfter?: string | null) {
    return classifyCompatHttpError({
      status,
      text,
      baseUrl: this.config.baseUrl,
      fetchImpl: this.fetchImpl,
      retryAfter
    })
  }

  private logHttpFailure(input: {
    url: string
    status: number
    body: string
    endpointFormat: ModelEndpointFormat
    configuredEndpointFormat: ModelEndpointFormat
    model: string
  }): void {
    console.warn('[kun:model] model HTTP request failed', compatHttpFailureLog({
      provider: this.provider,
      status: input.status,
      model: input.model,
      configuredModel: this.config.model,
      baseUrl: this.config.baseUrl,
      requestUrl: input.url,
      endpointFormat: input.endpointFormat,
      configuredEndpointFormat: input.configuredEndpointFormat,
      body: input.body
    }))
  }

  private buildRequestBody(
    request: ModelRequest,
    stream: boolean,
    options: { endpointFormat?: ModelEndpointFormat; includeStreamUsage?: boolean } = {}
  ): Record<string, unknown> {
    const requestModel = request.model?.trim()
    const model = requestModel || this.config.model
    const messages = this.collectMessages(request, model)
    const endpointFormat = options.endpointFormat ?? this.endpointFormat()
    const tools = normalizeToolSpecs(request.tools)
    const reasoning = this.modelReasoningFor(model)
    const isCodex = isCodexEndpoint(this.config.baseUrl)
    const isCodexLite = isCodex && this.capabilitiesForModel(model).responsesMode === 'lite'
    const codecs = createCompatRequestCodecs()
    return codecs.build({
      request,
      model,
      messages,
      tools,
      stream,
      endpointFormat,
      includeStreamUsage: options.includeStreamUsage,
      baseUrl: this.config.baseUrl,
      reasoning,
      maxTokens: this.resolveMaxTokens(request, model),
      isCodex,
      isCodexLite,
      codexNativeImageGeneration: codexModelSupportsNativeImageGeneration(model)
    })
  }

  private collectMessages(request: ModelRequest, model: string): ChatMessage[] {
    return projectCompatMessages(request, {
      historyLimit: this.config.historyLimit,
      thinkingMode: requiresReasoningRoundTrip(
        request.reasoningEffort,
        model,
        this.config.baseUrl,
        this.modelReasoningFor(model)
      ),
      supportsImages: this.modelSupportsImageInput(model)
    })
  }

  /**
   * Whether the resolved model accepts image input. Tool-result images are
   * only forwarded as real image parts to vision models; text-only models
   * get a text summary instead. Defaults to true when no capability
   * resolver is configured (the runtime always sets one).
   */
  private modelSupportsImageInput(model: string): boolean {
    if (!this.config.modelCapabilities) return true
    return this.capabilitiesForModel(model).supportsVision
  }

  private async *streamSse(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    endpointFormat: ModelEndpointFormat,
    model: string
  ): AsyncIterable<ModelStreamChunk> {
    const decoder = new TextDecoder('utf-8')
    const reader = body.getReader()
    const frameBuffer = new IncrementalSseFrameBuffer()
    const pendingArguments = new Map<string, PendingToolCall>()
    const pendingByIndex = new Map<number, string>()
    const completedToolCalls = new Set<string>()
    let usage: UsageSnapshot | null = null
    // The Responses protocol may repeat final output in response.completed;
    // a boolean is sufficient to suppress that duplicate. Retaining the full
    // streamed text/reasoning here used quadratic concatenation and a second
    // unbounded copy of an already-emitted response.
    let sawTextDelta = false
    let stopReason: ModelStopReason = 'stop'
    let finishReason: string | null = null
    let sawDone = false
    let readerFinished = false
    let bufferBytes = 0
    const idleTimeoutMs = normalizeStreamIdleTimeoutMs(this.config.streamIdleTimeoutMs)
    const limits = normalizeModelStreamLimits(this.config.streamLimits)
    const budget = new ModelStreamResourceBudget(limits)
    const cancelReader = (reason: string): void => {
      // Never await cancellation here: a broken/custom ReadableStream can
      // make its cancel promise hang, defeating the very timeout/limit that
      // is trying to stop it.
      void reader.cancel(reason).catch(() => {})
    }
    try {
      while (!signal.aborted) {
        const read = await readStreamChunk(reader, signal, idleTimeoutMs)
        if (read.kind === 'timeout') {
          yield {
            kind: 'error',
            message: `model stream stalled for ${idleTimeoutMs}ms without data`,
            code: 'stream_idle_timeout'
          }
          return
        }
        if (read.kind === 'aborted') break
        if (read.kind === 'error') {
          yield { kind: 'error', message: read.message, code: 'stream_read_error' }
          return
        }
        const { value, done } = read
        if (done) {
          readerFinished = true
          break
        }
        if (!value) {
          readerFinished = true
          break
        }
        budget.addInboundBytes(value.byteLength)
        bufferBytes += value.byteLength
        if (bufferBytes > limits.maxBufferBytes) {
          throw budget.exceeded(`${limits.maxBufferBytes} buffered SSE bytes`)
        }
        frameBuffer.append(decoder.decode(value, { stream: true }))
        while (true) {
          const parsedFrame = frameBuffer.takeFrame()
          if (parsedFrame === null) break
          const frame = parsedFrame.data
          const consumedBytes = Buffer.byteLength(frame, 'utf8') + Buffer.byteLength(parsedFrame.delimiter, 'utf8')
          bufferBytes = Math.max(0, bufferBytes - consumedBytes)
          budget.addFrame(Buffer.byteLength(frame, 'utf8'))
          const dataLines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (!dataLines) continue
          if (dataLines === '[DONE]') {
            finishReason = finishReason ?? 'stop'
            sawDone = true
            break
          }
          let payload: unknown
          try {
            payload = JSON.parse(dataLines)
          } catch {
            yield { kind: 'error', message: 'model stream contained invalid SSE JSON', code: 'stream_invalid_frame' }
            return
          }
          const result = this.consumeStreamPayload(
            payload as Record<string, unknown>,
            pendingArguments,
            pendingByIndex,
            completedToolCalls,
            sawTextDelta,
            endpointFormat,
            model,
            budget
          )
          budget.addOutput(result.chunks)
          sawTextDelta = result.sawTextDelta
          if (result.usage) usage = mergeUsageSnapshots(usage, result.usage)
          if (result.finishReason) {
            // Some protocols emit a semantic terminal reason followed by a
            // generic stop frame. Do not let that trailing frame downgrade
            // `length`, `tool_calls`, or `error` to a successful stop.
            finishReason = mergeStreamFinishReason(finishReason, result.finishReason)
          }
          for (const chunk of result.chunks) yield chunk
        }
        if (sawDone) break
      }
    } catch (error) {
      if (error instanceof ModelStreamResourceLimitError) {
        frameBuffer.clear()
        budget.clearPendingCalls(pendingArguments)
        pendingByIndex.clear()
        completedToolCalls.clear()
        cancelReader('model stream resource limit exceeded')
        yield { kind: 'error', message: error.message, code: 'stream_resource_limit' }
        return
      }
      throw error
    } finally {
      if (!readerFinished) cancelReader('model stream closed before body completion')
      try {
        reader.releaseLock()
      } catch {
        // The stream may already be released; ignore.
      }
    }
    if (signal.aborted) {
      yield { kind: 'error', message: 'request was aborted' }
      return
    }
    if (!sawDone && !finishReason) {
      yield {
        kind: 'error',
        message: 'model stream ended before a terminal frame',
        code: 'stream_truncated'
      }
      return
    }
    // Safety net: finalize any tool call whose arguments finished streaming but
    // was never emitted because the stream ended without a per-call "done"
    // signal. The chat_completions branch only finalizes on
    // `finish_reason === 'tool_calls'`, so a provider that ends with 'stop',
    // 'length', or a bare `[DONE]` while a tool call is still pending would
    // otherwise DROP the call silently. Truncated arguments surface here as
    // `{ __raw }` (a tool error the model can react to) instead of vanishing.
    let flushedPendingToolCall = false
    try {
      for (const [callId, pending] of pendingArguments) {
        if (!pending.name) continue
        if (completedToolCalls.has(callId)) continue
        const argumentsRaw = budget.pendingArguments(pending)
        budget.completeToolCall(argumentsRaw)
        flushedPendingToolCall = true
        completedToolCalls.add(callId)
        yield {
          kind: 'tool_call_complete',
          callId,
          toolName: pending.name,
          arguments: this.parseToolArguments(argumentsRaw || '{}')
        }
      }
    } catch (error) {
      if (error instanceof ModelStreamResourceLimitError) {
        yield { kind: 'error', message: error.message, code: 'stream_resource_limit' }
        return
      }
      throw error
    }
    budget.clearPendingCalls(pendingArguments)
    if (usage) yield { kind: 'usage', usage }
    stopReason = ((): ModelStopReason => {
      switch (finishReason) {
        case 'tool_calls':
          return 'tool_calls'
        case 'length':
          return 'length'
        case 'error':
          return 'error'
        default:
          // A completed or recovered tool call means this was really a
          // tool-call turn even if the provider emitted only a generic stop.
          return flushedPendingToolCall || completedToolCalls.size > 0 ? 'tool_calls' : 'stop'
      }
    })()
    yield { kind: 'completed', stopReason }
  }

  private consumeStreamPayload(
    payload: Record<string, unknown>,
    pendingArguments: Map<string, PendingToolCall>,
    pendingByIndex: Map<number, string>,
    completedToolCalls: Set<string>,
    sawTextDelta: boolean,
    endpointFormat: ModelEndpointFormat,
    model: string,
    budget: ModelStreamResourceBudget
  ): StreamPayloadResult {
    const payloadError = modelPayloadError(payload)
    if (payloadError) {
      return {
        chunks: [{
          kind: 'error',
          message: payloadError.message,
          ...(payloadError.code ? { code: payloadError.code } : {})
        }],
        sawTextDelta,
        finishReason: 'error',
        usage: null
      }
    }
    if (endpointFormat === 'responses') {
      return this.consumeResponsesStreamPayload(
        payload,
        pendingArguments,
        pendingByIndex,
        completedToolCalls,
        sawTextDelta,
        model,
        budget
      )
    }
    if (endpointFormat === 'messages') {
      return this.consumeAnthropicMessagesStreamPayload(
        payload,
        pendingArguments,
        pendingByIndex,
        completedToolCalls,
        sawTextDelta,
        model,
        budget
      )
    }
    return decodeChatCompletionsStreamPayload({
      payload,
      pendingArguments,
      pendingByIndex,
      sawTextDelta,
      budget,
      normalizeUsage: (usage) => this.mapUsage(usage, model),
      parseToolArguments: (raw) => this.parseToolArguments(raw)
    })
  }

  private consumeResponsesStreamPayload(
    payload: Record<string, unknown>,
    pendingArguments: Map<string, PendingToolCall>,
    pendingByIndex: Map<number, string>,
    completedToolCalls: Set<string>,
    sawTextDelta: boolean,
    model: string,
    budget: ModelStreamResourceBudget
  ): StreamPayloadResult {
    return decodeResponsesStreamPayload({
      payload,
      pendingArguments,
      pendingByIndex,
      completedToolCalls,
      sawTextDelta,
      budget,
      parseToolArguments: (raw) => this.parseToolArguments(raw),
      normalizeUsage: (usage) => this.mapUsage(usage, model)
    })
  }
  private consumeAnthropicMessagesStreamPayload(
    payload: Record<string, unknown>,
    pendingArguments: Map<string, PendingToolCall>,
    pendingByIndex: Map<number, string>,
    completedToolCalls: Set<string>,
    sawTextDelta: boolean,
    model: string,
    budget: ModelStreamResourceBudget
  ): StreamPayloadResult {
    return decodeAnthropicMessagesStreamPayload({
      payload,
      pendingArguments,
      pendingByIndex,
      completedToolCalls,
      sawTextDelta,
      budget,
      normalizeUsage: (usage) => this.mapUsage(usage, model),
      parseToolArguments: (raw) => this.parseToolArguments(raw)
    })
  }

  private *materializeNonStreaming(
    payload: ChatCompletionResponse,
    endpointFormat: ModelEndpointFormat,
    model: string,
    limits: ModelStreamLimits
  ): Generator<ModelStreamChunk> {
    yield* enforceNonStreamingLimits(
      decodeCompatNonStreamingResponse(
        payload as unknown as Record<string, unknown>,
        endpointFormat,
        {
          normalizeUsage: (usage) => this.mapUsage(usage, model),
          parseToolArguments: (raw) => this.parseToolArguments(raw),
          payloadError: modelPayloadError
        }
      ),
      limits
    )
  }

  private mapUsage(usage: Record<string, unknown>, model = this.config.model): UsageSnapshot {
    return normalizeCompatUsage({
      usage,
      model,
      providerBaseUrl: this.config.baseUrl
    })
  }

  private parseToolArguments(raw: string): Record<string, unknown> {
    return repairToolArguments(raw).arguments
  }
}

function buildModelEndpointUrl(baseUrl: string, endpointFormat: ModelEndpointFormat): string {
  if (isCustomModelEndpointFormat(endpointFormat)) return exactModelEndpointUrl(baseUrl)
  const path = modelEndpointPath(endpointFormat)
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) return `/v1/${path}`
  const lastSegment = normalized.split('/').pop()?.toLowerCase() ?? ''
  if (lastSegment === 'beta') {
    return `${normalized.slice(0, -'/beta'.length)}/v1/${path}`
  }
  if (/^v\d+$/.test(lastSegment)) {
    return `${normalized}/${path}`
  }
  return `${normalized}/v1/${path}`
}

function exactModelEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  const query = trimmed.search(/[?#]/)
  if (query < 0) return trimmed.replace(/\/+$/, '')
  return `${trimmed.slice(0, query).replace(/\/+$/, '')}${trimmed.slice(query)}`
}


function buildChatCompletionsUrl(baseUrl: string): string {
  return buildModelEndpointUrl(baseUrl, 'chat_completions')
}

function modelPayloadError(payload: Record<string, unknown>): { message: string; code?: string } | null {
  const rawError = payload.error
  if (typeof rawError === 'string' && rawError.trim()) {
    return { message: rawError.trim() }
  }
  const directError = modelErrorObject(recordValue(payload, 'error'))
  if (directError) return directError
  const responseError = modelErrorObject(recordValue(recordValue(payload, 'response'), 'error'))
  if (responseError) return responseError
  const baseResp = recordValue(payload, 'base_resp') ?? recordValue(payload, 'baseResp')
  if (baseResp) {
    const code = errorCodeString(
      baseResp.status_code ?? baseResp.status ?? baseResp.code ?? baseResp.err_code
    )
    if (code && !successErrorCode(code)) {
      return {
        message:
          recordString(baseResp, 'status_msg') ||
          recordString(baseResp, 'message') ||
          recordString(baseResp, 'msg') ||
          `model provider error (${code})`,
        code
      }
    }
  }
  const topLevelCode = errorCodeString(payload.code ?? payload.type ?? payload.status_code ?? payload.err_code)
  const topLevelMessage =
    recordString(payload, 'message') ||
    recordString(payload, 'error_msg') ||
    recordString(payload, 'status_msg')
  if (topLevelCode && topLevelMessage && !successErrorCode(topLevelCode)) {
    return { message: topLevelMessage, code: topLevelCode }
  }
  return null
}

function modelErrorObject(error: Record<string, unknown> | null): { message: string; code?: string } | null {
  if (!error) return null
  const message =
    recordString(error, 'message') ||
    recordString(error, 'msg') ||
    recordString(error, 'status_msg') ||
    recordString(error, 'error_msg')
  const code = errorCodeString(error.code ?? error.type ?? error.status ?? error.status_code ?? error.err_code)
  if (message) return { message, ...(code ? { code } : {}) }
  if (code && !successErrorCode(code)) return { message: `model provider error (${code})`, code }
  return null
}

function errorCodeString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function successErrorCode(code: string): boolean {
  const normalized = code.trim().toLowerCase()
  return normalized === '0' || normalized === 'ok' || normalized === 'success'
}

function recordValue(value: unknown, key?: string): Record<string, unknown> | null {
  const target = key === undefined
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>)[key]
      : null
  return target && typeof target === 'object' && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null
}

function recordString(value: unknown, key: string): string {
  const target = value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined
  return typeof target === 'string' ? target : ''
}

function mergeUsageSnapshots(current: UsageSnapshot | null, next: UsageSnapshot): UsageSnapshot {
  if (!current) return next
  const promptTokens = next.promptTokens || current.promptTokens
  const completionTokens = Math.max(next.completionTokens, current.completionTokens)
  const totalTokens = next.totalTokens > 0 && next.promptTokens > 0
    ? next.totalTokens
    : promptTokens + completionTokens
  return {
    ...current,
    ...next,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: Math.max(current.cachedTokens ?? 0, next.cachedTokens ?? 0),
    cacheHitTokens: Math.max(current.cacheHitTokens ?? 0, next.cacheHitTokens ?? 0),
    cacheMissTokens: Math.max(current.cacheMissTokens ?? 0, next.cacheMissTokens ?? 0),
    cacheHitRate: next.cacheHitRate ?? current.cacheHitRate,
    costUsd: next.costUsd ?? current.costUsd,
    costCny: next.costCny ?? current.costCny
  }
}

function shouldRetryWithoutStreamUsage(
  status: number,
  text: string,
  body: Record<string, unknown>
): boolean {
  if (status !== 400 && status !== 422) return false
  if (!Object.prototype.hasOwnProperty.call(body, 'stream_options')) return false
  return /\b(stream_options|include_usage)\b/i.test(text)
}

function reasoningFromMessage(message: ChatCompletionResponse['choices'][number]['message'] | undefined): string {
  if (!message) return ''
  const value = message.reasoning_content ??
    (message as ChatMessage & { reasoning?: unknown }).reasoning
  return typeof value === 'string' ? value : ''
}

function normalizeStreamIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(value)) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return Math.max(0, Math.floor(value))
}

function normalizeModelStreamLimits(input: Partial<ModelStreamLimits> | undefined): ModelStreamLimits {
  const normalize = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.max(1, Math.floor(value))
  }
  return {
    maxBufferBytes: normalize(input?.maxBufferBytes, DEFAULT_MODEL_STREAM_LIMITS.maxBufferBytes),
    maxFrameBytes: normalize(input?.maxFrameBytes, DEFAULT_MODEL_STREAM_LIMITS.maxFrameBytes),
    maxTotalBytes: normalize(input?.maxTotalBytes, DEFAULT_MODEL_STREAM_LIMITS.maxTotalBytes),
    maxFrames: normalize(input?.maxFrames, DEFAULT_MODEL_STREAM_LIMITS.maxFrames),
    maxOutputBytes: normalize(input?.maxOutputBytes, DEFAULT_MODEL_STREAM_LIMITS.maxOutputBytes),
    maxPendingToolCalls: normalize(input?.maxPendingToolCalls, DEFAULT_MODEL_STREAM_LIMITS.maxPendingToolCalls),
    maxPendingToolArgumentBytes: normalize(
      input?.maxPendingToolArgumentBytes,
      DEFAULT_MODEL_STREAM_LIMITS.maxPendingToolArgumentBytes
    ),
    maxTotalPendingToolArgumentBytes: normalize(
      input?.maxTotalPendingToolArgumentBytes,
      DEFAULT_MODEL_STREAM_LIMITS.maxTotalPendingToolArgumentBytes
    ),
    maxCompletedToolCalls: normalize(input?.maxCompletedToolCalls, DEFAULT_MODEL_STREAM_LIMITS.maxCompletedToolCalls),
    maxCompletedToolArgumentBytes: normalize(
      input?.maxCompletedToolArgumentBytes,
      DEFAULT_MODEL_STREAM_LIMITS.maxCompletedToolArgumentBytes
    )
  }
}

let modelTraceFailureWarned = false

function ignoreModelTraceFailure<T>(operation: () => T): T | undefined {
  try {
    return operation()
  } catch {
    warnModelTraceFailure()
    return undefined
  }
}

function warnModelTraceFailure(): void {
  if (modelTraceFailureWarned) return
  modelTraceFailureWarned = true
  console.warn('[kun:model] model request observability capture failed; the provider request continues unchanged')
}

type LimitedResponseJson =
  | { kind: 'ok'; value: unknown }
  | { kind: 'limit'; maxBytes: number }
  | { kind: 'invalid_json'; message: string }

/** Read an HTTP body without delegating an unbounded response to Response.text/json. */
async function readLimitedResponseText(response: Response, maxBytes: number): Promise<{ text: string; exceeded: boolean }> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel('model response body limit exceeded').catch(() => {})
    return { text: '', exceeded: true }
  }
  if (!response.body) return { text: '', exceeded: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parts: string[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        void reader.cancel('model response body limit exceeded').catch(() => {})
        return { text: parts.join(''), exceeded: true }
      }
      const text = decoder.decode(value, { stream: true })
      if (text) parts.push(text)
    }
    const tail = decoder.decode()
    if (tail) parts.push(tail)
    return { text: parts.join(''), exceeded: false }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Best effort; cancellation or a completed reader may already release it.
    }
  }
}

async function readLimitedResponseJson(response: Response, maxBytes: number): Promise<LimitedResponseJson> {
  const body = await readLimitedResponseText(response, maxBytes)
  if (body.exceeded) return { kind: 'limit', maxBytes }
  try {
    return { kind: 'ok', value: JSON.parse(body.text) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'invalid_json', message }
  }
}

function* enforceNonStreamingLimits(
  chunks: Iterable<ModelStreamChunk>,
  limits: ModelStreamLimits
): Generator<ModelStreamChunk> {
  const budget = new ModelStreamResourceBudget(limits)
  try {
    for (const chunk of chunks) {
      if (chunk.kind === 'tool_call_complete') {
        budget.completeToolCall(JSON.stringify(chunk.arguments) ?? '{}')
      }
      budget.addOutput([chunk])
      yield chunk
    }
  } catch (error) {
    if (error instanceof ModelStreamResourceLimitError) {
      yield { kind: 'error', message: error.message, code: 'stream_resource_limit' }
      return
    }
    throw error
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number
): Promise<StreamReadResult> {
  if (signal.aborted) return { kind: 'aborted' }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let cleanupAbort: (() => void) | undefined
  const readPromise = reader.read()
    .then((result): StreamReadResult => ({ kind: 'chunk', ...result }))
    .catch((error): StreamReadResult => {
      if (signal.aborted) return { kind: 'aborted' }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', message: `model stream read failed: ${message}` }
    })
  const abortPromise = new Promise<StreamReadResult>((resolve) => {
    const onAbort = (): void => resolve({ kind: 'aborted' })
    if (signal.aborted) {
      resolve({ kind: 'aborted' })
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    cleanupAbort = () => signal.removeEventListener('abort', onAbort)
  })
  const candidates: Array<Promise<StreamReadResult>> = [readPromise, abortPromise]
  if (idleTimeoutMs > 0) {
    candidates.push(new Promise<StreamReadResult>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), idleTimeoutMs)
    }))
  }
  const result = await Promise.race(candidates)
  if (timeout) clearTimeout(timeout)
  cleanupAbort?.()
  if (result.kind === 'timeout') {
    // A custom stream may never resolve `cancel()`. Fire-and-forget it so an
    // idle timeout remains a real deadline rather than another await point.
    void reader.cancel('model stream idle timeout').catch(() => {})
  }
  return result
}
