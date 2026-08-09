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
import { isRecord, numericProjection, safeInteger } from './controller-project-support.js'
import { stableProjectionId } from './controller-package-support.js'

export function audioAnalysisCapabilitiesFrom(value: unknown): AudioAnalysisCapabilitiesProjection | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.probedAt !== 'string' || !Array.isArray(value.analyses)) {
    return undefined
  }
  const analyses = value.analyses.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      !['silence', 'beat-grid', 'sync-features'].includes(String(candidate.analysis)) ||
      typeof candidate.available !== 'boolean' ||
      candidate.local !== true ||
      candidate.networkUsed !== false
    ) return []
    return [{
      analysis: candidate.analysis as AudioAnalysisCapabilitiesProjection['analyses'][number]['analysis'],
      available: candidate.available,
      ...(typeof candidate.algorithm === 'string' ? { algorithm: candidate.algorithm.slice(0, 128) } : {}),
      ...(typeof candidate.algorithmVersion === 'string' ? { algorithmVersion: candidate.algorithmVersion.slice(0, 64) } : {}),
      ...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 128) } : {}),
      ...(typeof candidate.remediation === 'string' ? { remediation: candidate.remediation.slice(0, 1_024) } : {}),
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      local: true as const,
      networkUsed: false as const
    }]
  })
  if (analyses.length !== 3 || new Set(analyses.map(({ analysis }) => analysis)).size !== 3) return undefined
  return { schemaVersion: 1, probedAt: value.probedAt, analyses }
}

export function denoiseMetadataCapabilityFrom(value: unknown): DenoiseMetadataCapabilityProjection | undefined {
  if (
    !isRecord(value) ||
    !['ready', 'unavailable'].includes(String(value.outcome)) ||
    value.local !== true ||
    value.networkUsed !== false
  ) return undefined
  if (value.outcome === 'ready') {
    const descriptor = value.descriptor
    if (
      !isRecord(descriptor) ||
      !['adapterId', 'adapterVersion', 'algorithm', 'algorithmVersion']
        .every((key) => typeof descriptor[key] === 'string' && String(descriptor[key]).length > 0) ||
      (descriptor.modelId === undefined) !== (descriptor.modelVersion === undefined) ||
      (descriptor.modelId !== undefined && typeof descriptor.modelId !== 'string') ||
      (descriptor.modelVersion !== undefined && typeof descriptor.modelVersion !== 'string')
    ) return undefined
    return {
      outcome: 'ready',
      descriptor: {
        adapterId: String(descriptor.adapterId).slice(0, 256),
        adapterVersion: String(descriptor.adapterVersion).slice(0, 64),
        algorithm: String(descriptor.algorithm).slice(0, 256),
        algorithmVersion: String(descriptor.algorithmVersion).slice(0, 64),
        ...(typeof descriptor.modelId === 'string' ? {
          modelId: descriptor.modelId.slice(0, 256),
          modelVersion: String(descriptor.modelVersion).slice(0, 64)
        } : {})
      },
      local: true,
      networkUsed: false
    }
  }
  if (
    typeof value.code !== 'string' ||
    typeof value.remediation !== 'string' ||
    typeof value.retryable !== 'boolean'
  ) return undefined
  return {
    outcome: 'unavailable',
    code: value.code.slice(0, 128),
    remediation: value.remediation.slice(0, 1_024),
    retryable: value.retryable,
    local: true,
    networkUsed: false
  }
}

