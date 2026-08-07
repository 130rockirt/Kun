import { randomUUID } from 'node:crypto'
import { goalContextTexts, type ToolCallProviderMetadata } from '../../contracts/items.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import {
  startLlmDebugRoundIfEnabled,
  type LlmDebugRound,
  type LlmDebugSink
} from '../../services/llm-debug-recorder.js'
import type {
  CompatChatMessage,
  CompatChatMessageContentPart
} from './compat-request-codecs.js'
import { projectCompatMessages } from './compat-message-projector.js'
import { createProxyFetch } from './proxy-fetch.js'
import { IncrementalSseFrameBuffer } from './incremental-sse-frame-buffer.js'
import { GeminiCliOAuthSource } from './gemini-cli-oauth.js'
import {
  exponentialRetryDelayMs,
  normalizeModelRequestRetryConfig,
  parseRetryAfterMs,
  retryDelayMs,
  sleepWithAbort
} from './compat-retry-policy.js'
import type { ModelRequestRetryConfig } from '../../config/kun-config.js'
export const GEMINI_CLI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
export const GEMINI_CLI_CODE_ASSIST_API_VERSION = 'v1internal'

const MAX_ERROR_BODY_BYTES = 256 * 1024
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024

export type GeminiCliApiModelClientConfig = {
  model: string
  modelProxyUrl?: string
  endpoint?: string
  apiVersion?: string
  fetchImpl?: typeof fetch
  oauthSource?: GeminiCliOAuthSource
  debugSink?: LlmDebugSink
  retry?: ModelRequestRetryConfig
}

type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
  functionResponse?: {
    id?: string
    name?: string
    response?: Record<string, unknown>
  }
}

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiCodeAssistResponse = {
  response?: {
    candidates?: Array<{
      content?: { role?: string; parts?: GeminiPart[] }
      finishReason?: string
    }>
    promptFeedback?: {
      blockReason?: string
      blockReasonMessage?: string
    }
    usageMetadata?: GeminiUsageMetadata
  }
  error?: {
    code?: number
    status?: string
    message?: string
  }
}

type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

type GeminiCodeAssistSetup = {
  currentTier?: { id?: string }
  paidTier?: { id?: string }
  cloudaicompanionProject?: string
  ineligibleTiers?: Array<{ reasonMessage?: string }>
  error?: { code?: number; status?: string; message?: string }
}

/**
 * Native Kun model client for the official Gemini CLI's Google subscription
 * API path. Unlike Antigravity it does not delegate the whole turn: Kun keeps
 * history, tools, approvals, compaction, retries, and SSE ownership.
 */
export class GeminiCliApiModelClient implements ModelClient {
  readonly provider = 'gemini-cli-api'
  readonly model: string
  readonly config: {
    baseUrl: string
    endpointFormat: 'custom_endpoint'
  }

  private readonly fetchImpl: typeof fetch
  private readonly oauthSource: GeminiCliOAuthSource
  private readonly debugSink?: LlmDebugSink
  private readonly endpoint: string
  private readonly apiVersion: string
  private readonly retry: ReturnType<typeof normalizeModelRequestRetryConfig>
  private projectId: string | undefined

  constructor(config: GeminiCliApiModelClientConfig) {
    this.model = config.model
    this.endpoint = (config.endpoint ??
      process.env.CODE_ASSIST_ENDPOINT?.trim() ??
      GEMINI_CLI_CODE_ASSIST_ENDPOINT).replace(/\/+$/, '')
    this.apiVersion = (config.apiVersion ??
      process.env.CODE_ASSIST_API_VERSION?.trim() ??
      GEMINI_CLI_CODE_ASSIST_API_VERSION).replace(/^\/+|\/+$/g, '')
    this.config = {
      baseUrl: `${this.endpoint}/${this.apiVersion}`,
      endpointFormat: 'custom_endpoint'
    }
    this.fetchImpl = config.fetchImpl ??
      createProxyFetch(config.modelProxyUrl ?? '') ??
      fetch
    this.oauthSource = config.oauthSource ?? new GeminiCliOAuthSource({
      fetchImpl: this.fetchImpl
    })
    this.debugSink = config.debugSink
    this.retry = normalizeModelRequestRetryConfig(config.retry)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const round = await this.startDebugRound(request)
    try {
      for await (const chunk of this.streamInner(request, round)) {
        safeDebug(() => this.debugSink?.captureChunk(round!, chunk))
        yield chunk
      }
    } finally {
      if (round && this.debugSink) {
        await this.debugSink.finish(round).catch(() => {})
      }
    }
  }

