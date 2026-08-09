import { randomUUID } from 'node:crypto'
import type { ToolCallProviderMetadata } from '../../contracts/items.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import type { ModelRequest } from '../../ports/model-client.js'
import type { CompatChatMessage, CompatChatMessageContentPart } from './compat-request-codecs.js'
import { projectCompatMessages } from './compat-message-projector.js'
import { IncrementalSseFrameBuffer } from './incremental-sse-frame-buffer.js'
import { parseRetryAfterMs, retryDelayMs } from './compat-retry-policy.js'

const MAX_ERROR_BODY_BYTES = 256 * 1024
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024

export type GeminiPart = {
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

export type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiCodeAssistResponse = {
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

export type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
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

export async function *readGeminiSse(
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

export function normalizeGeminiUsage(
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

export async function readGeminiError(response: Response): Promise<{
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

export async function geminiRetryDelayMs(
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

export function providerErrorMessage(
  error: GeminiCodeAssistResponse['error'] | undefined,
  status: number,
  fallback = ''
): string {
  const detail = error?.message?.trim() || fallback.replace(/\s+/g, ' ').trim()
  return `Gemini CLI API request failed (${error?.status || `HTTP ${status}`}): ${
    boundedText(detail || 'Unknown provider error')
  }`
}

export function geminiErrorCode(status: number, providerStatus?: string): string {
  if (status === 401 || status === 403) return 'gemini_cli_auth_failed'
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') return 'rate_limit_exceeded'
  if (status >= 500) return 'gemini_cli_api_unavailable'
  return 'gemini_cli_api_request_failed'
}

export function geminiHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': 'google-gemini-cli',
    'x-goog-api-client': 'gl-node/kun gemini-cli-api'
  }
}

export function geminiProviderMetadata(
  thoughtSignature: string | undefined
): ToolCallProviderMetadata | null {
  const signature = thoughtSignature?.trim()
  if (!signature || signature.length > 131_072) return null
  return { gemini: { thoughtSignature: signature } }
}

export function traceSafeBody(body: Record<string, unknown>): string {
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

export function objectValue(value: unknown): Record<string, unknown> {
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

export function safeErrorMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error))
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof GeminiCliApiHttpError && error.status === 401
}

export class GeminiCliApiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GeminiCliApiHttpError'
  }
}

export function safeDebug<T>(action: () => T): T | undefined {
  try {
    return action()
  } catch {
    return undefined
  }
}
