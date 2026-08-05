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

const NOW = new Date('2026-08-05T01:02:03.000Z')
const STAMP = '20260805T010203000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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

function makeFixture(options: {
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

function seedRuntimeStore(path: string, marker: string): void {
  const thread = join(path, 'threads', `thread-${marker}`)
  mkdirSync(thread, { recursive: true })
  writeFileSync(join(thread, 'events.jsonl'), `${marker}\n`)
  writeFileSync(join(path, 'marker.txt'), marker)
  writeFileSync(join(path, 'config.json'), '{"serve":{}}\n')
}

function interruptOriginalHistoryMigration(
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

function canonicalCompletedV2Journal(
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

function readMarker(path: string): string {
  return readFileSync(join(path, 'marker.txt'), 'utf8')
}
