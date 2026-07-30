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
import type { TurnItem } from '../../contracts/items.js'
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
  cursorTodosRequestFromMessage,
  mapCursorUsage,
  type CursorSdkStreamLimits
} from './cursor-sdk-event-mapper.js'
import type { CursorBridgeTool } from './cursor-sdk-tool-bridge.js'

const DEFAULT_CURSOR_MODEL = 'auto'
const MAX_CURSOR_ERROR_LENGTH = 2_000
const CURSOR_AUTH_RECOVERY_PROMPT = [
  'Continue the interrupted request from the current persisted agent state.',
  'Do not repeat tool calls that already completed or duplicate their side effects.',
  'Use the existing results and finish the pending response.'
].join('\n')

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
  /** Mirrors successful Cursor-owned updateTodos calls into Kun thread state. */
  setThreadTodos?: (threadId: string, request: SetThreadTodosRequest) => Promise<unknown>
  /** Delegated read-only children must deny mutation regardless of parent defaults. */
  enforceReadOnly?: boolean
  sessionCoordinator?: DelegatedSessionCoordinator
  contextProfile?: (model: string) => {
    contextWindowTokens: number
    softThresholdTokens: number
    hardThresholdTokens: number
  }
  loadKunTurnContext?: (input: {
    threadId: string
    turnId: string
    userText: string
    actingModelRoute: ActingTurnModelRoute
    signal: AbortSignal
  }) => Promise<CursorKunTurnContext>
}

