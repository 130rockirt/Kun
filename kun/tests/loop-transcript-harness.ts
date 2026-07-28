import type { RuntimeEvent } from '../src/contracts/events.js'
import type { TurnItem } from '../src/contracts/items.js'
import type { ThreadRecord } from '../src/contracts/threads.js'
import type { Turn, TurnStatus } from '../src/contracts/turns.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { replayRuntimeEvents } from '../src/domain/runtime-event-reducer.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import type {
  ToolCallLike,
  ToolHostContext,
  ToolHostResult
} from '../src/ports/tool-host.js'
import type { Harness } from './loop-test-harness.js'
import type { TurnRunOutcome } from '../src/loop/turn-execution-types.js'

/**
 * JSON-safe projection used by the loop transcript tests. It intentionally
 * preserves semantic order while dropping clock values and AbortSignal
 * internals, which would otherwise make the characterization fixtures flaky.
 */
export type TranscriptValue =
  | null
  | boolean
  | number
  | string
  | TranscriptValue[]
  | { [key: string]: unknown }

export type NormalizedRecord = { [key: string]: unknown }

export type NormalizedModelRequest = {
  threadId: string
  turnId: string
  model: string
  providerId?: string
  systemPrompt?: string
  modeInstruction?: string
  contextInstructions: string[]
  prefix: NormalizedTurnItem[]
  history: NormalizedTurnItem[]
  tools: Array<{
    name: string
    description: string
    toolKind?: 'tool_call' | 'command_execution' | 'file_change'
    inputSchema: TranscriptValue
  }>
  requiredToolName?: string
  stream?: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  responseFormat?: 'json_object'
  reasoningEffort?: string
  attachments?: TranscriptValue
  attachmentTextFallbacks?: TranscriptValue
  attachmentDocuments?: TranscriptValue
}

export type NormalizedRuntimeEvent = NormalizedRecord & {
  kind: RuntimeEvent['kind']
  seq: number
}

export type NormalizedTurnItem = NormalizedRecord & {
  id: string
  threadId: string
  turnId: string
  kind: TurnItem['kind']
  role: TurnItem['role']
  status: TurnItem['status']
}

export type NormalizedTurn = NormalizedRecord & {
  id: string
  threadId: string
  status: TurnStatus
  items: NormalizedTurnItem[]
}

export type NormalizedThread = NormalizedRecord & {
  id: string
  status: ThreadRecord['status']
  turns: NormalizedTurn[]
}

export type ToolExecutionTrace = {
  callId: string
  toolName: string
  providerId?: string
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  arguments: TranscriptValue
}

type RawToolExecutionTrace = Omit<ToolExecutionTrace, 'arguments'> & {
  arguments: unknown
}

type TranscriptNormalizationState = {
  inputIds: Map<string, string>
  nextInputId: number
}

export type LoopTranscript = {
  status: TurnRunOutcome
  modelRequests: NormalizedModelRequest[]
  events: NormalizedRuntimeEvent[]
  eventProjection: TranscriptValue
  sessionItems: NormalizedTurnItem[]
  thread: NormalizedThread | null
  turn: NormalizedTurn | null
  usage: TranscriptValue
  toolExecutionOrder: ToolExecutionTrace[]
}

export type ModelScript =
  | readonly ModelStreamChunk[]
  | ((input: {
    request: ModelRequest
    callIndex: number
  }) => AsyncIterable<ModelStreamChunk>)

/**
 * A fully offline model double that records the request boundary before
 * replaying a deterministic sequence of model chunks.
 */
export class ScriptedCapturingModel implements ModelClient {
  readonly provider: string
  readonly model: string
  readonly requests: ModelRequest[] = []
  private callIndex = 0

  constructor(
    private readonly scripts: readonly ModelScript[],
    options: { provider?: string; model?: string } = {}
  ) {
    this.provider = options.provider ?? 'transcript'
    this.model = options.model ?? 'transcript-model'
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    const callIndex = this.callIndex
    this.callIndex += 1
    const script = this.scripts[callIndex] ?? []
    const chunks = typeof script === 'function'
      ? script({ request, callIndex })
      : asAsyncIterable(script)
    for await (const chunk of chunks) yield chunk
  }
}

/**
 * Records the externally observable execution order while retaining the real
 * tool host, approval, sandbox, and result behavior underneath.
 */
export class CapturingToolHost extends LocalToolHost {
  readonly executions: RawToolExecutionTrace[] = []

