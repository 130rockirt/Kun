import type {
  ExtensionHostClient,
  JobSnapshot,
  JsonObject,
  MediaResourceLease
} from '@kun/extension-api'
import type {
  DerivedMediaRecordProjection,
  EditorAction,
  EditorNotice,
  EditorState,
  MediaLibraryPageProjection,
  OtioExportTicket,
  ProjectPackageTicket,
  ProjectProjection,
  ProjectSummary
} from './model.js'
import type { MessageKey } from './i18n.js'

type CurrentRef<T> = { current: T }

export type EditorActionContext = {
  client: ExtensionHostClient
  dispatch(action: EditorAction): void
  stateRef: CurrentRef<EditorState>
  ownedLeaseIds: CurrentRef<Set<string>>
  derivedLeaseCache: CurrentRef<Map<string, MediaResourceLease>>
  derivedLeaseRequests: CurrentRef<Map<string, Promise<MediaResourceLease>>>
  pendingOtioImportHandle: CurrentRef<string | undefined>
  activeProjectResolutionGeneration: CurrentRef<number>
  projectLoadGeneration: CurrentRef<number>
  mediaLibraryLoadGeneration: CurrentRef<number>
  openMediaHandleRef: CurrentRef<((handleId: string) => Promise<void>) | undefined>
  copy(key: MessageKey, values?: Readonly<Record<string, string | number>>): string
  pushNotice(notice: Omit<EditorNotice, 'id'> & { id?: string }): void
  execute(action: string, payload?: JsonObject): Promise<Record<string, unknown>>
  releaseAllLeases(): Promise<void>
  loadDerived(projectId: string, expectedRevision?: number): Promise<void>
  loadPreviewHistory(projectId: string): Promise<void>
  loadMediaIntelligence(projectId: string, expectedRevision: number, preferredAssetId?: string): Promise<void>
  loadGeneration(projectId: string): Promise<void>
  loadProject(projectId: string): Promise<ProjectProjection>
  loadMediaLibraryPage(options?: {
    folderId?: string
    query?: string
    offset?: number
    limit?: number
  }): Promise<void>
  loadProjects(): Promise<ProjectSummary[]>
  loadProjectPackageSnapshot(ticket: ProjectPackageTicket): Promise<JobSnapshot>
  loadOtioExportSnapshot(ticket: OtioExportTicket): Promise<JobSnapshot>
  refreshJobs(
    packageTickets?: ProjectPackageTicket[],
    otioTickets?: OtioExportTicket[]
  ): Promise<JobSnapshot[]>
  withBusy(operation: () => Promise<void>): Promise<void>
}

export type EditorMediaActions = {
  openMediaHandle(handleId: string): Promise<void>
  openPassiveMediaHandle(handleId: string): Promise<string>
  openAsset(assetId: string): Promise<void>
  openDerivedResource(recordId: string): Promise<string | undefined>
}

export type EditorMediaActionContext = EditorActionContext & EditorMediaActions

export type EditorIntelligenceActions = {
  startDerivedRequest(
    kind: 'waveform' | 'thumbnail' | 'filmstrip' | 'proxy',
    record?: DerivedMediaRecordProjection
  ): Promise<void>
}
