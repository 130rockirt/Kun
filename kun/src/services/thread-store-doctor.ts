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

const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{24}$/
const MAX_REPORT_ISSUES = 64

export const DEFAULT_THREAD_STORE_DOCTOR_LIMITS: ThreadStoreDoctorLimits = {
  maxThreads: 1_000,
  maxDirectoryEntries: 10_000,
  maxAttachments: 2_000,
  maxAttachmentScopeEntries: 2_000,
  maxAttachmentScopeItemChars: 4_096,
  maxRecordsPerArtifact: 100_000,
  maxTotalRecords: 200_000,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024
}

const HARD_LIMITS: ThreadStoreDoctorLimits = {
  maxThreads: 10_000,
  maxDirectoryEntries: 100_000,
  maxAttachments: 50_000,
  maxAttachmentScopeEntries: 100_000,
  maxAttachmentScopeItemChars: 32_768,
  maxRecordsPerArtifact: 1_000_000,
  maxTotalRecords: 2_000_000,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
}

export type ThreadStoreDoctorOptions = {
  dataDir: string
  sqlitePath?: string
  attachmentRootDir?: string
  limits?: Partial<ThreadStoreDoctorLimits>
  nowIso?: () => string
}

type JsonlInspection = {
  status: ThreadStoreArtifactStatus
  validRecords: number
  invalidRecords: number
  issues: ThreadStoreDiagnosticIssue[]
  thread?: ThreadRecord
  metadataSource?: ThreadStoreMetadataSource
}

type BoundedReadResult =
  | { kind: 'ok'; bytes: Buffer; stat: BigIntStats }
  | { kind: 'missing' | 'not_file' | 'artifact_limit' | 'total_limit' | 'changed' | 'unreadable' }

type AttachmentBaseInspection = {
  status: ThreadStoreArtifactStatus
  scopes?: {
    threadIds: ReadonlySet<string>
    workspaces: ReadonlySet<string>
  }
}

/**
 * Performs a bounded, side-effect-free scan of the canonical hybrid thread store.
 * JSON/JSONL content is read through capped file-handle reads; no call site uses
 * stat followed by an unbounded readFile.
 */
export async function scanThreadStore(
  options: ThreadStoreDoctorOptions
): Promise<ThreadStoreDiagnosticReport> {
  const checkedAt = options.nowIso?.() ?? new Date().toISOString()
  const limits = normalizeLimits(options.limits)
  const budget = new ScanBudget(limits)
  const reportIssues: ThreadStoreDiagnosticIssue[] = []
  const threadsRoot = resolve(options.dataDir, 'threads')
  const attachmentRoot = resolve(options.attachmentRootDir ?? join(options.dataDir, 'attachments'))
  const listing = await listThreadIds(
    threadsRoot,
    limits.maxThreads,
    limits.maxDirectoryEntries,
    budget.stability
  )
  if (listing.limit) {
    reportIssues.push(issue(
      listing.limit === 'entries' ? 'directory_entry_limit_exceeded' : 'thread_limit_exceeded',
      listing.limit === 'entries'
        ? 'The thread scan stopped at its configured directory-entry limit.'
        : 'The thread scan stopped at its configured thread limit.',
      'warning'
    ))
  }
  if (listing.changed) {
    reportIssues.push(issue(
      'thread_directory_changed',
      'The thread directory changed while it was being enumerated; retry while the store is quiescent.',
      'warning'
    ))
  }
  if (listing.unreadable) {
    reportIssues.push(issue(
      'threads_unreadable',
      'The thread directory could not be enumerated.',
      'error'
    ))
  }

  const sqlite = await openReadonlyIndex(
    options.sqlitePath ?? join(options.dataDir, 'index.sqlite3'),
    budget,
    limits.maxArtifactBytes
  )
  const sqliteIssue = globalSqliteIssue(sqlite.status)
  if (sqliteIssue) reportIssues.push(sqliteIssue)
  const attachments = new AttachmentInspector({
    rootDir: attachmentRoot,
    budget,
    limits
  })
  const diagnostics: ThreadStoreDiagnostic[] = []
  let stable = !sqliteIssue && !listing.changed

  if (sqlite.status === 'ok' && sqlite.index && listing.complete && !listing.unreadable) {
    const inventory = sqlite.index.listThreadIds(limits.maxThreads)
    if (inventory.invalidRows) {
      stable = false
      reportIssues.push(issue(
        'invalid_sqlite_index_rows',
        'The rebuildable SQLite index contains rows with invalid thread identifiers.',
        'error'
      ))
    }
    if (inventory.overflow) {
      stable = false
      reportIssues.push(issue(
        'sqlite_index_row_limit_exceeded',
        'The SQLite index has too many rows for a bounded filesystem comparison.',
        'warning'
      ))
    } else {
      const filesystemIds = new Set(listing.threadIds)
      if (inventory.threadIds.some((threadId) => !filesystemIds.has(threadId))) {
        reportIssues.push(issue(
          'orphan_sqlite_index_rows',
          'The rebuildable SQLite index contains stale rows without canonical thread directories; no synthetic thread diagnostics were created.',
          'warning'
        ))
      }
    }
  }

  try {
    for (const threadId of listing.threadIds) {
      const scannedThread = await scanThread({
        threadId,
        threadsRoot,
        sqlite,
        attachments,
        budget,
        checkedAt,
        limits
      })
      const { diagnostic } = scannedThread
      diagnostics.push(diagnostic)
      if (scannedThread.incomplete || hasIncompleteStatus(diagnostic)) stable = false
    }
    if (!(await sqlite.verifyStable())) {
      stable = false
      if (!reportIssues.some((item) => item.code === 'sqlite_index_changed')) {
        reportIssues.push(issue(
          'sqlite_index_changed',
          'The SQLite index or its WAL state changed during the scan; retry while the store is quiescent.',
          'warning'
        ))
      }
      for (let index = 0; index < diagnostics.length; index += 1) {
        const diagnostic = diagnostics[index]
        if (!diagnostic || diagnostic.sqliteIndex !== 'ok') continue
        diagnostics[index] = ThreadStoreDiagnostic.parse({
          ...diagnostic,
          sqliteIndex: 'changed',
          issues: [
            ...diagnostic.issues,
            issue(
              'sqlite_index_changed',
              'The SQLite index or its WAL state changed during the scan; retry while the store is quiescent.',
              'warning'
            )
          ].slice(0, MAX_REPORT_ISSUES)
        })
      }
    }
    if (!(await budget.stability.verify())) {
      stable = false
      reportIssues.push(issue(
        'store_changed_during_scan',
        'A previously inspected storage path changed before the scan completed; retry while the store is quiescent.',
        'warning'
      ))
    }
  } finally {
    sqlite.index?.close()
  }

  for (const reason of budget.exhaustedReasons) {
    const next = reason === 'bytes'
      ? issue('total_byte_limit_exceeded', 'The scan stopped reading artifacts at its total byte limit.', 'warning')
      : issue('total_record_limit_exceeded', 'The scan stopped parsing JSONL at its total record limit.', 'warning')
    if (reportIssues.length < MAX_REPORT_ISSUES) reportIssues.push(next)
  }

  return ThreadStoreDiagnosticReport.parse({
    schemaVersion: 1,
    checkedAt,
    complete: listing.complete && !listing.unreadable && budget.exhaustedReasons.size === 0 && stable,
    limits,
    scanned: {
      threads: diagnostics.length,
      attachments: attachments.scannedCount,
      records: budget.records,
      bytes: budget.bytes
    },
    issues: reportIssues,
    threads: diagnostics
  })
}

