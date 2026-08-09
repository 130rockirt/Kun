import {
  readdirSync
} from 'node:fs'
import {
  createHash
} from 'node:crypto'
import {
  basename,
  dirname,
  join,
  resolve
} from 'node:path'
import {
  type RuntimeDataRecoveryInventory,
  RuntimeDataRecoveryInventorySchema
} from '../shared/runtime-data-recovery'
import {
  CURRENT_SIBLING_PATTERN,
  LEGACY_SIBLING_PATTERN,
  RECOVERY_RECORD_DIR,
  type RecoveryVerifiedCandidate
} from './runtime-data-dir-recovery-types'
import {
  fingerprintTree
} from './runtime-data-dir-recovery-candidates'
import {
  coreInventoriesEqual,
  isUuid,
  parseCoreInventory,
  parseMigrationJournalEvidence,
  readJsonObject
} from './runtime-data-dir-recovery-acceptance'
import {
  inventoriesEqual,
  pathKey,
  pathState,
  samePath
} from './runtime-data-dir-recovery-utils'



export function isCanonicalStringArray(value: unknown): value is string[] {
  if (!isStringArray(value) || new Set(value).size !== value.length) return false
  return stringArraysEqual(value, [...value].sort())
}

export function runtimeThreadIds(rootPath: string): string[] {
  const threadsPath = join(rootPath, 'threads')
  if (pathState(threadsPath) !== 'directory') return []
  return readdirSync(threadsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

export function inspectRecoveryVerifiedCandidates(
  userDataPath: string,
  current: string,
  legacy: string,
  platform: NodeJS.Platform
): { paths: Map<string, RecoveryVerifiedCandidate>; invalidEvidenceCount: number } {
  const paths = new Map<string, RecoveryVerifiedCandidate>()
  const recordRoot = join(userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { paths, invalidEvidenceCount: 0 }
  if (rootState !== 'directory') return { paths, invalidEvidenceCount: 1 }

  let invalidEvidenceCount = 0
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!isUuid(operationId)) {
      invalidEvidenceCount += 1
      continue
    }
    const operationDir = join(recordRoot, operationId)
    if (pathState(operationDir) !== 'directory') {
      invalidEvidenceCount += 1
      continue
    }
    const verifiedPath = join(operationDir, '020-verified.json')
    const state = pathState(verifiedPath)
    if (state === 'missing') continue
    if (state !== 'file') {
      invalidEvidenceCount += 1
      continue
    }
    const record = readJsonObject(verifiedPath)
    const inventory = RuntimeDataRecoveryInventorySchema.safeParse(record?.stagingInventory)
    const sourceFingerprint = record?.sourceFingerprint
    const stagingFingerprint = record?.stagingFingerprint
    const stagingPath = record?.stagingPath
    const sourcePath = record?.sourcePath
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.operationId !== operationId ||
      record.phase !== 'verified' ||
      record.action !== 'restore' ||
      typeof sourcePath !== 'string' ||
      !isRecognizedFixedPath(sourcePath, current, legacy, platform) ||
      typeof record.targetPath !== 'string' ||
      !samePath(record.targetPath, current, platform) ||
      typeof stagingPath !== 'string' ||
      !isRuntimeRecoveryStagingPath(stagingPath, current, platform) ||
      typeof sourceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
      stagingFingerprint !== sourceFingerprint ||
      !inventory.success ||
      !parseMigrationJournalEvidence(record.blockedJournalEvidence)
    ) {
      invalidEvidenceCount += 1
      continue
    }
    const key = pathKey(stagingPath, platform)
    const proof = { fingerprint: stagingFingerprint, inventory: inventory.data }
    const existing = paths.get(key)
    if (
      existing &&
      (existing.fingerprint !== proof.fingerprint || !inventoriesEqual(existing.inventory, proof.inventory))
    ) {
      paths.delete(key)
      invalidEvidenceCount += 1
      continue
    }
    paths.set(key, proof)
  }
  return { paths, invalidEvidenceCount }
}

export function isRuntimeRecoveryStagingPath(
  candidate: string,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const resolved = resolve(candidate)
  return samePath(dirname(resolved), dirname(current), platform) &&
    /^data\.runtime-recovery-staging-\d{8}T\d{9}Z(?:-\d+)?\.bak$/i.test(basename(resolved))
}

