import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, link, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TextDecoder } from 'node:util'

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 100_000
const HARD_MAX_BYTES = 64 * 1024 * 1024
const HARD_MAX_RECORDS = 1_000_000
const RENAME_ATTEMPTS = 6

export type JsonlTailInspection = {
  status: 'missing' | 'ok' | 'repaired' | 'truncated' | 'invalid' | 'too_large' | 'changed'
  path: string
  bytes: number
  validRecords?: number
  validPrefixBytes?: number
  removedBytes?: number
  contentSha256?: string
  reason?: string
  /** Preserved original inode when two concurrent writers cannot be reconciled safely. */
  conflictPath?: string
}

export type JsonlTailBackup = {
  path: string
  /** Exact bounded bytes. The repair keeps a separate immutable working copy. */
  contents: Buffer
  bytes: number
  sha256: string
}

export type JsonlTailRepairOptions = {
  maxBytes?: number
  maxRecords?: number
  backup: (snapshot: JsonlTailBackup) => Promise<void>
  /**
   * Runs the complete inspection/backup/replace transaction while every
   * cooperating writer is excluded from this path.
   */
  runExclusive: <T>(path: string, operation: () => Promise<T>) => Promise<T>
}

type StableSnapshot = {
  bytes: Buffer
  stat: BigIntStats
  sha256: string
}

type SnapshotResult =
  | { kind: 'ok'; snapshot: StableSnapshot }
  | { kind: 'missing' | 'invalid' | 'too_large' | 'changed'; bytes: number; reason: string }

type LoadedInspection = {
  inspection: JsonlTailInspection
  snapshot?: StableSnapshot
}

/** Inspect JSONL through a single file handle with a hard allocation/read cap. */
export async function inspectJsonlTail(
  path: string,
  options: { maxBytes?: number; maxRecords?: number } = {}
): Promise<JsonlTailInspection> {
  return (await loadInspection(path, normalizeLimits(options))).inspection
}

/**
 * Repairs only a malformed final record after a durable caller-controlled backup.
 *
 * A hard link retains the exact original inode across the atomic replacement.
 * This lets the service detect an append through a descriptor opened before the
 * rename and restore that inode instead of silently discarding concurrent data.
 * The mandatory exclusive runner closes the filesystem's lack of atomic
 * compare-and-swap for competing rename writers.
 */
export async function repairJsonlTail(
  path: string,
  options: JsonlTailRepairOptions
): Promise<JsonlTailInspection> {
  if (!options || typeof options.backup !== 'function') throw new Error('backup_required')
  if (typeof options.runExclusive !== 'function') throw new Error('maintenance_lock_required')
  return options.runExclusive(path, () => repairJsonlTailExclusive(path, options))
}

