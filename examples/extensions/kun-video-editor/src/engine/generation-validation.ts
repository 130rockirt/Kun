import { createHash } from 'node:crypto'
import {
  GENERATION_LIMITS,
  type GenerationAssessment,
  type GenerationAuthorizationReceipt,
  type GenerationConsent,
  type GenerationCostQuote,
  type GenerationModelDescriptor,
  type GenerationOutput,
  type GenerationOwner,
  type GenerationProgress,
  type GenerationProviderDescriptor,
  type GenerationProviderKind,
  type GenerationRecord,
  type GenerationReference,
  type GenerationRequest,
  type GenerationSnapshot
} from './generation-model.js'
import {
  CREDENTIAL_ASSIGNMENT,
  CURRENCY,
  MIME_BY_KIND,
  OPAQUE_ID,
  OPAQUE_MEDIA_ID,
  PROVIDER_ID,
  SAFE_LOCAL_ID,
  generationRequestDigest,
  normalizeGenerationRequest,
  redactGenerationDiagnostic
} from './generation-runtime.js'

export function validateProvider(value: unknown, index: number): GenerationProviderDescriptor {
  const provider = exactObject(value, ['id', 'displayName', 'version', 'kind', 'status', 'unavailableReason', 'models'], `catalog.providers[${index}]`)
  const id = providerIdValue(provider.id, `catalog.providers[${index}].id`)
  const kind = oneOf(provider.kind, ['local', 'byok', 'remote'] as const, `catalog.providers[${index}].kind`)
  const status = oneOf(provider.status, ['available', 'unavailable'] as const, `catalog.providers[${index}].status`)
  const models = boundedArray(provider.models, `catalog.providers[${index}].models`, GENERATION_LIMITS.models)
    .map((model, modelIndex) => validateModel(model, id, kind, modelIndex))
  const unavailableReason = provider.unavailableReason === undefined
    ? undefined
    : boundedString(provider.unavailableReason, `catalog.providers[${index}].unavailableReason`, 1, 512)
  if (status === 'unavailable' && !unavailableReason) throw validationError(`catalog.providers[${index}] requires unavailableReason`)
  return {
    id,
    displayName: boundedString(provider.displayName, `catalog.providers[${index}].displayName`, 1, 128),
    version: boundedString(provider.version, `catalog.providers[${index}].version`, 1, 128),
    kind,
    status,
    ...(unavailableReason ? { unavailableReason } : {}),
    models
  }
}

