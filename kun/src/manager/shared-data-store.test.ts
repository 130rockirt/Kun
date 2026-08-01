import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createThreadRecord } from '../domain/thread.js'
import { testGraphConfig, testGraphPlan } from '../graph/graph-test-fixtures.test-support.js'
import { DEFAULT_KUN_CAPABILITIES_CONFIG } from '../contracts/capabilities.js'
import { ManagerSharedDataStore } from './shared-data-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function dataStore(): Promise<ManagerSharedDataStore> {
  const root = await mkdtemp(join(tmpdir(), 'kun-manager-data-'))
  roots.push(root)
  return ManagerSharedDataStore.create(join(root, 'data'))
}

describe('manager shared data store', () => {
  it('serializes canonical thread mutations without changing the existing format', async () => {
    const store = await dataStore()
    const thread = createThreadRecord({
      id: 'thread-shared',
      title: 'Shared',
      workspace: '/tmp/workspace',
      model: 'test-model'
    })
    await store.executeThread('upsert', { thread })
    expect(await store.executeThread('get', { threadId: thread.id })).toMatchObject({
      id: thread.id,
      title: 'Shared'
    })
    await store.close()
  })

  it('allocates unique monotonic event sequences across concurrent runtime clients', async () => {
    const store = await dataStore()
    const threadId = 'thread-sequences'
    const sequences = await Promise.all(Array.from({ length: 100 }, () =>
      store.executeSession('allocateEventSeq', { threadId }) as Promise<number>
    ))
    expect([...sequences].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1)
    )
    await Promise.all(sequences.map((seq) => store.executeSession('appendEvent', {
      threadId,
      event: {
        kind: 'heartbeat',
        threadId,
        seq,
        timestamp: new Date(1_800_000_000_000 + seq).toISOString()
      }
    })))
    const persisted = await store.executeSession('loadEventsSince', {
      threadId,
      sinceSeq: 0
    }) as Array<{ seq: number }>
    expect(persisted).toHaveLength(100)
    expect(new Set(persisted.map((event) => event.seq)).size).toBe(100)
    await store.close()
  })

  it('rejects an unreserved duplicate event sequence', async () => {
    const store = await dataStore()
    const event = {
      kind: 'heartbeat' as const,
      threadId: 'thread-duplicate',
      seq: 1,
      timestamp: '2026-08-01T00:00:00.000Z'
    }
    await store.executeSession('appendEvent', { threadId: event.threadId, event })
    await expect(store.executeSession('appendEvent', {
      threadId: event.threadId,
      event: { ...event, timestamp: '2026-08-01T00:00:01.000Z' }
    })).rejects.toThrow(/high-water/u)
    await store.close()
  })

  it('serializes revisioned atomic JSON writes through the manager', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-manager-json-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    const path = join(dataDir, 'extensions', 'registry.json')
    const store = await ManagerSharedDataStore.create(dataDir)
    expect(await store.readAtomicJson(path)).toEqual({ revision: 0, value: null })

    await store.writeAtomicJson({ path, expectedRevision: 0, value: { revision: 1 } })
    await expect(store.writeAtomicJson({
      path,
      expectedRevision: 0,
      value: { revision: 2 }
    })).rejects.toMatchObject({ currentRevision: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ revision: 1 })
    await store.deleteAtomicJson({ path, expectedRevision: 1 })
    expect(await store.readAtomicJson(path)).toEqual({ revision: 2, value: null })
    await store.close()
  })

  it('refuses atomic JSON access outside the canonical data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-manager-json-boundary-'))
    roots.push(root)
    const store = await ManagerSharedDataStore.create(join(root, 'data'))
    await expect(store.readAtomicJson(join(root, 'outside.json'))).rejects.toThrow(/below/u)
    await store.close()
  })

  it('owns artifact writes and deduplicates content for both runtime flavors', async () => {
    const store = await dataStore()
    const first = await store.executeArtifact('put', {
      input: { content: 'shared artifact', source: 'tool', origin: 'production' }
    }) as { meta: { id: string }; deduped: boolean }
    const second = await store.executeArtifact('put', {
      input: { content: 'shared artifact', source: 'tool', origin: 'development' }
    }) as { meta: { id: string; origins?: string[] }; deduped: boolean }

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.meta.origins).toEqual(['production', 'development'])
    expect(await store.executeArtifact('get', { id: first.meta.id })).toBe('shared artifact')
    await store.close()
  })

  it('serializes shared memory mutations through one manager-owned store', async () => {
    const store = await dataStore()
    const config = { enabled: true, scopes: ['user', 'workspace', 'project'], maxInjectedRecords: 8 }
    const created = await store.executeMemory('createWithId', {
      config,
      value: {
        id: 'mem_shared_test',
        input: {
          content: 'Use the shared data plane.',
          scope: 'workspace',
          workspace: '/tmp/shared-workspace'
        }
      }
    }) as { id: string }
    expect(created.id).toBe('mem_shared_test')

    const listed = await store.executeMemory('list', {
      config,
      value: { workspace: '/tmp/shared-workspace' }
    }) as Array<{ id: string }>
    expect(listed.map((record) => record.id)).toContain('mem_shared_test')
    await store.close()
  })

  it('owns Graph journals and snapshots for both runtime clients', async () => {
    const store = await dataStore()
    const config = testGraphConfig()
    await store.executeGraph('create', {
      config,
      value: {
        runId: 'run_manager_shared',
        threadId: 'thread_manager_shared',
        projectId: 'project_manager_shared',
        sourceTurnId: 'turn_manager_shared',
        plan: testGraphPlan(),
        commandId: 'command_manager_shared',
        idempotencyKey: 'manager-shared-create'
      }
    })
    const listed = await store.executeGraph('list', {
      config,
      value: { threadId: 'thread_manager_shared' }
    }) as Array<{ id: string }>
    expect(listed.map((run) => run.id)).toEqual(['run_manager_shared'])
    await store.close()
  })

  it('owns attachment content and scope mutations', async () => {
    const store = await dataStore()
    const config = DEFAULT_KUN_CAPABILITIES_CONFIG.attachments
    const created = await store.executeAttachment('create', {
      config,
      value: {
        name: 'shared.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('shared attachment').toString('base64'),
        documentText: 'shared attachment',
        threadId: 'thread_attachment'
      }
    }) as { id: string }
    const resolved = await store.executeAttachment('resolveContent', {
      config,
      value: { id: created.id, scope: { threadId: 'thread_attachment' } }
    }) as { dataBase64: string }
    expect(Buffer.from(resolved.dataBase64, 'base64').toString()).toBe('shared attachment')
    await store.close()
  })
})