export function completedNoHistoryEvidenceIsConsistent(input: {
  journal: Record<string, unknown>
  reportPath: string
  current: string
  legacy: string
  platform: NodeJS.Platform
}): boolean {
  const { journal, current, legacy, platform } = input
  const report = readJsonObject(input.reportPath)
  const sourceInventory = parseCoreInventory(journal.sourceInventory)
  const targetInventory = parseCoreInventory(journal.targetInventory)
  const sourceFingerprint = createHash('sha256').update('no-legacy-source').digest('hex')
  const candidateFingerprint = journal.candidateFingerprint
  const settingsBackupPaths = journal.settingsBackupPaths
  const sourceThreadIds = journal.sourceThreadIds
  const conflicts = journal.conflicts
  const completedAt = journal.completedAt
  if (
    journal.schemaVersion !== 3 ||
    journal.phase !== 'completed' ||
    journal.provenance !== 'no-legacy-source' ||
    typeof journal.sourcePath !== 'string' ||
    !samePath(journal.sourcePath, legacy, platform) ||
    typeof journal.targetPath !== 'string' ||
    !samePath(journal.targetPath, current, platform) ||
    typeof journal.stagingPath !== 'string' ||
    !isHistoryPreservingStagingPath(journal.stagingPath, current, platform) ||
    journal.destinationBackupPath !== undefined ||
    journal.compatibilityLinkBackupPath !== undefined ||
    (journal.settingsSourcePath !== undefined && typeof journal.settingsSourcePath !== 'string') ||
    (journal.settingsWritePath !== undefined && typeof journal.settingsWritePath !== 'string') ||
    !isStringArray(settingsBackupPaths) ||
    !Array.isArray(sourceThreadIds) || sourceThreadIds.length !== 0 ||
    !sourceInventory || !isEmptyCoreInventory(sourceInventory) ||
    journal.sourceFingerprint !== sourceFingerprint ||
    typeof candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidateFingerprint) ||
    journal.salvaged !== 0 ||
    !Array.isArray(conflicts) || conflicts.length !== 0 ||
    !targetInventory ||
    !validSqliteCheck(journal.sqliteQuickCheck) ||
    !validRecordedDate(journal.startedAt) ||
    !validRecordedDate(journal.updatedAt) ||
    typeof completedAt !== 'string' || !validRecordedDate(completedAt) ||
    pathState(legacy) !== 'missing' ||
    !report
  ) {
    return false
  }

  let target: ReturnType<typeof fingerprintTree>
  try {
    target = fingerprintTree(current)
  } catch {
    return false
  }
  if (
    target.fingerprint !== candidateFingerprint ||
    !coreInventoriesEqual(target.inventory, targetInventory)
  ) {
    return false
  }

  const reportSourceInventory = parseCoreInventory(report.sourceInventory)
  const reportTargetInventory = parseCoreInventory(report.targetInventory)
  return report.schemaVersion === 3 &&
    report.status === 'completed' &&
    report.provenance === 'no-legacy-source' &&
    typeof report.sourcePath === 'string' && samePath(report.sourcePath, legacy, platform) &&
    typeof report.targetPath === 'string' && samePath(report.targetPath, current, platform) &&
    report.stagingPath === journal.stagingPath &&
    report.destinationBackupPath === undefined &&
    report.compatibilityLinkBackupPath === undefined &&
    report.settingsSourcePath === journal.settingsSourcePath &&
    isStringArray(report.settingsBackupPaths) &&
    stringArraysEqual(report.settingsBackupPaths, settingsBackupPaths) &&
    report.sourceThreadCount === 0 &&
    Boolean(reportSourceInventory && coreInventoriesEqual(reportSourceInventory, sourceInventory)) &&
    report.sourceFingerprint === sourceFingerprint &&
    report.candidateFingerprint === candidateFingerprint &&
    report.salvaged === 0 &&
    Array.isArray(report.conflicts) && report.conflicts.length === 0 &&
    Boolean(reportTargetInventory && coreInventoriesEqual(reportTargetInventory, targetInventory)) &&
    report.sqliteQuickCheck === journal.sqliteQuickCheck &&
    report.completedAt === completedAt &&
    report.exactPreMigrationSnapshot === true &&
    report.sourceExisted === false
}

export function isHistoryPreservingStagingPath(
  candidate: string,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const resolved = resolve(candidate)
  return samePath(dirname(resolved), dirname(current), platform) &&
    /^data\.history-preserving-staging-\d{8}T\d{9}Z(?:-\d+)?\.bak$/i.test(basename(resolved))
}

export function validRecordedDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function validSqliteCheck(value: unknown): boolean {
  return value === 'missing' || value === 'ok' || value === 'invalid'
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export function isEmptyCoreInventory(
  inventory: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>
): boolean {
  return inventory.files === 0 && inventory.symlinks === 0 && inventory.bytes === 0 &&
    (inventory.directories === 0 || inventory.directories === 1)
}

export function isRecognizedFixedPath(
  path: string,
  current: string,
  legacy: string,
  platform: NodeJS.Platform
): boolean {
  if (samePath(path, current, platform) || samePath(path, legacy, platform)) return true
  const resolvedPath = resolve(path)
  const name = basename(resolvedPath)
  if (samePath(dirname(resolvedPath), dirname(current), platform)) return CURRENT_SIBLING_PATTERN.test(name)
  if (samePath(dirname(resolvedPath), dirname(legacy), platform)) return LEGACY_SIBLING_PATTERN.test(name)
  return false
}
