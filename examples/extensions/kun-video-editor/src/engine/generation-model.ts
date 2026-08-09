import { createHash } from 'node:crypto'
import type { GenerationExecutionRequest } from './generation-runtime.js'

export const GENERATION_LIMITS = Object.freeze({
  providers: 32,
  models: 256,
  promptCharacters: 8_000,
  negativePromptCharacters: 4_000,
  references: 8,
  variants: 8,
  records: 512,
  outputs: 8,
  diagnosticCharacters: 512
})

export type GenerationTask = 'image' | 'video' | 'audio' | 'upscale'
export type GenerationOutputKind = 'image' | 'video' | 'audio'
export type GenerationProviderKind = 'local' | 'byok' | 'remote'

export type GenerationModelDescriptor = {
  id: string
  displayName: string
  version: string
  tasks: GenerationTask[]
  outputKinds: GenerationOutputKind[]
  referenceKinds: GenerationOutputKind[]
  limits: {
    maxPromptCharacters: number
    minReferences: number
    maxReferences: number
    maxVariants: number
    maxWidth?: number
    maxHeight?: number
    maxDurationUs?: number
  }
  permissions: {
    permissionIds: string[]
    credential: 'none' | 'host-account'
    mediaUpload: 'never' | 'explicit'
  }
  privacy: {
    processing: 'device' | 'provider'
    promptRetention: 'none' | 'provider-policy'
    mediaRetention: 'none' | 'provider-policy'
  }
  cost: {
    currency: string
    minimumMinor: number
    maximumMinor: number
    estimateOnly: boolean
  }
}

export type GenerationProviderDescriptor = {
  id: string
  displayName: string
  version: string
  kind: GenerationProviderKind
  status: 'available' | 'unavailable'
  unavailableReason?: string
  models: GenerationModelDescriptor[]
}

export type GenerationCatalog = {
  schemaVersion: 1
  revision: string
  generatedAt: string
  providers: GenerationProviderDescriptor[]
}

/**
 * Runtime adapters keep authentication and endpoints inside their Host-owned
 * implementation. Neither descriptor nor request has a credential/URL field.
 */
export interface GenerationProviderAdapter {
  readonly provider: GenerationProviderDescriptor
  start(request: GenerationExecutionRequest, context: GenerationAdapterContext): Promise<unknown>
  status(jobId: string, context: GenerationAdapterContext): Promise<unknown>
  cancel(jobId: string, context: GenerationAdapterContext): Promise<unknown>
}

export type GenerationAdapterContext = {
  owner: GenerationOwner
  signal?: AbortSignal
}

export type GenerationReference = {
  assetId: string
  mediaHandleId: string
  kind: GenerationOutputKind
  sourceFingerprint?: { algorithm: 'sha256'; value: string }
}

export type GenerationConsent = {
  providerPermissionApproved: boolean
  mediaUploadApproved: boolean
  costApproved: boolean
  approvedMaximumMinor: number
  currency: string
  confirmedAt: string
}

export type GenerationRequest = {
  task: GenerationTask
  projectId: string
  projectRevision: number
  providerId: string
  modelId: string
  prompt: string
  negativePrompt?: string
  references: GenerationReference[]
  variants: number
  seed?: number
  output: {
    kind: GenerationOutputKind
    width?: number
    height?: number
    durationUs?: number
  }
  outputPolicy: 'resolve-placeholder' | 'add-variants'
  idempotencyKey: string
  consent: GenerationConsent
}

export type GenerationCostQuote = {
  quoteId: string
  currency: string
  minimumMinor: number
  maximumMinor: number
  estimateOnly: boolean
}

export type GenerationAssessment =
  | {
    outcome: 'ready'
    request: GenerationRequest
    provider: GenerationProviderDescriptor
    model: GenerationModelDescriptor
    quote: GenerationCostQuote
  }
  | {
    outcome: 'confirmation-required'
    request: GenerationRequest
    provider: GenerationProviderDescriptor
    model: GenerationModelDescriptor
    quote: GenerationCostQuote
    missing: Array<'provider-permission' | 'media-upload' | 'cost'>
  }
  | {
    outcome: 'unavailable'
    request?: GenerationRequest
    code: 'catalog-unavailable' | 'provider-unavailable' | 'model-unavailable' | 'unsupported-constraints'
    message: string
  }

export type GenerationOwner = {
  extensionId: string
  extensionVersion: string
  workspaceId: string
  projectId: string
}

/** Host-issued, one-operation authorization. UI consent booleans alone are not authority. */
export type GenerationAuthorizationReceipt = {
  schemaVersion: 1
  authorizationId: string
  owner: GenerationOwner
  requestDigest: string
  quoteId: string
  providerId: string
  modelId: string
  permissionIds: string[]
  uploadAssetIds: string[]
  currency: string
  approvedMaximumMinor: number
  issuedAt: string
  expiresAt: string
}

export type GenerationProgress = {
  completed: number
  total: number
  unit: string
  message?: string
  updatedAt: string
}

export type GenerationOutput = {
  id: string
  assetId: string
  outputHandleId: string
  displayName: string
  kind: GenerationOutputKind
  mimeType: string
  byteSize?: number
  completionIdentity: string
  width?: number
  height?: number
  durationUs?: number
  sampleRate?: number
  channels?: number
  primary: boolean
  createdAt: string
}

export type GenerationRecordState =
  | 'placeholder'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type GenerationRecord = {
  schemaVersion: 1
  id: string
  generation: number
  owner: GenerationOwner
  request: GenerationRequest
  requestDigest: string
  quote: GenerationCostQuote
  authorization: GenerationAuthorizationReceipt
  placeholder: {
    assetId: string
    displayName: string
    kind: GenerationOutputKind
    state: 'pending' | 'resolved' | 'failed' | 'cancelled' | 'interrupted'
  }
  state: GenerationRecordState
  attempt: number
  executionId: string
  jobId?: string
  progress?: GenerationProgress
  outputs: GenerationOutput[]
  selectedOutputId?: string
  error?: { code: string; message: string; retryable: boolean }
  createdAt: string
  updatedAt: string
}

export type GenerationSnapshot = {
  schemaVersion: 1
  generation: number
  records: GenerationRecord[]
}

export interface GenerationPersistence {
  load(): Promise<unknown | undefined>
  save(snapshot: GenerationSnapshot): Promise<void>
}

export class MemoryGenerationPersistence implements GenerationPersistence {
  snapshot?: GenerationSnapshot

  async load(): Promise<unknown | undefined> {
    return this.snapshot === undefined ? undefined : structuredClone(this.snapshot)
  }

  async save(snapshot: GenerationSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot)
  }
}

export type GenerationCreateResult = {
  record: GenerationRecord
  deduplicated: boolean
}
