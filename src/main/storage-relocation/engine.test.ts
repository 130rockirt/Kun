import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH } from '../../shared/storage-relocation'

vi.mock('./paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths')>()
  return {
    ...actual,
    validateDestinationPath: (input: { destinationRoot: string }) => input.destinationRoot
  }
})

import { StorageRelocationEngine } from './engine'

const fixedVolume = async (path: string) => ({
  root: path,
  driveType: 'Fixed' as const,
  fileSystem: 'NTFS',
  availableBytes: Number.MAX_SAFE_INTEGER
})

type Fixture = {
  homeDir: string
  userDataPath: string
  destinationD: string
  destinationE: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kun-storage-engine-'))
  const homeDir = join(root, 'home')
  const userDataPath = join(root, 'app-data')
  const destinationD = join(root, 'drive-d', 'KunData')
  const destinationE = join(root, 'drive-e', 'KunData')
  await mkdir(join(homeDir, '.kun', 'data', 'threads'), { recursive: true })
  await mkdir(join(homeDir, '.deepseekgui', 'compat'), { recursive: true })
  await mkdir(userDataPath, { recursive: true })
  await writeFile(join(homeDir, '.kun', 'data', 'threads', 'thread.json'), '{"id":"thread_1"}\n')
  await writeFile(join(homeDir, '.deepseekgui', 'compat', 'legacy.txt'), 'legacy')
  return { homeDir, userDataPath, destinationD, destinationE }
}

function engine(input: Fixture, healthCheck?: () => Promise<void>): StorageRelocationEngine {
  return new StorageRelocationEngine({
    homeDir: input.homeDir,
    userDataPath: input.userDataPath,
    installPath: join(input.homeDir, 'Kun.exe'),
    platform: 'win32',
    featureEnabled: true,
    inspectVolume: fixedVolume,
    healthCheck
  })
}

describe('storage relocation engine recovery', () => {
  let input: Fixture
  beforeEach(async () => { input = await fixture() })

  it('moves, moves again, and restores while preserving logical paths and content', async () => {
    const relocation = engine(input)
    const firstPlan = await relocation.preflightMove(input.destinationD)
    await relocation.schedule(firstPlan, false)
    await expect(relocation.runPending()).resolves.toMatchObject({ phase: 'completed' })
    expect((await lstat(join(input.homeDir, '.kun'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(input.homeDir, '.kun', 'data', 'threads', 'thread.json'), 'utf8'))
      .toContain('thread_1')
    await expect(relocation.status()).resolves.toMatchObject({ state: 'relocated' })

    const secondPlan = await relocation.preflightMove(input.destinationE)
    await relocation.schedule(secondPlan, false)
    await expect(relocation.runPending()).resolves.toMatchObject({ phase: 'completed' })
    expect(await readFile(join(input.destinationE, '.deepseekgui', 'compat', 'legacy.txt'), 'utf8'))
      .toBe('legacy')

    const restorePlan = await relocation.preflightRestoreDefault()
    await relocation.schedule(restorePlan, false)
    await expect(relocation.runPending()).resolves.toMatchObject({ phase: 'completed' })
    expect((await lstat(join(input.homeDir, '.kun'))).isDirectory()).toBe(true)
    expect((await lstat(join(input.homeDir, '.kun'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(input.homeDir, '.kun', 'data', 'threads', 'thread.json'), 'utf8'))
      .toContain('thread_1')
    await expect(relocation.status()).resolves.toMatchObject({ state: 'default' })
  })

  it('resumes a journal left in copying and completes cutover', async () => {
    const firstProcess = engine(input)
    const plan = await firstProcess.preflightMove(input.destinationD)
    const prepared = await firstProcess.schedule(plan, false)
    await mkdir(prepared.roots[0]!.stagingPath, { recursive: true })
    await firstProcess.store.writeJournal({ ...prepared, phase: 'copying' })

    const restartedProcess = engine(input)
    await expect(restartedProcess.runPending()).resolves.toMatchObject({ phase: 'completed' })
    expect(await restartedProcess.store.activeOperationId()).toBeNull()
  })

  it('rolls back a cutover when the new runtime health check fails', async () => {
    const relocation = engine(input, async () => { throw new Error('injected health failure') })
    const plan = await relocation.preflightMove(input.destinationD)
    await relocation.schedule(plan, false)
    await expect(relocation.runPending()).resolves.toMatchObject({ phase: 'failed' })
    expect((await lstat(join(input.homeDir, '.kun'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(input.homeDir, '.kun', 'data', 'threads', 'thread.json'), 'utf8'))
      .toContain('thread_1')
    expect(await relocation.store.activeOperationId()).toBeNull()
    await expect(relocation.store.latestReport()).resolves.toMatchObject({ outcome: 'rolled-back' })
  })

  it('cancels before cutover without changing the source', async () => {
    const relocation = engine(input)
    const plan = await relocation.preflightMove(input.destinationD)
    const journal = await relocation.schedule(plan, false)
    await relocation.cancel(journal.operationId)
    expect((await lstat(join(input.homeDir, '.kun'))).isSymbolicLink()).toBe(false)
    expect(await relocation.store.activeOperationId()).toBeNull()
    await expect(relocation.store.latestReport()).resolves.toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects a journal whose source path was changed after scheduling', async () => {
    const relocation = engine(input)
    const plan = await relocation.preflightMove(input.destinationD)
    const prepared = await relocation.schedule(plan, false)
    const outside = join(input.homeDir, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await relocation.store.writeJournal({
      ...prepared,
      roots: prepared.roots.map((root, index) => index === 0
        ? { ...root, sourcePhysicalPath: outside }
        : root)
    })
    await expect(engine(input).runPending()).rejects.toThrow(/journal source path is not trusted/)
    await expect(readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('rejects removable media and conflicting target data during preflight', async () => {
    const removable = new StorageRelocationEngine({
      homeDir: input.homeDir,
      userDataPath: input.userDataPath,
      installPath: join(input.homeDir, 'Kun.exe'),
      platform: 'win32',
      featureEnabled: true,
      inspectVolume: async (path) => ({
        root: path,
        driveType: 'Removable',
        fileSystem: 'NTFS',
        availableBytes: Number.MAX_SAFE_INTEGER
      })
    })
    await expect(removable.preflightMove(input.destinationD)).rejects.toThrow(/local fixed NTFS/)
    await mkdir(input.destinationD, { recursive: true })
    await writeFile(join(input.destinationD, 'conflict.txt'), 'do not replace')
    await expect(engine(input).preflightMove(input.destinationD)).rejects.toThrow(/empty folder/)
  })

  it('truncates a persisted failure message before publishing recovery progress', async () => {
    const relocation = engine(input)
    const plan = await relocation.preflightMove(input.destinationD)
    const prepared = await relocation.schedule(plan, false)
    const longMessage = 'x'.repeat(STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH + 1)
    await relocation.store.writeJournal({
      ...prepared,
      phase: 'failed',
      error: { code: 'copy_failed', message: longMessage, nextActions: [] }
    })

    const recovered = await engine(input).status()
    const expectedMessage = `${longMessage.slice(0, STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH - 3)}...`
    expect(recovered).toMatchObject({
      state: 'pending',
      pending: { phase: 'failed', message: expectedMessage }
    })
    expect(recovered.pending?.message).toHaveLength(STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH)
  })
})