export function validateModel(value: unknown, providerId: string, providerKind: GenerationProviderKind, index: number): GenerationModelDescriptor {
  const model = exactObject(value, [
    'id', 'displayName', 'version', 'tasks', 'outputKinds', 'referenceKinds', 'limits', 'permissions', 'privacy', 'cost'
  ], `provider ${providerId} model[${index}]`)
  const tasks = uniqueEnumArray(model.tasks, ['image', 'video', 'audio', 'upscale'] as const, `provider ${providerId} model[${index}].tasks`)
  const outputKinds = uniqueEnumArray(model.outputKinds, ['image', 'video', 'audio'] as const, `provider ${providerId} model[${index}].outputKinds`)
  const referenceKinds = uniqueEnumArray(model.referenceKinds, ['image', 'video', 'audio'] as const, `provider ${providerId} model[${index}].referenceKinds`, true)
  const limitsValue = exactObject(model.limits, [
    'maxPromptCharacters', 'minReferences', 'maxReferences', 'maxVariants', 'maxWidth', 'maxHeight', 'maxDurationUs'
  ], `provider ${providerId} model[${index}].limits`)
  const minReferences = nonNegativeInteger(limitsValue.minReferences, 'limits.minReferences')
  const maxReferences = nonNegativeInteger(limitsValue.maxReferences, 'limits.maxReferences')
  if (minReferences > maxReferences || maxReferences > GENERATION_LIMITS.references) throw validationError('Invalid generation reference limits')
  if (minReferences > 0 && referenceKinds.length === 0) {
    throw validationError('Generation models requiring references must advertise a reference kind')
  }
  const permissionsValue = exactObject(model.permissions, ['permissionIds', 'credential', 'mediaUpload'], 'model.permissions')
  const permissionIds = boundedArray(permissionsValue.permissionIds, 'model.permissions.permissionIds', 16)
    .map((permission, permissionIndex) => permissionId(permission, `model.permissions.permissionIds[${permissionIndex}]`))
  if (new Set(permissionIds).size !== permissionIds.length) {
    throw validationError('Generation model permission IDs must be unique')
  }
  const credential = oneOf(permissionsValue.credential, ['none', 'host-account'] as const, 'model.permissions.credential')
  const mediaUpload = oneOf(permissionsValue.mediaUpload, ['never', 'explicit'] as const, 'model.permissions.mediaUpload')
  if (
    providerKind === 'local' &&
    (credential !== 'none' || permissionIds.some((id) => id.startsWith('network:')) || mediaUpload !== 'never')
  ) {
    throw validationError('Local generation models cannot require credentials, network permission, or media upload')
  }
  if (providerKind === 'byok' && credential !== 'host-account') throw validationError('BYOK generation models require a Host account session')
  const privacyValue = exactObject(model.privacy, ['processing', 'promptRetention', 'mediaRetention'], 'model.privacy')
  const processing = oneOf(privacyValue.processing, ['device', 'provider'] as const, 'model.privacy.processing')
  if (providerKind === 'local' && processing !== 'device') throw validationError('Local generation must declare device processing')
  if (providerKind !== 'local' && processing !== 'provider') throw validationError('Remote/BYOK generation must declare provider processing')
  const promptRetention = oneOf(privacyValue.promptRetention, ['none', 'provider-policy'] as const, 'model.privacy.promptRetention')
  const mediaRetention = oneOf(privacyValue.mediaRetention, ['none', 'provider-policy'] as const, 'model.privacy.mediaRetention')
  if (providerKind === 'local' && (promptRetention !== 'none' || mediaRetention !== 'none')) {
    throw validationError('Local generation cannot declare provider retention')
  }
  const costValue = exactObject(model.cost, ['currency', 'minimumMinor', 'maximumMinor', 'estimateOnly'], 'model.cost')
  const minimumMinor = nonNegativeInteger(costValue.minimumMinor, 'model.cost.minimumMinor')
  const maximumMinor = nonNegativeInteger(costValue.maximumMinor, 'model.cost.maximumMinor')
  if (minimumMinor > maximumMinor) throw validationError('Generation minimum cost cannot exceed maximum cost')
  return {
    id: providerIdValue(model.id, `provider ${providerId} model[${index}].id`),
    displayName: boundedString(model.displayName, `provider ${providerId} model[${index}].displayName`, 1, 128),
    version: boundedString(model.version, `provider ${providerId} model[${index}].version`, 1, 128),
    tasks,
    outputKinds,
    referenceKinds,
    limits: {
      maxPromptCharacters: positiveInteger(limitsValue.maxPromptCharacters, 'limits.maxPromptCharacters', GENERATION_LIMITS.promptCharacters),
      minReferences,
      maxReferences,
      maxVariants: positiveInteger(limitsValue.maxVariants, 'limits.maxVariants', GENERATION_LIMITS.variants),
      ...(limitsValue.maxWidth === undefined ? {} : { maxWidth: positiveInteger(limitsValue.maxWidth, 'limits.maxWidth', 65_536) }),
      ...(limitsValue.maxHeight === undefined ? {} : { maxHeight: positiveInteger(limitsValue.maxHeight, 'limits.maxHeight', 65_536) }),
      ...(limitsValue.maxDurationUs === undefined ? {} : { maxDurationUs: positiveInteger(limitsValue.maxDurationUs, 'limits.maxDurationUs', Number.MAX_SAFE_INTEGER) })
    },
    permissions: { permissionIds, credential, mediaUpload },
    privacy: {
      processing,
      promptRetention,
      mediaRetention
    },
    cost: {
      currency: currency(costValue.currency, 'model.cost.currency'),
      minimumMinor,
      maximumMinor,
      estimateOnly: booleanValue(costValue.estimateOnly, 'model.cost.estimateOnly')
    }
  }
}

export function validateReference(value: unknown, index: number): GenerationReference {
  const reference = exactObject(value, ['assetId', 'mediaHandleId', 'kind', 'sourceFingerprint'], `request.references[${index}]`)
  const sourceFingerprint = reference.sourceFingerprint === undefined
    ? undefined
    : validateFingerprint(reference.sourceFingerprint, `request.references[${index}].sourceFingerprint`)
  return {
    assetId: safeId(reference.assetId, `request.references[${index}].assetId`),
    mediaHandleId: opaqueMediaId(reference.mediaHandleId, `request.references[${index}].mediaHandleId`),
    kind: oneOf(reference.kind, ['image', 'video', 'audio'] as const, `request.references[${index}].kind`),
    ...(sourceFingerprint ? { sourceFingerprint } : {})
  }
}

