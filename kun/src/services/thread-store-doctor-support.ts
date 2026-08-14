import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, opendir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { AttachmentMetadata, type AttachmentMetadata as AttachmentMetadataType } from '../contracts/attachments.js'
import { RuntimeEvent } from '../contracts/events.js'
import { TurnItem } from '../contracts/items.js'
import {
  ThreadStoreDiagnostic,
  ThreadStoreDiagnosticReport,
  type ThreadStoreArtifactStatus,
  type ThreadStoreDiagnosticIssue,
  type ThreadStoreDoctorLimits,
  type ThreadStoreMetadataSource
} from '../contracts/thread-store-diagnostics.js'
import { isSafeThreadId } from '../contracts/thread-id.js'
import { ThreadSchema, type ThreadRecord } from '../contracts/threads.js'
import { DEFAULT_THREAD_STORE_DOCTOR_LIMITS, HARD_LIMITS } from './thread-store-doctor-scan.js'
import { samePathSnapshot, ScanStabilityTracker } from './thread-store-doctor-stability.js'
import { type WalState } from './thread-store-doctor-attachments.js'
import { sqliteIndex } from './thread-store-doctor-sqlite.js'

export async function listThreadIds(
  root: string,
  maxThreads: number,
  maxDirectoryEntries: number,
  stability: ScanStabilityTracker
): Promise<{
  threadIds: string[]
  complete: boolean
  unreadable: boolean
  changed: boolean
  limit?: 'threads' | 'entries'
}> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  let before: BigIntStats
  try {
    before = await lstat(root, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return { threadIds: [], complete: false, unreadable: true, changed: false }
    }
    directory = await opendir(root)
    const ids: string[] = []
    let entries = 0
    let limit: 'threads' | 'entries' | undefined
    for await (const entry of directory) {
      entries += 1
      if (entries > maxDirectoryEntries) {
        limit = 'entries'
        break
      }
      if (!entry.isDirectory() || !isSafeThreadId(entry.name)) continue
      if (ids.length >= maxThreads) {
        limit = 'threads'
        break
      }
      ids.push(entry.name)
    }
    const after = await lstat(root, { bigint: true }).catch(() => undefined)
    const changed = !after || !sameDirectorySnapshot(before, after)
    if (after?.isDirectory() && !after.isSymbolicLink()) stability.trackDirectory(root, after)
    return {
      threadIds: ids.sort(),
      complete: !limit && !changed,
      unreadable: false,
      changed,
      ...(limit ? { limit } : {})
    }
  } catch (error) {
    if (isMissing(error)) {
      stability.trackMissing(root)
      return { threadIds: [], complete: true, unreadable: false, changed: false }
    }
    return { threadIds: [], complete: false, unreadable: true, changed: false }
  }
}

export function normalizeLimits(input: Partial<ThreadStoreDoctorLimits> | undefined): ThreadStoreDoctorLimits {
  const output = { ...DEFAULT_THREAD_STORE_DOCTOR_LIMITS, ...input }
  for (const key of Object.keys(output) as Array<keyof ThreadStoreDoctorLimits>) {
    const value = output[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
      throw new Error(`${key} must be an integer between 1 and ${HARD_LIMITS[key]}`)
    }
  }
  if (output.maxArtifactBytes > output.maxTotalBytes) {
    throw new Error('maxArtifactBytes must not exceed maxTotalBytes')
  }
  if (output.maxRecordsPerArtifact > output.maxTotalRecords) {
    throw new Error('maxRecordsPerArtifact must not exceed maxTotalRecords')
  }
  return output
}

export function collectThreadAttachmentIds(thread: ThreadRecord, add: (id: string) => void): void {
  for (const turn of thread.turns) {
    for (const id of turn.attachmentIds ?? []) add(id)
    for (const item of turn.items) {
      if ('attachmentIds' in item) {
        for (const id of item.attachmentIds ?? []) add(id)
      }
    }
  }
}

