import { randomUUID } from 'node:crypto'
import {
  ModelProviderDeclarationSchema,
  ModelProviderRequestSchema,
  ModelProviderStreamEventSchema,
  ProviderBindingSchema,
  ProviderModelSchema,
  ProviderProbeResultSchema,
  type ModelContentPart,
  type ModelMessage,
  type ModelProviderAdapter,
  type ModelProviderDeclaration,
  type ModelProviderRequest,
  type ModelProviderStreamEvent,
  type ProviderModel,
  type ProviderProbeResult
} from '@kun/extension-api'
import type { ExtensionPrincipal } from '../../services/extension-agent-service.js'
import type { ExtensionProviderAccountStore } from '../../services/extension-provider-account-store.js'
import { extensionProviderId } from '../../services/extension-provider-account-store.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import { compileExtensionJsonSchema } from '../../extensions/json-schema-validator.js'
import { projectCompatMessages } from './compat-message-projector.js'
import type { CompatChatMessage } from './compat-request-codecs.js'
import {
  DEFAULT_MODEL_STREAM_LIMITS,
  TOOL_ARGUMENT_PART_COMPACTION_WINDOW
} from './model-stream-resource-budget.js'

type ProviderRegistration = {
  providerId: string
  principal: ExtensionPrincipal
  declaration: ModelProviderDeclaration
  adapter: ModelProviderAdapter
  activeRequests: Map<string, AbortController>
  reportDiagnostic(input: Omit<ExtensionModelProviderDiagnostic, 'extensionId' | 'providerId' | 'timestamp'>): void
  disposed: boolean
}

type PendingProviderToolCall = {
  callId: string
  nameBlocks: string[]
  nameParts: string[]
  argumentBlocks: string[]
  argumentParts: string[]
  argumentBytes: number
  complete?: Extract<ModelProviderStreamEvent, { type: 'toolCallComplete' }>
}

export type ExtensionModelProviderDiagnostic = {
  extensionId: string
  providerId: string
  modelId?: string
  accountId?: string
  requestId?: string
  operation: 'probe' | 'listModels' | 'stream'
  code:
    | 'probe_failed'
    | 'provider_error'
    | 'model_discovery_failed'
    | 'invalid_model'
    | 'duplicate_model'
    | 'model_limit_exceeded'
    | 'stream_protocol_error'
  category:
    | 'authentication'
    | 'authorization'
    | 'rate_limit'
    | 'invalid_request'
    | 'unavailable'
    | 'adapter_failure'
    | 'protocol'
  retryable: boolean
  message: string
  timestamp: string
}

export type ExtensionModelProviderRegistration = {
  providerId: string
  dispose(): Promise<void>
}

export type ExtensionModelProviderRegistryOptions = {
  accounts: ExtensionProviderAccountStore
  maxEventBytes?: number
  maxEventsPerRequest?: number
  maxTotalBytesPerRequest?: number
  maxOutputBytesPerRequest?: number
  maxPendingToolCallsPerRequest?: number
  maxCompletedToolCallsPerRequest?: number
  maxToolArgumentBytes?: number
  maxTotalPendingToolArgumentBytesPerRequest?: number
  maxCompletedToolArgumentBytesPerRequest?: number
  nowIso?: () => string
  maxDiagnostics?: number
}

