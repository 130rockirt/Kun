export const VIEW_LIMITS = Object.freeze({
  projects: 100,
  sequences: 64,
  mediaFolders: 256,
  assets: 100,
  tracks: 64,
  items: 500,
  captions: 500,
  transcripts: 100,
  transcriptSegments: 500,
  revisions: 50,
  jobs: 40,
  derivedRecords: 120,
  agentEvents: 256,
  notices: 8,
  mediaLeases: 16,
  virtualWindow: 80,
  previewHistory: 40,
  multicamGroups: 64,
  generationRecords: 100
})

export type Rational = { numerator: number; denominator: number }
export type CanvasPreset = '16:9' | '9:16' | '1:1'
export type CanvasFit = 'fit' | 'crop' | 'pad'

export type ProjectSummary = {
  id: string
  name: string
  currentRevision: number
  updatedAt: string
  durationFrames: number
}

export type AssetProjection = {
  id: string
  name: string
  kind: 'video' | 'audio' | 'image' | 'animation'
  mediaHandleId?: string
  durationUs: number
  container: string
  video?: { codec: string; width: number; height: number; frameRate: Rational; rotation?: number }
  audio?: { codec: string; sampleRate: number; channels: number }
  still?: {
    width: number
    height: number
    format: string
    animated: boolean
    frameRate?: Rational
    loop?: boolean
  }
  folderId?: string
  generatedLineage?: {
    providerId: string
    modelId: string
    jobId: string
    promptDigest?: string
    referenceAssetIds: string[]
    variantOfAssetId?: string
  }
  availability?: 'online' | 'offline' | 'revoked' | 'changed'
  transcriptIds: string[]
}

export type MediaFolderProjection = {
  id: string
  name: string
  parentId?: string
}

export type MediaLibraryPageProjection = {
  projectId: string
  revision: number
  folderId?: string
  query: string
  offset: number
  limit: number
  total: number
  hiddenBefore: number
  hiddenAfter: number
  assets: AssetProjection[]
}

export type SequenceProjection = {
  id: string
  name: string
  durationFrames: number
  itemCount: number
  captionCount: number
  nestedByCount?: number
  viewState: { zoom: number; scrollFrame: number; open: boolean }
}

export type LinkGroupProjection = {
  id: string
  kind: 'av' | 'sync' | 'custom'
  itemIds: string[]
  locked: boolean
}

export type TrackProjection = {
  id: string
  name: string
  kind: 'video' | 'audio' | 'caption'
  order: number
  overlap: 'reject' | 'mix'
  muted?: boolean
  locked?: boolean
  visible?: boolean
  syncLocked?: boolean
}

export type ItemProjection = {
  id: string
  assetId: string
  trackId: string
  timelineStartFrame: number
  durationFrames: number
  sourceStartUs: number
  sourceEndUs: number
  speed: Rational
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }
  opacity: number
  fadeInFrames: number
  fadeOutFrames: number
  linkGroupId?: string
  nestedSequenceId?: string
  volume?: number
  muted?: boolean
  visible?: boolean
  locked?: boolean
  crop?: { left: number; top: number; right: number; bottom: number }
  blendMode?: 'normal' | 'multiply' | 'screen' | 'overlay'
  effects?: Array<{
    id: string
    type: string
    enabled: boolean
    parameters: Record<string, number | string | boolean>
  }>
  keyframes?: Array<{
    id: string
    property: string
    interpolation: 'hold' | 'linear' | 'ease'
    points: Array<{ id: string; frame: number; value: number }>
  }>
}

export type CaptionProjection = {
  id: string
  trackId: string
  startFrame: number
  endFrame: number
  text: string
  placement: 'top' | 'center' | 'bottom'
  style?: {
    fontSize?: number
    color?: string
    background?: string
    fontFamily?: string
    fontWeight?: number
    maxWidthRatio?: number
  }
  sourceTranscriptId?: string
  sourceSegmentIds?: string[]
  speakerAttribution?: SpeakerAttributionProjection
  words?: Array<{
    id: string
    text: string
    startFrame: number
    endFrame: number
    sourceWordId?: string
  }>
  animation?: { kind: 'none' | 'word-highlight' | 'fade'; durationFrames?: number }
}

export type TranscriptSegmentProjection = {
  id: string
  startUs: number
  endUs: number
  text: string
  speakerAttribution?: SpeakerAttributionProjection
  tags?: Array<'filler' | 'silence'>
  words?: Array<{
    id: string
    startUs: number
    endUs: number
    text: string
    confidence?: number
  }>
}