  private async *streamInner(
    request: ModelRequest,
    round: LlmDebugRound | null
  ): AsyncIterable<ModelStreamChunk> {
    if (request.abortSignal.aborted) {
      yield { kind: 'error', code: 'request_aborted', message: 'request was aborted before start' }
      return
    }

    let accessToken: string
    try {
      accessToken = await this.oauthSource.accessToken()
    } catch (error) {
      if (round && this.debugSink) {
        safeDebug(() => this.debugSink!.recordPhaseDiagnostic?.(round, {
          phase: 'credential',
          failureOrigin: 'credential',
          code: 'gemini_cli_login_required',
          message: safeErrorMessage(error)
        }))
      }
      yield {
        kind: 'error',
        code: 'gemini_cli_login_required',
        message: safeErrorMessage(error)
      }
      return
    }

    try {
      this.projectId = this.projectId ?? await this.loadProject(accessToken, request.abortSignal, round)
    } catch (error) {
      if (isUnauthorized(error)) {
        try {
          accessToken = await this.oauthSource.accessToken(accessToken)
          this.projectId = await this.loadProject(accessToken, request.abortSignal, round)
        } catch (retryError) {
          if (round && this.debugSink) {
            safeDebug(() => this.debugSink!.recordPhaseDiagnostic?.(round, {
              phase: 'credential',
              failureOrigin: 'credential',
              code: 'gemini_cli_auth_failed',
              message: safeErrorMessage(retryError)
            }))
          }
          yield {
            kind: 'error',
            code: 'gemini_cli_auth_failed',
            message: safeErrorMessage(retryError)
          }
          return
        }
      } else {
        yield {
          kind: 'error',
          code: 'gemini_cli_setup_failed',
          message: safeErrorMessage(error)
        }
        return
      }
    }

    const model = request.model?.trim() || this.model
    const body = buildGeminiCliCodeAssistRequest(request, model, this.projectId)
    let attemptOrdinal = 0
    const post = (
      reason: 'initial' | 'credential_refresh' | 'transport_retry'
    ) => this.postStream({
      body,
      accessToken,
      signal: request.abortSignal,
      round,
      attempt: ++attemptOrdinal,
      reason
    })
    let result = await post('initial')
    let credentialRefreshAttempted = false
    let transportRetryAttempt = 0
    const retryStatuses = new Set(this.retry.httpStatusCodes)
    while (true) {
      if (result.error) {
        if (
          request.abortSignal.aborted ||
          transportRetryAttempt >= this.retry.maxAttempts
        ) break
        const nextAttempt = transportRetryAttempt + 1
        const delayMs = exponentialRetryDelayMs(
          this.retry.initialDelayMs,
          transportRetryAttempt
        )
        yield {
          kind: 'retrying',
          attempt: nextAttempt,
          maxAttempts: this.retry.maxAttempts,
          delayMs,
          reason: 'network'
        }
        const aborted = await sleepWithAbort(delayMs, request.abortSignal)
        if (aborted || request.abortSignal.aborted) {
          yield {
            kind: 'error',
            code: 'request_aborted',
            message: 'Gemini CLI API request was aborted during retry backoff.'
          }
          return
        }
        transportRetryAttempt = nextAttempt
        result = await post('transport_retry')
        continue
      }
      if (!result.response || result.response.ok) break
      if (result.response.status === 401 && !credentialRefreshAttempted) {
        credentialRefreshAttempted = true
        await result.response.body?.cancel().catch(() => {})
        try {
          accessToken = await this.oauthSource.accessToken(accessToken)
        } catch (error) {
          if (round && this.debugSink) {
            safeDebug(() => this.debugSink!.recordPhaseDiagnostic?.(round, {
              phase: 'credential',
              failureOrigin: 'credential',
              code: 'gemini_cli_auth_failed',
              message: safeErrorMessage(error)
            }))
          }
          yield {
            kind: 'error',
            code: 'gemini_cli_auth_failed',
            message: safeErrorMessage(error)
          }
          return
        }
        result = await post('credential_refresh')
        continue
      }
      if (
        transportRetryAttempt >= this.retry.maxAttempts ||
        !retryStatuses.has(result.response.status)
      ) break
      const status = result.response.status
      const delayMs = await geminiRetryDelayMs(
        result.response,
        this.retry.initialDelayMs,
        transportRetryAttempt
      )
      await result.response.body?.cancel().catch(() => {})
      yield {
        kind: 'retrying',
        status,
        attempt: transportRetryAttempt + 1,
        maxAttempts: this.retry.maxAttempts,
        delayMs
      }
      const aborted = await sleepWithAbort(delayMs, request.abortSignal)
      if (aborted || request.abortSignal.aborted) {
        yield {
          kind: 'error',
          code: 'request_aborted',
          message: 'Gemini CLI API request was aborted during retry backoff.'
        }
        return
      }
      transportRetryAttempt += 1
      result = await post('transport_retry')
    }
    if (result.error) {
      yield {
        kind: 'error',
        code: request.abortSignal.aborted ? 'request_aborted' : 'gemini_cli_api_network_error',
        message: result.error
      }
      return
    }
    const response = result.response!
    if (!response.ok) {
      const error = await readGeminiError(response)
      yield {
        kind: 'error',
        code: geminiErrorCode(response.status, error.status),
        message: error.message,
        failure: {
          category: response.status === 401 || response.status === 403
            ? 'authentication'
            : response.status === 404
              ? 'model_not_found'
              : response.status === 429
                ? 'rate_limit'
                : response.status >= 500
                  ? 'unavailable'
                  : 'request',
          httpStatus: response.status,
          ...(error.status ? { providerCode: error.status } : {}),
          ...(error.retryAfterMs !== undefined
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
          failoverAllowed:
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404 ||
            response.status === 429 ||
            response.status >= 500
        }
      }
      return
    }
    if (!response.body) {
      yield {
        kind: 'error',
        code: 'gemini_cli_api_empty_response',
        message: 'Gemini CLI API returned no response body.'
      }
      return
    }

    let sawToolCall = false
    let sawContent = false
    let finishReason = ''
    let latestUsage: GeminiUsageMetadata | undefined
    try {
      for await (const payload of readGeminiSse(response.body, request.abortSignal)) {
        const candidate = payload.response?.candidates?.[0]
        finishReason = candidate?.finishReason ?? finishReason
        latestUsage = payload.response?.usageMetadata ?? latestUsage
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text) {
            sawContent = true
            yield part.thought
              ? { kind: 'assistant_reasoning_delta', text: part.text }
              : { kind: 'assistant_text_delta', text: part.text }
          }
          if (part.functionCall?.name) {
            sawContent = true
            sawToolCall = true
            const providerMetadata = geminiProviderMetadata(part.thoughtSignature)
            yield {
              kind: 'tool_call_complete',
              callId: part.functionCall.id?.trim() || randomUUID(),
              toolName: part.functionCall.name,
              arguments: objectValue(part.functionCall.args),
              ...(providerMetadata ? { providerMetadata } : {})
            }
          }
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/')) {
            sawContent = true
            yield {
              kind: 'image_generation_complete',
              imageBase64: part.inlineData.data,
              mimeType: part.inlineData.mimeType
            }
          }
        }
        const blockReason = payload.response?.promptFeedback?.blockReason
        if (blockReason && !sawContent) {
          throw new Error(
            `Gemini CLI API blocked the request: ${
              payload.response?.promptFeedback?.blockReasonMessage || blockReason
            }`
          )
        }
      }
    } catch (error) {
      yield {
        kind: 'error',
        code: request.abortSignal.aborted ? 'request_aborted' : 'gemini_cli_api_stream_failed',
        message: safeErrorMessage(error)
      }
      return
    }

    if (latestUsage) {
      yield {
        kind: 'usage',
        usage: normalizeGeminiUsage(
          latestUsage,
          request.providerId?.trim() || this.provider,
          model
        )
      }
    }
    if (!sawContent) {
      yield {
        kind: 'error',
        code: 'gemini_cli_api_empty_response',
        message: /MAX_TOKENS/i.test(finishReason)
          ? 'Gemini CLI API exhausted the output-token budget before returning visible content.'
          : 'Gemini CLI API completed without returning text, reasoning, a tool call, or an image.',
        failure: {
          category: 'unavailable',
          failoverAllowed: true
        }
      }
      return
    }
    yield {
      kind: 'completed',
      stopReason: sawToolCall
        ? 'tool_calls'
        : /MAX_TOKENS/i.test(finishReason)
          ? 'length'
          : 'stop'
    }
  }

  private async startDebugRound(request: ModelRequest): Promise<LlmDebugRound | null> {
    if (!this.debugSink) return null
    return await startLlmDebugRoundIfEnabled(this.debugSink, {
      threadId: request.threadId,
      turnId: request.turnId,
      provider: this.provider,
      model: request.model?.trim() || this.model,
      toolCatalog: request.tools.map((tool) => ({
        name: tool.name,
        ...(tool.providerKind ? { providerKind: tool.providerKind } : {}),
        ...(tool.providerId ? { providerId: tool.providerId } : {})
      })),
      redactedRequestValues: goalContextTexts(request.history)
    }) ?? null
  }

  private async loadProject(
    accessToken: string,
    signal: AbortSignal,
    round: LlmDebugRound | null = null
  ): Promise<string> {
    const url = this.methodUrl('loadCodeAssist')
    const headers = geminiHeaders(accessToken)
    const requestBody = {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    }
    const body = JSON.stringify(requestBody)
    const trace = round && this.debugSink
      ? safeDebug(() => this.debugSink!.beginHttpAttempt(round, {
          endpointFormat: 'gemini-cli-api',
          attempt: 1,
          reason: 'initial',
          url,
          headers,
          bodyText: traceSafeBody(requestBody),
          secretValues: [accessToken],
          phase: 'setup',
          failureOrigin: 'setup'
        }))
      : undefined
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal
      })
      if (trace && round && this.debugSink) {
        safeDebug(() => this.debugSink!.captureHttpResponse(round, trace, response))
      }
      const payload = await response.json().catch(() => null) as GeminiCodeAssistSetup | null
      if (!response.ok) {
        if (trace) trace.diagnosticCode = 'gemini_cli_setup_failed'
        throw new GeminiCliApiHttpError(
          response.status,
          providerErrorMessage(payload?.error, response.status)
        )
      }
      const projectId = payload?.cloudaicompanionProject?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT_ID?.trim()
      if (projectId) return projectId
      const reason = payload?.ineligibleTiers
        ?.map((tier) => tier.reasonMessage?.trim())
        .filter(Boolean)
        .join('; ')
      if (trace) trace.diagnosticCode = 'gemini_cli_setup_failed'
      throw new Error(
        reason ||
        'Gemini CLI account setup is incomplete. Run `gemini` once to finish Google subscription onboarding.'
      )
    } catch (error) {
      if (trace && !(error instanceof GeminiCliApiHttpError)) {
        this.debugSink?.captureHttpError(trace, error)
      }
      throw error
    }
  }

  private async postStream(input: {
    body: Record<string, unknown>
    accessToken: string
    signal: AbortSignal
    round: LlmDebugRound | null
    attempt: number
    reason: 'initial' | 'credential_refresh' | 'transport_retry'
  }): Promise<{ response?: Response; error?: string }> {
    const url = `${this.methodUrl('streamGenerateContent')}?alt=sse`
    const headers = geminiHeaders(input.accessToken)
    const trace = input.round && this.debugSink
      ? safeDebug(() => this.debugSink!.beginHttpAttempt(input.round!, {
          endpointFormat: 'gemini-cli-api',
          attempt: input.attempt,
          reason: input.reason,
          url,
          headers,
          bodyText: traceSafeBody(input.body),
          secretValues: [input.accessToken]
        }))
      : undefined
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input.body),
        signal: input.signal
      })
      if (trace && input.round && this.debugSink) {
        safeDebug(() => this.debugSink!.captureHttpResponse(input.round!, trace, response))
      }
      return { response }
    } catch (error) {
      if (trace && this.debugSink) {
        safeDebug(() => this.debugSink!.captureHttpError(trace, error))
      }
      return {
        error: input.signal.aborted
          ? 'Gemini CLI API request was aborted.'
          : `Gemini CLI API request failed: ${safeErrorMessage(error)}`
      }
    }
  }

  private methodUrl(method: string): string {
    return `${this.endpoint}/${this.apiVersion}:${method}`
  }
}

