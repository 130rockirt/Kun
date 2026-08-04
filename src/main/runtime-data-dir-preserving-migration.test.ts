import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  chmod,
  utimes,
  writeFile
} from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markCanonicalKunRuntimeMigrationRuntimeVerified,
  runCanonicalKunRuntimeDataMigration as runCanonicalKunRuntimeDataMigrationImpl
} from './runtime-data-dir-migration'

const tempRoots: string[] = []
const TEST_TIMESTAMP = '2026-07-26T00:00:00.000Z'
const TEST_AVAILABLE_COPY_BYTES = 100 * 1024 * 1024 * 1024

function runCanonicalKunRuntimeDataMigration(
  input: Parameters<typeof runCanonicalKunRuntimeDataMigrationImpl>[0]
): ReturnType<typeof runCanonicalKunRuntimeDataMigrationImpl> {
  return runCanonicalKunRuntimeDataMigrationImpl({
    availableCopyBytes: () => TEST_AVAILABLE_COPY_BYTES,
    ...input
  })
}

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
  it('performs an empty cutover without creating a legacy compatibility link', async () => {
    const test = await fixture()

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    await expect(lstat(test.legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).provenance)
      .toBe('no-legacy-source')
  })

  it('adopts the only existing current store without creating a legacy link', async () => {
    const test = await fixture()
    await writeThread(test.current, 'thr_current', 'current')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    await expect(lstat(test.legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(
      join(test.current, 'threads', 'thr_current', 'metadata.jsonl'),
      'utf8'
    )).toContain('current')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
  })

  it('recovers preserved history when settings select a missing current store', async () => {
    const test = await fixture('~/.kun/data')
    await writeThread(test.legacy, 'thr_history', 'preserved history')
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
    expect(result.authority).toBe('current')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.legacy)).isSymbolicLink()).toBe(false)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toBe(sourceBytes)
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
  })

  it('reconstructs an independent legacy directory from an unjournaled compatibility link', async () => {
    const test = await fixture('~/.kun/data')
    await writeThread(test.current, 'thr_history', 'linked history')
    await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
    await symlink(test.current, test.legacy)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.legacy)).isSymbolicLink()).toBe(false)
    expect(await realpath(test.legacy)).not.toBe(await realpath(test.current))
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toContain('linked history')
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toContain('linked history')
  })

  it('adds missing preserved history without overwriting the explicitly selected current store', async () => {
    const test = await fixture('~/.kun/data')
    await writeThread(test.legacy, 'thr_preserved_only', 'preserved')
    await writeThread(test.current, 'thr_current_only', 'current')
    const legacyBytes = await readFile(
      join(test.legacy, 'threads', 'thr_preserved_only', 'metadata.jsonl'),
      'utf8'
    )
    const currentBytes = await readFile(
      join(test.current, 'threads', 'thr_current_only', 'metadata.jsonl'),
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await readdir(join(test.legacy, 'threads')))).toEqual(['thr_preserved_only'])
    expect((await readdir(join(test.current, 'threads'))).sort()).toEqual([
      'thr_current_only',
      'thr_preserved_only'
    ])
    expect(await readFile(
      join(test.legacy, 'threads', 'thr_preserved_only', 'metadata.jsonl'),
      'utf8'
    )).toBe(legacyBytes)
    expect(await readFile(
      join(test.current, 'threads', 'thr_current_only', 'metadata.jsonl'),
      'utf8'
    )).toBe(currentBytes)
  })

  it.each([
    'prepared',
    'settings-backed-up',
    'destination-salvaged'
  ] as const)(
    'resumes an interrupted additive history merge after phase %s',
    async (interruptedPhase) => {
      const test = await fixture('~/.kun/data')
      await writeThread(test.legacy, 'thr_preserved_only', 'preserved')
      await writeThread(test.current, 'thr_current_only', 'current')
      const sourceBytes = await readFile(
        join(test.legacy, 'threads', 'thr_preserved_only', 'metadata.jsonl'),
        'utf8'
      )

      const interrupted = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined,
        afterPreservationPhase: (phase) => {
          if (phase === interruptedPhase) throw new Error(`interrupt after ${phase}`)
        }
      })
      expect(interrupted.status).toBe('blocked')
      expect(await readFile(
        join(test.legacy, 'threads', 'thr_preserved_only', 'metadata.jsonl'),
        'utf8'
      )).toBe(sourceBytes)

      const resumed = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined
      })
      expect(resumed.status).toBe('completed')
      expect((await readdir(join(test.current, 'threads'))).sort()).toEqual([
        'thr_current_only',
        'thr_preserved_only'
      ])
      expect(await readFile(
        join(test.legacy, 'threads', 'thr_preserved_only', 'metadata.jsonl'),
        'utf8'
      )).toBe(sourceBytes)
    }
  )

  it('stops an interrupted migration when the user selects a custom Runtime store', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const customDataDir = join(test.root, 'custom-runtime')

    const interrupted = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (phase !== 'prepared') return
        writeFileSync(
          test.settingsPath,
          JSON.stringify({
            version: 1,
            agents: { kun: { dataDir: customDataDir } }
          }),
          'utf8'
        )
      }
    })

    expect(interrupted.status).toBe('blocked')
    expect(interrupted.message).toContain('active settings source changed')
    expect(await readSettingsDataDir(test.settingsPath)).toBe(customDataDir)
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

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

  it('copies immutable package directories before restoring their read-only mode', async () => {
    const test = await fixture()
    const sourcePackage = join(test.legacy, 'extensions', 'acme.demo', '1.0.0')
    const targetPackage = join(test.current, 'extensions', 'acme.demo', '1.0.0')
    await mkdir(sourcePackage, { recursive: true })
    const sourceLicense = join(sourcePackage, 'LICENSE')
    const targetLicense = join(targetPackage, 'LICENSE')
    await writeFile(sourceLicense, 'immutable package', 'utf8')
    await chmod(sourceLicense, 0o444)
    await chmod(sourcePackage, 0o555)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(targetLicense, 'utf8')).toBe('immutable package')
    if (process.platform !== 'win32') {
      expect((await stat(sourcePackage)).mode & 0o777).toBe(0o555)
      expect((await stat(targetPackage)).mode & 0o777).toBe(0o555)
      expect((await stat(sourceLicense)).mode & 0o777).toBe(0o444)
      expect((await stat(targetLicense)).mode & 0o777).toBe(0o444)
    }
    await chmod(sourcePackage, 0o755)
    await chmod(targetPackage, 0o755)
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

  it('rejects a corrupted verified candidate before activation', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    await writeFile(join(test.legacy, 'config.json'), '{"valid":true}', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (phase !== 'candidate-rebased') return
        const journal = JSON.parse(readFileSync(
          join(test.userData, 'kun-runtime-data-migration-v3.json'),
          'utf8'
        ))
        writeFileSync(join(journal.stagingPath, 'config.json'), '{', 'utf8')
      }
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('candidate config is not valid JSON')
    expect(await readFile(join(test.legacy, 'config.json'), 'utf8')).toBe('{"valid":true}')
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

  it('keeps at least five GiB free after creating the independent history copy', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const oneGiB = 1024 * 1024 * 1024

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      availableCopyBytes: () => oneGiB * 5
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('safety reserve')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.deepseekgui/kun')
  })

  it('budgets space for displaced destination history before copying either store', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    await writeThread(test.current, 'thr_displaced', 'displaced')
    await mkdir(join(test.current, 'attachments'), { recursive: true })
    await writeFile(
      join(test.current, 'attachments', 'large.bin'),
      Buffer.alloc(2 * 1024 * 1024)
    )
    const oneGiB = 1024 * 1024 * 1024

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      availableCopyBytes: () => oneGiB * 5 + 1024 * 1024
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain('authoritative and displaced history')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
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
      [],
      () => new Date('2026-07-26T01:00:00.000Z')
    )).toMatchObject({
      status: 'incomplete',
      missingThreadIds: ['thr_history']
    })
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBeUndefined()

    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      ['thr_history'],
      () => new Date('2026-07-26T01:00:00.000Z')
    )).toMatchObject({
      status: 'verified',
      expectedThreadCount: 1,
      visibleThreadCount: 1
    })
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      ['thr_history']
    ).status).toBe('not-needed')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T01:00:00.000Z')
  })

  it('revokes stale verification evidence when migrated history disappears from the API', async () => {
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
      ['thr_history']
    ).status).toBe('verified')

    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      []
    )).toMatchObject({
      status: 'incomplete',
      missingThreadIds: ['thr_history']
    })
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBeUndefined()
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

  it('replaces an incomplete pre-cutover version-2 migration with a preserving copy', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    const v2Journal = completedV2Journal(test.legacy, test.current, ['thr_history'])
    v2Journal.phase = 'prepared'
    await writeFile(
      join(test.userData, 'kun-runtime-data-migration-v2.json'),
      `${JSON.stringify(v2Journal, null, 2)}\n`,
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'metadata.jsonl'),
      'utf8'
    )).toContain('history')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).provenance)
      .toBe('original-legacy-source')
  })

  it('reconstructs history after version-2 already promoted the source but created no link', async () => {
    const test = await fixture()
    await writeThread(test.current, 'thr_history', 'history')
    const v2Journal = completedV2Journal(test.legacy, test.current, ['thr_history'])
    v2Journal.phase = 'source-promoted'
    await writeFile(
      join(test.userData, 'kun-runtime-data-migration-v2.json'),
      `${JSON.stringify(v2Journal, null, 2)}\n`,
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
    expect(journal.compatibilityLinkBackupPath).toBeUndefined()
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

  it('does not reconstruct version-2 history after the user selects a custom store', async () => {
    const test = await fixture()
    const customDataDir = join(test.root, 'custom-runtime')
    await writeFile(
      test.settingsPath,
      JSON.stringify({ version: 1, agents: { kun: { dataDir: customDataDir } } }),
      'utf8'
    )
    await mkdir(customDataDir, { recursive: true })
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

    expect(result.status).toBe('not-needed')
    expect(result.authority).toBe('custom')
    expect((await lstat(test.legacy)).isSymbolicLink()).toBe(true)
    await expect(lstat(join(test.userData, 'kun-runtime-data-migration-v3.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

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
