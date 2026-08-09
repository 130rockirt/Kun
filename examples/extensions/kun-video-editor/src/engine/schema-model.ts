import type { MulticamGroup } from './multicam.js'

export const PROJECT_SCHEMA_VERSION = 2 as const
export const MAX_PROJECT_HISTORY = 50

export const PROJECT_LIMITS = Object.freeze({
  assets: 512,
  mediaFolders: 256,
  sequences: 32,
  tracksPerSequence: 64,
  itemsPerSequence: 10_000,
  captionsPerSequence: 10_000,
  linkGroups: 2_048,
  linkGroupMembers: 32,
  transcripts: 512,
  transcriptSegments: 50_000,
  transcriptWordsPerSegment: 2_000,
  derivedReferences: 4_096,
  multicamGroups: 64,
  effectsPerItem: 32,
  effectParameters: 64,
  keyframeTracksPerItem: 32,
  keyframePointsPerTrack: 2_048,
  selectedIds: 256,
  receiptIds: 256,
  receiptShifts: 64,
  receiptChanges: 64,
  receiptNotes: 16,
  recoveryEntries: 128
} as const)

export type Rational = {
  numerator: number
  denominator: number
}

export type CanvasPreset = '16:9' | '9:16' | '1:1'
export type CanvasFit = 'fit' | 'crop' | 'pad'
export type CanvasSettings = {
  preset: CanvasPreset
  width: number
  height: number
  fit: CanvasFit
  background: string
}

export type VideoStreamMetadata = {
  codec: string
  width: number
  height: number
  frameRate: Rational
  rotation?: 0 | 90 | 180 | 270
}

export type AudioStreamMetadata = {
  codec: string
  sampleRate: number
  channels: number
}

export type StillImageMetadata = {
  width: number
  height: number
  format: string
  animated: boolean
  frameRate?: Rational
  loop?: boolean
}

export type GeneratedAssetLineage = {
  providerId: string
  modelId: string
  jobId: string
  promptDigest?: string
  /** Legacy project field. New generation integrations persist only promptDigest. */
  prompt?: string
  referenceAssetIds: string[]
  variantOfAssetId?: string
}

export type MediaFolder = {
  id: string
  name: string
  parentId?: string
}

export type MediaAsset = {
  id: string
  name: string
  kind: 'video' | 'audio' | 'image' | 'animation'
  mediaHandleId?: string
  workspaceRelativePath?: string
  durationUs: number
  container: string
  video?: VideoStreamMetadata
  audio?: AudioStreamMetadata
  still?: StillImageMetadata
  folderId?: string
  generatedLineage?: GeneratedAssetLineage
  transcriptIds: string[]
  availability?: 'online' | 'offline' | 'revoked' | 'changed'
  sourceIdentity?: SourceIdentity
  recovery?: {
    reason?: 'missing' | 'revoked' | 'changed' | 'manifest-unreadable'
    lastVerifiedAt?: string
    previousMediaHandleId?: string
  }
}

export type SourceIdentity = {
  algorithm: 'sha256'
  value: string
  sizeBytes?: number
  modifiedAt?: string
}

export type Track = {
  id: string
  name: string
  kind: 'video' | 'audio' | 'caption'
  order: number
  overlap: 'reject' | 'mix'
  muted?: boolean
  locked?: boolean
  syncLocked?: boolean
}

