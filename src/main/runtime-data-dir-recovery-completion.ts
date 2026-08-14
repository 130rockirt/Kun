import {
  mkdirSync,
  readdirSync
} from 'node:fs'
import {
  randomUUID
} from 'node:crypto'
import {
  basename,
  dirname,
  join
} from 'node:path'
import {
  canonicalCurrentKunDataDir
} from './kun-data-dir-paths'
import {
  RECOVERY_RECORD_DIR,
  RECOVERY_TARGET_IDENTITY_PREFIX,
  type RuntimeDataRecoveryAcceptanceCheck,
  type RuntimeDataRecoveryCompletionCheck
} from './runtime-data-dir-recovery-types'
import {
  fingerprintTree,
  hashFile
} from './runtime-data-dir-recovery-candidates'
import {
  writeDurableJson
} from './runtime-data-dir-recovery-records'
import {
  completedRecordMatches,
  coreInventoriesEqual,
  isUuid,
  journalEvidenceEqual,
  migrationJournalEvidence,
  parseCoreInventory,
  parseMigrationJournalEvidence,
  preparedRecordMatches,
  readJsonObject,
  recoveryTargetIdentityMarkerMatches,
  regularFileDigestMatches,
  validRecordedRecoveryPaths
} from './runtime-data-dir-recovery-acceptance'
import {
  isObject,
  pathState,
  readBoundedFile,
  samePath
} from './runtime-data-dir-recovery-utils'



/**
 * Validates an immutable recovery completion record against both the current
 * canonical tree and the exact v2/v3 journal bytes that were preserved when
 * recovery began. Migration startup may supersede an otherwise-blocking old
 * journal only when this returns `valid` with `supersedesBlockedJournals`.
 */
export function validateRuntimeDataRecoveryCompletion(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
}): RuntimeDataRecoveryCompletionCheck {
  const platform = input.platform ?? process.platform
  const recordRoot = join(input.userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { status: 'none' }
  if (rootState !== 'directory') return { status: 'invalid', reason: 'record_root_invalid' }

  const completionPaths: string[] = []
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      continue
    }
    const path = join(recordRoot, operationId, '040-completed.json')
    if (pathState(path) !== 'missing') completionPaths.push(path)
  }
  if (completionPaths.length === 0) return { status: 'none' }

  const currentTarget = canonicalCurrentKunDataDir(input.homeDir, platform)
  const currentJournals = migrationJournalEvidence(input.userDataPath)
  let sawTargetChange = false
  let sawJournalChange = false
  for (const markerPath of completionPaths.reverse()) {
    let marker: Record<string, unknown>
    try {
      if (pathState(markerPath) !== 'file') throw new Error('completion marker is not a file')
      const parsed = JSON.parse(readBoundedFile(markerPath, 16 * 1024 * 1024)) as unknown
      if (!isObject(parsed)) throw new Error('completion marker is not an object')
      marker = parsed
    } catch {
      continue
    }
    const operationId = basename(dirname(markerPath))
    const action = marker.action
    const completedAt = marker.recordedAt
    const targetFingerprint = marker.targetFingerprint
    const targetIdentityMarkerName = marker.targetIdentityMarkerName
    const targetIdentityMarkerDigest = marker.targetIdentityMarkerDigest
    if (
      marker.schemaVersion !== 1 ||
      marker.phase !== 'completed' ||
      marker.operationId !== operationId ||
      (action !== 'restore' && action !== 'initialize-new-install' && action !== 'start-over') ||
      typeof completedAt !== 'string' ||
      !Number.isFinite(Date.parse(completedAt)) ||
      typeof targetFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(targetFingerprint) ||
      typeof targetIdentityMarkerName !== 'string' ||
      targetIdentityMarkerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
      typeof targetIdentityMarkerDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(targetIdentityMarkerDigest) ||
      typeof marker.targetPath !== 'string' ||
      !samePath(marker.targetPath, currentTarget, platform) ||
      !validRecordedRecoveryPaths(marker, currentTarget, platform)
    ) {
      continue
    }
    const recordedInventory = parseCoreInventory(marker.targetInventory)
    const recordedJournals = parseMigrationJournalEvidence(marker.blockedJournalEvidence)
    if (!recordedInventory || !recordedJournals) continue

    let currentTargetState: ReturnType<typeof fingerprintTree>
    try {
      currentTargetState = fingerprintTree(currentTarget)
    } catch {
      sawTargetChange = true
      continue
    }
    if (
      currentTargetState.fingerprint !== targetFingerprint ||
      !coreInventoriesEqual(currentTargetState.inventory, recordedInventory)
    ) {
      sawTargetChange = true
      continue
    }
    if (!journalEvidenceEqual(recordedJournals, currentJournals)) {
      sawJournalChange = true
      continue
    }
    if (!recoveryTargetIdentityMarkerMatches(
      currentTarget,
      operationId,
      targetIdentityMarkerName,
      targetIdentityMarkerDigest
    )) {
      sawTargetChange = true
      continue
    }
    return {
      status: 'valid',
      operationId,
      action,
      completedAt,
      targetFingerprint,
      targetIdentityMarkerName,
      targetIdentityMarkerDigest,
      supersedesBlockedJournals: recordedJournals.length > 0,
      preservedJournalVersions: recordedJournals.map((entry) => entry.version)
    }
  }
  return {
    status: 'invalid',
    reason: sawTargetChange
      ? 'target_changed'
      : sawJournalChange ? 'journal_changed' : 'marker_invalid'
  }
}