async function scanThread(input: {
  threadId: string
  threadsRoot: string
  sqlite: ReadonlyIndexState
  attachments: AttachmentInspector
  budget: ScanBudget
  checkedAt: string
  limits: ThreadStoreDoctorLimits
}): Promise<{ diagnostic: ThreadStoreDiagnostic; incomplete: boolean }> {
  const threadRoot = join(input.threadsRoot, input.threadId)
  const referencedAttachments = new Set<string>()
  let attachmentReferenceOverflow = false
  const addAttachment = (id: string): void => {
    if (referencedAttachments.has(id)) return
    if (referencedAttachments.size >= input.limits.maxAttachments) {
      attachmentReferenceOverflow = true
      return
    }
    referencedAttachments.add(id)
  }

  const metadata = await inspectMetadata(
    threadRoot,
    input.threadId,
    input.budget,
    input.limits,
    addAttachment
  )
  const messages = await inspectJsonl(
    join(threadRoot, 'messages.jsonl'),
    input.budget,
    input.limits,
    (value) => {
      const parsed = TurnItem.safeParse(value)
      if (!parsed.success || parsed.data.threadId !== input.threadId) return false
      if ('attachmentIds' in parsed.data) {
        for (const id of parsed.data.attachmentIds ?? []) addAttachment(id)
      }
      return true
    }
  )
  const events = await inspectJsonl(
    join(threadRoot, 'events.jsonl'),
    input.budget,
    input.limits,
    (value) => {
      const parsed = RuntimeEvent.safeParse(value)
      return parsed.success && parsed.data.threadId === input.threadId
    }
  )
  const sqliteIndex = inspectSqliteIndex(input.sqlite, input.threadId, threadRoot)
  const inspectedAttachments = await input.attachments.inspect(
    [...referencedAttachments],
    input.threadId,
    metadata.thread?.workspace
  )
  const attachmentResult = attachmentReferenceOverflow
    ? {
        status: worseStatus(inspectedAttachments.status, 'limit_exceeded'),
        incomplete: true,
        issues: [
          ...inspectedAttachments.issues,
          issue(
            'attachment_limit_exceeded',
            'The thread references more attachments than the configured scan limit.',
            'warning'
          )
        ].slice(0, MAX_REPORT_ISSUES)
      }
    : inspectedAttachments

  const issues = [
    ...metadata.issues,
    ...messages.issues,
    ...events.issues,
    ...sqliteIndex.issues,
    ...attachmentResult.issues
  ].slice(0, MAX_REPORT_ISSUES)

  const diagnostic = ThreadStoreDiagnostic.parse({
    threadId: input.threadId,
    metadata: metadata.status,
    metadataSource: metadata.metadataSource ?? 'none',
    messages: messages.status,
    events: events.status,
    sqliteIndex: sqliteIndex.status,
    attachments: attachmentResult.status,
    recoverable: isRecoverable(
      Boolean(metadata.thread),
      messages.status,
      events.status,
      attachmentResult.status
    ),
    issues,
    checkedAt: input.checkedAt
  })
  return { diagnostic, incomplete: attachmentResult.incomplete }
}

async function inspectMetadata(
  threadRoot: string,
  threadId: string,
  budget: ScanBudget,
  limits: ThreadStoreDoctorLimits,
  addAttachment: (id: string) => void
): Promise<JsonlInspection> {
  let latestThread: ThreadRecord | undefined
  const metadata = await inspectJsonl(
    join(threadRoot, 'metadata.jsonl'),
    budget,
    limits,
    (value) => {
      if (!isRecord(value) || value.kind !== 'thread_metadata') return false
      const parsed = ThreadSchema.safeParse(value.thread)
      if (!parsed.success || parsed.data.id !== threadId) return false
      latestThread = parsed.data
      return true
    }
  )

  if (latestThread && metadata.status !== 'changed' && metadata.status !== 'limit_exceeded') {
    collectThreadAttachmentIds(latestThread, addAttachment)
    return { ...metadata, thread: latestThread, metadataSource: 'metadata_jsonl' }
  }

  if (metadata.status === 'changed' || metadata.status === 'limit_exceeded') {
    return { ...metadata, metadataSource: 'none' }
  }

  const legacy = await readBoundedFile(join(threadRoot, 'thread.json'), budget, limits.maxArtifactBytes)
  if (legacy.kind === 'missing') {
    if (metadata.status !== 'missing') {
      return {
        ...metadata,
        status: 'invalid',
        metadataSource: 'none',
        issues: [
          ...metadata.issues,
          issue('invalid_metadata', 'No valid metadata snapshot was found for this thread.', 'error')
        ]
      }
    }
    return {
      status: 'missing',
      validRecords: 0,
      invalidRecords: 0,
      issues: [issue('missing_metadata', 'No thread metadata file was found.', 'error')],
      metadataSource: 'none'
    }
  }
  if (legacy.kind !== 'ok') {
    return { ...jsonReadFailure(legacy.kind, 'metadata'), metadataSource: 'none' }
  }
  const decoded = decodeUtf8(legacy.bytes)
  if (decoded === null) {
    return {
      status: 'invalid',
      validRecords: 0,
      invalidRecords: 1,
      issues: [issue('invalid_utf8', 'The legacy metadata is not valid UTF-8.', 'error')],
      metadataSource: 'none'
    }
  }
  try {
    const parsed = ThreadSchema.safeParse(JSON.parse(decoded))
    if (!parsed.success || parsed.data.id !== threadId) throw new Error('invalid metadata')
    collectThreadAttachmentIds(parsed.data, addAttachment)
    const canonicalUnavailable = metadata.status !== 'missing'
    return {
      status: canonicalUnavailable ? 'invalid' : 'ok',
      validRecords: 1,
      invalidRecords: canonicalUnavailable ? Math.max(1, metadata.invalidRecords) : 0,
      issues: canonicalUnavailable
        ? [
            ...metadata.issues,
            issue('invalid_metadata', 'No valid canonical metadata snapshot was found.', 'error'),
            issue(
              'legacy_metadata_fallback',
              'The canonical metadata has no valid snapshot; the runtime can recover from thread.json.',
              'warning'
            )
          ]
        : [],
      thread: parsed.data,
      metadataSource: 'legacy_thread_json'
    }
  } catch {
    return {
      status: 'invalid',
      validRecords: 0,
      invalidRecords: 1,
      issues: [
        ...metadata.issues,
        issue('invalid_metadata', 'The legacy thread metadata is invalid.', 'error')
      ],
      metadataSource: 'none'
    }
  }
}

