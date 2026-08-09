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
import { type BoundedReadResult } from './thread-store-doctor-scan.js'
import { isMissing, sameFile, sameSnapshot } from './thread-store-doctor-support.js'

export class ScanBudget {
  bytes = 0
  records = 0
  readonly exhaustedReasons = new Set<'bytes' | 'records'>()
  readonly stability = new ScanStabilityTracker()

  constructor(readonly limits: ThreadStoreDoctorLimits) {}

  remainingBytes(): number {
    return this.limits.maxTotalBytes - this.bytes
  }

  consumeBytes(value: number): void {
    this.bytes += value
  }

  consumeRecord(): boolean {
    if (this.records >= this.limits.maxTotalRecords) {
      this.exhaustedReasons.add('records')
      return false
    }
    this.records += 1
    return true
  }
}

export type TrackedPathSnapshot =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'file' | 'directory' | 'other'; stat: BigIntStats }

export class ScanStabilityTracker {
  private readonly paths = new Map<string, TrackedPathSnapshot>()
  private changedDuringScan = false

  trackMissing(path: string): void {
    this.track(path, { kind: 'missing' })
  }

  trackFile(path: string, stat: BigIntStats): void {
    this.track(path, { kind: 'file', stat })
  }

  trackDirectory(path: string, stat: BigIntStats): void {
    this.track(path, { kind: 'directory', stat })
  }

  trackOther(path: string, stat: BigIntStats): void {
    this.track(path, { kind: 'other', stat })
  }

  trackUnreadable(path: string): void {
    this.track(path, { kind: 'unreadable' })
  }

  async verify(): Promise<boolean> {
    let stable = !this.changedDuringScan
    for (const [path, expected] of this.paths) {
      const current = await inspectTrackedPath(path)
      if (!sameTrackedPath(expected, current)) stable = false
    }
    return stable
  }

  private track(path: string, snapshot: TrackedPathSnapshot): void {
    const previous = this.paths.get(path)
    if (previous && !sameTrackedPath(previous, snapshot)) this.changedDuringScan = true
    this.paths.set(path, snapshot)
  }
}

export async function inspectTrackedPath(path: string): Promise<TrackedPathSnapshot> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (stat.isFile() && !stat.isSymbolicLink()) return { kind: 'file', stat }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return { kind: 'directory', stat }
    return { kind: 'other', stat }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
}

export function sameTrackedPath(left: TrackedPathSnapshot, right: TrackedPathSnapshot): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing' && right.kind === 'missing') return true
  if (left.kind === 'unreadable' || right.kind === 'unreadable') return false
  if (left.kind === 'missing' || right.kind === 'missing') return false
  return samePathSnapshot(left.stat, right.stat)
}

export function samePathSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

export async function readBoundedFile(
  path: string,
  budget: ScanBudget,
  maxArtifactBytes: number
): Promise<BoundedReadResult> {
  let pathStat: BigIntStats
  try {
    pathStat = await lstat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      budget.stability.trackMissing(path)
      return { kind: 'missing' }
    }
    budget.stability.trackUnreadable(path)
    return { kind: 'unreadable' }
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    if (pathStat.isDirectory() && !pathStat.isSymbolicLink()) {
      budget.stability.trackDirectory(path, pathStat)
    } else {
      budget.stability.trackOther(path, pathStat)
    }
    return { kind: 'not_file' }
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const before = await handle.stat({ bigint: true })
    if (!sameFile(pathStat, before)) return { kind: 'changed' }
    if (before.size > BigInt(maxArtifactBytes)) return { kind: 'artifact_limit' }
    if (before.size > BigInt(Math.max(0, budget.remainingBytes()))) {
      budget.exhaustedReasons.add('bytes')
      return { kind: 'total_limit' }
    }

    const expected = Number(before.size)
    const bytes = Buffer.allocUnsafe(expected)
    let offset = 0
    while (offset < expected) {
      const next = await handle.read(bytes, offset, expected - offset, offset)
      if (next.bytesRead === 0) break
      offset += next.bytesRead
      budget.consumeBytes(next.bytesRead)
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true }).catch(() => undefined)
    if (
      offset !== expected
      || !sameSnapshot(before, after)
      || !pathAfter
      || !sameFile(after, pathAfter)
    ) return { kind: 'changed' }
    budget.stability.trackFile(path, after)
    return { kind: 'ok', bytes, stat: after }
  } catch {
    // Even when opening, reading, or fstat fails, retain the lstat identity so
    // a later replacement cannot turn an invalid artifact into a complete scan.
    budget.stability.trackFile(path, pathStat)
    return { kind: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