async function repairJsonlTailExclusive(
  path: string,
  options: JsonlTailRepairOptions
): Promise<JsonlTailInspection> {
  const limits = normalizeLimits(options)
  const loaded = await loadInspection(path, limits)
  const inspection = loaded.inspection
  const original = loaded.snapshot
  if (inspection.status !== 'truncated' || inspection.validPrefixBytes === undefined || !original) {
    return inspection
  }

  await options.backup({
    path,
    contents: Buffer.from(original.bytes),
    bytes: original.bytes.length,
    sha256: original.sha256
  })

  const afterBackup = await loadInspection(path, limits)
  if (
    afterBackup.inspection.status !== 'truncated'
    || afterBackup.inspection.validPrefixBytes !== inspection.validPrefixBytes
    || !afterBackup.snapshot
    || !sameSnapshotContents(original, afterBackup.snapshot)
  ) {
    return changed(path, afterBackup.inspection.bytes, 'changed_after_backup')
  }

  const repairedBytes = original.bytes.subarray(0, inspection.validPrefixBytes)
  const tempPath = `${path}.${process.pid}.${randomUUID()}.repair.tmp`
  const guardPath = `${path}.${process.pid}.${randomUUID()}.repair.guard`
  let tempExists = false
  let guardExists = false
  let replacementPublished = false

  try {
    await writeSyncedExclusive(tempPath, repairedBytes, Number(original.stat.mode & 0o777n))
    tempExists = true

    await link(path, guardPath)
    guardExists = true
    const guardedPath = await readStableSnapshot(path, limits.maxBytes)
    const guardedCopy = await readStableSnapshot(guardPath, limits.maxBytes)
    if (
      guardedPath.kind !== 'ok'
      || guardedCopy.kind !== 'ok'
      || !sameInode(guardedPath.snapshot.stat, guardedCopy.snapshot.stat)
      || !sameSnapshotContents(original, guardedPath.snapshot, { ignoreCtime: true })
      || !sameSnapshotContents(original, guardedCopy.snapshot, { ignoreCtime: true })
    ) {
      return changed(path, snapshotBytes(guardedPath), 'changed_before_replace')
    }

    await renameWithRetry(tempPath, path)
    tempExists = false
    replacementPublished = true
    await syncParentDirectory(path)

    const [published, retainedOriginal] = await Promise.all([
      readStableSnapshot(path, limits.maxBytes),
      readStableSnapshot(guardPath, limits.maxBytes)
    ])
    const publishedExpected = published.kind === 'ok' && published.snapshot.bytes.equals(repairedBytes)
    const originalUnchanged = retainedOriginal.kind === 'ok'
      && sameSnapshotContents(original, retainedOriginal.snapshot, { ignoreCtime: true })

    if (!originalUnchanged && publishedExpected && retainedOriginal.kind === 'ok') {
      // An already-open writer appended to the original inode during replace.
      // Put that inode back atomically; the malformed tail remains for a later retry,
      // but no concurrent bytes are lost.
      await renameWithRetry(guardPath, path)
      guardExists = false
      await syncParentDirectory(path)
      return changed(path, retainedOriginal.snapshot.bytes.length, 'changed_during_replace')
    }

    if (!publishedExpected || !originalUnchanged) {
      // Both sides changed, or the newly published path was changed. Choosing one
      // would discard data, so retain the original inode under an explicit path.
      return {
        ...changed(path, snapshotBytes(published), 'concurrent_replace_conflict'),
        conflictPath: guardPath
      }
    }

    await rm(guardPath)
    guardExists = false
    await syncParentDirectory(path)
    return {
      status: 'repaired',
      path,
      bytes: repairedBytes.length,
      validRecords: inspection.validRecords,
      validPrefixBytes: repairedBytes.length,
      removedBytes: original.bytes.length - repairedBytes.length,
      contentSha256: sha256(repairedBytes)
    }
  } finally {
    if (tempExists) await rm(tempPath, { force: true }).catch(() => undefined)
    // Before publication the target still owns the original inode, so the extra
    // hard link is safe to remove. After publication it is intentionally retained
    // on exceptional/conflict paths as the last non-lossy copy.
    if (guardExists && !replacementPublished) {
      await rm(guardPath, { force: true }).catch(() => undefined)
    }
  }
}

async function loadInspection(
  path: string,
  limits: { maxBytes: number; maxRecords: number }
): Promise<LoadedInspection> {
  const loaded = await readStableSnapshot(path, limits.maxBytes)
  if (loaded.kind !== 'ok') {
    return {
      inspection: {
        status: loaded.kind,
        path,
        bytes: loaded.bytes,
        reason: loaded.reason
      }
    }
  }

  const snapshot = loaded.snapshot
  let validRecords = 0
  let malformedFinalStart = -1
  let pendingMalformedFinal = false
  let malformedInterior = false
  let records = 0
  let lineStart = 0
  while (lineStart <= snapshot.bytes.length) {
    const recordStart = lineStart
    const newline = snapshot.bytes.indexOf(0x0a, lineStart)
    const lineEnd = newline < 0 ? snapshot.bytes.length : newline
    const lineBytes = snapshot.bytes.subarray(lineStart, lineEnd)
    lineStart = newline < 0 ? snapshot.bytes.length + 1 : newline + 1
    if (isJsonWhitespaceOnly(lineBytes)) continue
    if (pendingMalformedFinal) malformedInterior = true
    records += 1
    if (records > limits.maxRecords) {
      return {
        inspection: {
          status: 'too_large',
          path,
          bytes: snapshot.bytes.length,
          validRecords,
          contentSha256: snapshot.sha256,
          reason: 'max_records'
        },
        snapshot
      }
    }
    const text = decodeUtf8(lineBytes)
    if (text === null) {
      return {
        inspection: {
          status: 'invalid',
          path,
          bytes: snapshot.bytes.length,
          validRecords,
          contentSha256: snapshot.sha256,
          reason: 'invalid_utf8'
        },
        snapshot
      }
    }
    try {
      JSON.parse(text)
      validRecords += 1
    } catch {
      pendingMalformedFinal = true
      malformedFinalStart = recordStart
    }
  }

  if (malformedInterior || (pendingMalformedFinal && validRecords === 0)) {
    return {
      inspection: {
        status: 'invalid',
        path,
        bytes: snapshot.bytes.length,
        validRecords,
        contentSha256: snapshot.sha256,
        reason: malformedInterior ? 'interior_corruption' : 'no_valid_prefix'
      },
      snapshot
    }
  }
  if (pendingMalformedFinal) {
    return {
      inspection: {
        status: 'truncated',
        path,
        bytes: snapshot.bytes.length,
        validRecords,
        validPrefixBytes: malformedFinalStart,
        removedBytes: snapshot.bytes.length - malformedFinalStart,
        contentSha256: snapshot.sha256
      },
      snapshot
    }
  }
  return {
    inspection: {
      status: 'ok',
      path,
      bytes: snapshot.bytes.length,
      validRecords,
      contentSha256: snapshot.sha256
    },
    snapshot
  }
}