export function buildGeminiCliCodeAssistRequest(
  request: ModelRequest,
  model: string,
  projectId: string
): Record<string, unknown> {
  const messages = projectCompatMessages(request, {
    thinkingMode: false,
    supportsImages: true
  })
  const projected = messagesToGemini(messages, request)
  const generationConfig: Record<string, unknown> = {}
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (request.topP !== undefined) generationConfig.topP = request.topP
  if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens
  if (request.responseFormat === 'json_object') {
    generationConfig.responseMimeType = 'application/json'
  }
  const thinkingConfig = geminiThinkingConfig(request.reasoningEffort)
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig

  const inner: Record<string, unknown> = {
    contents: projected.contents,
    ...(projected.systemInstruction
      ? { systemInstruction: { role: 'user', parts: [{ text: projected.systemInstruction }] } }
      : {}),
    ...(request.tools.length
      ? {
          tools: [{
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.inputSchema
            }))
          }],
          toolConfig: {
            functionCallingConfig: request.requiredToolName
              ? { mode: 'ANY', allowedFunctionNames: [request.requiredToolName] }
              : { mode: 'AUTO' }
          }
        }
      : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    session_id: request.threadId
  }

  return {
    model,
    project: projectId,
    user_prompt_id: randomUUID(),
    request: inner
  }
}

