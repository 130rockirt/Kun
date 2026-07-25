import type { SDKMessage, TokenUsage } from '@cursor/sdk'
import { DEFAULT_MODEL_STREAM_LIMITS } from '../../adapters/model/model-stream-resource-budget.js'
import type { TurnItem } from '../../contracts/items.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import {
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeToolCallItem,
  makeToolResultItem
} from '../../domain/item.js'
import type { RuntimeEventDraft } from '../../services/runtime-event-recorder.js'
import { utf8PrefixWithinBytes } from '../../shared/utf8-text-blocks.js'

export type CursorSdkStreamLimits = {
  maxEvents: number
  maxEventBytes: number
  maxTotalEventBytes: number
  maxOutputBytes: number
  maxToolCalls: number
}

export const DEFAULT_CURSOR_SDK_STREAM_LIMITS: CursorSdkStreamLimits = {
  maxEvents: DEFAULT_MODEL_STREAM_LIMITS.maxFrames,
  maxEventBytes: DEFAULT_MODEL_STREAM_LIMITS.maxFrameBytes,
  maxTotalEventBytes: DEFAULT_MODEL_STREAM_LIMITS.maxTotalBytes,
  maxOutputBytes: DEFAULT_MODEL_STREAM_LIMITS.maxOutputBytes,
  maxToolCalls: DEFAULT_MODEL_STREAM_LIMITS.maxCompletedToolCalls
}

export class CursorSdkResourceLimitError extends Error {
  readonly code = 'cursor_sdk_stream_resource_limit'

  constructor(message: string) {
    super(message)
    this.name = 'CursorSdkResourceLimitError'
  }
}

export interface CursorSdkEventMapperContext {
  threadId: string
  turnId: string
  providerId: string
  model: string
  nextId: (prefix: string) => string
  limits?: Partial<CursorSdkStreamLimits>
}

type ToolState = {
  itemId: string
  name: string
  kind: 'tool_call' | 'command_execution' | 'file_change'
  args: Record<string, unknown>
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.trunc(value as number)
    : fallback
}

function normalizeLimits(input: Partial<CursorSdkStreamLimits> | undefined): CursorSdkStreamLimits {
  return {
    maxEvents: positiveInteger(input?.maxEvents, DEFAULT_CURSOR_SDK_STREAM_LIMITS.maxEvents),
    maxEventBytes: positiveInteger(input?.maxEventBytes, DEFAULT_CURSOR_SDK_STREAM_LIMITS.maxEventBytes),
    maxTotalEventBytes: positiveInteger(
      input?.maxTotalEventBytes,
      DEFAULT_CURSOR_SDK_STREAM_LIMITS.maxTotalEventBytes
    ),
    maxOutputBytes: positiveInteger(input?.maxOutputBytes, DEFAULT_CURSOR_SDK_STREAM_LIMITS.maxOutputBytes),
    maxToolCalls: positiveInteger(input?.maxToolCalls, DEFAULT_CURSOR_SDK_STREAM_LIMITS.maxToolCalls)
  }
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    throw new CursorSdkResourceLimitError('Cursor SDK emitted a non-serializable event')
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toolKindFor(name: string): ToolState['kind'] {
  if (/^(shell|bash)$/i.test(name)) return 'command_execution'
  if (/^(write|edit|delete)$/i.test(name)) return 'file_change'
  return 'tool_call'
}

function boundedOutput(value: unknown, maxBytes: number): unknown {
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return { truncated: true, preview: '[non-serializable Cursor tool output]' }
  }
  if (Buffer.byteLength(serialized) <= maxBytes) return value
  const prefix = utf8PrefixWithinBytes(serialized, 0, maxBytes)
  return {
    truncated: true,
    preview: serialized.slice(0, prefix.end)
  }
}

export function mapCursorUsage(
  usage: TokenUsage,
  providerId: string,
  model: string
): UsageSnapshot {
  const promptTokens = Math.max(0, Math.trunc(usage.inputTokens))
  const completionTokens = Math.max(0, Math.trunc(usage.outputTokens))
  const cacheHitTokens = Math.max(0, Math.trunc(usage.cacheReadTokens))
  const cacheWriteTokens = Math.max(0, Math.trunc(usage.cacheWriteTokens))
  return {
    promptTokens,
    completionTokens,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: Math.max(0, Math.trunc(usage.reasoningTokens)) }),
    totalTokens: Math.max(
      promptTokens + completionTokens,
      Math.max(0, Math.trunc(usage.totalTokens))
    ),
    cachedTokens: cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
    cacheWriteTokens,
    cacheHitRate: promptTokens > 0 ? Math.min(1, cacheHitTokens / promptTokens) : null,
    actualProviderId: providerId,
    actualModelId: model,
    turns: 1
  }
}