export function speakerAdaptersFrom(value: unknown): SpeakerAdapterProjection[] {
  if (!Array.isArray(value) || value.length > 16) return []
  const adapters = value.flatMap((candidate) => {
    if (
      !isRecord(candidate) || !isRecord(candidate.descriptor) ||
      !['ready', 'unavailable'].includes(String(candidate.outcome)) ||
      candidate.local !== true || candidate.networkUsed !== false
    ) return []
    const descriptor = candidate.descriptor
    if (
      typeof descriptor.id !== 'string' || descriptor.id.length < 1 || descriptor.id.length > 256 ||
      typeof descriptor.version !== 'string' || descriptor.version.length < 1 || descriptor.version.length > 64 ||
      !['local-model', 'import'].includes(String(descriptor.execution)) ||
      (descriptor.format !== undefined && descriptor.format !== 'kun-speaker-json-v1') ||
      (descriptor.modelId !== undefined && typeof descriptor.modelId !== 'string') ||
      (descriptor.modelVersion !== undefined && typeof descriptor.modelVersion !== 'string')
    ) return []
    return [{
      descriptor: {
        id: descriptor.id,
        version: descriptor.version,
        execution: descriptor.execution as SpeakerAdapterProjection['descriptor']['execution'],
        ...(descriptor.format === 'kun-speaker-json-v1' ? { format: 'kun-speaker-json-v1' as const } : {}),
        ...(typeof descriptor.modelId === 'string' ? { modelId: descriptor.modelId.slice(0, 256) } : {}),
        ...(typeof descriptor.modelVersion === 'string' ? { modelVersion: descriptor.modelVersion.slice(0, 64) } : {})
      },
      outcome: candidate.outcome as SpeakerAdapterProjection['outcome'],
      ...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 128) } : {}),
      ...(typeof candidate.remediation === 'string' ? { remediation: candidate.remediation.slice(0, 1_024) } : {}),
      local: true as const,
      networkUsed: false as const
    }]
  })
  if (adapters.length !== value.length || new Set(adapters.map(({ descriptor }) => descriptor.id)).size !== adapters.length) {
    return []
  }
  return adapters
}

export function speakerIdentitiesFrom(value: unknown): SpeakerIdentityProjection[] {
  if (!Array.isArray(value) || value.length > 256) return []
  const identities = value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' || candidate.id.length < 1 || candidate.id.length > 128 ||
      typeof candidate.label !== 'string' || candidate.label.length < 1 || candidate.label.length > 160 ||
      !Array.isArray(candidate.aliases) || candidate.aliases.length > 32 ||
      !candidate.aliases.every((alias) => typeof alias === 'string' && alias.length >= 1 && alias.length <= 160) ||
      !Array.isArray(candidate.sourceEvidenceIds) || candidate.sourceEvidenceIds.length > 256 ||
      !candidate.sourceEvidenceIds.every((id) => typeof id === 'string' && id.length >= 1 && id.length <= 128) ||
      typeof candidate.createdAt !== 'string' || typeof candidate.updatedAt !== 'string'
    ) return []
    return [{
      id: candidate.id,
      label: candidate.label,
      aliases: candidate.aliases as string[],
      sourceEvidenceIds: candidate.sourceEvidenceIds as string[],
      createdAt: candidate.createdAt.slice(0, 64),
      updatedAt: candidate.updatedAt.slice(0, 64)
    }]
  })
  if (identities.length !== value.length || new Set(identities.map(({ id }) => id)).size !== identities.length) return []
  return identities
}

export function speakerAttributionPlanFrom(value: unknown): SpeakerAttributionPlanProjection | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    typeof value.analysisId !== 'string' || value.analysisId.length < 1 || value.analysisId.length > 512 ||
    safeInteger(value.transcriptSegmentCount) === undefined ||
    safeInteger(value.captionCount) === undefined ||
    safeInteger(value.identifiedCount) === undefined ||
    safeInteger(value.uncertainCount) === undefined ||
    !Array.isArray(value.warnings) || value.warnings.length > 100 ||
    !value.warnings.every((warning) => typeof warning === 'string')
  ) return undefined
  const transcriptSegmentCount = safeInteger(value.transcriptSegmentCount)!
  const captionCount = safeInteger(value.captionCount)!
  const identifiedCount = safeInteger(value.identifiedCount)!
  const uncertainCount = safeInteger(value.uncertainCount)!
  if (identifiedCount + uncertainCount !== transcriptSegmentCount + captionCount) return undefined
  return {
    analysisId: value.analysisId,
    transcriptSegmentCount,
    captionCount,
    identifiedCount,
    uncertainCount,
    warnings: value.warnings.map((warning) => String(warning).slice(0, 512))
  }
}

