import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  chmod,
  utimes,
  writeFile
} from 'node:fs/promises'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalKunRuntimeMigrationRequiresExclusiveAccess,
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

  it('rebuilds a stale original-source candidate on the next startup', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    await writeFile(join(test.legacy, 'stale-only.txt'), 'stale\n', 'utf8')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (phase !== 'candidate-copied') return
        writeFileSync(
          join(test.legacy, 'threads', 'thr_history', 'messages.jsonl'),
          'latest source write\n',
          'utf8'
        )
        rmSync(join(test.legacy, 'stale-only.txt'))
      }
    })
    expect(first.status).toBe('blocked')
    const interrupted = JSON.parse(await readFile(first.journalPath, 'utf8'))
    const staleStagingPath = interrupted.stagingPath as string

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('completed')
    const completed = JSON.parse(await readFile(resumed.journalPath, 'utf8'))
    expect(completed.stagingPath).not.toBe(staleStagingPath)
    expect((await lstat(staleStagingPath)).isDirectory()).toBe(true)
    expect(await readFile(
      join(test.current, 'threads', 'thr_history', 'messages.jsonl'),
      'utf8'
    )).toBe('latest source write\n')
    await expect(lstat(join(test.current, 'stale-only.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'candidate-verified',
    'candidate-rebased',
    'destination-backed-up',
    'destination-salvaged'
  ] as const)(
    'rebuilds from the latest trusted source after interruption in phase %s',
    async (phase) => {
      const test = await fixture()
      await writeThread(test.legacy, 'thr_history', 'history')
      await writeThread(test.current, 'thr_current', 'current')
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
      const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
      const staleStagingPath = interruptedJournal.stagingPath as string
      const destinationBackupPath = interruptedJournal.destinationBackupPath as string
      await writeThread(test.legacy, 'thr_late', `late after ${phase}`)

      const resumed = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined
      })

      expect(resumed.status).toBe('completed')
      const completedJournal = JSON.parse(await readFile(resumed.journalPath, 'utf8'))
      expect(completedJournal.stagingPath).not.toBe(staleStagingPath)
      expect(completedJournal.destinationBackupPath).toBe(destinationBackupPath)
      expect((await lstat(staleStagingPath)).isDirectory()).toBe(true)
      expect((await lstat(destinationBackupPath)).isDirectory()).toBe(true)
      expect(await readFile(
        join(destinationBackupPath, 'threads', 'thr_current', 'metadata.jsonl'),
        'utf8'
      )).toContain('current')
      expect((await readdir(join(test.current, 'threads'))).sort())
        .toEqual(['thr_current', 'thr_history', 'thr_late'])
    }
  )

  it('keeps displaced history and the stale candidate when recorded source history disappears', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    await writeThread(test.current, 'thr_current', 'current')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (!interrupted && phase === 'destination-salvaged') {
          interrupted = true
          throw new Error('interrupted after destination salvage')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    const staleStagingPath = interruptedJournal.stagingPath as string
    const destinationBackupPath = interruptedJournal.destinationBackupPath as string
    await rm(join(test.legacy, 'threads', 'thr_history'), {
      recursive: true,
      force: true
    })

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('blocked')
    expect(resumed.message).toContain('missing 1 thread directories recorded before migration')
    const blockedJournal = JSON.parse(await readFile(resumed.journalPath, 'utf8'))
    expect(blockedJournal.stagingPath).toBe(staleStagingPath)
    expect(blockedJournal.destinationBackupPath).toBe(destinationBackupPath)
    expect((await lstat(staleStagingPath)).isDirectory()).toBe(true)
    expect((await lstat(destinationBackupPath)).isDirectory()).toBe(true)
    expect(await readFile(
      join(destinationBackupPath, 'threads', 'thr_current', 'metadata.jsonl'),
      'utf8'
    )).toContain('current')
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls an uncommitted activation back to evidence before refreshing its source', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (!interrupted && phase === 'destination-salvaged') {
          interrupted = true
          throw new Error('crash before activation')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    const staleStagingPath = interruptedJournal.stagingPath as string
    await rename(staleStagingPath, test.current)
    await writeThread(test.legacy, 'thr_late', 'late after uncommitted activation')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('completed')
    const completed = JSON.parse(await readFile(resumed.journalPath, 'utf8'))
    expect(completed.stagingPath).not.toBe(staleStagingPath)
    expect((await lstat(staleStagingPath)).isDirectory()).toBe(true)
    expect((await readdir(join(test.current, 'threads'))).sort())
      .toEqual(['thr_history', 'thr_late'])
  })

  it('rejects a malformed optional activation fingerprint in a persisted journal', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (!interrupted && phase === 'destination-salvaged') {
          interrupted = true
          throw new Error('crash before activation')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    journal.activationFingerprint = 'not-a-sha256'
    await writeFile(first.journalPath, `${JSON.stringify(journal)}\n`, 'utf8')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed).toMatchObject({
      status: 'blocked',
      message: 'the Runtime preservation journal is inaccessible or invalid'
    })
    expect((await lstat(journal.stagingPath)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('backfills an old journal activation fingerprint only while staging still exists', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (!interrupted && phase === 'destination-salvaged') {
          interrupted = true
          throw new Error('old journal before activation fingerprint')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    delete journal.activationFingerprint
    await writeFile(first.journalPath, `${JSON.stringify(journal)}\n`, 'utf8')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('completed')
    expect(JSON.parse(await readFile(resumed.journalPath, 'utf8')).activationFingerprint)
      .toMatch(/^[a-f0-9]{64}$/u)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
  })

  it('fails closed for an old unsigned journal after staging has already moved', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_history', 'history')
    let interrupted = false
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPreservationPhase: (phase) => {
        if (!interrupted && phase === 'destination-salvaged') {
          interrupted = true
          throw new Error('old journal before activation fingerprint')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    delete journal.activationFingerprint
    await writeFile(first.journalPath, `${JSON.stringify(journal)}\n`, 'utf8')
    await rename(journal.stagingPath, test.current)
    await writeThread(test.legacy, 'thr_late', 'trusted source advanced')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(resumed.status).toBe('blocked')
    expect(resumed.message).toContain('uncommitted Runtime activation has no authenticated fingerprint')
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    await expect(lstat(journal.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['bytes', 'thread', 'registry'] as const)(
    'leaves a tampered uncommitted activation in place when its %s identity changed',
    async (drift) => {
      const test = await fixture()
      await writeThread(test.legacy, 'thr_history', 'history')
      let interrupted = false
      const first = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined,
        afterPreservationPhase: (phase) => {
          if (!interrupted && phase === 'destination-salvaged') {
            interrupted = true
            throw new Error('crash before activation')
          }
        }
      })
      expect(first.status).toBe('blocked')
      const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
      const staleStagingPath = journal.stagingPath as string
      expect(journal.activationFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      await rename(staleStagingPath, test.current)
      if (drift === 'bytes') {
        await writeFile(join(test.current, 'tampered.txt'), 'tampered\n', 'utf8')
      } else if (drift === 'thread') {
        await writeThread(test.current, 'thr_untrusted', 'untrusted')
      } else {
        await mkdir(join(test.current, 'extensions'), { recursive: true })
        await writeFile(
          join(test.current, 'extensions', 'registry.json'),
          '{"schemaVersion":1,"extensions":{"untrusted":{}}}\n',
          'utf8'
        )
      }
      await writeThread(test.legacy, 'thr_late', 'trusted source advanced')

      const resumed = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined
      })

      expect(resumed.status).toBe('blocked')
      expect(resumed.message).toContain(
        'uncommitted Runtime activation bytes or identity do not match'
      )
      expect((await lstat(test.current)).isDirectory()).toBe(true)
      await expect(lstat(staleStagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

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

})