  override async execute(
    call: ToolCallLike,
    context: ToolHostContext,
    onUpdate?: (item: TurnItem) => Promise<void> | void
  ): Promise<ToolHostResult> {
    this.executions.push({
      callId: call.callId,
      toolName: call.toolName,
      ...(call.providerId ? { providerId: call.providerId } : {}),
      ...(call.toolKind ? { toolKind: call.toolKind } : {}),
      arguments: call.arguments
    })
    return super.execute(call, context, onUpdate)
  }
}

/** Run one initialized harness turn and capture its durable/public boundary. */
export async function runTranscript(input: {
  harness: Harness
  model: ScriptedCapturingModel
  toolHost?: CapturingToolHost
}): Promise<LoopTranscript> {
  const status = await input.harness.loop.runTurn(input.harness.threadId, input.harness.turnId)
  return captureTranscript({ ...input, status })
}

/** Capture a transcript after a turn is settled outside `runTranscript` (e.g. interrupt tests). */
export async function captureTranscript(input: {
  harness: Harness
  model: ScriptedCapturingModel
  status: TurnRunOutcome
  toolHost?: CapturingToolHost
}): Promise<LoopTranscript> {
  const [events, sessionItems, thread] = await Promise.all([
    input.harness.sessionStore.loadEventsSince(input.harness.threadId, 0),
    input.harness.sessionStore.loadItems(input.harness.threadId),
    input.harness.threadStore.get(input.harness.threadId)
  ])
  const normalizer = createTranscriptNormalizationState()
  const turn = thread?.turns.find((candidate) => candidate.id === input.harness.turnId) ?? null
  return {
    status: input.status,
    modelRequests: input.model.requests.map((request) => normalizeModelRequest(request, normalizer)),
    events: events.map((event) => normalizeRuntimeEvent(event, normalizer)),
    eventProjection: normalizeTranscriptValue(replayRuntimeEvents(events), normalizer),
    sessionItems: sessionItems.map((item) => normalizeTurnItem(item, normalizer)),
    thread: thread ? normalizeThread(thread, normalizer) : null,
    turn: turn ? normalizeTurn(turn, normalizer) : null,
    usage: normalizeTranscriptValue(input.harness.usage.forThread(input.harness.threadId), normalizer),
    toolExecutionOrder: (input.toolHost?.executions ?? []).map((execution) =>
      normalizeToolExecution(execution, normalizer)
    )
  }
}

export function normalizeModelRequest(
  request: ModelRequest,
  normalizer = createTranscriptNormalizationState()
): NormalizedModelRequest {
  return {
    threadId: normalizeText(request.threadId, normalizer, true),
    turnId: normalizeText(request.turnId, normalizer, true),
    model: request.model,
    ...(request.providerId ? { providerId: normalizeText(request.providerId, normalizer) } : {}),
    ...(request.systemPrompt ? { systemPrompt: normalizeText(request.systemPrompt, normalizer) } : {}),
    ...(request.modeInstruction ? { modeInstruction: normalizeText(request.modeInstruction, normalizer) } : {}),
    contextInstructions: (request.contextInstructions ?? []).map((text) => normalizeText(text, normalizer)),
    prefix: request.prefix.map((item) => normalizeTurnItem(item, normalizer)),
    history: request.history.map((item) => normalizeTurnItem(item, normalizer)),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: normalizeText(tool.description, normalizer),
      ...(tool.toolKind ? { toolKind: tool.toolKind } : {}),
      inputSchema: normalizeTranscriptValue(tool.inputSchema, normalizer)
    })),
    ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.attachments ? { attachments: normalizeTranscriptValue(request.attachments, normalizer) } : {}),
    ...(request.attachmentTextFallbacks
      ? { attachmentTextFallbacks: normalizeTranscriptValue(request.attachmentTextFallbacks, normalizer) }
      : {}),
    ...(request.attachmentDocuments
      ? { attachmentDocuments: normalizeTranscriptValue(request.attachmentDocuments, normalizer) }
      : {})
  }
}

export function normalizeRuntimeEvent(
  event: RuntimeEvent,
  normalizer = createTranscriptNormalizationState()
): NormalizedRuntimeEvent {
  return {
    ...(normalizeTranscriptValue(event, normalizer) as NormalizedRecord),
    kind: event.kind,
    seq: event.seq
  }
}

export function normalizeTurnItem(
  item: TurnItem,
  normalizer = createTranscriptNormalizationState()
): NormalizedTurnItem {
  return {
    ...(normalizeTranscriptValue(item, normalizer) as NormalizedRecord),
    id: normalizeText(item.id, normalizer, true),
    threadId: normalizeText(item.threadId, normalizer, true),
    turnId: normalizeText(item.turnId, normalizer, true),
    kind: item.kind,
    role: item.role,
    status: item.status
  }
}