function messagesToGemini(
  messages: CompatChatMessage[],
  request: ModelRequest
): { systemInstruction: string; contents: GeminiContent[] } {
  const systems: string[] = []
  const contents: GeminiContent[] = []
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name)
    }
  }
  const metadataByCallId = new Map<string, ToolCallProviderMetadata>()
  for (const item of [...request.prefix, ...request.history]) {
    if (item.kind === 'tool_call' && item.providerMetadata?.gemini) {
      metadataByCallId.set(item.callId, item.providerMetadata)
    }
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = compatContentText(message.content).trim()
      if (text) systems.push(text)
      continue
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) continue
      appendGeminiContent(contents, {
        role: 'user',
        parts: [{
          functionResponse: {
            id: message.tool_call_id,
            name: toolNames.get(message.tool_call_id) ?? 'tool',
            response: { output: compatContentText(message.content) }
          }
        }]
      })
      continue
    }
    const parts = compatContentParts(message.content)
    for (const call of message.tool_calls ?? []) {
      const signature = metadataByCallId.get(call.id)?.gemini?.thoughtSignature
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: parseObject(call.function.arguments)
        },
        ...(signature ? { thoughtSignature: signature } : {})
      })
    }
    if (parts.length > 0) {
      appendGeminiContent(contents, {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts
      })
    }
  }
  return { systemInstruction: systems.join('\n\n'), contents }
}

