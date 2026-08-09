import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptRuntimeDataRecoveryCompletion,
  RuntimeDataDirRecovery,
  RuntimeDataRecoveryError,
  runtimeDataRecoveryInternals,
  validateAcceptedRuntimeDataRecovery,
  validateRuntimeDataRecoveryCompletion
} from './runtime-data-dir-recovery'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  canonicalKunRuntimeMigrationRequiresExclusiveAccess,
  markCanonicalKunRuntimeMigrationRuntimeVerified,
  runCanonicalKunRuntimeDataMigration
} from './runtime-data-dir-migration'
import {
  cleanupRuntimeDataRecoveryFixtures,
  makeFixture,
  seedRuntimeStore
} from './runtime-data-dir-recovery.test-support'

const NOW = new Date('2026-08-05T01:02:03.000Z')
const STAMP = '20260805T010203000Z'
afterEach(() => {
  cleanupRuntimeDataRecoveryFixtures()
})

describe('Runtime recovery migration handoff', () => {
  it('keeps completed migration evidence immutable after recovery is accepted and verified healthy', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const current = canonicalCurrentKunDataDir(fixture.homeDir)
    seedRuntimeStore(legacy, 'sealed-history')
    mkdirSync(fixture.userDataPath, { recursive: true })
    writeFileSync(join(fixture.userDataPath, 'kun-settings.json'), JSON.stringify({
      version: 1,
      agents: { kun: { dataDir: '~/.deepseekgui/kun' } }
    }))

    const migrated = runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      availableCopyBytes: () => 100 * 1024 * 1024 * 1024,
      assertLegacyRuntimeInactive: () => undefined
    })
    expect(migrated, migrated.message).toMatchObject({ status: 'completed' })
    const sealedJournal = readFileSync(migrated.journalPath, 'utf8')
    rmSync(current, { recursive: true, force: true })

    const status = await fixture.recovery.refresh()
    const candidate = status.candidates.find((entry) => entry.inventory.threads === 1)
    expect(candidate).toBeDefined()
    await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: candidate!.candidateId
    })
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })).toMatchObject({ status: 'completed', authority: 'current' })
    expect(readFileSync(migrated.journalPath, 'utf8')).toBe(sealedJournal)

    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      fixture.userDataPath,
      ['thread-sealed-history'],
      { homeDir: fixture.homeDir, now: () => NOW }
    )).toMatchObject({ status: 'not-needed', missingThreadIds: [] })
    expect(readFileSync(migrated.journalPath, 'utf8')).toBe(sealedJournal)
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toMatchObject({ status: 'valid' })

    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })).toMatchObject({ status: 'completed', authority: 'current' })
    expect(readFileSync(migrated.journalPath, 'utf8')).toBe(sealedJournal)
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toMatchObject({ status: 'valid' })
  })

  it('accepts a restored target, rewrites legacy settings, and preserves the blocked journal', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const journalPath = join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json')
    const settingsPath = join(fixture.userDataPath, 'kun-settings.json')
    seedRuntimeStore(legacy, 'handoff-history')
    mkdirSync(fixture.userDataPath, { recursive: true })
    const blockedJournal = '{"schemaVersion":3,"phase":"candidate-verified","corrupt":true}\n'
    writeFileSync(journalPath, blockedJournal)
    writeFileSync(settingsPath, JSON.stringify({
      version: 1,
      agents: { kun: { dataDir: '~/.deepseekgui/kun' } },
      unrelated: { keep: true }
    }))
    const status = await fixture.recovery.getStatus()
    await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })

    expect(canonicalKunRuntimeMigrationRequiresExclusiveAccess(fixture)).toBe(true)
    const result = runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })

    expect(result).toMatchObject({ status: 'completed', authority: 'current' })
    expect(readFileSync(journalPath, 'utf8')).toBe(blockedJournal)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      agents: { kun: { dataDir: '~/.kun/data' } },
      unrelated: { keep: true }
    })
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toMatchObject({
      status: 'valid',
      action: 'restore'
    })
  })

  it('keeps an accepted handoff valid across normal Runtime writes but blocks journal drift', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const journalPath = join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json')
    seedRuntimeStore(legacy, 'accepted-history')
    mkdirSync(fixture.userDataPath, { recursive: true })
    const blockedJournal = '{"schemaVersion":3,"phase":"candidate-verified","corrupt":true}\n'
    writeFileSync(journalPath, blockedJournal)
    const status = await fixture.recovery.getStatus()
    await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    }).status).toBe('completed')

    writeFileSync(join(canonicalCurrentKunDataDir(fixture.homeDir), 'runtime-write.jsonl'), 'new event\n')
    expect(canonicalKunRuntimeMigrationRequiresExclusiveAccess(fixture)).toBe(false)
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    }).status).toBe('completed')

    writeFileSync(journalPath, `${blockedJournal}changed\n`)
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })).toMatchObject({
      status: 'blocked',
      authority: 'unknown'
    })
  })

  it('does not override a custom Runtime directory when canonical recovery evidence exists', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const settingsPath = join(fixture.userDataPath, 'kun-settings.json')
    const customPath = join(fixture.homeDir, 'custom-runtime')
    seedRuntimeStore(legacy, 'custom-history')
    mkdirSync(fixture.userDataPath, { recursive: true })
    const status = await fixture.recovery.getStatus()
    await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })
    const settings = JSON.stringify({
      version: 1,
      agents: { kun: { dataDir: customPath } },
      unrelated: { keep: true }
    })
    writeFileSync(settingsPath, settings)

    expect(canonicalKunRuntimeMigrationRequiresExclusiveAccess(fixture)).toBe(false)
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })).toMatchObject({ status: 'not-needed', authority: 'custom' })
    expect(readFileSync(settingsPath, 'utf8')).toBe(settings)
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toEqual({ status: 'none' })
  })

  it('accepts a no-journal new-install completion before normal startup', async () => {
    const fixture = makeFixture()
    const status = await fixture.recovery.getStatus()
    await fixture.recovery.execute({
      action: 'initialize-new-install',
      generation: status.generation,
      confirmation: 'initialize-empty-new-install'
    })

    expect(canonicalKunRuntimeMigrationRequiresExclusiveAccess(fixture)).toBe(true)
    expect(runCanonicalKunRuntimeDataMigration({
      ...fixture,
      now: () => NOW,
      assertLegacyRuntimeInactive: () => undefined
    })).toMatchObject({ status: 'completed', authority: 'current' })
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toMatchObject({
      status: 'valid',
      action: 'initialize-new-install',
      preservedJournalVersions: []
    })
  })
})