async function inspectJsonl(
  path: string,
  budget: ScanBudget,
  limits: ThreadStoreDoctorLimits,
  validate: (value: unknown) => boolean
): Promise<JsonlInspection> {
  const read = await readBoundedFile(path, budget, limits.maxArtifactBytes)
  if (read.kind === 'missing') {
    return { status: 'missing', validRecords: 0, invalidRecords: 0, issues: [] }
  }
  if (read.kind !== 'ok') return jsonReadFailure(read.kind, 'JSONL artifact')
  let validRecords = 0
  let invalidRecords = 0
  let pendingMalformedFinal = false
  let malformedInterior = false
  let invalidShape = false
  let artifactRecords = 0
  let lineStart = 0

  while (lineStart <= read.bytes.length) {
    const newline = read.bytes.indexOf(0x0a, lineStart)
    const lineEnd = newline < 0 ? read.bytes.length : newline
    const lineBytes = read.bytes.subarray(lineStart, lineEnd)
    lineStart = newline < 0 ? read.bytes.length + 1 : newline + 1
    if (isJsonWhitespaceOnly(lineBytes)) continue
    if (pendingMalformedFinal) malformedInterior = true
    if (artifactRecords >= limits.maxRecordsPerArtifact) {
      return {
        status: 'limit_exceeded',
        validRecords,
        invalidRecords,
        issues: [issue(
          'artifact_record_limit_exceeded',
          'A JSONL artifact exceeds its configured record limit.',
          'warning'
        )]
      }
    }
    if (!budget.consumeRecord()) {
      return {
        status: 'limit_exceeded',
        validRecords,
        invalidRecords,
        issues: [issue(
          'total_record_limit_exceeded',
          'The scan reached its total JSONL record limit.',
          'warning'
        )]
      }
    }
    artifactRecords += 1
    const line = decodeUtf8(lineBytes)
    if (line === null) {
      return {
        status: 'invalid',
        validRecords,
        invalidRecords: invalidRecords + 1,
        issues: [issue('invalid_utf8', 'A JSONL artifact is not valid UTF-8.', 'error')]
      }
    }
    try {
      const value = JSON.parse(line) as unknown
      if (validate(value)) validRecords += 1
      else {
        invalidRecords += 1
        invalidShape = true
      }
    } catch {
      invalidRecords += 1
      pendingMalformedFinal = true
    }
  }

  if (malformedInterior || invalidShape) {
    return {
      status: 'invalid',
      validRecords,
      invalidRecords,
      issues: [issue(
        'invalid_jsonl_records',
        'A JSONL artifact contains malformed or unexpected records.',
        'error'
      )]
    }
  }
  if (pendingMalformedFinal) {
    return {
      status: validRecords > 0 ? 'truncated' : 'invalid',
      validRecords,
      invalidRecords,
      issues: [issue(
        validRecords > 0 ? 'truncated_jsonl_tail' : 'invalid_jsonl_records',
        validRecords > 0
          ? 'A JSONL artifact ends with a malformed final record.'
          : 'A JSONL artifact has no valid record before its malformed tail.',
        validRecords > 0 ? 'warning' : 'error'
      )]
    }
  }
  return { status: 'ok', validRecords, invalidRecords, issues: [] }
}

function jsonReadFailure(
  kind: Exclude<BoundedReadResult['kind'], 'ok' | 'missing'>,
  label: string
): JsonlInspection {
  if (kind === 'artifact_limit' || kind === 'total_limit') {
    return {
      status: 'limit_exceeded',
      validRecords: 0,
      invalidRecords: 0,
      issues: [issue(
        kind === 'artifact_limit' ? 'artifact_byte_limit_exceeded' : 'total_byte_limit_exceeded',
        kind === 'artifact_limit'
          ? `The ${label} exceeds its configured byte limit.`
          : `The ${label} could not be read within the total byte limit.`,
        'warning'
      )]
    }
  }
  if (kind === 'changed') {
    return {
      status: 'changed',
      validRecords: 0,
      invalidRecords: 0,
      issues: [issue('artifact_changed', `The ${label} changed while it was being read.`, 'warning')]
    }
  }
  return {
    status: 'invalid',
    validRecords: 0,
    invalidRecords: 0,
    issues: [issue('unreadable_artifact', `The ${label} is not a readable regular file.`, 'error')]
  }
}

class ScanBudget {
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

type TrackedPathSnapshot =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'file' | 'directory' | 'other'; stat: BigIntStats }

class ScanStabilityTracker {
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

async function inspectTrackedPath(path: string): Promise<TrackedPathSnapshot> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (stat.isFile() && !stat.isSymbolicLink()) return { kind: 'file', stat }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return { kind: 'directory', stat }
    return { kind: 'other', stat }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
}

function sameTrackedPath(left: TrackedPathSnapshot, right: TrackedPathSnapshot): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing' && right.kind === 'missing') return true
  if (left.kind === 'unreadable' || right.kind === 'unreadable') return false
  if (left.kind === 'missing' || right.kind === 'missing') return false
  return samePathSnapshot(left.stat, right.stat)
}

function samePathSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function readBoundedFile(
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

class AttachmentInspector {
  private readonly cache = new Map<string, AttachmentBaseInspection>()
  private readonly rootDir: string
  private readonly budget: ScanBudget
  private readonly limits: ThreadStoreDoctorLimits

  constructor(options: { rootDir: string; budget: ScanBudget; limits: ThreadStoreDoctorLimits }) {
    this.rootDir = options.rootDir
    this.budget = options.budget
    this.limits = options.limits
  }

  get scannedCount(): number {
    return this.cache.size
  }

  async inspect(
    ids: string[],
    threadId: string,
    workspace: string | undefined
  ): Promise<{
    status: ThreadStoreArtifactStatus
    incomplete: boolean
    issues: ThreadStoreDiagnosticIssue[]
  }> {
    let status: ThreadStoreArtifactStatus = 'ok'
    let incomplete = false
    const issues: ThreadStoreDiagnosticIssue[] = []
    for (const id of ids.sort()) {
      if (!ATTACHMENT_ID_PATTERN.test(id)) {
        status = worseStatus(status, 'invalid')
        issues.push(issue('invalid_attachment_reference', 'A thread contains an invalid attachment reference.', 'error'))
        continue
      }
      let inspected = this.cache.get(id)
      if (!inspected) {
        if (this.cache.size >= this.limits.maxAttachments) {
          status = worseStatus(status, 'limit_exceeded')
          incomplete = true
          issues.push(issue('attachment_limit_exceeded', 'The scan reached its configured attachment limit.', 'warning'))
          continue
        }
        inspected = await this.inspectBase(id)
        this.cache.set(id, inspected)
      }
      let nextStatus = inspected.status
      if (nextStatus === 'ok' && inspected.scopes) {
        const { threadIds, workspaces } = inspected.scopes
        if (threadIds.size === 0 && workspaces.size === 0) {
          nextStatus = 'ok'
        } else if (threadIds.has(threadId)) {
          nextStatus = 'ok'
        } else if (workspace && workspaces.has(workspace)) {
          nextStatus = 'ok'
        } else if (!workspace && workspaces.size > 0) {
          nextStatus = 'indeterminate'
        } else {
          nextStatus = 'mismatch'
        }
      }
      if (isIncompleteAttachmentStatus(nextStatus)) incomplete = true
      status = worseStatus(status, nextStatus)
      if (nextStatus !== 'ok' && issues.length < MAX_REPORT_ISSUES) {
        issues.push(issue(
          attachmentIssueCode(nextStatus),
          attachmentIssueMessage(nextStatus),
          nextStatus === 'limit_exceeded'
            || nextStatus === 'changed'
            || nextStatus === 'indeterminate'
            ? 'warning'
            : 'error'
        ))
      }
    }
    return { status, incomplete, issues }
  }

  private async inspectBase(id: string): Promise<AttachmentBaseInspection> {
    const metadataRead = await readBoundedFile(
      join(this.rootDir, `${id}.json`),
      this.budget,
      this.limits.maxArtifactBytes
    )
    if (metadataRead.kind === 'missing') return { status: 'missing' }
    if (metadataRead.kind === 'artifact_limit' || metadataRead.kind === 'total_limit') {
      return { status: 'limit_exceeded' }
    }
    if (metadataRead.kind === 'changed') return { status: 'changed' }
    if (metadataRead.kind !== 'ok') return { status: 'invalid' }
    const text = decodeUtf8(metadataRead.bytes)
    if (text === null) return { status: 'invalid' }

    let metadata: AttachmentMetadataType
    try {
      const raw = JSON.parse(text) as unknown
      const scopeValidation = validateAttachmentScopes(raw, this.limits)
      if (scopeValidation !== 'ok') return { status: scopeValidation }
      metadata = AttachmentMetadata.parse(raw)
    } catch {
      return { status: 'invalid' }
    }
    if (metadata.id !== id) return { status: 'mismatch' }

    const scopes = {
      threadIds: new Set(metadata.threadIds),
      workspaces: new Set(metadata.workspaces)
    }

    const content = await readBoundedFile(
      join(this.rootDir, `${id}.bin`),
      this.budget,
      this.limits.maxArtifactBytes
    )
    if (content.kind === 'missing') return { status: 'missing' }
    if (content.kind === 'artifact_limit' || content.kind === 'total_limit') {
      return { status: 'limit_exceeded' }
    }
    if (content.kind === 'changed') return { status: 'changed' }
    if (content.kind !== 'ok') return { status: 'invalid' }
    if (
      content.bytes.length !== metadata.byteSize
      || sha256(content.bytes) !== metadata.hash.toLowerCase()
    ) return { status: 'mismatch' }
    return { status: 'ok', scopes }
  }
}

function isIncompleteAttachmentStatus(status: ThreadStoreArtifactStatus): boolean {
  return status === 'changed' || status === 'limit_exceeded' || status === 'indeterminate'
}

function validateAttachmentScopes(
  raw: unknown,
  limits: ThreadStoreDoctorLimits
): 'ok' | 'invalid' | 'limit_exceeded' {
  if (!isRecord(raw)) return 'invalid'
  const threadIds = raw.threadIds ?? []
  const workspaces = raw.workspaces ?? []
  if (!Array.isArray(threadIds) || !Array.isArray(workspaces)) return 'invalid'
  if (threadIds.length + workspaces.length > limits.maxAttachmentScopeEntries) {
    return 'limit_exceeded'
  }
  for (const values of [threadIds, workspaces]) {
    for (const value of values) {
      if (typeof value !== 'string') return 'invalid'
      if (value.length > limits.maxAttachmentScopeItemChars) return 'limit_exceeded'
    }
  }
  return 'ok'
}

type ReadonlyIndexRow = {
  metadata_path?: string
  messages_path?: string
  events_path?: string
}

type ReadonlyIndex = {
  getThread: (threadId: string) => ReadonlyIndexRow | undefined
  listThreadIds: (limit: number) => {
    threadIds: string[]
    overflow: boolean
    invalidRows: boolean
  }
  close: () => void
}

type ReadonlyIndexState = {
  status: 'ok' | 'missing' | 'invalid' | 'mismatch' | 'changed' | 'limit_exceeded'
  index: ReadonlyIndex | null
  verifyStable: () => Promise<boolean>
}

type SqliteColumnExpectation = {
  name: string
  type: 'TEXT' | 'REAL' | 'INTEGER'
  notNull: boolean
  primaryKeyPosition: number
  defaultValue: string | null
}

const REQUIRED_SQLITE_COLUMNS: Readonly<Record<string, readonly SqliteColumnExpectation[]>> = {
  threads: [
    sqliteColumn('id', 'TEXT', false, 1),
    sqliteColumn('title', 'TEXT', true),
    sqliteColumn('workspace', 'TEXT', true),
    sqliteColumn('model', 'TEXT', true),
    sqliteColumn('mode', 'TEXT', true),
    sqliteColumn('status', 'TEXT', true),
    sqliteColumn('approval_policy', 'TEXT', true),
    sqliteColumn('sandbox_mode', 'TEXT', true),
    sqliteColumn('cost_budget_usd', 'REAL', false),
    sqliteColumn('cost_budget_warning_sent', 'INTEGER', false),
    sqliteColumn('relation', 'TEXT', true),
    sqliteColumn('parent_thread_id', 'TEXT', false),
    sqliteColumn('forked_from_thread_id', 'TEXT', false),
    sqliteColumn('forked_from_title', 'TEXT', false),
    sqliteColumn('forked_at', 'TEXT', false),
    sqliteColumn('forked_from_message_count', 'INTEGER', false),
    sqliteColumn('forked_from_turn_count', 'INTEGER', false),
    sqliteColumn('goal_json', 'TEXT', false),
    sqliteColumn('todos_json', 'TEXT', false),
    sqliteColumn('extension_metadata_json', 'TEXT', false),
    sqliteColumn('created_at', 'TEXT', true),
    sqliteColumn('updated_at', 'TEXT', true),
    sqliteColumn('created_at_ms', 'INTEGER', true),
    sqliteColumn('updated_at_ms', 'INTEGER', true),
    sqliteColumn('preview', 'TEXT', false),
    sqliteColumn('message_count', 'INTEGER', true, 0, '0'),
    sqliteColumn('event_seq_high_water', 'INTEGER', true, 0, '0'),
    sqliteColumn('metadata_path', 'TEXT', true),
    sqliteColumn('messages_path', 'TEXT', true),
    sqliteColumn('events_path', 'TEXT', true),
    sqliteColumn('search_text', 'TEXT', true),
    sqliteColumn('usage_backfilled', 'INTEGER', true, 0, '0')
  ],
  usage_events: [
    sqliteColumn('thread_id', 'TEXT', true, 1),
    sqliteColumn('seq', 'INTEGER', true, 2),
    sqliteColumn('timestamp', 'TEXT', true),
    sqliteColumn('turn_id', 'TEXT', false),
    sqliteColumn('model', 'TEXT', false),
    sqliteColumn('usage_json', 'TEXT', true)
  ]
}

const REQUIRED_SQLITE_INDEXES = [
  sqliteIndex('threads', 'threads_updated_idx', [['updated_at_ms', true], ['id', true]]),
  sqliteIndex('threads', 'threads_workspace_updated_idx', [
    ['workspace', false], ['updated_at_ms', true], ['id', true]
  ]),
  sqliteIndex('threads', 'threads_status_updated_idx', [
    ['status', false], ['updated_at_ms', true], ['id', true]
  ]),
  sqliteIndex('threads', 'threads_relation_updated_idx', [
    ['relation', false], ['updated_at_ms', true], ['id', true]
  ]),
  sqliteIndex('usage_events', 'usage_events_thread_seq_idx', [
    ['thread_id', false], ['seq', false]
  ]),
  sqliteIndex('usage_events', 'usage_events_timestamp_idx', [['timestamp', false]])
] as const

type WalState =
  | { kind: 'missing' }
  | { kind: 'file'; stat: BigIntStats }
  | { kind: 'invalid' }

async function openReadonlyIndex(
  path: string,
  budget: ScanBudget,
  maxArtifactBytes: number
): Promise<ReadonlyIndexState> {
  let handle: { close: () => void } | undefined
  const inert = (status: Exclude<ReadonlyIndexState['status'], 'ok'>): ReadonlyIndexState => ({
    status,
    index: null,
    verifyStable: async () => true
  })
  try {
    const walBefore = await inspectWal(`${path}-wal`)
    if (walBefore.kind === 'invalid') return inert('invalid')
    if (walBefore.kind === 'file' && walBefore.stat.size > 0n) return inert('changed')
    const main = await readBoundedFile(path, budget, maxArtifactBytes)
    if (main.kind === 'missing') return inert('missing')
    if (main.kind === 'artifact_limit' || main.kind === 'total_limit') return inert('limit_exceeded')
    if (main.kind === 'changed') return inert('changed')
    if (main.kind !== 'ok') return inert('invalid')
    const walAfterRead = await inspectWal(`${path}-wal`)
    if (!sameWalState(walBefore, walAfterRead)) return inert('changed')
    const sqlite = await import('better-sqlite3')
    const Database = sqlite.default
    // A Buffer-backed database is an isolated in-memory copy. Keep it writable
    // only long enough to probe the real HybridThreadStore write contract.
    const db = new Database(Buffer.from(readonlySqliteBuffer(main.bytes)))
    handle = db
    db.pragma('journal_mode = MEMORY')
    db.pragma('temp_store = MEMORY')
    const validation = validateReadonlyIndex(db)
    if (validation !== 'ok') {
      db.close()
      handle = undefined
      return inert(validation)
    }
    db.pragma('query_only = ON')
    const statement = db.prepare(
      'SELECT metadata_path, messages_path, events_path FROM threads WHERE id = ?'
    )
    const listStatement = db.prepare('SELECT id FROM threads ORDER BY id ASC LIMIT ?')
    return {
      status: 'ok',
      index: {
        getThread: (threadId) => statement.get(threadId) as ReadonlyIndexRow | undefined,
        listThreadIds: (limit) => {
          const rows = listStatement.all(limit + 1) as Array<{ id?: unknown }>
          const inspected = rows.slice(0, limit)
          return {
            threadIds: inspected
              .map((row) => row.id)
              .filter((id): id is string => typeof id === 'string' && isSafeThreadId(id)),
            overflow: rows.length > limit,
            invalidRows: rows.some((row) => (
              typeof row.id !== 'string' || !isSafeThreadId(row.id)
            ))
          }
        },
        close: () => db.close()
      },
      verifyStable: async () => {
        const [mainAfter, walAfter] = await Promise.all([
          lstat(path, { bigint: true }).catch(() => undefined),
          inspectWal(`${path}-wal`)
        ])
        return Boolean(
          mainAfter
          && sameSnapshot(main.stat, mainAfter)
          && sameWalState(walBefore, walAfter)
        )
      }
    }
  } catch (error) {
    handle?.close()
    return inert(isMissing(error) ? 'missing' : 'invalid')
  }
}

function validateReadonlyIndex(
  db: BetterSqliteDatabase
): 'ok' | 'invalid' | 'mismatch' {
  try {
    const expectedTables = new Set(Object.keys(REQUIRED_SQLITE_COLUMNS))
    const persistedTables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' LIMIT ?
    `).all(expectedTables.size + 1) as Array<{ name?: unknown }>
    if (
      persistedTables.length !== expectedTables.size
      || persistedTables.some((table) => (
        typeof table.name !== 'string' || !expectedTables.has(table.name)
      ))
    ) return 'mismatch'

    const tableSql = db.prepare(
      "SELECT type, sql FROM sqlite_master WHERE name = ?"
    )
    for (const [table, expectedColumns] of Object.entries(REQUIRED_SQLITE_COLUMNS)) {
      const catalog = tableSql.get(table) as { type?: unknown; sql?: unknown } | undefined
      if (
        catalog?.type !== 'table'
        || typeof catalog.sql !== 'string'
        || containsSqlKeyword(catalog.sql, 'CHECK')
      ) return 'mismatch'
      const actualColumns = db.prepare(`
        SELECT name, type, "notnull", dflt_value, pk, hidden
        FROM pragma_table_xinfo(?)
      `).all(table) as Array<{
        name?: unknown
        type?: unknown
        notnull?: unknown
        pk?: unknown
        dflt_value?: unknown
        hidden?: unknown
      }>
      if (actualColumns.length !== expectedColumns.length) return 'mismatch'
      const actualByName = new Map(actualColumns.map((column) => [column.name, column]))
      for (const expected of expectedColumns) {
        const actual = actualByName.get(expected.name)
        if (
          !actual
          || String(actual.type).toUpperCase() !== expected.type
          || Number(actual.notnull) !== Number(expected.notNull)
          || Number(actual.pk) !== expected.primaryKeyPosition
          || (
            actual.dflt_value === null || actual.dflt_value === undefined
              ? null
              : String(actual.dflt_value)
          ) !== expected.defaultValue
          || Number(actual.hidden) !== 0
        ) return 'mismatch'
      }
      const foreignKey = db.prepare(
        'SELECT 1 FROM pragma_foreign_key_list(?) LIMIT 1'
      ).get(table)
      if (foreignKey) return 'mismatch'
    }

    const trigger = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN ('threads', 'usage_events')
      LIMIT 1
    `).get()
    if (trigger) return 'mismatch'

    for (const table of Object.keys(REQUIRED_SQLITE_COLUMNS)) {
      const indexes = readSqliteIndexList(db, table)
      if (indexes.some((index) => (
        index.partial
        || (index.unique && index.origin !== 'pk')
        || !hasSafeSqliteIndexShape(db, index.name)
      ))) return 'mismatch'
      const primary = indexes.filter((index) => index.origin === 'pk')
      if (primary.length !== 1 || !primary[0]) return 'mismatch'
      const primaryColumns = table === 'threads'
        ? [{ name: 'id', descending: false }]
        : [{ name: 'thread_id', descending: false }, { name: 'seq', descending: false }]
      if (!matchesSqliteIndex(db, primary[0].name, primaryColumns)) return 'mismatch'

      for (const expected of REQUIRED_SQLITE_INDEXES.filter((index) => index.table === table)) {
        const listed = indexes.find((index) => index.name === expected.name)
        if (
          !listed
          || listed.unique
          || listed.partial
          || listed.origin !== 'c'
          || !matchesSqliteIndex(db, expected.name, expected.columns)
        ) return 'mismatch'
      }
    }

    // At this point the database contains only the two owned tables and their
    // catalog-vetted objects, so a full check cannot evaluate unowned SQL.
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok') return 'invalid'
    } catch {
      return 'invalid'
    }

    for (const [table, columns] of Object.entries(REQUIRED_SQLITE_COLUMNS)) {
      db.prepare(`SELECT ${columns.map((column) => column.name).join(', ')} FROM ${table} LIMIT 0`)
    }
    db.prepare('SELECT id FROM threads ORDER BY id ASC LIMIT ?')
    db.prepare('SELECT * FROM usage_events ORDER BY thread_id ASC, seq ASC')
    if (!probeHybridThreadStoreWrites(db)) return 'mismatch'
    return 'ok'
  } catch {
    return 'mismatch'
  }
}

