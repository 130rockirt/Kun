import type { ModelCapabilityMetadata } from '../../contracts/capabilities.js'
import type { ModelToolSpec } from '../../ports/model-client.js'
import { isDeepSeekHost } from './model-error-probe.js'
import { repairToolArguments } from './tool-argument-repair.js'
import {
  COMPAT_ANTHROPIC_THINKING,
  COMPAT_TOOL_RESULT_ERROR,
  CompatRequestCodecs,
  type CompatChatMessage,
  type CompatChatMessageContentPart
} from './compat-request-codecs.js'

type AnthropicCacheControl = { type: 'ephemeral' }
type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
type AnthropicContentBlock = (
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
) & { cache_control?: AnthropicCacheControl }
type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

const CODEX_NATIVE_IMAGE_GENERATION_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'])

export function createCompatRequestCodecs(): CompatRequestCodecs {
  return new CompatRequestCodecs({
    splitOpenAiMessages: (value) =>
      splitToolImageMessagesForOpenAi(value as CompatChatMessage[]),
    responsesInput: (value) => messagesToResponsesInput(value as CompatChatMessage[]),
    toAnthropic: (value, thinkingMode) =>
      messagesToAnthropic(value as CompatChatMessage[], thinkingMode),
    applyAnthropicCacheControl: (value) =>
      applyAnthropicCacheControl(value as AnthropicMessage[]),
    plainText: (value) => chatContentToPlainText(value as CompatChatMessage['content']),
    applyChatReasoning: (requestBody, effort, input) => applyReasoningEffort(requestBody, effort, {
      ...input,
      maxReasoningEffort: input.nativeDeepSeekHost ? 'max' : 'high'
    }),
    responsesReasoning: (effort, capability, options) =>
      responsesReasoningForEffort(effort, capability, options),
    applyAnthropicReasoning: (requestBody, effort, capability) =>
      applyAnthropicReasoningEffort(requestBody, effort, capability),
    resolveReasoning: (effort, capability) => resolveReasoningEffort(effort, capability)
  })
}

export function normalizeToolSpecs(tools: ModelToolSpec[]): ModelToolSpec[] {
  return [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeSchema(tool.inputSchema)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function codexModelSupportsNativeImageGeneration(model: string): boolean {
  return CODEX_NATIVE_IMAGE_GENERATION_MODELS.has(normalizeModelId(model))
}

function messagesToResponsesInput(messages: CompatChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: chatContentToPlainText(message.content)
        })
      }
      continue
    }
    const content = chatContentToResponsesContent(message.content)
    if (content !== undefined && !(Array.isArray(content) && content.length === 0)) {
      input.push({
        role: message.role,
        content
      })
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: 'completed'
      })
    }
  }
  return input
}

