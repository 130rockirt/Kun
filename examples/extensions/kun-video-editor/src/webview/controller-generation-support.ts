import {
  ExtensionApiError,
  ResultPreviewOpenPayloadSchema,
  type AgentRunEvent,
  type ExtensionHostClient,
  type GeneratedArtifact,
  type JobSnapshot,
  type JsonObject,
  type JsonValue,
  type MediaMetadata,
  type MediaResourceLease
} from '@kun/extension-api'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  containsAsciiControlCharacters,
  replaceNullOrLineBreaks
} from '../text-safety.js'
import {
  INITIAL_EDITOR_STATE,
  VIEW_LIMITS,
  editorReducer,
  generatedArtifacts,
  toPersistedState,
  type CanvasFit,
  type CanvasPreset,
  type AssetProjection,
  type AudioAnalysisCapabilitiesProjection,
  type AudioAnalysisRecordProjection,
  type AudioSyncPreviewProjection,
  type DenoiseMetadataCapabilityProjection,
  type DerivedMediaKind,
  type DerivedMediaRecordProjection,
  type DerivedStorageUsageProjection,
  type EditorAction,
  type EditorNotice,
  type EditorState,
  type EditorWorkspace,
  type GenerationRecordProjection,
  type GenerationStateProjection,
  type MediaLibraryPageProjection,
  type MediaIntelligenceEvidenceProjection,
  type MediaIntelligenceProgressProjection,
  type PersistedEditorState,
  type PreviewComparisonProjection,
  type PreviewHistoryEntryProjection,
  type PreviewHistoryProjection,
  type PreviewSourceProjection,
  type ProjectChange,
  type ProjectPackageMissingMediaPolicy,
  type ProjectPackageTicket,
  type InterchangeLossManifestProjection,
  type OtioExportTicket,
  type OtioImportPreview,
  type OtioTimecodeMappingProjection,
  type MulticamGroupProjection,
  type ProjectProjection,
  type ProjectSummary,
  type RenderTicket,
  type SpeakerAdapterProjection,
  type SpeakerAttributionPlanProjection,
  type SpeakerIdentityProjection,
  type TimelineOperation,
  type VisualMomentPageProjection,
  type VisualProvisioningProjection
} from './model.js'
import type {
  GenerationCatalog,
  GenerationConsent,
  GenerationModelDescriptor,
  GenerationProviderDescriptor
} from '../engine/generation.js'
import type { GenerationPanelRequest } from './generation-panel.js'
import { formatMessage, messagesFor, type MessageKey } from './i18n.js'
import { renderCapabilityDetails } from './render-capability.js'
import type {
  MulticamCreateRequest,
  MulticamLayoutRequest,
  MulticamRenameRequest,
  MulticamSelectionRequest,
  MulticamSwitchRequest,
  MulticamSyncConfirmation
} from './multicam-panel.js'
import { isRecord, safeInteger } from './controller-project-support.js'
import { boundedIdentifier } from './controller-utility-support.js'

export function artifactUsesPlayer(artifact: GeneratedArtifact): boolean {
  if (artifact.mimeType === 'application/x-subrip' || artifact.mimeType === 'text/vtt') return false
  return artifact.mediaKind === 'video' || artifact.mediaKind === 'audio' || artifact.mediaKind === 'image'
}

export function classifyError(
  error: unknown,
  fallback: string,
  interactionGuidance = 'Complete the protected desktop interaction and retry.',
  preferFallback = false,
  fallbackKey?: MessageKey,
  fallbackValues?: Readonly<Record<string, string | number>>
): Omit<EditorNotice, 'id'> {
  const api = error instanceof ExtensionApiError ? error : undefined
  const code = api?.code ?? (isRecord(error) && typeof error.code === 'string' ? error.code : '')
  const rawMessage = error instanceof Error && error.message ? error.message.slice(0, 1_000) : ''
  const usesFallback = preferFallback || !rawMessage
  const message = usesFallback ? fallback : rawMessage
  const interactionRequired = /INTERACTION_REQUIRED|interaction.required/iu.test(code) || /interaction required/iu.test(rawMessage)
  return {
    severity: interactionRequired ? 'warning' : 'error',
    message: interactionRequired ? `${message} ${interactionGuidance}` : message,
    ...(usesFallback && fallbackKey ? {
      messageKey: fallbackKey,
      ...(fallbackValues ? { messageValues: fallbackValues } : {})
    } : {}),
    interactionRequired,
    retryable: api?.retryable ?? true
  }
}