/**
 * Pure, bounded projection of Cursor's public SDK stream onto Kun events.
 * Cursor executes its own built-in tools; the mapper only mirrors lifecycle
 * events and never redispatches them through Kun's tool host.
 */
export class CursorSdkEventMapper {
  private readonly limits: CursorSdkStreamLimits
  private eventCount = 0
  private totalEventBytes = 0
  private outputBytes = 0
  private toolCallCount = 0
  private textItemId?: string
  private reasoningItemId?: string
  private readonly textParts: string[] = []
  private readonly reasoningParts: string[] = []
  private readonly tools = new Map<string, ToolState>()
  private sawUsage = false

  constructor(private readonly ctx: CursorSdkEventMapperContext) {
    this.limits = normalizeLimits(ctx.limits)
  }

  get hasUsage(): boolean {
    return this.sawUsage
  }

  get text(): string {
    return this.textParts.join('')
  }

  get runningTextItem(): TurnItem | undefined {
    if (!this.textItemId || this.textParts.length === 0) return undefined
    return makeAssistantTextItem({
      id: this.textItemId,
      threadId: this.ctx.threadId,
      turnId: this.ctx.turnId,
      text: this.text,
      status: 'running'
    })
  }

  get runningReasoningItem(): TurnItem | undefined {
    if (!this.reasoningItemId || this.reasoningParts.length === 0) return undefined
    return makeAssistantReasoningItem({
      id: this.reasoningItemId,
      threadId: this.ctx.threadId,
      turnId: this.ctx.turnId,
      text: this.reasoningParts.join(''),
      status: 'running'
    })
  }

  map(message: SDKMessage): RuntimeEventDraft[] {
    this.consumeEvent(message)
    switch (message.type) {
      case 'assistant':
        return this.mapAssistant(message)
      case 'thinking':
        return this.mapThinking(message.text)
      case 'tool_call':
        return this.mapToolCall(message)
      case 'usage':
        this.sawUsage = true
        return [this.usageEvent(message.usage)]
      default:
        return []
    }
  }

  finalize(resultText?: string, usage?: TokenUsage): RuntimeEventDraft[] {
    if (resultText && resultText !== this.text) {
      this.appendOutput(
        this.textParts,
        resultText.startsWith(this.text) ? resultText.slice(this.text.length) : (!this.text ? resultText : '')
      )
    }
    const events: RuntimeEventDraft[] = []
    if (this.reasoningParts.length > 0) {
      this.reasoningItemId ||= this.ctx.nextId('item_cursor_reasoning')
      events.push({
        kind: 'item_created',
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        itemId: this.reasoningItemId,
        item: makeAssistantReasoningItem({
          id: this.reasoningItemId,
          threadId: this.ctx.threadId,
          turnId: this.ctx.turnId,
          text: this.reasoningParts.join(''),
          status: 'completed'
        })
      })
    }
    if (this.textParts.length > 0) {
      this.textItemId ||= this.ctx.nextId('item_cursor_text')
      events.push({
        kind: 'item_created',
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        itemId: this.textItemId,
        item: makeAssistantTextItem({
          id: this.textItemId,
          threadId: this.ctx.threadId,
          turnId: this.ctx.turnId,
          text: this.text,
          status: 'completed'
        })
      })
    }
    if (usage && !this.sawUsage) {
      this.sawUsage = true
      events.push(this.usageEvent(usage))
    }
    return events
  }

  private consumeEvent(message: SDKMessage): void {
    this.eventCount += 1
    if (this.eventCount > this.limits.maxEvents) {
      throw new CursorSdkResourceLimitError('Cursor SDK stream exceeded the event count limit')
    }
    const bytes = byteLength(message)
    if (bytes > this.limits.maxEventBytes) {
      throw new CursorSdkResourceLimitError('Cursor SDK emitted an oversized event')
    }
    this.totalEventBytes += bytes
    if (this.totalEventBytes > this.limits.maxTotalEventBytes) {
      throw new CursorSdkResourceLimitError('Cursor SDK stream exceeded the total byte limit')
    }
  }