export function validateRequestedOutput(value: unknown): GenerationRequest['output'] {
  const output = exactObject(value, ['kind', 'width', 'height', 'durationUs'], 'request.output')
  const kind = oneOf(output.kind, ['image', 'video', 'audio'] as const, 'request.output.kind')
  const width = output.width === undefined ? undefined : positiveInteger(output.width, 'request.output.width', 65_536)
  const height = output.height === undefined ? undefined : positiveInteger(output.height, 'request.output.height', 65_536)
  const durationUs = output.durationUs === undefined
    ? undefined
    : positiveInteger(output.durationUs, 'request.output.durationUs', Number.MAX_SAFE_INTEGER)
  if ((width === undefined) !== (height === undefined)) {
    throw validationError('request.output width and height must be provided together')
  }
  if (kind === 'audio' && (width !== undefined || height !== undefined)) {
    throw validationError('request.output audio cannot contain visual dimensions')
  }
  if (kind === 'image' && durationUs !== undefined) {
    throw validationError('request.output image cannot contain a duration')
  }
  return {
    kind,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationUs === undefined ? {} : { durationUs })
  }
}

export function validateConsent(value: unknown): GenerationConsent {
  const consent = exactObject(value, [
    'providerPermissionApproved', 'mediaUploadApproved', 'costApproved', 'approvedMaximumMinor', 'currency', 'confirmedAt'
  ], 'request.consent')
  return {
    providerPermissionApproved: booleanValue(consent.providerPermissionApproved, 'request.consent.providerPermissionApproved'),
    mediaUploadApproved: booleanValue(consent.mediaUploadApproved, 'request.consent.mediaUploadApproved'),
    costApproved: booleanValue(consent.costApproved, 'request.consent.costApproved'),
    approvedMaximumMinor: nonNegativeInteger(consent.approvedMaximumMinor, 'request.consent.approvedMaximumMinor'),
    currency: currency(consent.currency, 'request.consent.currency'),
    confirmedAt: timestamp(consent.confirmedAt, 'request.consent.confirmedAt')
  }
}

export function validateAuthorization(
  value: unknown,
  owner: GenerationOwner,
  assessment: Extract<GenerationAssessment, { outcome: 'ready' }>,
  now: Date
): GenerationAuthorizationReceipt {
  const receipt = validateAuthorizationShape(value)
  const requestDigest = generationRequestDigest(assessment.request)
  const requiredUploads = assessment.model.permissions.mediaUpload === 'explicit'
    ? assessment.request.references.map(({ assetId }) => assetId)
    : []
  if (!ownerMatches(receipt.owner, owner)) throw validationError('Generation authorization owner does not match request owner')
  if (receipt.requestDigest !== requestDigest) throw validationError('Generation authorization request digest does not match')
  if (receipt.quoteId !== assessment.quote.quoteId) throw validationError('Generation authorization quote does not match')
  if (receipt.providerId !== assessment.provider.id || receipt.modelId !== assessment.model.id) {
    throw validationError('Generation authorization provider/model does not match')
  }
  if (
    receipt.currency !== assessment.quote.currency ||
    receipt.approvedMaximumMinor !== assessment.quote.maximumMinor ||
    receipt.approvedMaximumMinor > assessment.request.consent.approvedMaximumMinor
  ) {
    throw validationError('Generation authorization is not bound to the exact approved quote')
  }
  if (
    receipt.permissionIds.length !== assessment.model.permissions.permissionIds.length ||
    receipt.permissionIds.some((permission, index) => permission !== assessment.model.permissions.permissionIds[index])
  ) {
    throw validationError('Generation authorization does not cover the exact ordered provider permissions')
  }
  if (
    receipt.uploadAssetIds.length !== requiredUploads.length ||
    receipt.uploadAssetIds.some((assetId, index) => assetId !== requiredUploads[index])
  ) {
    throw validationError('Generation authorization does not cover the exact ordered media uploads')
  }
  if (Date.parse(receipt.issuedAt) < Date.parse(assessment.request.consent.confirmedAt)) {
    throw validationError('Generation authorization predates the confirmed consent intent')
  }
  if (Date.parse(receipt.issuedAt) > now.getTime()) throw validationError('Generation authorization was issued in the future')
  if (Date.parse(receipt.expiresAt) <= now.getTime()) throw validationError('Generation authorization has expired')
  return receipt
}

