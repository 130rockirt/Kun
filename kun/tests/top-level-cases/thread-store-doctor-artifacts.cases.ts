import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HybridThreadDocumentRepository } from '../../src/adapters/hybrid/hybrid-thread-documents.js'
import { HybridThreadStore } from '../../src/adapters/hybrid/hybrid-thread-store.js'
import type { ThreadRecord } from '../../src/contracts/threads.js'
import { createThreadRecord } from '../../src/domain/thread.js'
import { createTurnRecord } from '../../src/domain/turn.js'
import { scanThreadStore } from '../../src/services/thread-store-doctor.js'
import { NOW, createCanonicalSqliteSchema, createSqliteVariant, expectDoctorSchemaMismatch, insertCanonicalIndexRow, makeRoot, readSqliteRow, roots, snapshotFiles, withRuntimeStore, writeAttachment, writeCanonicalThread } from '../support/thread-store-doctor-fixtures.js'

describe('scanThreadStore', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reports index-only rows as stale rebuildable orphans without synthesizing threads', async () => {
    const root = await makeRoot()
    const sqlitePath = join(root, 'index.sqlite3')
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(sqlitePath)
    createCanonicalSqliteSchema(db)
    insertCanonicalIndexRow(db, {
      id: 'thr_orphan',
      threadRoot: join(root, 'threads', 'thr_orphan')
    })
    db.close()

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads).toEqual([])
    expect(report.complete).toBe(true)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'orphan_sqlite_index_rows',
      severity: 'warning'
    }))
  })

  it('reports non-string SQLite thread ids as index corruption', async () => {
    const root = await makeRoot()
    const sqlitePath = join(root, 'index.sqlite3')
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(sqlitePath)
    createCanonicalSqliteSchema(db)
    insertCanonicalIndexRow(db, {
      id: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      threadRoot: join(root, 'threads', 'invalid')
    })
    db.close()

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads).toEqual([])
    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_sqlite_index_rows',
      severity: 'error'
    }))
  })

  it('detects mixed valid and malformed interior records instead of hiding them', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_mixed',
      title: 'Mixed',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    const valid = JSON.stringify({ kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id })
    const later = JSON.stringify({ kind: 'heartbeat', seq: 2, timestamp: NOW, threadId: thread.id })
    await writeFile(join(threadRoot, 'events.jsonl'), `${valid}\n{"broken":\n${later}\n`)

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads[0]).toMatchObject({ events: 'invalid', recoverable: false })
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({ code: 'invalid_jsonl_records' }))
  })

  it('distinguishes a malformed final record when a valid prefix exists', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_tail',
      title: 'Tail',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    const valid = JSON.stringify({ kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id })
    await writeFile(join(threadRoot, 'events.jsonl'), `${valid}\n{"kind":"heartbeat"`)

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads[0]).toMatchObject({ events: 'truncated', recoverable: true })
  })

  it('matches runtime fallback to thread.json when metadata.jsonl has no valid snapshot', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_legacy_fallback',
      title: 'Legacy fallback',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    await writeFile(join(threadRoot, 'metadata.jsonl'), '')
    await writeFile(join(threadRoot, 'thread.json'), JSON.stringify(thread))

    const runtimeDocuments = new HybridThreadDocumentRepository(root)
    expect(await runtimeDocuments.readThread(thread.id)).toMatchObject({ id: thread.id })

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads[0]).toMatchObject({
      metadata: 'invalid',
      metadataSource: 'legacy_thread_json',
      recoverable: true
    })
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'legacy_metadata_fallback'
    }))
  })

  it('scans dense newline input without materializing one object per line', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_dense_newlines',
      title: 'Dense newlines',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    await writeFile(join(threadRoot, 'events.jsonl'), Buffer.alloc(1_000_000, 0x0a))

    const report = await scanThreadStore({
      dataDir: root,
      limits: { maxRecordsPerArtifact: 1, maxTotalRecords: 2 }
    })

    expect(report.threads[0]?.events).toBe('ok')
    expect(report.scanned.records).toBe(1)
  })

  it('enforces artifact and thread bounds', async () => {
    const root = await makeRoot()
    for (const id of ['thr_a', 'thr_b']) {
      const thread = createThreadRecord({ id, title: id, workspace: root, model: 'deepseek-chat', createdAt: NOW })
      const threadRoot = await writeCanonicalThread(root, thread)
      await writeFile(join(threadRoot, 'events.jsonl'), `${' '.repeat(80)}\n`)
    }

    const report = await scanThreadStore({
      dataDir: root,
      limits: {
        maxThreads: 1,
        maxAttachments: 1,
        maxRecordsPerArtifact: 2,
        maxTotalRecords: 2,
        maxArtifactBytes: 64,
        maxTotalBytes: 128
      }
    })

    expect(report.complete).toBe(false)
    expect(report.scanned.threads).toBe(1)
    expect(report.scanned.bytes).toBeLessThanOrEqual(128)
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'thread_limit_exceeded' }))
    expect(report.threads[0]?.metadata).toBe('limit_exceeded')
  })

  it('enforces per-artifact record and total byte budgets independently', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_budgets',
      title: 'Budgets',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    const event = JSON.stringify({ kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id })
    await writeFile(join(threadRoot, 'events.jsonl'), `${event}\n${event}\n`)

    const recordReport = await scanThreadStore({
      dataDir: root,
      limits: { maxRecordsPerArtifact: 1, maxTotalRecords: 10 }
    })
    expect(recordReport.threads[0]?.events).toBe('limit_exceeded')
    expect(recordReport.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'artifact_record_limit_exceeded'
    }))

    const metadataBytes = (await stat(join(threadRoot, 'metadata.jsonl'))).size
    const byteReport = await scanThreadStore({
      dataDir: root,
      limits: { maxArtifactBytes: metadataBytes, maxTotalBytes: metadataBytes }
    })
    expect(byteReport.threads[0]?.events).toBe('limit_exceeded')
    expect(byteReport.scanned.bytes).toBe(metadataBytes)
    expect(byteReport.issues).toContainEqual(expect.objectContaining({ code: 'total_byte_limit_exceeded' }))
  })

  it('caps referenced attachment inspection and validates content size and scope', async () => {
    const root = await makeRoot()
    const ids = ['att_0123456789abcdef01234567', 'att_1123456789abcdef01234567']
    const thread = createThreadRecord({
      id: 'thr_attachments',
      title: 'Attachments',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const withAttachments = {
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_attachments',
        threadId: thread.id,
        prompt: 'files',
        attachmentIds: ids
      })]
    }
    await writeCanonicalThread(root, withAttachments)
    const attachmentRoot = join(root, 'attachments')
    await mkdir(attachmentRoot, { recursive: true })
    for (const id of ids) {
      await writeFile(join(attachmentRoot, `${id}.json`), JSON.stringify({
        id,
        name: 'file.txt',
        kind: 'document',
        mimeType: 'text/plain',
        byteSize: 3,
        hash: 'a'.repeat(64),
        threadIds: [thread.id],
        workspaces: [],
        createdAt: NOW,
        updatedAt: NOW
      }))
      // Same byte length as metadata, but deliberately wrong SHA-256.
      await writeFile(join(attachmentRoot, `${id}.bin`), 'bad')
    }

    const report = await scanThreadStore({
      dataDir: root,
      limits: { maxAttachments: 1 }
    })

    expect(report.scanned.attachments).toBe(1)
    expect(report.threads[0]?.attachments).toBe('limit_exceeded')
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'attachment_mismatch'
    }))
    expect(report.complete).toBe(false)
  })

  it('keeps reference overflow incomplete when an invalid attachment dominates status', async () => {
    const root = await makeRoot()
    const ids = ['att_9123456789abcdef01234567', 'att_a123456789abcdef01234567']
    const thread = createThreadRecord({
      id: 'thr_attachment_overflow_hidden',
      title: 'Attachment overflow hidden',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    await writeCanonicalThread(root, {
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_attachment_overflow_hidden',
        threadId: thread.id,
        prompt: 'files',
        attachmentIds: ids
      })]
    })
    const attachmentRoot = join(root, 'attachments')
    await mkdir(attachmentRoot, { recursive: true })
    await writeFile(join(attachmentRoot, `${ids[0]}.json`), '{}')

    const report = await scanThreadStore({
      dataDir: root,
      limits: { maxAttachments: 1 }
    })

    expect(report.scanned.attachments).toBe(1)
    expect(report.threads[0]?.attachments).toBe('invalid')
    expect(report.threads[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_attachment' }),
      expect.objectContaining({ code: 'attachment_limit_exceeded' })
    ]))
    expect(report.complete).toBe(false)
  })

  it('uses the attachment store thread-or-workspace and global scope semantics', async () => {
    const root = await makeRoot()
    const ids = ['att_2123456789abcdef01234567', 'att_3123456789abcdef01234567']
    const thread = createThreadRecord({
      id: 'thr_attachment_scope',
      title: 'Attachment scope',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    await writeCanonicalThread(root, {
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_attachment_scope',
        threadId: thread.id,
        prompt: 'files',
        attachmentIds: ids
      })]
    })
    await writeAttachment(root, ids[0]!, {
      threadIds: ['thr_someone_else'],
      workspaces: [root]
    })
    await writeAttachment(root, ids[1]!, { threadIds: [], workspaces: [] })

    const report = await scanThreadStore({ dataDir: root })

    expect(report.scanned.attachments).toBe(2)
    expect(report.threads[0]).toMatchObject({
      attachments: 'ok',
      recoverable: true
    })
  })

  it('bounds attachment scope counts and item lengths before Zod clones metadata', async () => {
    const root = await makeRoot()
    const ids = [
      'att_4123456789abcdef01234567',
      'att_5123456789abcdef01234567',
      'att_6123456789abcdef01234567'
    ]
    const thread = createThreadRecord({
      id: 'thr_attachment_scope_limits',
      title: 'Attachment scope limits',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    await writeCanonicalThread(root, {
      ...thread,
      turns: [createTurnRecord({
        id: 'turn_attachment_scope_limits',
        threadId: thread.id,
        prompt: 'files',
        attachmentIds: ids
      })]
    })
    await writeAttachment(root, ids[0]!, { threadIds: [thread.id], workspaces: [] })
    await writeFile(join(root, 'attachments', `${ids[0]}.json`), '{}')
    await writeAttachment(root, ids[1]!, {
      threadIds: ['one', 'two'],
      workspaces: []
    })
    await writeAttachment(root, ids[2]!, {
      threadIds: ['123456789'],
      workspaces: []
    })

    const report = await scanThreadStore({
      dataDir: root,
      limits: {
        maxAttachmentScopeEntries: 1,
        maxAttachmentScopeItemChars: 8
      }
    })

    expect(report.scanned.attachments).toBe(3)
    expect(report.threads[0]?.attachments).toBe('invalid')
    expect(report.complete).toBe(false)
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_attachment'
    }))
    expect(report.threads[0]?.issues.filter((item) => (
      item.code === 'attachment_limit_exceeded'
    ))).toHaveLength(2)
  })

  it('does not authorize workspace-scoped attachments when thread workspace is unknown', async () => {
    const root = await makeRoot()
    const threadId = 'thr_unknown_workspace'
    const attachmentIds = [
      'att_7123456789abcdef01234567',
      'att_8123456789abcdef01234567'
    ]
    const threadRoot = join(root, 'threads', threadId)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), '')
    await writeFile(join(threadRoot, 'messages.jsonl'), `${JSON.stringify({
      id: 'item_unknown_workspace',
      turnId: 'turn_unknown_workspace',
      threadId,
      role: 'user',
      status: 'completed',
      createdAt: NOW,
      kind: 'user_message',
      text: 'file',
      attachmentIds
    })}\n`)
    await writeFile(join(threadRoot, 'events.jsonl'), '')
    await writeAttachment(root, attachmentIds[0]!, {
      threadIds: ['thr_someone_else'],
      workspaces: []
    })
    await writeAttachment(root, attachmentIds[1]!, { threadIds: [], workspaces: [root] })

    const report = await scanThreadStore({ dataDir: root })

    expect(report.complete).toBe(false)
    expect(report.threads[0]).toMatchObject({
      metadataSource: 'none',
      attachments: 'mismatch',
      recoverable: false
    })
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'attachment_mismatch',
      severity: 'error'
    }))
    expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
      code: 'attachment_scope_indeterminate',
      severity: 'warning'
    }))
  })

  it('bounds junk directory traversal independently from valid thread count', async () => {
    const root = await makeRoot()
    const threadsRoot = join(root, 'threads')
    await mkdir(threadsRoot, { recursive: true })
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(threadsRoot, `junk-${index}.txt`), 'junk')
    }

    const report = await scanThreadStore({
      dataDir: root,
      limits: { maxThreads: 10, maxDirectoryEntries: 2 }
    })

    expect(report.complete).toBe(false)
    expect(report.scanned.threads).toBe(0)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'directory_entry_limit_exceeded'
    }))
  })
})
