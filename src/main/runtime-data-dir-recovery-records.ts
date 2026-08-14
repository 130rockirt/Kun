import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync
} from 'node:fs'
import {
  randomBytes,
  randomUUID
} from 'node:crypto'
import {
  basename,
  dirname,
  join
} from 'node:path'
import {
  type PathState,
  RECOVERY_RECORD_DIR,
  RECOVERY_TARGET_IDENTITY_PREFIX
} from './runtime-data-dir-recovery-types'
import {
  hashFile
} from './runtime-data-dir-recovery-candidates'
import {
  isUuid,
  migrationJournalEvidence
} from './runtime-data-dir-recovery-acceptance'
import {
  fsyncDirectoryBestEffort,
  pathState
} from './runtime-data-dir-recovery-utils'



export type RecoveryRecord = {
  operationDir: string
  base: Record<string, unknown>
  now: () => Date
}

export type RecoveryTargetIdentity = {
  name: string
  digest: string
}

export type MigrationJournalEvidence = {
  version: 2 | 3
  state: Exclude<PathState, 'missing'>
  digest: string
}

export function beginRecoveryRecord(
  userDataPath: string,
  now: () => Date,
  base: Record<string, unknown>
): RecoveryRecord {
  const operationId = randomUUID()
  const operationDir = join(userDataPath, RECOVERY_RECORD_DIR, operationId)
  mkdirSync(operationDir, { recursive: true, mode: 0o700 })
  const record = {
    operationDir,
    now,
    base: {
      schemaVersion: 1,
      operationId,
      startedAt: now().toISOString(),
      blockedJournalEvidence: migrationJournalEvidence(userDataPath),
      ...base
    }
  }
  writeRecoveryRecord(record, 0, 'started', {})
  return record
}

export function writeRecoveryTargetIdentityMarker(
  record: RecoveryRecord,
  stagingPath: string
): RecoveryTargetIdentity {
  const operationId = String(record.base.operationId)
  if (!isUuid(operationId)) throw new Error('recovery operation identity is invalid')
  const name = `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json`
  const path = join(stagingPath, name)
  writeDurableJson(path, {
    schemaVersion: 1,
    operationId,
    token: randomBytes(32).toString('hex')
  })
  return { name, digest: hashFile(path) }
}

export function writeRecoveryRecord(
  record: RecoveryRecord,
  ordinal: number,
  phase: string,
  detail: Record<string, unknown>
): void {
  writeDurableJson(join(record.operationDir, `${String(ordinal).padStart(3, '0')}-${phase}.json`), {
    ...record.base,
    phase,
    recordedAt: record.now().toISOString(),
    ...detail
  })
}

export function writeRecoveryRecordBestEffort(
  record: RecoveryRecord,
  ordinal: number,
  phase: string,
  detail: Record<string, unknown>
): void {
  try {
    writeRecoveryRecord(record, ordinal, phase, detail)
  } catch {
    // The source, staging, and any destination backup remain untouched even if
    // the diagnostic record cannot be extended.
  }
}

export function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const handle = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  fsyncDirectoryBestEffort(dirname(path))
}

export function uniqueSiblingPath(path: string, label: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[-:.]/g, '')
  for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
    const suffix = ordinal === 0 ? '' : `-${ordinal}`
    const candidate = join(dirname(path), `${basename(path)}.${label}-${stamp}${suffix}.bak`)
    if (pathState(candidate) === 'missing') return candidate
  }
  throw new Error('could not allocate a recovery sibling')
}
