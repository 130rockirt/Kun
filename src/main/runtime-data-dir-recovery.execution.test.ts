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
  readMarker,
  seedRuntimeStore
} from './runtime-data-dir-recovery.test-support'

const NOW = new Date('2026-08-05T01:02:03.000Z')
const STAMP = '20260805T010203000Z'
afterEach(() => {
  cleanupRuntimeDataRecoveryFixtures()
})

describe('RuntimeDataDirRecovery execution boundary', () => {
  it('revalidates identity and fingerprint before creating staging data', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    seedRuntimeStore(legacy, 'before')
    const status = await fixture.recovery.getStatus()
    writeFileSync(join(legacy, 'threads', 'thread-before', 'events.jsonl'), 'changed\n')

    await expect(fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })).rejects.toMatchObject({ code: 'candidate_changed' } satisfies Partial<RuntimeDataRecoveryError>)
    expect(existsSync(canonicalCurrentKunDataDir(fixture.homeDir))).toBe(false)
    expect(readFileSync(join(legacy, 'threads', 'thread-before', 'events.jsonl'), 'utf8')).toBe('changed\n')
  })

  it('copies to fresh staging, preserves the displaced target, and atomically activates the copy', async () => {
    const fixture = makeFixture()
    const current = canonicalCurrentKunDataDir(fixture.homeDir)
    const backup = join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`)
    seedRuntimeStore(current, 'old-current')
    seedRuntimeStore(backup, 'selected-backup')
    const status = await fixture.recovery.getStatus()
    const selected = status.candidates.find((candidate) => candidate.kind === 'backup')!

    const completed = await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: selected.candidateId
    })

    expect(completed.state).toBe('completed')
    expect(readMarker(current)).toBe('selected-backup')
    expect(readMarker(backup)).toBe('selected-backup')
    const displaced = readdirSync(join(fixture.homeDir, '.kun'))
      .find((name) => name.startsWith('data.pre-runtime-recovery-'))
    expect(displaced).toBeDefined()
    expect(readMarker(join(fixture.homeDir, '.kun', displaced!))).toBe('old-current')
    expect(readdirSync(join(fixture.userDataPath, 'kun-runtime-data-recovery-v1'))).toHaveLength(1)
  })

  it('rolls back when the activated tree differs from the verified staging snapshot', async () => {
    const fixture = makeFixture({
      afterTargetActivated: (targetPath) => {
        writeFileSync(join(targetPath, 'late-mutation.txt'), 'changed after verification\n')
      }
    })
    const current = canonicalCurrentKunDataDir(fixture.homeDir)
    const backup = join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`)
    seedRuntimeStore(current, 'old-current')
    seedRuntimeStore(backup, 'selected-backup')
    const status = await fixture.recovery.getStatus()
    const selected = status.candidates.find((candidate) => candidate.kind === 'backup')!

    await expect(fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: selected.candidateId
    })).rejects.toMatchObject({ code: 'cutover_failed' })

    expect(readMarker(current)).toBe('old-current')
    expect(readMarker(backup)).toBe('selected-backup')
    const recoveryStaging = readdirSync(join(fixture.homeDir, '.kun'))
      .find((name) => name.startsWith('data.runtime-recovery-staging-'))
    expect(recoveryStaging).toBeDefined()
    expect(readMarker(join(fixture.homeDir, '.kun', recoveryStaging!))).toBe('selected-backup')
    expect(readFileSync(
      join(fixture.homeDir, '.kun', recoveryStaging!, 'late-mutation.txt'),
      'utf8'
    )).toContain('changed after verification')
    expect(validateRuntimeDataRecoveryCompletion(fixture)).toEqual({ status: 'none' })
  })

  it('initializes an empty store only when there is no historical evidence', async () => {
    const fixture = makeFixture()
    const status = await fixture.recovery.getStatus()
    expect(status).toMatchObject({ state: 'new-install', historicalEvidence: false })

    await expect(fixture.recovery.execute({
      action: 'initialize-new-install',
      generation: status.generation,
      confirmation: 'initialize-empty-new-install'
    })).resolves.toMatchObject({ state: 'completed' })
    expect(readdirSync(canonicalCurrentKunDataDir(fixture.homeDir))).toEqual([
      expect.stringMatching(/^\.kun-runtime-recovery-identity-[0-9a-f-]+\.json$/)
    ])
    expect(acceptRuntimeDataRecoveryCompletion({ ...fixture, now: () => NOW })).toMatchObject({
      status: 'valid',
      action: 'initialize-new-install',
      preservedJournalVersions: []
    })

    const reopened = new RuntimeDataDirRecovery({
      homeDir: fixture.homeDir,
      userDataPath: fixture.userDataPath,
      now: () => NOW,
      assertRuntimeInactive: () => undefined
    })
    await expect(reopened.getStatus()).resolves.toMatchObject({
      state: 'candidate-ready',
      historicalEvidence: true,
      candidates: [{ kind: 'current' }]
    })
  })

  it('requires explicit start-over for unrecoverable historical evidence and preserves it as a backup', async () => {
    const fixture = makeFixture()
    const current = canonicalCurrentKunDataDir(fixture.homeDir)
    mkdirSync(join(fixture.homeDir, '.kun'), { recursive: true })
    writeFileSync(current, 'unreadable historical shape')
    const status = await fixture.recovery.getStatus()
    expect(status).toMatchObject({ state: 'start-over-required', historicalEvidence: true })

    await expect(fixture.recovery.execute({
      action: 'start-over',
      generation: status.generation,
      confirmation: 'preserve-existing-evidence-and-start-over'
    })).resolves.toMatchObject({ state: 'completed' })
    expect(readdirSync(current)).toEqual([
      expect.stringMatching(/^\.kun-runtime-recovery-identity-[0-9a-f-]+\.json$/)
    ])
    const backup = readdirSync(join(fixture.homeDir, '.kun'))
      .find((name) => name.startsWith('data.pre-runtime-recovery-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(fixture.homeDir, '.kun', backup!), 'utf8')).toBe('unreadable historical shape')
  })

  it('expires a generation after one mutation attempt', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    seedRuntimeStore(legacy, 'history')
    const status = await fixture.recovery.getStatus()
    writeFileSync(join(legacy, 'marker.txt'), 'changed')
    const request = {
      action: 'restore' as const,
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    }
    await expect(fixture.recovery.execute(request)).rejects.toMatchObject({ code: 'candidate_changed' })
    await expect(fixture.recovery.execute(request)).rejects.toMatchObject({ code: 'generation_expired' })
  })

  it('binds immutable completion to the preserved blocked journal and activated target', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const journalPath = join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json')
    seedRuntimeStore(legacy, 'recovered-history')
    mkdirSync(fixture.userDataPath, { recursive: true })
    const blockedJournal = '{"schemaVersion":3,"phase":"candidate-verified","corrupt":true}\n'
    writeFileSync(journalPath, blockedJournal)
    const status = await fixture.recovery.getStatus()

    await fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })

    expect(validateRuntimeDataRecoveryCompletion(fixture)).toMatchObject({
      status: 'valid',
      action: 'restore',
      supersedesBlockedJournals: true,
      preservedJournalVersions: [3]
    })

    expect(acceptRuntimeDataRecoveryCompletion({ ...fixture, now: () => NOW })).toMatchObject({
      status: 'valid',
      action: 'restore',
      preservedJournalVersions: [3]
    })

    // Normal Runtime writes invalidate the one-time completion fingerprint but
    // must not invalidate the already accepted recovery decision.
    writeFileSync(join(canonicalCurrentKunDataDir(fixture.homeDir), 'runtime-write.jsonl'), 'new event\n')
    expect(validateRuntimeDataRecoveryCompletion(fixture)).toEqual({
      status: 'invalid',
      reason: 'target_changed'
    })
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toMatchObject({
      status: 'valid',
      action: 'restore',
      preservedJournalVersions: [3]
    })

    writeFileSync(journalPath, `${blockedJournal}changed\n`)
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toEqual({
      status: 'invalid',
      reason: 'journal_changed'
    })

    writeFileSync(journalPath, blockedJournal)
    rmSync(canonicalCurrentKunDataDir(fixture.homeDir), { recursive: true })
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toEqual({
      status: 'invalid',
      reason: 'target_unavailable'
    })
    mkdirSync(canonicalCurrentKunDataDir(fixture.homeDir), { recursive: true })
    expect(validateAcceptedRuntimeDataRecovery(fixture)).toEqual({
      status: 'invalid',
      reason: 'target_changed'
    })
  })
})
