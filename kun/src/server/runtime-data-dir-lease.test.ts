import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireRuntimeDataDirLease,
  RUNTIME_DATA_DIR_OWNER_FILE
} from './runtime-data-dir-lease.js'

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('Runtime data directory lease', () => {
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
})
