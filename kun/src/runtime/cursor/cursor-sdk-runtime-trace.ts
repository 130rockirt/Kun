import type {
  AgentOptions,
  LocalAgentStore,
  Run,
  RunResult,
  SDKAgent,
  SDKCustomTool,
  SDKImage,
  SDKMessage,
  SDKUserMessage,
  TokenUsage
} from '@cursor/sdk'
import type { AttachmentStore } from '../../attachments/attachment-store.js'
import type { ServeProviderConfig } from '../../config/kun-config.js'
import {
  MAX_TURN_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENT_IDS
} from '../../contracts/attachments.js'
import type {
  ModelRequestTraceDelegated,
  ModelRequestTraceRecord
} from '../../contracts/model-request-trace.js'
import { goalContextTexts, type TurnItem } from '../../contracts/items.js'
import type { ActingTurnModelRoute } from '../../contracts/turns.js'
import type { SetThreadTodosRequest } from '../../contracts/threads.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import { userMessageTextWithComposerContexts } from '../../domain/composer-context.js'
import { resolveTurnClientSurface } from '../../loop/turn-context-resolver.js'
import { normalizeTurnLimits, type TurnLimitsConfig } from '../../loop/turn-limits.js'
import type { TurnRunOutcome } from '../../loop/turn-execution-types.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { ThreadStore } from '../../ports/thread-store.js'
import { buildClientSurfaceInstruction } from '../../prompt/kun-prompt-context.js'
import {
  startLlmDebugRoundIfEnabled,
  type LlmDebugRound,
  type LlmDebugSink
} from '../../services/llm-debug-recorder.js'
import type { RuntimeEventDraft, RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { TurnService } from '../../services/turn-service.js'
import {
  buildHistoryTranscript,
  composeSdkPromptText,
  DEFAULT_SDK_HISTORY_TRANSCRIPT_MAX_BYTES
} from '../agent-sdk/sdk-context-assembler.js'
import {
  filterGoalContextsForGoalKey,
  goalContextKey
} from '../../loop/continuation-instructions.js'
import type {
  DelegatedRuntimeCapabilities,
  DelegatedTurnRuntime
} from '../delegated-turn-runtime.js'
import {
  delegatedCapabilityFingerprint,
  delegatedCredentialIdentity,
  priorItemsForDelegatedTurn,
  type DelegatedSessionCoordinator,
  type DelegatedSessionPreparation
} from '../delegated-session-binding.js'
import {
  delegatedGraphCompletionCheck,
  delegatedGraphRecoveryInstruction,
  parkDelegatedGraphTurnAfterRecovery,
  type DelegatedGraphPhase
} from '../delegated-graph-turn-policy.js'
import {
  CursorSdkEventMapper,
  CursorSdkResourceLimitError,
  cursorTodosRequestFromMessage,
  mapCursorUsage,
  type CursorSdkStreamLimits
} from './cursor-sdk-event-mapper.js'
import type { CursorBridgeTool } from './cursor-sdk-tool-bridge.js'
import type { CursorSdkImageSummary } from './cursor-sdk-runtime-support.js'


export function captureCursorTraceDraft(
  trace: CursorTrace | undefined,
  draft: RuntimeEventDraft
): void {
  if (!trace?.sink.captureToolResult) return
  const item = itemOf(draft)
  if (draft.kind !== 'tool_call_finished' || item?.kind !== 'tool_result') return
  try {
    trace.sink.captureToolResult(trace.round, {
      callId: item.callId,
      toolName: item.toolName,
      output: traceOutputText(item.output),
      isError: item.isError
    })
  } catch {
    warnCursorTraceFailure()
  }
}

export function traceOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function estimateDelegatedTokens(text: string): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0
}

export function cursorSdkCapabilities(kunTools = false): DelegatedRuntimeCapabilities {
  return {
    nativeResume: true,
    structuredStreaming: true,
    kunTools,
    externalApproval: kunTools,
    liveSteering: false,
    nativeContextTelemetry: false,
    fork: false
  }
}

export function itemOf(draft: RuntimeEventDraft): TurnItem | undefined {
  return 'item' in draft ? draft.item as TurnItem : undefined
}

export function cursorRunError(result: RunResult): Error {
  const error = new Error(result.error?.message || 'Cursor SDK run failed')
  error.name = result.error?.code || 'CursorSdkRunError'
  return error
}

export function cursorAuthenticationFailureMessage(): string {
  return [
    'Cursor SDK authentication failed again after Kun automatically rebuilt the SDK session',
    'and retried once with the configured API Key.',
    'This SDK path does not use the Cursor desktop login.',
    'If the key is active in the Cursor dashboard, this is a',
    'Cursor SDK/service authentication failure.'
  ].join(' ')
}