export function isRecoverable(
  hasThreadMetadata: boolean,
  messages: ThreadStoreArtifactStatus,
  events: ThreadStoreArtifactStatus,
  attachments: ThreadStoreArtifactStatus
): boolean {
  const readable = (status: ThreadStoreArtifactStatus): boolean => (
    status === 'ok' || status === 'missing' || status === 'truncated'
  )
  return hasThreadMetadata
    && readable(messages)
    && readable(events)
    && attachments === 'ok'
}

export function hasIncompleteStatus(diagnostic: ThreadStoreDiagnostic): boolean {
  return [
    diagnostic.metadata,
    diagnostic.messages,
    diagnostic.events,
    diagnostic.sqliteIndex,
    diagnostic.attachments
  ].some((status) => (
    status === 'changed' || status === 'limit_exceeded' || status === 'indeterminate'
  ))
}

export function worseStatus(
  current: ThreadStoreArtifactStatus,
  next: ThreadStoreArtifactStatus
): ThreadStoreArtifactStatus {
  const rank: Record<ThreadStoreArtifactStatus, number> = {
    ok: 0,
    truncated: 1,
    indeterminate: 2,
    missing: 3,
    mismatch: 4,
    changed: 5,
    limit_exceeded: 6,
    invalid: 7
  }
  return rank[next] > rank[current] ? next : current
}

export function attachmentIssueCode(status: ThreadStoreArtifactStatus): string {
  if (status === 'missing') return 'missing_attachment'
  if (status === 'mismatch') return 'attachment_mismatch'
  if (status === 'indeterminate') return 'attachment_scope_indeterminate'
  if (status === 'changed') return 'attachment_changed'
  if (status === 'limit_exceeded') return 'attachment_limit_exceeded'
  return 'invalid_attachment'
}

export function attachmentIssueMessage(status: ThreadStoreArtifactStatus): string {
  if (status === 'missing') return 'A referenced attachment artifact is missing.'
  if (status === 'mismatch') return 'A referenced attachment has mismatched metadata, content, or scope.'
  if (status === 'indeterminate') return 'A referenced attachment has workspace scope, but no valid thread workspace could be recovered.'
  if (status === 'changed') return 'A referenced attachment changed while it was inspected.'
  if (status === 'limit_exceeded') return 'A referenced attachment could not be inspected within configured limits.'
  return 'A referenced attachment artifact is invalid.'
}

export function issue(
  code: string,
  message: string,
  severity: ThreadStoreDiagnosticIssue['severity']
): ThreadStoreDiagnosticIssue {
  return { code, message, severity }
}

export function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function isJsonWhitespaceOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false
  }
  return true
}

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isFile()
}

export function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

export function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && samePathSnapshot(left, right)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export async function inspectWal(path: string): Promise<WalState> {
  try {
    const stat = await lstat(path, { bigint: true })
    return stat.isFile() && !stat.isSymbolicLink() ? { kind: 'file', stat } : { kind: 'invalid' }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'invalid' }
  }
}

export function sameWalState(left: WalState, right: WalState): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing' && right.kind === 'missing') return true
  if (left.kind !== 'file' || right.kind !== 'file') return false
  return left.stat.size === 0n
    && right.stat.size === 0n
    && sameSnapshot(left.stat, right.stat)
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readonlySqliteBuffer(bytes: Buffer): Buffer {
  // WAL read/write header versions (bytes 18/19) make SQLite try to open a
  // filesystem WAL even when better-sqlite3 is backed by an in-memory Buffer.
  // A missing/empty, stable WAL proves the main database is checkpointed, so
  // normalize only the private copy to rollback format before readonly query.
  if (bytes.length < 20 || (bytes[18] !== 2 && bytes[19] !== 2)) return bytes
  const copy = Buffer.from(bytes)
  copy[18] = 1
  copy[19] = 1
  return copy
}