export type SpeakerAttributionProjection = {
  analysisId: string
  speakerId?: string
  speakerLabel?: string
  confidence: number
  status: 'identified' | 'unknown' | 'overlap' | 'uncertain'
  sourceTurnIds: string[]
}

export type TranscriptProjection = {
  id: string
  assetId: string
  language: string
  provenance: 'srt' | 'vtt' | 'json' | 'local-asr'
  segmentCount: number
  segments: TranscriptSegmentProjection[]
  truncated: boolean
}

export type RevisionProjection = {
  revision: number
  parentRevision: number | null
  author: 'manual' | 'agent' | 'system'
  sourceOperation: string
  timestamp: string
  summary: string
  restoredFromRevision?: number | null
}

export type MulticamSyncEvidenceProjection = {
  id: string
  analysisId: string
  kind: 'audio-correlation' | 'timecode' | 'manual-confirmation'
  referenceMemberId: string
  targetMemberId: string
  confidence: number
  algorithmId: string
  algorithmVersion: string
}

export type MulticamMemberProjection = {
  id: string
  assetId: string
  memberLabel: string
  angleLabel: string
  sourceFps: Rational
  sync: {
    status: 'reference' | 'verified' | 'uncertain' | 'unknown'
    offsetFrames: number
    confidence?: number
    evidence: MulticamSyncEvidenceProjection[]
  }
  coverage: Array<{
    id: string
    startFrame: number
    endFrame: number
    sourceStartFrame: number
    sourceEndFrame: number
  }>
}

export type MulticamLayoutProjection = {
  id: string
  label: string
  slots: Array<{
    memberId: string
    x: number
    y: number
    width: number
    height: number
    zIndex: number
    opacity: number
    audioEnabled: boolean
  }>
}

export type MulticamProgramFragmentProjection = {
  id: string
  startFrame: number
  endFrame: number
  selection:
    | { kind: 'angle'; memberId: string }
    | { kind: 'layout'; layoutId: string }
}

export type MulticamGroupProjection = {
  schemaVersion: 1
  id: string
  sequenceId: string
  name: string
  fps: Rational
  durationFrames: number
  referenceMemberId: string
  members: MulticamMemberProjection[]
  layouts: MulticamLayoutProjection[]
  programFragments: MulticamProgramFragmentProjection[]
}

export type ProjectProjection = {
  schemaVersion: 1
  id: string
  name: string
  fps: Rational
  canvas: {
    preset: CanvasPreset
    width: number
    height: number
    fit: CanvasFit
    background: string
  }
  currentRevision: number
  eventGeneration: number
  activeSequenceId: string
  selection: {
    sequenceId: string
    revision: number
    generation: number
    playheadFrame: number
    selectedAssetIds: string[]
    selectedItemIds: string[]
    selectedCaptionIds: string[]
    selectedWordIds: string[]
    range?: { startFrame: number; endFrame: number }
  }
  updatedAt: string
  durationFrames: number
  playback: {
    mode: 'source-fast-path' | 'composed-proof'
    projectId: string
    sequenceId: string
    revision: number
    irDigest?: string | null
    sourceAssetId?: string | null
    reasons: string[]
  }
  sequences: SequenceProjection[]
  mediaFolders: MediaFolderProjection[]
  linkGroups: LinkGroupProjection[]
  multicamGroups: MulticamGroupProjection[]
  assets: AssetProjection[]
  tracks: TrackProjection[]
  items: ItemProjection[]
  captions: CaptionProjection[]
  transcripts: TranscriptProjection[]
  revisions: RevisionProjection[]
  canUndo?: boolean
  canRedo?: boolean
  truncated?: boolean
}

