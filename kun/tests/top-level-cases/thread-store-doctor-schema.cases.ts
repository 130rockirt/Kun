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
})