export function normalizeTurn(
  turn: Turn,
  normalizer = createTranscriptNormalizationState()
): NormalizedTurn {
  return {
    ...(normalizeTranscriptValue(turn, normalizer) as NormalizedRecord),
    id: normalizeText(turn.id, normalizer, true),
    threadId: normalizeText(turn.threadId, normalizer, true),
    status: turn.status,
    items: turn.items.map((item) => normalizeTurnItem(item, normalizer))
  }
}

export function normalizeThread(
  thread: ThreadRecord,
  normalizer = createTranscriptNormalizationState()
): NormalizedThread {
  return {
    ...(normalizeTranscriptValue(thread, normalizer) as NormalizedRecord),
    id: normalizeText(thread.id, normalizer, true),
    status: thread.status,
    turns: thread.turns.map((turn) => normalizeTurn(turn, normalizer))
  }
}

function normalizeToolExecution(
  execution: RawToolExecutionTrace,
  normalizer: TranscriptNormalizationState
): ToolExecutionTrace {
  return {
    ...execution,
    callId: normalizeText(execution.callId, normalizer, true),
    toolName: normalizeText(execution.toolName, normalizer),
    ...(execution.providerId ? { providerId: normalizeText(execution.providerId, normalizer) } : {}),
    arguments: normalizeTranscriptValue(execution.arguments, normalizer)
  }
}

/**
 * Sort object keys and remove wall-clock fields so assertions describe the
 * compatibility contract, not the incidental implementation timestamps.
 */
export function normalizeTranscriptValue(
  value: unknown,
  normalizer = createTranscriptNormalizationState(),
  field?: string
): TranscriptValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return normalizeText(value, normalizer, isIdentifierField(field))
  if (Array.isArray(value)) return value.map((entry) => normalizeTranscriptValue(entry, normalizer, field))
  if (typeof value === 'object') {
    const normalized: { [key: string]: TranscriptValue } = {}
    for (const [key, nested] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      if (isVolatileTranscriptField(key) || nested === undefined) continue
      normalized[key] = normalizeTranscriptValue(nested, normalizer, key)
    }
    return normalized
  }
  return String(value)
}

function asAsyncIterable(chunks: readonly ModelStreamChunk[]): AsyncIterable<ModelStreamChunk> {
  return (async function *scriptedChunks(): AsyncIterable<ModelStreamChunk> {
    for (const chunk of chunks) yield chunk
  })()
}

function isVolatileTranscriptField(field: string): boolean {
  return field === 'abortSignal' ||
    field === 'timestamp' ||
    field === 'createdAt' ||
    field === 'updatedAt' ||
    field === 'startedAt' ||
    field === 'finishedAt'
}

function createTranscriptNormalizationState(): TranscriptNormalizationState {
  return {
    inputIds: new Map(),
    nextInputId: 0
  }
}

function normalizeText(
  value: string,
  normalizer: TranscriptNormalizationState,
  normalizeIdentifier = false
): string {
  const normalized = value
    // ISO values occur in runtime-context prompt injection and event payloads.
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g, '<timestamp>')
    // Localized runtime-context prompt injection has a user-local clock.
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/g, '<local-time>')
  return normalizeIdentifier ? normalizeGeneratedInputIdentifier(normalized, normalizer) : normalized
}

function isIdentifierField(field: string | undefined): boolean {
  return field === 'id' ||
    field === 'threadId' ||
    field === 'turnId' ||
    field === 'itemId' ||
    field === 'inputId' ||
    field === 'callId' ||
    field === 'approvalId' ||
    field === 'sourceItemIds' ||
    field === 'itemIds' ||
    field === 'pendingUserInputIds'
}

function normalizeGeneratedInputIdentifier(
  value: string,
  normalizer: TranscriptNormalizationState
): string {
  const match = /^(item_)?(in_[a-z0-9]{8})(?![a-z0-9])((?:_[a-z0-9]+)*)$/i.exec(value)
  if (!match) return value
  const [, itemPrefix, inputId, suffix] = match
  const normalizedInput = normalizer.inputIds.get(inputId)
    ?? `<input_${++normalizer.nextInputId}>`
  normalizer.inputIds.set(inputId, normalizedInput)
  if (!itemPrefix) return `${normalizedInput}${suffix}`
  return `<item_${normalizedInput.slice(1, -1)}>${suffix}`
}