/** Dynamic custom-provider registry whose clients plug into MultiProviderModelClient. */
export class ExtensionModelProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>()
  private readonly maxEventBytes: number
  private readonly maxEventsPerRequest: number
  private readonly maxTotalBytesPerRequest: number
  private readonly maxOutputBytesPerRequest: number
  private readonly maxPendingToolCallsPerRequest: number
  private readonly maxCompletedToolCallsPerRequest: number
  private readonly maxToolArgumentBytes: number
  private readonly maxTotalPendingToolArgumentBytesPerRequest: number
  private readonly maxCompletedToolArgumentBytesPerRequest: number
  private readonly nowIso: () => string
  private readonly maxDiagnostics: number
  private readonly diagnosticBuffer: ExtensionModelProviderDiagnostic[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: ExtensionModelProviderRegistryOptions) {
    this.maxEventBytes = Math.max(1_024, options.maxEventBytes ?? 1024 * 1024)
    this.maxEventsPerRequest = Math.max(1, options.maxEventsPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxFrames)
    this.maxTotalBytesPerRequest = Math.max(
      1_024,
      options.maxTotalBytesPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxTotalBytes
    )
    this.maxOutputBytesPerRequest = Math.max(
      1_024,
      options.maxOutputBytesPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxOutputBytes
    )
    this.maxPendingToolCallsPerRequest = Math.max(
      1,
      Math.floor(options.maxPendingToolCallsPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxPendingToolCalls)
    )
    this.maxCompletedToolCallsPerRequest = Math.max(
      1,
      Math.floor(options.maxCompletedToolCallsPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxCompletedToolCalls)
    )
    this.maxToolArgumentBytes = Math.max(
      1_024,
      options.maxToolArgumentBytes ?? DEFAULT_MODEL_STREAM_LIMITS.maxPendingToolArgumentBytes
    )
    this.maxTotalPendingToolArgumentBytesPerRequest = Math.max(
      1_024,
      options.maxTotalPendingToolArgumentBytesPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxTotalPendingToolArgumentBytes
    )
    this.maxCompletedToolArgumentBytesPerRequest = Math.max(
      1_024,
      options.maxCompletedToolArgumentBytesPerRequest ?? DEFAULT_MODEL_STREAM_LIMITS.maxCompletedToolArgumentBytes
    )
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.maxDiagnostics = Math.max(1, Math.floor(options.maxDiagnostics ?? 256))
  }

  async register(
    principal: ExtensionPrincipal,
    declarationInput: unknown,
    adapter: ModelProviderAdapter
  ): Promise<ExtensionModelProviderRegistration> {
    if (!principal.permissions.includes('providers.register')) throw new Error('Missing permission: providers.register')
    const declaration = ModelProviderDeclarationSchema.parse(declarationInput)
    const providerId = extensionProviderId(principal.extensionId, declaration.id)
    const provider = await this.options.accounts.getProvider(providerId)
    if (!provider || provider.ownerExtensionId !== principal.extensionId) {
      throw new Error(`authentication provider definition must be registered first: ${providerId}`)
    }
    if (this.registrations.has(providerId)) throw new Error(`extension model provider already registered: ${providerId}`)
    const registration: ProviderRegistration = {
      providerId,
      principal,
      declaration,
      adapter,
      activeRequests: new Map(),
      reportDiagnostic: (diagnostic) => this.recordDiagnostic(
        principal.extensionId,
        providerId,
        diagnostic
      ),
      disposed: false
    }
    this.registrations.set(providerId, registration)
    this.emitChanged()
    let disposed = false
    return {
      providerId,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await this.disposeRegistration(registration)
      }
    }
  }

  clientMap(): Map<string, ModelClient> {
    return new Map([...this.registrations.values()]
      .filter((registration) => !registration.disposed)
      .map((registration) => [
        registration.providerId,
        new ExtensionRemoteModelClient(registration, this.options.accounts, {
          maxEventBytes: this.maxEventBytes,
          maxEventsPerRequest: this.maxEventsPerRequest,
          maxTotalBytesPerRequest: this.maxTotalBytesPerRequest,
          maxOutputBytesPerRequest: this.maxOutputBytesPerRequest,
          maxPendingToolCallsPerRequest: this.maxPendingToolCallsPerRequest,
          maxCompletedToolCallsPerRequest: this.maxCompletedToolCallsPerRequest,
          maxToolArgumentBytes: this.maxToolArgumentBytes,
          maxTotalPendingToolArgumentBytesPerRequest: this.maxTotalPendingToolArgumentBytesPerRequest,
          maxCompletedToolArgumentBytesPerRequest: this.maxCompletedToolArgumentBytesPerRequest
        })
      ]))
  }

  isAvailable(providerId: string): boolean {
    const registration = this.registrations.get(providerId)
    return Boolean(registration && !registration.disposed)
  }

  async probe(providerId: string, accountId: string, modelId?: string, signal?: AbortSignal) {
    const registration = this.requireRegistration(providerId)
    const selectedModel = modelId
      ? await resolveProviderModel(registration, modelId, signal, accountId)
      : (await mergedProviderModels(registration, signal, accountId))[0]
    if (!selectedModel) throw new Error(`extension provider has no available models: ${providerId}`)
    await this.options.accounts.validateBinding({
      providerId,
      accountId,
      modelId: selectedModel.id
    })
    let result: ProviderProbeResult
    try {
      result = ProviderProbeResultSchema.parse(await registration.adapter.probe(
        ProviderBindingSchema.parse({ providerId, accountId, modelId: selectedModel.id }),
        { cancellation: cancellationToken(signal ?? new AbortController().signal) }
      ))
    } catch (error) {
      if (signal?.aborted) throw error
      registration.reportDiagnostic({
        operation: 'probe',
        code: 'probe_failed',
        category: 'adapter_failure',
        retryable: false,
        ...(accountId ? { accountId } : {}),
        ...(selectedModel ? { modelId: selectedModel.id } : {}),
        message: 'Extension provider probe failed.'
      })
      throw new Error('Extension provider probe failed.')
    }
    if (!result.ok) {
      registration.reportDiagnostic({
        operation: 'probe',
        code: 'provider_error',
        category: 'unavailable',
        retryable: false,
        accountId,
        modelId: selectedModel.id,
        message: 'Extension provider probe reported an unavailable service.'
      })
    }
    return {
      ok: result.ok,
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.message || result.details
        ? { message: result.ok ? 'Extension provider probe completed.' : 'Extension provider probe failed.' }
        : {})
    }
  }

  async listModels(providerId: string, accountId: string, signal?: AbortSignal) {
    const registration = this.requireRegistration(providerId)
    await this.options.accounts.validateBinding({ providerId, accountId, modelId: 'model-list' })
    return mergedProviderModels(registration, signal, accountId)
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  diagnostics(extensionId?: string): ExtensionModelProviderDiagnostic[] {
    return this.diagnosticBuffer
      .filter((diagnostic) => !extensionId || diagnostic.extensionId === extensionId)
      .map((diagnostic) => structuredClone(diagnostic))
  }

  async disposeExtension(extensionId: string): Promise<void> {
    await Promise.allSettled([...this.registrations.values()]
      .filter((registration) => registration.principal.extensionId === extensionId)
      .map((registration) => this.disposeRegistration(registration)))
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.registrations.values()].map((registration) => this.disposeRegistration(registration)))
  }

  private requireRegistration(providerId: string): ProviderRegistration {
    const registration = this.registrations.get(providerId)
    if (!registration || registration.disposed) throw new Error(`extension model provider is unavailable: ${providerId}`)
    return registration
  }

  private async disposeRegistration(registration: ProviderRegistration): Promise<void> {
    if (registration.disposed) return
    registration.disposed = true
    this.registrations.delete(registration.providerId)
    for (const [requestId, controller] of registration.activeRequests) {
      controller.abort(new Error('extension model provider disposed'))
      // Adapter cleanup is best-effort. A broken third-party cancel hook must
      // not retain active request references or block extension/runtime shutdown.
      void Promise.resolve()
        .then(() => registration.adapter.cancel(requestId))
        .catch(() => undefined)
    }
    registration.activeRequests.clear()
    this.emitChanged()
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* isolate runtime listeners */ }
    }
  }

  private recordDiagnostic(
    extensionId: string,
    providerId: string,
    diagnostic: Omit<ExtensionModelProviderDiagnostic, 'extensionId' | 'providerId' | 'timestamp'>
  ): void {
    this.diagnosticBuffer.push({
      extensionId,
      providerId,
      ...diagnostic,
      timestamp: this.nowIso()
    })
    if (this.diagnosticBuffer.length > this.maxDiagnostics) {
      this.diagnosticBuffer.splice(0, this.diagnosticBuffer.length - this.maxDiagnostics)
    }
  }
}

