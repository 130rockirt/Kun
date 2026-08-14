import { createHash } from 'node:crypto'
import {
  GENERATION_LIMITS,
  type GenerationAssessment,
  type GenerationAuthorizationReceipt,
  type GenerationCatalog,
  type GenerationConsent,
  type GenerationCreateResult,
  type GenerationOutputKind,
  type GenerationOwner,
  type GenerationPersistence,
  type GenerationRecord,
  type GenerationRecordState,
  type GenerationReference,
  type GenerationRequest,
  type GenerationTask
} from './generation-model.js'
import {
  assertNoCatalogLocators,
  assertNoSecretFields,
  boundedArray,
  boundedString,
  constraintProblem,
  digest,
  exactObject,
  executionId,
  nonNegativeInteger,
  oneOf,
  opaqueId,
  ownerMatches,
  placeholderName,
  positiveInteger,
  providerIdValue,
  quoteFor,
  safeCode,
  safeId,
  timestamp,
  validateAuthorization,
  validateConsent,
  validateOutputs,
  validateOwner,
  validateProgress,
  validateProvider,
  validateReference,
  validateRequestedOutput,
  validateSnapshot,
  validationError
} from './generation-validation.js'

export const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/u
export const SAFE_LOCAL_ID = /^[A-Za-z][A-Za-z0-9._~-]{0,255}$/u
export const OPAQUE_ID = /^[A-Za-z0-9._~-]{8,256}$/u
export const OPAQUE_MEDIA_ID = /^[A-Za-z0-9_-]{16,512}$/u
export const CURRENCY = /^[A-Z]{3}$/u
export const MIME_BY_KIND: Readonly<Record<GenerationOutputKind, ReadonlySet<string>>> = Object.freeze({
  image: new Set(['image/png', 'image/jpeg', 'image/webp']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac'])
})
export const ACTIVE_STATES = new Set<GenerationRecordState>(['placeholder', 'queued', 'running', 'cancelling'])
export const CREDENTIAL_ASSIGNMENT = /(?:api[_-]?key|(?:access[_-]?)?token|auth(?:orization)?|password|secret)\s*[:=]\s*[^\s,;]+/iu

export function validateGenerationCatalog(value: unknown): GenerationCatalog {
  const catalog = exactObject(value, ['schemaVersion', 'revision', 'generatedAt', 'providers'], 'catalog')
  if (catalog.schemaVersion !== 1) throw validationError('catalog.schemaVersion must be 1')
  const revision = boundedString(catalog.revision, 'catalog.revision', 1, 128)
  const generatedAt = timestamp(catalog.generatedAt, 'catalog.generatedAt')
  const providerValues = boundedArray(catalog.providers, 'catalog.providers', GENERATION_LIMITS.providers)
  const providers = providerValues.map((provider, index) => validateProvider(provider, index))
  if (new Set(providers.map(({ id }) => id)).size !== providers.length) {
    throw validationError('Generation provider IDs must be unique')
  }
  const modelIds = new Set<string>()
  let modelCount = 0
  for (const provider of providers) {
    for (const model of provider.models) {
      modelCount += 1
      const qualified = `${provider.id}/${model.id}`
      if (modelIds.has(qualified)) throw validationError(`Duplicate generation model ${qualified}`)
      modelIds.add(qualified)
    }
  }
  if (modelCount > GENERATION_LIMITS.models) throw validationError('Generation catalog contains too many models')
  assertNoSecretFields(catalog, 'catalog')
  const validated = { schemaVersion: 1 as const, revision, generatedAt, providers }
  assertNoCatalogLocators(validated, 'catalog')
  return validated
}

export function normalizeGenerationRequest(value: unknown): GenerationRequest {
  const request = exactObject(value, [
    'task', 'projectId', 'projectRevision', 'providerId', 'modelId', 'prompt', 'negativePrompt',
    'references', 'variants', 'seed', 'output', 'outputPolicy', 'idempotencyKey', 'consent'
  ], 'request')
  const task = oneOf(request.task, ['image', 'video', 'audio', 'upscale'] as const, 'request.task')
  const projectId = safeId(request.projectId, 'request.projectId')
  const projectRevision = nonNegativeInteger(request.projectRevision, 'request.projectRevision')
  const providerId = providerIdValue(request.providerId, 'request.providerId')
  const modelId = providerIdValue(request.modelId, 'request.modelId')
  const prompt = boundedString(request.prompt, 'request.prompt', 1, GENERATION_LIMITS.promptCharacters).normalize('NFKC').trim()
  if (CREDENTIAL_ASSIGNMENT.test(prompt)) throw validationError('request.prompt appears to contain a credential assignment')
  const negativePrompt = request.negativePrompt === undefined
    ? undefined
    : boundedString(request.negativePrompt, 'request.negativePrompt', 1, GENERATION_LIMITS.negativePromptCharacters).normalize('NFKC').trim()
  if (negativePrompt && CREDENTIAL_ASSIGNMENT.test(negativePrompt)) {
    throw validationError('request.negativePrompt appears to contain a credential assignment')
  }
  const references = boundedArray(request.references, 'request.references', GENERATION_LIMITS.references)
    .map((reference, index) => validateReference(reference, index))
  const variants = positiveInteger(request.variants, 'request.variants', GENERATION_LIMITS.variants)
  const seed = request.seed === undefined ? undefined : nonNegativeInteger(request.seed, 'request.seed')
  const output = validateRequestedOutput(request.output)
  const outputPolicy = oneOf(request.outputPolicy, ['resolve-placeholder', 'add-variants'] as const, 'request.outputPolicy')
  const idempotencyKey = opaqueId(request.idempotencyKey, 'request.idempotencyKey')
  const consent = validateConsent(request.consent)
  assertNoSecretFields(request, 'request')
  return {
    task,
    projectId,
    projectRevision,
    providerId,
    modelId,
    prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
    references,
    variants,
    ...(seed === undefined ? {} : { seed }),
    output,
    outputPolicy,
    idempotencyKey,
    consent
  }
}

export function assessGenerationRequest(catalogValue: unknown, requestValue: unknown): GenerationAssessment {
  const request = normalizeGenerationRequest(requestValue)
  let catalog: GenerationCatalog
  try {
    catalog = validateGenerationCatalog(catalogValue)
  } catch {
    return {
      outcome: 'unavailable',
      request,
      code: 'catalog-unavailable',
      message: 'No validated generation catalog is available. Editing remains available.'
    }
  }
  const provider = catalog.providers.find(({ id }) => id === request.providerId)
  if (!provider) {
    return { outcome: 'unavailable', request, code: 'provider-unavailable', message: 'The requested provider is not present in the validated catalog.' }
  }
  if (provider.status !== 'available') {
    return {
      outcome: 'unavailable',
      request,
      code: 'provider-unavailable',
      message: provider.unavailableReason ?? 'The requested provider is unavailable.'
    }
  }
  const model = provider.models.find(({ id }) => id === request.modelId)
  if (!model) {
    return { outcome: 'unavailable', request, code: 'model-unavailable', message: 'The requested model is unavailable.' }
  }
  const unsupported = constraintProblem(model, request)
  if (unsupported) {
    return { outcome: 'unavailable', request, code: 'unsupported-constraints', message: unsupported }
  }
  const quote = quoteFor(catalog.revision, provider.id, model, request)
  const missing: Array<'provider-permission' | 'media-upload' | 'cost'> = []
  if ((provider.kind !== 'local' || model.permissions.permissionIds.length > 0) && !request.consent.providerPermissionApproved) {
    missing.push('provider-permission')
  }
  if (request.references.length > 0 && model.permissions.mediaUpload === 'explicit' && !request.consent.mediaUploadApproved) {
    missing.push('media-upload')
  }
  if (
    quote.maximumMinor > 0 &&
    (!request.consent.costApproved ||
      request.consent.currency !== quote.currency ||
      request.consent.approvedMaximumMinor < quote.maximumMinor)
  ) {
    missing.push('cost')
  }
  return missing.length > 0
    ? { outcome: 'confirmation-required', request, provider, model, quote, missing }
    : { outcome: 'ready', request, provider, model, quote }
}

export class GenerationStore {
  readonly recoveryDiagnostics: string[]
  private records: GenerationRecord[]
  private generation: number
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly persistence: GenerationPersistence,
    private readonly now: () => Date,
    records: GenerationRecord[],
    generation: number,
    diagnostics: string[]
  ) {
    this.records = records
    this.generation = generation
    this.recoveryDiagnostics = diagnostics
  }

  static async open(
    persistence: GenerationPersistence,
    options: { now?: () => Date } = {}
  ): Promise<GenerationStore> {
    const diagnostics: string[] = []
    let records: GenerationRecord[] = []
    let generation = 0
    const loaded = await persistence.load()
    if (loaded !== undefined) {
      try {
        const snapshot = validateSnapshot(loaded)
        records = snapshot.records
        generation = snapshot.generation
      } catch (error) {
        diagnostics.push(`Generation metadata was preserved but could not be decoded: ${redactGenerationDiagnostic(error)}`)
      }
    }
    return new GenerationStore(persistence, options.now ?? (() => new Date()), records, generation, diagnostics)
  }

  async list(owner: Partial<GenerationOwner> = {}): Promise<GenerationRecord[]> {
    return await this.serialized(async () => structuredClone(this.records
      .filter((record) => ownerMatches(record.owner, owner))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))))
  }

  async get(id: string): Promise<GenerationRecord | undefined> {
    return await this.serialized(async () => {
      const record = this.records.find((candidate) => candidate.id === id)
      return record ? structuredClone(record) : undefined
    })
  }

  async findByIdempotency(owner: GenerationOwner, idempotencyKey: string): Promise<GenerationRecord | undefined> {
    const validatedOwner = validateOwner(owner)
    const key = opaqueId(idempotencyKey, 'idempotencyKey')
    return await this.serialized(async () => {
      const record = this.records.find((candidate) =>
        ownerMatches(candidate.owner, validatedOwner) && candidate.request.idempotencyKey === key
      )
      return record ? structuredClone(record) : undefined
    })
  }

  async create(
    ownerValue: GenerationOwner,
    assessment: Extract<GenerationAssessment, { outcome: 'ready' }>,
    authorizationValue: unknown
  ): Promise<GenerationCreateResult> {
    return await this.serialized(async () => {
      const owner = validateOwner(ownerValue)
      if (owner.projectId !== assessment.request.projectId) throw validationError('Generation owner project does not match request project')
      const existing = this.records.find((record) =>
        ownerMatches(record.owner, owner) && record.request.idempotencyKey === assessment.request.idempotencyKey
      )
      const requestDigest = generationRequestDigest(assessment.request)
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw validationError('Idempotency key is already bound to a different generation request')
        }
        return { record: structuredClone(existing), deduplicated: true }
      }
      const authorization = validateAuthorization(
        authorizationValue,
        owner,
        assessment,
        this.optionsNow()
      )
      if (this.records.length >= GENERATION_LIMITS.records) throw validationError('Generation record limit reached')
      const now = this.timestamp()
      const id = `generation_${digest(`${owner.extensionId}\n${owner.workspaceId}\n${owner.projectId}\n${assessment.request.idempotencyKey}`).slice(0, 24)}`
      const record: GenerationRecord = {
        schemaVersion: 1,
        id,
        generation: this.nextGeneration(),
        owner,
        request: structuredClone(assessment.request),
        requestDigest,
        quote: structuredClone(assessment.quote),
        authorization,
        placeholder: {
          assetId: `generated_${digest(`${id}\nplaceholder`).slice(0, 24)}`,
          displayName: placeholderName(assessment.request),
          kind: assessment.request.output.kind,
          state: 'pending'
        },
        state: 'placeholder',
        attempt: 1,
        executionId: executionId(id, 1),
        outputs: [],
        createdAt: now,
        updatedAt: now
      }
      this.records.push(record)
      await this.persist()
      return { record: structuredClone(record), deduplicated: false }
    })
  }

  async retry(
    id: string,
    assessment: Extract<GenerationAssessment, { outcome: 'ready' }>,
    authorizationValue: unknown
  ): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!['failed', 'cancelled', 'interrupted'].includes(record.state)) {
        throw validationError('Only failed, cancelled, or interrupted generation records can be retried')
      }
      const requestDigest = generationRequestDigest(assessment.request)
      if (
        record.request.idempotencyKey !== assessment.request.idempotencyKey ||
        record.requestDigest !== requestDigest
      ) {
        throw validationError('Retry assessment does not match the original idempotent request')
      }
      const authorization = validateAuthorization(
        authorizationValue,
        record.owner,
        assessment,
        this.optionsNow()
      )
      record.request = structuredClone(assessment.request)
      record.quote = structuredClone(assessment.quote)
      record.authorization = authorization
      record.attempt += 1
      record.executionId = executionId(record.id, record.attempt)
      record.jobId = undefined
      record.progress = undefined
      record.outputs = []
      record.selectedOutputId = undefined
      record.error = undefined
      record.state = 'placeholder'
      record.placeholder.state = 'pending'
    })
  }

  async markQueued(id: string, jobIdValue: unknown): Promise<GenerationRecord> {
    return await this.markDispatched(id, jobIdValue, 'queued')
  }

  async markDispatched(
    id: string,
    jobIdValue: unknown,
    stateValue: 'queued' | 'running'
  ): Promise<GenerationRecord> {
    const jobId = opaqueId(jobIdValue, 'jobId')
    const state = oneOf(stateValue, ['queued', 'running'] as const, 'generation dispatch state')
    return await this.mutate(id, (record) => {
      if (!['placeholder', 'queued', 'running'].includes(record.state)) {
        throw validationError('Generation record cannot accept a dispatch state')
      }
      if (record.jobId && record.jobId !== jobId) throw validationError('Prepared generation job identity changed before dispatch')
      if (record.state === 'running' && state === 'queued') {
        throw validationError('Generation dispatch state cannot move backwards')
      }
      record.jobId = jobId
      record.state = state
    })
  }

  async bindPreparedJob(id: string, jobIdValue: unknown): Promise<GenerationRecord> {
    const jobId = opaqueId(jobIdValue, 'jobId')
    return await this.mutate(id, (record) => {
      if (record.state !== 'placeholder') throw validationError('Generation record is not awaiting job preparation')
      if (record.jobId && record.jobId !== jobId) throw validationError('Prepared generation job identity changed')
      record.jobId = jobId
    })
  }

  async reportProgress(id: string, progressValue: unknown): Promise<GenerationRecord> {
    const progress = validateProgress(progressValue)
    return await this.mutate(id, (record) => {
      if (!['queued', 'running', 'cancelling'].includes(record.state)) throw validationError('Generation record is not running')
      if (record.progress) {
        if (progress.total !== record.progress.total || progress.unit !== record.progress.unit) {
          throw validationError('Generation progress total/unit cannot change')
        }
        if (progress.completed < record.progress.completed) throw validationError('Generation progress cannot move backwards')
        if (Date.parse(progress.updatedAt) < Date.parse(record.progress.updatedAt)) {
          throw validationError('Generation progress timestamp cannot move backwards')
        }
      }
      record.progress = progress
      if (record.state === 'queued') record.state = 'running'
    })
  }

  async requestCancellation(id: string): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!ACTIVE_STATES.has(record.state)) return
      record.state = 'cancelling'
    })
  }

  async cancel(id: string): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!ACTIVE_STATES.has(record.state)) return
      record.state = 'cancelled'
      record.placeholder.state = 'cancelled'
      record.error = { code: 'cancelled', message: 'Generation was cancelled.', retryable: true }
    })
  }

  async fail(id: string, error: { code: string; message: unknown; retryable: boolean }): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!ACTIVE_STATES.has(record.state)) return
      record.state = 'failed'
      record.placeholder.state = 'failed'
      record.error = {
        code: safeCode(error.code),
        message: redactGenerationDiagnostic(error.message),
        retryable: error.retryable
      }
    })
  }

  async interrupt(id: string, message: unknown): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!ACTIVE_STATES.has(record.state)) return
      record.state = 'interrupted'
      record.placeholder.state = 'interrupted'
      record.error = { code: 'interrupted', message: redactGenerationDiagnostic(message), retryable: true }
    })
  }

  async complete(id: string, outputValue: unknown, jobOwnerValue: unknown): Promise<GenerationRecord> {
    return await this.mutate(id, (record) => {
      if (!['queued', 'running', 'cancelling'].includes(record.state)) throw validationError('Generation record cannot accept outputs')
      const jobOwner = validateOwner(jobOwnerValue)
      if (!ownerMatches(record.owner, jobOwner)) throw validationError('Generation output owner does not match record owner')
      const outputs = validateOutputs(outputValue, record.request, this.timestamp())
      record.outputs = outputs
      record.selectedOutputId = outputs.find(({ primary }) => primary)?.id ?? outputs[0]!.id
      record.state = 'ready'
      record.placeholder.state = 'resolved'
      record.error = undefined
    })
  }

  private async mutate(id: string, action: (record: GenerationRecord) => void): Promise<GenerationRecord> {
    return await this.serialized(async () => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (!record) throw validationError(`Unknown generation record ${id}`)
      action(record)
      record.generation = this.nextGeneration()
      record.updatedAt = this.timestamp()
      await this.persist()
      return structuredClone(record)
    })
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action)
    this.queue = pending.then(() => undefined, () => undefined)
    return await pending
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private optionsNow(): Date {
    return this.now()
  }

  private async persist(): Promise<void> {
    await this.persistence.save({ schemaVersion: 1, generation: this.generation, records: structuredClone(this.records) })
  }
}

