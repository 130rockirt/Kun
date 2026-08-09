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
  canIgnoreRuntimeMigrationFsyncError,
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
      [],
      () => new Date('2026-07-26T04:00:00.000Z')
    )).toMatchObject({
      status: 'incomplete',
      missingThreadIds: ['thr_legacy']
    })
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBeUndefined()

    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      ['thr_legacy'],
      () => new Date('2026-07-26T04:00:00.000Z')
    )).toMatchObject({
      status: 'verified',
      expectedThreadCount: 1,
      visibleThreadCount: 1
    })
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      test.userData,
      ['thr_legacy']
    ).status).toBe('not-needed')
    expect(JSON.parse(await readFile(result.journalPath, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T04:00:00.000Z')
    expect(JSON.parse(await readFile(result.reportPath!, 'utf8')).runtimeVerifiedAt)
      .toBe('2026-07-26T04:00:00.000Z')
  })
})