function messagesToAnthropic(
  messages: CompatChatMessage[],
  includeThinkingBlocks = false
): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = []
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = chatContentToPlainText(message.content).trim()
      if (!text) continue
      // System messages that arrive after conversation turns are the
      // volatile per-turn context (goal budgets, memories, drift
      // warnings). Hoisting them into the top-level `system` block
      // would invalidate the provider's prompt cache for the whole
      // conversation on every counter tick, so they trail the history
      // inside a user turn instead — mirroring the chat_completions
      // ordering in collectMessages.
      if (out.length > 0) {
        appendTrailingInstruction(out, text)
        continue
      }
      system.push(text)
      continue
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) continue
      // Keep `tool_result` content as plain text. Anthropic's own API also
      // accepts an `image` block INSIDE tool_result (the computer-use beta
      // shape), but third-party Anthropic-compat providers (MiniMax, etc.)
      // often have not implemented that newer shape and return 502 / 4xx
      // when they see it. The image rides instead as a sibling `image`
      // block in the same user message — the older shape that every
      // compat layer accepts.
      const blocks: AnthropicContentBlock[] = [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: chatContentToTextOnly(message.content),
        ...(message[COMPAT_TOOL_RESULT_ERROR] === true ? { is_error: true } : {})
      }]
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== 'image_url') continue
          const image = anthropicImageSource(part.image_url.url)
          if (image) blocks.push({ type: 'image', source: image })
        }
      }
      // Parallel tool calls arrive as N consecutive `role: 'tool'` messages.
      // Anthropic requires every tool_use from a single assistant turn to be
      // answered by tool_result blocks inside ONE user message — emitting N
      // separate user messages trips "tool_use ids were found without
      // tool_result blocks immediately after" on compat providers. Real user
      // turns never carry a tool_result block, so its presence marks the run
      // we are still folding into.
      const last = out[out.length - 1]
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        (last.content as AnthropicContentBlock[]).some((b) => b.type === 'tool_result')
      ) {
        last.content.push(...blocks)
      } else {
        out.push({ role: 'user', content: blocks })
      }
      continue
    }
    const content = chatContentToAnthropicContent(message.content)
    const blocks: AnthropicContentBlock[] = Array.isArray(content)
      ? [...content]
      : content.trim()
        ? [{ type: 'text' as const, text: content }]
        : []
    if (includeThinkingBlocks && message.role === 'assistant') {
      const preserved = message[COMPAT_ANTHROPIC_THINKING]
      if (preserved?.length) {
        blocks.unshift(...preserved.map((block) => ({ ...block })))
      }
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: repairToolArguments(call.function.arguments).arguments
      })
    }
    if (blocks.length > 0) {
      out.push({ role: message.role, content: blocks })
      continue
    }
  }
  return { system: system.join('\n\n'), messages: out }
}

/**
 * Folds a trailing system instruction into the conversation as user
 * content. Appends to the final user message when one exists so the
 * request keeps strict user/assistant alternation.
 */
function appendTrailingInstruction(out: AnthropicMessage[], text: string): void {
  const block: AnthropicContentBlock = { type: 'text', text }
  const last = out[out.length - 1]
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = last.content.trim()
        ? [{ type: 'text', text: last.content }, block]
        : [block]
      return
    }
    last.content.push(block)
    return
  }
  out.push({ role: 'user', content: [block] })
}

/**
 * Marks the stable prefix for provider-side prompt caching. Anthropic
 * protocol caching is explicit: providers such as MiniMax only cache
 * content before `cache_control` breakpoints (up to 4 per request).
 * One breakpoint goes on the system block (which also covers the tool
 * definitions that precede it) and one on the final content block of
 * each of the last two messages, so consecutive agent steps re-hit the
 * prefix cached by the previous request.
 */
function applyAnthropicCacheControl(messages: AnthropicMessage[]): void {
  let breakpoints = 0
  for (let i = messages.length - 1; i >= 0 && breakpoints < 2; i -= 1) {
    const content = messages[i].content
    if (typeof content === 'string' || content.length === 0) continue
    content[content.length - 1].cache_control = { type: 'ephemeral' }
    breakpoints += 1
  }
}

function chatContentToResponsesContent(
  content: CompatChatMessage['content']
): string | Array<Record<string, unknown>> | undefined {
  if (content === null || content === undefined) return undefined
  if (typeof content === 'string') return content
  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image_url') {
      parts.push({ type: 'input_image', image_url: part.image_url.url })
    }
  }
  return parts
}

/**
 * OpenAI chat-completions and Responses APIs do not accept image parts
 * inside a `tool`/`function_call_output` message. When a tool result
 * carries images, keep the tool message text-only and re-emit the
 * image(s) in a following synthetic user message so vision models still
 * see them. Anthropic Messages handles images inline and skips this.
 */
