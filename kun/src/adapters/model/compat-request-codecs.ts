import type { ModelCapabilityMetadata } from '../../contracts/capabilities.js'
import type { ModelEndpointFormat } from '../../contracts/model-endpoint-format.js'
import type { ModelRequest, ModelToolSpec } from '../../ports/model-client.js'
import { isDeepSeekHost, isGeminiOpenAiHost } from './model-error-probe.js'

export const COMPAT_HISTORY_CONTEXT = Symbol('compat-history-context')

export type CompatChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | CompatChatMessageContentPart[] | null
  [COMPAT_HISTORY_CONTEXT]?: true
  name?: string
  tool_call_id?: string
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type CompatChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type ReasoningCapability = ModelCapabilityMetadata['reasoning']

export type CompatRequestCodecInput = {
  request: ModelRequest
  model: string
  messages: CompatChatMessage[]
  tools: ModelToolSpec[]
  stream: boolean
  endpointFormat: ModelEndpointFormat
  includeStreamUsage?: boolean
  baseUrl: string
  reasoning?: ReasoningCapability
  maxTokens?: number
  isCodex: boolean
  isCodexLite: boolean
  codexNativeImageGeneration: boolean
}

export type CompatRequestCodecDeps = {
  splitOpenAiMessages: (messages: CompatChatMessage[]) => CompatChatMessage[]
  responsesInput: (messages: CompatChatMessage[]) => Array<Record<string, unknown>>
  toAnthropic: (
    messages: CompatChatMessage[],
    thinkingMode: boolean
  ) => { system: string; messages: Array<{ content: unknown }> }
  applyAnthropicCacheControl: (messages: Array<{ content: unknown }>) => void
  plainText: (content: CompatChatMessage['content']) => string
  applyChatReasoning: (
    body: Record<string, unknown>,
    effort: string | undefined,
    input: {
      includeThinking: boolean
      nativeDeepSeekHost: boolean
      geminiOpenAiHost: boolean
      reasoning?: ReasoningCapability
    }
  ) => void
  responsesReasoning: (
    effort: string | undefined,
    reasoning: ReasoningCapability,
    options: { maxEffort: 'high' | 'xhigh'; includeSummary: boolean }
  ) => Record<string, unknown> | null
  applyAnthropicReasoning: (
    body: Record<string, unknown>,
    effort: string | undefined,
    reasoning: ReasoningCapability
  ) => void
  resolveReasoning: (
    effort: string | undefined,
    reasoning: NonNullable<ReasoningCapability>
  ) => string | undefined
}

const DEFAULT_MESSAGES_MAX_TOKENS = 8_192
const DEFAULT_MESSAGES_REASONING_MAX_TOKENS = 32_768

export class CompatRequestCodecs {
  constructor(private readonly deps: CompatRequestCodecDeps) {}

  build(input: CompatRequestCodecInput): Record<string, unknown> {
    switch (input.endpointFormat) {
      case 'responses':
        return this.responses(input)
      case 'messages':
        return this.messages(input)
      default:
        return this.chatCompletions(input)
    }
  }