class ExtensionRemoteModelClient implements ModelClient {
  readonly provider: string
  readonly model: string

  constructor(
    private readonly registration: ProviderRegistration,
    private readonly accounts: ExtensionProviderAccountStore,
    private readonly limits: {
      maxEventBytes: number
      maxEventsPerRequest: number
      maxTotalBytesPerRequest: number
      maxOutputBytesPerRequest: number
      maxPendingToolCallsPerRequest: number
      maxCompletedToolCallsPerRequest: number
      maxToolArgumentBytes: number
      maxTotalPendingToolArgumentBytesPerRequest: number
      maxCompletedToolArgumentBytesPerRequest: number
    }
  ) {
    this.provider = registration.providerId
    this.model = registration.declaration.models[0]?.id ?? 'extension-model'
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    if (this.registration.disposed) throw new Error(`extension model provider is unavailable: ${this.provider}`)
    if (!request.accountId) throw new Error(`account is required for extension provider: ${this.provider}`)
    await this.accounts.validateBinding({
      providerId: this.provider,
      accountId: request.accountId,
      modelId: request.model
    })
    const model = await resolveProviderModel(
      this.registration,
      request.model,
      request.abortSignal,
      request.accountId
    )
    assertModelRequestCapabilities(request, model)
    const requestId = `modelreq_${randomUUID()}`
    const controller = new AbortController()
    const detachAbort = forwardAbort(request.abortSignal, controller)
    this.registration.activeRequests.set(requestId, controller)
    const normalized = normalizeModelRequest(
      request,
      requestId,
      this.provider,
      request.accountId,
      model.capabilities.input.includes('image')
    )
    let expectedSequence = 0
    let eventCount = 0
    let totalBytes = 0
    let outputBytes = 0
    let terminal = false
    let lastUsage: Extract<ModelProviderStreamEvent, { type: 'usage' }>['usage'] | undefined
    let terminalChunks: ModelStreamChunk[] | undefined
    const pendingToolCalls = new Map<string, PendingProviderToolCall>()
    let totalPendingToolArgumentBytes = 0
    let completedToolCalls = 0
    let completedToolArgumentBytes = 0
    const pendingToolCall = (callId: string): PendingProviderToolCall => {
      const existing = pendingToolCalls.get(callId)
      if (existing) return existing
      if (pendingToolCalls.size >= this.limits.maxPendingToolCallsPerRequest) {
        throw new Error(
          `extension provider pending tool-call limit exceeded ` +
          `(${pendingToolCalls.size + 1}/${this.limits.maxPendingToolCallsPerRequest})`
        )
      }
      const created: PendingProviderToolCall = {
        callId,
        nameBlocks: [],
        nameParts: [],
        argumentBlocks: [],
        argumentParts: [],
        argumentBytes: 0
      }
      pendingToolCalls.set(callId, created)
      return created
    }
    let cancelPromise: Promise<void> | undefined
    const cancel = (reason: unknown): Promise<void> => {
      controller.abort(reason)
      cancelPromise ??= Promise.resolve()
        .then(() => this.registration.adapter.cancel(requestId))
        .catch(() => undefined)
      return cancelPromise
    }
    const onRequestAbort = () => { void cancel(request.abortSignal.reason) }
    if (request.abortSignal.aborted) onRequestAbort()
    else request.abortSignal.addEventListener('abort', onRequestAbort, { once: true })
    try {
      const source = this.registration.adapter.stream(normalized, {
        cancellation: cancellationToken(controller.signal)
      })
      for await (const rawEvent of source) {
        if (controller.signal.aborted) throw abortError()
        eventCount += 1
        if (eventCount > this.limits.maxEventsPerRequest) {
          throw new Error('extension provider stream event limit exceeded')
        }
        const eventBytes = serializedBytes(rawEvent)
        if (eventBytes > this.limits.maxEventBytes) {
          throw new Error('extension provider stream event is too large')
        }
        totalBytes += eventBytes
        if (totalBytes > this.limits.maxTotalBytesPerRequest) {
          throw new Error(
            `extension provider stream byte limit exceeded ` +
            `(${totalBytes}/${this.limits.maxTotalBytesPerRequest} bytes)`
          )
        }
        const event = ModelProviderStreamEventSchema.parse(rawEvent)
        if (event.requestId !== requestId) throw new Error('extension provider stream requestId mismatch')
        if (event.sequence !== expectedSequence) {
          throw new Error(`extension provider stream sequence mismatch: expected ${expectedSequence}, received ${event.sequence}`)
        }
        expectedSequence += 1
        if (terminal) throw new Error('extension provider emitted data after a terminal event')
        if (event.type === 'usage' && hasReportedUsage(event.usage)) lastUsage = event.usage
        if (event.type === 'completed' && event.usage && hasReportedUsage(event.usage)) {
          lastUsage = event.usage
        }
        if (event.type === 'completed' && !lastUsage) {
          throw new Error('extension provider completed without terminal usage')
        }
        if (event.type === 'toolCallDelta') {
          const pending = pendingToolCall(event.callId)
          if (pending.complete) throw new Error('extension provider emitted tool-call data after completion')
          if (event.nameDelta) appendProviderToolName(pending, event.nameDelta)
          if (event.argumentsDelta) {
            const bytes = Buffer.byteLength(event.argumentsDelta, 'utf8')
            const nextArgumentBytes = pending.argumentBytes + bytes
            if (nextArgumentBytes > this.limits.maxToolArgumentBytes) {
              throw new Error(
                `extension provider tool argument byte limit exceeded ` +
                `(${nextArgumentBytes}/${this.limits.maxToolArgumentBytes} bytes)`
              )
            }
            const nextTotalPendingBytes = totalPendingToolArgumentBytes + bytes
            if (nextTotalPendingBytes > this.limits.maxTotalPendingToolArgumentBytesPerRequest) {
              throw new Error(
                `extension provider total pending tool-argument byte limit exceeded ` +
                `(${nextTotalPendingBytes}/${this.limits.maxTotalPendingToolArgumentBytesPerRequest} bytes)`
              )
            }
            appendProviderToolArguments(pending, event.argumentsDelta)
            pending.argumentBytes = nextArgumentBytes
            totalPendingToolArgumentBytes = nextTotalPendingBytes
          }
        }
        if (event.type === 'toolCallComplete') {
          const pending = pendingToolCall(event.callId)
          if (pending.complete) throw new Error('extension provider completed the same tool call more than once')
          const nextCompletedToolCalls = completedToolCalls + 1
          if (nextCompletedToolCalls > this.limits.maxCompletedToolCallsPerRequest) {
            throw new Error(
              `extension provider completed tool-call limit exceeded ` +
              `(${nextCompletedToolCalls}/${this.limits.maxCompletedToolCallsPerRequest})`
            )
          }
          const argumentBytes = serializedBytes(event.input)
          if (argumentBytes > this.limits.maxToolArgumentBytes) {
            throw new Error(
              `extension provider tool argument byte limit exceeded ` +
              `(${argumentBytes}/${this.limits.maxToolArgumentBytes} bytes)`
            )
          }
          const nextCompletedArgumentBytes = completedToolArgumentBytes + argumentBytes
          if (nextCompletedArgumentBytes > this.limits.maxCompletedToolArgumentBytesPerRequest) {
            throw new Error(
              `extension provider completed tool-argument byte limit exceeded ` +
              `(${nextCompletedArgumentBytes}/${this.limits.maxCompletedToolArgumentBytesPerRequest} bytes)`
            )
          }
          pending.complete = event
          completedToolCalls = nextCompletedToolCalls
          completedToolArgumentBytes = nextCompletedArgumentBytes
        }
        const chunks = mapProviderEvent(event)
        for (const chunk of chunks) {
          if (chunk.kind === 'assistant_text_delta' || chunk.kind === 'assistant_reasoning_delta') {
            outputBytes += Buffer.byteLength(chunk.text, 'utf8')
          }
        }
        if (outputBytes > this.limits.maxOutputBytesPerRequest) {
          throw new Error(
            `extension provider stream output byte limit exceeded ` +
            `(${outputBytes}/${this.limits.maxOutputBytesPerRequest} bytes)`
          )
        }
        if (event.type === 'completed' || event.type === 'error') {
          if (event.type === 'error') {
            const normalizedError = normalizeProviderReportedError(event.code, event.retryable)
            this.registration.reportDiagnostic({
              operation: 'stream',
              code: 'provider_error',
              category: normalizedError.category,
              retryable: normalizedError.retryable,
              modelId: request.model,
              accountId: request.accountId,
              requestId,
              message: normalizedError.message
            })
          }
          const toolCallChunks = event.type === 'completed'
            ? finalizeProviderToolCalls(
                normalized,
                pendingToolCalls,
                event.finishReason,
                this.limits
              )
            : []
          terminal = true
          terminalChunks = [
            ...toolCallChunks,
            ...(lastUsage ? [{ kind: 'usage' as const, usage: usageSnapshot(lastUsage) }] : []),
            ...(event.type === 'error'
              ? mapProviderErrorEvent(event)
              : chunks)
          ]
        } else {
          // Usage is a cumulative terminal snapshot. Buffer the latest event
          // so a provider that reports it both before and with completion is
          // accounted exactly once.
          if (
            event.type !== 'usage' &&
            event.type !== 'toolCallDelta' &&
            event.type !== 'toolCallComplete'
          ) for (const chunk of chunks) yield chunk
        }
      }
      if (!terminal) throw new Error('extension provider stream ended without a terminal event')
      for (const chunk of terminalChunks ?? []) yield chunk
    } catch (error) {
      if (controller.signal.aborted || request.abortSignal.aborted) throw abortError()
      // Extension cancellation is best-effort and must not be able to suppress
      // the bounded protocol error by returning a promise that never settles.
      void cancel(error)
      const safeMessage = safeProviderProtocolError(error)
      this.registration.reportDiagnostic({
        operation: 'stream',
        code: 'stream_protocol_error',
        category: 'protocol',
        retryable: false,
        modelId: request.model,
        accountId: request.accountId,
        requestId,
        message: safeMessage
      })
      yield {
        kind: 'error',
        code: 'extension_provider_protocol_error',
        message: safeMessage
      }
      yield { kind: 'completed', stopReason: 'error' }
    } finally {
      request.abortSignal.removeEventListener('abort', onRequestAbort)
      detachAbort()
      this.registration.activeRequests.delete(requestId)
    }
  }
}

