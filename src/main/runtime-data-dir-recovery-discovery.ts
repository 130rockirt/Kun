import {
  readdirSync,
  realpathSync
} from 'node:fs'
import {
  createHash
} from 'node:crypto'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from 'node:path'
import {
  type RuntimeDataRecoveryCandidateKind
} from '../shared/runtime-data-recovery'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  settingsReadCandidates
} from './settings-file-paths'
import {
  type CandidateDescriptor,
  CURRENT_SIBLING_PATTERN,
  LEGACY_SIBLING_PATTERN,
  MIGRATION_STAMP,
  type MigrationJournalVerifiedCandidate,
  type PathState,
  RECOVERY_RECORD_DIR,
  type RecoveryEvidenceInspection,
  type RuntimeDataDirRecoveryOptions,
  V2_JOURNAL,
  V2_REPORT,
  V3_JOURNAL,
  V3_REPORT
} from './runtime-data-dir-recovery-types'
import {
  completedNoHistoryEvidenceIsConsistent,
  inspectRecoveryVerifiedCandidates,
  isCanonicalStringArray,
  isRecognizedFixedPath,
  isStringArray,
  runtimeThreadIds,
  stringArraysEqual,
  validRecordedDate
} from './runtime-data-dir-recovery-evidence'
import {
  inspectCandidate
} from './runtime-data-dir-recovery-candidates'
import {
  validateRuntimeDataRecoveryCompletion
} from './runtime-data-dir-recovery-completion'
import {
  coreInventoriesEqual,
  coreInventory,
  parseCoreInventory
} from './runtime-data-dir-recovery-acceptance'
import {
  errnoCode,
  inventoriesEqual,
  isObject,
  pathKey,
  pathState,
  readBoundedFile,
  samePath
} from './runtime-data-dir-recovery-utils'



export type DiscoveredPath = {
  path: string
  kind: RuntimeDataRecoveryCandidateKind
  state: PathState
  evidence: boolean
}

export function discoverFixedCandidates(homeDir: string, platform: NodeJS.Platform): DiscoveredPath[] {
  const current = canonicalCurrentKunDataDir(homeDir, platform)
  const legacy = canonicalLegacyKunDataDir(homeDir, platform)
  const result: DiscoveredPath[] = [
    discovered(current, 'current', false),
    discovered(legacy, 'legacy', false)
  ]
  for (const [parent, pattern] of [
    [dirname(current), CURRENT_SIBLING_PATTERN],
    [dirname(legacy), LEGACY_SIBLING_PATTERN]
  ] as const) {
    let names: string[] = []
    try {
      names = readdirSync(parent).sort()
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') result.push({ path: parent, kind: 'backup', state: 'inaccessible', evidence: true })
      continue
    }
    for (const name of names) {
      if (!pattern.test(name)) continue
      const kind: RuntimeDataRecoveryCandidateKind = name.includes('staging') ? 'staging' : 'backup'
      result.push(discovered(join(parent, name), kind, true))
    }
  }
  return result
}

export function discovered(path: string, kind: RuntimeDataRecoveryCandidateKind, namedEvidence: boolean): DiscoveredPath {
  const state = pathState(path)
  let evidence = namedEvidence && state !== 'missing'
  if ((kind === 'current' || kind === 'legacy') && state !== 'missing' && state !== 'directory') {
    evidence = true
  }
  if ((kind === 'current' || kind === 'legacy') && state === 'directory') {
    try {
      evidence = readdirSync(path).length > 0
    } catch {
      evidence = true
    }
  }
  return { path, kind, state, evidence }
}

