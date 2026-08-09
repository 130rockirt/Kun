import { createHash } from 'node:crypto'
import { MAX_MEDIA_OTIO_TEXT_BYTES } from '@kun/extension-api'
import type {
  ExtensionContext,
  ExtensionErrorData,
  GeneratedArtifact,
  JsonObject,
  JsonValue,
  JobSnapshot,
  MediaCapabilities,
  MediaMetadata,
  MediaProbeResult,
  ToolInvocationContext,
  ToolResult
} from '@kun/extension-api'
import { replaceAsciiControlCharacters } from '../text-safety.js'
import {
  ProjectService,
  TimelineOperationSchema,
  VideoEngineError,
  appendPreviewHistory,
  applySpeakerAttributionPlan,
  applyTimelineOperations,
  applyTimelineScript,
  beatSnapTargets,
  boundedEffectCatalog,
  buildVideoSelectionAttachment,
  buildEditableCaptions,
  buildSpeakerAttributionPlan,
  comparePreviewHistory,
  combineAudioSourceFingerprints,
  compileMulticamProgramIr,
  compileMulticamProgramProject,
  compileRenderIr,
  createMediaFolder,
  defaultFfmpegCapabilities,
  deleteMediaFolder,
  emptyPreviewHistory,
  framesToMicroseconds,
  generateRenderPlan,
  generateTimelineMarkdown,
  flattenNestedRenderIr,
  importTranscript,
  inspectMulticamProgram,
  inspectComposedTimeline,
  inspectRawMedia,
  mediaLibraryPage,
  microsecondsToFrames,
  negotiateRenderIr,
  negotiateAdvancedEffects,
  negotiateAdvancedExport,
  organizeMediaAssets,
  planAudioSynchronization,
  exportProjectToOtio,
  importProjectFromOtio,
  serializeOtioInterchange,
  PROJECT_PACKAGE_LIMITS,
  parseTimelineScriptHeader,
  planBatchMediaImport,
  planDecomposeNestedSequence,
  planReplaceTimelineItemFromPreview,
  projectDurationFrames,
  readCompactProjectWindow,
  readMediaIntelligenceEvidence,
  resolveProjectContext,
  resolveInteractivePlayback,
  renderIrDigest,
  selectPreviewHistory,
  sequenceDurationFrames,
  updateMediaFolder,
  validateHistory,
  type AssetTimeRange,
  type AudioSyncAnalysis,
  type DiarizationRecord,
  type ImportedDiarizationTurn,
  type AdvancedEffectExecutionPlan,
  type AdvancedExportPlan,
  type AdvancedExportSettings,
  type CaptionBuildOptions,
  type FfmpegRenderStep,
  type MediaAsset,
  type MulticamGroup,
  type MutationReceipt,
  type InterchangeLossManifest,
  type PreviewHistory,
  type PreviewHistoryEntry,
  type PreviewSource,
  type ProjectSelectionPatch,
  type ProofArtifactBinding,
  type RenderBackendCapabilities,
  type RenderKind,
  type RevisionAuthor,
  type SpeakerIdentity,
  type TextRenderStep,
  type TimelineItem,
  type TimelineOperation,
  type Transcript,
  type VideoProject
} from '../engine/index.js'
import {
  planMulticamEditorAction,
  type MulticamEditorAction
} from './multicam-control.js'
import { VIDEO_TOOL_DECLARATIONS } from './tool-contracts.js'
import { DerivedMediaService } from './derived-media-service.js'
import {
  GenerationControlPlane,
  type GenerationReferenceResolver
} from './generation-control-plane.js'
import {
  GenerationService,
  type GenerationExecutionBroker,
  type GenerationMaterialization
} from './generation-service.js'
import { KunLocalAudioAnalysisBroker } from './kun-audio-analysis-broker.js'
import {
  MediaIntelligenceService,
  type AnalysisOutcome,
  type IntelligenceRecord
} from './media-intelligence-service.js'
import {
  observedAdvancedFfmpegCapabilities,
  observedRenderBackendCapabilities,
  professionalExportCapabilityProjection
} from './professional-export.js'
import {
  prepareProjectPackageArchiveExport,
  startProjectPackageArchiveExport
} from './project-package-export-service.js'
import {
  OTIO_OUTPUT_MIME_TYPE,
  prepareOtioInterchangeExport,
  startOtioInterchangeExport
} from './otio-interchange-service.js'
import {
  ACTIVE_PROJECT_KEY, INLINE_OTIO_PREVIEW_BYTES, INTERCHANGE_MAPPING_PREVIEW_LIMIT,
  MAX_ASSETS, MAX_CAPTIONS, MAX_ITEMS, MAX_LINK_GROUPS, MAX_MEDIA_FOLDERS,
  MAX_MULTICAM_GROUPS, MAX_PROJECTS, MAX_SCRIPT_BYTES, MAX_SEQUENCES,
  MAX_TRACKS, MAX_TRANSCRIPTS, MAX_TRANSCRIPT_SEGMENTS, OTIO_EXPORT_RECORD_PREFIX,
  PACKAGE_PREFLIGHT_ASSET_PREVIEW_LIMIT, PACKAGE_PREFLIGHT_DEDUPE_PREVIEW_LIMIT,
  PREVIEW_HISTORY_PREFIX, PROJECT_PACKAGE_RECORD_PREFIX, RENDER_RECORD_PREFIX,
  RENDER_TRACKING_CANCELLATION_WAIT_MS, ExtensionApiError, ToolInputError,
  type OtioExportRecord, type ProjectPackageExportRecord,
  type RenderCapabilityAssessment, type RenderRecord, type ToolInput
} from './video-tools-model.js'
import {
  boundedArray,
  boundedString,
  enumValue,
  nonNegativeInteger,
  stableId
} from './video-tools-input-support.js'
import { isSha256Digest } from './video-tools-render-support.js'
export function interchangeMappingPreview(
  mappings: ReturnType<typeof exportProjectToOtio>['timecodeMappings']
): { items: ReturnType<typeof exportProjectToOtio>['timecodeMappings']; truncated: number } {
  return {
    items: mappings.slice(0, INTERCHANGE_MAPPING_PREVIEW_LIMIT),
    truncated: Math.max(0, mappings.length - INTERCHANGE_MAPPING_PREVIEW_LIMIT)
  }
}