export function validateAuthorizationShape(value: unknown): GenerationAuthorizationReceipt {
  const receipt = exactObject(value, [
    'schemaVersion', 'authorizationId', 'owner', 'requestDigest', 'quoteId', 'providerId', 'modelId',
    'permissionIds', 'uploadAssetIds', 'currency', 'approvedMaximumMinor', 'issuedAt', 'expiresAt'
  ], 'generation authorization')
  if (receipt.schemaVersion !== 1) throw validationError('Generation authorization schemaVersion must be 1')
  const issuedAt = timestamp(receipt.issuedAt, 'generation authorization.issuedAt')
  const expiresAt = timestamp(receipt.expiresAt, 'generation authorization.expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw validationError('Generation authorization must expire after issuance')
  return {
    schemaVersion: 1,
    authorizationId: opaqueId(receipt.authorizationId, 'generation authorization.authorizationId'),
    owner: validateOwner(receipt.owner),
    requestDigest: sha256Value(receipt.requestDigest, 'generation authorization.requestDigest'),
    quoteId: opaqueId(receipt.quoteId, 'generation authorization.quoteId'),
    providerId: providerIdValue(receipt.providerId, 'generation authorization.providerId'),
    modelId: providerIdValue(receipt.modelId, 'generation authorization.modelId'),
    permissionIds: boundedArray(receipt.permissionIds, 'generation authorization.permissionIds', 16)
      .map((permission, index) => permissionId(permission, `generation authorization.permissionIds[${index}]`)),
    uploadAssetIds: boundedArray(receipt.uploadAssetIds, 'generation authorization.uploadAssetIds', GENERATION_LIMITS.references)
      .map((assetId, index) => safeId(assetId, `generation authorization.uploadAssetIds[${index}]`)),
    currency: currency(receipt.currency, 'generation authorization.currency'),
    approvedMaximumMinor: nonNegativeInteger(receipt.approvedMaximumMinor, 'generation authorization.approvedMaximumMinor'),
    issuedAt,
    expiresAt
  }
}

export function constraintProblem(model: GenerationModelDescriptor, request: GenerationRequest): string | undefined {
  if (!model.tasks.includes(request.task)) return 'The model does not support the requested generation task.'
  if (!model.outputKinds.includes(request.output.kind)) return 'The model does not support the requested output kind.'
  if (request.prompt.length > model.limits.maxPromptCharacters) return 'The prompt exceeds the selected model limit.'
  if (request.references.length < model.limits.minReferences || request.references.length > model.limits.maxReferences) {
    return 'The reference count is outside the selected model limits.'
  }
  if (request.references.some(({ kind }) => !model.referenceKinds.includes(kind))) return 'A selected reference kind is unsupported.'
  if (request.variants > model.limits.maxVariants) return 'The variant count exceeds the selected model limit.'
  if (request.output.width && model.limits.maxWidth && request.output.width > model.limits.maxWidth) return 'Requested width exceeds the model limit.'
  if (request.output.height && model.limits.maxHeight && request.output.height > model.limits.maxHeight) return 'Requested height exceeds the model limit.'
  if (request.output.durationUs && model.limits.maxDurationUs && request.output.durationUs > model.limits.maxDurationUs) return 'Requested duration exceeds the model limit.'
  if (request.task === 'upscale' && request.references.length !== 1) return 'Upscale requires exactly one reference asset.'
  if (model.permissions.mediaUpload === 'never' && request.references.length > 0 && model.privacy.processing === 'provider') {
    return 'The selected remote model does not permit reference-media upload.'
  }
  return undefined
}

export function quoteFor(revision: string, providerId: string, model: GenerationModelDescriptor, request: GenerationRequest): GenerationCostQuote {
  const multiplier = Math.max(1, request.variants)
  const minimumMinor = model.cost.minimumMinor * multiplier
  const maximumMinor = model.cost.maximumMinor * multiplier
  if (!Number.isSafeInteger(minimumMinor) || !Number.isSafeInteger(maximumMinor)) throw validationError('Generation cost quote exceeds safe integer bounds')
  return {
    quoteId: `quote_${digest(`${revision}\n${providerId}\n${model.id}\n${request.idempotencyKey}\n${multiplier}`).slice(0, 24)}`,
    currency: model.cost.currency,
    minimumMinor,
    maximumMinor,
    estimateOnly: model.cost.estimateOnly
  }
}

export function validateOutputs(value: unknown, request: GenerationRequest, createdAt: string): GenerationOutput[] {
  const values = boundedArray(value, 'generation outputs', GENERATION_LIMITS.outputs)
  if (values.length === 0 || values.length > request.variants) throw validationError('Generation output count is invalid')
  const outputs = values.map((entry, index) => {
    const output = exactObject(entry, [
      'id', 'assetId', 'outputHandleId', 'displayName', 'kind', 'mimeType', 'byteSize',
      'completionIdentity', 'width', 'height', 'durationUs', 'sampleRate', 'channels', 'primary', 'createdAt'
    ], `generation outputs[${index}]`)
    const kind = oneOf(output.kind, ['image', 'video', 'audio'] as const, `generation outputs[${index}].kind`)
    const mimeType = boundedString(output.mimeType, `generation outputs[${index}].mimeType`, 3, 128).toLowerCase()
    if (!MIME_BY_KIND[kind].has(mimeType)) throw validationError(`Unsupported ${kind} output MIME type`)
    if (kind !== request.output.kind) throw validationError('Generation output kind does not match the approved request')
    const displayName = boundedString(output.displayName, `generation outputs[${index}].displayName`, 1, 256)
    if (
      displayName.includes('/') ||
      displayName.includes('\\') ||
      [...displayName].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw validationError('Generation output displayName must not contain a path')
    }
    const width = output.width === undefined ? undefined : positiveInteger(output.width, `generation outputs[${index}].width`, 65_536)
    const height = output.height === undefined ? undefined : positiveInteger(output.height, `generation outputs[${index}].height`, 65_536)
    const durationUs = output.durationUs === undefined
      ? undefined
      : positiveInteger(output.durationUs, `generation outputs[${index}].durationUs`, Number.MAX_SAFE_INTEGER)
    const sampleRate = output.sampleRate === undefined
      ? undefined
      : positiveInteger(output.sampleRate, `generation outputs[${index}].sampleRate`, 384_000)
    const channels = output.channels === undefined
      ? undefined
      : positiveInteger(output.channels, `generation outputs[${index}].channels`, 32)
    if ((kind === 'image' || kind === 'video') && (width === undefined || height === undefined)) {
      throw validationError(`Generation ${kind} outputs require verified dimensions`)
    }
    if (kind === 'audio' && (width !== undefined || height !== undefined)) {
      throw validationError('Generation audio outputs cannot contain visual dimensions')
    }
    if (kind === 'audio' && (sampleRate === undefined || channels === undefined)) {
      throw validationError('Generation audio outputs require verified sample rate and channel metadata')
    }
    if (kind !== 'audio' && (sampleRate !== undefined || channels !== undefined)) {
      throw validationError('Generation visual outputs cannot contain audio-only stream metadata')
    }
    if ((kind === 'video' || kind === 'audio') && durationUs === undefined) {
      throw validationError(`Generation ${kind} outputs require a verified duration`)
    }
    if (kind === 'image' && durationUs !== undefined) {
      throw validationError('Generation image outputs cannot contain a duration')
    }
    if (request.output.width !== undefined && width !== request.output.width) {
      throw validationError('Generation output width does not match the approved request')
    }
    if (request.output.height !== undefined && height !== request.output.height) {
      throw validationError('Generation output height does not match the approved request')
    }
    if (request.output.durationUs !== undefined && durationUs !== request.output.durationUs) {
      throw validationError('Generation output duration does not match the approved request')
    }
    return {
      id: opaqueId(output.id, `generation outputs[${index}].id`),
      assetId: safeId(output.assetId, `generation outputs[${index}].assetId`),
      outputHandleId: opaqueMediaId(output.outputHandleId, `generation outputs[${index}].outputHandleId`),
      displayName,
      kind,
      mimeType,
      ...(output.byteSize === undefined ? {} : { byteSize: nonNegativeInteger(output.byteSize, `generation outputs[${index}].byteSize`) }),
      completionIdentity: opaqueId(output.completionIdentity, `generation outputs[${index}].completionIdentity`),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationUs === undefined ? {} : { durationUs }),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
      primary: booleanValue(output.primary, `generation outputs[${index}].primary`),
      createdAt: output.createdAt === undefined ? createdAt : timestamp(output.createdAt, `generation outputs[${index}].createdAt`)
    }
  })
  if (outputs.filter(({ primary }) => primary).length !== 1) throw validationError('Generation outputs require exactly one primary variant')
  if (new Set(outputs.map(({ id }) => id)).size !== outputs.length) throw validationError('Generation output IDs must be unique')
  if (new Set(outputs.map(({ outputHandleId }) => outputHandleId)).size !== outputs.length) throw validationError('Generation output handles must be unique')
  return outputs
}

