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