function splitToolImageMessagesForOpenAi(messages: CompatChatMessage[]): CompatChatMessage[] {
  const hasToolImages = messages.some(
    (message) =>
      message.role === 'tool' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url')
  )
  if (!hasToolImages) return messages
  const out: CompatChatMessage[] = []
  let pendingImages: CompatChatMessageContentPart[] = []
  const flushImages = (): void => {
    if (pendingImages.length === 0) return
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: '(Automated) The tool call(s) above returned the following image(s):' },
        ...pendingImages
      ]
    })
    pendingImages = []
  }
  for (const message of messages) {
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const textParts: string[] = []
      const imageParts: CompatChatMessageContentPart[] = []
      for (const part of message.content) {
        if (part.type === 'text') textParts.push(part.text)
        else imageParts.push(part)
      }
      out.push({
        ...message,
        content: textParts.join('\n') || '(image returned; see the following message)'
      })
      pendingImages.push(...imageParts)
      continue
    }
    // Flush queued images once the run of tool results ends, so they land
    // after the whole tool batch but before the next assistant turn.
    if (message.role !== 'tool') flushImages()
    out.push(message)
  }
  flushImages()
  return out
}

function chatContentToAnthropicContent(content: CompatChatMessage['content']): string | AnthropicContentBlock[] {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  const parts: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text })
      continue
    }
    const image = anthropicImageSource(part.image_url.url)
    if (image) parts.push({ type: 'image', source: image })
  }
  return parts
}

function anthropicImageSource(value: string): AnthropicImageSource | null {
  const data = parseDataUri(value)
  if (data) {
    return {
      type: 'base64',
      media_type: data.mimeType,
      data: data.base64
    }
  }
  if (/^https?:\/\//i.test(value)) {
    return { type: 'url', url: value }
  }
  return null
}

function parseDataUri(value: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(value)
  if (!match) return null
  return { mimeType: match[1], base64: match[2] }
}

function chatContentToPlainText(content: CompatChatMessage['content']): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return part.text
    return `[image: ${part.image_url.url}]`
  }).join('\n')
}

/**
 * Extract ONLY text parts from a chat-message content array — image parts
 * are dropped entirely (no `[image: data:...]` placeholder). Used when the
 * image rides separately (as a sibling block in the user message) so the
 * raw base64 does not leak back into the text channel.
 */
function chatContentToTextOnly(content: CompatChatMessage['content']): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<CompatChatMessageContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

type ModelReasoningCapability = NonNullable<ModelCapabilityMetadata['reasoning']>
type NormalizedReasoningEffort = ModelReasoningCapability['defaultEffort']

function responsesReasoningForEffort(
  effort: string | undefined,
  reasoning?: ModelReasoningCapability,
  options: {
    maxEffort?: 'high' | 'xhigh'
    includeSummary?: boolean
  } = {}
): Record<string, unknown> | null {
  if (reasoning && reasoning.requestProtocol !== 'openai-responses') return null
  const resolved = reasoning
    ? resolveReasoningEffort(effort, reasoning)
    : normalizeReasoningEffortValue(effort)
  if (resolved === 'auto' || resolved === 'off' || !resolved) return null
  const normalized = resolved
  const payload = (wireEffort: string): Record<string, unknown> => ({
    effort: wireEffort,
    ...(options.includeSummary ? { summary: 'auto' } : {})
  })
  switch (normalized) {
    case 'low':
      return payload('low')
    case 'medium':
      return payload('medium')
    case 'high':
      return payload('high')
    case 'max':
      return payload(options.maxEffort ?? 'high')
    default:
      return null
  }
}


