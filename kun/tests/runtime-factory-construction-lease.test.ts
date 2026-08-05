import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/adapters/in-memory-event-bus.js', () => ({
  InMemoryEventBus: class {
    constructor() {
      throw new Error('injected Runtime composition failure')
    }
  }
}))

import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import {
  acquireRuntimeDataDirMigrationLock,
  runtimeDataDirOwnerPath
} from '../src/server/runtime-data-dir-migration-lock.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Runtime composition writer lease construction failure', () => {
  it('releases its writer fence when composition throws after acquisition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-construction-lease-'))
    roots.push(root)
    const dataDir = join(root, 'data')

    await expect(createKunServeRuntime({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      runtimeToken: 'token',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:9',
      model: 'test-model',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      tokenEconomyMode: false,
      insecure: false,
      storage: { backend: 'file' }
    })).rejects.toThrow('injected Runtime composition failure')

    await expect(readFile(runtimeDataDirOwnerPath(dataDir), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const migration = await acquireRuntimeDataDirMigrationLock(dataDir)
    await migration.release()
  })
})