export function visualProvisioningFrom(value: unknown): VisualProvisioningProjection | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || typeof value.optIn !== 'boolean' ||
    !['disabled', 'broker-unavailable', 'missing', 'downloading', 'unverified', 'inference-unavailable', 'ready', 'failed']
      .includes(String(value.state)) ||
    typeof value.code !== 'string' || typeof value.installSupported !== 'boolean' ||
    !isRecord(value.verification) ||
    value.local !== true || value.networkUsedForInference !== false ||
    value.rawPathsExposed !== false || value.urlsAccepted !== false ||
    typeof value.remediation !== 'string' || typeof value.checkedAt !== 'string'
  ) return undefined
  const verification = value.verification
  const verificationErrors = verification.errors
  if (
    typeof verification.brokerAttested !== 'boolean' ||
    typeof verification.downloadVerified !== 'boolean' ||
    typeof verification.sourceVerified !== 'boolean' ||
    typeof verification.installVerified !== 'boolean' ||
    typeof verification.signatureVerified !== 'boolean' ||
    typeof verification.manifestVerified !== 'boolean' ||
    !Array.isArray(verificationErrors) ||
    !verificationErrors.every((error: unknown) => typeof error === 'string')
  ) return undefined
  const model = isRecord(value.model) &&
    typeof value.model.adapterId === 'string' && typeof value.model.adapterVersion === 'string' &&
    typeof value.model.packageId === 'string' && typeof value.model.modelId === 'string' &&
    typeof value.model.modelVersion === 'string' && typeof value.model.manifestSha256 === 'string' &&
    safeInteger(value.model.embeddingDimensions) !== undefined
    ? {
        adapterId: value.model.adapterId.slice(0, 256),
        adapterVersion: value.model.adapterVersion.slice(0, 64),
        packageId: value.model.packageId.slice(0, 256),
        modelId: value.model.modelId.slice(0, 256),
        modelVersion: value.model.modelVersion.slice(0, 64),
        embeddingDimensions: safeInteger(value.model.embeddingDimensions)!,
        manifestSha256: value.model.manifestSha256.slice(0, 64)
      }
    : undefined
  return {
    schemaVersion: 1,
    optIn: value.optIn,
    state: value.state as VisualProvisioningProjection['state'],
    code: value.code.slice(0, 128),
    installSupported: value.installSupported,
    ...(['bundled', 'downloaded'].includes(String(value.packageSource))
      ? { packageSource: value.packageSource as 'bundled' | 'downloaded' }
      : {}),
    ...(model ? { model } : {}),
    verification: {
      brokerAttested: verification.brokerAttested,
      downloadVerified: verification.downloadVerified,
      sourceVerified: verification.sourceVerified,
      installVerified: verification.installVerified,
      signatureVerified: verification.signatureVerified,
      manifestVerified: verification.manifestVerified,
      errors: verificationErrors.slice(0, 32).map((error: unknown) => String(error).slice(0, 512))
    },
    local: true,
    networkUsedForInference: false,
    rawPathsExposed: false,
    urlsAccepted: false,
    remediation: value.remediation.slice(0, 1_024),
    checkedAt: value.checkedAt.slice(0, 64)
  }
}