type SqliteListedIndex = {
  name: string
  unique: boolean
  origin: string
  partial: boolean
}

function readSqliteIndexList(db: BetterSqliteDatabase, table: string): SqliteListedIndex[] {
  const rows = db.prepare(`
    SELECT name, "unique" AS is_unique, origin, partial
    FROM pragma_index_list(?)
  `).all(table) as Array<{
    name?: unknown
    is_unique?: unknown
    origin?: unknown
    partial?: unknown
  }>
  return rows.map((row) => ({
    name: String(row.name ?? ''),
    unique: Number(row.is_unique) === 1,
    origin: String(row.origin ?? ''),
    partial: Number(row.partial) === 1
  }))
}

function matchesSqliteIndex(
  db: BetterSqliteDatabase,
  indexName: string,
  expected: ReadonlyArray<{ name: string; descending: boolean }>
): boolean {
  const actual = readSqliteIndexKeyColumns(db, indexName)
  if (actual.length !== expected.length) return false
  return expected.every((column, index) => {
    const candidate = actual[index]
    return Boolean(
      candidate
      && candidate.name === column.name
      && candidate.descending === column.descending
      && candidate.collation === 'BINARY'
    )
  })
}

function readSqliteIndexKeyColumns(
  db: BetterSqliteDatabase,
  indexName: string
): Array<{ name: unknown; descending: boolean; collation: unknown }> {
  return (db.prepare(`
    SELECT seqno, name, desc, coll, key
    FROM pragma_index_xinfo(?)
  `).all(indexName) as Array<{
    seqno?: unknown
    name?: unknown
    desc?: unknown
    coll?: unknown
    key?: unknown
  }>)
    .filter((column) => Number(column.key) === 1)
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((column) => ({
      name: column.name,
      descending: Number(column.desc) === 1,
      collation: column.coll
    }))
}

