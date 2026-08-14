import type { VideoEngineErrorCode } from './errors.js'
import type {
  Rational,
  RevisionAuthor,
  TimelineOperation,
  VideoProject
} from './schema.js'

export type CreateProjectInput = {
  id: string
  name: string
  fps?: Rational
  canvasPreset?: VideoProject['canvas']['preset']
}

export type ImportProjectInput = {
  project: VideoProject
  targetProjectId: string
  expectedSourceProjectId: string
  expectedSourceRevision: number
  sourceDocumentDigest: string
}

export type CommitMetadata = {
  author: RevisionAuthor
  actorId?: string
  transactionId?: string
  sourceOperation: string
  summary: string
  operations?: TimelineOperation[]
  inverseOperations?: TimelineOperation[]
  restoredFromRevision?: number
}

export type ProjectSummary = {
  id: string
  name: string
  currentRevision: number
  updatedAt: string
  durationFrames: number
}

export type ProjectDiagnostic = {
  id: string
  code: VideoEngineErrorCode
}

export type ProjectListResult = {
  projects: ProjectSummary[]
  diagnostics: ProjectDiagnostic[]
}

export type ProjectServiceOptions = {
  historyLimit?: number
  now?: () => Date
  commitPhaseHook?: (phase: 'pending' | 'snapshot' | 'project' | 'timeline') => void | Promise<void>
  sourceProbe?: (asset: VideoProject['assets'][number]) => Promise<{
    availability: NonNullable<VideoProject['assets'][number]['availability']>
    sourceIdentity?: VideoProject['assets'][number]['sourceIdentity']
  }>
}

export type PendingProjectCommit = {
  schemaVersion: 1
  projectId: string
  previousRevision: number
  project: VideoProject
}