  private appendOutput(parts: string[], text: string): void {
    if (!text) return
    this.outputBytes += Buffer.byteLength(text)
    if (this.outputBytes > this.limits.maxOutputBytes) {
      throw new CursorSdkResourceLimitError('Cursor SDK response exceeded the output byte limit')
    }
    parts.push(text)
  }

  private mapAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): RuntimeEventDraft[] {
    const events: RuntimeEventDraft[] = []
    for (const block of message.message.content) {
      if (block.type !== 'text' || !block.text) continue
      this.appendOutput(this.textParts, block.text)
      this.textItemId ||= this.ctx.nextId('item_cursor_text')
      events.push({
        kind: 'assistant_text_delta',
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        itemId: this.textItemId,
        item: makeAssistantTextItem({
          id: this.textItemId,
          threadId: this.ctx.threadId,
          turnId: this.ctx.turnId,
          text: block.text,
          status: 'running'
        })
      })
    }
    return events
  }

  private mapThinking(text: string): RuntimeEventDraft[] {
    if (!text) return []
    this.appendOutput(this.reasoningParts, text)
    this.reasoningItemId ||= this.ctx.nextId('item_cursor_reasoning')
    return [{
      kind: 'assistant_reasoning_delta',
      threadId: this.ctx.threadId,
      turnId: this.ctx.turnId,
      itemId: this.reasoningItemId,
      item: makeAssistantReasoningItem({
        id: this.reasoningItemId,
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        text,
        status: 'running'
      })
    }]
  }

  private mapToolCall(
    message: Extract<SDKMessage, { type: 'tool_call' }>
  ): RuntimeEventDraft[] {
    const existing = this.tools.get(message.call_id)
    if (message.status === 'running') {
      if (existing) return []
      this.toolCallCount += 1
      if (this.toolCallCount > this.limits.maxToolCalls) {
        throw new CursorSdkResourceLimitError('Cursor SDK stream exceeded the tool-call limit')
      }
      const state: ToolState = {
        itemId: `item_cursor_tool_${this.ctx.turnId}_${message.call_id}`,
        name: message.name,
        kind: toolKindFor(message.name),
        args: recordOf(message.args)
      }
      this.tools.set(message.call_id, state)
      return [{
        kind: 'tool_call_started',
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        itemId: state.itemId,
        item: makeToolCallItem({
          id: state.itemId,
          threadId: this.ctx.threadId,
          turnId: this.ctx.turnId,
          callId: message.call_id,
          toolName: state.name,
          toolKind: state.kind,
          arguments: state.args,
          status: 'running'
        })
      }]
    }

    const state = existing ?? {
      itemId: `item_cursor_tool_${this.ctx.turnId}_${message.call_id}`,
      name: message.name,
      kind: toolKindFor(message.name),
      args: recordOf(message.args)
    }
    this.tools.delete(message.call_id)
    const events: RuntimeEventDraft[] = []
    if (!existing) {
      this.toolCallCount += 1
      if (this.toolCallCount > this.limits.maxToolCalls) {
        throw new CursorSdkResourceLimitError('Cursor SDK stream exceeded the tool-call limit')
      }
      events.push({
        kind: 'tool_call_started',
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        itemId: state.itemId,
        item: makeToolCallItem({
          id: state.itemId,
          threadId: this.ctx.threadId,
          turnId: this.ctx.turnId,
          callId: message.call_id,
          toolName: state.name,
          toolKind: state.kind,
          arguments: state.args,
          status: 'running'
        })
      })
    }
    const resultId = `item_cursor_result_${this.ctx.turnId}_${message.call_id}`
    events.push({
      kind: 'tool_call_finished',
      threadId: this.ctx.threadId,
      turnId: this.ctx.turnId,
      itemId: resultId,
      item: makeToolResultItem({
        id: resultId,
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        callId: message.call_id,
        toolName: state.name,
        toolKind: state.kind,
        output: boundedOutput(message.result, this.limits.maxEventBytes),
        isError: message.status === 'error',
        status: message.status === 'error' ? 'failed' : 'completed'
      })
    })
    return events
  }

  private usageEvent(usage: TokenUsage): RuntimeEventDraft {
    return {
      kind: 'usage',
      threadId: this.ctx.threadId,
      turnId: this.ctx.turnId,
      usage: mapCursorUsage(usage, this.ctx.providerId, this.ctx.model)
    }
  }
}
