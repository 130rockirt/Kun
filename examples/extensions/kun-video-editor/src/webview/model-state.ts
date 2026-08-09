import type {
  AgentRun,
  AgentRunEvent,
  JobEvent,
  JobSnapshot,
  Locale,
  MediaCapabilities,
  MediaMetadata,
  MediaResourceLease,
  ResultPreviewOpenPayload,
  Theme
} from '@kun/extension-api'
import type { MessageKey } from './i18n.js'
import type { RenderCapabilityDetail } from './render-capability.js'
import type {
  AudioAnalysisCapabilitiesProjection,
  AudioAnalysisRecordProjection,
  AudioSyncPreviewProjection,
  DenoiseMetadataCapabilityProjection,
  DerivedMediaRecordProjection,
  DerivedStorageUsageProjection,
  GenerationRecordProjection,
  GenerationStateProjection,
  MediaIntelligenceEvidenceProjection,
  MediaIntelligenceProgressProjection,
  PreviewComparisonProjection,
  PreviewHistoryProjection,
  SpeakerAdapterProjection,
  SpeakerAttributionPlanProjection,
  SpeakerIdentityProjection,
  VisualMomentPageProjection,
  VisualProvisioningProjection
} from './model-intelligence.js'
import type {
  MediaLibraryPageProjection,
  OtioExportTicket,
  OtioImportPreview,
  ProjectChange,
  ProjectPackageTicket,
  ProjectProjection,
  ProjectSummary,
  RenderTicket
} from './model-project.js'

export type EditorNotice = {
  id: string
  severity: 'info' | 'warning' | 'error'
  message: string
  messageKey?: MessageKey
  messageValues?: Readonly<Record<string, string | number>>
  interactionRequired?: boolean
  retryable?: boolean
  capabilityDetails?: RenderCapabilityDetail[]
}

export type EditorWorkspace = 'script' | 'clips' | 'timeline' | 'properties' | 'output'

export type PersistedEditorState = {
  schemaVersion: 1
  projectId?: string
  selectedItemId?: string
  playheadFrame: number
  activeRunId?: string
  activeWorkspace: EditorWorkspace
  renderTickets: RenderTicket[]
  projectPackageTickets: ProjectPackageTicket[]
  otioExportTickets: OtioExportTicket[]
  transcriptWindowStart: number
}

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline'

export type EditorState = {
  initialized: boolean
  busy: boolean
  connection: ConnectionState
  reconnectToken: number
  theme?: Theme
  locale?: Locale
  mediaCapabilities?: MediaCapabilities
  resultPreview?: ResultPreviewOpenPayload
  projects: ProjectSummary[]
  project?: ProjectProjection
  mediaLibrary?: MediaLibraryPageProjection
  selectedItemId?: string
  selectedCaptionId?: string
  selectedAssetId?: string
  playheadFrame: number
  playing: boolean
  media: Record<string, MediaMetadata>
  leases: Record<string, MediaResourceLease>
  activeMediaHandleId?: string
  activeMediaUrl?: string
  revokedHandles: string[]
  script?: { revision: number; digest: string; markdown: string; dirty: boolean }
  agentRun?: AgentRun
  agentEvents: AgentRunEvent[]
  jobs: JobSnapshot[]
  jobEvents: Record<string, JobEvent[]>
  activeWorkspace: EditorWorkspace
  renderTickets: RenderTicket[]
  projectPackageTickets: ProjectPackageTicket[]
  otioExportTickets: OtioExportTicket[]
  otioImportPreview?: OtioImportPreview
  derivedRecords: DerivedMediaRecordProjection[]
  derivedUsage?: DerivedStorageUsageProjection
  derivedRecoveryDiagnostics: string[]
  previewHistory: PreviewHistoryProjection
  previewComparison?: PreviewComparisonProjection
  audioAnalysisCapabilities?: AudioAnalysisCapabilitiesProjection
  denoiseMetadataCapability?: DenoiseMetadataCapabilityProjection
  audioAnalysisRecords: AudioAnalysisRecordProjection[]
  visualProvisioning?: VisualProvisioningProjection
  visualMomentPage?: VisualMomentPageProjection
  mediaIntelligenceOperations: MediaIntelligenceProgressProjection[]
  mediaIntelligenceEvidence?: MediaIntelligenceEvidenceProjection
  speakerAdapters: SpeakerAdapterProjection[]
  speakerIdentities: SpeakerIdentityProjection[]
  speakerAttributionPlan?: SpeakerAttributionPlanProjection
  audioSyncPreview?: AudioSyncPreviewProjection
  generation: GenerationStateProjection
  notices: EditorNotice[]
  lastProjectChange?: ProjectChange
  conflict?: { expectedRevision: number; currentRevision?: number }
  transcriptWindowStart: number
  timelineWindowStart: number
}

