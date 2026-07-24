import type { TurnItem } from '../contracts/items.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { ToolProviderKind } from './tool-host.js'
import type { ModelFailureMetadata } from '../contracts/model-route-pool.js'

/**
 * One streaming chunk from a model response. The loop consumes these
 * chunks to drive assistant text and reasoning deltas, tool call
 * accumulation, and usage reporting.
 */
export type ModelRouteTargetMetadata = {
  routePoolId: string
  targetId: string
  providerId: string
  modelId: string
  requestedModelId: string
}

export type ModelStreamChunk = (
  | { kind: 'assistant_text_delta'; text: string }
  | { kind: 'assistant_reasoning_delta'; text: string }
  | { kind: 'tool_call_delta'; callId: string; toolName?: string; argumentsDelta?: string }
  | { kind: 'tool_call_complete'; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { kind: 'retrying'; status: number; attempt: number; maxAttempts: number; delayMs: number }
  | { kind: 'image_generation_complete'; imageBase64: string; mimeType: string }
  | { kind: 'usage'; usage: UsageSnapshot }
  | { kind: 'completed'; stopReason: 'stop' | 'tool_calls' | 'length' | 'error' }
  | { kind: 'error'; message: string; code?: string; failure?: ModelFailureMetadata }
) & { route?: ModelRouteTargetMetadata }

/**
 * A single model turn request: the immutable prefix items, the running
 * conversation history, and any tools that are currently advertised.
 */
export type ModelRequest = {
  threadId: string
  turnId: string
  model: string
  /**
   * Optional provider id override. Routed by `MultiProviderModelClient`
   * to a per-provider client when set; falls back to the runtime's
   * default provider only when omitted or explicitly `default`. Unknown
   * providers fail closed so requests never cross credential boundaries. Lets a workflow / scheduled
   * task / IM bridge pick a non-runtime provider per request while
   * reusing the single Kun process (kun#workflow-multi-provider).
   */
  providerId?: string
  /** Runtime-owned diagnostic run id used to correlate route-test progress. */
  routeTestId?: string
  /** Opaque account selection for custom/extension providers. Never a credential. */
  accountId?: string
  systemPrompt?: string
  /**
   * Optional thread-scoped persona/profile. Emitted as a separate system
   * message after the stable Kun contract so per-thread customization never
   * mutates the immutable prefix field.
   */
  threadProfileInstruction?: string
  /**
   * Optional mode-scoped instruction (e.g. Plan mode guidance). Emitted
   * after the byte-stable `systemPrompt` and optional thread profile so
   * the cached prefix stays unchanged while the mode note still rides at
   * the front of the request.
   */
  modeInstruction?: string
  /**
   * Dynamic per-turn system instructions, such as active Skill
   * guidance. These are intentionally outside the immutable prefix.
   */
  contextInstructions?: string[]
  prefix: TurnItem[]
  history: TurnItem[]
  attachments?: ModelInputAttachment[]
  attachmentTextFallbacks?: ModelTextAttachmentFallback[]
  attachmentDocuments?: ModelDocumentAttachment[]
  tools: ModelToolSpec[]
  /**
   * Optional loop-level requirement. The agent loop uses this to keep
   * GUI-owned workflows, such as plan creation, tied to a concrete tool
   * result even when a provider ignores tool-use instructions.
   */
  requiredToolName?: string
  /** Optional per-request streaming override. Defaults to adapter configuration. */
  stream?: boolean
  /** Optional output cap forwarded to OpenAI-compatible providers. */
  maxTokens?: number
  /** Optional sampling controls for classifier-style calls. */
  temperature?: number
  topP?: number
  /** Optional structured response mode for short JSON classifier paths. */
  responseFormat?: 'json_object'
  /**
   * Optional DeepSeek-style thinking control. `off` disables thinking;
   * `high` and `max` enable it with a concrete reasoning effort.
   */
  reasoningEffort?: string
  abortSignal: AbortSignal
}

export type ModelInputAttachment = {
  id: string
  name: string
  mimeType: string
  dataBase64: string
  width?: number
  height?: number
  localFilePath?: string
}

export type ModelTextAttachmentFallback = {
  id: string
  name: string
  mimeType: string
  dataBase64: string
  byteSize: number
  width?: number
  height?: number
  localFilePath?: string
  wasCompressed?: boolean
}

export type ModelDocumentAttachment = {
  id: string
  name: string
  mimeType: string
  text: string
  byteSize: number
  documentFormat?: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'csv' | 'json' | 'xml'
  sourceSha256?: string
  pageCount?: number
  truncated?: boolean
  localFilePath?: string
}

export type ModelToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  /** Host-authored side-effect classification; never forwarded to model providers. */
  sideEffect?: 'read-only' | 'unknown'
  /** Local execution provenance. Provider serializers must not forward it. */
  providerKind?: ToolProviderKind
  /** Stable local provider id (for example `builtin` or `mcp:filesystem`). */
  providerId?: string
}

/**
 * Port for talking to a model provider. Adapters implement this with
 * a DeepSeek-compatible HTTP client, with `pi-ai`, or with a test
 * double. The loop never depends on a concrete implementation.
 */
export interface ModelClient {
  readonly provider: string
  readonly model: string
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>
}
