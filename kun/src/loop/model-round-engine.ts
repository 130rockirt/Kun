import type { CacheRequestSignature } from '../cache/cache-diagnostics.js'
import { utf8PrefixWithinBytes } from '../shared/utf8-text-blocks.js'
import type { PipelineStage } from '../contracts/events.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { UsageService } from '../services/usage-service.js'
import {
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeToolCallItem
} from '../domain/item.js'
import { redactBrowserUseActionForPersistence } from '../contracts/browser-use.js'
import {
  ModelStreamCollector,
  type ModelStreamSnapshot,
  type ModelStreamToolMetadata
} from './model-stream-collector.js'
import type { LoopTelemetry } from './loop-telemetry.js'
import type { TurnExecutionFailure } from './turn-execution-types.js'

export type ModelRoundStreamResult =
  | { kind: 'completed'; snapshot: ModelStreamSnapshot }
  | { kind: 'tool_calls'; snapshot: ModelStreamSnapshot }
  | { kind: 'aborted' }
  | { kind: 'failed' }

export type ModelRoundEngineInput = {
  threadId: string
  turnId: string
  signal: AbortSignal
  request: ModelRequest
  maxToolCallsPerStep: number
  streamToolMetadata: ReadonlyMap<string, ModelStreamToolMetadata>
  maxToolArgumentStringBytes?: number
  cacheSignature: CacheRequestSignature
  preSendDetails: Record<string, unknown>
  postSendDetails: Record<string, unknown>
  writeGeneratedImage: (input: {
    imageBase64: string
    mimeType: string
  }) => Promise<{ markdown: string }>
}

export type ModelRoundEngineDeps = {
  model: Pick<ModelClient, 'stream'>
  events: Pick<RuntimeEventRecorder, 'record'>
  turns: Pick<TurnService, 'applyItem'>
  usage: Pick<UsageService, 'record'>
  telemetry: Pick<LoopTelemetry, 'recordPromptPressure'>
  ids: Pick<IdGenerator, 'next'>
  recordPipelineStage: (
    threadId: string,
    turnId: string,
    stage: Extract<PipelineStage, 'pre_send' | 'post_send' | 'response_received'>,
    details?: Record<string, unknown>
  ) => Promise<void>
  recordGoalUsage: (threadId: string, tokens: number) => Promise<void>
  rememberFailure: (turnId: string, failure: TurnExecutionFailure) => void
  recordToolCallLimit: (threadId: string, turnId: string, message: string) => Promise<void>
}

const ASSISTANT_DELTA_EVENT_MAX_BYTES = 4 * 1024
const ASSISTANT_DELTA_EVENT_MAX_DELAY_MS = 40
const MAX_TRACKED_TOOL_CALL_TURNS = 128
const COMPAT_FALLBACK_CALL_ID_PATTERN = /^call_\d+$/

type AssistantDeltaEvent = {
  kind: 'assistant_text_delta' | 'assistant_reasoning_delta'
  itemId: string
  text: string
}

/**
 * Runs one already-prepared model request and owns only stream-local side
 * effects. The outer AgentLoop retains context resolution, compaction, tool
 * dispatch, and terminal lifecycle ownership.
 */
export class ModelRoundEngine {
  private readonly runtimeCallIdsByTurn = new Map<string, Set<string>>()

  constructor(private readonly deps: ModelRoundEngineDeps) {}