async function mergedProviderModels(
  registration: ProviderRegistration,
  signal?: AbortSignal,
  accountId?: string
): Promise<ProviderModel[]> {
  let dynamic: ProviderModel[] = []
  try {
    dynamic = await registration.adapter.listModels(
      ProviderBindingSchema.parse({
        providerId: registration.providerId,
        ...(accountId ? { accountId } : {}),
        modelId: 'model-list'
      }),
      { cancellation: cancellationToken(signal ?? new AbortController().signal) }
    )
  } catch (error) {
    if (signal?.aborted) throw error
    registration.reportDiagnostic({
      operation: 'listModels',
      code: 'model_discovery_failed',
      category: 'adapter_failure',
      retryable: false,
      ...(accountId ? { accountId } : {}),
      message: 'Dynamic model discovery failed; using manifest-declared models.'
    })
    return [...registration.declaration.models].sort((left, right) => left.id.localeCompare(right.id))
  }
  const merged = new Map<string, ProviderModel>()
  const dynamicIds = new Set<string>()
  if (dynamic.length > 512) {
    registration.reportDiagnostic({
      operation: 'listModels',
      code: 'model_limit_exceeded',
      category: 'protocol',
      retryable: false,
      ...(accountId ? { accountId } : {}),
      message: 'Dynamic model discovery exceeded 512 entries; extra entries were ignored.'
    })
  }
  for (const model of dynamic.slice(0, 512)) {
    const parsed = ProviderModelSchema.safeParse(model)
    if (!parsed.success) {
      registration.reportDiagnostic({
        operation: 'listModels',
        code: 'invalid_model',
        category: 'protocol',
        retryable: false,
        ...(accountId ? { accountId } : {}),
        message: 'Dynamic model discovery returned an invalid entry; it was ignored.'
      })
      continue
    }
    if (dynamicIds.has(parsed.data.id)) {
      registration.reportDiagnostic({
        operation: 'listModels',
        code: 'duplicate_model',
        category: 'protocol',
        retryable: false,
        ...(accountId ? { accountId } : {}),
        modelId: parsed.data.id,
        message: `Dynamic model discovery returned duplicate model ID ${parsed.data.id}; the first entry was retained.`
      })
      continue
    }
    dynamicIds.add(parsed.data.id)
    merged.set(parsed.data.id, parsed.data)
  }
  // Manifest declarations are the reviewed, consented capability ceiling and
  // therefore override dynamic metadata for the same model identity.
  for (const model of registration.declaration.models) merged.set(model.id, model)
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function resolveProviderModel(
  registration: ProviderRegistration,
  modelId: string,
  signal?: AbortSignal,
  accountId?: string
): Promise<ProviderModel> {
  const declared = registration.declaration.models.find((model) => model.id === modelId)
  if (declared) return declared
  const dynamic = await mergedProviderModels(registration, signal, accountId)
  const model = dynamic.find((candidate) => candidate.id === modelId)
  if (!model) throw new Error(`model is not provided by ${registration.providerId}: ${modelId}`)
  return model
}

function assertModelRequestCapabilities(request: ModelRequest, model: ProviderModel): void {
  const capabilities = model.capabilities
  if (request.tools.length > 0 && !capabilities.tools) {
    throw new Error(`extension provider model does not support tools: ${model.id}`)
  }
  if (request.reasoningEffort && request.reasoningEffort !== 'off' && !capabilities.reasoning) {
    throw new Error(`extension provider model does not support reasoning: ${model.id}`)
  }
  if ((request.attachments?.length ?? 0) > 0 && !capabilities.input.includes('image')) {
    throw new Error(`extension provider model does not support image input: ${model.id}`)
  }
  if ((request.attachmentDocuments?.length ?? 0) > 0 && !capabilities.input.includes('file')) {
    throw new Error(`extension provider model does not support document input: ${model.id}`)
  }
  if (!capabilities.output.includes('text') && !capabilities.tools) {
    throw new Error(`extension provider model has no Kun-compatible output capability: ${model.id}`)
  }
}

function normalizeModelRequest(
  request: ModelRequest,
  requestId: string,
  providerId: string,
  accountId: string,
  supportsImages: boolean
): ModelProviderRequest {
  const projected = projectCompatMessages(request, { thinkingMode: true, supportsImages })
  const instructions: string[] = []
  const messages: ModelMessage[] = []
  for (const message of projected) {
    if (message.role === 'system') {
      const text = compatText(message.content)
      if (text) instructions.push(text)
      continue
    }
    const metadata: Record<string, unknown> = {}
    if (message.tool_calls?.length) metadata.toolCalls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJsonObject(call.function.arguments)
    }))
    if (message.reasoning_content?.trim()) metadata.reasoning = message.reasoning_content
    messages.push({
      role: message.role,
      content: compatContent(message.content),
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      ...(Object.keys(metadata).length ? { metadata: metadata as never } : {})
    })
  }
  const reasoning = normalizeReasoningEffort(request.reasoningEffort)
  return ModelProviderRequestSchema.parse({
    apiVersion: '1.0.0',
    requestId,
    binding: { providerId, accountId, modelId: request.model },
    instructions,
    messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })),
    generation: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { topP: request.topP } : {}),
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
      ...(request.requiredToolName
        ? { toolChoice: { type: 'tool' as const, name: request.requiredToolName } }
        : {})
    },
    metadata: {
      threadId: request.threadId,
      turnId: request.turnId,
      ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {})
    }
  })
}

