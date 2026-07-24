import type {
  AgentOptions,
  LocalAgentStore,
  Run,
  RunResult,
  SDKAgent,
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
import type { ModelRequestTraceRecord } from '../../contracts/model-request-trace.js'
import type { TurnItem } from '../../contracts/items.js'
import type { UsageSnapshot } from '../../contracts/usage.js'
import { userMessageTextWithComposerContexts } from '../../domain/composer-context.js'
import { normalizeTurnLimits, type TurnLimitsConfig } from '../../loop/turn-limits.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { ThreadStore } from '../../ports/thread-store.js'
import type {
  LlmDebugRound,
  LlmDebugSink
} from '../../services/llm-debug-recorder.js'
import type { RuntimeEventDraft, RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { TurnService } from '../../services/turn-service.js'
import {
  buildHistoryTranscript,
  composeSdkPromptText,
  DEFAULT_SDK_HISTORY_TRANSCRIPT_MAX_BYTES
} from '../agent-sdk/sdk-context-assembler.js'
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
  CursorSdkEventMapper,
  CursorSdkResourceLimitError,
  mapCursorUsage,
  type CursorSdkStreamLimits
} from './cursor-sdk-event-mapper.js'

const DEFAULT_CURSOR_MODEL = 'auto'
const MAX_CURSOR_ERROR_LENGTH = 2_000

export interface CursorSdkApi {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>
    resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>
  }
  JsonlLocalAgentStore?: new (rootDir: string) => LocalAgentStore
}

export interface CursorSdkRuntimeDeps {
  providerConfigs: Record<string, ServeProviderConfig>
  providerIds: ReadonlySet<string>
  defaultIsCursor: boolean
  defaultApiKey?: string
  defaultModel?: string
  systemPrompt?: string
  threadStore: ThreadStore
  sessionStore: SessionStore
  turns: TurnService
  events: RuntimeEventRecorder
  ids: { next(prefix: string): string }
  debugSink?: LlmDebugSink
  attachmentStore?: AttachmentStore
  turnLimits?: TurnLimitsConfig
  streamLimits?: Partial<CursorSdkStreamLimits>
  loadSdk?: () => Promise<CursorSdkApi>
  /** Delegated read-only children must deny mutation regardless of parent defaults. */
  enforceReadOnly?: boolean
  sessionCoordinator?: DelegatedSessionCoordinator
  contextProfile?: (model: string) => {
    contextWindowTokens: number
    softThresholdTokens: number
    hardThresholdTokens: number
  }
}

class CursorTurnInterruptedError extends Error {
  constructor(readonly reason: 'aborted' | 'timeout') {
    super(reason === 'timeout' ? 'Cursor SDK turn exceeded its wall-time limit' : 'Cursor SDK turn was aborted')
    this.name = 'CursorTurnInterruptedError'
  }
}

export function normalizeCursorModel(model: string | undefined): string {
  const normalized = model?.trim()
  return normalized || DEFAULT_CURSOR_MODEL
}

export function cursorAgentExecutionOptions(input: {
  workspace: string
  apiKey: string
  model: string
  name: string
  planMode: boolean
  approvalPolicy: string
  sandboxMode: string
  enforceReadOnly?: boolean
}): AgentOptions {
  const mutationAllowed =
    input.enforceReadOnly !== true
    && input.planMode !== true
    && input.approvalPolicy === 'auto'
    && input.sandboxMode !== 'read-only'
    && input.sandboxMode !== 'external-sandbox'
  return {
    apiKey: input.apiKey,
    model: { id: normalizeCursorModel(input.model) },
    name: input.name,
    mode: mutationAllowed ? 'agent' : 'plan',
    local: {
      cwd: input.workspace,
      // Never inherit ~/.cursor, workspace .cursor rules, team settings, or
      // plugins. Kun's canonical prompt and policy are the sole ambient input.
      settingSources: [],
      autoReview: false,
      sandboxOptions: {
        enabled: input.enforceReadOnly === true || input.sandboxMode !== 'danger-full-access'
      }
    }
  }
}

export function sanitizeCursorSdkError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutSecret = apiKey ? raw.split(apiKey).join('[REDACTED]') : raw
  return withoutSecret.slice(0, MAX_CURSOR_ERROR_LENGTH)
}

export type CursorSdkImageSummary = {
  mimeType: string
  byteSize: number
  width?: number
  height?: number
}

