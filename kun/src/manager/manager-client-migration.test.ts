import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRuntimeDiscoveryRecord } from '../server/runtime-discovery.js'
import { acquireRuntimeDataDirMigrationLock } from '../server/runtime-data-dir-migration-lock.js'
import { ensureServiceManager } from './manager-client.js'

describe('Service Manager legacy Runtime handover migration fence', () => {
  it('preserves production discovery during migration and removes it after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-manager-handover-migration-'))
    const dataDir = join(root, 'data')
    const controlDir = join(root, 'control')
    const discovery = createRuntimeDiscoveryRecord({
      instanceId: 'legacy-runtime',
      pid: 2_147_483_647,
      startedAt: '2026-08-05T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'legacy-token',
      insecure: false,
      flavor: 'production',
      buildId: 'a'.repeat(64),
      launchMode: 'shared'
    })
    const discoveryPath = join(dataDir, 'runtime.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch
    const input = {
      flavor: 'production' as const,
      dataDir,
      controlDir,
      settingsPath: join(root, 'kun-settings.json'),
      fetch: fetchImpl,
      timeoutMs: 10,
      launch: {
        command: process.execPath,
        args: ['-e', 'process.exit(99)'],
        runAsNode: false
      }
    }
    const migration = await acquireRuntimeDataDirMigrationLock(dataDir)
    try {
      await expect(ensureServiceManager(input)).rejects.toThrow(/migration is active/)
      expect(JSON.parse(await readFile(discoveryPath, 'utf8'))).toMatchObject({
        instanceId: discovery.instanceId,
        pid: discovery.pid
      })
    } finally {
      await migration.release()
    }

    try {
      await expect(ensureServiceManager(input)).rejects.toThrow(/did not become ready/)
      await expect(readFile(discoveryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