export function generationCatalogFrom(value: unknown): GenerationCatalog | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    typeof value.revision !== 'string' || value.revision.length < 1 || value.revision.length > 128 ||
    typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Array.isArray(value.providers) || value.providers.length > 32 ||
    containsGenerationSecretOrLocator(value)
  ) return undefined
  const providers = value.providers
    .map(generationProviderFrom)
    .filter((provider): provider is GenerationProviderDescriptor => provider !== undefined)
  if (providers.length !== value.providers.length || new Set(providers.map(({ id }) => id)).size !== providers.length) {
    return undefined
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    generatedAt: value.generatedAt,
    providers
  }
}

export function generationProviderFrom(value: unknown): GenerationProviderDescriptor | undefined {
  if (
    !isRecord(value) || !generationProviderId(value.id) ||
    typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 128 ||
    typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 128 ||
    !['local', 'byok', 'remote'].includes(String(value.kind)) ||
    !['available', 'unavailable'].includes(String(value.status)) ||
    !Array.isArray(value.models) || value.models.length > 256
  ) return undefined
  const models = value.models
    .map(generationModelFrom)
    .filter((model): model is GenerationModelDescriptor => model !== undefined)
  if (models.length !== value.models.length || new Set(models.map(({ id }) => id)).size !== models.length) return undefined
  return {
    id: value.id,
    displayName: value.displayName,
    version: value.version,
    kind: value.kind as GenerationProviderDescriptor['kind'],
    status: value.status as GenerationProviderDescriptor['status'],
    ...(typeof value.unavailableReason === 'string'
      ? { unavailableReason: value.unavailableReason.slice(0, 512) }
      : {}),
    models
  }
}

