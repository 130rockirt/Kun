import {
  type RuntimeDataRecoveryCandidate,
  type RuntimeDataRecoveryInventory,
  type RuntimeDataRecoveryStatus
} from '../shared/runtime-data-recovery'



export const V2_JOURNAL = 'kun-runtime-data-migration-v2.json'
export const V2_REPORT = 'kun-runtime-data-migration-v2-report.json'
export const V3_JOURNAL = 'kun-runtime-data-migration-v3.json'
export const V3_REPORT = 'kun-runtime-data-migration-v3-report.json'
export const RECOVERY_RECORD_DIR = 'kun-runtime-data-recovery-v1'
export const RECOVERY_TARGET_IDENTITY_PREFIX = '.kun-runtime-recovery-identity-'
export const PROTECTED_IDENTITY_ENTRIES = [
  'credentials',
  'mcp-oauth',
  'extensions/providers.json',
  'extensions/accounts.json',
  'extensions/provider-bindings.json',
  'extensions/legacy-credential-migrations.json',
  'secret.key'
] as const
export const JSON_IDENTITY_ENTRIES = PROTECTED_IDENTITY_ENTRIES.filter((entry) => entry.endsWith('.json'))
export const MIGRATION_STAMP = '\\d{8}T\\d{9}Z(?:-\\d+)?'
export const CURRENT_SIBLING_PATTERN = new RegExp(
  `^data\\.(?:pre-deepseekgui-migration|history-preserving-staging|` +
  `pre-history-preserving-migration|runtime-recovery-staging|pre-runtime-recovery)-` +
  `${MIGRATION_STAMP}\\.bak$`,
  'i'
)
export const LEGACY_SIBLING_PATTERN = new RegExp(
  `^kun\\.(?:cutover-conflict|history-preserving-staging|` +
  `pre-preservation-compatibility-link)-${MIGRATION_STAMP}\\.bak$`,
  'i'
)

export type PathState = 'missing' | 'directory' | 'symlink' | 'file' | 'other' | 'inaccessible'

export type CandidateDescriptor = {
  path: string
  realPath: string
  device: bigint | number
  inode: bigint | number
  fingerprint: string
  automaticRestoreSafe: boolean
  journalVerification?: MigrationJournalVerifiedCandidate
  summary: Omit<RuntimeDataRecoveryCandidate, 'candidateId' | 'equivalentCopies'>
}

export type RecoveryVerifiedCandidate = {
  fingerprint: string
  inventory: RuntimeDataRecoveryInventory
}

export type MigrationJournalVerifiedCandidate = RecoveryVerifiedCandidate & {
  journalPath: string
  journalDigest: string
  sourceThreadIds: string[]
}

export type RecoveryEvidenceInspection = {
  historicalEvidence: boolean
  invalidEvidenceCount: number
  journalReferencedPaths: Set<string>
  journalVerifiedPaths: Map<string, MigrationJournalVerifiedCandidate>
  recoveryVerifiedPaths: Map<string, RecoveryVerifiedCandidate>
}

export type RecoverySnapshot = {
  generation: string
  descriptors: Map<string, CandidateDescriptor>
  status: RuntimeDataRecoveryStatus
  consumed: boolean
}

export type RecoveryLogger = (message: string, detail?: unknown) => void

export type RuntimeDataDirRecoveryOptions = {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
  now?: () => Date
  log?: RecoveryLogger
  assertRuntimeInactive?: (dataDir: string) => void
  /** Deterministic crash/race injection used by native and unit recovery tests. */
  afterTargetActivated?: (targetPath: string) => void
}

export type RuntimeDataRecoveryCompletionCheck =
  | { status: 'none' }
  | {
      status: 'invalid'
      reason: 'record_root_invalid' | 'marker_invalid' | 'target_changed' | 'journal_changed'
    }
  | {
      status: 'valid'
      operationId: string
      action: 'restore' | 'initialize-new-install' | 'start-over'
      completedAt: string
      targetFingerprint: string
      targetIdentityMarkerName: string
      targetIdentityMarkerDigest: string
      supersedesBlockedJournals: boolean
      preservedJournalVersions: Array<2 | 3>
    }

export type RuntimeDataRecoveryAcceptanceCheck =
  | { status: 'none' }
  | {
      status: 'invalid'
      reason:
        | 'completion_missing'
        | 'completion_invalid'
        | 'accepted_record_invalid'
        | 'journal_changed'
        | 'target_changed'
        | 'target_unavailable'
    }
  | {
      status: 'valid'
      operationId: string
      action: 'restore' | 'initialize-new-install' | 'start-over'
      acceptedAt: string
      preservedJournalVersions: Array<2 | 3>
    }

export type RuntimeDataRecoveryErrorCode =
  | 'generation_expired'
  | 'candidate_unknown'
  | 'candidate_changed'
  | 'action_not_allowed'
  | 'active_writer'
  | 'scan_failed'
  | 'copy_failed'
  | 'verification_failed'
  | 'cutover_failed'

export class RuntimeDataRecoveryError extends Error {
  constructor(
    readonly code: RuntimeDataRecoveryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RuntimeDataRecoveryError'
  }
}
