import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HybridThreadDocumentRepository } from '../src/adapters/hybrid/hybrid-thread-documents.js'
import { HybridThreadStore } from '../src/adapters/hybrid/hybrid-thread-store.js'
import type { ThreadRecord } from '../src/contracts/threads.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { createTurnRecord } from '../src/domain/turn.js'
import { scanThreadStore } from '../src/services/thread-store-doctor.js'

const roots: string[] = []
const NOW = '2026-07-18T00:00:00.000Z'

describe('scanThreadStore', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('scans canonical JSONL and a SQLite index without mutating the store', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_healthy',
      title: 'Healthy',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const store = new HybridThreadStore({ dataDir: root })
    await store.upsert(thread)
    await store.shutdown()
    const threadRoot = join(root, 'threads', thread.id)
    await writeFile(join(threadRoot, 'messages.jsonl'), '')
    await writeFile(join(threadRoot, 'events.jsonl'), '')
    const before = await snapshotFiles(root)

    const report = await scanThreadStore({ dataDir: root, nowIso: () => NOW })

    expect(report.complete).toBe(true)
    expect(report.threads[0]).toMatchObject({
      threadId: thread.id,
      metadata: 'ok',
      metadataSource: 'metadata_jsonl',
      messages: 'ok',
      events: 'ok',
      sqliteIndex: 'ok',
      attachments: 'ok',
      recoverable: true
    })
    expect(await snapshotFiles(root)).toEqual(before)
  })

  it('fails closed on a non-empty SQLite WAL without touching disk sidecars', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_wal',
      title: 'WAL',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    const sqlitePath = join(root, 'index.sqlite3')
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(sqlitePath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('wal_autocheckpoint = 0')
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, metadata_path TEXT, messages_path TEXT, events_path TEXT)')
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
        thread.id,
        join(threadRoot, 'metadata.jsonl'),
        join(threadRoot, 'messages.jsonl'),
        join(threadRoot, 'events.jsonl')
      )
      expect((await stat(`${sqlitePath}-wal`)).size).toBeGreaterThan(0)
      const before = await snapshotFiles(root)

      const report = await scanThreadStore({ dataDir: root })

      expect(report.complete).toBe(false)
      expect(report.threads[0]?.sqliteIndex).toBe('changed')
      expect(report.threads[0]?.issues).toContainEqual(expect.objectContaining({
        code: 'sqlite_index_changed'
      }))
      expect(await snapshotFiles(root)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('reports a damaged SQLite index globally when there are no thread directories', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'index.sqlite3'), 'not a sqlite database')

    const report = await scanThreadStore({ dataDir: root })

    expect(report.threads).toEqual([])
    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_sqlite_index',
      severity: 'error'
    }))
  })

  it('rejects the partial SQLite schema that makes HybridThreadStore fall back', async () => {
    const root = await makeRoot()
    const thread = createThreadRecord({
      id: 'thr_partial_index',
      title: 'Partial index',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = await writeCanonicalThread(root, thread)
    const sqlitePath = join(root, 'index.sqlite3')
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(sqlitePath)
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, metadata_path TEXT, messages_path TEXT, events_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
      thread.id,
      join(threadRoot, 'metadata.jsonl'),
      join(threadRoot, 'messages.jsonl'),
      join(threadRoot, 'events.jsonl')
    )
    db.close()

    const report = await scanThreadStore({ dataDir: root })

    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'sqlite_index_schema_mismatch',
      severity: 'error'
    }))
    expect(report.threads[0]?.sqliteIndex).toBe('mismatch')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new HybridThreadStore({ dataDir: root })
    try {
      await store.ready()
      expect(await store.get(thread.id)).toMatchObject({ id: thread.id })
      await expect(store.loadUsageRecords()).rejects.toThrow('hybrid sqlite unavailable')
    } finally {
      await store.shutdown()
      warn.mockRestore()
    }
  })

  it('rejects an otherwise canonical SQLite index with a required index missing', async () => {
    const root = await makeRoot()
    const sqlitePath = join(root, 'index.sqlite3')
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(sqlitePath)
    createCanonicalSqliteSchema(db)
    db.exec('DROP INDEX usage_events_timestamp_idx')
    db.close()

    const report = await scanThreadStore({ dataDir: root })

    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'sqlite_index_schema_mismatch'
    }))
  })

  it.each(['VIRTUAL', 'STORED'] as const)(
    'rejects an extra %s generated column before evaluating its allocation bomb',
    async (generatedThreadColumn) => {
      const root = await makeRoot()
      await createSqliteVariant(root, { generatedThreadColumn })

      await expectDoctorSchemaMismatch(root)
    }
  )

  it('accepts the healthy column order produced by historical ALTER migrations', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, { legacyMigratedOrder: true })

    const report = await scanThreadStore({ dataDir: root })

    expect(report.complete).toBe(true)
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'sqlite_index_schema_mismatch'
    }))
  })

  it('rejects an extra table before evaluating its failing CHECK constraint', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, {}, (db) => {
      db.exec(`
        CREATE TABLE extension_cache (
          value INTEGER CHECK (value > 0)
        );
        PRAGMA ignore_check_constraints = ON;
        INSERT INTO extension_cache VALUES (0);
        PRAGMA ignore_check_constraints = OFF;
      `)
      expect(db.pragma('quick_check', { simple: true })).not.toBe('ok')
    })

    const report = await scanThreadStore({ dataDir: root })

    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'sqlite_index_schema_mismatch'
    }))
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'invalid_sqlite_index'
    }))
  })

  it('rejects an extra table with an inbound foreign key to threads', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, {}, (db) => {
      db.exec(`
        CREATE TABLE extension_children (
          thread_id TEXT NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
        )
      `)
    })

    await expectDoctorSchemaMismatch(root)
  })

  it('does not exhaust or reject the write probe when 10,000 legacy candidate ids exist', async () => {
    const root = await makeRoot()
    const sqlite = await import('better-sqlite3')
    const db = new sqlite.default(join(root, 'index.sqlite3'))
    try {
      createCanonicalSqliteSchema(db)
      db.transaction(() => {
        for (let index = 0; index < 10_000; index += 1) {
          const id = `thr_kun_doctor_probe_${index}`
          insertCanonicalIndexRow(db, { id, threadRoot: join(root, 'threads', id) })
        }
      })()
    } finally {
      db.close()
    }

    const report = await scanThreadStore({
      dataDir: root,
      limits: {
        maxThreads: 10_000,
        maxArtifactBytes: 64 * 1024 * 1024,
        maxTotalBytes: 64 * 1024 * 1024
      }
    })

    expect(report.complete).toBe(true)
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'sqlite_index_schema_mismatch'
    }))
  })

  it.each([
    {
      label: 'usage_backfilled has no default',
      schema: { usageBackfilledDefault: 'none' as const },
      title: 'Missing default'
    },
    {
      label: 'threads has a CHECK constraint',
      schema: { titleCheck: true },
      title: 'Kun doctor schema probe'
    }
  ])('rejects $label after the real runtime thread write fails', async ({ schema, title }) => {
    const root = await makeRoot()
    await createSqliteVariant(root, schema)
    const thread = createThreadRecord({
      id: 'thr_runtime_write_failure',
      title,
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })

    await withRuntimeStore(root, async (store) => {
      await store.upsert(thread)
    })

    const indexed = await readSqliteRow<{ count: number }>(
      root,
      'SELECT COUNT(*) AS count FROM threads WHERE id = ?',
      thread.id
    )
    expect(indexed?.count).toBe(0)
    await expectDoctorSchemaMismatch(root)
  })

  it('rejects usage_backfilled DEFAULT 1 after the real runtime persists the wrong state', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, { usageBackfilledDefault: 'one' })
    const thread = createThreadRecord({
      id: 'thr_wrong_backfill_default',
      title: 'Wrong default',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })

    await withRuntimeStore(root, async (store) => {
      await store.upsert(thread)
    })

    const indexed = await readSqliteRow<{ usage_backfilled: number }>(
      root,
      'SELECT usage_backfilled FROM threads WHERE id = ?',
      thread.id
    )
    expect(indexed?.usage_backfilled).toBe(1)
    await expectDoctorSchemaMismatch(root)
  })

  it.each([
    {
      label: 'an extra UNIQUE timestamp index',
      sql: 'CREATE UNIQUE INDEX extra_usage_timestamp_unique ON usage_events(timestamp)'
    },
    {
      label: 'a partial expression index',
      sql: `
        CREATE UNIQUE INDEX extra_usage_turns_partial
        ON usage_events(json_extract(usage_json, '$.turns'))
        WHERE json_valid(usage_json)
      `
    }
  ])('rejects $label after the real runtime loses the second usage write', async ({ sql }) => {
    const root = await makeRoot()
    await createSqliteVariant(root, {}, (db) => db.exec(sql))
    const thread = createThreadRecord({
      id: 'thr_usage_index_semantics',
      title: 'Usage index semantics',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const usage = {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cacheHitRate: null,
      turns: 1
    }

    await withRuntimeStore(root, async (store) => {
      await store.upsert(thread)
      await store.noteEvent({
        kind: 'usage', seq: 1, timestamp: NOW, threadId: thread.id, usage
      })
      await store.noteEvent({
        kind: 'usage', seq: 2, timestamp: NOW, threadId: thread.id, usage
      })
    })

    const indexed = await readSqliteRow<{ count: number }>(
      root,
      'SELECT COUNT(*) AS count FROM usage_events WHERE thread_id = ?',
      thread.id
    )
    expect(indexed?.count).toBe(1)
    await expectDoctorSchemaMismatch(root)
  })

  it('rejects a threads update trigger after the real runtime silently keeps stale data', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, {}, (db) => db.exec(`
      CREATE TRIGGER preserve_thread_update
      BEFORE UPDATE ON threads
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `))
    const thread = createThreadRecord({
      id: 'thr_trigger_semantics',
      title: 'Before trigger',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })

    await withRuntimeStore(root, async (store) => {
      await store.upsert(thread)
      await store.upsert({ ...thread, title: 'After trigger' })
    })

    const indexed = await readSqliteRow<{ title: string }>(
      root,
      'SELECT title FROM threads WHERE id = ?',
      thread.id
    )
    expect(indexed?.title).toBe('Before trigger')
    await expectDoctorSchemaMismatch(root)
  })

  it('rejects a NOCASE primary-key index after case-distinct runtime writes collapse', async () => {
    const root = await makeRoot()
    await createSqliteVariant(root, { threadIdNoCase: true })
    const lower = createThreadRecord({
      id: 'thr_case_semantics',
      title: 'Lower case',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const upper = { ...lower, id: lower.id.toUpperCase(), title: 'Upper case' }

    await withRuntimeStore(root, async (store) => {
      await store.upsert(lower)
      await store.upsert(upper)
    })

    const indexed = await readSqliteRow<{ count: number }>(
      root,
      'SELECT COUNT(*) AS count FROM threads WHERE lower(id) = lower(?)',
      lower.id
    )
    expect(indexed?.count).toBe(1)
    await expectDoctorSchemaMismatch(root)
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

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-'))
  roots.push(root)
  return root
}

type TestSqliteSchemaOptions = {
  usageBackfilledDefault?: 'none' | 'zero' | 'one'
  titleCheck?: boolean
  threadIdNoCase?: boolean
  generatedThreadColumn?: 'VIRTUAL' | 'STORED'
  legacyMigratedOrder?: boolean
}

async function createSqliteVariant(
  root: string,
  options: TestSqliteSchemaOptions = {},
  mutate?: (db: BetterSqliteDatabase) => void
): Promise<void> {
  const sqlite = await import('better-sqlite3')
  const db = new sqlite.default(join(root, 'index.sqlite3'))
  try {
    createCanonicalSqliteSchema(db, options)
    mutate?.(db)
  } finally {
    db.close()
  }
}

async function withRuntimeStore(
  root: string,
  action: (store: HybridThreadStore) => Promise<void>
): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const store = new HybridThreadStore({ dataDir: root })
  try {
    await store.ready()
    await store.waitForBackfill()
    await action(store)
  } finally {
    await store.shutdown()
    warn.mockRestore()
  }
}

async function readSqliteRow<T>(
  root: string,
  sql: string,
  ...params: Array<string | number>
): Promise<T | undefined> {
  const sqlite = await import('better-sqlite3')
  const db = new sqlite.default(join(root, 'index.sqlite3'), { readonly: true })
  try {
    return db.prepare(sql).get(...params) as T | undefined
  } finally {
    db.close()
  }
}

async function expectDoctorSchemaMismatch(root: string): Promise<void> {
  const report = await scanThreadStore({ dataDir: root })
  expect(report.complete).toBe(false)
  expect(report.issues).toContainEqual(expect.objectContaining({
    code: 'sqlite_index_schema_mismatch',
    severity: 'error'
  }))
  for (const diagnostic of report.threads) expect(diagnostic.sqliteIndex).toBe('mismatch')
}

async function writeCanonicalThread(
  root: string,
  thread: ThreadRecord
): Promise<string> {
  const threadRoot = join(root, 'threads', thread.id)
  await mkdir(threadRoot, { recursive: true })
  await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
    kind: 'thread_metadata',
    version: 1,
    timestamp: NOW,
    thread
  })}\n`)
  await writeFile(join(threadRoot, 'messages.jsonl'), '')
  await writeFile(join(threadRoot, 'events.jsonl'), '')
  return threadRoot
}

async function writeAttachment(
  root: string,
  id: string,
  scopes: { threadIds: string[]; workspaces: string[] }
): Promise<void> {
  const content = Buffer.from('attachment payload')
  const attachmentRoot = join(root, 'attachments')
  await mkdir(attachmentRoot, { recursive: true })
  await writeFile(join(attachmentRoot, `${id}.json`), JSON.stringify({
    id,
    name: 'file.txt',
    kind: 'document',
    mimeType: 'text/plain',
    byteSize: content.length,
    hash: createHash('sha256').update(content).digest('hex'),
    threadIds: scopes.threadIds,
    workspaces: scopes.workspaces,
    createdAt: NOW,
    updatedAt: NOW
  }))
  await writeFile(join(attachmentRoot, `${id}.bin`), content)
}

function createCanonicalSqliteSchema(
  db: BetterSqliteDatabase,
  options: TestSqliteSchemaOptions = {}
): void {
  const usageBackfilled = options.usageBackfilledDefault === 'none'
    ? 'INTEGER NOT NULL'
    : options.usageBackfilledDefault === 'one'
      ? 'INTEGER NOT NULL DEFAULT 1'
      : 'INTEGER NOT NULL DEFAULT 0'
  const titleCheck = options.titleCheck
    ? "TEXT NOT NULL CHECK (title <> 'Kun doctor schema probe')"
    : 'TEXT NOT NULL'
  const threadId = options.threadIdNoCase
    ? 'TEXT COLLATE NOCASE PRIMARY KEY'
    : 'TEXT PRIMARY KEY'
  const generatedThreadColumn = options.generatedThreadColumn
    ? `, generated_bomb BLOB GENERATED ALWAYS AS (zeroblob(1073741824)) ${options.generatedThreadColumn}`
    : ''
  const jsonColumnsBeforeDates = options.legacyMigratedOrder
    ? ''
    : `
      todos_json TEXT,
      extension_metadata_json TEXT,`
  const jsonColumnsAfterSearch = options.legacyMigratedOrder
    ? `
      todos_json TEXT,
      extension_metadata_json TEXT,`
    : ''
  db.exec(`
    CREATE TABLE threads (
      id ${threadId},
      title ${titleCheck},
      workspace TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      sandbox_mode TEXT NOT NULL,
      cost_budget_usd REAL,
      cost_budget_warning_sent INTEGER,
      relation TEXT NOT NULL,
      parent_thread_id TEXT,
      forked_from_thread_id TEXT,
      forked_from_title TEXT,
      forked_at TEXT,
      forked_from_message_count INTEGER,
      forked_from_turn_count INTEGER,
      goal_json TEXT,
      ${jsonColumnsBeforeDates}
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      preview TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      event_seq_high_water INTEGER NOT NULL DEFAULT 0,
      metadata_path TEXT NOT NULL,
      messages_path TEXT NOT NULL,
      events_path TEXT NOT NULL,
      search_text TEXT NOT NULL,
      ${jsonColumnsAfterSearch}
      usage_backfilled ${usageBackfilled}${generatedThreadColumn}
    );
    CREATE INDEX threads_updated_idx
      ON threads(updated_at_ms DESC, id DESC);
    CREATE INDEX threads_workspace_updated_idx
      ON threads(workspace, updated_at_ms DESC, id DESC);
    CREATE INDEX threads_status_updated_idx
      ON threads(status, updated_at_ms DESC, id DESC);
    CREATE INDEX threads_relation_updated_idx
      ON threads(relation, updated_at_ms DESC, id DESC);
    CREATE TABLE usage_events (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      turn_id TEXT,
      model TEXT,
      usage_json TEXT NOT NULL,
      PRIMARY KEY(thread_id, seq)
    );
    CREATE INDEX usage_events_thread_seq_idx
      ON usage_events(thread_id, seq);
    CREATE INDEX usage_events_timestamp_idx
      ON usage_events(timestamp);
  `)
}

function insertCanonicalIndexRow(
  db: BetterSqliteDatabase,
  input: { id: string | Buffer; threadRoot: string; thread?: ThreadRecord }
): void {
  const thread = input.thread
  const createdAt = thread?.createdAt ?? NOW
  const updatedAt = thread?.updatedAt ?? NOW
  db.prepare(`
    INSERT INTO threads (
      id, title, workspace, model, mode, status, approval_policy, sandbox_mode,
      relation, created_at, updated_at, created_at_ms, updated_at_ms,
      message_count, event_seq_high_water, metadata_path, messages_path,
      events_path, search_text, usage_backfilled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    thread?.title ?? 'Indexed thread',
    thread?.workspace ?? '/workspace',
    thread?.model ?? 'deepseek-chat',
    thread?.mode ?? 'agent',
    thread?.status ?? 'idle',
    thread?.approvalPolicy ?? 'on-request',
    thread?.sandboxMode ?? 'workspace-write',
    thread?.relation ?? 'primary',
    createdAt,
    updatedAt,
    Date.parse(createdAt),
    Date.parse(updatedAt),
    0,
    0,
    join(input.threadRoot, 'metadata.jsonl'),
    join(input.threadRoot, 'messages.jsonl'),
    join(input.threadRoot, 'events.jsonl'),
    thread?.title ?? 'Indexed thread',
    0
  )
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, relative)
      else if (entry.isFile()) {
        const info = await stat(path)
        output[relative] = `${info.size}:${(await readFile(path)).toString('base64')}`
      }
    }
  }
  await visit(root)
  return output
}