function appendGeminiContent(contents: GeminiContent[], next: GeminiContent): void {
  const previous = contents.at(-1)
  if (previous?.role === next.role) {
    previous.parts.push(...next.parts)
  } else {
    contents.push(next)
  }
}

function compatContentParts(
  content: CompatChatMessage['content']
): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!content) return []
  const out: GeminiPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push({ text: part.text })
      continue
    }
    const image = dataUri(part)
    if (image) out.push({ inlineData: image })
    else out.push({ text: `[image unavailable to Gemini CLI API: ${part.image_url.url}]` })
  }
  return out
}

function compatContentText(content: CompatChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content.map((part) =>
    part.type === 'text' ? part.text : `[image: ${part.image_url.url}]`
  ).join('\n')
}

function dataUri(
  part: Extract<CompatChatMessageContentPart, { type: 'image_url' }>
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(part.image_url.url)
  return match ? { mimeType: match[1], data: match[2] } : null
}

function geminiThinkingConfig(effort: string | undefined): Record<string, unknown> | null {
  switch (effort?.trim().toLowerCase()) {
    case 'off':
      return { thinkingBudget: 0, includeThoughts: false }
    case 'low':
      return { thinkingBudget: 1_024, includeThoughts: true }
    case 'high':
    case 'max':
    case 'xhigh':
      return { thinkingBudget: 16_384, includeThoughts: true }
    case 'medium':
      return { thinkingBudget: 8_192, includeThoughts: true }
    default:
      return null
  }
}