export type GenerationExecutionRequest = {
  schemaVersion: 1
  executionId: string
  requestDigest: string
  owner: GenerationOwner
  providerId: string
  modelId: string
  task: GenerationTask
  prompt: string
  negativePrompt?: string
  references: GenerationReference[]
  variants: number
  seed?: number
  output: GenerationRequest['output']
  outputPolicy: GenerationRequest['outputPolicy']
  consent: GenerationConsent
  authorization: GenerationAuthorizationReceipt
}

export function executionRequest(record: GenerationRecord): GenerationExecutionRequest {
  if (record.state !== 'placeholder') throw validationError('Generation record is not awaiting execution')
  return {
    schemaVersion: 1,
    executionId: record.executionId,
    requestDigest: record.requestDigest,
    owner: structuredClone(record.owner),
    providerId: record.request.providerId,
    modelId: record.request.modelId,
    task: record.request.task,
    prompt: record.request.prompt,
    ...(record.request.negativePrompt ? { negativePrompt: record.request.negativePrompt } : {}),
    references: structuredClone(record.request.references),
    variants: record.request.variants,
    ...(record.request.seed === undefined ? {} : { seed: record.request.seed }),
    output: structuredClone(record.request.output),
    outputPolicy: record.request.outputPolicy,
    consent: structuredClone(record.request.consent),
    authorization: structuredClone(record.authorization)
  }
}

