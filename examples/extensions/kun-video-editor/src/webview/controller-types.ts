import type { GeneratedArtifact } from '@kun/extension-api'
import type { GenerationConsent } from '../engine/generation.js'
import type { GenerationPanelRequest } from './generation-panel.js'
import type {
  MulticamCreateRequest,
  MulticamLayoutRequest,
  MulticamRenameRequest,
  MulticamSelectionRequest,
  MulticamSwitchRequest,
  MulticamSyncConfirmation
} from './multicam-panel.js'
import type {
  CanvasPreset,
  DerivedMediaKind,
  DerivedMediaRecordProjection,
  EditorState,
  EditorWorkspace,
  PreviewSourceProjection,
  ProjectPackageMissingMediaPolicy,
  RenderTicket,
  TimelineOperation
} from './model.js'

export type ProjectPackageExportOptions = {
  missingMediaPolicy: ProjectPackageMissingMediaPolicy
  includeReceipts: boolean
  includeAgentProvenance: boolean
  mediaScope: 'all' | 'selected'
  assetIds?: string[]
}

export type PreviewResource = {
  entryId: string
  title: string
  url: string
  mediaKind: 'video' | 'audio' | 'image'
}

export type EditorController = {
  state: EditorState
  refreshAll(): Promise<void>
  retryInitialization(): Promise<void>
  setActiveWorkspace(workspace: EditorWorkspace): void
  createProject(
    name: string,
    preset: CanvasPreset,
    fps?: { numerator: number; denominator: number }
  ): Promise<void>
  openProject(projectId: string): Promise<void>
  importMedia(options?: { folderId?: string; addToTimeline?: boolean }): Promise<void>
  loadMediaLibraryPage(options?: { folderId?: string; query?: string; offset?: number; limit?: number }): Promise<void>
  importTranscript(): Promise<void>
  checkLocalTranscriber(): Promise<void>
  generateCaptions(): Promise<void>
  openAsset(assetId: string): Promise<void>
  openDerivedResource?(recordId: string): Promise<string | undefined>
  refreshActiveLease(): Promise<void>
  recoverMedia(assetId?: string): Promise<void>
  refreshDerived(): Promise<void>
  startDerived(kind: Extract<DerivedMediaKind, 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy'>): Promise<void>
  retryDerived(record: DerivedMediaRecordProjection): Promise<void>
  cancelDerived(recordId: string): Promise<void>
  cleanupDerived(includeReady?: boolean): Promise<void>
  refreshMediaIntelligence(): Promise<void>
  setVisualOptIn(enabled: boolean): Promise<void>
  requestVisualModelInstall(): Promise<void>
  indexVisual(assetId: string): Promise<void>
  searchVisualMoments(indexId: string, query: string, offset?: number): Promise<void>
  analyzeVad(assetId: string): Promise<void>
  applyVadAnalysis(analysisId: string): Promise<void>
  importSpeakerEvidence(assetId: string, document: string): Promise<void>
  previewSpeakerAttribution(analysisId: string): Promise<void>
  applySpeakerAttribution(analysisId: string): Promise<void>
  analyzeBeats(assetId: string): Promise<void>
  analyzeDenoiseMetadata(assetId: string): Promise<void>
  previewAudioSync(referenceItemId: string, targetItemId: string, seed?: number): Promise<void>
  applyAudioSync(analysisId: string, referenceItemId: string, targetItemId: string): Promise<void>
  cancelMediaIntelligence(operationId: string): Promise<void>
  refreshGeneration(): Promise<void>
  requestGeneration(request: GenerationPanelRequest): Promise<void>
  retryGeneration(recordId: string, consent: GenerationConsent): Promise<void>
  cancelGeneration(recordId: string): Promise<void>
  insertGeneratedVariant(recordId: string, outputId: string): Promise<void>
  createMulticam(request: MulticamCreateRequest): Promise<void>
  renameMulticamLabels(request: MulticamRenameRequest): Promise<void>
  confirmMulticamSync(request: MulticamSyncConfirmation): Promise<void>
  switchMulticam(request: MulticamSwitchRequest): Promise<void>
  mergeMulticam(groupId: string): Promise<void>
  applyMulticamLayout(request: MulticamLayoutRequest): Promise<void>
  previewMulticam(request: MulticamSelectionRequest): Promise<void>
  applyOperations(operations: TimelineOperation[], summary: string): Promise<void>
  createSequence(name: string, activate?: boolean): Promise<void>
  duplicateSequence(sequenceId: string, name: string, activate?: boolean): Promise<void>
  renameSequence(sequenceId: string, name: string): Promise<void>
  selectSequence(sequenceId: string): Promise<void>
  closeSequence(sequenceId: string): Promise<void>
  deleteSequence(sequenceId: string): Promise<void>
  setSequenceView(sequenceId: string, zoom: number, scrollFrame: number): Promise<void>
  decomposeNested(itemId: string): Promise<void>
  createMediaFolder(name: string, parentId?: string): Promise<void>
  updateMediaFolder(folderId: string, patch: { name?: string; parentId?: string | null }): Promise<void>
  deleteMediaFolder(folderId: string, moveContentsToFolderId?: string): Promise<void>
  organizeMedia(assetIds: string[], folderId?: string): Promise<void>
  refreshPreviewHistory(): Promise<void>
  addPreview(source: PreviewSourceProjection, label: string): Promise<void>
  selectPreview(entryId: string): Promise<void>
  openPreviewResource(entryId: string): Promise<PreviewResource | undefined>
  comparePreviews(leftEntryId: string, rightEntryId: string, mode: 'wipe' | 'side-by-side'): Promise<void>
  replaceSelectedFromPreview(entryId: string): Promise<void>
  attachSelection(previewEntryIds?: string[]): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  readScript(): Promise<void>
  editScript(markdown: string): void
  applyScript(ranges: Array<{ assetId: string; startUs: number; endUs: number; reason?: 'filler' | 'silence' | 'selection' }>): Promise<void>
  seek(frame: number): void
  togglePlaying(): void
  selectItem(itemId?: string): void
  selectCaption(captionId?: string): void
  setTranscriptWindow(start: number): void
  setTimelineWindow(start: number): void
  startAgent(prompt: string): Promise<void>
  steerAgent(prompt: string): Promise<void>
  cancelAgent(): Promise<void>
  startRender(
    kind: RenderTicket['renderKind'],
    captionMode: 'none' | 'burned' | 'sidecar' | 'both',
    subtitleFormat?: 'srt' | 'vtt',
    options?: {
      multicamGroupId?: string
      range?: { startFrame: number; endFrame: number }
    }
  ): Promise<void>
  cancelJob(jobId: string): Promise<void>
  startProjectPackage(options: ProjectPackageExportOptions): Promise<void>
  refreshProjectPackage(jobId: string): Promise<void>
  cancelProjectPackage(jobId: string): Promise<void>
  startOtioExport(): Promise<void>
  refreshOtioExport(jobId: string): Promise<void>
  cancelOtioExport(jobId: string): Promise<void>
  previewOtioImport(): Promise<void>
  confirmOtioImport(targetProjectId: string): Promise<void>
  cancelOtioImportPreview(): Promise<void>
  openArtifact(artifact: GeneratedArtifact): Promise<void>
  revealArtifact(artifact: GeneratedArtifact): Promise<void>
  dismissNotice(id: string): void
}