/**
 * Performs the one-time full target verification before managed Runtime
 * writers start, then seals that decision in immutable two-phase records.
 * The caller must hold the shared migration/startup lock for this call.
 */
export function acceptRuntimeDataRecoveryCompletion(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
  now?: () => Date
}): RuntimeDataRecoveryAcceptanceCheck {
  const existing = validateAcceptedRuntimeDataRecovery(input)
  if (existing.status === 'valid') return existing

  const completion = validateRuntimeDataRecoveryCompletion(input)
  if (completion.status === 'none') return { status: 'invalid', reason: 'completion_missing' }
  if (completion.status !== 'valid') {
    return { status: 'invalid', reason: 'completion_invalid' }
  }

  const platform = input.platform ?? process.platform
  const now = input.now ?? (() => new Date())
  const operationDir = join(input.userDataPath, RECOVERY_RECORD_DIR, completion.operationId)
  const completionPath = join(operationDir, '040-completed.json')
  const acceptanceId = randomUUID()
  const acceptanceDir = join(operationDir, `acceptance-${acceptanceId}`)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const journals = migrationJournalEvidence(input.userDataPath)
  const base = {
    schemaVersion: 1,
    operationId: completion.operationId,
    acceptanceId,
    action: completion.action,
    targetPath,
    targetIdentityMarkerName: completion.targetIdentityMarkerName,
    targetIdentityMarkerDigest: completion.targetIdentityMarkerDigest,
    completionDigest: hashFile(completionPath),
    journalEvidence: journals
  }
  mkdirSync(acceptanceDir, { recursive: true, mode: 0o700 })
  const preparedPath = join(acceptanceDir, '000-prepared.json')
  writeDurableJson(preparedPath, {
    ...base,
    phase: 'prepared',
    preparedAt: now().toISOString()
  })

  // Re-run the expensive verification after the prepared record is durable.
  // A shared migration/startup lock closes the remaining writer race before
  // the accepted seal is written.
  const revalidated = validateRuntimeDataRecoveryCompletion(input)
  if (
    revalidated.status !== 'valid' ||
    revalidated.operationId !== completion.operationId ||
    revalidated.targetFingerprint !== completion.targetFingerprint
  ) {
    return { status: 'invalid', reason: 'completion_invalid' }
  }
  writeDurableJson(join(acceptanceDir, '010-accepted.json'), {
    ...base,
    phase: 'accepted',
    preparedDigest: hashFile(preparedPath),
    acceptedAt: now().toISOString()
  })
  return validateAcceptedRuntimeDataRecovery(input)
}

/**
 * Fast post-acceptance validation. It intentionally does not fingerprint the
 * Runtime tree because normal Runtime writes are expected after acceptance.
 */