function hasSafeSqliteIndexShape(db: BetterSqliteDatabase, indexName: string): boolean {
  const columns = readSqliteIndexKeyColumns(db, indexName)
  return columns.length > 0 && columns.every((column) => (
    typeof column.name === 'string' && column.collation === 'BINARY'
  ))
}

function probeHybridThreadStoreWrites(db: BetterSqliteDatabase): boolean {
  let savepointStarted = false
  try {
    const [firstId, secondId] = findWriteProbeThreadIds(db)
    const threadUpsert = db.prepare(`
      INSERT INTO threads (
        id, title, workspace, model, mode, status, approval_policy, sandbox_mode,
        cost_budget_usd, cost_budget_warning_sent, relation, parent_thread_id,
        forked_from_thread_id, forked_from_title, forked_at, forked_from_message_count,
        forked_from_turn_count, goal_json, todos_json, extension_metadata_json,
        created_at, updated_at, created_at_ms, updated_at_ms, preview, message_count,
        event_seq_high_water, metadata_path, messages_path, events_path, search_text
      ) VALUES (
        @id, @title, @workspace, @model, @mode, @status, @approval_policy, @sandbox_mode,
        @cost_budget_usd, @cost_budget_warning_sent, @relation, @parent_thread_id,
        @forked_from_thread_id, @forked_from_title, @forked_at, @forked_from_message_count,
        @forked_from_turn_count, @goal_json, @todos_json, @extension_metadata_json,
        @created_at, @updated_at, @created_at_ms, @updated_at_ms, @preview, @message_count,
        @event_seq_high_water, @metadata_path, @messages_path, @events_path, @search_text
      ) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, workspace=excluded.workspace, model=excluded.model,
        mode=excluded.mode, status=excluded.status,
        approval_policy=excluded.approval_policy, sandbox_mode=excluded.sandbox_mode,
        cost_budget_usd=excluded.cost_budget_usd,
        cost_budget_warning_sent=excluded.cost_budget_warning_sent,
        relation=excluded.relation, parent_thread_id=excluded.parent_thread_id,
        forked_from_thread_id=excluded.forked_from_thread_id,
        forked_from_title=excluded.forked_from_title, forked_at=excluded.forked_at,
        forked_from_message_count=excluded.forked_from_message_count,
        forked_from_turn_count=excluded.forked_from_turn_count,
        goal_json=excluded.goal_json, todos_json=excluded.todos_json,
        extension_metadata_json=excluded.extension_metadata_json,
        created_at=excluded.created_at, updated_at=excluded.updated_at,
        created_at_ms=excluded.created_at_ms, updated_at_ms=excluded.updated_at_ms,
        preview=excluded.preview, message_count=excluded.message_count,
        event_seq_high_water=MAX(threads.event_seq_high_water, excluded.event_seq_high_water),
        metadata_path=excluded.metadata_path, messages_path=excluded.messages_path,
        events_path=excluded.events_path, search_text=excluded.search_text
    `)
    const usageUpsert = db.prepare(`
      INSERT INTO usage_events (
        thread_id, seq, timestamp, turn_id, model, usage_json
      ) VALUES (
        @thread_id, @seq, @timestamp, @turn_id, @model, @usage_json
      ) ON CONFLICT(thread_id, seq) DO UPDATE SET
        timestamp=excluded.timestamp, turn_id=excluded.turn_id,
        model=excluded.model, usage_json=excluded.usage_json
    `)

    db.exec('SAVEPOINT kun_doctor_write_probe')
    savepointStarted = true
    threadUpsert.run(threadWriteProbeRow(firstId, 'Kun doctor schema probe'))
    threadUpsert.run(threadWriteProbeRow(firstId, 'Kun doctor schema probe updated'))
    threadUpsert.run(threadWriteProbeRow(secondId, 'KUN DOCTOR SCHEMA PROBE'))
    const defaults = db.prepare(`
      SELECT id, usage_backfilled FROM threads WHERE id IN (?, ?)
    `).all(firstId, secondId) as Array<{ id?: unknown; usage_backfilled?: unknown }>
    if (
      defaults.length !== 2
      || defaults.some((row) => row.usage_backfilled !== 0)
    ) throw new Error('unexpected usage_backfilled default')

    const timestamp = '2099-01-01T00:00:00.000Z'
    const usageJson = JSON.stringify({
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cacheHitRate: null,
      turns: 1
    })
    usageUpsert.run(usageWriteProbeRow(firstId, 1, timestamp, usageJson))
    usageUpsert.run(usageWriteProbeRow(secondId, 1, timestamp, usageJson))

    db.exec('ROLLBACK TO kun_doctor_write_probe')
    db.exec('RELEASE kun_doctor_write_probe')
    savepointStarted = false
    return true
  } catch {
    if (savepointStarted) {
      try {
        db.exec('ROLLBACK TO kun_doctor_write_probe')
      } catch {
        // The failed statement may already have ended the savepoint.
      }
      try {
        db.exec('RELEASE kun_doctor_write_probe')
      } catch {
        // The write probe runs only on an isolated in-memory database.
      }
    }
    return false
  }
}

