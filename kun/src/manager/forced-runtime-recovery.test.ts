import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forcedRuntimeRecoveryPath,
  readForcedRuntimeRecovery,
  recordVerifiedForcedRuntimeOwner,
  removeForcedRuntimeRecovery
} from './forced-runtime-recovery.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kun-forced-runtime-recovery-'))
  roots.push(root)
  return { controlDir: root, dataDir: join(root, 'data') }
}

describe('forced Runtime recovery marker', () => {
  it('merges exact owners without persisting control tokens or commands', async () => {
    const test = await fixture()
    const first = await recordVerifiedForcedRuntimeOwner({
      ...test,
      owner: {
        flavor: 'production',
        instanceId: 'production-old',
        pid: 4101,
        startedAt: '2026-08-21T00:00:00.000Z'
      },
      now: new Date('2026-08-21T00:02:00.000Z')
    })
    const second = await recordVerifiedForcedRuntimeOwner({
      ...test,
      owner: {
        flavor: 'development',
        instanceId: 'development-old',
        pid: 4102,
        startedAt: '2026-08-21T00:00:01.000Z'
      },
      now: new Date('2026-08-21T00:03:00.000Z')
    })

    expect(second.markerId).toBe(first.markerId)
    expect(second.owners.map((owner) => owner.flavor)).toEqual([
      'production',
      'development'
    ])
    const serialized = await readFile(forcedRuntimeRecoveryPath(test.controlDir), 'utf8')
    expect(serialized).not.toMatch(/token|command|settings/iu)
    if (process.platform !== 'win32') {
      expect((await stat(forcedRuntimeRecoveryPath(test.controlDir))).mode & 0o777).toBe(0o600)
    }
    expect(await removeForcedRuntimeRecovery(test.controlDir, second.markerId)).toBe(true)
    expect(await readForcedRuntimeRecovery(test.controlDir)).toBeNull()
  })

  it('rejects malformed, oversized, and cross-data-directory markers', async () => {
    const test = await fixture()
    const path = forcedRuntimeRecoveryPath(test.controlDir)
    await writeFile(path, '{broken', 'utf8')
    await expect(readForcedRuntimeRecovery(test.controlDir)).rejects.toThrow()
    await writeFile(path, 'x'.repeat(64 * 1024 + 1), 'utf8')
    await expect(readForcedRuntimeRecovery(test.controlDir)).rejects.toThrow(/oversized/u)
    await rm(path, { force: true })
    await recordVerifiedForcedRuntimeOwner({
      ...test,
      owner: {
        flavor: 'production',
        instanceId: 'production-old',
        pid: 4101,
        startedAt: '2026-08-21T00:00:00.000Z'
      }
    })
    await expect(readForcedRuntimeRecovery(test.controlDir, join(test.controlDir, 'other-data')))
      .rejects.toThrow(/different data directory/u)
  })
})