export function validateProgress(value: unknown): GenerationProgress {
  const progress = exactObject(value, ['completed', 'total', 'unit', 'message', 'updatedAt'], 'generation progress')
  const completed = nonNegativeInteger(progress.completed, 'generation progress.completed')
  const total = positiveInteger(progress.total, 'generation progress.total', Number.MAX_SAFE_INTEGER)
  if (completed > total) throw validationError('Generation progress completed cannot exceed total')
  const unit = boundedString(progress.unit, 'generation progress.unit', 1, 64)
  if (!/^[A-Za-z][A-Za-z0-9._ -]{0,63}$/u.test(unit)) {
    throw validationError('Generation progress unit must be a bounded display token')
  }
  return {
    completed,
    total,
    unit,
    ...(progress.message === undefined ? {} : {
      message: redactGenerationDiagnostic(
        boundedString(progress.message, 'generation progress.message', 1, 512)
      )
    }),
    updatedAt: timestamp(progress.updatedAt, 'generation progress.updatedAt')
  }
}

export function validateSnapshot(value: unknown): GenerationSnapshot {
  const snapshot = exactObject(value, ['schemaVersion', 'generation', 'records'], 'generation snapshot')
  if (snapshot.schemaVersion !== 1) throw validationError('generation snapshot schemaVersion must be 1')
  const generation = nonNegativeInteger(snapshot.generation, 'generation snapshot.generation')
  const recordValues = boundedArray(snapshot.records, 'generation snapshot.records', GENERATION_LIMITS.records)
  const records = recordValues.map((record, index) => validateStoredRecord(record, index))
  if (records.some((record) => record.generation > generation)) throw validationError('Generation record exceeds snapshot generation')
  return { schemaVersion: 1, generation, records }
}