function mapProviderEvent(event: ModelProviderStreamEvent): ModelStreamChunk[] {
  switch (event.type) {
    case 'textDelta': return [{ kind: 'assistant_text_delta', text: event.delta }]
    case 'reasoningDelta': return [{ kind: 'assistant_reasoning_delta', text: event.delta }]
    case 'toolCallDelta': return [{
      kind: 'tool_call_delta', callId: event.callId,
      ...(event.nameDelta ? { toolName: event.nameDelta } : {}),
      ...(event.argumentsDelta ? { argumentsDelta: event.argumentsDelta } : {})
    }]
    case 'toolCallComplete': return [{
      kind: 'tool_call_complete', callId: event.callId, toolName: event.name, arguments: event.input
    }]
    case 'usage': return [{ kind: 'usage', usage: usageSnapshot(event.usage) }]
    case 'completed': return [{
      kind: 'completed' as const,
      stopReason: event.finishReason === 'tool_calls'
        ? 'tool_calls' as const
        : event.finishReason === 'length'
          ? 'length' as const
          : 'stop' as const
    }]
    case 'error': return [
      {
        kind: 'error',
        message: 'Extension provider reported an error.',
        code: 'extension_provider_error'
      },
      { kind: 'completed', stopReason: 'error' }
    ]
  }
}

