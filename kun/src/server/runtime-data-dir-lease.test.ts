import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireRuntimeDataDirLease,
  RUNTIME_DATA_DIR_OWNER_FILE,
  withRuntimeDataDirAncillaryWriter,
  withRuntimeDataDirConfigWriter
} from './runtime-data-dir-lease.js'
import {
  acquireRuntimeDataDirMigrationLock,
  runtimeDataDirMigrationLockPath
} from './runtime-data-dir-migration-lock.js'

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('Runtime data directory lease', () => {
  it('does not create a missing data directory when migration rejects Runtime or config writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(root)
    const dataDir = join(root, 'data')
    const migration = await acquireRuntimeDataDirMigrationLock(dataDir, {
      pid: process.pid,
      processIsAlive: (pid) => pid === process.pid
    })
    try {
      await expect(acquireRuntimeDataDirLease(dataDir, {
        pid: process.pid + 1,
        processIsAlive: (pid) => pid === process.pid
      })).rejects.toThrow(/migration is active/)
      await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(withRuntimeDataDirConfigWriter(dataDir, async () => undefined))
        .rejects.toThrow(/migration is active/)
      await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(withRuntimeDataDirAncillaryWriter(dataDir, async () => undefined))
        .rejects.toThrow(/migration is active/)
      await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await migration.release()
    }
  })

  it('does not create a missing data directory behind a legacy migration lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(root)
    const dataDir = join(root, 'data')
    await writeFile(runtimeDataDirMigrationLockPath(dataDir), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: 'legacy-migration-lock',
      startedAt: '2026-08-05T00:00:00.000Z',
      dataDir
    }))

    await expect(acquireRuntimeDataDirLease(dataDir))
      .rejects.toThrow(/migration is active/)
    await expect(withRuntimeDataDirConfigWriter(dataDir, async () => undefined))
      .rejects.toThrow(/migration is active/)
    await expect(withRuntimeDataDirAncillaryWriter(dataDir, async () => undefined))
      .rejects.toThrow(/migration is active/)
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows ancillary writes to coexist with Runtime and config owners', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(dataDir)
    let entered!: () => void
    const claimAcquired = new Promise<void>((resolve) => { entered = resolve })
    let continueAncillary!: () => void
    const mayContinue = new Promise<void>((resolve) => { continueAncillary = resolve })
    const ancillary = withRuntimeDataDirAncillaryWriter(
      dataDir,
      async () => 'ancillary-complete',
      {
        afterClaimAcquired: async () => {
          entered()
          await mayContinue
        }
      }
    )
    await claimAcquired

    const runtime = await acquireRuntimeDataDirLease(dataDir)
    await runtime.release()
    await expect(withRuntimeDataDirConfigWriter(dataDir, async () => 'config-complete'))
      .resolves.toBe('config-complete')
    continueAncillary()
    await expect(ancillary).resolves.toBe('ancillary-complete')
  })

  it('releases an ancillary claim when its write fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(dataDir)
    await expect(withRuntimeDataDirAncillaryWriter(dataDir, async () => {
      throw new Error('ancillary write failed')
    })).rejects.toThrow(/ancillary write failed/)

    const migration = await acquireRuntimeDataDirMigrationLock(dataDir)
    await migration.release()
  })

  it('holds one data directory exclusively and releases only its own record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(dataDir)
    const alive = (pid: number): boolean => pid === 101
    const first = await acquireRuntimeDataDirLease(dataDir, {
      pid: 101,
      processIsAlive: alive,
      now: () => new Date('2026-07-26T00:00:00.000Z')
    })

    await expect(acquireRuntimeDataDirLease(dataDir, {
      pid: 202,
      processIsAlive: alive
    })).rejects.toThrow(/active process 101/)
    expect(JSON.parse(await readFile(
      join(dataDir, RUNTIME_DATA_DIR_OWNER_FILE),
      'utf8'
    ))).toMatchObject({
      schemaVersion: 1,
      pid: 101,
      startedAt: '2026-07-26T00:00:00.000Z'
    })

    await first.release()
    await expect(readFile(join(dataDir, RUNTIME_DATA_DIR_OWNER_FILE), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a stale owner record without weakening exclusive creation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(dataDir)
    const stale = await acquireRuntimeDataDirLease(dataDir, {
      pid: 303,
      processIsAlive: () => false
    })
    const replacement = await acquireRuntimeDataDirLease(dataDir, {
      pid: 404,
      processIsAlive: () => false
    })

    expect(JSON.parse(await readFile(replacement.path, 'utf8')).pid).toBe(404)
    await stale.release()
    expect(JSON.parse(await readFile(replacement.path, 'utf8')).pid).toBe(404)
    await replacement.release()
  })

  it('does not delete a live owner that replaces stale bytes during reclaim', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-lease-'))
    tempRoots.push(dataDir)
    const path = join(dataDir, RUNTIME_DATA_DIR_OWNER_FILE)
    const stale = {
      schemaVersion: 1,
      pid: 501,
      token: 'stale-token',
      startedAt: '2026-08-05T00:00:00.000Z'
    }
    const replacement = { ...stale, pid: 502, token: 'live-replacement' }
    await writeFile(path, JSON.stringify(stale))
    let replaced = false

    await expect(acquireRuntimeDataDirLease(dataDir, {
      pid: 503,
      processIsAlive: (pid) => pid === replacement.pid,
      beforeStaleReclaim: async (ownerPath) => {
        if (replaced) return
        replaced = true
        await rm(ownerPath, { force: true })
        await writeFile(ownerPath, JSON.stringify(replacement))
      }
    })).rejects.toThrow(/owner changed during stale-owner recovery/)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      pid: replacement.pid,
      token: replacement.token
    })
  })
})