  private chatCompletions(input: CompatRequestCodecInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: input.model,
      stream: input.stream,
      messages: this.deps.splitOpenAiMessages(input.messages)
    }
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens
    if (input.request.temperature !== undefined) body.temperature = input.request.temperature
    if (input.request.topP !== undefined) body.top_p = input.request.topP
    if (input.request.responseFormat === 'json_object') body.response_format = { type: 'json_object' }
    if (input.stream && input.includeStreamUsage !== false) body.stream_options = { include_usage: true }
    const nativeDeepSeekHost = isDeepSeekHost(input.baseUrl)
    const geminiOpenAiHost = isGeminiOpenAiHost(input.baseUrl)
    const includeThinking = !isAzureOpenAiEndpoint(input.baseUrl) && !geminiOpenAiHost
    this.deps.applyChatReasoning(body, input.request.reasoningEffort, {
      includeThinking,
      nativeDeepSeekHost,
      geminiOpenAiHost,
      reasoning: input.reasoning
    })
    if (
      includeThinking && nativeDeepSeekHost &&
      !Object.prototype.hasOwnProperty.call(body, 'thinking') &&
      isThinkingProducerModel(input.model)
    ) {
      body.thinking = { type: 'enabled' }
    }
    if (input.tools.length) {
      body.tools = input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }))
    }
    return body
  }

  private responses(input: CompatRequestCodecInput): Record<string, unknown> {
    const system = input.isCodex
      ? input.messages.filter(
          (message) => message.role === 'system' && message[COMPAT_HISTORY_CONTEXT] !== true
        )
      : []
    const nonSystem = input.isCodex
      ? input.messages.filter(
          (message) => message.role !== 'system' || message[COMPAT_HISTORY_CONTEXT] === true
        )
      : input.messages
    let instructions = system
      .map((message) => this.deps.plainText(message.content).trim())
      .filter(Boolean)
      .join('\n\n')
    const responseTools = input.tools.map((tool) => ({
      type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema
    }))
    let responseInput = this.deps.responsesInput(this.deps.splitOpenAiMessages(nonSystem))
    if (input.isCodex && !input.isCodexLite && responseInput.length === 0 && instructions) {
      // The Responses endpoint requires input even when the request has only
      // system context. Move (rather than duplicate) that context into a
      // supported system-role input item so the wire request remains valid.
      responseInput = [{ role: 'system', content: instructions }]
      instructions = ''
    }
    const litePrefix: Array<Record<string, unknown>> = input.isCodexLite
      ? [
          { type: 'additional_tools', role: 'developer', tools: responseTools },
          ...(instructions ? [{
            type: 'message', role: 'developer',
            content: [{ type: 'input_text', text: instructions }]
          }] : [])
        ]
      : []
    const body: Record<string, unknown> = {
      model: input.model,
      stream: input.stream,
      input: input.isCodexLite ? [...litePrefix, ...responseInput] : responseInput,
      ...(input.isCodexLite
        ? { store: false, tool_choice: 'auto', parallel_tool_calls: false }
        : input.isCodex ? { instructions: instructions || ' ', store: false } : {}),
      ...(input.isCodex ? { prompt_cache_key: input.request.threadId } : {})
    }
    if (input.maxTokens !== undefined && !input.isCodex) body.max_output_tokens = input.maxTokens
    if (input.request.temperature !== undefined) body.temperature = input.request.temperature
    if (input.request.topP !== undefined) body.top_p = input.request.topP
    if (input.request.responseFormat === 'json_object') body.text = { format: { type: 'json_object' } }
    const reasoning = this.deps.responsesReasoning(
      input.request.reasoningEffort,
      input.reasoning,
      { maxEffort: input.isCodex ? 'xhigh' : 'high', includeSummary: input.isCodex }
    )
    if (reasoning || input.isCodexLite) {
      body.reasoning = input.isCodexLite ? { ...(reasoning ?? {}), context: 'all_turns' } : reasoning!
      if (input.isCodex) body.include = ['reasoning.encrypted_content']
    }
    if (!input.isCodexLite && responseTools.length) body.tools = responseTools
    if (!input.isCodexLite && input.isCodex && input.codexNativeImageGeneration) {
      body.tools = [...((body.tools ?? []) as Record<string, unknown>[]), { type: 'image_generation' }]
    }
    return body
  }

  private messages(input: CompatRequestCodecInput): Record<string, unknown> {
    const anthropicThinking = input.reasoning?.requestProtocol === 'anthropic-thinking'
    const converted = this.deps.toAnthropic(input.messages, anthropicThinking)
    this.deps.applyAnthropicCacheControl(converted.messages)
    const resolvedEffort = anthropicThinking && input.reasoning
      ? this.deps.resolveReasoning(input.request.reasoningEffort, input.reasoning)
      : undefined
    const thinkingEnabled = resolvedEffort !== undefined && resolvedEffort !== 'off'
    const body: Record<string, unknown> = {
      model: input.model,
      stream: input.stream,
      max_tokens: input.maxTokens ?? (
        thinkingEnabled ? DEFAULT_MESSAGES_REASONING_MAX_TOKENS : DEFAULT_MESSAGES_MAX_TOKENS
      ),
      messages: converted.messages
    }
    const systemText = input.request.responseFormat === 'json_object'
      ? [converted.system, 'Return a valid JSON object only.'].filter((item) => item.trim()).join('\n\n')
      : converted.system
    if (systemText) {
      body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    }
    if (input.request.temperature !== undefined) body.temperature = input.request.temperature
    if (input.request.topP !== undefined) body.top_p = input.request.topP
    this.deps.applyAnthropicReasoning(body, input.request.reasoningEffort, input.reasoning)
    if (input.tools.length) {
      body.tools = input.tools.map((tool) => ({
        name: tool.name, description: tool.description, input_schema: tool.inputSchema
      }))
    }
    return body
  }
}

function isAzureOpenAiEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')
  } catch {
    return /\.openai\.azure\.com\b|\.cognitiveservices\.azure\.com\b/i.test(baseUrl)
  }
}

function isThinkingProducerModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized === 'deepseek-v4-pro' || normalized === 'deepseek-v4-flash' ||
    normalized.includes('deepseek-reasoner') || normalized.endsWith('/deepseek-v4-pro') ||
    normalized.endsWith('/deepseek-v4-flash')
}