export function validateStoredRecord(value: unknown, index: number): GenerationRecord {
  const record = exactObject(value, [
    'schemaVersion', 'id', 'generation', 'owner', 'request', 'requestDigest', 'quote', 'authorization', 'placeholder', 'state', 'attempt',
    'executionId', 'jobId', 'progress', 'outputs', 'selectedOutputId', 'error', 'createdAt', 'updatedAt'
  ], `generation snapshot.records[${index}]`)
  if (record.schemaVersion !== 1) throw validationError('Generation record schemaVersion must be 1')
  const owner = validateOwner(record.owner)
  const request = normalizeGenerationRequest(record.request)
  const requestDigest = boundedString(record.requestDigest, 'generation record.requestDigest', 64, 64)
  if (requestDigest !== generationRequestDigest(request)) throw validationError('Stored generation request digest is invalid')
  if (owner.projectId !== request.projectId) throw validationError('Stored generation owner/project mismatch')
  const quoteValue = exactObject(record.quote, ['quoteId', 'currency', 'minimumMinor', 'maximumMinor', 'estimateOnly'], 'generation record.quote')
  const quote: GenerationCostQuote = {
    quoteId: opaqueId(quoteValue.quoteId, 'generation record.quote.quoteId'),
    currency: currency(quoteValue.currency, 'generation record.quote.currency'),
    minimumMinor: nonNegativeInteger(quoteValue.minimumMinor, 'generation record.quote.minimumMinor'),
    maximumMinor: nonNegativeInteger(quoteValue.maximumMinor, 'generation record.quote.maximumMinor'),
    estimateOnly: booleanValue(quoteValue.estimateOnly, 'generation record.quote.estimateOnly')
  }
  const authorization = validateAuthorizationShape(record.authorization)
  if (
    !ownerMatches(authorization.owner, owner) ||
    authorization.requestDigest !== requestDigest ||
    authorization.quoteId !== quote.quoteId ||
    authorization.providerId !== request.providerId ||
    authorization.modelId !== request.modelId ||
    authorization.currency !== quote.currency ||
    authorization.approvedMaximumMinor < quote.maximumMinor
  ) {
    throw validationError('Stored generation authorization is not bound to its request and quote')
  }
  const placeholderValue = exactObject(record.placeholder, ['assetId', 'displayName', 'kind', 'state'], 'generation record.placeholder')
  const state = oneOf(record.state, ['placeholder', 'queued', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted'] as const, 'generation record.state')
  const outputs = record.outputs === undefined ? [] : validateStoredOutputs(record.outputs, request)
  return {
    schemaVersion: 1,
    id: opaqueId(record.id, 'generation record.id'),
    generation: nonNegativeInteger(record.generation, 'generation record.generation'),
    owner,
    request,
    requestDigest,
    quote,
    authorization,
    placeholder: {
      assetId: safeId(placeholderValue.assetId, 'generation record.placeholder.assetId'),
      displayName: boundedString(placeholderValue.displayName, 'generation record.placeholder.displayName', 1, 256),
      kind: oneOf(placeholderValue.kind, ['image', 'video', 'audio'] as const, 'generation record.placeholder.kind'),
      state: oneOf(placeholderValue.state, ['pending', 'resolved', 'failed', 'cancelled', 'interrupted'] as const, 'generation record.placeholder.state')
    },
    state,
    attempt: positiveInteger(record.attempt, 'generation record.attempt', Number.MAX_SAFE_INTEGER),
    executionId: opaqueId(record.executionId, 'generation record.executionId'),
    ...(record.jobId === undefined ? {} : { jobId: opaqueId(record.jobId, 'generation record.jobId') }),
    ...(record.progress === undefined ? {} : { progress: validateProgress(record.progress) }),
    outputs,
    ...(record.selectedOutputId === undefined ? {} : { selectedOutputId: opaqueId(record.selectedOutputId, 'generation record.selectedOutputId') }),
    ...(record.error === undefined ? {} : { error: validateStoredError(record.error) }),
    createdAt: timestamp(record.createdAt, 'generation record.createdAt'),
    updatedAt: timestamp(record.updatedAt, 'generation record.updatedAt')
  }
}

export function validateStoredOutputs(value: unknown, request: GenerationRequest): GenerationOutput[] {
  const entries = boundedArray(value, 'generation record.outputs', GENERATION_LIMITS.outputs)
  if (entries.length === 0) return []
  return validateOutputs(entries, request, new Date(0).toISOString())
}

export function validateStoredError(value: unknown): GenerationRecord['error'] {
  const error = exactObject(value, ['code', 'message', 'retryable'], 'generation record.error')
  return {
    code: safeCode(error.code),
    message: redactGenerationDiagnostic(error.message),
    retryable: booleanValue(error.retryable, 'generation record.error.retryable')
  }
}

export function validateOwner(value: unknown): GenerationOwner {
  const owner = exactObject(value, ['extensionId', 'extensionVersion', 'workspaceId', 'projectId'], 'generation owner')
  return {
    extensionId: boundedString(owner.extensionId, 'generation owner.extensionId', 3, 129),
    extensionVersion: boundedString(owner.extensionVersion, 'generation owner.extensionVersion', 1, 128),
    workspaceId: safeId(owner.workspaceId, 'generation owner.workspaceId'),
    projectId: safeId(owner.projectId, 'generation owner.projectId')
  }
}

export function validateFingerprint(value: unknown, path: string): { algorithm: 'sha256'; value: string } {
  const fingerprint = exactObject(value, ['algorithm', 'value'], path)
  if (fingerprint.algorithm !== 'sha256') throw validationError(`${path}.algorithm must be sha256`)
  const digestValue = boundedString(fingerprint.value, `${path}.value`, 64, 64)
  if (!/^[a-f0-9]{64}$/u.test(digestValue)) throw validationError(`${path}.value must be a lowercase SHA-256 digest`)
  return { algorithm: 'sha256', value: digestValue }
}

export function placeholderName(request: GenerationRequest): string {
  const base = request.task === 'upscale' ? 'Upscaled media' : `Generated ${request.output.kind}`
  return `${base} (${request.modelId})`.slice(0, 256)
}

export function executionId(recordId: string, attempt: number): string {
  return `execution_${digest(`${recordId}\n${attempt}`).slice(0, 24)}`
}

export function ownerMatches(owner: GenerationOwner, filter: Partial<GenerationOwner>): boolean {
  return Object.entries(filter).every(([key, value]) => owner[key as keyof GenerationOwner] === value)
}

export function providerIdValue(value: unknown, path: string): string {
  const text = boundedString(value, path, 1, 64)
  if (!PROVIDER_ID.test(text)) throw validationError(`${path} must be a provider-safe identifier`)
  return text
}

export function permissionId(value: unknown, path: string): string {
  const text = boundedString(value, path, 1, 256)
  if (!/^(?:network:(?:\*\.)?[a-z0-9.-]+|accounts\.(?:use|manage):[a-z0-9.-]+)$/u.test(text)) {
    throw validationError(`${path} is not a supported scoped permission`)
  }
  return text
}

export function safeId(value: unknown, path: string): string {
  const text = boundedString(value, path, 1, 256)
  if (!SAFE_LOCAL_ID.test(text)) throw validationError(`${path} must be a safe identifier`)
  return text
}

export function opaqueId(value: unknown, path: string): string {
  const text = boundedString(value, path, 8, 256)
  if (!OPAQUE_ID.test(text)) throw validationError(`${path} must be opaque`)
  return text
}

export function opaqueMediaId(value: unknown, path: string): string {
  const text = boundedString(value, path, 16, 512)
  if (!OPAQUE_MEDIA_ID.test(text)) throw validationError(`${path} must be an opaque media handle`)
  return text
}

export function currency(value: unknown, path: string): string {
  const text = boundedString(value, path, 3, 3)
  if (!CURRENCY.test(text)) throw validationError(`${path} must be an ISO-style uppercase currency code`)
  return text
}

export function sha256Value(value: unknown, path: string): string {
  const text = boundedString(value, path, 64, 64)
  if (!/^[a-f0-9]{64}$/u.test(text)) throw validationError(`${path} must be a lowercase SHA-256 digest`)
  return text
}

export function timestamp(value: unknown, path: string): string {
  const text = boundedString(value, path, 20, 64)
  if (!Number.isFinite(Date.parse(text))) throw validationError(`${path} must be an ISO timestamp`)
  return text
}

export function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw validationError(`${path} must be a non-negative safe integer`)
  return Number(value)
}

export function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw validationError(`${path} must be a positive bounded safe integer`)
  }
  return Number(value)
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`${path} must be a boolean`)
  return value
}

