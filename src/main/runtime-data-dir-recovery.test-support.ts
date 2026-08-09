import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { canonicalLegacyKunDataDir } from './kun-data-dir-paths'
import { runCanonicalKunRuntimeDataMigration } from './runtime-data-dir-migration'
import { RuntimeDataDirRecovery } from './runtime-data-dir-recovery'

const NOW = new Date('2026-08-05T01:02:03.000Z')
const roots: string[] = []

export function cleanupRuntimeDataRecoveryFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function makeFixture(options: {
  afterTargetActivated?: (targetPath: string) => void
} = {}): {
  homeDir: string
  userDataPath: string
  recovery: RuntimeDataDirRecovery
} {
  const root = mkdtempSync(join(tmpdir(), 'kun-runtime-recovery-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  const userDataPath = join(root, 'user-data')
  mkdirSync(homeDir, { recursive: true })
  return {
    homeDir,
    userDataPath,
    recovery: new RuntimeDataDirRecovery({
      homeDir,
      userDataPath,
      now: () => NOW,
      assertRuntimeInactive: () => undefined,
      ...(options.afterTargetActivated
        ? { afterTargetActivated: options.afterTargetActivated }
        : {})
    })
  }
}

export function seedRuntimeStore(path: string, marker: string): void {
  const thread = join(path, 'threads', `thread-${marker}`)
  mkdirSync(thread, { recursive: true })
  writeFileSync(join(thread, 'events.jsonl'), `${marker}\n`)
  writeFileSync(join(path, 'marker.txt'), marker)
  writeFileSync(join(path, 'config.json'), '{"serve":{}}\n')
}

export function interruptOriginalHistoryMigration(
  fixture: Pick<ReturnType<typeof makeFixture>, 'homeDir' | 'userDataPath'>,
  phase:
    | 'candidate-verified'
    | 'candidate-rebased'
    | 'destination-backed-up'
    | 'destination-salvaged'
): { sourcePath: string; journalPath: string } {
  const sourcePath = canonicalLegacyKunDataDir(fixture.homeDir)
  seedRuntimeStore(sourcePath, 'v3-proof')
  let interrupted = false
  const result = runCanonicalKunRuntimeDataMigration({
    homeDir: fixture.homeDir,
    userDataPath: fixture.userDataPath,
    now: () => NOW,
    sleep: () => undefined,
    availableCopyBytes: () => Number.MAX_SAFE_INTEGER,
    afterPreservationPhase: (currentPhase) => {
      if (!interrupted && currentPhase === phase) {
        interrupted = true
        throw new Error(`interrupt after ${phase}`)
      }
    }
  })
  expect(result.status).toBe('blocked')
  if (!interrupted) throw new Error(`migration did not reach ${phase}: ${JSON.stringify(result)}`)
  return { sourcePath, journalPath: result.journalPath }
}

export function canonicalCompletedV2Journal(
  sourcePath: string,
  targetPath: string,
  sourceThreadIds: string[]
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    phase: 'completed',
    sourcePath,
    targetPath,
    cutoverConflictBackupPaths: [],
    settingsBackupPaths: [],
    settingsBackedUp: true,
    extensionRegistryBackupPaths: [],
    sourceThreadIds,
    salvaged: 0,
    conflicts: [],
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: NOW.toISOString()
  }
}

export function readMarker(path: string): string {
  return readFileSync(join(path, 'marker.txt'), 'utf8')
}