function findWriteProbeThreadIds(db: BetterSqliteDatabase): [string, string] {
  const candidates = Array.from({ length: 4 }, () => {
    const suffix = randomUUID().toLowerCase()
    const first = `thr_kun_doctor_probe_${suffix}`
    const second = `thr_kun_doctor_probe_${suffix.toUpperCase()}`
    if (!isSafeThreadId(first) || !isSafeThreadId(second)) {
      throw new Error('generated invalid SQLite write-probe thread id')
    }
    return [first, second] as const
  })
  const flattened = candidates.flat()
  const placeholders = flattened.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id FROM threads WHERE id IN (${placeholders})
  `).all(...flattened) as Array<{ id?: unknown }>
  const occupied = new Set(rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.toLowerCase()))
  for (const [first, second] of candidates) {
    if (!occupied.has(first)) return [first, second]
  }
  throw new Error('no available thread id for SQLite write probe')
}

function threadWriteProbeRow(id: string, title: string): Record<string, string | number | null> {
  const root = `/kun-doctor/${id}`
  const timestamp = '2099-01-01T00:00:00.000Z'
  return {
    id,
    title,
    workspace: root,
    model: 'deepseek-chat',
    mode: 'agent',
    status: 'idle',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    cost_budget_usd: null,
    cost_budget_warning_sent: null,
    relation: 'primary',
    parent_thread_id: null,
    forked_from_thread_id: null,
    forked_from_title: null,
    forked_at: null,
    forked_from_message_count: null,
    forked_from_turn_count: null,
    goal_json: null,
    todos_json: null,
    extension_metadata_json: null,
    created_at: timestamp,
    updated_at: timestamp,
    created_at_ms: Date.parse(timestamp),
    updated_at_ms: Date.parse(timestamp),
    preview: null,
    message_count: 0,
    event_seq_high_water: 0,
    metadata_path: `${root}/metadata.jsonl`,
    messages_path: `${root}/messages.jsonl`,
    events_path: `${root}/events.jsonl`,
    search_text: title.toLowerCase()
  }
}

function usageWriteProbeRow(
  threadId: string,
  seq: number,
  timestamp: string,
  usageJson: string
): Record<string, string | number | null> {
  return {
    thread_id: threadId,
    seq,
    timestamp,
    turn_id: 'turn_kun_doctor_probe',
    model: 'deepseek-chat',
    usage_json: usageJson
  }
}

function containsSqlKeyword(sql: string, keyword: string): boolean {
  let index = 0
  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]
    if (current === "'" || current === '"' || current === '`') {
      const quote = current
      index += 1
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index += 1
          continue
        }
        if (sql[index + 1] === quote) {
          index += 2
          continue
        }
        index += 1
        break
      }
      continue
    }
    if (current === '[') {
      index += 1
      while (index < sql.length && sql[index] !== ']') index += 1
      index += 1
      continue
    }
    if (current === '-' && next === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }
    if (isSqlIdentifierCharacter(current)) {
      const start = index
      while (index < sql.length && isSqlIdentifierCharacter(sql[index])) index += 1
      if (sql.slice(start, index).toUpperCase() === keyword) return true
      continue
    }
    index += 1
  }
  return false
}

function isSqlIdentifierCharacter(value: string | undefined): boolean {
  if (!value) return false
  const code = value.charCodeAt(0)
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || value === '_'
    || value === '$'
}