export function inspectKnownJournals(
  options: Pick<RuntimeDataDirRecoveryOptions, 'homeDir' | 'userDataPath'>,
  platform: NodeJS.Platform
): RecoveryEvidenceInspection {
  const journalReferencedPaths = new Set<string>()
  const journalVerifiedPaths = new Map<string, MigrationJournalVerifiedCandidate>()
  let historicalEvidence = false
  let invalidEvidenceCount = 0
  let v3ProvesNoHistory = false
  const current = canonicalCurrentKunDataDir(options.homeDir, platform)
  const legacy = canonicalLegacyKunDataDir(options.homeDir, platform)
  const v2ReportExists = pathState(join(options.userDataPath, V2_REPORT)) !== 'missing'
  const v3ReportExists = pathState(join(options.userDataPath, V3_REPORT)) !== 'missing'
  if (v2ReportExists) historicalEvidence = true
  const recoveryRecords = join(options.userDataPath, RECOVERY_RECORD_DIR)
  if (pathState(recoveryRecords) !== 'missing') {
    const completion = validateRuntimeDataRecoveryCompletion({
      homeDir: options.homeDir,
      userDataPath: options.userDataPath,
      platform
    })
    if (
      completion.status !== 'valid' ||
      completion.action !== 'initialize-new-install' ||
      completion.supersedesBlockedJournals
    ) {
      historicalEvidence = true
    }
  }
  const recoveryInspection = inspectRecoveryVerifiedCandidates(
    options.userDataPath,
    current,
    legacy,
    platform
  )
  invalidEvidenceCount += recoveryInspection.invalidEvidenceCount

  for (const [name, version] of [[V2_JOURNAL, 2], [V3_JOURNAL, 3]] as const) {
    const journalPath = join(options.userDataPath, name)
    const state = pathState(journalPath)
    if (state === 'missing') continue
    if (state !== 'file') {
      historicalEvidence = true
      invalidEvidenceCount += 1
      continue
    }
    try {
      const journalRaw = readBoundedFile(journalPath, 4 * 1024 * 1024)
      const parsed = JSON.parse(journalRaw) as unknown
      if (!isObject(parsed)) throw new Error('journal is not an object')
      const value = parsed
      if (value.schemaVersion !== version || !samePath(String(value.targetPath ?? ''), current, platform)) {
        throw new Error('invalid journal identity')
      }
      const source = String(value.sourcePath ?? '')
      if (!samePath(source, legacy, platform) && !samePath(source, current, platform)) {
        throw new Error('invalid journal source')
      }
      const claimsNoHistory = version === 3 && value.provenance === 'no-legacy-source'
      if (claimsNoHistory) {
        v3ProvesNoHistory = completedNoHistoryEvidenceIsConsistent({
          journal: value,
          reportPath: join(options.userDataPath, V3_REPORT),
          current,
          legacy,
          platform
        })
        if (!v3ProvesNoHistory) {
          historicalEvidence = true
          invalidEvidenceCount += 1
        }
      } else {
        historicalEvidence = true
      }
      const pathValues = version === 2
        ? [value.destinationBackupPath, ...(Array.isArray(value.cutoverConflictBackupPaths) ? value.cutoverConflictBackupPaths : [])]
        : [value.stagingPath, value.destinationBackupPath, value.compatibilityLinkBackupPath]
      for (const candidate of pathValues) {
        if (typeof candidate !== 'string') continue
        if (!isRecognizedFixedPath(candidate, current, legacy, platform)) {
          throw new Error('journal contains an unrecognized path')
        }
        // A path reference alone proves neither the migration phase nor the
        // bytes present at that path. Keep this informational and never use it
        // to admit a staging directory or to authorize automatic recovery.
        journalReferencedPaths.add(pathKey(candidate, platform))
      }
      // Schema v2 records a rename/link state machine and has no staging path
      // or candidate fingerprint, so it can never authorize staging by itself.
      // Its v2-history reconstruction is recoverable only after schema v3 has
      // durably recorded the copied candidate and exact fingerprint.
      if (version === 3 && migrationJournalPhaseCanProveStaging(value)) {
        const proof = inspectMigrationJournalVerifiedCandidate({
          journal: value,
          journalPath,
          journalRaw,
          userDataPath: options.userDataPath,
          current,
          legacy,
          platform
        })
        if (!proof) throw new Error('migration staging proof is incomplete or inconsistent')
        const key = pathKey(String(value.stagingPath), platform)
        const existing = journalVerifiedPaths.get(key)
        if (
          existing &&
          (
            existing.fingerprint !== proof.fingerprint ||
            !inventoriesEqual(existing.inventory, proof.inventory) ||
            existing.journalDigest !== proof.journalDigest
          )
        ) {
          journalVerifiedPaths.delete(key)
          throw new Error('conflicting migration staging proofs')
        }
        journalVerifiedPaths.set(key, proof)
      }
    } catch {
      historicalEvidence = true
      invalidEvidenceCount += 1
    }
  }
  if (v3ReportExists && !v3ProvesNoHistory) historicalEvidence = true
  return {
    historicalEvidence,
    invalidEvidenceCount,
    journalReferencedPaths,
    journalVerifiedPaths,
    recoveryVerifiedPaths: recoveryInspection.paths
  }
}