async function *readGeminiSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<GeminiCodeAssistResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames = new IncrementalSseFrameBuffer()
  let totalBytes = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('Gemini CLI API stream was aborted.')
      const { value, done } = await reader.read()
      if (done) break
      totalBytes += value?.byteLength ?? 0
      if (totalBytes > MAX_STREAM_BYTES) {
        throw new Error(`Gemini CLI API stream exceeded ${MAX_STREAM_BYTES} bytes.`)
      }
      frames.append(decoder.decode(value, { stream: true }))
      let frame = frames.takeFrame()
      while (frame) {
        if (Buffer.byteLength(frame.data, 'utf8') > MAX_SSE_FRAME_BYTES) {
          throw new Error(`Gemini CLI API SSE frame exceeded ${MAX_SSE_FRAME_BYTES} bytes.`)
        }
        const data = frame.data
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim()
        if (data && data !== '[DONE]') {
          let parsed: GeminiCodeAssistResponse
          try {
            parsed = JSON.parse(data) as GeminiCodeAssistResponse
          } catch {
            throw new Error('Gemini CLI API returned malformed SSE JSON.')
          }
          if (parsed.error) {
            throw new Error(providerErrorMessage(parsed.error, parsed.error.code ?? 500))
          }
          yield parsed
        }
        frame = frames.takeFrame()
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeGeminiUsage(
  usage: GeminiUsageMetadata,
  providerId: string,
  model: string
): UsageSnapshot {
  const promptTokens = nonNegativeInt(usage.promptTokenCount)
  const completionTokens = nonNegativeInt(usage.candidatesTokenCount)
  const reasoningTokens = nonNegativeInt(usage.thoughtsTokenCount)
  const totalTokens = nonNegativeInt(usage.totalTokenCount) ||
    promptTokens + completionTokens + reasoningTokens
  const cacheHitTokens = nonNegativeInt(usage.cachedContentTokenCount)
  const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens)
  const cacheable = cacheHitTokens + cacheMissTokens
  return {
    promptTokens,
    completionTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    totalTokens,
    actualProviderId: providerId,
    actualModelId: model,
    cachedTokens: cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: cacheable > 0 ? cacheHitTokens / cacheable : null,
    turns: 1
  }
}