export async function resolveCursorSdkImages(input: {
  attachmentStore?: AttachmentStore
  attachmentIds: readonly string[]
  threadId: string
  workspace: string
}): Promise<{ images: SDKImage[]; summaries: CursorSdkImageSummary[] }> {
  if (!input.attachmentStore || input.attachmentIds.length === 0) {
    return { images: [], summaries: [] }
  }
  const images: SDKImage[] = []
  const summaries: CursorSdkImageSummary[] = []
  let totalBytes = 0
  for (const id of input.attachmentIds.slice(0, MAX_TURN_ATTACHMENT_IDS)) {
    try {
      const attachment = await input.attachmentStore.resolveContent(id, {
        threadId: input.threadId,
        workspace: input.workspace
      })
      if (
        attachment.kind !== 'image'
        || !attachment.mimeType.startsWith('image/')
        || attachment.data.byteLength <= 0
        || totalBytes + attachment.data.byteLength > MAX_TURN_ATTACHMENT_BYTES
      ) {
        continue
      }
      totalBytes += attachment.data.byteLength
      const dimension = positiveDimension(attachment.width, attachment.height)
      images.push({
        data: attachment.data.toString('base64'),
        mimeType: attachment.mimeType,
        ...(dimension ? { dimension } : {})
      })
      summaries.push({
        mimeType: attachment.mimeType,
        byteSize: attachment.data.byteLength,
        ...(dimension ?? {})
      })
    } catch {
      // Missing or unauthorized attachments are excluded from the delegated request.
    }
  }
  return { images, summaries }
}

function positiveDimension(
  width: number | undefined,
  height: number | undefined
): { width: number; height: number } | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && width! > 0 && height! > 0
    ? { width: width!, height: height! }
    : undefined
}

export function cursorSdkErrorCode(error: unknown): string {
  if (error instanceof CursorSdkResourceLimitError) return error.code
  const record = error && typeof error === 'object'
    ? error as { name?: unknown; message?: unknown; code?: unknown }
    : {}
  const signature = `${record.name ?? ''} ${record.code ?? ''} ${record.message ?? ''}`.toLowerCase()
  if (/authentication|unauthenticated|invalid api key/.test(signature)) {
    return 'cursor_sdk_authentication_failed'
  }
  if (/rate.?limit|resource.?exhausted|quota|usage.?limit/.test(signature)) {
    return 'cursor_sdk_rate_limited'
  }
  if (/network|unavailable|connect|timeout/.test(signature)) {
    return 'cursor_sdk_network_failed'
  }
  if (/configuration|invalid.?argument/.test(signature)) {
    return 'cursor_sdk_configuration_failed'
  }
  if (/err_module_not_found|cannot find package|cannot find module/.test(signature)) {
    return 'cursor_sdk_unavailable'
  }
  return 'cursor_sdk_failed'
}

export class CursorSdkRuntime implements DelegatedTurnRuntime {
  constructor(private readonly deps: CursorSdkRuntimeDeps) {}

  handlesProvider(providerId: string | undefined): boolean {
    if (providerId && this.deps.providerIds.has(providerId)) return true
    if (!this.deps.defaultIsCursor) return false
    return !providerId || !this.deps.providerConfigs[providerId]
  }

  capabilities(providerId: string | undefined): DelegatedRuntimeCapabilities | undefined {
    if (!this.handlesProvider(providerId)) return undefined
    return cursorSdkCapabilities()
  }

  async runTurn(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId?: string
  ): Promise<'completed' | 'failed' | 'aborted'> {
    const execute = () => this.runTurnOwned(threadId, turnId, signal, providerId)
    return this.deps.sessionCoordinator
      ? this.deps.sessionCoordinator.runExclusive(threadId, execute)
      : execute()
  }