export const MIGRATION_STAGING_PROOF_PHASES = new Set([
  'candidate-verified',
  'candidate-rebased',
  'destination-backed-up',
  'destination-salvaged',
  'legacy-link-backed-up'
])

export function migrationJournalPhaseCanProveStaging(
  journal: Record<string, unknown>
): boolean {
  return typeof journal.phase === 'string' &&
    MIGRATION_STAGING_PROOF_PHASES.has(journal.phase)
}

export function inspectMigrationJournalVerifiedCandidate(input: {
  journal: Record<string, unknown>
  journalPath: string
  journalRaw: string
  userDataPath: string
  current: string
  legacy: string
  platform: NodeJS.Platform
}): MigrationJournalVerifiedCandidate | null {
  const { journal, current, legacy, platform } = input
  const phase = journal.phase
  const provenance = journal.provenance
  if (
    journal.schemaVersion !== 3 ||
    typeof phase !== 'string' ||
    !MIGRATION_STAGING_PROOF_PHASES.has(phase) ||
    (provenance !== 'original-legacy-source' && provenance !== 'reconstructed-from-current') ||
    (journal.mergeIntoCurrent !== undefined && journal.mergeIntoCurrent !== false)
  ) {
    return null
  }

  const reconstructingV2History = provenance === 'reconstructed-from-current'
  const expectedSource = reconstructingV2History ? current : legacy
  const stagingOriginal = reconstructingV2History ? legacy : current
  const stagingPath = journal.stagingPath
  if (
    typeof journal.sourcePath !== 'string' ||
    !samePath(journal.sourcePath, expectedSource, platform) ||
    typeof journal.targetPath !== 'string' ||
    !samePath(journal.targetPath, current, platform) ||
    typeof stagingPath !== 'string' ||
    !isMigrationOwnedSiblingPath(
      stagingPath,
      stagingOriginal,
      'history-preserving-staging',
      platform
    ) ||
    (
      journal.destinationBackupPath !== undefined &&
      (
        reconstructingV2History ||
        typeof journal.destinationBackupPath !== 'string' ||
        !isMigrationOwnedSiblingPath(
          journal.destinationBackupPath,
          current,
          'pre-history-preserving-migration',
          platform
        )
      )
    ) ||
    (
      journal.compatibilityLinkBackupPath !== undefined &&
      (
        !reconstructingV2History ||
        typeof journal.compatibilityLinkBackupPath !== 'string' ||
        !isMigrationOwnedSiblingPath(
          journal.compatibilityLinkBackupPath,
          legacy,
          'pre-preservation-compatibility-link',
          platform
        )
      )
    ) ||
    !migrationSettingsPathsAreCanonical(journal, input.userDataPath, platform)
  ) {
    return null
  }

  const isReconstructionPhase = phase === 'candidate-verified' || phase === 'legacy-link-backed-up'
  if (
    (reconstructingV2History && !isReconstructionPhase) ||
    (!reconstructingV2History && phase === 'legacy-link-backed-up') ||
    (
      (phase === 'candidate-rebased' ||
        phase === 'destination-backed-up' ||
        phase === 'destination-salvaged') &&
      (!Number.isSafeInteger(journal.extensionRegistryRebasedRecords) ||
        Number(journal.extensionRegistryRebasedRecords) < 0)
    ) ||
    (
      (phase === 'candidate-verified' || phase === 'legacy-link-backed-up') &&
      journal.extensionRegistryRebasedRecords !== undefined
    )
  ) {
    return null
  }

  const sourceInventory = parseCoreInventory(journal.sourceInventory)
  const sourceThreadIds = journal.sourceThreadIds
  const sourceFingerprint = journal.sourceFingerprint
  const candidateFingerprint = journal.candidateFingerprint
  const activationFingerprint = journal.activationFingerprint
  if (
    !sourceInventory ||
    !isCanonicalStringArray(sourceThreadIds) ||
    typeof sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
    candidateFingerprint !== sourceFingerprint ||
    (
      activationFingerprint !== undefined &&
      (
        typeof activationFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(activationFingerprint)
      )
    ) ||
    !Number.isSafeInteger(journal.salvaged) ||
    Number(journal.salvaged) < 0 ||
    !isStringArray(journal.conflicts) ||
    !validRecordedDate(journal.startedAt) ||
    !validRecordedDate(journal.updatedAt) ||
    journal.completedAt !== undefined ||
    journal.runtimeVerifiedAt !== undefined ||
    journal.targetInventory !== undefined ||
    journal.sqliteQuickCheck !== undefined ||
    (journal.error !== undefined && typeof journal.error !== 'string')
  ) {
    return null
  }

  let descriptor: CandidateDescriptor
  try {
    descriptor = inspectCandidate(stagingPath, 'staging', platform)
  } catch {
    return null
  }
  const actualThreadIds = runtimeThreadIds(stagingPath)
  if (
    descriptor.fingerprint !== candidateFingerprint ||
    !coreInventoriesEqual(coreInventory(descriptor.summary.inventory), sourceInventory) ||
    !stringArraysEqual(actualThreadIds, sourceThreadIds)
  ) {
    return null
  }

  return {
    fingerprint: descriptor.fingerprint,
    inventory: descriptor.summary.inventory,
    journalPath: input.journalPath,
    journalDigest: createHash('sha256').update(input.journalRaw).digest('hex'),
    sourceThreadIds: [...sourceThreadIds]
  }
}

