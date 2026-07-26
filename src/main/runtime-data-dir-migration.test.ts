import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markCanonicalKunRuntimeMigrationRuntimeVerified,
  retryRuntimeMigrationMutation,
  runCanonicalKunRuntimeDataMigration as runCanonicalKunRuntimeDataMigrationWithPreservation
} from './runtime-data-dir-migration'

const tempRoots: string[] = []
const TEST_EXTENSION_ID = 'acme.demo'
const TEST_EXTENSION_VERSION = '1.0.0'
const TEST_TIMESTAMP = '2026-07-26T00:00:00.000Z'

const runCanonicalKunRuntimeDataMigration = (
  input: Parameters<typeof runCanonicalKunRuntimeDataMigrationWithPreservation>[0]
) => runCanonicalKunRuntimeDataMigrationWithPreservation({
  ...input,
  skipHistoryPreservationForTests: true
})

async function fixture(dataDir = '~/.deepseekgui/kun'): Promise<{
  root: string
  home: string
  userData: string
  legacy: string
  current: string
  settingsPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'kun-runtime-dir-migration-'))
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
  const settings = JSON.parse(await readFile(path, 'utf8'))
  return settings.agents.kun.dataDir
}

async function isLinkTo(path: string, target: string): Promise<boolean> {
  const stats = await lstat(path)
  if (!stats.isSymbolicLink()) return false
  // POSIX readlink preserves the absolute target supplied by the migrator.
  return process.platform === 'win32' || (await readlink(path)) === target
}