export function interchangeProjectSummary(project: VideoProject): JsonObject {
  return {
    id: project.id,
    name: project.name,
    schemaVersion: project.schemaVersion,
    revision: project.currentRevision,
    activeSequenceId: project.activeSequenceId,
    fps: project.fps,
    canvas: project.canvas,
    counts: {
      assets: project.assets.length,
      sequences: project.sequences.length,
      tracks: project.sequences.reduce((total, sequence) => total + sequence.tracks.length, 0),
      items: project.sequences.reduce((total, sequence) => total + sequence.items.length, 0),
      captions: project.sequences.reduce((total, sequence) => total + sequence.captions.length, 0),
      transcripts: project.transcripts.length
    }
  }
}

export function packageAssetIds(project: VideoProject, value: unknown): Set<string> {
  if (value === undefined) return new Set(project.assets.map(({ id }) => id))
  const values = boundedArray(value, 'assetIds', 0, PROJECT_PACKAGE_LIMITS.mediaAssets)
    .map((entry, index) => stableId(entry, `assetIds[${index}]`))
  if (new Set(values).size !== values.length) {
    throw new ToolInputError('assetIds must not contain duplicate stable identities.')
  }
  const available = new Set(project.assets.map(({ id }) => id))
  const unknown = values.find((assetId) => !available.has(assetId))
  if (unknown) throw new ToolInputError(`assetIds contains unknown asset ${unknown}.`)
  return new Set(values)
}

export function packageMissingPolicy(value: unknown): 'fail' | 'omit' {
  if (value === undefined) return 'fail'
  const selected = enumValue(
    value,
    ['fail', 'omit', 'record-incomplete'] as const,
    'missingMediaPolicy'
  )
  return selected === 'record-incomplete' ? 'omit' : selected
}

export function safeProjectPackageName(value: string): string {
  const leaf = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'kun-video-project'
  const safe = leaf
    .replace(/[^A-Za-z0-9._~-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120)
  return safe || 'kun-video-project'
}

export function safeInterchangeName(value: string): string {
  const leaf = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'kun-video-project'
  const safe = leaf
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._~-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
  return safe || 'kun-video-project'
}

export function safeInterchangeDisplayName(value: string): string {
  const leaf = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'timeline.otio'
  return replaceAsciiControlCharacters(leaf, '').slice(0, 256) || 'timeline.otio'
}

export function suggestedImportProjectId(sourceProjectId: string, existing: ReadonlySet<string>): string {
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const label = suffix === 1 ? '-import' : `-import-${suffix}`
    const candidate = `${sourceProjectId.slice(0, 128 - label.length)}${label}`
    if (!existing.has(candidate)) return candidate
  }
  throw new ToolInputError('No bounded project identity is available for this OTIO import.')
}

export function sha256Digest(value: unknown, name: string): string {
  const digest = boundedString(value, name, 64, 64)
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new ToolInputError(`${name} must be a SHA-256 digest.`)
  return digest
}

export function projectPackageKey(jobId: string): string {
  return `${PROJECT_PACKAGE_RECORD_PREFIX}${jobId}`
}

