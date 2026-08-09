import type {
  ModelRequestTraceBody,
  ModelRequestTraceRecord
} from '../contracts/model-request-trace.js'
import { projectToolArgumentsForPersistence } from '../domain/tool-argument-envelope.js'
import type { ModelStreamChunk } from '../ports/model-client.js'
import type { LlmDebugRound } from './llm-debug-recorder-contracts.js'
import { LlmDebugRecorder as SplitLlmDebugRecorder } from './llm-debug-recorder-recorder.js'
import { addCaptureWarning } from './llm-debug-recorder-support.js'

export {
  type LlmDebugRound,
  type LlmDebugToolCall,
  type LlmDebugToolResult,
  type LlmDebugOutputTruncation,
  type LlmDebugOutput,
  type LlmDebugRoundMeta,
  type LlmHttpAttemptReason,
  type LlmHttpAttemptMeta,
  type LlmCliInvocationMeta,
  type LlmSdkInvocationMeta,
  type LlmPhaseDiagnosticMeta,
  type LlmDebugSink,
  type LlmDebugRecorderLimits,
  DEFAULT_LLM_DEBUG_RECORDER_LIMITS,
  type LlmDebugRecorderOptions
} from './llm-debug-recorder-contracts.js'
export {
  startLlmDebugRoundIfEnabled,
  redactBrowserUseDebugContent
} from './llm-debug-recorder-support.js'

const RAW_TOOL_ARGUMENT_RESPONSE_OMISSION =
  '[response body omitted: raw tool argument envelope]'

/**
 * Preserve the raw-envelope persistence fence on top of the split recorder.
 * Runtime execution still receives the original arguments; only retained
 * diagnostics receive the canonical, non-reversible projection.
 */
export class LlmDebugRecorder extends SplitLlmDebugRecorder {
  private readonly rawArgumentRounds = new WeakSet<LlmDebugRound>()
  private readonly projectedResponses = new WeakSet<object>()

  override captureHttpResponse(
    round: LlmDebugRound,
    record: ModelRequestTraceRecord,
    response: Response
  ): void {
    super.captureHttpResponse(round, record, response)
    this.projectResponseBody(round, record)
  }

  override captureChunk(round: LlmDebugRound, chunk: ModelStreamChunk): void {
    if (chunk.kind !== 'tool_call_complete') {
      super.captureChunk(round, chunk)
      return
    }
    if (typeof chunk.arguments.__raw === 'string') {
      this.rawArgumentRounds.add(round)
      for (const record of round.exchanges) {
        addCaptureWarning(
          record,
          'response body omitted because a raw tool argument envelope was observed'
        )
      }
    }
    super.captureChunk(round, {
      ...chunk,
      arguments: projectToolArgumentsForPersistence(chunk.arguments).arguments
    })
  }

  private projectResponseBody(round: LlmDebugRound, record: ModelRequestTraceRecord): void {
    const response = record.response
    if (!response || this.projectedResponses.has(response)) return
    this.projectedResponses.add(response)
    let body = response.body
    Object.defineProperty(response, 'body', {
      configurable: true,
      enumerable: true,
      get: () => this.rawArgumentRounds.has(round) && body
        ? omittedRawToolArgumentResponseBody(body)
        : body,
      set: (next: ModelRequestTraceBody | undefined) => { body = next }
    })
    if (this.rawArgumentRounds.has(round)) {
      addCaptureWarning(
        record,
        'response body omitted because a raw tool argument envelope was observed'
      )
    }
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