export type CursorKunTurnContext = {
  instructionBlocks: string[]
  activeSkillIds: string[]
  tools: CursorBridgeTool[]
  customTools: Record<string, SDKCustomTool>
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
      // Keep the SDK's own transport and stalled-run recovery enabled even if
      // a future SDK release changes the headless default.
      enableAgentRetries: true,
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
    return cursorSdkCapabilities(Boolean(this.deps.loadKunTurnContext))
  }

  async runTurn(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId?: string
  ): Promise<TurnRunOutcome> {
    const runtimeController = new AbortController()
    const abortRuntime = (): void => runtimeController.abort()
    signal.addEventListener('abort', abortRuntime, { once: true })
    if (signal.aborted) abortRuntime()
    const execute = () => this.runTurnOwned(
      threadId,
      turnId,
      runtimeController.signal,
      providerId,
      abortRuntime
    )
    try {
      return await (this.deps.sessionCoordinator
        ? this.deps.sessionCoordinator.runExclusive(threadId, execute)
        : execute())
    } finally {
      abortRuntime()
      signal.removeEventListener('abort', abortRuntime)
    }
  }

  private async runTurnOwned(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    providerId: string | undefined,
    abortRuntime: () => void
  ): Promise<TurnRunOutcome> {
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

    const requestedProviderId = turn.providerId?.trim()
    const fallbackProviderId =
      requestedProviderId ||
      providerId?.trim() ||
      thread.providerId?.trim() ||
      'cursor-subscription'
    const requestedAccountId = turn.accountId?.trim() || (
      !requestedProviderId || requestedProviderId === thread.providerId?.trim()
        ? thread.accountId?.trim()
        : undefined
    )
    const actingModelRoute: ActingTurnModelRoute = turn.actingModelRoute ?? {
      model: normalizeCursorModel(turn.model || thread.model || this.deps.defaultModel),
      providerId: fallbackProviderId,
      ...(requestedAccountId ? { accountId: requestedAccountId } : {})
    }
    const resolvedProviderId = actingModelRoute.providerId ?? fallbackProviderId
    const resolvedAccountId =
      actingModelRoute.accountId ??
      requestedAccountId
    const provider = this.deps.providerConfigs[resolvedProviderId]
    const apiKey =
      provider?.apiKey?.trim() ||
      (resolvedProviderId === 'cursor-subscription'
        ? this.deps.defaultApiKey?.trim() || ''
        : '')
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
    if (!turn.actingModelRoute) {
      await this.deps.turns.updateTurnMetadata(threadId, turnId, { actingModelRoute })
    }

    const historyTranscript = buildHistoryTranscript(
      items,
      turnId,
      DEFAULT_SDK_HISTORY_TRANSCRIPT_MAX_BYTES
    )
    const userText = userMessageTextWithComposerContexts(userItem)
    let kunContext: CursorKunTurnContext = {
      instructionBlocks: [],
      activeSkillIds: [],
      tools: [],
      customTools: {}
    }
    if (this.deps.loadKunTurnContext) {
      try {
        kunContext = await this.deps.loadKunTurnContext({
          threadId,
          turnId,
          userText,
          actingModelRoute,
          signal
        })
      } catch (error) {
        abortRuntime()
        const message = sanitizeCursorSdkError(error, apiKey)
        await this.deps.events.record({
          kind: 'error',
          threadId,
          turnId,
          message,
          code: 'cursor_sdk_context_failed',
          severity: 'error'
        })
        await this.deps.turns.finishTurn({
          threadId,
          turnId,
          status: 'failed',
          error: message,
          code: 'cursor_sdk_context_failed',
          severity: 'error'
        })
        return 'failed'
      }
    }
    const instructionBlocks = [
      this.deps.systemPrompt?.trim(),
      buildClientSurfaceInstruction(resolveTurnClientSurface(turn)),
      thread.systemPrompt?.trim(),
      ...kunContext.instructionBlocks
    ].filter((value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index
    )
    const model = actingModelRoute.model
    const attachmentIds = userItem.attachmentIds ?? []
    const resolvedImages = await resolveCursorSdkImages({
      attachmentStore: this.deps.attachmentStore,
      attachmentIds,
      threadId,
      workspace: thread.workspace
    })
    const planMode = this.deps.enforceReadOnly === true || (turn.mode ?? thread.mode) === 'plan'
    const approvalPolicy = turn.approvalPolicy ?? thread.approvalPolicy
    const sandboxMode = turn.sandboxMode ?? thread.sandboxMode
    let capabilities = cursorSdkCapabilities(Boolean(this.deps.loadKunTurnContext))
    let options = cursorAgentExecutionOptions({
      workspace: thread.workspace,
      apiKey,
      model,
      name: `Kun · ${thread.title || thread.id}`.slice(0, 120),
      planMode,
      approvalPolicy,
      sandboxMode,
      enforceReadOnly: this.deps.enforceReadOnly
    })
    if (Object.keys(kunContext.customTools).length > 0) {
      options = {
        ...options,
        local: {
          ...options.local,
          customTools: kunContext.customTools
        }
      }
    }
    let preparation: DelegatedSessionPreparation | undefined
    if (this.deps.sessionCoordinator) {
      preparation = await this.deps.sessionCoordinator.prepare({
        threadId,
        route: {
          providerKind: 'cursor-sdk',
          providerId: resolvedProviderId,
          credentialIdentity: delegatedCredentialIdentity({
            providerId: resolvedProviderId,
            accountId: resolvedAccountId,
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
            approvalPolicy,
            sandboxMode,
            settingSources: options.local?.settingSources ?? [],
            capabilities,
            ...(this.deps.loadKunTurnContext
              ? {
                  instructions: kunContext.instructionBlocks,
                  tools: kunContext.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    providerId: tool.providerId,
                    providerKind: tool.providerKind
                  }))
                }
              : {})
          }),
          continuationMode: 'native'
        },
        priorItems: priorItemsForDelegatedTurn(items, turnId)
      })
    }
    const buildPrompt = (includeHistory: boolean): string => composeSdkPromptText({
      ...(includeHistory && historyTranscript ? { historyTranscript } : {}),
      userText,
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
        userText
      ].join('\n'))
      const tools = estimateDelegatedTokens(JSON.stringify(kunContext.tools))
      const skills = estimateDelegatedTokens(kunContext.activeSkillIds.join('\n'))
      const other = resolvedImages.images.length * 1_024
      await this.deps.events.record({
        kind: 'context_snapshot',
        threadId,
        turnId,
        model,
        providerId: resolvedProviderId,
        stepIndex: 0,
        ...contextProfile,
        estimatedInputTokens: system + skills + tools + messages + other,
        breakdown: { tools, system, skills, messages, other },
        toolCount: kunContext.tools.length,
        activeSkillIds: kunContext.activeSkillIds,
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
    const materializedOutputItemIds = new Set<string>()
    let trace: CursorTrace | undefined
    let agent: SDKAgent | undefined
    let run: Run | undefined
    let timedOut = false
    let authenticationRecoveryAttempted = false
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
      let attemptPrompt = prompt
      let attemptMessage = sdkMessage
      let forceRecoveryRun = false
      let recoveryContinuesAcceptedRun = false
      for (;;) {
        trace = await startCursorTrace(this.deps.debugSink, {
          threadId,
          turnId,
          provider: resolvedProviderId,
          model,
          prompt: attemptPrompt,
          instructions: instructionBlocks,
          tools: kunContext.tools,
          images: recoveryContinuesAcceptedRun ? [] : resolvedImages.summaries,
          mode: options.mode ?? 'plan',
          sandboxEnabled: options.local?.sandboxOptions?.enabled !== false,
          delegated: {
            providerKind: 'cursor-sdk',
            phase: preparation?.resumed || recoveryContinuesAcceptedRun ? 'resumed' : 'rebased',
            ...(preparation?.rebaseReason ? { reason: preparation.rebaseReason } : {}),
            contextManagement: 'sdk-managed',
            nativeHistory: preparation?.resumed || recoveryContinuesAcceptedRun
              ? 'unknown'
              : 'none',
            capabilities
          }
        })
        let runAccepted = false
        try {
          run = await Promise.race([
            agent.send(attemptMessage, {
              mode: options.mode,
              ...(forceRecoveryRun ? { local: { force: true } } : {})
            }),
            interrupted
          ])
          runAccepted = true

          if (run.supports('stream')) {
            const iterator = run.stream()[Symbol.asyncIterator]()
            for (;;) {
              const next = await Promise.race([iterator.next(), interrupted])
              if (next.done) break
              await this.consumeMessage(
                threadId,
                turnId,
                mapper,
                next.value,
                trace,
                materializedOutputItemIds
              )
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
          break
        } catch (error) {
          if (
            authenticationRecoveryAttempted
            || error instanceof CursorTurnInterruptedError
            || cursorSdkErrorCode(error) !== 'cursor_sdk_authentication_failed'
          ) {
            throw error
          }
          authenticationRecoveryAttempted = true
          const safeAttemptError = new Error(sanitizeCursorSdkError(error, apiKey))
          safeAttemptError.name = error instanceof Error ? error.name : 'CursorSdkError'
          await finishCursorTrace(trace, { kind: 'error', error: safeAttemptError })
          trace = undefined
          await this.deps.events.record({
            kind: 'pipeline_stage',
            threadId,
            turnId,
            stage: 'pre_send',
            label: 'Cursor SDK authentication expired; rebuilding the SDK session and retrying once',
            details: {
              reason: 'cursor_sdk_authentication_failed',
              attempt: 2,
              maxAttempts: 2,
              requestAccepted: runAccepted
            }
          })
          const recoveryAgentId: string = agent.agentId
          await Promise.race([agent[Symbol.asyncDispose](), interrupted])
          agent = await Promise.race([
            sdk.Agent.resume(recoveryAgentId, options),
            interrupted
          ])
          forceRecoveryRun = true
          recoveryContinuesAcceptedRun = runAccepted
          if (runAccepted) {
            attemptPrompt = CURSOR_AUTH_RECOVERY_PROMPT
            attemptMessage = CURSOR_AUTH_RECOVERY_PROMPT
          } else {
            attemptPrompt = prompt
            attemptMessage = sdkMessage
          }
        }
      }
      const suspension = await this.deps.turns.suspendGraphLeadTurn?.({ threadId, turnId })
      const outcome: TurnRunOutcome = suspension === 'suspended' ? 'suspended' : 'completed'
      if (outcome === 'completed') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'completed' })
      }
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
      return outcome
    } catch (error) {
      const abortedBeforeFailure = signal.aborted
      abortRuntime()
      cancelRun()
      const code = timedOut ? 'turn_wall_time_limit' : cursorSdkErrorCode(error)
      const message = timedOut
        ? `Cursor SDK turn exceeded ${limits.maxWallTimeMs}ms wall time`
        : code === 'cursor_sdk_authentication_failed' && authenticationRecoveryAttempted
          ? cursorAuthenticationFailureMessage()
          : sanitizeCursorSdkError(error, apiKey)
      const safeTraceError = new Error(message)
      safeTraceError.name = error instanceof Error ? error.name : 'CursorSdkError'
      await finishCursorTrace(trace, { kind: 'error', error: safeTraceError })
      trace = undefined
      if (
        abortedBeforeFailure
        || error instanceof CursorTurnInterruptedError && error.reason === 'aborted'
      ) {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      await this.deps.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code,
        severity: 'error'
      })
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: message,
        code,
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
    threadId: string,
    turnId: string,
    mapper: CursorSdkEventMapper,
    message: SDKMessage,
    trace: CursorTrace | undefined,
    materializedOutputItemIds: Set<string>
  ): Promise<void> {
    captureCursorMessage(trace, message)
    const drafts = mapper.map(message)
    const outputItem = message.type === 'assistant'
      ? mapper.runningTextItem
      : message.type === 'thinking'
        ? mapper.runningReasoningItem
        : undefined
    if (outputItem) {
      if (materializedOutputItemIds.has(outputItem.id)) {
        const updated = await this.deps.turns.updateItem(
          outputItem.threadId,
          outputItem.id,
          outputItem
        )
        if (!updated) {
          await this.deps.turns.applyItem(outputItem.threadId, outputItem)
        }
      } else {
        await this.deps.turns.applyItem(outputItem.threadId, outputItem)
        materializedOutputItemIds.add(outputItem.id)
      }
    }
    for (const draft of drafts) {
      captureCursorTraceDraft(trace, draft)
      await this.emitDraft(draft.threadId, draft)
    }
    const todosRequest = cursorTodosRequestFromMessage(message)
    if (todosRequest && this.deps.setThreadTodos) {
      try {
        await this.deps.setThreadTodos(threadId, todosRequest)
      } catch (error) {
        await this.deps.events.record({
          kind: 'error',
          threadId,
          turnId,
          message: `Failed to sync Cursor SDK todos: ${sanitizeCursorSdkError(error, '')}`,
          code: 'cursor_sdk_todo_sync_failed',
          severity: 'warning'
        })
      }
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

function captureCursorTraceDraft(
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

function traceOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function estimateDelegatedTokens(text: string): number {
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

function itemOf(draft: RuntimeEventDraft): TurnItem | undefined {
  return 'item' in draft ? draft.item as TurnItem : undefined
}

function cursorRunError(result: RunResult): Error {
  const error = new Error(result.error?.message || 'Cursor SDK run failed')
  error.name = result.error?.code || 'CursorSdkRunError'
  return error
}

function cursorAuthenticationFailureMessage(): string {
  return [
    'Cursor SDK authentication failed again after Kun automatically rebuilt the SDK session',
    'and retried once with the configured API Key.',
    'This SDK path does not use the Cursor desktop login.',
    'If the key is active in the Cursor dashboard, this is a',
    'Cursor SDK/service authentication failure.'
  ].join(' ')
}

type CursorTrace = {
  sink: LlmDebugSink
  round: LlmDebugRound
  record: ModelRequestTraceRecord
}

async function startCursorTrace(
  sink: LlmDebugSink | undefined,
  input: {
    threadId: string
    turnId: string
    provider: string
    model: string
    prompt: string
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