function applyReasoningEffort(
  body: Record<string, unknown>,
  effort: string | undefined,
  options: {
    includeThinking?: boolean
    nativeDeepSeekHost?: boolean
    geminiOpenAiHost?: boolean
    reasoning?: ModelReasoningCapability
    maxReasoningEffort?: 'high' | 'max'
  } = {}
): void {
  const normalized = options.reasoning
    ? resolveReasoningEffort(effort, options.reasoning)
    : normalizeReasoningEffortValue(effort)
  if (!normalized) return
  const includeThinking = options.includeThinking !== false
  // thinking field in DeepSeek format is only supported on the official DeepSeek API.
  // Third-party OpenAI-compat proxies (SiliconFlow, OpenRouter, llama.cpp, etc.) may
  // reject or mishandle it, causing 400 errors or empty responses. See issue #26.
  const nativeDeepSeek = options.nativeDeepSeekHost === true
  if (options.geminiOpenAiHost === true) {
    applyGeminiOpenAiReasoningEffort(body, normalized)
    return
  }
  if (options.reasoning) {
    applyProfileReasoningEffort(body, normalized, options.reasoning, includeThinking, nativeDeepSeek)
    return
  }
  switch (normalized) {
    case 'off':
      if (nativeDeepSeek) body.thinking = { type: 'disabled' }
      break
    case 'low':
    case 'medium':
    case 'high':
      body.reasoning_effort = 'high'
      if (nativeDeepSeek) body.thinking = { type: 'enabled' }
      break
    case 'max':
      body.reasoning_effort = options.maxReasoningEffort ?? 'max'
      if (nativeDeepSeek) body.thinking = { type: 'enabled' }
      break
  }
}

function applyGeminiOpenAiReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort
): void {
  switch (effort) {
    case 'auto':
      return
    case 'off':
      // Gemini 3 models cannot disable thinking. "minimal" is the closest
      // compatible setting and is also accepted by Gemini 2.5.
      body.reasoning_effort = 'minimal'
      return
    case 'low':
    case 'medium':
    case 'high':
      body.reasoning_effort = effort
      return
    case 'max':
      body.reasoning_effort = 'high'
      return
  }
}

function applyProfileReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort,
  reasoning: ModelReasoningCapability,
  includeThinking: boolean,
  nativeDeepSeekHost: boolean
): void {
  switch (reasoning.requestProtocol) {
    case 'none':
    case 'openai-responses':
    case 'anthropic-thinking':
      return
    case 'openai-chat-completions':
      applyOpenAiChatReasoningEffort(body, effort)
      return
    case 'qwen-chat-completions':
      applyQwenChatReasoningEffort(body, effort)
      return
    case 'thinking-toggle-chat-completions':
      applyThinkingToggleChatReasoningEffort(body, effort, includeThinking)
      return
    case 'deepseek-chat-completions':
      applyDeepSeekChatReasoningEffort(body, effort, nativeDeepSeekHost)
      return
    case 'glm-chat-completions':
      applyGlmChatReasoningEffort(body, effort, includeThinking)
      return
    case 'mimo-chat-completions':
      applyMimoChatReasoningEffort(body, effort, includeThinking)
      return
  }
}

function applyOpenAiChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort
): void {
  switch (effort) {
    case 'auto':
      return
    case 'off':
      body.reasoning_effort = 'none'
      return
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      body.reasoning_effort = effort
      return
  }
}

function applyQwenChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort
): void {
  body.enable_thinking = effort !== 'off'
}

function applyThinkingToggleChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort,
  includeThinking: boolean
): void {
  if (!includeThinking) return
  body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' }
}

function applyDeepSeekChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort,
  includeThinking: boolean
): void {
  if (effort === 'off') {
    if (includeThinking) body.thinking = { type: 'disabled' }
    return
  }
  if (effort === 'max') {
    body.reasoning_effort = 'max'
  } else if (effort !== 'auto') {
    body.reasoning_effort = 'high'
  }
  if (includeThinking && effort !== 'auto') body.thinking = { type: 'enabled' }
}

function applyGlmChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort,
  includeThinking: boolean
): void {
  if (!includeThinking || effort === 'auto') return
  body.thinking = {
    type: effort === 'off' ? 'disabled' : 'enabled',
    clear_thinking: true
  }
}

function applyMimoChatReasoningEffort(
  body: Record<string, unknown>,
  effort: NormalizedReasoningEffort,
  includeThinking: boolean
): void {
  if (effort === 'off') {
    if (includeThinking) body.thinking = { type: 'disabled' }
    return
  }
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    body.reasoning_effort = effort
    if (includeThinking) body.thinking = { type: 'enabled' }
  }
}

