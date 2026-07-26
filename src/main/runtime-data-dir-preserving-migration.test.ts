import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  chmod,
  utimes,
  writeFile
} from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markCanonicalKunRuntimeMigrationRuntimeVerified,
  runCanonicalKunRuntimeDataMigration
} from './runtime-data-dir-migration'

const tempRoots: string[] = []
const TEST_TIMESTAMP = '2026-07-26T00:00:00.000Z'

async function fixture(dataDir = '~/.deepseekgui/kun') {
  const root = await mkdtemp(join(tmpdir(), 'kun-runtime-preservation-'))
  tempRoots.push(root)
  const home = join(root, 'home')
  const userData = join(root, 'appData', 'Kun')
  const legacy = join(home, '.deepseekgui', 'kun')
  const current = join(home, '.kun', 'data')
  const settingsPath = join(userData, 'kun-settings.json')
  await mkdir(userData, { recursive: true })
  await writeFile(
    settingsPath,
    JSON.stringify({ version: 1, agents: { kun: { dataDir } } }),
    'utf8'
  )
  return { root, home, userData, legacy, current, settingsPath }
}

async function writeThread(dataDir: string, id: string, title: string): Promise<void> {
  const threadDir = join(dataDir, 'threads', id)
  await mkdir(threadDir, { recursive: true })
  await writeFile(
    join(threadDir, 'metadata.jsonl'),
    `${JSON.stringify({ kind: 'thread_metadata', thread: { id, title } })}\n`,
    'utf8'
  )
  await writeFile(join(threadDir, 'messages.jsonl'), '', 'utf8')
}

async function readSettingsDataDir(path: string): Promise<string> {
  return JSON.parse(await readFile(path, 'utf8')).agents.kun.dataDir
}

function extensionManifest() {
  return {
    publisher: 'acme',
    name: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    manifestVersion: 1,
    apiVersion: '1.0.0',
    engines: { kun: '*' },
    main: 'dist/main.mjs',
    activationEvents: ['onStartup'],
    contributes: {},
    permissions: [],
    stateSchemaVersion: 0
  }
}

async function writeLegacyExtensionRegistry(dataDir: string): Promise<string> {
  const packagePath = join(dataDir, 'extensions', 'acme.demo', '1.0.0')
  const document = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: TEST_TIMESTAMP,
    extensions: {
      'acme.demo': {
        id: 'acme.demo',
        selectedVersion: '1.0.0',
        globallyEnabled: false,
        workspaceEnablement: {},
        workspacePermissionGrants: {},
        versions: {
          '1.0.0': {
            version: '1.0.0',
            packagePath,
            archiveSha256: 'a'.repeat(64),
            integrity: { algorithm: 'sha256', files: {} },
            source: { type: 'local', locator: 'fixture.kunx' },
            signatureStatus: 'unsigned',
            requestedPermissions: [],
            grantedPermissions: [],
            installedAt: TEST_TIMESTAMP,
            manifest: extensionManifest(),
            mutable: false
          }
        },
        useDevelopment: false
      }
    }
  }
  await mkdir(packagePath, { recursive: true })
  const raw = `${JSON.stringify(document, null, 2)}\n`
  await writeFile(join(dataDir, 'extensions', 'registry.json'), raw, 'utf8')
  return raw
}

