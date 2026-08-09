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
  canonicalCompletedV2Journal,
  cleanupRuntimeDataRecoveryFixtures,
  interruptOriginalHistoryMigration,
  makeFixture,
  readMarker,
  seedRuntimeStore
} from './runtime-data-dir-recovery.test-support'

const NOW = new Date('2026-08-05T01:02:03.000Z')
const STAMP = '20260805T010203000Z'
afterEach(() => {
  cleanupRuntimeDataRecoveryFixtures()
})

describe('RuntimeDataDirRecovery candidate inventory', () => {
  it('scans only canonical roots and exact migration-owned sibling names', async () => {
    const fixture = makeFixture()
    const backup = join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`)
    seedRuntimeStore(backup, 'preserved')
    seedRuntimeStore(join(fixture.homeDir, '.kun', 'data.attacker-copy.bak'), 'ignored')

    const status = await fixture.recovery.getStatus()

    expect(status.state).toBe('candidate-ready')
    expect(status.candidates).toHaveLength(1)
    expect(status.candidates[0]).toMatchObject({ kind: 'backup', equivalentCopies: 1 })
    expect(status.candidates[0].candidateId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(status)).not.toContain(fixture.homeDir)
    expect(JSON.stringify(status)).not.toContain('preserved')
    expect(status.historicalEvidence).toBe(true)
  })

  it('deduplicates byte-identical stores and prefers the canonical current copy', async () => {
    const fixture = makeFixture()
    seedRuntimeStore(canonicalCurrentKunDataDir(fixture.homeDir), 'same')
    seedRuntimeStore(canonicalLegacyKunDataDir(fixture.homeDir), 'same')

    const status = await fixture.recovery.getStatus()

    expect(status.state).toBe('candidate-ready')
    expect(status.candidates).toHaveLength(1)
    expect(status.candidates[0]).toMatchObject({ kind: 'current', equivalentCopies: 2 })
  })

  it('requires a choice for non-identical trusted histories', async () => {
    const fixture = makeFixture()
    seedRuntimeStore(canonicalCurrentKunDataDir(fixture.homeDir), 'current')
    seedRuntimeStore(canonicalLegacyKunDataDir(fixture.homeDir), 'legacy')

    const status = await fixture.recovery.getStatus()

    expect(status.state).toBe('selection-required')
    expect(status.candidates.map((candidate) => candidate.kind)).toEqual(['current', 'legacy'])
    expect(status.recommendedCandidateId).toBeUndefined()
  })

  it('does not offer migration staging that is only referenced by a shallow journal', async () => {
    const fixture = makeFixture()
    const staging = join(fixture.homeDir, '.kun', `data.history-preserving-staging-${STAMP}.bak`)
    seedRuntimeStore(staging, 'journal-copy')
    const staged = runtimeDataRecoveryInternals.inspectCandidate(
      staging,
      'staging',
      process.platform
    )
    mkdirSync(fixture.userDataPath, { recursive: true })
    writeFileSync(join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json'), JSON.stringify({
      schemaVersion: 3,
      phase: 'candidate-verified',
      provenance: 'original-legacy-source',
      sourcePath: canonicalLegacyKunDataDir(fixture.homeDir),
      targetPath: canonicalCurrentKunDataDir(fixture.homeDir),
      stagingPath: staging,
      sourceThreadIds: ['thread-journal-copy'],
      sourceInventory: {
        files: staged.summary.inventory.files,
        directories: staged.summary.inventory.directories,
        symlinks: staged.summary.inventory.symlinks,
        bytes: staged.summary.inventory.bytes
      },
      sourceFingerprint: staged.fingerprint,
      candidateFingerprint: staged.fingerprint
    }))

    const status = await fixture.recovery.getStatus()

    expect(status).toMatchObject({
      state: 'start-over-required',
      candidates: [],
      historicalEvidence: true
    })
    expect(status.invalidEvidenceCount).toBeGreaterThanOrEqual(1)
  })

  it.each([
    'candidate-verified',
    'candidate-rebased',
    'destination-backed-up',
    'destination-salvaged'
  ] as const)(
    'offers an exact v3 migration staging copy after source loss in phase %s',
    async (phase) => {
      const fixture = makeFixture()
      const interrupted = interruptOriginalHistoryMigration(fixture, phase)
      rmSync(interrupted.sourcePath, { recursive: true, force: true })

      const status = await fixture.recovery.getStatus()

      expect(status).toMatchObject({
        state: 'candidate-ready',
        historicalEvidence: true,
        invalidEvidenceCount: 0
      })
      expect(status.candidates).toHaveLength(1)
      expect(status.candidates[0]).toMatchObject({
        kind: 'staging',
        journalReferenced: true,
        journalVerified: true,
        recoveryVerified: false
      })
      expect(status.recommendedCandidateId).toBe(status.candidates[0].candidateId)

      const completed = await fixture.recovery.recoverAutomaticallyIfSafe()
      expect(completed?.state).toBe('completed')
      expect(readMarker(canonicalCurrentKunDataDir(fixture.homeDir))).toBe('v3-proof')
    }
  )

  it('refreshes journal thread identity before a second crash and source loss', async () => {
    const fixture = makeFixture()
    const interrupted = interruptOriginalHistoryMigration(fixture, 'candidate-verified')
    const lateThread = join(interrupted.sourcePath, 'threads', 'thread-late')
    mkdirSync(lateThread, { recursive: true })
    writeFileSync(join(lateThread, 'events.jsonl'), 'late\n')
    let refreshed = false
    const second = runCanonicalKunRuntimeDataMigration({
      homeDir: fixture.homeDir,
      userDataPath: fixture.userDataPath,
      now: () => NOW,
      sleep: () => undefined,
      availableCopyBytes: () => Number.MAX_SAFE_INTEGER,
      afterPreservationPhase: (phase) => {
        if (!refreshed && phase === 'candidate-verified') {
          refreshed = true
          throw new Error('interrupt after refreshed candidate verification')
        }
      }
    })
    expect(second.status).toBe('blocked')
    const refreshedJournal = JSON.parse(readFileSync(second.journalPath, 'utf8'))
    expect(refreshedJournal.sourceThreadIds).toEqual([
      'thread-late',
      'thread-v3-proof'
    ])

    const unavailableSource = `${interrupted.sourcePath}.unavailable`
    renameSync(interrupted.sourcePath, unavailableSource)
    const status = await fixture.recovery.refresh()
    expect(status).toMatchObject({
      state: 'candidate-ready',
      candidates: [{
        kind: 'staging',
        journalVerified: true,
        inventory: { threads: 2 }
      }]
    })

    renameSync(unavailableSource, interrupted.sourcePath)
    const completed = runCanonicalKunRuntimeDataMigration({
      homeDir: fixture.homeDir,
      userDataPath: fixture.userDataPath,
      now: () => NOW,
      sleep: () => undefined,
      availableCopyBytes: () => Number.MAX_SAFE_INTEGER
    })
    expect(completed, completed.message).toMatchObject({ status: 'completed' })
    expect(markCanonicalKunRuntimeMigrationRuntimeVerified(
      fixture.userDataPath,
      ['thread-v3-proof'],
      { homeDir: fixture.homeDir, now: () => NOW }
    )).toMatchObject({
      status: 'incomplete',
      missingThreadIds: ['thread-late']
    })
  })

  it.each(['candidate-verified', 'legacy-link-backed-up'] as const)(
    'offers the v3 proof produced while reconstructing v2 history in phase %s',
    async (phase) => {
      const fixture = makeFixture()
      const current = canonicalCurrentKunDataDir(fixture.homeDir)
      const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
      seedRuntimeStore(current, 'v2-proof')
      mkdirSync(join(fixture.homeDir, '.deepseekgui'), { recursive: true })
      symlinkSync(current, legacy)
      mkdirSync(fixture.userDataPath, { recursive: true })
      writeFileSync(
        join(fixture.userDataPath, 'kun-runtime-data-migration-v2.json'),
        `${JSON.stringify(canonicalCompletedV2Journal(legacy, current, ['thread-v2-proof']))}\n`
      )
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
      if (existsSync(legacy)) rmSync(legacy, { recursive: true, force: true })
      rmSync(current, { recursive: true, force: true })

      const status = await fixture.recovery.getStatus()

      expect(status.state).toBe('candidate-ready')
      expect(status.candidates).toHaveLength(1)
      expect(status.candidates[0]).toMatchObject({
        kind: 'staging',
        journalVerified: true
      })
    }
  )

  it.each(['fingerprint', 'activation-fingerprint', 'inventory', 'thread-identity'] as const)(
    'rejects a v3 staging proof with %s drift',
    async (drift) => {
      const fixture = makeFixture()
      const interrupted = interruptOriginalHistoryMigration(fixture, 'candidate-verified')
      rmSync(interrupted.sourcePath, { recursive: true, force: true })
      const journal = JSON.parse(readFileSync(interrupted.journalPath, 'utf8'))
      if (drift === 'fingerprint') {
        journal.candidateFingerprint = '0'.repeat(64)
      } else if (drift === 'activation-fingerprint') {
        journal.activationFingerprint = 'not-a-sha256'
      } else if (drift === 'inventory') {
        journal.sourceInventory.bytes += 1
      } else {
        journal.sourceThreadIds = ['thread-not-present']
      }
      writeFileSync(interrupted.journalPath, `${JSON.stringify(journal)}\n`)

      const status = await fixture.recovery.getStatus()

      expect(status).toMatchObject({ state: 'start-over-required', candidates: [] })
      expect(status.invalidEvidenceCount).toBeGreaterThanOrEqual(1)
    }
  )

  it('rejects an otherwise complete staging proof with a non-canonical path', async () => {
    const fixture = makeFixture()
    const interrupted = interruptOriginalHistoryMigration(fixture, 'candidate-verified')
    rmSync(interrupted.sourcePath, { recursive: true, force: true })
    const journal = JSON.parse(readFileSync(interrupted.journalPath, 'utf8'))
    journal.stagingPath = join(fixture.homeDir, 'untrusted', 'staging')
    writeFileSync(interrupted.journalPath, `${JSON.stringify(journal)}\n`)

    const status = await fixture.recovery.getStatus()

    expect(status).toMatchObject({ state: 'start-over-required', candidates: [] })
    expect(status.invalidEvidenceCount).toBeGreaterThanOrEqual(1)
  })

  it('does not auto-select a verified migration staging copy when another history differs', async () => {
    const fixture = makeFixture()
    const interrupted = interruptOriginalHistoryMigration(fixture, 'candidate-verified')
    rmSync(interrupted.sourcePath, { recursive: true, force: true })
    seedRuntimeStore(
      join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`),
      'other-history'
    )

    const status = await fixture.recovery.getStatus()

    expect(status.state).toBe('selection-required')
    expect(status.candidates).toHaveLength(2)
    expect(status.candidates.some((candidate) => candidate.journalVerified)).toBe(true)
    expect(status.recommendedCandidateId).toBeUndefined()
  })

  it('revalidates the exact migration journal proof before restoring staging', async () => {
    const fixture = makeFixture()
    const interrupted = interruptOriginalHistoryMigration(fixture, 'candidate-verified')
    rmSync(interrupted.sourcePath, { recursive: true, force: true })
    const status = await fixture.recovery.getStatus()
    const journal = JSON.parse(readFileSync(interrupted.journalPath, 'utf8'))
    journal.updatedAt = new Date(NOW.getTime() + 1000).toISOString()
    writeFileSync(interrupted.journalPath, `${JSON.stringify(journal)}\n`)

    await expect(fixture.recovery.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.candidates[0].candidateId
    })).rejects.toMatchObject({ code: 'candidate_changed' })
    expect(existsSync(canonicalCurrentKunDataDir(fixture.homeDir))).toBe(false)
  })

  it('marks a fixed backup as journal-referenced without claiming verification', async () => {
    const fixture = makeFixture()
    const backup = join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`)
    seedRuntimeStore(backup, 'journal-backup')
    mkdirSync(fixture.userDataPath, { recursive: true })
    writeFileSync(join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json'), JSON.stringify({
      schemaVersion: 3,
      provenance: 'original-legacy-source',
      sourcePath: canonicalLegacyKunDataDir(fixture.homeDir),
      targetPath: canonicalCurrentKunDataDir(fixture.homeDir),
      destinationBackupPath: backup
    }))

    const status = await fixture.recovery.getStatus()

    expect(status.candidates[0]).toMatchObject({
      kind: 'backup',
      journalReferenced: true,
      journalVerified: false,
      recoveryVerified: false
    })
  })

  it('does not offer a candidate containing an escaping symlink', async () => {
    const fixture = makeFixture()
    const backup = join(fixture.homeDir, '.kun', `data.pre-history-preserving-migration-${STAMP}.bak`)
    mkdirSync(backup, { recursive: true })
    symlinkSync(tmpdir(), join(backup, 'outside'))

    const status = await fixture.recovery.getStatus()

    expect(status.state).toBe('start-over-required')
    expect(status.candidates).toEqual([])
    expect(status.invalidEvidenceCount).toBe(1)
  })

  it('keeps incomplete credential material recoverable but reports its scoped warning', async () => {
    const fixture = makeFixture()
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    seedRuntimeStore(legacy, 'history')
    mkdirSync(join(legacy, 'credentials'))

    const status = await fixture.recovery.getStatus()

    expect(status.candidates[0].credentialState).toBe('incomplete')
    expect(status.candidates[0].warnings.join(' ')).toMatch(/API key/)
  })

  it('treats a malformed no-legacy-source journal as historical evidence', async () => {
    const fixture = makeFixture()
    mkdirSync(canonicalCurrentKunDataDir(fixture.homeDir), { recursive: true })
    mkdirSync(fixture.userDataPath, { recursive: true })
    writeFileSync(join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json'), JSON.stringify({
      schemaVersion: 3,
      provenance: 'no-legacy-source',
      sourcePath: canonicalLegacyKunDataDir(fixture.homeDir),
      targetPath: canonicalCurrentKunDataDir(fixture.homeDir),
      sourceThreadIds: [],
      sourceInventory: { files: 0, directories: 0, symlinks: 0, bytes: 0 }
    }))
    writeFileSync(join(fixture.userDataPath, 'kun-runtime-data-migration-v3-report.json'), '{}')

    await expect(fixture.recovery.getStatus()).resolves.toMatchObject({
      state: 'start-over-required',
      historicalEvidence: true,
      candidates: []
    })
  })

  it('accepts only a complete matching no-history journal and report as a new install', async () => {
    const fixture = makeFixture()
    const current = canonicalCurrentKunDataDir(fixture.homeDir)
    const legacy = canonicalLegacyKunDataDir(fixture.homeDir)
    const staging = join(fixture.homeDir, '.kun', `data.history-preserving-staging-${STAMP}.bak`)
    mkdirSync(current, { recursive: true })
    mkdirSync(fixture.userDataPath, { recursive: true })
    const target = runtimeDataRecoveryInternals.fingerprintTree(current)
    const sourceFingerprint = createHash('sha256').update('no-legacy-source').digest('hex')
    const journal = {
      schemaVersion: 3,
      phase: 'completed',
      provenance: 'no-legacy-source',
      sourcePath: legacy,
      targetPath: current,
      stagingPath: staging,
      settingsBackupPaths: [],
      sourceThreadIds: [],
      sourceInventory: { files: 0, directories: 0, symlinks: 0, bytes: 0 },
      sourceFingerprint,
      candidateFingerprint: target.fingerprint,
      salvaged: 0,
      conflicts: [],
      targetInventory: target.inventory,
      sqliteQuickCheck: 'missing',
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: NOW.toISOString()
    }
    writeFileSync(
      join(fixture.userDataPath, 'kun-runtime-data-migration-v3.json'),
      `${JSON.stringify(journal)}\n`
    )
    writeFileSync(
      join(fixture.userDataPath, 'kun-runtime-data-migration-v3-report.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        status: 'completed',
        provenance: 'no-legacy-source',
        sourcePath: legacy,
        targetPath: current,
        stagingPath: staging,
        settingsBackupPaths: [],
        sourceThreadCount: 0,
        sourceInventory: journal.sourceInventory,
        sourceFingerprint,
        candidateFingerprint: target.fingerprint,
        salvaged: 0,
        conflicts: [],
        targetInventory: target.inventory,
        sqliteQuickCheck: 'missing',
        completedAt: NOW.toISOString(),
        exactPreMigrationSnapshot: true,
        sourceExisted: false
      })}\n`
    )

    await expect(fixture.recovery.getStatus()).resolves.toMatchObject({
      state: 'new-install',
      historicalEvidence: false,
      candidates: [],
      invalidEvidenceCount: 0
    })
  })

  it('offers recovery staging only when an exact verified-phase record matches it', async () => {
    const fixture = makeFixture()
    const staging = join(fixture.homeDir, '.kun', `data.runtime-recovery-staging-${STAMP}.bak`)
    seedRuntimeStore(staging, 'verified-staging')

    const withoutProof = await fixture.recovery.getStatus()
    expect(withoutProof).toMatchObject({ state: 'start-over-required', candidates: [] })

    const descriptor = runtimeDataRecoveryInternals.inspectCandidate(
      staging,
      'staging',
      process.platform
    )
    const operationId = randomUUID()
    const operationDir = join(fixture.userDataPath, 'kun-runtime-data-recovery-v1', operationId)
    mkdirSync(operationDir, { recursive: true })
    writeFileSync(join(operationDir, '020-verified.json'), JSON.stringify({
      schemaVersion: 1,
      operationId,
      phase: 'verified',
      action: 'restore',
      sourcePath: canonicalLegacyKunDataDir(fixture.homeDir),
      sourceFingerprint: descriptor.fingerprint,
      targetPath: canonicalCurrentKunDataDir(fixture.homeDir),
      stagingPath: staging,
      stagingFingerprint: descriptor.fingerprint,
      stagingInventory: descriptor.summary.inventory,
      blockedJournalEvidence: []
    }))

    const withProof = await fixture.recovery.refresh()
    expect(withProof).toMatchObject({ state: 'candidate-ready' })
    expect(withProof.candidates[0]).toMatchObject({
      kind: 'staging',
      recoveryVerified: true,
      journalVerified: false
    })
  })
})