  private async runTurnOwned(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId?: string
  ): Promise<'completed' | 'failed' | 'aborted'> {
    const thread = await this.deps.threadStore.get(threadId)
    const turn = thread?.turns.find((candidate) => candidate.id === turnId)
    if (!thread || !turn) {
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: 'no input for Cursor subscription turn',
        code: 'cursor_sdk_missing_turn'
      })
      return 'failed'
    }
    const items = await this.deps.sessionStore.loadItems(threadId)
    const userItem = [...items]
      .reverse()
      .find((item) => item.turnId === turnId && item.kind === 'user_message')
    if (!userItem || userItem.kind !== 'user_message') {
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: 'no input for Cursor subscription turn',
        code: 'cursor_sdk_missing_turn'
      })
      return 'failed'
    }

    const resolvedProviderId = providerId?.trim() || 'cursor-subscription'
    const provider = providerId ? this.deps.providerConfigs[providerId] : undefined
    const apiKey = providerId
      ? provider?.apiKey?.trim() || ''
      : this.deps.defaultApiKey?.trim() || ''
    if (!apiKey) {
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: 'Cursor subscription API key is not configured',
        code: 'cursor_sdk_missing_credential',
        severity: 'error'
      })
      return 'failed'
    }
    if (signal.aborted) {
      await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
      return 'aborted'
    }

    const historyTranscript = buildHistoryTranscript(
      items,
      turnId,
      DEFAULT_SDK_HISTORY_TRANSCRIPT_MAX_BYTES
    )
    const instructionBlocks = [
      this.deps.systemPrompt?.trim(),
      thread.systemPrompt?.trim()
    ].filter((value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index
    )
    const model = normalizeCursorModel(turn.model || thread.model || this.deps.defaultModel)
    const attachmentIds = userItem.attachmentIds ?? []
    const resolvedImages = await resolveCursorSdkImages({
      attachmentStore: this.deps.attachmentStore,
      attachmentIds,
      threadId,
      workspace: thread.workspace
    })
    const planMode = this.deps.enforceReadOnly === true || (turn.mode ?? thread.mode) === 'plan'
    let capabilities = cursorSdkCapabilities()
    let options = cursorAgentExecutionOptions({
      workspace: thread.workspace,
      apiKey,
      model,
      name: `Kun · ${thread.title || thread.id}`.slice(0, 120),
      planMode,
      approvalPolicy: thread.approvalPolicy,
      sandboxMode: thread.sandboxMode,
      enforceReadOnly: this.deps.enforceReadOnly
    })
    let preparation: DelegatedSessionPreparation | undefined
    if (this.deps.sessionCoordinator) {
      preparation = await this.deps.sessionCoordinator.prepare({
        threadId,
        route: {
          providerKind: 'cursor-sdk',
          providerId: resolvedProviderId,
          credentialIdentity: delegatedCredentialIdentity({
            providerId: resolvedProviderId,
            accountId: turn.accountId || thread.accountId,
            credentialSourceId: provider?.credentialSourceId,
            credentialSecret: apiKey
          }),
          workspace: thread.workspace,
          model,
          capabilityFingerprint: delegatedCapabilityFingerprint({
            systemPrompt: this.deps.systemPrompt?.trim() || '',
            threadPersona: thread.systemPrompt?.trim() || '',
            mode: options.mode,
            sandbox: options.local?.sandboxOptions?.enabled !== false,
            settingSources: options.local?.settingSources ?? [],
            capabilities
          }),
          continuationMode: 'native'
        },
        priorItems: priorItemsForDelegatedTurn(items, turnId)
      })
    }
    const buildPrompt = (includeHistory: boolean): string => composeSdkPromptText({
      ...(includeHistory && historyTranscript ? { historyTranscript } : {}),
      userText: userMessageTextWithComposerContexts(userItem),
      instructionBlocks
    })
    let prompt = buildPrompt(!preparation?.resumed)
    let sdkMessage: string | SDKUserMessage = resolvedImages.images.length > 0
      ? { text: prompt, images: resolvedImages.images }
      : prompt
    await this.deps.events.record({
      kind: 'delegated_runtime',
      threadId,
      turnId,
      providerKind: 'cursor-sdk',
      providerId: resolvedProviderId,
      phase: preparation?.resumed ? 'resumed' : 'rebased',
      ...(preparation?.rebaseReason ? { reason: preparation.rebaseReason } : {}),
      capabilities
    })
    const contextProfile = this.deps.contextProfile?.(model)
    const recordContextSnapshot = async (resumed: boolean): Promise<void> => {
      if (!contextProfile) return
      const system = estimateDelegatedTokens(instructionBlocks.join('\n'))
      const messages = estimateDelegatedTokens([
        resumed ? '' : historyTranscript,
        userMessageTextWithComposerContexts(userItem)
      ].join('\n'))
      const other = resolvedImages.images.length * 1_024
      await this.deps.events.record({
        kind: 'context_snapshot',
        threadId,
        turnId,
        model,
        providerId: resolvedProviderId,
        stepIndex: 0,
        ...contextProfile,
        estimatedInputTokens: system + messages + other,
        breakdown: { tools: 0, system, skills: 0, messages, other },
        toolCount: 0,
        activeSkillIds: [],
        contextManagement: 'sdk-managed',
        nativeHistory: resumed ? 'unknown' : 'none'
      })
    }
    await recordContextSnapshot(preparation?.resumed === true)
    const limits = normalizeTurnLimits(this.deps.turnLimits)
    const mapper = new CursorSdkEventMapper({
      threadId,
      turnId,
      providerId: resolvedProviderId,
      model,
      nextId: (prefix) => this.deps.ids.next(prefix),
      limits: this.deps.streamLimits
    })
    let trace: CursorTrace | undefined
    let agent: SDKAgent | undefined
    let run: Run | undefined
    let timedOut = false
    let rejectInterruption: ((error: CursorTurnInterruptedError) => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject
    })
    void interrupted.catch(() => undefined)
    const cancelRun = (): void => {
      if (run) void run.cancel().catch(() => undefined)
    }
    const onAbort = (): void => {
      cancelRun()
      rejectInterruption?.(new CursorTurnInterruptedError('aborted'))
    }
    const timeout = setTimeout(() => {
      timedOut = true
      cancelRun()
      rejectInterruption?.(new CursorTurnInterruptedError('timeout'))
    }, limits.maxWallTimeMs)
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const sdk = this.deps.loadSdk
        ? await Promise.race([this.deps.loadSdk(), interrupted])
        : await Promise.race([
            import('@cursor/sdk').then((module) => module as CursorSdkApi),
            interrupted
          ])
      const attachIsolatedStore = (): void => {
        if (!this.deps.sessionCoordinator || !sdk.JsonlLocalAgentStore) return
        const store = new sdk.JsonlLocalAgentStore(
          this.deps.sessionCoordinator.store.providerStateDir('cursor-sdk', threadId)
        )
        options = {
          ...options,
          local: { ...options.local, store }
        }
      }
      if (this.deps.sessionCoordinator && !sdk.JsonlLocalAgentStore) {
        if (preparation?.resumed) {
          preparation = await this.deps.sessionCoordinator.rejectResume(preparation)
        }
        capabilities = { ...capabilities, nativeResume: false }
        await this.deps.events.record({
          kind: 'delegated_runtime',
          threadId,
          turnId,
          providerKind: 'cursor-sdk',
          providerId: resolvedProviderId,
          phase: 'portable',
          reason: 'capabilities_changed',
          capabilities
        })
        throw new Error(
          'Cursor SDK configuration does not expose the isolated local agent store required for durable sessions'
        )
      }
      attachIsolatedStore()
      if (preparation?.resumed && preparation.nativeSessionId) {
        try {
          agent = await Promise.race([
            sdk.Agent.resume(preparation.nativeSessionId, options),
            interrupted
          ])
        } catch (error) {
          if (error instanceof CursorTurnInterruptedError) throw error
          preparation = this.deps.sessionCoordinator
            ? await this.deps.sessionCoordinator.rejectResume(preparation)
            : {
                ...preparation,
                generation: preparation.generation + 1,
                nativeSessionId: undefined,
                resumed: false,
                rebaseReason: 'native_state_unavailable'
              }
          attachIsolatedStore()
          prompt = buildPrompt(true)
          sdkMessage = resolvedImages.images.length > 0
            ? { text: prompt, images: resolvedImages.images }
            : prompt
          await this.deps.events.record({
            kind: 'delegated_runtime',
            threadId,
            turnId,
            providerKind: 'cursor-sdk',
            providerId: resolvedProviderId,
            phase: 'rebased',
            reason: 'native_state_unavailable',
            capabilities
          })
          await recordContextSnapshot(false)
          agent = await Promise.race([sdk.Agent.create(options), interrupted])
        }
      } else {
        agent = await Promise.race([sdk.Agent.create(options), interrupted])
      }
      trace = startCursorTrace(this.deps.debugSink, {
        threadId,
        turnId,
        provider: resolvedProviderId,
        model,
        prompt,
        images: resolvedImages.summaries,
        mode: options.mode ?? 'plan',
        sandboxEnabled: options.local?.sandboxOptions?.enabled !== false
      })
      run = await Promise.race([
        agent.send(sdkMessage, { mode: options.mode }),
        interrupted
      ])

      if (run.supports('stream')) {
        const iterator = run.stream()[Symbol.asyncIterator]()
        for (;;) {
          const next = await Promise.race([iterator.next(), interrupted])
          if (next.done) break
          await this.consumeMessage(mapper, next.value, trace)
        }
      }
      const result = await Promise.race([run.wait(), interrupted])
      if (result.status === 'cancelled' || signal.aborted) {
        await finishCursorTrace(trace, {
          kind: 'error',
          error: new CursorTurnInterruptedError('aborted')
        })
        trace = undefined
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      if (result.status === 'error') {
        throw cursorRunError(result)
      }
      for (const draft of mapper.finalize(result.result, result.usage)) {
        await this.emitDraft(threadId, draft)
      }
      finishCursorTraceChunks(trace, mapper.text, result.usage, resolvedProviderId, model)
      await finishCursorTrace(trace, { kind: 'completed' })
      trace = undefined
      await this.deps.turns.finishTurn({ threadId, turnId, status: 'completed' })
      if (preparation && this.deps.sessionCoordinator) {
        try {
          await this.deps.sessionCoordinator.commit({
            preparation,
            committedItems: await this.deps.sessionStore.loadItems(threadId),
            lastCommittedTurnId: turnId,
            nativeSessionId: agent.agentId
          })
        } catch {
          // The canonical Kun turn is already durable. A checkpoint write
          // failure simply forces a portable rebase on the next turn.
        }
      }
      return 'completed'
    } catch (error) {
      const safeTraceError = new Error(sanitizeCursorSdkError(error, apiKey))
      safeTraceError.name = error instanceof Error ? error.name : 'CursorSdkError'
      await finishCursorTrace(trace, { kind: 'error', error: safeTraceError })
      trace = undefined
      if (
        signal.aborted
        || error instanceof CursorTurnInterruptedError && error.reason === 'aborted'
      ) {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      const message = timedOut
        ? `Cursor SDK turn exceeded ${limits.maxWallTimeMs}ms wall time`
        : sanitizeCursorSdkError(error, apiKey)
      await this.deps.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: timedOut ? 'turn_wall_time_limit' : cursorSdkErrorCode(error),
        severity: 'error'
      })
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: message,
        code: timedOut ? 'turn_wall_time_limit' : cursorSdkErrorCode(error),
        severity: 'error'
      })
      return 'failed'
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      try {
        agent?.close()
      } catch {
        // best effort: the turn is already terminal
      }
    }
  }

  private async consumeMessage(
    mapper: CursorSdkEventMapper,
    message: SDKMessage,
    trace: CursorTrace | undefined
  ): Promise<void> {
    captureCursorMessage(trace, message)
    for (const draft of mapper.map(message)) {
      await this.emitDraft(draft.threadId, draft)
    }
  }

  private async emitDraft(threadId: string, draft: RuntimeEventDraft): Promise<void> {
    const item = itemOf(draft)
    if (item && (
      draft.kind === 'item_created'
      || draft.kind === 'tool_call_started'
      || draft.kind === 'tool_call_finished'
    )) {
      await this.deps.turns.applyItem(threadId, item)
      if (draft.kind !== 'item_created') await this.deps.events.record(draft)
      return
    }
    await this.deps.events.record(draft)
  }
}

