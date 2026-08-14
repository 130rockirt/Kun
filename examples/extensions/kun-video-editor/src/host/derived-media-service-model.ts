import type { JsonObject } from '@kun/extension-api'
import type {
  BrokeredDerivedKind,
  DerivedMediaPriority,
  DerivedMediaStoreOptions,
  VideoProject
} from '../engine/index.js'

export type DerivedMediaStartInput = {
  project: VideoProject
  assetId: string
  kind: BrokeredDerivedKind
  /** Optional persistent export grant. Omitted derived outputs use Host-owned cache targets. */
  outputHandleId?: string
  priority?: DerivedMediaPriority
  normalizedParameters?: Readonly<Record<string, unknown>>
  retryRecordId?: string
}

export type DerivedMediaListResult = {
  records: JsonObject[]
  usage: JsonObject
  recoveryDiagnostics: string[]
}

export type DerivedMediaServiceOptions = {
  /** Test/embedding seam; production loads the authoritative workspace project. */
  loadProject?: (projectId: string) => Promise<VideoProject | undefined>
  store?: Pick<DerivedMediaStoreOptions, 'quotaBytes' | 'maxRecords' | 'now'>
}

export type PendingStage = {
  id: 'partial' | 'final'
  outputHandleId: string
  partial: boolean
}

export type PendingOutput = {
  schemaVersion: 3
  recordId: string
  sourceHandleId: string
  pinnedRevision: number
  stages: PendingStage[]
  stageIndex: number
  durationUs: number
  createdAt: string
}