export const INITIAL_EDITOR_STATE: EditorState = {
  initialized: false,
  busy: false,
  connection: 'connecting',
  reconnectToken: 0,
  projects: [],
  playheadFrame: 0,
  playing: false,
  media: {},
  leases: {},
  revokedHandles: [],
  agentEvents: [],
  jobs: [],
  jobEvents: {},
  activeWorkspace: 'script',
  renderTickets: [],
  projectPackageTickets: [],
  otioExportTickets: [],
  derivedRecords: [],
  derivedRecoveryDiagnostics: [],
  previewHistory: { schemaVersion: 1, generation: 0, entries: [] },
  audioAnalysisRecords: [],
  speakerAdapters: [],
  speakerIdentities: [],
  mediaIntelligenceOperations: [],
  generation: {
    catalog: { schemaVersion: 1, revision: 'generation-unavailable', generatedAt: new Date(0).toISOString(), providers: [] },
    outcome: 'unavailable',
    records: [],
    recoveryDiagnostics: []
  },
  notices: [],
  transcriptWindowStart: 0,
  timelineWindowStart: 0
}

export type EditorAction =
  | { type: 'initialized'; persisted?: PersistedEditorState }
  | { type: 'busy'; value: boolean }
  | { type: 'connection'; value: ConnectionState }
  | { type: 'reconnect' }
  | { type: 'theme'; value: Theme }
  | { type: 'locale'; value: Locale }
  | { type: 'media-capabilities'; value: MediaCapabilities }
  | { type: 'result-preview'; value: ResultPreviewOpenPayload }
  | { type: 'projects'; value: ProjectSummary[] }
  | { type: 'project'; value: ProjectProjection }
  | { type: 'media-library'; value: MediaLibraryPageProjection }
  | { type: 'clear-project' }
  | {
      type: 'selection-synced'
      projectId: string
      revision: number
      generation: number
      eventGeneration: number
      selection: ProjectProjection['selection']
    }
  | { type: 'selection'; itemId?: string; captionId?: string; assetId?: string }
  | { type: 'seek'; frame: number }
  | { type: 'playing'; value: boolean }
  | { type: 'media'; value: MediaMetadata[] }
  | { type: 'lease'; value: MediaResourceLease }
  | { type: 'lease-release'; handleId: string }
  | { type: 'active-media'; handleId?: string; url?: string }
  | { type: 'media-revoked'; handleId: string }
  | { type: 'script'; revision: number; digest: string; markdown: string }
  | { type: 'script-edit'; markdown: string }
  | { type: 'agent-run'; value?: AgentRun }
  | { type: 'agent-event'; value: AgentRunEvent }
  | { type: 'jobs'; value: JobSnapshot[] }
  | { type: 'job-event'; value: JobEvent }
  | { type: 'active-workspace'; value: EditorWorkspace }
  | { type: 'render-ticket'; value: RenderTicket }
  | { type: 'project-package-ticket'; value: ProjectPackageTicket }
  | { type: 'otio-export-ticket'; value: OtioExportTicket }
  | { type: 'otio-import-preview'; value?: OtioImportPreview }
  | {
      type: 'derived'
      projectId: string
      revision: number
      records: DerivedMediaRecordProjection[]
      usage?: DerivedStorageUsageProjection
      recoveryDiagnostics?: string[]
    }
  | { type: 'derived-record'; value: DerivedMediaRecordProjection }
  | { type: 'preview-history'; projectId: string; value: PreviewHistoryProjection }
  | { type: 'preview-comparison'; projectId: string; value?: PreviewComparisonProjection }
  | {
      type: 'audio-analysis-state'
      projectId: string
      revision: number
      capabilities?: AudioAnalysisCapabilitiesProjection
      denoiseMetadataCapability?: DenoiseMetadataCapabilityProjection
      visualProvisioning?: VisualProvisioningProjection
      visualMomentPage?: VisualMomentPageProjection
      clearVisualMomentPage?: boolean
      records?: AudioAnalysisRecordProjection[]
      operations?: MediaIntelligenceProgressProjection[]
      evidence?: MediaIntelligenceEvidenceProjection
      speakerAdapters?: SpeakerAdapterProjection[]
      speakerIdentities?: SpeakerIdentityProjection[]
      speakerAttributionPlan?: SpeakerAttributionPlanProjection
      clearSpeakerAttributionPlan?: boolean
      syncPreview?: AudioSyncPreviewProjection
      clearSyncPreview?: boolean
    }
  | { type: 'media-intelligence-progress'; value: MediaIntelligenceProgressProjection }
  | { type: 'generation-state'; projectId?: string; value: GenerationStateProjection }
  | { type: 'generation-record'; value: GenerationRecordProjection }
  | { type: 'notice'; value: EditorNotice }
  | { type: 'project-change'; value: ProjectChange }
  | { type: 'dismiss-notice'; id: string }
  | { type: 'conflict'; expectedRevision: number; currentRevision?: number }
  | { type: 'clear-conflict' }
  | { type: 'transcript-window'; start: number }
  | { type: 'timeline-window'; start: number }