type NormalizedProviderError = {
  category: Extract<ExtensionModelProviderDiagnostic['category'],
    'authentication' | 'authorization' | 'rate_limit' | 'invalid_request' | 'unavailable' | 'adapter_failure'>
  retryable: boolean
  code: string
  message: string
}

function mapProviderErrorEvent(
  event: Extract<ModelProviderStreamEvent, { type: 'error' }>
): ModelStreamChunk[] {
  const normalized = normalizeProviderReportedError(event.code, event.retryable)
  return [
    { kind: 'error', message: normalized.message, code: normalized.code },
    { kind: 'completed', stopReason: 'error' }
  ]
}

/**
 * Provider-owned codes and messages are untrusted and may contain credentials.
 * Map only recognized semantic tokens into a fixed Kun vocabulary, retaining
 * retryability without persisting or displaying the raw adapter payload.
 */
function normalizeProviderReportedError(code: string, retryable: boolean): NormalizedProviderError {
  const tokens = code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const compact = tokens.join('')
  const has = (...values: string[]) => values.some((value) => tokens.includes(value))
  const is = (...values: string[]) => values.includes(compact)
  const httpStatus = tokens.find((token) => /^\d{3}$/.test(token))
  if (has('unauthenticated', 'authentication', 'reauthentication', 'credential', 'credentials',
    'invalidcredential', 'invalidcredentials', 'unauthorized') ||
      is('invalidapikey', 'invalidaccesstoken', 'authenticationrequired') ||
      httpStatus === '401' ||
      (has('auth') && !has('authorization', 'forbidden')) ||
      (has('api') && has('key')) ||
      (has('access') && has('token'))) {
    return {
      category: 'authentication',
      retryable,
      code: 'extension_provider_authentication_error',
      message: 'Extension provider authentication failed; reconnect the selected account.'
    }
  }
  if (has('authorization', 'forbidden', 'permission', 'denied') || httpStatus === '403') {
    return {
      category: 'authorization',
      retryable,
      code: 'extension_provider_authorization_error',
      message: 'Extension provider authorization failed for the selected account.'
    }
  }
  if (
    has('ratelimit', 'rate', 'quota', 'throttled', 'throttle') ||
    is('resourceexhausted', 'toomanyrequests', 'ratelimitexceeded', 'quotaexceeded') ||
    httpStatus === '429'
  ) {
    return {
      category: 'rate_limit',
      retryable,
      code: 'extension_provider_rate_limit_error',
      message: 'Extension provider rate limit was reached.'
    }
  }
  if (
    has('invalidrequest', 'invalid', 'badrequest', 'unsupported', 'notfound') ||
    is('modelnotfound', 'resourcenotfound', 'invalidargument', 'failedprecondition') ||
    httpStatus === '400' || httpStatus === '404' || httpStatus === '409' || httpStatus === '422'
  ) {
    return {
      category: 'invalid_request',
      retryable,
      code: 'extension_provider_invalid_request',
      message: 'Extension provider rejected the normalized request.'
    }
  }
  if (
    has('unavailable', 'timeout', 'overloaded', 'network', 'upstream') ||
    is('deadlineexceeded', 'requesttimeout', 'serviceunavailable', 'gatewaytimeout') ||
    httpStatus === '408' || httpStatus === '500' || httpStatus === '502' ||
    httpStatus === '503' || httpStatus === '504'
  ) {
    return {
      category: 'unavailable',
      retryable,
      code: 'extension_provider_unavailable',
      message: 'Extension provider is temporarily unavailable.'
    }
  }
  return {
    category: 'adapter_failure',
    retryable,
    code: 'extension_provider_error',
    message: 'Extension provider reported an error.'
  }
}