export function boundedString(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw validationError(`${path} must contain ${minimum}-${maximum} characters`)
  }
  return value
}

export function boundedArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw validationError(`${path} must be an array with at most ${maximum} entries`)
  return value
}

export function oneOf<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw validationError(`${path} is invalid`)
  return value as T[number]
}

export function uniqueEnumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  allowEmpty = false
): T[number][] {
  const items = boundedArray(value, path, values.length)
  if (!allowEmpty && items.length === 0) throw validationError(`${path} must not be empty`)
  const parsed = items.map((item, index) => oneOf(item, values, `${path}[${index}]`))
  if (new Set(parsed).size !== parsed.length) throw validationError(`${path} contains duplicate values`)
  return parsed
}

export function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError(`${path} must be an object`)
  const objectValue = value as Record<string, unknown>
  const unknown = Object.keys(objectValue).filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw validationError(`${path} contains unsupported fields: ${unknown.slice(0, 4).join(', ')}`)
  return objectValue
}

export function assertNoSecretFields(value: unknown, path: string): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:secret|token|password|api.?key|authorization|credentialvalue)/iu.test(key)) {
      throw validationError(`${path} contains a forbidden credential field`)
    }
    assertNoSecretFields(entry, `${path}.${key}`)
  }
}

export function assertNoCatalogLocators(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (
      /(?:https?|file):\/\//iu.test(value) ||
      /^(?:[A-Za-z]:[\\/]|\/)/u.test(value.trim()) ||
      CREDENTIAL_ASSIGNMENT.test(value)
    ) {
      throw validationError(`${path} contains a forbidden credential or raw location`)
    }
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCatalogLocators(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertNoCatalogLocators(entry, `${path}.${key}`)
  }
}

export function safeCode(value: unknown): string {
  const text = typeof value === 'string' ? value : 'generation_error'
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(text) ? text : 'generation_error'
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function validationError(message: string): Error {
  const error = new Error(message)
  error.name = 'GenerationValidationError'
  return error
}