export function migrationSettingsPathsAreCanonical(
  journal: Record<string, unknown>,
  userDataPath: string,
  platform: NodeJS.Platform
): boolean {
  const sourcePath = journal.settingsSourcePath
  const writePath = journal.settingsWritePath
  const backupPaths = journal.settingsBackupPaths
  if (
    (sourcePath !== undefined && typeof sourcePath !== 'string') ||
    (writePath !== undefined && typeof writePath !== 'string') ||
    !isStringArray(backupPaths) ||
    ((sourcePath === undefined) !== (writePath === undefined))
  ) {
    return false
  }
  if (typeof sourcePath === 'string') {
    const recognizedSources = settingsReadCandidates(userDataPath)
    if (!recognizedSources.some((candidate) => samePath(candidate, sourcePath, platform))) return false
    if (typeof writePath === 'string' && !samePath(sourcePath, writePath, platform)) {
      try {
        if (
          pathState(sourcePath) !== 'symlink' ||
          !samePath(realpathSync(sourcePath), writePath, platform)
        ) {
          return false
        }
      } catch {
        return false
      }
    }
  }
  if (backupPaths.length > 0 && typeof writePath !== 'string') return false
  return backupPaths.every((backupPath) =>
    typeof backupPath === 'string' &&
    typeof writePath === 'string' &&
    isMigrationOwnedSiblingPath(
      backupPath,
      writePath,
      'pre-runtime-data-migration',
      platform
    ))
}

export function isMigrationOwnedSiblingPath(
  candidate: string,
  original: string,
  label: string,
  platform: NodeJS.Platform
): boolean {
  if (!isAbsolute(candidate) || !isAbsolute(original)) return false
  const resolved = resolve(candidate)
  if (!samePath(dirname(resolved), dirname(resolve(original)), platform)) return false
  const escapedOriginalName = basename(resolve(original)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^${escapedOriginalName}\\.${label}-${MIGRATION_STAMP}\\.bak$`,
    'i'
  ).test(basename(resolved))
}