export function otioExportKey(jobId: string): string {
  return `${OTIO_EXPORT_RECORD_PREFIX}${jobId}`
}

export function storedOtioExportRecord(
  value: JsonValue | undefined,
  expectedJobId: string
): OtioExportRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const record = value as Record<string, JsonValue | undefined>
    if (record.schemaVersion !== 1 || record.adapterId !== 'kun.otio-json' ||
      record.adapterVersion !== '1.0.0') return undefined
    const jobId = boundedString(record.jobId, 'stored OTIO jobId', 8, 512)
    if (jobId !== expectedJobId || !isSha256Digest(record.documentDigest) ||
      !isSha256Digest(record.projectDigest)) return undefined
    const createdAt = boundedString(record.createdAt, 'stored OTIO createdAt', 1, 64)
    if (!Number.isFinite(Date.parse(createdAt))) return undefined
    const lossManifest = storedInterchangeLossManifest(record.lossManifest)
    if (!lossManifest) return undefined
    const documentBytes = nonNegativeInteger(record.documentBytes, 'stored OTIO documentBytes')
    if (documentBytes < 1 || documentBytes > MAX_MEDIA_OTIO_TEXT_BYTES) return undefined
    return {
      schemaVersion: 1,
      jobId,
      projectId: stableId(record.projectId, 'stored OTIO projectId'),
      sequenceId: stableId(record.sequenceId, 'stored OTIO sequenceId'),
      pinnedRevision: nonNegativeInteger(record.pinnedRevision, 'stored OTIO pinnedRevision'),
      adapterId: 'kun.otio-json',
      adapterVersion: '1.0.0',
      documentDigest: record.documentDigest,
      projectDigest: record.projectDigest,
      documentBytes,
      lossManifest,
      createdAt
    }
  } catch {
    return undefined
  }
}

export function storedInterchangeLossManifest(value: unknown): InterchangeLossManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const manifest = value as Record<string, unknown>
  if (
    manifest.adapterId !== 'kun.otio-json' || manifest.adapterVersion !== '1.0.0' ||
    typeof manifest.portableLossless !== 'boolean' ||
    typeof manifest.kunRoundTripLossless !== 'boolean' ||
    !Number.isSafeInteger(manifest.truncated) || Number(manifest.truncated) < 0 ||
    !Array.isArray(manifest.entries) || manifest.entries.length > 128
  ) return undefined
  const entries = manifest.entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const candidate = entry as Record<string, unknown>
    if (
      typeof candidate.code !== 'string' || candidate.code.length < 1 || candidate.code.length > 128 ||
      (candidate.severity !== 'info' && candidate.severity !== 'warning') ||
      typeof candidate.feature !== 'string' || candidate.feature.length < 1 || candidate.feature.length > 128 ||
      typeof candidate.nodeId !== 'string' || candidate.nodeId.length < 1 || candidate.nodeId.length > 128 ||
      (candidate.preservation !== 'otio-standard' && candidate.preservation !== 'kun-metadata') ||
      typeof candidate.message !== 'string' || candidate.message.length < 1 || candidate.message.length > 1_024
    ) return []
    return [{
      code: candidate.code,
      severity: candidate.severity as 'info' | 'warning',
      feature: candidate.feature,
      nodeId: candidate.nodeId,
      preservation: candidate.preservation as 'otio-standard' | 'kun-metadata',
      message: candidate.message
    }]
  })
  if (entries.length !== manifest.entries.length) return undefined
  return {
    adapterId: 'kun.otio-json',
    adapterVersion: '1.0.0',
    portableLossless: manifest.portableLossless,
    kunRoundTripLossless: manifest.kunRoundTripLossless,
    entries,
    truncated: Number(manifest.truncated)
  }
}

export function otioExportJobProjection(
  snapshot: JobSnapshot,
  record: OtioExportRecord,
  currentRevision: number | undefined
): JsonObject {
  return {
    jobId: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    cursor: snapshot.latestCursor,
    projectId: record.projectId,
    sequenceId: record.sequenceId,
    pinnedRevision: record.pinnedRevision,
    currentRevision: currentRevision ?? null,
    stale: currentRevision !== undefined && currentRevision !== record.pinnedRevision,
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    documentDigest: record.documentDigest,
    projectDigest: record.projectDigest,
    documentBytes: record.documentBytes,
    lossManifest: record.lossManifest as unknown as JsonValue,
    ...(snapshot.progress ? { progress: snapshot.progress as unknown as JsonObject } : {}),
    ...(snapshot.error ? { error: snapshot.error as unknown as JsonObject } : {})
  }
}