function finalizeProviderToolCalls(
  request: ModelProviderRequest,
  pending: ReadonlyMap<string, PendingProviderToolCall>,
  finishReason: Extract<ModelProviderStreamEvent, { type: 'completed' }>['finishReason'],
  limits: {
    maxCompletedToolCallsPerRequest: number
    maxToolArgumentBytes: number
    maxCompletedToolArgumentBytesPerRequest: number
  }
): ModelStreamChunk[] {
  if (finishReason === 'tool_calls' && pending.size === 0) {
    throw new Error('extension provider completed for tool calls without a completed call')
  }
  if (finishReason !== 'tool_calls' && pending.size > 0) {
    throw new Error('extension provider emitted tool calls with a non-tool terminal reason')
  }
  if (pending.size > limits.maxCompletedToolCallsPerRequest) {
    throw new Error(
      `extension provider completed tool-call limit exceeded ` +
      `(${pending.size}/${limits.maxCompletedToolCallsPerRequest})`
    )
  }

  const advertised = new Map(request.tools.map((tool) => [tool.name, tool]))
  const chunks: ModelStreamChunk[] = []
  let totalArgumentBytes = 0
  for (const call of pending.values()) {
    const fragmentedName = [...call.nameBlocks, ...call.nameParts].join('')
    const fragmentedArguments = [...call.argumentBlocks, ...call.argumentParts].join('')
    let name: string
    let input: Record<string, unknown>
    if (call.complete) {
      name = call.complete.name
      input = call.complete.input
      if (fragmentedName && fragmentedName !== name) {
        throw new Error('extension provider tool-call name fragments do not match completion')
      }
      if (fragmentedArguments) {
        const assembled = parseProviderToolArguments(fragmentedArguments)
        if (stableJson(assembled) !== stableJson(input)) {
          throw new Error('extension provider tool-call argument fragments do not match completion')
        }
      }
    } else {
      if (!fragmentedName) throw new Error('extension provider tool call has no name')
      name = fragmentedName
      input = parseProviderToolArguments(fragmentedArguments || '{}')
    }
    const tool = advertised.get(name)
    if (!tool) throw new Error('extension provider requested an unadvertised tool')
    compileExtensionJsonSchema(tool.inputSchema, `model tool ${name} input`)
      .assert(input, `extension provider tool call ${call.callId}`)

    const argumentBytes = serializedBytes(input)
    if (argumentBytes > limits.maxToolArgumentBytes) {
      throw new Error(
        `extension provider tool argument byte limit exceeded ` +
        `(${argumentBytes}/${limits.maxToolArgumentBytes} bytes)`
      )
    }
    totalArgumentBytes += argumentBytes
    if (totalArgumentBytes > limits.maxCompletedToolArgumentBytesPerRequest) {
      throw new Error(
        `extension provider completed tool-argument byte limit exceeded ` +
        `(${totalArgumentBytes}/${limits.maxCompletedToolArgumentBytesPerRequest} bytes)`
      )
    }
    chunks.push({
      kind: 'tool_call_complete',
      callId: call.callId,
      toolName: name,
      arguments: input
    })
  }
  return chunks
}

