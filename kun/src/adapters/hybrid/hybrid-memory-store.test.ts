import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryCapabilityConfig } from '../../contracts/capabilities.js'
import { HybridMemoryStore } from './hybrid-memory-store.js'

const roots: string[] = []
const policy: MemoryCapabilityConfig = {
  enabled: true,
  scopes: ['user', 'workspace', 'project'],
  maxInjectedRecords: 8
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('HybridMemoryStore', () => {
  it('projects canonical JSON into FTS5 and retrieves bounded Latin and CJK records', async () => {
    const { store } = await createStore()
    await store.createWithId('mem_latin', {
      content: 'Use pnpm for package management', scope: 'workspace', workspace: '/workspace-a'
    })
    await store.createWithId('mem_cjk', {
      content: '中文接口文档需要示例', scope: 'workspace', workspace: '/workspace-a'
    })
    await store.waitForBackfill()

    await expect(store.retrieve({ query: 'pnpm package', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_latin' }])
    await expect(store.retrieve({ query: '中文接口文档', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_cjk' }])
    const diagnostics = await store.diagnostics()
    expect(diagnostics).toMatchObject({
      canonicalCount: 2, indexedCount: 2, staleCount: 0, indexState: 'ready', indexSchemaVersion: 1
    })
    expect(diagnostics.lastRetrieval?.mode).toBe('sqlite-fts5')
    await store.shutdown()
  })

  it('filters temporal lifecycle before FTS ranking and candidate limits', async () => {
    const { store } = await createStore()
    for (let index = 0; index < 20; index += 1) {
      await store.createWithId(`mem_expired_${index}`, {
        content: `exact temporal lifecycle query ${index}`,
        scope: 'workspace',
        workspace: '/workspace-a',
        validTo: '2026-08-27T00:00:00.000Z'
      })
    }
    await store.createWithId('mem_temporal_active', {
      content: 'exact temporal lifecycle query active',
      scope: 'workspace',
      workspace: '/workspace-a'
    })

    await expect(store.retrieve({
      query: 'exact temporal lifecycle query',
      workspace: '/workspace-a',
      limit: 1
    })).resolves.toMatchObject([{ id: 'mem_temporal_active' }])
    expect((await store.diagnostics()).lastRetrieval?.filtered.lifecycle).toBeGreaterThanOrEqual(20)
    await store.shutdown()
  })

  it('keeps canonical success across a projection crash window and reconciles on restart', async () => {
    const root = await tempRoot()
    let failProjection = true
    const first = new HybridMemoryStore({
      dataDir: root, config: policy,
      beforeProject: () => { if (failProjection) throw new Error('simulated projection interruption token=private') }
    })
    await first.ready()
    await first.createWithId('mem_crash', {
      content: 'Canonical data survives projection failure', scope: 'workspace', workspace: '/workspace-a'
    })
    expect(JSON.parse(await readFile(join(root, 'memory', 'mem_crash.json'), 'utf8'))).toMatchObject({ id: 'mem_crash' })
    const degraded = await first.diagnostics()
    expect(degraded.indexState).toBe('degraded')
    expect(degraded.degradedReason).toContain('token=[redacted]')
    await first.shutdown()

    failProjection = false
    const second = new HybridMemoryStore({ dataDir: root, config: policy })
    await second.waitForBackfill()
    await expect(second.retrieve({ query: 'projection failure', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_crash' }])
    expect(await second.diagnostics()).toMatchObject({ indexState: 'ready', staleCount: 0 })
    await second.shutdown()
  })

  it('rebuilds a deleted index from canonical files without losing lifecycle state', async () => {
    const root = await tempRoot()
    const first = new HybridMemoryStore({ dataDir: root, config: policy })
    await first.createWithId('mem_rebuild', {
      content: 'Rebuild this indexed memory', scope: 'workspace', workspace: '/workspace-a'
    })
    await first.update('mem_rebuild', { disabled: true }, { workspace: '/workspace-a' })
    await first.shutdown()
    await removeIndexFiles(root)

    const second = new HybridMemoryStore({ dataDir: root, config: policy })
    await second.waitForBackfill()
    expect(await second.retrieve({ query: 'rebuild indexed', workspace: '/workspace-a', limit: 3 })).toEqual([])
    expect((await second.list({ all: true })).find((record) => record.id === 'mem_rebuild')?.disabledAt).toBeTruthy()
    expect(await second.diagnostics()).toMatchObject({ canonicalCount: 1, indexedCount: 1, staleCount: 0 })
    await second.shutdown()
  })

  it('falls back for corrupt SQLite and migration failure without deleting damaged JSON', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory-index.sqlite3'), 'not a database')
    await writeFile(join(root, 'memory', 'damaged.json'), '{broken')
    const corrupt = new HybridMemoryStore({ dataDir: root, config: policy })
    await corrupt.ready()
    await corrupt.createWithId('mem_fallback', {
      content: 'Filesystem fallback remains available', scope: 'workspace', workspace: '/workspace-a'
    })
    await expect(corrupt.retrieve({ query: 'filesystem fallback', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_fallback' }])
    expect(await corrupt.diagnostics()).toMatchObject({ indexState: 'degraded', malformedCount: 1 })
    expect(await readFile(join(root, 'memory', 'damaged.json'), 'utf8')).toBe('{broken')
    await corrupt.shutdown()

    await removeIndexFiles(root)
    const migrationFailure = new HybridMemoryStore({
      dataDir: root,
      config: policy,
      beforeMigrate: () => { throw new Error('simulated migration failure') }
    })
    await migrationFailure.ready()
    await expect(migrationFailure.retrieve({ query: 'filesystem fallback', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_fallback' }])
    expect((await migrationFailure.diagnostics()).degradedReason).toContain('migration failure')
    await migrationFailure.shutdown()
  })

  it('converges lifecycle and purge projections and protects exact paths', async () => {
    const { root, store } = await createStore()
    await store.createWithId('mem_lifecycle', {
      content: 'Lifecycle projection', scope: 'workspace', workspace: '/workspace-a'
    })
    await store.update('mem_lifecycle', { disabled: true }, { workspace: '/workspace-a' })
    expect(await store.retrieve({ query: 'lifecycle', workspace: '/workspace-a', limit: 3 })).toEqual([])
    await store.update('mem_lifecycle', { disabled: false }, { workspace: '/workspace-a' })
    await expect(store.retrieve({ query: 'lifecycle', workspace: '/workspace-a', limit: 3 }))
      .resolves.toMatchObject([{ id: 'mem_lifecycle' }])
    await store.delete('mem_lifecycle', { workspace: '/workspace-a' })
    expect(await store.retrieve({ query: 'lifecycle', workspace: '/workspace-a', limit: 3 })).toEqual([])
    await store.purge('mem_lifecycle')
    expect(await store.list({ all: true, includeDeleted: true })).toEqual([])
    expect(await store.diagnostics()).toMatchObject({ canonicalCount: 0, indexedCount: 0 })
    await expect(store.createWithId('../escape', { content: 'bad', scope: 'user' })).rejects.toThrow(/invalid memory id/u)
    expect(() => new HybridMemoryStore({
      dataDir: root, config: policy, sqlitePath: join(root, '..', 'outside.sqlite3')
    })).toThrow(/below the configured data directory/u)
    await store.shutdown()
  })

  it('serializes concurrent canonical writes and returns stable ordering', async () => {
    const { store } = await createStore()
    await Promise.all(Array.from({ length: 16 }, (_, index) => store.createWithId(`mem_concurrent_${index}`, {
      content: `Concurrent memory ${index}`, scope: 'workspace', workspace: '/workspace-a'
    })))
    await store.waitForBackfill()
    const first = (await store.retrieve({ query: 'concurrent memory', workspace: '/workspace-a', limit: 8 }))
      .map((record) => record.id)
    const second = (await store.retrieve({ query: 'concurrent memory', workspace: '/workspace-a', limit: 8 }))
      .map((record) => record.id)
    expect(first).toEqual(second)
    expect(first).toHaveLength(8)
    expect(await store.diagnostics()).toMatchObject({ canonicalCount: 16, indexedCount: 16, staleCount: 0 })
    await store.shutdown()
  })
})

async function createStore(): Promise<{ root: string; store: HybridMemoryStore }> {
  const root = await tempRoot()
  const store = new HybridMemoryStore({
    dataDir: root,
    config: policy,
    nowIso: () => '2026-08-28T00:00:00.000Z'
  })
  await store.ready()
  return { root, store }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-hybrid-memory-'))
  roots.push(root)
  return root
}

async function removeIndexFiles(root: string): Promise<void> {
  await Promise.all(['memory-index.sqlite3', 'memory-index.sqlite3-wal', 'memory-index.sqlite3-shm']
    .map((name) => rm(join(root, name), { force: true })))
}