function estimateDelegatedTokens(text: string): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0
}

export function cursorSdkCapabilities(): DelegatedRuntimeCapabilities {
  return {
    nativeResume: true,
    structuredStreaming: true,
    kunTools: false,
    externalApproval: false,
    liveSteering: false,
    nativeContextTelemetry: false,
    fork: false
  }
}

function itemOf(draft: RuntimeEventDraft): TurnItem | undefined {
  return 'item' in draft ? draft.item as TurnItem : undefined
}

function cursorRunError(result: RunResult): Error {
  const error = new Error(result.error?.message || 'Cursor SDK run failed')
  error.name = result.error?.code || 'CursorSdkRunError'
  return error
}

type CursorTrace = {
  sink: LlmDebugSink
  round: LlmDebugRound
  record: ModelRequestTraceRecord
}

function startCursorTrace(
  sink: LlmDebugSink | undefined,
  input: {
    threadId: string
    turnId: string
    provider: string
    model: string
    prompt: string
    images: readonly CursorSdkImageSummary[]
    mode: 'agent' | 'plan'
    sandboxEnabled: boolean
  }
): CursorTrace | undefined {
  if (!sink?.beginSdkInvocation) return undefined
  let round: LlmDebugRound | undefined
  try {
    round = sink.start({
      threadId: input.threadId,
      turnId: input.turnId,
      provider: input.provider,
      model: input.model
    })
    const record = sink.beginSdkInvocation(round, {
      endpointFormat: 'cursor-sdk',
      target: 'cursor-sdk://local/agent',
      bodyText: JSON.stringify({
        model: input.model,
        input: input.prompt,
        attachments: {
          count: input.images.length,
          images: input.images
        },
        mode: input.mode,
        sandbox: input.sandboxEnabled
      })
    })
    return { sink, round, record }
  } catch {
    if (round) void sink.finish(round).catch(() => undefined)
    warnCursorTraceFailure()
    return undefined
  }
}

function captureCursorMessage(
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

function finishCursorTraceChunks(
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

async function finishCursorTrace(
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

function warnCursorTraceFailure(): void {
  if (cursorTraceFailureWarned) return
  cursorTraceFailureWarned = true
  console.warn('[kun:cursor] model request observability capture failed; the SDK turn continues unchanged')
}