export type Transform = {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type Crop = {
  left: number
  top: number
  right: number
  bottom: number
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay'

export type EffectParameter = number | string | boolean

export type EffectInstance = {
  id: string
  type: string
  enabled: boolean
  parameters: Record<string, EffectParameter>
}

export type KeyframePoint = {
  id: string
  frame: number
  value: number
}

export type KeyframeTrack = {
  id: string
  property: string
  interpolation: 'hold' | 'linear' | 'ease'
  points: KeyframePoint[]
}

export type TimelineItem = {
  id: string
  assetId: string
  trackId: string
  timelineStartFrame: number
  durationFrames: number
  sourceStartUs: number
  sourceEndUs: number
  speed: Rational
  transform: Transform
  opacity: number
  fadeInFrames: number
  fadeOutFrames: number
  linkGroupId?: string
  nestedSequenceId?: string
  crop?: Crop
  blendMode?: BlendMode
  volume?: number
  muted?: boolean
  visible?: boolean
  locked?: boolean
  effects?: EffectInstance[]
  keyframes?: KeyframeTrack[]
}

export type Caption = {
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
  speakerAttribution?: SpeakerAttributionEvidence
  words?: Array<{
    id: string
    text: string
    startFrame: number
    endFrame: number
    sourceWordId?: string
  }>
  animation?: {
    kind: 'none' | 'word-highlight' | 'fade'
    durationFrames?: number
  }
}

export type TranscriptWord = {
  id: string
  startUs: number
  endUs: number
  text: string
  confidence?: number
  provenance?: {
    adapterId: string
    sourceId?: string
  }
}

export type TranscriptSegment = {
  id: string
  startUs: number
  endUs: number
  text: string
  words?: TranscriptWord[]
  tags?: Array<'filler' | 'silence'>
  confidence?: number
  speakerAttribution?: SpeakerAttributionEvidence
  provenance?: {
    adapterId: string
    sourceId?: string
  }
}

/**
 * Revision-bound attribution derived from immutable diarization evidence.
 * Unknown, overlapping, and otherwise uncertain ranges intentionally omit an
 * identity so display code cannot accidentally promote weak evidence to fact.
 */
export type SpeakerAttributionEvidence = {
  analysisId: string
  speakerId?: string
  speakerLabel?: string
  confidence: number
  status: 'identified' | 'unknown' | 'overlap' | 'uncertain'
  sourceTurnIds: string[]
}

export type Transcript = {
  id: string
  assetId: string
  language: string
  provenance: 'srt' | 'vtt' | 'json' | 'local-asr'
  segments: TranscriptSegment[]
  adapter?: {
    id: string
    version: string
    modelId?: string
    execution: 'local' | 'import'
    sourceFormat?: 'srt' | 'vtt' | 'json'
  }
  sourceFingerprint?: SourceIdentity
}

export type SequenceViewState = {
  zoom: number
  scrollFrame: number
  open: boolean
}

export type Sequence = {
  id: string
  name: string
  tracks: Track[]
  items: TimelineItem[]
  captions: Caption[]
  viewState: SequenceViewState
}

export type LinkGroup = {
  id: string
  kind: 'av' | 'sync' | 'custom'
  itemIds: string[]
  locked: boolean
}

export type ProjectSelection = {
  generation: number
  revision: number
  sequenceId: string
  playheadFrame: number
  selectedAssetIds: string[]
  selectedItemIds: string[]
  selectedCaptionIds: string[]
  selectedWordIds: string[]
  range?: { startFrame: number; endFrame: number }
}

export type DerivedReference = {
  id: string
  kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'transcript' | 'analysis' | 'embedding' | 'proxy' | 'proof' | 'preview'
  sourceAssetId?: string
  dependencyIds: string[]
  producerVersion: string
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'interrupted' | 'invalid'
  bytes: number
  pinned: boolean
  sourceFingerprint?: SourceIdentity
  updatedAt: string
  errorCode?: string
}

export type AgentUndoEntry = {
  revision: number
  actorId: string
  transactionId: string
}

export type ProjectRecoveryState = {
  mode: 'healthy' | 'write-blocked'
  recoveredFromRevision?: number
  unreadableManifestKinds: Array<'project' | 'media' | 'derived'>
  interruptedJobIds: string[]
  notes: string[]
}

export type RevisionAuthor = 'manual' | 'agent' | 'system'

export type AddItemOperation = { type: 'add-item'; item: TimelineItem }
export type SplitItemOperation = { type: 'split-item'; itemId: string; atFrame: number }
export type TrimItemOperation = {
  type: 'trim-item'
  itemId: string
  startFrame: number
  endFrame: number
}
export type DeleteItemOperation = { type: 'delete-item'; itemId: string }
export type MoveItemOperation = {
  type: 'move-item'
  itemId: string
  trackId: string
  timelineStartFrame: number
}
export type ReorderItemOperation = {
  type: 'reorder-item'
  itemId: string
  beforeItemId?: string
}
export type UpdateTransformOperation = {
  type: 'update-transform'
  itemId: string
  transform: Partial<Transform>
  opacity?: number
}
export type UpdateTrackStateOperation = {
  type: 'update-track-state'
  trackId: string
  muted?: boolean
  locked?: boolean
  syncLocked?: boolean
}
export type UpdateItemPropertiesOperation = {
  type: 'update-item-properties'
  itemId: string
  volume?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  muted?: boolean
  visible?: boolean
  locked?: boolean
}
export type SetLinkGroupOperation = { type: 'set-link-group'; group: LinkGroup }
export type DeleteLinkGroupOperation = { type: 'delete-link-group'; linkGroupId: string }
export type CreateSequenceOperation = {
  type: 'create-sequence'
  sequenceId: string
  name: string
  activate?: boolean
}
/** Internal inverse/snapshot operation. Host parsers MUST NOT expose this variant. */
export type RestoreSequenceOperation = {
  type: 'restore-sequence'
  sequence: Sequence
  linkGroups: LinkGroup[]
  activate: boolean
}
export type DuplicateSequenceOperation = {
  type: 'duplicate-sequence'
  sourceSequenceId: string
  sequenceId: string
  name: string
  activate?: boolean
}
export type RenameSequenceOperation = { type: 'rename-sequence'; sequenceId: string; name: string }
export type SelectSequenceOperation = { type: 'select-sequence'; sequenceId: string }
export type OpenSequenceOperation = { type: 'open-sequence'; sequenceId: string }
export type CloseSequenceOperation = {
  type: 'close-sequence'
  sequenceId: string
  fallbackSequenceId?: string
}
export type DeleteSequenceOperation = { type: 'delete-sequence'; sequenceId: string }
export type SetSequenceViewOperation = {
  type: 'set-sequence-view'
  sequenceId: string
  zoom: number
  scrollFrame: number
}
export type SetItemKeyframesOperation = {
  type: 'set-item-keyframes'
  itemId: string
  keyframes: KeyframeTrack[]
}
export type SetItemEffectsOperation = {
  type: 'set-item-effects'
  itemId: string
  effects: EffectInstance[]
}
export type UpdateItemCompositionOperation = {
  type: 'update-item-composition'
  itemId: string
  crop?: Crop
  opacity?: number
  blendMode?: BlendMode
}
export type RetimeItemOperation = { type: 'retime-item'; itemId: string; speed: Rational }
export type AddCaptionOperation = { type: 'add-caption'; caption: Caption }
export type UpdateCaptionOperation = {
  type: 'update-caption'
  captionId: string
  patch: Partial<Omit<Caption, 'id'>>
}
export type DeleteCaptionOperation = { type: 'delete-caption'; captionId: string }
export type SetCanvasOperation = {
  type: 'set-canvas'
  preset: CanvasPreset
  fit: CanvasFit
}
export type SetMulticamGroupOperation = {
  type: 'set-multicam-group'
  group: MulticamGroup
}
export type DeleteMulticamGroupOperation = {
  type: 'delete-multicam-group'
  groupId: string
}
export type SwitchMulticamAngleOperation = {
  type: 'switch-multicam-angle'
  groupId: string
  memberId: string
  startFrame: number
  endFrame: number
  coveragePolicy?: 'reject' | 'clamp'
  minimumSyncConfidence?: number
}
export type ApplyMulticamLayoutOperation = {
  type: 'apply-multicam-layout'
  groupId: string
  layoutId: string
  startFrame: number
  endFrame: number
  coveragePolicy?: 'reject' | 'clamp'
  minimumSyncConfidence?: number
}
export type MergeMulticamProgramOperation = {
  type: 'merge-multicam-program'
  groupId: string
}

export type TimelineOperation =
  | AddItemOperation
  | SplitItemOperation
  | TrimItemOperation
  | DeleteItemOperation
  | MoveItemOperation
  | ReorderItemOperation
  | UpdateTransformOperation
  | UpdateTrackStateOperation
  | UpdateItemPropertiesOperation
  | SetLinkGroupOperation
  | DeleteLinkGroupOperation
  | CreateSequenceOperation
  | RestoreSequenceOperation
  | DuplicateSequenceOperation
  | RenameSequenceOperation
  | SelectSequenceOperation
  | OpenSequenceOperation
  | CloseSequenceOperation
  | DeleteSequenceOperation
  | SetSequenceViewOperation
  | SetItemKeyframesOperation
  | SetItemEffectsOperation
  | UpdateItemCompositionOperation
  | RetimeItemOperation
  | AddCaptionOperation
  | UpdateCaptionOperation
  | DeleteCaptionOperation
  | SetCanvasOperation
  | SetMulticamGroupOperation
  | DeleteMulticamGroupOperation
  | SwitchMulticamAngleOperation
  | ApplyMulticamLayoutOperation
  | MergeMulticamProgramOperation

export type Revision = {
  revision: number
  parentRevision: number | null
  author: RevisionAuthor
  actorId?: string
  transactionId?: string
  sourceOperation: string
  timestamp: string
  summary: string
  operations: TimelineOperation[]
  inverseOperations: TimelineOperation[]
  restoredFromRevision?: number
}

export type VideoProject = {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  id: string
  name: string
  createdAt: string
  updatedAt: string
  fps: Rational
  canvas: CanvasSettings
  assets: MediaAsset[]
  mediaFolders?: MediaFolder[]
  /** Compatibility projection of the active sequence for the 0.3.x Host/Webview. */
  tracks: Track[]
  items: TimelineItem[]
  captions: Caption[]
  sequences: Sequence[]
  activeSequenceId: string
  linkGroups: LinkGroup[]
  selection: ProjectSelection
  transcripts: Transcript[]
  derivedReferences: DerivedReference[]
  /** Optional so schema-v2 projects written before multicam support still open without rewriting. */
  multicamGroups?: MulticamGroup[]
  currentRevision: number
  eventGeneration: number
  revisions: Revision[]
  undoStack: number[]
  redoStack: number[]
  agentUndoStack: AgentUndoEntry[]
  recovery: ProjectRecoveryState
}

export type ReceiptIdKind =
  | 'asset'
  | 'media-folder'
  | 'sequence'
  | 'track'
  | 'item'
  | 'caption'
  | 'link-group'
  | 'transcript'
  | 'derived'
  | 'multicam-group'
  | 'multicam-fragment'

export type ReceiptId = { kind: ReceiptIdKind; id: string }

export type UniformShift = {
  sequenceId: string
  trackId?: string
  fromFrame: number
  deltaFrames: number
  count: number
}

export type MutationReceipt = {
  schemaVersion: 1
  transactionId: string
  projectId: string
  sequenceId: string
  previousRevision: number
  newRevision: number
  generation: number
  attribution: {
    author: RevisionAuthor
    actorId?: string
    sourceOperation: string
  }
  createdIds: ReceiptId[]
  changedIds: ReceiptId[]
  removedIds: ReceiptId[]
  shifts: UniformShift[]
  sequenceChanges: string[]
  trackChanges: string[]
  proofInvalidated: boolean
  notes: Array<{
    code: string
    messageKey: string
    severity: 'info' | 'warning'
    values?: Record<string, string | number>
  }>
  truncated: {
    created: number
    changed: number
    removed: number
    shifts: number
    sequenceChanges: number
    trackChanges: number
    notes: number
  }
}

export type RenderPreset = {
  id: 'proof-frame' | 'preview' | 'h264-mp4' | 'audio-aac' | 'subtitles-srt' | 'subtitles-vtt'
  width?: number
  height?: number
  videoBitrate?: string
  audioBitrate?: string
}

export type RuntimeSchema<T> = {
  parse(value: unknown): T
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: Error }
}