export function validOtioArtifacts(
  snapshot: JobSnapshot,
  record: OtioExportRecord
): GeneratedArtifact[] {
  const artifacts = snapshot.result?.generatedArtifacts ?? []
  if (artifacts.length !== 1) return []
  const artifact = artifacts[0]!
  const metadata = artifact.provenance.metadata
  if (
    artifact.availability !== 'available' ||
    artifact.mediaKind !== 'document' ||
    artifact.mimeType !== OTIO_OUTPUT_MIME_TYPE ||
    artifact.provenance.jobId !== snapshot.id ||
    artifact.provenance.operation !== 'media.startFfmpegJob' ||
    metadata?.projectId !== record.projectId ||
    metadata?.pinnedRevision !== record.pinnedRevision ||
    metadata?.interchangeAdapterId !== record.adapterId ||
    metadata?.interchangeAdapterVersion !== record.adapterVersion ||
    metadata?.documentDigest !== record.documentDigest ||
    metadata?.projectDigest !== record.projectDigest ||
    metadata?.lossCount !== record.lossManifest.entries.length ||
    metadata?.portableLossless !== record.lossManifest.portableLossless ||
    metadata?.kunRoundTripLossless !== record.lossManifest.kunRoundTripLossless
  ) return []
  return [artifact]
}

export function storedProjectPackageRecord(
  value: JsonValue | undefined,
  expectedJobId: string
): ProjectPackageExportRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const record = value as Record<string, JsonValue | undefined>
    if (record.schemaVersion !== 1) return undefined
    const jobId = boundedString(record.jobId, 'stored package jobId', 1, 256)
    if (jobId !== expectedJobId) return undefined
    const missingMediaPolicy = enumValue(
      record.missingMediaPolicy,
      ['fail', 'omit'] as const,
      'stored package missingMediaPolicy'
    )
    const missingAssetIds = boundedArray(
      record.missingAssetIds,
      'stored package missingAssetIds',
      0,
      PROJECT_PACKAGE_LIMITS.mediaAssets
    ).map((entry, index) => stableId(entry, `stored package missingAssetIds[${index}]`))
    if (typeof record.complete !== 'boolean') return undefined
    const createdAt = boundedString(record.createdAt, 'stored package createdAt', 1, 64)
    if (!Number.isFinite(Date.parse(createdAt))) return undefined
    if (!isSha256Digest(record.manifestDigest)) return undefined
    return {
      schemaVersion: 1,
      jobId,
      projectId: stableId(record.projectId, 'stored package projectId'),
      sequenceId: stableId(record.sequenceId, 'stored package sequenceId'),
      pinnedRevision: nonNegativeInteger(record.pinnedRevision, 'stored package pinnedRevision'),
      packageId: stableId(record.packageId, 'stored package packageId'),
      manifestDigest: record.manifestDigest,
      complete: record.complete,
      selectedAssetCount: nonNegativeInteger(
        record.selectedAssetCount,
        'stored package selectedAssetCount'
      ),
      embeddedAssetCount: nonNegativeInteger(
        record.embeddedAssetCount,
        'stored package embeddedAssetCount'
      ),
      uniqueMediaCount: nonNegativeInteger(
        record.uniqueMediaCount,
        'stored package uniqueMediaCount'
      ),
      deduplicatedAssetCount: nonNegativeInteger(
        record.deduplicatedAssetCount,
        'stored package deduplicatedAssetCount'
      ),
      missingAssetIds,
      missingMediaPolicy,
      createdAt
    }
  } catch {
    return undefined
  }
}

export function projectPackageJobProjection(
  snapshot: JobSnapshot,
  record: ProjectPackageExportRecord
): JsonObject {
  return {
    jobId: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    cursor: snapshot.latestCursor,
    projectId: record.projectId,
    sequenceId: record.sequenceId,
    pinnedRevision: record.pinnedRevision,
    packageId: record.packageId,
    manifestDigest: record.manifestDigest,
    complete: record.complete,
    selectedAssetCount: record.selectedAssetCount,
    embeddedAssetCount: record.embeddedAssetCount,
    uniqueMediaCount: record.uniqueMediaCount,
    deduplicatedAssetCount: record.deduplicatedAssetCount,
    missingAssetIds: record.missingAssetIds,
    missingMediaPolicy: record.missingMediaPolicy,
    ...(snapshot.progress ? { progress: snapshot.progress as unknown as JsonObject } : {}),
    ...(snapshot.error ? { error: snapshot.error as unknown as JsonObject } : {}),
    ...(snapshot.result?.data === undefined ? {} : { result: snapshot.result.data })
  }
}

export function extensionOf(name: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,16})$/u.exec(name)
  return match?.[1]?.toLocaleLowerCase()
}