function applyAnthropicReasoningEffort(
  body: Record<string, unknown>,
  effort: string | undefined,
  reasoning?: ModelReasoningCapability
): void {
  if (reasoning?.requestProtocol !== 'anthropic-thinking') return
  const resolved = resolveReasoningEffort(effort, reasoning)
  if (!resolved) return
  if (resolved === 'off') {
    body.thinking = { type: 'disabled' }
    return
  }
  body.thinking = { type: 'adaptive' }
  const outputEffort = anthropicOutputEffortForReasoningEffort(resolved)
  if (outputEffort) body.output_config = { effort: outputEffort }
}

function anthropicOutputEffortForReasoningEffort(
  effort: NormalizedReasoningEffort
): 'low' | 'medium' | 'high' | 'max' | null {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return effort
    case 'auto':
    case 'off':
      return null
  }
}

function resolveReasoningEffort(
  effort: string | undefined,
  reasoning: ModelReasoningCapability
): NormalizedReasoningEffort | undefined {
  const normalized = normalizeReasoningEffortValue(effort)
  if (!normalized) return undefined
  if (reasoning.supportedEfforts.includes(normalized)) return normalized
  if (
    normalized === 'low' &&
    reasoning.supportedEfforts.includes('off') &&
    !reasoning.supportedEfforts.includes('low')
  ) {
    return 'off'
  }
  return reasoning.defaultEffort
}

function normalizeReasoningEffortValue(effort: string | undefined): NormalizedReasoningEffort | undefined {
  switch (effort?.trim().toLowerCase()) {
    case 'auto':
    case 'adaptive':
      return 'auto'
    case 'off':
    case 'disabled':
    case 'none':
    case 'false':
      return 'off'
    case 'low':
    case 'minimal':
      return 'low'
    case 'medium':
    case 'mid':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
    case 'maximum':
    case 'xhigh':
      return 'max'
    default:
      return undefined
  }
}



function isAzureOpenAiEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.toLowerCase()
    return host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')
  } catch {
    return /\.openai\.azure\.com\b|\.cognitiveservices\.azure\.com\b/i.test(baseUrl)
  }
}

function isThinkingMode(effort: string | undefined): boolean {
  const normalized = effort?.trim().toLowerCase()
  if (!normalized) return false
  return !['off', 'disabled', 'none', 'false'].includes(normalized)
}

export function requiresReasoningRoundTrip(
  effort: string | undefined,
  model: string | undefined,
  baseUrl: string,
  reasoning?: ModelReasoningCapability
): boolean {
  if (reasoning) {
    const resolved = resolveReasoningEffort(effort, reasoning)
    if (resolved) {
      return resolved !== 'off' && reasoning.requestProtocol !== 'none'
    }
    return isDeepSeekHost(baseUrl) && isThinkingProducerModel(model)
  }
  // Thinking-mode round trip is a DeepSeek-specific protocol extension.
  // OpenAI-compat providers (OpenRouter, llama.cpp, etc.) may reject
  // or misinterpret the `thinking` field, so we only auto-enable it
  // on the official DeepSeek host. User-selected reasoningEffort still
  // forces the path (opt-in). See issue #26.
  return isThinkingMode(effort) || (isDeepSeekHost(baseUrl) && isThinkingProducerModel(model))
}

function isThinkingProducerModel(model: string | undefined): boolean {
  const normalized = normalizeModelId(model)
  if (!normalized) return false
  return normalized === 'deepseek-v4-pro' ||
    normalized === 'deepseek-v4-flash' ||
    normalized.includes('deepseek-reasoner') ||
    normalized.endsWith('/deepseek-v4-pro') ||
    normalized.endsWith('/deepseek-v4-flash')
}


function canonicalizeSchema(value: unknown): Record<string, unknown> {
  const canonical = canonicalize(value)
  return canonical && typeof canonical === 'object' && !Array.isArray(canonical)
    ? canonical as Record<string, unknown>
    : {}
}

function normalizeModelId(model: string | undefined): string {
  return model?.trim().toLowerCase() ?? ''
}


function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}