export function visualMomentPageFrom(value: unknown, indexId: string): VisualMomentPageProjection | undefined {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.results) ||
    safeInteger(value.offset) === undefined || safeInteger(value.totalMatches) === undefined ||
    !['complete', 'partial'].includes(String(value.completeness)) ||
    !isRecord(value.ranking) || value.ranking.semantics !== 'uncalibrated-cosine' ||
    value.ranking.calibratedConfidence !== false || value.ranking.local !== true ||
    value.ranking.networkUsed !== false
  ) return undefined
  const ranking = value.ranking
  if (!['adapterId', 'adapterVersion', 'modelId', 'modelVersion', 'packageId', 'manifestSha256']
    .every((key) => typeof ranking[key] === 'string')) return undefined
  const results = value.results.slice(0, 100).flatMap((candidate) => {
    if (
      !isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.assetId !== 'string' ||
      typeof candidate.sampleId !== 'string' || typeof candidate.score !== 'number' ||
      !Number.isFinite(candidate.score) || candidate.score < -1 || candidate.score > 1 ||
      !isRecord(candidate.sourceRange) || candidate.sourceRange.assetId !== candidate.assetId ||
      safeInteger(candidate.sourceRange.startUs) === undefined || safeInteger(candidate.sourceRange.endUs) === undefined ||
      !isRecord(candidate.evidence) || safeInteger(candidate.evidence.representativeUs) === undefined
    ) return []
    const modelConfidence = typeof candidate.evidence.modelConfidence === 'number' &&
      Number.isFinite(candidate.evidence.modelConfidence) && candidate.evidence.modelConfidence >= 0 &&
      candidate.evidence.modelConfidence <= 1
      ? candidate.evidence.modelConfidence
      : undefined
    return [{
      id: candidate.id.slice(0, 512),
      assetId: candidate.assetId.slice(0, 128),
      sourceRange: {
        assetId: candidate.assetId.slice(0, 128),
        startUs: safeInteger(candidate.sourceRange.startUs)!,
        endUs: safeInteger(candidate.sourceRange.endUs)!
      },
      score: candidate.score,
      sampleId: candidate.sampleId.slice(0, 512),
      representativeUs: safeInteger(candidate.evidence.representativeUs)!,
      ...(modelConfidence === undefined ? {} : { modelConfidence })
    }]
  })
  if (results.length !== value.results.length) return undefined
  return {
    schemaVersion: 1,
    indexId: indexId.slice(0, 512),
    offset: safeInteger(value.offset)!,
    results,
    ...(safeInteger(value.nextOffset) === undefined ? {} : { nextOffset: safeInteger(value.nextOffset)! }),
    totalMatches: safeInteger(value.totalMatches)!,
    completeness: value.completeness as VisualMomentPageProjection['completeness'],
    ranking: {
      semantics: 'uncalibrated-cosine',
      calibratedConfidence: false,
      local: true,
      networkUsed: false,
      adapterId: String(ranking.adapterId).slice(0, 256),
      adapterVersion: String(ranking.adapterVersion).slice(0, 64),
      modelId: String(ranking.modelId).slice(0, 256),
      modelVersion: String(ranking.modelVersion).slice(0, 64),
      packageId: String(ranking.packageId).slice(0, 256),
      manifestSha256: String(ranking.manifestSha256).slice(0, 64)
    }
  }
}

export function audioAnalysisRecordFrom(value: unknown): AudioAnalysisRecordProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !['vad', 'beat-grid', 'denoise-metadata', 'audio-sync', 'speaker-diarization', 'visual-index'].includes(String(value.kind)) ||
    value.immutable !== true
  ) return undefined
  const snapTargets = audioSnapTargetsFrom(value.snapTargets)
  if (value.snapTargets !== undefined && snapTargets === undefined) return undefined
  const denoise = value.kind === 'denoise-metadata' ? denoiseMetadataRecordSummaryFrom(value) : undefined
  if (value.kind === 'denoise-metadata' && !denoise) return undefined
  return {
    schemaVersion: 1,
    id: value.id.slice(0, 512),
    kind: value.kind as AudioAnalysisRecordProjection['kind'],
    ...(typeof value.assetId === 'string' ? { assetId: value.assetId.slice(0, 128) } : {}),
    ...(typeof value.referenceAssetId === 'string' ? { referenceAssetId: value.referenceAssetId.slice(0, 128) } : {}),
    ...(typeof value.targetAssetId === 'string' ? { targetAssetId: value.targetAssetId.slice(0, 128) } : {}),
    ...(['complete', 'partial'].includes(String(value.completeness))
      ? { completeness: value.completeness as 'complete' | 'partial' }
      : {}),
    ...numericProjection(value, [
      'silenceCount', 'safeSuggestionCount', 'suggestionConfidenceThreshold', 'markerCount', 'tempoBpm',
      'turnCount', 'identifiedTurnCount', 'uncertainTurnCount',
      'indexedSampleCount', 'plannedSampleCount', 'omittedSampleCount', 'intervalUs', 'maxFrames',
      'seed', 'proposedTargetDeltaUs', 'confidence', 'confidenceThreshold', 'separation', 'threshold', 'minimumSeparation'
    ]),
    ...(denoise ?? {}),
    ...(snapTargets === undefined ? {} : { snapTargets }),
    ...(typeof value.adapterId === 'string' ? { adapterId: value.adapterId.slice(0, 256) } : {}),
    ...(typeof value.adapterVersion === 'string' ? { adapterVersion: value.adapterVersion.slice(0, 64) } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId.slice(0, 256) } : {}),
    ...(typeof value.modelVersion === 'string' ? { modelVersion: value.modelVersion.slice(0, 64) } : {}),
    ...(typeof value.packageId === 'string' ? { packageId: value.packageId.slice(0, 256) } : {}),
    ...(typeof value.manifestSha256 === 'string' ? { manifestSha256: value.manifestSha256.slice(0, 64) } : {}),
    ...(value.samplingStrategy === 'uniform-interval-v1' ? { samplingStrategy: 'uniform-interval-v1' as const } : {}),
    ...(['ready', 'uncertain'].includes(String(value.outcome))
      ? { outcome: value.outcome as 'ready' | 'uncertain' }
      : {}),
    ...(typeof value.refusalReason === 'string' ? { refusalReason: value.refusalReason.slice(0, 128) } : {}),
    ...(typeof value.currentGrant === 'boolean' ? { currentGrant: value.currentGrant } : {}),
    immutable: true
  }
}

