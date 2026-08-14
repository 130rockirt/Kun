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
import { readBoundedFile, ScanBudget } from './thread-store-doctor-stability.js'
import { AttachmentInspector, type ReadonlyIndexState } from './thread-store-doctor-attachments.js'
import { globalSqliteIssue, inspectSqliteIndex, openReadonlyIndex, sqliteIndex } from './thread-store-doctor-sqlite.js'
import { collectThreadAttachmentIds, decodeUtf8, hasIncompleteStatus, isJsonWhitespaceOnly, isRecord, isRecoverable, issue, listThreadIds, normalizeLimits, worseStatus } from './thread-store-doctor-support.js'

export const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{24}$/

export const MAX_REPORT_ISSUES = 64

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

export const HARD_LIMITS: ThreadStoreDoctorLimits = {
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

export type JsonlInspection = {
  status: ThreadStoreArtifactStatus
  validRecords: number
  invalidRecords: number
  issues: ThreadStoreDiagnosticIssue[]
  thread?: ThreadRecord
  metadataSource?: ThreadStoreMetadataSource
}

export type BoundedReadResult =
  | { kind: 'ok'; bytes: Buffer; stat: BigIntStats }
  | { kind: 'missing' | 'not_file' | 'artifact_limit' | 'total_limit' | 'changed' | 'unreadable' }

export type AttachmentBaseInspection = {
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

export async function scanThread(input: {
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

export async function inspectMetadata(
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

export async function inspectJsonl(
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

export function jsonReadFailure(
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
