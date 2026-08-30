import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceManagerStateSnapshotSchema } from './service-manager-state-snapshot.js'
import {
  readPersistedManagerState,
  writePersistedManagerState
} from './service-manager-state-persistence.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kun-manager-state-persistence-'))
  roots.push(root)
  return { root, path: join(root, 'manager-state.json') }
}

describe('Service Manager state persistence', () => {
  it('returns a fresh state when the file does not exist', async () => {
    const test = await fixture()

    const state = await readPersistedManagerState(test.path)

    expect(state.durableSnapshot()).toMatchObject({ version: 5, slots: [], leases: [] })
    expect(await readdir(test.root)).toEqual([])
  })

  it('restores a valid legacy snapshot without rewriting or backing it up', async () => {
    const test = await fixture()
    const serialized = JSON.stringify({
      version: 1,
      slots: [],
      leases: [],
      resourceLeases: []
    })
    await writeFile(test.path, serialized)

    const state = await readPersistedManagerState(test.path)

    expect(state.durableSnapshot()).toMatchObject({ version: 5, slots: [], leases: [] })
    expect(await readFile(test.path, 'utf8')).toBe(serialized)
    expect((await readdir(test.root)).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })

  it.each([
    ['NUL bytes', '\0'.repeat(1_692), 'invalid JSON'],
    ['truncated JSON', '{"version":', 'invalid JSON'],
    ['empty object', '{}', 'invalid state schema'],
    ['unknown version', '{"version":99}', 'invalid state schema']
  ])('backs up and replaces %s', async (_label, serialized, reason) => {
    const test = await fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFile(test.path, serialized)

    const state = await readPersistedManagerState(test.path)

    expect(state.durableSnapshot()).toMatchObject({ version: 5, slots: [], leases: [] })
    const entries = await readdir(test.root)
    const backups = entries.filter((name) => name.startsWith('manager-state.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(test.root, backups[0]!), 'utf8')).toBe(serialized)
    expect(ServiceManagerStateSnapshotSchema.parse(
      JSON.parse(await readFile(test.path, 'utf8')) as unknown
    )).toMatchObject({ version: 5, slots: [], leases: [] })
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
    if (process.platform !== 'win32') {
      expect((await stat(join(test.root, backups[0]!))).mode & 0o777).toBe(0o600)
      expect((await stat(test.path)).mode & 0o777).toBe(0o600)
    }
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(backups[0]!))
  })

  it('writes a durable current snapshot without direct-write fallback artifacts', async () => {
    const test = await fixture()
    const state = await readPersistedManagerState(test.path)

    await writePersistedManagerState(test.path, state.durableSnapshot())

    expect(ServiceManagerStateSnapshotSchema.parse(
      JSON.parse(await readFile(test.path, 'utf8')) as unknown
    )).toMatchObject({ version: 5 })
    expect((await readdir(test.root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not treat a filesystem read error as corrupt state', async () => {
    const test = await fixture()
    await mkdir(test.path)

    await expect(readPersistedManagerState(test.path)).rejects.toMatchObject({ code: 'EISDIR' })
    expect((await readdir(test.root)).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })
})