export type CursorTrace = {
  sink: LlmDebugSink
  round: LlmDebugRound
  record: ModelRequestTraceRecord
}

export async function startCursorTrace(
  sink: LlmDebugSink | undefined,
  input: {
    threadId: string
    turnId: string
    provider: string
    model: string
    prompt: string
    redactedRequestValues: readonly string[]
    instructions: readonly string[]
    tools: readonly CursorBridgeTool[]
    images: readonly CursorSdkImageSummary[]
    mode: 'agent' | 'plan'
    sandboxEnabled: boolean
    delegated: ModelRequestTraceDelegated
  }
): Promise<CursorTrace | undefined> {
  if (!sink?.beginSdkInvocation) return undefined
  let round: LlmDebugRound | undefined
  try {
    round = await startLlmDebugRoundIfEnabled(sink, {
      threadId: input.threadId,
      turnId: input.turnId,
      provider: input.provider,
      model: input.model,
      redactedRequestValues: input.redactedRequestValues,
      toolCatalog: input.tools.map((tool) => ({
        name: tool.name,
        providerKind: tool.providerKind,
        providerId: tool.providerId
      }))
    })
    if (!round) return undefined
    const record = sink.beginSdkInvocation(round, {
      endpointFormat: 'cursor-sdk',
      target: 'cursor-sdk://local/agent',
      bodyText: JSON.stringify({
        model: input.model,
        instructions: input.instructions,
        input: input.prompt,
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        attachments: {
          count: input.images.length,
          images: input.images
        },
        mode: input.mode,
        sandbox: input.sandboxEnabled
      }),
      delegated: input.delegated
    })
    return { sink, round, record }
  } catch {
    if (round) void sink.finish(round).catch(() => undefined)
    warnCursorTraceFailure()
    return undefined
  }
}

export function captureCursorMessage(
  trace: CursorTrace | undefined,
  message: SDKMessage
): void {
  if (!trace) return
  try {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          trace.sink.captureChunk(trace.round, { kind: 'assistant_text_delta', text: block.text })
        } else if (block.type === 'tool_use') {
          trace.sink.captureChunk(trace.round, {
            kind: 'tool_call_complete',
            callId: block.id,
            toolName: block.name,
            arguments: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
              ? block.input as Record<string, unknown>
              : {}
          })
        }
      }
    } else if (message.type === 'thinking' && message.text) {
      trace.sink.captureChunk(trace.round, { kind: 'assistant_reasoning_delta', text: message.text })
    } else if (message.type === 'tool_call' && message.status === 'running') {
      trace.sink.captureChunk(trace.round, {
        kind: 'tool_call_complete',
        callId: message.call_id,
        toolName: message.name,
        arguments: message.args && typeof message.args === 'object' && !Array.isArray(message.args)
          ? message.args as Record<string, unknown>
          : {}
      })
    } else if (message.type === 'usage') {
      trace.sink.captureChunk(trace.round, {
        kind: 'usage',
        usage: mapCursorUsage(message.usage, trace.round.provider, trace.round.model)
      })
    }
  } catch {
    warnCursorTraceFailure()
  }
}

export function finishCursorTraceChunks(
  trace: CursorTrace | undefined,
  text: string,
  usage: TokenUsage | undefined,
  providerId: string,
  model: string
): void {
  if (!trace) return
  try {
    if (!trace.round.output.text && text) {
      trace.sink.captureChunk(trace.round, { kind: 'assistant_text_delta', text })
    }
    if (usage && !trace.round.output.usage) {
      const snapshot: UsageSnapshot = mapCursorUsage(usage, providerId, model)
      trace.sink.captureChunk(trace.round, { kind: 'usage', usage: snapshot })
    }
    trace.sink.captureChunk(trace.round, { kind: 'completed', stopReason: 'stop' })
  } catch {
    warnCursorTraceFailure()
  }
}

export async function finishCursorTrace(
  trace: CursorTrace | undefined,
  result: { kind: 'completed' } | { kind: 'error'; error: unknown }
): Promise<void> {
  if (!trace) return
  try {
    if (result.kind === 'error') {
      trace.sink.captureChunk(trace.round, {
        kind: 'error',
        message: result.error instanceof Error ? result.error.message : String(result.error)
      })
      trace.sink.captureTransportError(trace.record, result.error)
    }
    await trace.sink.finish(trace.round)
  } catch {
    warnCursorTraceFailure()
  }
}

let cursorTraceFailureWarned = false

export function warnCursorTraceFailure(): void {
  if (cursorTraceFailureWarned) return
  cursorTraceFailureWarned = true
  console.warn('[kun:cursor] model request observability capture failed; the SDK turn continues unchanged')
}
