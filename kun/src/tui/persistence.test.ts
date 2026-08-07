import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emptyTuiPersistentState,
  modelStateKey,
  readTuiPersistentState,
  tuiStatePath,
  writeTuiPersistentState
} from './persistence.js'
import { acquireRuntimeDataDirMigrationLock } from '../server/runtime-data-dir-migration-lock.js'

describe('TUI persistent state', () => {
  it('does not recreate a missing migration target while state persistence is fenced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-state-migration-'))
    const dataDir = join(root, 'missing', 'data')
    const migration = await acquireRuntimeDataDirMigrationLock(dataDir)
    try {
      await expect(writeTuiPersistentState(dataDir, emptyTuiPersistentState()))
        .rejects.toThrow(/migration is active/)
      await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await migration.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically stores recents, favorites, and per-model effort without credentials', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-state-'))
    const key = modelStateKey('provider-a', 'account-a', 'model-a')
    try {
      await writeTuiPersistentState(dataDir, {
        ...emptyTuiPersistentState(),
        recentModels: [{ providerId: 'provider-a', accountId: 'account-a', model: 'model-a' }],
        favoriteModels: [key],
        reasoningByModel: { [key]: 'high' }
      })
      await expect(readTuiPersistentState(dataDir)).resolves.toMatchObject({
        recentModels: [{ model: 'model-a' }],
        favoriteModels: [key],
        reasoningByModel: { [key]: 'high' }
      })
      if (process.platform !== 'win32') {
        expect((await stat(tuiStatePath(dataDir))).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('falls back safely when an old or invalid state file cannot be parsed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-tui-state-empty-'))
    try {
      await expect(readTuiPersistentState(dataDir)).resolves.toEqual(emptyTuiPersistentState())
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