function completedV2Journal(sourcePath: string, targetPath: string, threadIds: string[]) {
  return {
    schemaVersion: 2,
    phase: 'completed',
    sourcePath,
    targetPath,
    cutoverConflictBackupPaths: [],
    settingsBackupPaths: [],
    settingsBackedUp: true,
    extensionRegistryBackupPaths: [],
    sourceThreadIds: threadIds,
    sourceInventory: { files: 1, directories: 2, symlinks: 0, bytes: 1 },
    targetInventory: { files: 1, directories: 2, symlinks: 0, bytes: 1 },
    sqliteQuickCheck: 'missing',
    salvaged: 0,
    conflicts: [],
    startedAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    completedAt: TEST_TIMESTAMP
  }
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('history-preserving Kun Runtime migration', () => {
  it('keeps the legacy store real and byte-independent after migration', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'immutable history')
    await writeFile(join(test.legacy, 'config.json'), '{"source":"legacy"}', 'utf8')
    const sourceBytes = await readFile(
      join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.journalPath).toContain('migration-v3.json')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.legacy)).isSymbolicLink()).toBe(false)
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)

    await writeFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'new-side-only\n',
      'utf8'
    )
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)
  })

  it('preserves regular-file mode and timestamps in the verified candidate', async () => {
    const test = await fixture()
    const sourceFile = join(test.legacy, 'history.bin')
    await mkdir(test.legacy, { recursive: true })
    await writeFile(sourceFile, 'history-bytes', 'utf8')
    await chmod(sourceFile, 0o640)
    const timestamp = new Date('2025-01-02T03:04:05.000Z')
    await utimes(sourceFile, timestamp, timestamp)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    const sourceMetadata = await stat(sourceFile)
    const targetMetadata = await stat(join(test.current, 'history.bin'))
    expect(targetMetadata.mode & 0o777).toBe(sourceMetadata.mode & 0o777)
    expect(Math.trunc(targetMetadata.mtimeMs)).toBe(Math.trunc(sourceMetadata.mtimeMs))
  })

  it('rebases only the candidate extension registry', async () => {
    const test = await fixture()
    const sourceRaw = await writeLegacyExtensionRegistry(test.legacy)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(join(test.legacy, 'extensions', 'registry.json'), 'utf8'))
      .toBe(sourceRaw)
    const current = JSON.parse(
      await readFile(join(test.current, 'extensions', 'registry.json'), 'utf8')
    )
    expect(current.extensions['acme.demo'].versions['1.0.0'].packagePath)
      .toBe(join(test.current, 'extensions', 'acme.demo', '1.0.0'))
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.extensionRegistryRebasedRecords).toBe(1)
  })

  it('rejects an unexpected candidate extension path without changing the source', async () => {
    const test = await fixture()
    const sourceRaw = await writeLegacyExtensionRegistry(test.legacy)
    const registryPath = join(test.legacy, 'extensions', 'registry.json')
    const unexpected = JSON.parse(sourceRaw)
    unexpected.extensions['acme.demo'].versions['1.0.0'].packagePath =
      join(test.root, 'unrelated', 'acme.demo', '1.0.0')
    const unexpectedRaw = `${JSON.stringify(unexpected, null, 2)}\n`
    await writeFile(registryPath, unexpectedRaw, 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('packagePath is outside the canonical migration roots')
    expect(await readFile(registryPath, 'utf8')).toBe(unexpectedRaw)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a populated destination and salvages non-conflicting history', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')
    const sourceBytes = await readFile(
      join(test.legacy, 'threads', 'thr_legacy', 'metadata.jsonl'),
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.destinationBackupPath).toBeTruthy()
    expect(await readFile(
      join(result.destinationBackupPath!, 'threads', 'thr_current', 'metadata.jsonl'),
      'utf8'
    )).toContain('current')
    expect((await readdir(join(test.current, 'threads'))).sort())
      .toEqual(['thr_current', 'thr_legacy'])
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_legacy', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)
  })

  it.each([
    'prepared',
    'settings-backed-up',
    'candidate-copied',
    'candidate-verified',
    'candidate-rebased',
    'destination-backed-up',
    'destination-salvaged',
    'target-activated',
    'settings-rewritten'
  ] as const)('resumes after interruption in preservation phase %s', async (phase) => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (currentPhase) => {
        if (!interrupted && currentPhase === phase) {
          interrupted = true
          throw new Error(`interrupted after ${phase}`)
        }
      }
    })
    expect(first.status).toBe('blocked')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(resumed.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toContain('history')
  })

  it('blocks activation when the legacy source changes during migration', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (phase === 'candidate-rebased') {
          writeFileSync(
            join(test.legacy, 'threads', 'thr_history', 'messages.jsonl'),
            'changed-during-copy\n',
            'utf8'
          )
        }
      }
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('source changed before candidate activation')
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.deepseekgui/kun')
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'messages.jsonl'),
      'utf8'
    )).toBe('changed-during-copy\n')
  })

  it('blocks before copying when fallback capacity is insufficient', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      availableCopyBytes: () => 0
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('insufficient capacity')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.deepseekgui/kun')
  })

  it('rejects an unsafe preservation staging path before mutation', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (phase === 'prepared') throw new Error('pause after planning')
      }
    })
    expect(first.status).toBe('blocked')
    const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    journal.stagingPath = join(test.root, 'unrelated-staging')
    await writeFile(first.journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('blocked')
    expect(resumed.message).toContain('unsafe staging path')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not quarantine a real legacy store on repeated startup', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(first.status).toBe('completed')

    const repeated = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(repeated.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await readdir(join(test.home, '.deepseekgui')))).toEqual(['kun'])
  })

  it('records Runtime verification in the version-3 journal', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(result.status).toBe('completed')
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      () => new Date('2026-07-26T01:00:00.000Z')
    )).toBe(true)
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(test.userData)).toBe(false)
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T01:00:00.000Z')
  })

  it('reconstructs an explicitly labeled independent snapshot for a version-2 profile', async () => {
    const test = await fixture('~/.kun/data')
    await writeThread(test.current, 'thr_history', 'history')
    await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
    await symlink(test.current, test.legacy)
    await writeFile(
      join(test.userData, 'kun-runtime-data-migration-v2.json'),
      `${JSON.stringify(completedV2Journal(
        test.legacy,
        test.current,
        ['thr_history']
      ), null, 2)}\n`,
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.provenance).toBe('reconstructed-from-current')
    expect((await lstat(journal.compatibilityLinkBackupPath)).isSymbolicLink()).toBe(true)
    const report = JSON.parse(await readFile(
      join(test.userData, 'kun-runtime-data-migration-v3-report.json'),
      'utf8'
    ))
    expect(report.exactPreMigrationSnapshot).toBe(false)
    expect(report.warning).toContain('reconstructed from the current store')

    await writeFile(
      join(test.current, 'threads', 'thr_history', 'messages.jsonl'),
      'new current write\n',
      'utf8'
    )
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'messages.jsonl'),
      'utf8'
    )).toBe('')
  })

  it.each([
    'prepared',
    'settings-backed-up',
    'candidate-copied',
    'candidate-verified',
    'legacy-link-backed-up'
  ] as const)(
    'resumes version-2 reconstruction after interruption in phase %s',
    async (phase) => {
      const test = await fixture('~/.kun/data')
      await writeThread(test.current, 'thr_history', 'history')
      await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
      await symlink(test.current, test.legacy)
      await writeFile(
        join(test.userData, 'kun-runtime-data-migration-v2.json'),
        `${JSON.stringify(completedV2Journal(
          test.legacy,
          test.current,
          ['thr_history']
        ), null, 2)}\n`,
        'utf8'
      )
      let interrupted = false
      const first = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined,
        afterPreservationPhase: (currentPhase) => {
          if (!interrupted && currentPhase === phase) {
            interrupted = true
            throw new Error(`interrupted after ${phase}`)
          }
        }
      })
      expect(first.status).toBe('blocked')
      expect((await lstat(test.current)).isDirectory()).toBe(true)

      const resumed = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined
      })
      expect(resumed.status).toBe('completed')
      expect((await lstat(test.legacy)).isDirectory()).toBe(true)
      expect(await readFile(
        join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
        'utf8'
      )).toContain('history')
    }
  )

  it('blocks an affected version-2 profile when recorded history is missing', async () => {
    const test = await fixture('~/.kun/data')
    await mkdir(test.current, { recursive: true })
    await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
    await symlink(test.current, test.legacy)
    await writeFile(
      join(test.userData, 'kun-runtime-data-migration-v2.json'),
      `${JSON.stringify(completedV2Journal(
        test.legacy,
        test.current,
        ['thr_missing']
      ), null, 2)}\n`,
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('missing 1 threads recorded before the rename migration')
    expect((await lstat(test.legacy)).isSymbolicLink()).toBe(true)
  })
})
