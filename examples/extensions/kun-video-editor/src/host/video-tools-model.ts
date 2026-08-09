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
export const MAX_PROJECTS = 100
export const MAX_ASSETS = 100
export const MAX_TRACKS = 64
export const MAX_ITEMS = 500
export const MAX_CAPTIONS = 500
export const MAX_TRANSCRIPTS = 100
export const MAX_TRANSCRIPT_SEGMENTS = 500
export const MAX_SEQUENCES = 32
export const MAX_MEDIA_FOLDERS = 256
export const MAX_LINK_GROUPS = 256
export const MAX_MULTICAM_GROUPS = 64
export const MAX_SCRIPT_BYTES = 240 * 1024
export const ACTIVE_PROJECT_KEY = 'active-project'
export const PREVIEW_HISTORY_PREFIX = 'preview-history:'
export const RENDER_RECORD_PREFIX = 'render-job:'
export const PROJECT_PACKAGE_RECORD_PREFIX = 'project-package-job:'
export const OTIO_EXPORT_RECORD_PREFIX = 'otio-export-job:'
export const RENDER_TRACKING_CANCELLATION_WAIT_MS = 12_000
export const INLINE_OTIO_PREVIEW_BYTES = 96 * 1024
export const INTERCHANGE_MAPPING_PREVIEW_LIMIT = 256
export const PACKAGE_PREFLIGHT_ASSET_PREVIEW_LIMIT = 200
export const PACKAGE_PREFLIGHT_DEDUPE_PREVIEW_LIMIT = 64

export type RenderRecord = {
  schemaVersion: 1
  jobId: string
  projectId: string
  sequenceId: string
  pinnedRevision: number
  renderIrDigest: string
  backendCapabilitiesDigest: string
  renderRange: { startFrame: number; endFrame: number }
  playbackMode: 'source-fast-path' | 'composed-proof'
  renderKind: RenderKind
  requestedRenderKind?: 'h264-mp4' | 'h265-mp4' | 'prores-mov'
  advancedSettingsDigest?: string
  advancedCapabilitiesDigest?: string
  effectSemanticsDigest?: string
  portableEquivalent?: boolean
  captionMode: 'none' | 'burned' | 'sidecar' | 'both'
  subtitleFormat: 'srt' | 'vtt'
  canvasPreset: VideoProject['canvas']['preset']
  proofFrame?: number
  expectedArtifacts: Array<{
    mediaKind: 'image' | 'video' | 'audio' | 'subtitle'
    mimeType: string
  }>
  createdAt: string
}

export type ProjectPackageExportRecord = {
  schemaVersion: 1
  jobId: string
  projectId: string
  sequenceId: string
  pinnedRevision: number
  packageId: string
  manifestDigest: string
  complete: boolean
  selectedAssetCount: number
  embeddedAssetCount: number
  uniqueMediaCount: number
  deduplicatedAssetCount: number
  missingAssetIds: string[]
  missingMediaPolicy: 'fail' | 'omit'
  createdAt: string
}

export type OtioExportRecord = {
  schemaVersion: 1
  jobId: string
  projectId: string
  sequenceId: string
  pinnedRevision: number
  adapterId: 'kun.otio-json'
  adapterVersion: '1.0.0'
  documentDigest: string
  projectDigest: string
  documentBytes: number
  lossManifest: InterchangeLossManifest
  createdAt: string
}

export type RenderCapabilityAssessment =
  | { failure: ToolResult }
  | {
      backendCapabilities: RenderBackendCapabilities
      selectedRenderKind: RenderKind
      advancedEffects?: AdvancedEffectExecutionPlan
      advancedExport?: AdvancedExportPlan
    }

export type ToolInput = Readonly<Record<string, unknown>>

// Node Host packages are installed without an extension-local node_modules
// tree. Keep the Host entrypoint runtime-self-contained instead of importing
// the SDK error class at activation time. The broker consumes this public
// structural error shape, while tests may still throw the SDK implementation.
export class ExtensionApiError extends Error {
  readonly code: ExtensionErrorData['code']
  readonly operation?: string
  readonly extensionId?: string
  readonly retryable: boolean
  readonly details?: JsonObject
  readonly documentation?: string

  constructor(data: ExtensionErrorData) {
    super(data.message)
    this.name = 'ExtensionApiError'
    this.code = data.code
    this.operation = data.operation
    this.extensionId = data.extensionId
    this.retryable = data.retryable
    this.details = data.details
    this.documentation = data.documentation
  }
}

export class ToolInputError extends ExtensionApiError {
  constructor(message: string) {
    super({ code: 'INVALID_ARGUMENT', message, retryable: false })
    this.name = 'ToolInputError'
  }
}