function testExtensionManifest() {
  return {
    publisher: 'acme',
    name: 'demo',
    displayName: 'Demo',
    version: TEST_EXTENSION_VERSION,
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

function testExtensionRegistry(packagePath: string, developmentPath?: string) {
  const manifest = testExtensionManifest()
  return {
    schemaVersion: 1,
    revision: 7,
    updatedAt: TEST_TIMESTAMP,
    extensions: {
      [TEST_EXTENSION_ID]: {
        id: TEST_EXTENSION_ID,
        selectedVersion: TEST_EXTENSION_VERSION,
        globallyEnabled: false,
        workspaceEnablement: {},
        workspacePermissionGrants: {},
        versions: {
          [TEST_EXTENSION_VERSION]: {
            version: TEST_EXTENSION_VERSION,
            packagePath,
            archiveSha256: 'a'.repeat(64),
            integrity: { algorithm: 'sha256', files: {} },
            source: { type: 'local', locator: 'fixture.kunx' },
            signatureStatus: 'unsigned',
            requestedPermissions: [],
            grantedPermissions: [],
            installedAt: TEST_TIMESTAMP,
            manifest,
            mutable: false
          }
        },
        ...(developmentPath
          ? {
              development: {
                path: developmentPath,
                source: { type: 'development', locator: developmentPath },
                digest: 'b'.repeat(64),
                manifest,
                requestedPermissions: [],
                grantedPermissions: [],
                registeredAt: TEST_TIMESTAMP,
                reloadedAt: TEST_TIMESTAMP,
                generation: 1,
                mutable: true
              }
            }
          : {}),
        useDevelopment: false
      }
    }
  }
}

async function writeExtensionRegistry(
  dataDir: string,
  packagePath: string,
  developmentPath?: string
): Promise<{ path: string; document: ReturnType<typeof testExtensionRegistry>; raw: string }> {
  const registryPath = join(dataDir, 'extensions', 'registry.json')
  const document = testExtensionRegistry(packagePath, developmentPath)
  const raw = `${JSON.stringify(document, null, 2)}\n`
  await mkdir(join(dataDir, 'extensions', TEST_EXTENSION_ID, TEST_EXTENSION_VERSION), {
    recursive: true
  })
  await writeFile(registryPath, raw, 'utf8')
  return { path: registryPath, document, raw }
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

describe('canonical Kun Runtime data migration', () => {
  it('promotes the complete legacy store and makes the new config authoritative', async () => {
    const test = await fixture()
    await mkdir(test.legacy, { recursive: true })
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeFile(
      join(test.legacy, 'config.json'),
      JSON.stringify({ models: { profiles: { legacy_model: {} } } }),
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
    expect(await readFile(join(test.current, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
    expect(JSON.parse(await readFile(join(test.current, 'config.json'), 'utf8')))
      .toHaveProperty('models.profiles.legacy_model')
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.phase).toBe('completed')
    expect(journal.sourceInventory).toMatchObject({
      files: expect.any(Number),
      directories: expect.any(Number),
      bytes: expect.any(Number)
    })
    expect(journal.targetInventory).toMatchObject({
      files: expect.any(Number),
      directories: expect.any(Number),
      bytes: expect.any(Number)
    })
    expect(journal.sqliteQuickCheck).toBe('missing')
    expect(journal.settingsBackedUp).toBe(true)
    expect(journal.settingsBackupPaths).toHaveLength(1)
    expect(await readSettingsDataDir(journal.settingsBackupPaths[0])).toBe('~/.deepseekgui/kun')
  })

  it('durably rebases installed extension paths and preserves all unrelated registry state', async () => {
    const test = await fixture()
    const legacyPackagePath = join(
      test.legacy,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const currentPackagePath = join(
      test.current,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const developmentPath = join(test.root, 'development-extension')
    const seeded = await writeExtensionRegistry(
      test.legacy,
      legacyPackagePath,
      developmentPath
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    const migratedRegistryPath = join(test.current, 'extensions', 'registry.json')
    const migrated = JSON.parse(await readFile(migratedRegistryPath, 'utf8'))
    const expected = structuredClone(seeded.document)
    expected.extensions[TEST_EXTENSION_ID].versions[TEST_EXTENSION_VERSION].packagePath =
      currentPackagePath
    expect(migrated).toEqual(expected)
    expect(migrated.extensions[TEST_EXTENSION_ID].development.path).toBe(developmentPath)

    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.extensionRegistryRebasedRecords).toBe(1)
    expect(journal.extensionRegistryRebasedAt).toEqual(expect.any(String))
    expect(journal.extensionRegistryBackupPaths).toHaveLength(1)
    expect(await readFile(journal.extensionRegistryBackupPaths[0], 'utf8')).toBe(seeded.raw)

    const registryBeforeRepeat = await readFile(migratedRegistryPath, 'utf8')
    const repeated = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(repeated.status).toBe('completed')
    expect(await readFile(migratedRegistryPath, 'utf8')).toBe(registryBeforeRepeat)
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).extensionRegistryBackupPaths)
      .toEqual(journal.extensionRegistryBackupPaths)
  })

  it('does not rewrite or back up an already-canonical extension registry', async () => {
    const test = await fixture()
    const currentPackagePath = join(
      test.current,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const seeded = await writeExtensionRegistry(test.legacy, currentPackagePath)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(join(test.current, 'extensions', 'registry.json'), 'utf8'))
      .toBe(seeded.raw)
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.extensionRegistryBackupPaths).toEqual([])
    expect(journal.extensionRegistryRebasedRecords).toBe(0)
  })

  it('blocks without rewriting an extension record outside the canonical migration roots', async () => {
    const test = await fixture()
    const unexpectedPackagePath = join(
      test.root,
      'unrelated-extension-store',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const seeded = await writeExtensionRegistry(test.legacy, unexpectedPackagePath)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain(
      `packagePath is outside the canonical migration roots: ` +
      `${TEST_EXTENSION_ID}@${TEST_EXTENSION_VERSION}`
    )
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.deepseekgui/kun')
    expect(await readFile(join(test.current, 'extensions', 'registry.json'), 'utf8'))
      .toBe(seeded.raw)
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.phase).toBe('salvaged')
    expect(journal.extensionRegistryBackupPaths).toEqual([])
  })

  it('blocks on an unsafe extension registry identity without creating a backup', async () => {
    const test = await fixture()
    const unsafeId = '../escape'
    const registry = testExtensionRegistry(join(test.legacy, 'extensions', 'escape', '1.0.0'))
    registry.extensions = {
      [unsafeId]: {
        ...registry.extensions[TEST_EXTENSION_ID],
        id: unsafeId
      }
    } as unknown as typeof registry.extensions
    const registryPath = join(test.legacy, 'extensions', 'registry.json')
    await mkdir(join(test.legacy, 'extensions'), { recursive: true })
    const raw = `${JSON.stringify(registry, null, 2)}\n`
    await writeFile(registryPath, raw, 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toContain(`extension registry identity is unsafe: ${unsafeId}`)
    expect(await readFile(join(test.current, 'extensions', 'registry.json'), 'utf8')).toBe(raw)
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).extensionRegistryBackupPaths)
      .toEqual([])
  })

  it.each([
    'extension-registry-backed-up',
    'extension-registry-rebased'
  ] as const)('resumes extension registry repair after interruption in phase %s', async (phase) => {
    const test = await fixture()
    const legacyPackagePath = join(
      test.legacy,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    await writeExtensionRegistry(test.legacy, legacyPackagePath)
    let interrupted = false

    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPhase: (currentPhase) => {
        if (!interrupted && currentPhase === phase) {
          interrupted = true
          throw new Error(`simulated interruption after ${phase}`)
        }
      }
    })

    expect(first.status).toBe('blocked')
    const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    expect(interruptedJournal.phase).toBe(phase)
    expect(interruptedJournal.extensionRegistryBackupPaths).toHaveLength(1)

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(resumed.status).toBe('completed')
    const registry = JSON.parse(await readFile(
      join(test.current, 'extensions', 'registry.json'),
      'utf8'
    ))
    expect(
      registry.extensions[TEST_EXTENSION_ID].versions[TEST_EXTENSION_VERSION].packagePath
    ).toBe(join(test.current, 'extensions', TEST_EXTENSION_ID, TEST_EXTENSION_VERSION))
    expect(JSON.parse(await readFile(first.journalPath, 'utf8')).extensionRegistryBackupPaths)
      .toEqual(interruptedJournal.extensionRegistryBackupPaths)
  })

  it('finishes recovery when the registry rewrite landed before its journal update', async () => {
    const test = await fixture()
    const legacyPackagePath = join(
      test.legacy,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    await writeExtensionRegistry(test.legacy, legacyPackagePath)

    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPhase: (phase) => {
        if (phase === 'extension-registry-backed-up') {
          throw new Error('simulated interruption before the registry rewrite')
        }
      }
    })
    expect(first.status).toBe('blocked')
    const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    expect(interruptedJournal.extensionRegistryRebasedRecords).toBe(1)

    // Simulate an atomic registry rename that completed immediately before
    // the process exited and therefore before the journal phase advanced.
    const currentPackagePath = join(
      test.current,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    await writeExtensionRegistry(test.current, currentPackagePath)

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(resumed.status).toBe('completed')

    const completedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    expect(completedJournal.extensionRegistryRebasedRecords).toBe(1)
    expect(completedJournal.extensionRegistryRebasedAt).toEqual(expect.any(String))
    expect(completedJournal.extensionRegistryBackupPaths)
      .toEqual(interruptedJournal.extensionRegistryBackupPaths)
  })

  it('repairs a legacy extension path left by an already-completed version-2 migration', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(first.status).toBe('completed')

    const legacyPackagePath = join(
      test.legacy,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const seeded = await writeExtensionRegistry(test.current, legacyPackagePath)
    const oldJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    delete oldJournal.extensionRegistryBackupPaths
    delete oldJournal.extensionRegistryRebasedRecords
    delete oldJournal.extensionRegistryRebasedAt
    await writeFile(first.journalPath, `${JSON.stringify(oldJournal, null, 2)}\n`, 'utf8')

    const repaired = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(repaired.status).toBe('completed')
    const registry = JSON.parse(await readFile(seeded.path, 'utf8'))
    expect(
      registry.extensions[TEST_EXTENSION_ID].versions[TEST_EXTENSION_VERSION].packagePath
    ).toBe(join(test.current, 'extensions', TEST_EXTENSION_ID, TEST_EXTENSION_VERSION))
    const repairedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    expect(repairedJournal.phase).toBe('completed')
    expect(repairedJournal.extensionRegistryRebasedRecords).toBe(1)
    expect(repairedJournal.extensionRegistryBackupPaths).toHaveLength(1)
    expect(await readFile(repairedJournal.extensionRegistryBackupPaths[0], 'utf8'))
      .toBe(seeded.raw)
  })

  it('adopts and repairs a verified canonical layout that predates the migration journal', async () => {
    const test = await fixture('~/.kun/data')
    await mkdir(test.current, { recursive: true })
    await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
    await symlink(test.current, test.legacy, process.platform === 'win32' ? 'junction' : 'dir')
    const legacyPackagePath = join(
      test.legacy,
      'extensions',
      TEST_EXTENSION_ID,
      TEST_EXTENSION_VERSION
    )
    const seeded = await writeExtensionRegistry(test.current, legacyPackagePath)

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(result.journalPath)).isFile()).toBe(true)
    const registry = JSON.parse(await readFile(seeded.path, 'utf8'))
    expect(
      registry.extensions[TEST_EXTENSION_ID].versions[TEST_EXTENSION_VERSION].packagePath
    ).toBe(join(test.current, 'extensions', TEST_EXTENSION_ID, TEST_EXTENSION_VERSION))
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.extensionRegistryRebasedRecords).toBe(1)
    expect(journal.extensionRegistryBackupPaths).toHaveLength(1)
  })

  it('keeps a completed migration blocked when its extension registry is malformed', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(first.status).toBe('completed')

    const registryPath = join(test.current, 'extensions', 'registry.json')
    const malformed = `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: TEST_TIMESTAMP,
      extensions: {
        [TEST_EXTENSION_ID]: {
          id: TEST_EXTENSION_ID,
          versions: []
        }
      }
    }, null, 2)}\n`
    await mkdir(join(test.current, 'extensions'), { recursive: true })
    await writeFile(registryPath, malformed, 'utf8')
    const oldJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    delete oldJournal.extensionRegistryBackupPaths
    delete oldJournal.extensionRegistryRebasedRecords
    delete oldJournal.extensionRegistryRebasedAt
    await writeFile(first.journalPath, `${JSON.stringify(oldJournal, null, 2)}\n`, 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.authority).toBe('current')
    expect(result.message).toContain(`extension registry entry has an invalid shape: ${TEST_EXTENSION_ID}`)
    expect(await readFile(registryPath, 'utf8')).toBe(malformed)
    expect(
      JSON.parse(await readFile(first.journalPath, 'utf8')).extensionRegistryBackupPaths ?? []
    ).toEqual([])
  })

  it('runs SQLite quick_check against a promoted Runtime index', async () => {
    const test = await fixture()
    await mkdir(test.legacy, { recursive: true })
    const database = new DatabaseSync(join(test.legacy, 'index.sqlite3'))
    try {
      database.exec('CREATE TABLE migration_probe (id TEXT PRIMARY KEY)')
      database.prepare('INSERT INTO migration_probe (id) VALUES (?)').run('ok')
    } finally {
      database.close()
    }

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.sqliteQuickCheck).toBe('ok')
    expect((await lstat(join(test.current, 'index.sqlite3'))).isFile()).toBe(true)
  })

  it('preserves an invalid rebuildable SQLite index and records failed validation', async () => {
    const test = await fixture()
    await mkdir(test.legacy, { recursive: true })
    await writeFile(join(test.legacy, 'index.sqlite3'), 'not-a-sqlite-database', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(join(test.current, 'index.sqlite3'), 'utf8'))
      .toBe('not-a-sqlite-database')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).sqliteQuickCheck)
      .toBe('invalid')
  })

  it('backs up a populated destination and salvages non-conflicting identity data', async () => {
    const test = await fixture()
    await mkdir(test.legacy, { recursive: true })
    await mkdir(test.current, { recursive: true })
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_new', 'new')
    await mkdir(join(test.current, 'attachments'), { recursive: true })
    await writeFile(join(test.current, 'attachments', 'att_new.json'), '{"id":"att_new"}', 'utf8')
    await mkdir(join(test.current, 'extensions'), { recursive: true })
    await writeFile(join(test.current, 'extensions', 'accounts.json'), '{"accounts":["new"]}', 'utf8')
    await mkdir(join(test.current, 'credentials'), { recursive: true })
    await writeFile(join(test.current, 'credentials', 'credentials.enc.json'), '{"encrypted":"new"}', 'utf8')
    await writeFile(join(test.current, 'secret.key'), 'new-secret-key', 'utf8')
    await mkdir(join(test.current, 'memory'), { recursive: true })
    await writeFile(join(test.current, 'memory', 'mem_new.json'), '{"id":"mem_new"}', 'utf8')
    await writeFile(join(test.legacy, 'config.json'), '{"source":"legacy"}', 'utf8')
    await writeFile(join(test.current, 'config.json'), '{"source":"new"}', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.destinationBackupPath).toBeTruthy()
    expect(JSON.parse(await readFile(join(test.current, 'config.json'), 'utf8')).source).toBe('legacy')
    expect(JSON.parse(await readFile(join(result.destinationBackupPath!, 'config.json'), 'utf8')).source).toBe('new')
    expect((await readdir(join(test.current, 'threads'))).sort()).toEqual(['thr_legacy', 'thr_new'])
    expect(await readFile(join(test.current, 'attachments', 'att_new.json'), 'utf8')).toContain('att_new')
    expect(await readFile(join(test.current, 'extensions', 'accounts.json'), 'utf8'))
      .toContain('"new"')
    expect(await readFile(join(test.current, 'credentials', 'credentials.enc.json'), 'utf8'))
      .toContain('"new"')
    expect(await readFile(join(test.current, 'secret.key'), 'utf8')).toBe('new-secret-key')
    expect(await readFile(join(test.current, 'memory', 'mem_new.json'), 'utf8')).toContain('mem_new')
    expect((await lstat(result.destinationBackupPath!)).isDirectory()).toBe(true)
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.destinationInventory).toMatchObject({
      files: expect.any(Number),
      directories: expect.any(Number),
      bytes: expect.any(Number)
    })

    const backupEntriesBefore = (await readdir(join(test.home, '.kun'))).sort()
    const repeated = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(repeated.status).toBe('completed')
    expect(repeated.destinationBackupPath).toBe(result.destinationBackupPath)
    expect((await readdir(join(test.home, '.kun'))).sort()).toEqual(backupEntriesBefore)
  })

  it('never overwrites a conflicting destination history', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_same', 'authoritative legacy')
    await writeThread(test.current, 'thr_same', 'alternate new')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(join(test.current, 'threads', 'thr_same', 'metadata.jsonl'), 'utf8'))
      .toContain('authoritative legacy')
    expect(await readFile(
      join(result.destinationBackupPath!, 'threads', 'thr_same', 'metadata.jsonl'),
      'utf8'
    )).toContain('alternate new')
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.conflicts).toContain('threads/thr_same')
  })

  it('does not mix protected identity records from different Runtime stores', async () => {
    const test = await fixture()
    await mkdir(join(test.legacy, 'credentials'), { recursive: true })
    await mkdir(join(test.current, 'credentials'), { recursive: true })
    await writeFile(join(test.legacy, 'secret.key'), 'legacy-key', 'utf8')
    await writeFile(
      join(test.legacy, 'credentials', 'credentials.enc.json'),
      '{"encrypted":"legacy"}',
      'utf8'
    )
    await writeFile(join(test.current, 'secret.key'), 'current-key', 'utf8')
    await writeFile(
      join(test.current, 'credentials', 'credentials.enc.json'),
      '{"encrypted":"current"}',
      'utf8'
    )

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readFile(join(test.current, 'secret.key'), 'utf8')).toBe('legacy-key')
    expect(await readFile(
      join(test.current, 'credentials', 'credentials.enc.json'),
      'utf8'
    )).toContain('"legacy"')
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.conflicts).toEqual(expect.arrayContaining(['credentials', 'secret.key']))
    expect(await readFile(join(result.destinationBackupPath!, 'secret.key'), 'utf8'))
      .toBe('current-key')
  })

  it.skipIf(process.platform === 'win32')(
    'does not activate symlinked records from the displaced destination',
    async () => {
      const test = await fixture()
      await writeThread(test.legacy, 'thr_legacy', 'legacy')
      const external = join(test.root, 'external-history')
      await writeThread(external, 'payload', 'outside')
      await mkdir(join(test.current, 'threads', 'thr_linked'), { recursive: true })
      await symlink(
        join(external, 'threads', 'payload', 'metadata.jsonl'),
        join(test.current, 'threads', 'thr_linked', 'metadata.jsonl')
      )

      const result = runCanonicalKunRuntimeDataMigration({
        userDataPath: test.userData,
        homeDir: test.home,
        sleep: () => undefined
      })

      expect(result.status).toBe('completed')
      await expect(lstat(join(test.current, 'threads', 'thr_linked')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lstat(
        join(result.destinationBackupPath!, 'threads', 'thr_linked', 'metadata.jsonl')
      )).isSymbolicLink()).toBe(true)
      expect(JSON.parse(await readFile(result.reportPath!, 'utf8')).conflicts)
        .toContain('threads/thr_linked')
    }
  )

  it('leaves an explicit custom data directory untouched', async () => {
    const test = await fixture(join(testPathPlaceholder(), 'custom-runtime'))
    await mkdir(test.legacy, { recursive: true })
    await writeThread(test.legacy, 'thr_legacy', 'legacy')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('not-needed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    await expect(lstat(test.current)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a custom data directory selected after a completed migration', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(first.status).toBe('completed')

    const customDataDir = join(test.root, 'custom-runtime')
    await writeFile(
      test.settingsPath,
      JSON.stringify({ version: 1, agents: { kun: { dataDir: customDataDir } } }),
      'utf8'
    )
    const repeated = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(repeated.status).toBe('not-needed')
    expect(repeated.authority).toBe('custom')
    expect(await readSettingsDataDir(test.settingsPath)).toBe(customDataDir)
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
  })

  it('uses the same legacy userData settings fallback as JsonSettingsStore', async () => {
    const test = await fixture()
    await rm(test.settingsPath)
    await writeFile(join(test.userData, 'non-settings-state'), 'keep current userData', 'utf8')
    const legacyUserData = join(test.root, 'appData', 'DeepSeek GUI')
    await mkdir(legacyUserData, { recursive: true })
    await writeFile(
      join(legacyUserData, 'deepseek-gui-settings.json'),
      JSON.stringify({ version: 1, agents: { kun: { dataDir: '~/.kun/data' } } }),
      'utf8'
    )
    await mkdir(test.legacy, { recursive: true })
    await mkdir(test.current, { recursive: true })
    await writeFile(join(test.legacy, 'config.json'), '{"source":"legacy"}', 'utf8')
    await writeFile(join(test.current, 'config.json'), '{"source":"current"}', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(JSON.parse(await readFile(join(test.current, 'config.json'), 'utf8')).source)
      .toBe('current')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(join(test.legacy, 'config.json'), 'utf8')).source)
      .toBe('legacy')
    const quarantined = (await readdir(join(test.home, '.deepseekgui')))
      .find((name) => name.startsWith('kun.post-migration-'))
    expect(quarantined).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'backs up and rewrites the target of a symlinked active settings file',
    async () => {
    const test = await fixture()
    const actualSettings = join(test.userData, 'actual-settings.json')
    await rm(test.settingsPath)
    await writeFile(
      actualSettings,
      JSON.stringify({ version: 1, agents: { kun: { dataDir: '~/.deepseekgui/kun' } } }),
      'utf8'
    )
    await symlink(actualSettings, test.settingsPath)
    await writeThread(test.legacy, 'thr_legacy', 'legacy')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.settingsPath)).isSymbolicLink()).toBe(true)
    expect(await readSettingsDataDir(actualSettings)).toBe('~/.kun/data')
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.settingsSourcePath).toBe(test.settingsPath)
    expect(journal.settingsWritePath).toBe(await realpath(actualSettings))
    expect(journal.settingsBackupPaths).toHaveLength(1)
    expect(await readSettingsDataDir(journal.settingsBackupPaths[0]))
      .toBe('~/.deepseekgui/kun')
    }
  )

  it('performs an empty-store cutover when only a stale legacy setting exists', async () => {
    const test = await fixture()

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
  })

  it('adopts an existing verified compatibility link and still backs up settings', async () => {
    const test = await fixture()
    await writeThread(test.current, 'thr_current', 'current')
    await mkdir(join(test.home, '.deepseekgui'), { recursive: true })
    await symlink(test.current, test.legacy, process.platform === 'win32' ? 'junction' : 'dir')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    const journal = JSON.parse(await readFile(result.journalPath, 'utf8'))
    expect(journal.settingsBackedUp).toBe(true)
    expect(journal.settingsBackupPaths).toHaveLength(1)
  })

  it('blocks on an invalid recovery journal without mutating either store', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_new', 'new')
    const journalPath = join(test.userData, 'kun-runtime-data-migration-v2.json')
    await writeFile(journalPath, '{"schemaVersion":2,"phase":"unknown"}', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/journal is inaccessible or invalid/)
    expect(await readFile(journalPath, 'utf8')).toContain('"phase":"unknown"')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
  })

  it('leaves a real legacy directory untouched when settings already select the new store', async () => {
    const test = await fixture('~/.kun/data')
    await mkdir(test.legacy, { recursive: true })
    await mkdir(test.current, { recursive: true })
    await writeFile(join(test.legacy, 'config.json'), '{"source":"stale"}', 'utf8')
    await writeFile(join(test.current, 'config.json'), '{"source":"current"}', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(join(test.current, 'config.json'), 'utf8')).source).toBe('current')
    const legacyParentEntries = await readdir(join(test.home, '.deepseekgui'))
    const quarantine = legacyParentEntries.find((name) => name.startsWith('kun.post-migration-'))
    expect(quarantine).toBeUndefined()
    expect(JSON.parse(await readFile(join(test.legacy, 'config.json'), 'utf8')).source)
      .toBe('stale')
  })

  it.each([
    'settings-backed-up',
    'destination-backed-up',
    'source-promoted',
    'link-created',
    'salvaged',
    'settings-rewritten'
  ] as const)('resumes after interruption in phase %s', async (phase) => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_new', 'new')
    let interrupted = false

    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      afterPhase: (currentPhase) => {
        if (!interrupted && currentPhase === phase) {
          interrupted = true
          throw new Error(`simulated interruption after ${phase}`)
        }
      }
    })
    expect(first.status).toBe('blocked')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(resumed.status).toBe('completed')
    expect((await readdir(join(test.current, 'threads'))).sort()).toEqual(['thr_legacy', 'thr_new'])
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
  })

  it('rolls back directory names when compatibility-link creation fails', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_new', 'new')

    const failed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      beforeCompatibilityLink: () => {
        throw new Error('simulated link denial')
      }
    })

    expect(failed.status).toBe('blocked')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    expect(await readFile(join(test.legacy, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
    expect(await readFile(join(test.current, 'threads', 'thr_new', 'metadata.jsonl'), 'utf8'))
      .toContain('new')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.deepseekgui/kun')
  })

  it('ignores an invalid stale secondary settings file when the active file is valid', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeFile(join(test.userData, 'deepseek-gui-settings.json'), '{broken', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
    expect(await readFile(join(test.current, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
    expect(await readFile(join(test.userData, 'deepseek-gui-settings.json'), 'utf8'))
      .toBe('{broken')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).phase).toBe('completed')
  })

  it('recovers the legacy store before invalid active settings are replaced with defaults', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeFile(test.settingsPath, '{broken', 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.authority).toBe('current')
    expect(await readFile(test.settingsPath, 'utf8')).toBe('{broken')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
    expect(await readFile(join(test.current, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
  })

  it('recovers an available legacy store when repaired settings already select a missing target', async () => {
    const test = await fixture('~/.kun/data')
    await writeThread(test.legacy, 'thr_legacy', 'legacy')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.authority).toBe('current')
    expect(await readSettingsDataDir(test.settingsPath)).toBe('~/.kun/data')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
    expect(await readFile(join(test.current, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
  })

  it('blocks before mutation while an active Runtime owns the legacy directory', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      assertLegacyRuntimeInactive: () => {
        throw new Error('simulated active Runtime owner')
      }
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/active Runtime owner/)
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    await expect(lstat(result.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back and preserves a legacy path recreated during cutover', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')

    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      beforeCompatibilityLink: () => {
        // The hook is synchronous, matching a Runtime that recreates the path
        // between source promotion and compatibility-link creation.
        mkdirSync(test.legacy, { recursive: true })
        writeFileSync(join(test.legacy, 'write-during-cutover'), 'preserved', 'utf8')
      }
    })

    expect(first.status).toBe('blocked')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    expect(await readFile(join(test.legacy, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
    expect(await readFile(join(test.current, 'threads', 'thr_current', 'metadata.jsonl'), 'utf8'))
      .toContain('current')
    const interruptedJournal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    expect(interruptedJournal.cutoverConflictBackupPaths).toHaveLength(1)
    expect(await readFile(
      join(interruptedJournal.cutoverConflictBackupPaths[0], 'write-during-cutover'),
      'utf8'
    )).toBe('preserved')

    const resumed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(resumed.status).toBe('completed')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
  })

  it.each([
    'rollback-conflict-planned',
    'rollback-conflict-backed-up',
    'rollback-source-restored'
  ] as const)('resumes an interrupted directory rollback in phase %s', async (phase) => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')
    let interrupted = false

    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      beforeCompatibilityLink: () => {
        mkdirSync(test.legacy, { recursive: true })
        writeFileSync(join(test.legacy, 'write-during-cutover'), 'preserved', 'utf8')
      },
      afterPhase: (currentPhase) => {
        if (!interrupted && currentPhase === phase) {
          interrupted = true
          throw new Error(`simulated interruption after ${phase}`)
        }
      }
    })

    expect(first.status).toBe('blocked')
    expect(JSON.parse(await readFile(first.journalPath, 'utf8')).phase).toBe(phase)

    const rollbackResume = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(rollbackResume.status).toBe('blocked')
    expect(JSON.parse(await readFile(first.journalPath, 'utf8')).phase)
      .toBe('settings-backed-up')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
    expect(await readFile(join(test.legacy, 'threads', 'thr_legacy', 'metadata.jsonl'), 'utf8'))
      .toContain('legacy')
    expect(await readFile(join(test.current, 'threads', 'thr_current', 'metadata.jsonl'), 'utf8'))
      .toContain('current')

    const completed = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(completed.status).toBe('completed')
    expect(await isLinkTo(test.legacy, test.current)).toBe(true)
  })

  it('rejects an unsafe journal-controlled backup path before mutation', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')
    const victim = join(test.root, 'unrelated-user-directory')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'untouched', 'utf8')
    const journalPath = join(test.userData, 'kun-runtime-data-migration-v2.json')
    const timestamp = '2026-07-26T00:00:00.000Z'
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 2,
      phase: 'settings-backed-up',
      sourcePath: test.legacy,
      targetPath: test.current,
      destinationBackupPath: victim,
      cutoverConflictBackupPaths: [],
      settingsSourcePath: test.settingsPath,
      settingsWritePath: test.settingsPath,
      settingsBackupPaths: [],
      settingsBackedUp: true,
      sourceThreadIds: ['thr_legacy'],
      salvaged: 0,
      conflicts: [],
      startedAt: timestamp,
      updatedAt: timestamp
    }), 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/unsafe destination backup path/)
    expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('untouched')
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
  })

  it('rejects an unsafe extension registry backup path in a completed journal', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    const first = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })
    expect(first.status).toBe('completed')

    const victim = join(test.root, 'unrelated-registry-backup.json')
    await writeFile(victim, '{"keep":true}\n', 'utf8')
    const journal = JSON.parse(await readFile(first.journalPath, 'utf8'))
    journal.extensionRegistryBackupPaths = [victim]
    await writeFile(first.journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/unsafe extension registry backup path/)
    expect(await readFile(victim, 'utf8')).toBe('{"keep":true}\n')
  })

  it('blocks before mutation while an active Runtime owns the destination directory', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_current', 'current')
    const inspected: string[] = []

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      assertLegacyRuntimeInactive: (dataDir) => {
        inspected.push(dataDir)
        if (dataDir === test.current) throw new Error('simulated active destination owner')
      }
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/active destination owner/)
    expect(inspected).toEqual([test.legacy, test.current])
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
  })

  it('rejects cross-volume promotion before mutating either store', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    await writeThread(test.current, 'thr_new', 'new')

    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined,
      statDevice: (path) => path === test.legacy ? 1 : 2
    })

    expect(result.status).toBe('blocked')
    expect(result.message).toMatch(/same-volume/)
    expect((await lstat(test.legacy)).isDirectory()).toBe(true)
    expect((await lstat(test.current)).isDirectory()).toBe(true)
  })

  it('records Runtime verification only after a completed migration', async () => {
    const test = await fixture()
    await writeThread(test.legacy, 'thr_legacy', 'legacy')
    const result = runCanonicalKunRuntimeDataMigration({
      userDataPath: test.userData,
      homeDir: test.home,
      sleep: () => undefined
    })

    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      () => new Date('2026-07-26T04:00:00.000Z')
    )).toBe(true)
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(test.userData)).toBe(false)
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T04:00:00.000Z')
    expect(JSON.parse(await readFile(result.reportPath!, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T04:00:00.000Z')
  })
})

describe('Windows migration retries', () => {
  it('retries transient Windows lock errors with bounded backoff', () => {
    const sleeps: number[] = []
    let attempts = 0
    retryRuntimeMigrationMutation(() => {
      attempts += 1
      if (attempts < 4) {
        const error = new Error('locked') as NodeJS.ErrnoException
        error.code = attempts === 1 ? 'EPERM' : attempts === 2 ? 'EBUSY' : 'EACCES'
        throw error
      }
    }, {
      platform: 'win32',
      sleep: (milliseconds) => sleeps.push(milliseconds)
    })
    expect(attempts).toBe(4)
    expect(sleeps).toEqual([0, 50, 150, 350])
  })
})

function testPathPlaceholder(): string {
  return '/explicit'
}