export type TimelineOperation =
  | { type: 'add-item'; item: ItemProjection }
  | { type: 'split-item'; itemId: string; atFrame: number }
  | { type: 'trim-item'; itemId: string; startFrame: number; endFrame: number }
  | { type: 'delete-item'; itemId: string }
  | { type: 'move-item'; itemId: string; trackId: string; timelineStartFrame: number }
  | { type: 'reorder-item'; itemId: string; beforeItemId?: string }
  | { type: 'update-transform'; itemId: string; transform: Partial<ItemProjection['transform']>; opacity?: number }
  | { type: 'update-track-state'; trackId: string; muted?: boolean; locked?: boolean; syncLocked?: boolean }
  | {
      type: 'update-item-properties'
      itemId: string
      volume?: number
      fadeInFrames?: number
      fadeOutFrames?: number
      muted?: boolean
      visible?: boolean
      locked?: boolean
    }
  | { type: 'set-link-group'; group: { id: string; kind: 'av' | 'sync' | 'custom'; itemIds: string[]; locked: boolean } }
  | { type: 'delete-link-group'; linkGroupId: string }
  | { type: 'create-sequence'; sequenceId: string; name: string; activate?: boolean }
  | {
      type: 'duplicate-sequence'
      sourceSequenceId: string
      sequenceId: string
      name: string
      activate?: boolean
    }
  | { type: 'rename-sequence'; sequenceId: string; name: string }
  | { type: 'select-sequence'; sequenceId: string }
  | { type: 'open-sequence'; sequenceId: string }
  | { type: 'close-sequence'; sequenceId: string; fallbackSequenceId?: string }
  | { type: 'delete-sequence'; sequenceId: string }
  | { type: 'set-sequence-view'; sequenceId: string; zoom: number; scrollFrame: number }
  | { type: 'set-item-keyframes'; itemId: string; keyframes: NonNullable<ItemProjection['keyframes']> }
  | { type: 'set-item-effects'; itemId: string; effects: NonNullable<ItemProjection['effects']> }
  | {
      type: 'update-item-composition'
      itemId: string
      crop?: NonNullable<ItemProjection['crop']>
      opacity?: number
      blendMode?: NonNullable<ItemProjection['blendMode']>
    }
  | { type: 'retime-item'; itemId: string; speed: Rational }
  | { type: 'add-caption'; caption: CaptionProjection }
  | { type: 'update-caption'; captionId: string; patch: Partial<Omit<CaptionProjection, 'id'>> }
  | { type: 'delete-caption'; captionId: string }
  | { type: 'set-canvas'; preset: CanvasPreset; fit: CanvasFit }
  | { type: 'set-multicam-group'; group: MulticamGroupProjection }
  | { type: 'delete-multicam-group'; groupId: string }
  | {
      type: 'switch-multicam-angle'
      groupId: string
      memberId: string
      startFrame: number
      endFrame: number
      coveragePolicy?: 'reject' | 'clamp'
      minimumSyncConfidence?: number
    }
  | {
      type: 'apply-multicam-layout'
      groupId: string
      layoutId: string
      startFrame: number
      endFrame: number
      coveragePolicy?: 'reject' | 'clamp'
      minimumSyncConfidence?: number
    }
  | { type: 'merge-multicam-program'; groupId: string }

export type ProjectChange = {
  schemaVersion: 1
  projectId: string
  revision: number
  generation?: number
  sequenceId?: string
  selectionGeneration?: number
  reason: string
  changedIds: string[]
  receipt?: Record<string, unknown>
  proofInvalidated?: boolean
}

export type RenderTicket = {
  jobId: string
  projectId: string
  pinnedRevision: number
  renderKind: 'proof-frame' | 'preview' | 'h264-mp4' | 'audio-aac' | 'subtitles'
  createdAt: string
}

export type ProjectPackageMissingMediaPolicy = 'fail' | 'omit'

export type ProjectPackageTicket = {
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
  missingMediaPolicy: ProjectPackageMissingMediaPolicy
  mediaScope: 'all' | 'selected'
  receiptsRequested: boolean
  agentProvenanceRequested: boolean
  createdAt: string
}

export type InterchangeLossEntryProjection = {
  code: string
  severity: 'info' | 'warning'
  feature: string
  nodeId: string
  preservation: 'otio-standard' | 'kun-metadata'
  message: string
}

export type InterchangeLossManifestProjection = {
  adapterId: 'kun.otio-json'
  adapterVersion: '1.0.0'
  portableLossless: boolean
  kunRoundTripLossless: boolean
  entries: InterchangeLossEntryProjection[]
  truncated: number
}

export type OtioExportTicket = {
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
  lossManifest: InterchangeLossManifestProjection
  createdAt: string
}

export type OtioTimecodeMappingProjection = {
  id: string
  sequenceId: string
  startFrame: number
  endFrame: number
  startTimecode: string
  endTimecode: string
  frameRate: Rational
}

export type OtioImportPreview = {
  inputHandleId: string
  displayName: string
  sourceDocumentDigest: string
  sourceProjectId: string
  sourceProjectRevision: number
  suggestedProjectId: string
  fidelity: 'kun-metadata' | 'portable-otio'
  project: {
    id: string
    name: string
    revision: number
    activeSequenceId: string
    counts: {
      assets: number
      sequences: number
      tracks: number
      items: number
      captions: number
      transcripts: number
    }
  }
  mediaRelinkRequired: string[]
  timecodeMappings: OtioTimecodeMappingProjection[]
  timecodeMappingsTruncated: number
  lossManifest: InterchangeLossManifestProjection
}