export function generationPublicProjection(record: GenerationRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: record.id,
    generation: record.generation,
    projectId: record.owner.projectId,
    projectRevision: record.request.projectRevision,
    providerId: record.request.providerId,
    modelId: record.request.modelId,
    task: record.request.task,
    promptDigest: digest(record.request.prompt),
    requestDigest: record.requestDigest,
    referenceAssetIds: record.request.references.map(({ assetId }) => assetId),
    variantsRequested: record.request.variants,
    outputPolicy: record.request.outputPolicy,
    quote: structuredClone(record.quote),
    placeholder: structuredClone(record.placeholder),
    state: record.state,
    attempt: record.attempt,
    ...(record.jobId ? { jobId: record.jobId } : {}),
    ...(record.progress ? { progress: structuredClone(record.progress) } : {}),
    outputs: record.outputs.map(({ outputHandleId: _handle, completionIdentity: _identity, ...output }) => output),
    ...(record.selectedOutputId ? { selectedOutputId: record.selectedOutputId } : {}),
    ...(record.error ? { error: structuredClone(record.error) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export function generationRequestDigest(requestValue: GenerationRequest): string {
  const request = normalizeGenerationRequest(requestValue)
  return digest(JSON.stringify({
    task: request.task,
    projectId: request.projectId,
    projectRevision: request.projectRevision,
    providerId: request.providerId,
    modelId: request.modelId,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? null,
    // Opaque media grants can be rotated or reacquired without changing the
    // semantic idempotency identity. Source fingerprints still fence changed
    // media, while executionRequest carries the current Host-only handles.
    references: request.references.map(({ assetId, kind, sourceFingerprint }) => ({
      assetId,
      kind,
      ...(sourceFingerprint ? { sourceFingerprint } : {})
    })),
    variants: request.variants,
    seed: request.seed ?? null,
    output: request.output,
    outputPolicy: request.outputPolicy,
    idempotencyKey: request.idempotencyKey
  }))
}

export function generationPromptDigest(prompt: string): string {
  return digest(boundedString(prompt, 'generation prompt', 1, GENERATION_LIMITS.promptCharacters))
}

export function redactGenerationDiagnostic(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/(?:api[_-]?key|(?:access[_-]?)?token|auth(?:orization)?|password|secret)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED_CREDENTIAL]')
    .replace(/https?:\/\/[^\s)\]}>,]+/giu, '[REDACTED_URL]')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private|Volumes)\/)[^\s)\]}>,]+/gu, '[REDACTED_PATH]')
    .slice(0, GENERATION_LIMITS.diagnosticCharacters)
}