async function readGeminiError(response: Response): Promise<{
  message: string
  status?: string
  retryAfterMs?: number
}> {
  const text = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES)
  let payload: GeminiCodeAssistResponse | null = null
  try {
    payload = JSON.parse(text) as GeminiCodeAssistResponse
  } catch {
    // A bounded plain-text error still produces a useful conversation card.
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ??
    parseGoogleRetryDurationMs(payload?.error?.message ?? text)
  return {
    message: providerErrorMessage(payload?.error, response.status, text),
    ...(payload?.error?.status ? { status: payload.error.status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  }
}

async function geminiRetryDelayMs(
  response: Response,
  initialDelayMs: number,
  attempt: number
): Promise<number> {
  const headerDelay = parseRetryAfterMs(response.headers.get('retry-after'))
  if (headerDelay !== undefined) return headerDelay
  if (response.status === 429) {
    const text = (await response.clone().text().catch(() => '')).slice(0, MAX_ERROR_BODY_BYTES)
    const providerDelay = parseGoogleRetryDurationMs(text)
    if (providerDelay !== undefined) return Math.min(60_000, providerDelay)
  }
  return retryDelayMs(response, initialDelayMs, attempt)
}

function parseGoogleRetryDurationMs(value: string): number | undefined {
  const match = /(?:quota will reset after|please retry in)\s*((?:\d+(?:\.\d+)?(?:ms|[smhd]))+)/i.exec(value)
  if (!match?.[1]) return undefined
  let total = 0
  const units = /(\d+(?:\.\d+)?)(ms|[smhd])/gi
  let part: RegExpExecArray | null
  let parsed = false
  while ((part = units.exec(match[1])) !== null) {
    parsed = true
    const amount = Number(part[1])
    if (!Number.isFinite(amount) || amount < 0) continue
    const multiplier = part[2].toLowerCase() === 'ms'
      ? 1
      : part[2].toLowerCase() === 's'
        ? 1_000
        : part[2].toLowerCase() === 'm'
          ? 60_000
          : part[2].toLowerCase() === 'h'
            ? 3_600_000
            : 86_400_000
    total += amount * multiplier
  }
  return parsed ? Math.min(3_600_000, Math.round(total)) : undefined
}

function providerErrorMessage(
  error: GeminiCodeAssistResponse['error'] | undefined,
  status: number,
  fallback = ''
): string {
  const detail = error?.message?.trim() || fallback.replace(/\s+/g, ' ').trim()
  return `Gemini CLI API request failed (${error?.status || `HTTP ${status}`}): ${
    boundedText(detail || 'Unknown provider error')
  }`
}

function geminiErrorCode(status: number, providerStatus?: string): string {
  if (status === 401 || status === 403) return 'gemini_cli_auth_failed'
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') return 'rate_limit_exceeded'
  if (status >= 500) return 'gemini_cli_api_unavailable'
  return 'gemini_cli_api_request_failed'
}

function geminiHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': 'google-gemini-cli',
    'x-goog-api-client': 'gl-node/kun gemini-cli-api'
  }
}

function geminiProviderMetadata(
  thoughtSignature: string | undefined
): ToolCallProviderMetadata | null {
  const signature = thoughtSignature?.trim()
  if (!signature || signature.length > 131_072) return null
  return { gemini: { thoughtSignature: signature } }
}

function traceSafeBody(body: Record<string, unknown>): string {
  return JSON.stringify(body, (key, value) =>
    key === 'thoughtSignature' ? '[REDACTED]' : value
  )
}

function parseObject(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value) as unknown)
  } catch {
    return {}
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0
}

function boundedText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 2_000 ? `${normalized.slice(0, 2_000)}…` : normalized
}

function safeErrorMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error))
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof GeminiCliApiHttpError && error.status === 401
}

class GeminiCliApiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GeminiCliApiHttpError'
  }
}

function safeDebug<T>(action: () => T): T | undefined {
  try {
    return action()
  } catch {
    return undefined
  }
}