function sqliteColumn(
  name: string,
  type: SqliteColumnExpectation['type'],
  notNull: boolean,
  primaryKeyPosition = 0,
  defaultValue: string | null = null
): SqliteColumnExpectation {
  return {
    name,
    type,
    notNull,
    primaryKeyPosition,
    defaultValue
  }
}

function sqliteIndex<
  const Table extends string,
  const Name extends string,
  const Columns extends ReadonlyArray<readonly [string, boolean]>
>(table: Table, name: Name, columns: Columns): {
  table: Table
  name: Name
  columns: ReadonlyArray<{ name: string; descending: boolean }>
} {
  return {
    table,
    name,
    columns: columns.map(([columnName, descending]) => ({ name: columnName, descending }))
  }
}

function inspectSqliteIndex(
  sqlite: ReadonlyIndexState,
  threadId: string,
  threadRoot: string
): { status: ThreadStoreArtifactStatus; issues: ThreadStoreDiagnosticIssue[] } {
  if (sqlite.status === 'missing') {
    return {
      status: 'missing',
      issues: [issue('missing_sqlite_index', 'The rebuildable SQLite index is missing.', 'warning')]
    }
  }
  if (sqlite.status === 'changed') {
    return {
      status: 'changed',
      issues: [issue(
        'sqlite_index_changed',
        'The SQLite index has a non-empty or changing WAL; retry while the store is quiescent.',
        'warning'
      )]
    }
  }
  if (sqlite.status === 'limit_exceeded') {
    return {
      status: 'limit_exceeded',
      issues: [issue(
        'sqlite_index_limit_exceeded',
        'The SQLite index could not be inspected within configured byte limits.',
        'warning'
      )]
    }
  }
  if (sqlite.status === 'mismatch') {
    return {
      status: 'mismatch',
      issues: [issue(
        'sqlite_index_schema_mismatch',
        'The SQLite index does not match the schema required by HybridThreadStore.',
        'error'
      )]
    }
  }
  if (sqlite.status === 'invalid' || !sqlite.index) {
    return {
      status: 'invalid',
      issues: [issue('invalid_sqlite_index', 'The SQLite index could not be queried read-only.', 'error')]
    }
  }
  try {
    const row = sqlite.index.getThread(threadId)
    if (!row) {
      return {
        status: 'mismatch',
        issues: [issue('sqlite_index_mismatch', 'The SQLite index has no matching thread row.', 'warning')]
      }
    }
    const expected: ReadonlyIndexRow = {
      metadata_path: join(threadRoot, 'metadata.jsonl'),
      messages_path: join(threadRoot, 'messages.jsonl'),
      events_path: join(threadRoot, 'events.jsonl')
    }
    const mismatch = (Object.keys(expected) as Array<keyof ReadonlyIndexRow>)
      .some((key) => resolve(String(row[key] ?? '')) !== resolve(String(expected[key])))
    return mismatch
      ? {
          status: 'mismatch',
          issues: [issue('sqlite_index_mismatch', 'The SQLite index paths do not match canonical storage.', 'warning')]
        }
      : { status: 'ok', issues: [] }
  } catch {
    return {
      status: 'invalid',
      issues: [issue('invalid_sqlite_index', 'The SQLite index query failed.', 'error')]
    }
  }
}

function globalSqliteIssue(
  status: ReadonlyIndexState['status']
): ThreadStoreDiagnosticIssue | undefined {
  if (status === 'changed') {
    return issue(
      'sqlite_index_changed',
      'The SQLite index has a non-empty or changing WAL; retry while the store is quiescent.',
      'warning'
    )
  }
  if (status === 'limit_exceeded') {
    return issue(
      'sqlite_index_limit_exceeded',
      'The SQLite index could not be inspected within configured byte limits.',
      'warning'
    )
  }
  if (status === 'invalid') {
    return issue(
      'invalid_sqlite_index',
      'The rebuildable SQLite index is invalid and could not be queried from a bounded in-memory snapshot.',
      'error'
    )
  }
  if (status === 'mismatch') {
    return issue(
      'sqlite_index_schema_mismatch',
      'The rebuildable SQLite index does not match the schema required by HybridThreadStore.',
      'error'
    )
  }
  return undefined
}

async function listThreadIds(
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

function normalizeLimits(input: Partial<ThreadStoreDoctorLimits> | undefined): ThreadStoreDoctorLimits {
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

function collectThreadAttachmentIds(thread: ThreadRecord, add: (id: string) => void): void {
  for (const turn of thread.turns) {
    for (const id of turn.attachmentIds ?? []) add(id)
    for (const item of turn.items) {
      if ('attachmentIds' in item) {
        for (const id of item.attachmentIds ?? []) add(id)
      }
    }
  }
}

function isRecoverable(
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

function hasIncompleteStatus(diagnostic: ThreadStoreDiagnostic): boolean {
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

function worseStatus(
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

function attachmentIssueCode(status: ThreadStoreArtifactStatus): string {
  if (status === 'missing') return 'missing_attachment'
  if (status === 'mismatch') return 'attachment_mismatch'
  if (status === 'indeterminate') return 'attachment_scope_indeterminate'
  if (status === 'changed') return 'attachment_changed'
  if (status === 'limit_exceeded') return 'attachment_limit_exceeded'
  return 'invalid_attachment'
}

function attachmentIssueMessage(status: ThreadStoreArtifactStatus): string {
  if (status === 'missing') return 'A referenced attachment artifact is missing.'
  if (status === 'mismatch') return 'A referenced attachment has mismatched metadata, content, or scope.'
  if (status === 'indeterminate') return 'A referenced attachment has workspace scope, but no valid thread workspace could be recovered.'
  if (status === 'changed') return 'A referenced attachment changed while it was inspected.'
  if (status === 'limit_exceeded') return 'A referenced attachment could not be inspected within configured limits.'
  return 'A referenced attachment artifact is invalid.'
}

function issue(
  code: string,
  message: string,
  severity: ThreadStoreDiagnosticIssue['severity']
): ThreadStoreDiagnosticIssue {
  return { code, message, severity }
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

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isFile()
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && samePathSnapshot(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function inspectWal(path: string): Promise<WalState> {
  try {
    const stat = await lstat(path, { bigint: true })
    return stat.isFile() && !stat.isSymbolicLink() ? { kind: 'file', stat } : { kind: 'invalid' }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'invalid' }
  }
}

function sameWalState(left: WalState, right: WalState): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing' && right.kind === 'missing') return true
  if (left.kind !== 'file' || right.kind !== 'file') return false
  return left.stat.size === 0n
    && right.stat.size === 0n
    && sameSnapshot(left.stat, right.stat)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readonlySqliteBuffer(bytes: Buffer): Buffer {
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
