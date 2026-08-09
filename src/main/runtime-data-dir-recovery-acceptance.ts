import {
  lstatSync,
  readlinkSync
} from 'node:fs'
import {
  createHash
} from 'node:crypto'
import {
  dirname,
  join
} from 'node:path'
import {
  type RuntimeDataRecoveryInventory
} from '../shared/runtime-data-recovery'
import {
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  type PathState,
  RECOVERY_TARGET_IDENTITY_PREFIX,
  V2_JOURNAL,
  V3_JOURNAL
} from './runtime-data-dir-recovery-types'
import {
  isRecognizedFixedPath
} from './runtime-data-dir-recovery-evidence'
import {
  fingerprintTree,
  hashFile
} from './runtime-data-dir-recovery-candidates'
import {
  type MigrationJournalEvidence
} from './runtime-data-dir-recovery-records'
import {
  isObject,
  pathState,
  readBoundedFile,
  samePath
} from './runtime-data-dir-recovery-utils'



export function completedRecordMatches(
  completion: Record<string, unknown> | null,
  accepted: Record<string, unknown>,
  operationId: string,
  targetPath: string,
  platform: NodeJS.Platform
): boolean {
  if (
    !completion ||
    completion.schemaVersion !== 1 ||
    completion.phase !== 'completed' ||
    completion.operationId !== operationId ||
    completion.action !== accepted.action ||
    typeof completion.targetPath !== 'string' ||
    !samePath(completion.targetPath, targetPath, platform) ||
    typeof completion.targetFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(completion.targetFingerprint) ||
    completion.targetIdentityMarkerName !== accepted.targetIdentityMarkerName ||
    completion.targetIdentityMarkerDigest !== accepted.targetIdentityMarkerDigest ||
    !parseCoreInventory(completion.targetInventory)
  ) {
    return false
  }
  const completionJournals = parseMigrationJournalEvidence(completion.blockedJournalEvidence)
  const acceptedJournals = parseMigrationJournalEvidence(accepted.journalEvidence)
  return Boolean(
    completionJournals &&
    acceptedJournals &&
    journalEvidenceEqual(completionJournals, acceptedJournals)
  )
}

export function preparedRecordMatches(
  prepared: Record<string, unknown> | null,
  accepted: Record<string, unknown>
): boolean {
  if (!prepared || prepared.phase !== 'prepared') return false
  for (const key of [
    'schemaVersion',
    'operationId',
    'acceptanceId',
    'action',
    'targetPath',
    'targetIdentityMarkerName',
    'targetIdentityMarkerDigest',
    'completionDigest'
  ] as const) {
    if (prepared[key] !== accepted[key]) return false
  }
  const preparedJournals = parseMigrationJournalEvidence(prepared.journalEvidence)
  const acceptedJournals = parseMigrationJournalEvidence(accepted.journalEvidence)
  return Boolean(
    preparedJournals &&
    acceptedJournals &&
    journalEvidenceEqual(preparedJournals, acceptedJournals)
  )
}

export function regularFileDigestMatches(path: string, expected: unknown): boolean {
  try {
    return typeof expected === 'string' && pathState(path) === 'file' && hashFile(path) === expected
  } catch {
    return false
  }
}

export function recoveryTargetIdentityMarkerMatches(
  targetPath: string,
  operationId: string,
  markerName: unknown,
  expectedDigest: unknown
): boolean {
  if (
    markerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
    typeof expectedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedDigest)
  ) return false
  const markerPath = join(targetPath, markerName)
  const marker = readJsonObject(markerPath)
  return Boolean(
    marker &&
    marker.schemaVersion === 1 &&
    marker.operationId === operationId &&
    typeof marker.token === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.token) &&
    regularFileDigestMatches(markerPath, expectedDigest)
  )
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (pathState(path) !== 'file') return null
    const value = JSON.parse(readBoundedFile(path, 16 * 1024 * 1024)) as unknown
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function validRecordedRecoveryPaths(
  marker: Record<string, unknown>,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const legacy = canonicalLegacyKunDataDir(dirname(dirname(current)), platform)
  for (const key of ['sourcePath', 'stagingPath', 'destinationBackupPath'] as const) {
    const value = marker[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !isRecognizedFixedPath(value, current, legacy, platform)) return false
  }
  if (
    typeof marker.destinationBackupPath === 'string' &&
    pathState(marker.destinationBackupPath) === 'missing'
  ) {
    return false
  }
  return true
}

export function migrationJournalEvidence(userDataPath: string): MigrationJournalEvidence[] {
  const result: MigrationJournalEvidence[] = []
  for (const [name, version] of [[V2_JOURNAL, 2], [V3_JOURNAL, 3]] as const) {
    const path = join(userDataPath, name)
    const state = pathState(path)
    if (state === 'missing') continue
    result.push({ version, state, digest: filesystemEvidenceDigest(path, state) })
  }
  return result
}

export function filesystemEvidenceDigest(path: string, state: Exclude<PathState, 'missing'>): string {
  const hash = createHash('sha256')
  hash.update(`${state}\0`)
  try {
    if (state === 'file') {
      hash.update(hashFile(path))
    } else if (state === 'directory') {
      hash.update(fingerprintTree(path).fingerprint)
    } else if (state === 'symlink') {
      hash.update(readlinkSync(path))
    } else if (state === 'other') {
      const metadata = lstatSync(path)
      hash.update(`${metadata.mode}\0${metadata.size}`)
    } else {
      hash.update('unreadable')
    }
  } catch {
    hash.update('unreadable')
  }
  return hash.digest('hex')
}

export function parseMigrationJournalEvidence(value: unknown): MigrationJournalEvidence[] | null {
  if (!Array.isArray(value) || value.length > 2) return null
  const seen = new Set<number>()
  const result: MigrationJournalEvidence[] = []
  for (const entry of value) {
    if (
      !isObject(entry) ||
      (entry.version !== 2 && entry.version !== 3) ||
      seen.has(entry.version) ||
      (
        entry.state !== 'directory' &&
        entry.state !== 'symlink' &&
        entry.state !== 'file' &&
        entry.state !== 'other' &&
        entry.state !== 'inaccessible'
      ) ||
      typeof entry.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.digest)
    ) {
      return null
    }
    seen.add(entry.version)
    result.push({ version: entry.version, state: entry.state, digest: entry.digest })
  }
  return result.sort((left, right) => left.version - right.version)
}

export function journalEvidenceEqual(
  left: readonly MigrationJournalEvidence[],
  right: readonly MigrationJournalEvidence[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.version === right[index]?.version &&
    entry.state === right[index]?.state &&
    entry.digest === right[index]?.digest)
}

export function parseCoreInventory(
  value: unknown
): Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'> | null {
  if (!isObject(value)) return null
  const keys = ['files', 'directories', 'symlinks', 'bytes'] as const
  if (!keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) return null
  return {
    files: Number(value.files),
    directories: Number(value.directories),
    symlinks: Number(value.symlinks),
    bytes: Number(value.bytes)
  }
}

export function coreInventory(
  value: RuntimeDataRecoveryInventory
): Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'> {
  return {
    files: value.files,
    directories: value.directories,
    symlinks: value.symlinks,
    bytes: value.bytes
  }
}

export function coreInventoriesEqual(
  left: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>,
  right: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>
): boolean {
  return left.files === right.files &&
    left.directories === right.directories &&
    left.symlinks === right.symlinks &&
    left.bytes === right.bytes
}