  async run(input: ModelRoundEngineInput): Promise<ModelRoundStreamResult> {
    const allocateRuntimeCallId = this.runtimeCallIdAllocator(input)
    const collector = new ModelStreamCollector({
      maxToolCallsPerStep: input.maxToolCallsPerStep,
      toolMetadata: input.streamToolMetadata,
      allocateRuntimeCallId,
      ...(input.maxToolArgumentStringBytes !== undefined
        ? { maxToolArgumentStringBytes: input.maxToolArgumentStringBytes }
        : {})
    })
    let textItemId = ''
    let reasoningItemId = ''
    let persistedReasoning = false
    let persistedText = false
    const persistAccumulatedResponse = async (): Promise<void> => {
      if (!persistedReasoning && collector.reasoning) {
        persistedReasoning = true
        const itemId = reasoningItemId || this.deps.ids.next('item_reasoning')
        await this.deps.turns.applyItem(
          input.threadId,
          makeAssistantReasoningItem({
            id: itemId,
            turnId: input.turnId,
            threadId: input.threadId,
            text: collector.reasoning,
            status: 'completed'
          })
        )
      }
      if (!persistedText && collector.text) {
        persistedText = true
        const itemId = textItemId || this.deps.ids.next('item_text')
        await this.deps.turns.applyItem(
          input.threadId,
          makeAssistantTextItem({
            id: itemId,
            turnId: input.turnId,
            threadId: input.threadId,
            text: collector.text,
            status: 'completed'
          })
        )
      }
    }
    const deltaEvents = new AssistantDeltaEventCoalescer(async (delta) => {
      if (delta.kind === 'assistant_text_delta') {
        await this.deps.events.record({
          kind: delta.kind,
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: delta.itemId,
          item: makeAssistantTextItem({
            id: delta.itemId,
            turnId: input.turnId,
            threadId: input.threadId,
            text: delta.text,
            status: 'running'
          })
        })
        return
      }
      await this.deps.events.record({
        kind: delta.kind,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: delta.itemId,
        item: makeAssistantReasoningItem({
          id: delta.itemId,
          turnId: input.turnId,
          threadId: input.threadId,
          text: delta.text,
          status: 'running'
        })
      })
    })

    await this.deps.recordPipelineStage(
      input.threadId,
      input.turnId,
      'pre_send',
      input.preSendDetails
    )
    await this.deps.recordPipelineStage(
      input.threadId,
      input.turnId,
      'post_send',
      input.postSendDetails
    )
    try {
      for await (const chunk of this.deps.model.stream(input.request)) {
        if (input.signal.aborted) {
          await deltaEvents.flush()
          await persistAccumulatedResponse()
          return { kind: 'aborted' }
        }
        const reduction = collector.reduce(chunk)
        if (reduction.terminal) {
          await deltaEvents.flush()
          const message = reduction.terminal.message
          this.deps.rememberFailure(input.turnId, {
            error: message,
            code: 'tool_call_limit_exceeded',
            severity: 'warning'
          })
          await this.deps.recordToolCallLimit(input.threadId, input.turnId, message)
          await persistAccumulatedResponse()
          return { kind: 'failed' }
        }
        for (const intent of reduction.intents) {
          if (
            intent.kind !== 'assistant_text_delta' &&
            intent.kind !== 'assistant_reasoning_delta'
          ) {
            await deltaEvents.flush()
          }
          switch (intent.kind) {
            case 'assistant_text_delta':
              textItemId ||= this.deps.ids.next('item_text')
              await deltaEvents.append({
                kind: intent.kind,
                itemId: textItemId,
                text: intent.text
              })
              break
            case 'assistant_reasoning_delta':
              reasoningItemId ||= this.deps.ids.next('item_reasoning')
              await deltaEvents.append({
                kind: intent.kind,
                itemId: reasoningItemId,
                text: intent.text
              })
              break
            case 'retrying':
              await this.deps.events.record({
                kind: 'model_request_retry',
                threadId: input.threadId,
                turnId: input.turnId,
                status: intent.status,
                attempt: intent.attempt,
                maxAttempts: intent.maxAttempts,
                delayMs: intent.delayMs
              })
              break
            case 'tool_call_ready': {
              const itemId = `item_tool_${input.turnId}_${intent.call.callId}`
              await this.deps.turns.applyItem(
                input.threadId,
                makeToolCallItem({
                  id: itemId,
                  turnId: input.turnId,
                  threadId: input.threadId,
                  callId: intent.call.callId,
                  toolName: intent.call.toolName,
                  toolKind: intent.call.toolKind,
                  arguments: intent.call.toolName === 'browser_use'
                    ? redactBrowserUseActionForPersistence(intent.call.arguments) as Record<string, unknown>
                    : intent.call.arguments,
                  ...(intent.providerMetadata
                    ? { providerMetadata: intent.providerMetadata }
                    : {}),
                  ...(intent.repairNotes.length
                    ? { summary: `Repaired tool arguments: ${intent.repairNotes.join('; ')}` }
                    : {})
                })
              )
              await this.deps.events.record({
                kind: 'tool_call_ready',
                threadId: input.threadId,
                turnId: input.turnId,
                itemId,
                callId: intent.call.callId,
                toolName: intent.call.toolName,
                readyCount: collector.toolCallCount
              })
              break
            }
            case 'generated_image': {
              const generated = await input.writeGeneratedImage({
                imageBase64: intent.imageBase64,
                mimeType: intent.mimeType
              })
              const textIntent = collector.appendAssistantText(generated.markdown)
              textItemId ||= this.deps.ids.next('item_text')
              await deltaEvents.append({
                kind: textIntent.kind,
                itemId: textItemId,
                text: textIntent.text
              })
              break
            }
            case 'usage': {
              this.deps.telemetry.recordPromptPressure(
                input.threadId,
                input.request.model,
                intent.usage.promptTokens
              )
              const usage = this.deps.usage.record(input.threadId, intent.usage, input.cacheSignature)
              await this.deps.recordGoalUsage(input.threadId, intent.usage.totalTokens)
              await this.deps.events.record({
                kind: 'usage',
                threadId: input.threadId,
                turnId: input.turnId,
                model: input.request.model,
                usage
              })
              break
            }
            case 'model_error':
              this.deps.rememberFailure(input.turnId, {
                error: intent.message,
                ...(intent.code ? { code: intent.code } : {}),
                severity: 'error'
              })
              await this.deps.events.record({
                kind: 'error',
                threadId: input.threadId,
                turnId: input.turnId,
                message: intent.message,
                code: intent.code,
                severity: 'error'
              })
              break
          }
        }
      }
    } catch (error) {
      let streamFailure = error
      try {
        await deltaEvents.flush()
      } catch (flushError) {
        streamFailure = flushError
      }
      await persistAccumulatedResponse()
      throw streamFailure
    } finally {
      deltaEvents.dispose()
    }

    if (input.signal.aborted) {
      await deltaEvents.flush()
      await persistAccumulatedResponse()
      return { kind: 'aborted' }
    }
    await deltaEvents.flush()
    const snapshot = collector.snapshot()
    await this.deps.recordPipelineStage(input.threadId, input.turnId, 'response_received', {
      stopReason: snapshot.stopReason,
      toolCallCount: snapshot.toolCalls.length
    })
    await persistAccumulatedResponse()
    if (snapshot.stopReason === 'error') return { kind: 'failed' }
    return snapshot.toolCalls.length > 0
      ? { kind: 'tool_calls', snapshot }
      : { kind: 'completed', snapshot }
  }