export function generationModelFrom(value: unknown): GenerationModelDescriptor | undefined {
  if (
    !isRecord(value) || !generationProviderId(value.id) ||
    typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 128 ||
    typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 128 ||
    !generationEnumArray(value.tasks, ['image', 'video', 'audio', 'upscale'], 4) ||
    !generationEnumArray(value.outputKinds, ['image', 'video', 'audio'], 3) ||
    !generationEnumArray(value.referenceKinds, ['image', 'video', 'audio'], 3, 0) ||
    !isRecord(value.limits) || !isRecord(value.permissions) || !isRecord(value.privacy) || !isRecord(value.cost)
  ) return undefined
  const limits = value.limits
  const permissions = value.permissions
  const privacy = value.privacy
  const cost = value.cost
  const integerFields = ['maxPromptCharacters', 'minReferences', 'maxReferences', 'maxVariants'] as const
  if (
    integerFields.some((field) => safeInteger(limits[field]) === undefined) ||
    Number(limits.maxPromptCharacters) < 1 || Number(limits.maxPromptCharacters) > 8_000 ||
    Number(limits.minReferences) < 0 || Number(limits.maxReferences) > 8 ||
    Number(limits.minReferences) > Number(limits.maxReferences) ||
    Number(limits.maxVariants) < 1 || Number(limits.maxVariants) > 8 ||
    !Array.isArray(permissions.permissionIds) || permissions.permissionIds.length > 16 ||
    !permissions.permissionIds.every((entry) => typeof entry === 'string' && entry.length >= 1 && entry.length <= 256) ||
    !['none', 'host-account'].includes(String(permissions.credential)) ||
    !['never', 'explicit'].includes(String(permissions.mediaUpload)) ||
    !['device', 'provider'].includes(String(privacy.processing)) ||
    !['none', 'provider-policy'].includes(String(privacy.promptRetention)) ||
    !['none', 'provider-policy'].includes(String(privacy.mediaRetention)) ||
    typeof cost.currency !== 'string' || !/^[A-Z]{3}$/u.test(cost.currency) ||
    safeInteger(cost.minimumMinor) === undefined || safeInteger(cost.maximumMinor) === undefined ||
    Number(cost.minimumMinor) < 0 || Number(cost.maximumMinor) < Number(cost.minimumMinor) ||
    typeof cost.estimateOnly !== 'boolean'
  ) return undefined
  const optionalLimit = (field: 'maxWidth' | 'maxHeight' | 'maxDurationUs'): number | undefined => {
    if (limits[field] === undefined) return undefined
    const parsed = safeInteger(limits[field])
    return parsed !== undefined && parsed >= 1 ? parsed : Number.NaN
  }
  const maxWidth = optionalLimit('maxWidth')
  const maxHeight = optionalLimit('maxHeight')
  const maxDurationUs = optionalLimit('maxDurationUs')
  if ([maxWidth, maxHeight, maxDurationUs].some((entry) => Number.isNaN(entry))) return undefined
  return {
    id: value.id,
    displayName: value.displayName,
    version: value.version,
    tasks: value.tasks as GenerationModelDescriptor['tasks'],
    outputKinds: value.outputKinds as GenerationModelDescriptor['outputKinds'],
    referenceKinds: value.referenceKinds as GenerationModelDescriptor['referenceKinds'],
    limits: {
      maxPromptCharacters: Number(limits.maxPromptCharacters),
      minReferences: Number(limits.minReferences),
      maxReferences: Number(limits.maxReferences),
      maxVariants: Number(limits.maxVariants),
      ...(maxWidth === undefined ? {} : { maxWidth }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
      ...(maxDurationUs === undefined ? {} : { maxDurationUs })
    },
    permissions: {
      permissionIds: permissions.permissionIds as string[],
      credential: permissions.credential as GenerationModelDescriptor['permissions']['credential'],
      mediaUpload: permissions.mediaUpload as GenerationModelDescriptor['permissions']['mediaUpload']
    },
    privacy: {
      processing: privacy.processing as GenerationModelDescriptor['privacy']['processing'],
      promptRetention: privacy.promptRetention as GenerationModelDescriptor['privacy']['promptRetention'],
      mediaRetention: privacy.mediaRetention as GenerationModelDescriptor['privacy']['mediaRetention']
    },
    cost: {
      currency: cost.currency,
      minimumMinor: Number(cost.minimumMinor),
      maximumMinor: Number(cost.maximumMinor),
      estimateOnly: cost.estimateOnly
    }
  }
}

export function generationRecordFrom(value: unknown): GenerationRecordProjection | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || !generationOpaqueId(value.id) ||
    safeInteger(value.generation) === undefined || !boundedIdentifier(value.projectId) ||
    safeInteger(value.projectRevision) === undefined || !generationProviderId(value.providerId) ||
    !generationProviderId(value.modelId) || !['image', 'video', 'audio', 'upscale'].includes(String(value.task)) ||
    typeof value.promptDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.promptDigest) ||
    !Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 8 ||
    !value.referenceAssetIds.every(boundedIdentifier) || safeInteger(value.variantsRequested) === undefined ||
    !isRecord(value.quote) || !isRecord(value.placeholder) ||
    !['placeholder', 'queued', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted'].includes(String(value.state)) ||
    safeInteger(value.attempt) === undefined || !Array.isArray(value.outputs) || value.outputs.length > 8 ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' ||
    containsGenerationSecretOrLocator(value)
  ) return undefined
  const quote = value.quote
  const placeholder = value.placeholder
  if (
    !generationOpaqueId(quote.quoteId) || typeof quote.currency !== 'string' || !/^[A-Z]{3}$/u.test(quote.currency) ||
    safeInteger(quote.minimumMinor) === undefined || safeInteger(quote.maximumMinor) === undefined ||
    typeof quote.estimateOnly !== 'boolean' || !boundedIdentifier(placeholder.assetId) ||
    typeof placeholder.displayName !== 'string' || placeholder.displayName.length < 1 || placeholder.displayName.length > 256 ||
    !['image', 'video', 'audio'].includes(String(placeholder.kind)) ||
    !['pending', 'resolved', 'failed', 'cancelled', 'interrupted'].includes(String(placeholder.state))
  ) return undefined
  const outputs = value.outputs.flatMap((entry) => {
    if (
      !isRecord(entry) || !generationOpaqueId(entry.id) || !boundedIdentifier(entry.assetId) ||
      typeof entry.displayName !== 'string' || entry.displayName.length < 1 || entry.displayName.length > 256 ||
      !['image', 'video', 'audio'].includes(String(entry.kind)) ||
      typeof entry.mimeType !== 'string' || entry.mimeType.length < 3 || entry.mimeType.length > 128 ||
      typeof entry.primary !== 'boolean' || typeof entry.createdAt !== 'string'
    ) return []
    const numericFields = ['byteSize', 'width', 'height', 'durationUs', 'sampleRate', 'channels'] as const
    if (numericFields.some((field) => entry[field] !== undefined && safeInteger(entry[field]) === undefined)) return []
    const kind = entry.kind as GenerationRecordProjection['outputs'][number]['kind']
    const width = safeInteger(entry.width)
    const height = safeInteger(entry.height)
    const durationUs = safeInteger(entry.durationUs)
    const sampleRate = safeInteger(entry.sampleRate)
    const channels = safeInteger(entry.channels)
    if ((kind === 'image' || kind === 'video') && (width === undefined || height === undefined)) return []
    if ((kind === 'video' || kind === 'audio') && durationUs === undefined) return []
    if (kind === 'audio' && (sampleRate === undefined || channels === undefined)) return []
    if (kind !== 'audio' && (sampleRate !== undefined || channels !== undefined)) return []
    return [{
      id: entry.id,
      assetId: entry.assetId,
      displayName: entry.displayName,
      kind,
      mimeType: entry.mimeType,
      ...(safeInteger(entry.byteSize) === undefined ? {} : { byteSize: Number(entry.byteSize) }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationUs === undefined ? {} : { durationUs }),
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(channels === undefined ? {} : { channels }),
      primary: entry.primary,
      createdAt: entry.createdAt.slice(0, 64)
    }]
  })
  if (outputs.length !== value.outputs.length) return undefined
  const progress = value.progress === undefined ? undefined : isRecord(value.progress) &&
    safeInteger(value.progress.completed) !== undefined && safeInteger(value.progress.total) !== undefined &&
    typeof value.progress.unit === 'string'
    ? {
        completed: Number(value.progress.completed),
        total: Number(value.progress.total),
        unit: value.progress.unit.slice(0, 64),
        ...(typeof value.progress.message === 'string' ? { message: value.progress.message.slice(0, 512) } : {})
      }
    : undefined
  if (value.progress !== undefined && !progress) return undefined
  const error = value.error === undefined ? undefined : isRecord(value.error) &&
    typeof value.error.code === 'string' && typeof value.error.message === 'string' && typeof value.error.retryable === 'boolean'
    ? { code: value.error.code.slice(0, 64), message: value.error.message.slice(0, 512), retryable: value.error.retryable }
    : undefined
  if (value.error !== undefined && !error) return undefined
  return {
    schemaVersion: 1,
    id: value.id,
    generation: Number(value.generation),
    projectId: value.projectId,
    projectRevision: Number(value.projectRevision),
    providerId: value.providerId,
    modelId: value.modelId,
    task: value.task as GenerationRecordProjection['task'],
    promptDigest: value.promptDigest,
    referenceAssetIds: value.referenceAssetIds as string[],
    variantsRequested: Number(value.variantsRequested),
    quote: {
      quoteId: quote.quoteId,
      currency: quote.currency,
      minimumMinor: Number(quote.minimumMinor),
      maximumMinor: Number(quote.maximumMinor),
      estimateOnly: quote.estimateOnly
    },
    placeholder: {
      assetId: placeholder.assetId,
      displayName: placeholder.displayName,
      kind: placeholder.kind as GenerationRecordProjection['placeholder']['kind'],
      state: placeholder.state as GenerationRecordProjection['placeholder']['state']
    },
    state: value.state as GenerationRecordProjection['state'],
    attempt: Number(value.attempt),
    ...(progress ? { progress } : {}),
    outputs,
    ...(error ? { error } : {}),
    createdAt: value.createdAt.slice(0, 64),
    updatedAt: value.updatedAt.slice(0, 64)
  }
}

export function generationEnumArray(
  value: unknown,
  allowed: readonly string[],
  maximum: number,
  minimum = 1
): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every((entry) => typeof entry === 'string' && allowed.includes(entry)) &&
    new Set(value).size === value.length
}

export function generationProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/u.test(value)
}

export function generationOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9._~-]+$/u.test(value)
}

export function containsGenerationSecretOrLocator(value: unknown, key = ''): boolean {
  if (/(?:secret|password|api.?key|access.?token|authorization|credentialvalue|endpoint|outputhandle|mediahandle|completionidentity|prompt(?:excerpt)?$)/iu.test(key)) {
    return true
  }
  if (typeof value === 'string') {
    return /https?:\/\//iu.test(value) || /(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private|Volumes)\/)/u.test(value)
  }
  if (Array.isArray(value)) return value.some((entry) => containsGenerationSecretOrLocator(entry, key))
  if (isRecord(value)) return Object.entries(value).some(([childKey, entry]) => containsGenerationSecretOrLocator(entry, childKey))
  return false
}