async function readStableSnapshot(path: string, maxBytes: number): Promise<SnapshotResult> {
  let pathBefore: BigIntStats
  try {
    pathBefore = await lstat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing', bytes: 0, reason: 'missing' }
    return { kind: 'invalid', bytes: 0, reason: 'unreadable' }
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    return { kind: 'invalid', bytes: Number(pathBefore.size), reason: 'not_a_regular_file' }
  }
  if (pathBefore.size > BigInt(maxBytes)) {
    return { kind: 'too_large', bytes: Number(pathBefore.size), reason: 'max_bytes' }
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    const before = await handle.stat({ bigint: true })
    if (!sameInode(pathBefore, before)) {
      return { kind: 'changed', bytes: Number(before.size), reason: 'changed_before_read' }
    }
    if (before.size > BigInt(maxBytes)) {
      return { kind: 'too_large', bytes: Number(before.size), reason: 'max_bytes' }
    }
    const expected = Number(before.size)
    const bytes = Buffer.allocUnsafe(expected)
    let offset = 0
    while (offset < expected) {
      const next = await handle.read(bytes, offset, expected - offset, offset)
      if (next.bytesRead === 0) break
      offset += next.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true }).catch(() => undefined)
    if (
      offset !== expected
      || !sameStableStat(before, after)
      || !pathAfter
      || !sameInode(after, pathAfter)
    ) {
      return { kind: 'changed', bytes: offset, reason: 'changed_during_read' }
    }
    return { kind: 'ok', snapshot: { bytes, stat: after, sha256: sha256(bytes) } }
  } catch (error) {
    if (isMissing(error)) return { kind: 'changed', bytes: 0, reason: 'changed_during_read' }
    return { kind: 'invalid', bytes: 0, reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeSyncedExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode || 0o600
  )
  try {
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (result.bytesWritten === 0) throw new Error('repair_temp_short_write')
      offset += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!isRetryableRename(error) || attempt === RENAME_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 25))
    }
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(dirname(path), constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    // Node does not expose a portable directory fsync handle on Windows.
    // The replacement itself still uses the platform's atomic rename primitive.
    if (process.platform !== 'win32' || !isUnsupportedDirectorySync(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function normalizeLimits(options: { maxBytes?: number; maxRecords?: number }): {
  maxBytes: number
  maxRecords: number
} {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAX_BYTES) {
    throw new Error(`maxBytes must be an integer between 1 and ${HARD_MAX_BYTES}`)
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > HARD_MAX_RECORDS) {
    throw new Error(`maxRecords must be an integer between 1 and ${HARD_MAX_RECORDS}`)
  }
  return { maxBytes, maxRecords }
}

function sameSnapshotContents(
  left: StableSnapshot,
  right: StableSnapshot,
  options: { ignoreCtime?: boolean } = {}
): boolean {
  return sameInode(left.stat, right.stat)
    && left.stat.size === right.stat.size
    && left.stat.mtimeNs === right.stat.mtimeNs
    && (options.ignoreCtime || left.stat.ctimeNs === right.stat.ctimeNs)
    && left.sha256 === right.sha256
    && left.bytes.equals(right.bytes)
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isFile()
}

function sameStableStat(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function changed(path: string, bytes: number, reason: string): JsonlTailInspection {
  return { status: 'changed', path, bytes, reason }
}

function snapshotBytes(result: SnapshotResult): number {
  return result.kind === 'ok' ? result.snapshot.bytes.length : result.bytes
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function isJsonWhitespaceOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false
  }
  return true
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isRetryableRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EINVAL' || code === 'EPERM' || code === 'EACCES' || code === 'EISDIR'
}