  clearTurn(turnId: string): void {
    this.runtimeCallIdsByTurn.delete(turnId)
  }

  private runtimeCallIdAllocator(input: ModelRoundEngineInput): (providerCallId: string) => string {
    const used = this.runtimeCallIdsByTurn.get(input.turnId) ?? new Set<string>()
    for (const item of input.request.history) {
      if (item.kind === 'tool_call' || item.kind === 'tool_result') used.add(item.callId)
    }
    this.runtimeCallIdsByTurn.delete(input.turnId)
    this.runtimeCallIdsByTurn.set(input.turnId, used)
    if (this.runtimeCallIdsByTurn.size > MAX_TRACKED_TOOL_CALL_TURNS) {
      const oldest = this.runtimeCallIdsByTurn.keys().next().value
      if (oldest !== undefined) this.runtimeCallIdsByTurn.delete(oldest)
    }

    return (providerCallId) => {
      if (
        providerCallId.trim() &&
        !COMPAT_FALLBACK_CALL_ID_PATTERN.test(providerCallId)
      ) {
        if (!used.has(providerCallId)) {
          used.add(providerCallId)
          return providerCallId
        }
      }

      let runtimeCallId = this.deps.ids.next('call_tool')
      while (used.has(runtimeCallId)) runtimeCallId = this.deps.ids.next('call_tool')
      used.add(runtimeCallId)
      return runtimeCallId
    }
  }
}

type PendingAssistantDeltaEvent = Omit<AssistantDeltaEvent, 'text'> & {
  parts: string[]
  bytes: number
}

/**
 * Coalesces adjacent provider deltas into persistence-sized events. A byte
 * ceiling keeps large bursts moving immediately, while the short timer keeps
 * low-volume output live even when the provider pauses between chunks.
 */
class AssistantDeltaEventCoalescer {
  private pending: PendingAssistantDeltaEvent | undefined
  private timer: NodeJS.Timeout | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private writeError: unknown
  private hasWriteError = false

  constructor(
    private readonly emit: (event: AssistantDeltaEvent) => Promise<void>,
    private readonly maxBytes = ASSISTANT_DELTA_EVENT_MAX_BYTES,
    private readonly maxDelayMs = ASSISTANT_DELTA_EVENT_MAX_DELAY_MS
  ) {}

  async append(event: AssistantDeltaEvent): Promise<void> {
    this.throwWriteError()
    if (!event.text) return
    if (
      this.pending &&
      (this.pending.kind !== event.kind || this.pending.itemId !== event.itemId)
    ) {
      await this.flush()
    }
    let offset = 0
    while (offset < event.text.length) {
      if (!this.pending) {
        this.pending = {
          kind: event.kind,
          itemId: event.itemId,
          parts: [],
          bytes: 0
        }
        this.scheduleFlush()
      }
      const prefix = utf8PrefixWithinBytes(
        event.text,
        offset,
        this.maxBytes - this.pending.bytes
      )
      if (prefix.end === offset) {
        await this.flush()
        continue
      }
      this.pending.parts.push(event.text.slice(offset, prefix.end))
      this.pending.bytes += prefix.bytes
      offset = prefix.end
      if (this.pending.bytes >= this.maxBytes) await this.flush()
    }
  }

  async flush(): Promise<void> {
    this.cancelTimer()
    this.enqueuePending()
    await this.writeTail
    this.throwWriteError()
  }

  dispose(): void {
    this.cancelTimer()
  }

  private scheduleFlush(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.enqueuePending()
    }, this.maxDelayMs)
    this.timer.unref?.()
  }

  private cancelTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private enqueuePending(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    this.writeTail = this.writeTail.then(async () => {
      if (this.hasWriteError) return
      try {
        await this.emit({
          kind: pending.kind,
          itemId: pending.itemId,
          text: pending.parts.join('')
        })
      } catch (error) {
        this.hasWriteError = true
        this.writeError = error
      }
    })
  }

  private throwWriteError(): void {
    if (this.hasWriteError) throw this.writeError
  }
}