function appendProviderToolName(pending: PendingProviderToolCall, value: string): void {
  pending.nameParts.push(value)
  if (pending.nameParts.length < TOOL_ARGUMENT_PART_COMPACTION_WINDOW) return
  pending.nameBlocks.push(pending.nameParts.join(''))
  pending.nameParts = []
}

function appendProviderToolArguments(pending: PendingProviderToolCall, value: string): void {
  pending.argumentParts.push(value)
  if (pending.argumentParts.length < TOOL_ARGUMENT_PART_COMPACTION_WINDOW) return
  pending.argumentBlocks.push(pending.argumentParts.join(''))
  pending.argumentParts = []
}

function parseProviderToolArguments(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('extension provider tool-call arguments are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extension provider tool-call arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value))
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)])
  )
}

function usageSnapshot(usage: {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  currency?: string
}) {
  const promptTokens = usage.inputTokens ?? 0
  const completionTokens = usage.outputTokens ?? 0
  const currency = usage.currency?.toUpperCase()
  return {
    promptTokens,
    completionTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    totalTokens: promptTokens + completionTokens,
    ...(usage.cacheReadTokens !== undefined ? { cachedTokens: usage.cacheReadTokens, cacheHitTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    cacheHitRate: usage.cacheReadTokens !== undefined && promptTokens > 0
      ? Math.min(1, usage.cacheReadTokens / promptTokens)
      : null,
    turns: 1,
    ...(usage.cost !== undefined && currency ? { costByCurrency: { [currency]: usage.cost } } : {}),
    ...(usage.cost !== undefined && currency === 'USD' ? { costUsd: usage.cost } : {}),
    ...(usage.cost !== undefined && currency === 'CNY' ? { costCny: usage.cost } : {})
  }
}

function hasReportedUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
}): boolean {
  return usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.cost !== undefined
}

function safeProviderProtocolError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const safePrefixes = [
    'extension provider stream event limit exceeded',
    'extension provider stream event is too large',
    'extension provider stream byte limit exceeded',
    'extension provider stream requestId mismatch',
    'extension provider stream sequence mismatch',
    'extension provider emitted data after a terminal event',
    'extension provider completed without terminal usage',
    'extension provider stream output byte limit exceeded',
    'extension provider pending tool-call limit exceeded',
    'extension provider tool argument byte limit exceeded',
    'extension provider total pending tool-argument byte limit exceeded',
    'extension provider completed tool-call limit exceeded',
    'extension provider completed tool-argument byte limit exceeded',
    'extension provider completed for tool calls without a completed call',
    'extension provider emitted tool calls with a non-tool terminal reason',
    'extension provider tool-call name fragments do not match completion',
    'extension provider tool-call argument fragments do not match completion',
    'extension provider tool call has no name',
    'extension provider requested an unadvertised tool',
    'extension provider tool-call arguments are not valid JSON',
    'extension provider tool-call arguments must be a JSON object',
    'extension provider emitted tool-call data after completion',
    'extension provider completed the same tool call more than once',
    'extension provider stream ended without a terminal event'
  ]
  return safePrefixes.some((prefix) => message.startsWith(prefix))
    ? message.slice(0, 4_096)
    : 'Extension provider returned malformed stream data.'
}

function compatContent(content: CompatChatMessage['content']): ModelContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!content) return []
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text }
    const parsed = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url)
    return parsed
      ? { type: 'image' as const, mimeType: parsed[1]!, data: parsed[2]! }
      : { type: 'text' as const, text: `[image: ${part.image_url.url}]` }
  })
}

function compatText(content: CompatChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content?.map((part) => part.type === 'text' ? part.text : '').join('\n') ?? ''
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function normalizeReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  if (value === 'max') return 'high'
  return undefined
}

function cancellationToken(signal: AbortSignal) {
  return {
    get isCancellationRequested() { return signal.aborted },
    onCancellationRequested(listener: () => void) {
      signal.addEventListener('abort', listener, { once: true })
      return { dispose: () => signal.removeEventListener('abort', listener) }
    }
  }
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason)
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

function abortError(): Error {
  const error = new Error('extension provider request aborted')
  error.name = 'AbortError'
  return error
}