export function validateAcceptedRuntimeDataRecovery(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
}): RuntimeDataRecoveryAcceptanceCheck {
  const platform = input.platform ?? process.platform
  const recordRoot = join(input.userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { status: 'none' }
  if (rootState !== 'directory') return { status: 'invalid', reason: 'accepted_record_invalid' }

  const acceptedPaths: string[] = []
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!isUuid(operationId)) continue
    const operationDir = join(recordRoot, operationId)
    if (pathState(operationDir) !== 'directory') continue
    for (const name of readdirSync(operationDir).sort()) {
      if (!/^acceptance-[0-9a-f-]{36}$/i.test(name)) continue
      const acceptanceId = name.slice('acceptance-'.length)
      if (!isUuid(acceptanceId)) continue
      const acceptedPath = join(operationDir, name, '010-accepted.json')
      if (pathState(acceptedPath) !== 'missing') acceptedPaths.push(acceptedPath)
    }
  }
  if (acceptedPaths.length === 0) return { status: 'none' }

  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const currentJournals = migrationJournalEvidence(input.userDataPath)
  let sawJournalChange = false
  let sawTargetChange = false
  let sawTargetUnavailable = false
  for (const acceptedPath of acceptedPaths.reverse()) {
    const accepted = readJsonObject(acceptedPath)
    if (!accepted) continue
    const acceptanceDir = dirname(acceptedPath)
    const operationDir = dirname(acceptanceDir)
    const operationId = basename(operationDir)
    const acceptanceId = basename(acceptanceDir).slice('acceptance-'.length)
    const action = accepted.action
    const acceptedAt = accepted.acceptedAt
    if (
      accepted.schemaVersion !== 1 ||
      accepted.phase !== 'accepted' ||
      accepted.operationId !== operationId ||
      accepted.acceptanceId !== acceptanceId ||
      (action !== 'restore' && action !== 'initialize-new-install' && action !== 'start-over') ||
      typeof acceptedAt !== 'string' ||
      !Number.isFinite(Date.parse(acceptedAt)) ||
      typeof accepted.targetPath !== 'string' ||
      !samePath(accepted.targetPath, targetPath, platform) ||
      typeof accepted.targetIdentityMarkerName !== 'string' ||
      accepted.targetIdentityMarkerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
      typeof accepted.targetIdentityMarkerDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.targetIdentityMarkerDigest) ||
      typeof accepted.completionDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.completionDigest) ||
      typeof accepted.preparedDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.preparedDigest)
    ) {
      continue
    }
    const journals = parseMigrationJournalEvidence(accepted.journalEvidence)
    if (!journals) continue
    const preparedPath = join(acceptanceDir, '000-prepared.json')
    const completionPath = join(operationDir, '040-completed.json')
    const completionRecord = readJsonObject(completionPath)
    if (
      !regularFileDigestMatches(preparedPath, accepted.preparedDigest) ||
      !regularFileDigestMatches(completionPath, accepted.completionDigest) ||
      !preparedRecordMatches(readJsonObject(preparedPath), accepted) ||
      !completedRecordMatches(completionRecord, accepted, operationId, targetPath, platform)
    ) {
      continue
    }
    if (!journalEvidenceEqual(journals, currentJournals)) {
      sawJournalChange = true
      continue
    }
    if (pathState(targetPath) !== 'directory') {
      sawTargetUnavailable = true
      continue
    }
    if (!recoveryTargetIdentityMarkerMatches(
      targetPath,
      operationId,
      accepted.targetIdentityMarkerName,
      accepted.targetIdentityMarkerDigest
    )) {
      sawTargetChange = true
      continue
    }
    return {
      status: 'valid',
      operationId,
      action,
      acceptedAt,
      preservedJournalVersions: journals.map((entry) => entry.version)
    }
  }
  return {
    status: 'invalid',
    reason: sawJournalChange
      ? 'journal_changed'
      : sawTargetUnavailable
        ? 'target_unavailable'
        : sawTargetChange ? 'target_changed' : 'accepted_record_invalid'
  }
}