export function denoiseMetadataRecordSummaryFrom(
  value: Record<string, unknown>
): Pick<AudioAnalysisRecordProjection, 'status' | 'noiseProfile' | 'recommendation' | 'metadataOnly'> | undefined {
  const profile = value.noiseProfile
  const recommendation = value.recommendation
  if (!isRecord(profile) || !isRecord(recommendation)) return undefined
  const levels = profile.levels
  const spectralBands = profile.spectralBands
  if (!isRecord(levels) || !Array.isArray(spectralBands)) return undefined
  if (
    !['ready', 'low-confidence'].includes(String(value.status)) ||
    value.metadataOnly !== true ||
    spectralBands.length > 32 ||
    recommendation.autoApplyAllowed !== false ||
    recommendation.audioMutation !== 'none' ||
    !['preview-suggested', 'review-required'].includes(String(recommendation.disposition))
  ) return undefined
  const requiredProfileNumbers = [
    profile.analyzedDurationUs,
    profile.sampleWindowCount,
    levels.noiseFloorDbfs,
    levels.averageRmsDbfs,
    levels.peakDbfs,
    levels.estimatedSnrDb,
    recommendation.reductionDb,
    recommendation.confidence
  ]
  if (requiredProfileNumbers.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    return undefined
  }
  if (
    !Number.isSafeInteger(profile.analyzedDurationUs) || Number(profile.analyzedDurationUs) < 1 ||
    !Number.isSafeInteger(profile.sampleWindowCount) || Number(profile.sampleWindowCount) < 1 ||
    Number(recommendation.reductionDb) < 0 || Number(recommendation.reductionDb) > 36 ||
    Number(recommendation.confidence) < 0 || Number(recommendation.confidence) > 1
  ) return undefined
  return {
    status: value.status as 'ready' | 'low-confidence',
    noiseProfile: {
      analyzedDurationUs: Number(profile.analyzedDurationUs),
      sampleWindowCount: Number(profile.sampleWindowCount),
      levels: {
        noiseFloorDbfs: Number(levels.noiseFloorDbfs),
        averageRmsDbfs: Number(levels.averageRmsDbfs),
        peakDbfs: Number(levels.peakDbfs),
        estimatedSnrDb: Number(levels.estimatedSnrDb)
      },
      spectralBandCount: spectralBands.length
    },
    recommendation: {
      reductionDb: Number(recommendation.reductionDb),
      confidence: Number(recommendation.confidence),
      disposition: recommendation.disposition as 'preview-suggested' | 'review-required',
      autoApplyAllowed: false,
      audioMutation: 'none'
    },
    metadataOnly: true
  }
}

export function audioSnapTargetsFrom(
  value: unknown
): AudioAnalysisRecordProjection['snapTargets'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const candidates = value.slice(0, 4_096)
  const targets = candidates.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      !stableProjectionId(candidate.id) ||
      safeInteger(candidate.frame) === undefined ||
      !['beat', 'downbeat'].includes(String(candidate.kind)) ||
      typeof candidate.confidence !== 'number' ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) return []
    return [{
      id: candidate.id,
      frame: safeInteger(candidate.frame)!,
      kind: candidate.kind as 'beat' | 'downbeat',
      confidence: candidate.confidence
    }]
  })
  return targets.length === candidates.length ? targets : undefined
}
