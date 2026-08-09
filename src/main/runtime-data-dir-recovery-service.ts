import {
  mkdirSync,
  renameSync
} from 'node:fs'
import {
  randomBytes,
  randomUUID
} from 'node:crypto'
import {
  dirname
} from 'node:path'
import {
  RUNTIME_DATA_RECOVERY_SCHEMA_VERSION,
  type RuntimeDataRecoveryExecuteInput,
  RuntimeDataRecoveryExecuteInputSchema,
  type RuntimeDataRecoveryInventory,
  type RuntimeDataRecoveryStatus,
  RuntimeDataRecoveryStatusSchema
} from '../shared/runtime-data-recovery'
import {
  canonicalCurrentKunDataDir
} from './kun-data-dir-paths'
import {
  assertNoActiveKunRuntimeUsingDataDir
} from './runtime-data-dir-ownership'
import {
  type CandidateDescriptor,
  type RecoveryLogger,
  type RecoverySnapshot,
  type RuntimeDataDirRecoveryOptions,
  RuntimeDataRecoveryError
} from './runtime-data-dir-recovery-types'
import {
  discoverFixedCandidates,
  inspectKnownJournals
} from './runtime-data-dir-recovery-discovery'
import {
  copyRuntimeTree,
  inspectCandidate,
  revalidateCandidate
} from './runtime-data-dir-recovery-candidates'
import {
  beginRecoveryRecord,
  type RecoveryRecord,
  type RecoveryTargetIdentity,
  uniqueSiblingPath,
  writeRecoveryRecord,
  writeRecoveryRecordBestEffort,
  writeRecoveryTargetIdentityMarker
} from './runtime-data-dir-recovery-records'
import {
  coreInventory
} from './runtime-data-dir-recovery-acceptance'
import {
  candidateOpaqueId,
  compareCandidatePreference,
  fsyncDirectoryBestEffort,
  inventoriesEqual,
  isEmptyInventory,
  pathKey,
  pathState,
  samePath,
  toRecoveryError
} from './runtime-data-dir-recovery-utils'



export class RuntimeDataDirRecovery {
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly log: RecoveryLogger
  private readonly assertRuntimeInactive: (dataDir: string) => void
  private readonly hmacSecret = randomBytes(32)
  private snapshot: RecoverySnapshot | null = null
  private operationActive = false

  constructor(private readonly options: RuntimeDataDirRecoveryOptions) {
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => undefined)
    this.assertRuntimeInactive = options.assertRuntimeInactive ??
      ((dataDir) => assertNoActiveKunRuntimeUsingDataDir(dataDir))
  }

  async getStatus(): Promise<RuntimeDataRecoveryStatus> {
    return this.currentSnapshot().status
  }

  async refresh(): Promise<RuntimeDataRecoveryStatus> {
    if (this.operationActive) {
      throw new RuntimeDataRecoveryError('action_not_allowed', 'Recovery is already in progress.')
    }
    this.snapshot = this.scan()
    return this.snapshot.status
  }

  async recoverAutomaticallyIfSafe(): Promise<RuntimeDataRecoveryStatus | null> {
    // Automatic recovery is a provenance decision, so never reuse a snapshot
    // that may have been rendered before another migration attempt finished.
    const status = await this.refresh()
    if (status.state !== 'candidate-ready' || !status.recommendedCandidateId) return null
    return this.execute({
      action: 'restore',
      generation: status.generation,
      candidateId: status.recommendedCandidateId
    })
  }

  async execute(raw: RuntimeDataRecoveryExecuteInput): Promise<RuntimeDataRecoveryStatus> {
    const input = RuntimeDataRecoveryExecuteInputSchema.parse(raw)
    if (this.operationActive) {
      throw new RuntimeDataRecoveryError('action_not_allowed', 'Recovery is already in progress.')
    }
    const snapshot = this.currentSnapshot()
    this.assertCurrentGeneration(snapshot, input.generation)
    this.assertActionAllowed(snapshot.status, input)
    snapshot.consumed = true
    this.operationActive = true
    snapshot.status = { ...snapshot.status, state: 'recovering', message: 'Recovery is in progress.' }
    try {
      if (input.action === 'restore') {
        const descriptor = snapshot.descriptors.get(input.candidateId)
        if (!descriptor) {
          throw new RuntimeDataRecoveryError('candidate_unknown', 'The recovery candidate is no longer available.')
        }
        this.restoreCandidate(descriptor)
      } else {
        this.activateEmptyStore(input.action)
      }
      snapshot.status = {
        ...snapshot.status,
        state: 'completed',
        message: 'Runtime data recovery completed. Kun can now restart.'
      }
      return snapshot.status
    } catch (error) {
      this.log('Runtime data recovery failed.', error)
      const publicError = toRecoveryError(error)
      this.snapshot = this.scan()
      this.snapshot.status = {
        ...this.snapshot.status,
        message: publicError.message
      }
      throw publicError
    } finally {
      this.operationActive = false
    }
  }

  private currentSnapshot(): RecoverySnapshot {
    if (!this.snapshot) this.snapshot = this.scan()
    return this.snapshot
  }

  private scan(): RecoverySnapshot {
    try {
      const generation = randomUUID()
      const journalInspection = inspectKnownJournals(this.options, this.platform)
      const discovered = discoverFixedCandidates(this.options.homeDir, this.platform)
      let historicalEvidence = journalInspection.historicalEvidence
      let invalidEvidenceCount = journalInspection.invalidEvidenceCount
      const inspected: CandidateDescriptor[] = []
      for (const source of discovered) {
        if (source.evidence) historicalEvidence = true
        if (source.state === 'missing') continue
        if (source.state !== 'directory') {
          invalidEvidenceCount += 1
          continue
        }
        try {
          const descriptor = inspectCandidate(source.path, source.kind, this.platform)
          if (isEmptyInventory(descriptor.summary.inventory)) continue
          const key = pathKey(source.path, this.platform)
          if (journalInspection.journalReferencedPaths.has(key)) {
            descriptor.summary.journalReferenced = true
          }
          const recoveryVerified = journalInspection.recoveryVerifiedPaths.get(key)
          let recoveryRecordMatches = false
          if (recoveryVerified) {
            if (
              descriptor.fingerprint === recoveryVerified.fingerprint &&
              inventoriesEqual(descriptor.summary.inventory, recoveryVerified.inventory)
            ) {
              recoveryRecordMatches = true
              descriptor.summary.recoveryVerified = true
              descriptor.automaticRestoreSafe = true
            } else {
              invalidEvidenceCount += 1
            }
          }
          const journalVerified = journalInspection.journalVerifiedPaths.get(key)
          let migrationJournalMatches = false
          if (journalVerified) {
            if (
              descriptor.fingerprint === journalVerified.fingerprint &&
              inventoriesEqual(descriptor.summary.inventory, journalVerified.inventory)
            ) {
              migrationJournalMatches = true
              descriptor.summary.journalVerified = true
              descriptor.journalVerification = journalVerified
              descriptor.automaticRestoreSafe = true
            } else {
              invalidEvidenceCount += 1
            }
          }
          if (source.kind === 'staging' && !recoveryRecordMatches && !migrationJournalMatches) {
            // A staging directory is an in-flight copy, not historical
            // authority. Without an exact recovery record or a fully validated
            // migration candidate fingerprint there is no sound way for Main
            // or the user to distinguish a complete snapshot from a
            // crash-truncated tree.
            if (!recoveryVerified && !journalVerified) invalidEvidenceCount += 1
            historicalEvidence = true
            continue
          }
          inspected.push(descriptor)
          historicalEvidence = true
        } catch (error) {
          invalidEvidenceCount += 1
          this.log('Ignored an invalid Runtime recovery candidate.', error)
        }
      }

      const groups = new Map<string, CandidateDescriptor[]>()
      for (const descriptor of inspected) {
        const group = groups.get(descriptor.fingerprint) ?? []
        group.push(descriptor)
        groups.set(descriptor.fingerprint, group)
      }
      const descriptors = new Map<string, CandidateDescriptor>()
      const candidateGroups = [...groups.values()]
        .map((copies) => copies.sort(compareCandidatePreference))
        .sort((left, right) => compareCandidatePreference(left[0], right[0]))
        .slice(0, 100)
        .map((copies) => {
          const descriptor = copies.find((copy) => copy.automaticRestoreSafe) ?? copies[0]
          const candidateId = candidateOpaqueId(this.hmacSecret, generation, descriptor)
          descriptors.set(candidateId, descriptor)
          return {
            automaticRestoreSafe: copies.some((copy) => copy.automaticRestoreSafe),
            candidate: {
              candidateId,
              ...descriptor.summary,
              equivalentCopies: copies.length
            }
          }
        })
      const candidates = candidateGroups.map(({ candidate }) => candidate)
      if (groups.size > 100) invalidEvidenceCount += groups.size - 100

      const soleCandidateIsSafe = candidateGroups.length === 1 &&
        candidateGroups[0].automaticRestoreSafe
      const state = candidates.length === 0
        ? historicalEvidence ? 'start-over-required' : 'new-install'
        : soleCandidateIsSafe ? 'candidate-ready' : 'selection-required'
      const warnings: string[] = []
      if (invalidEvidenceCount > 0) {
        warnings.push(
          `${invalidEvidenceCount} preserved item(s) could not be validated and were not offered for recovery.`
        )
      }
      const status = RuntimeDataRecoveryStatusSchema.parse({
        schemaVersion: RUNTIME_DATA_RECOVERY_SCHEMA_VERSION,
        generation,
        state,
        historicalEvidence,
        candidates,
        ...(soleCandidateIsSafe ? { recommendedCandidateId: candidates[0].candidateId } : {}),
        invalidEvidenceCount,
        warnings
      })
      return { generation, descriptors, status, consumed: false }
    } catch (error) {
      throw new RuntimeDataRecoveryError(
        'scan_failed',
        'Kun could not safely inspect preserved Runtime data.',
        { cause: error }
      )
    }
  }

  private assertCurrentGeneration(snapshot: RecoverySnapshot, generation: string): void {
    if (snapshot.consumed || generation !== snapshot.generation) {
      throw new RuntimeDataRecoveryError(
        'generation_expired',
        'The recovery inventory changed. Reload it before continuing.'
      )
    }
  }

  private assertActionAllowed(
    status: RuntimeDataRecoveryStatus,
    input: RuntimeDataRecoveryExecuteInput
  ): void {
    if (input.action === 'restore') {
      if (status.state !== 'candidate-ready' && status.state !== 'selection-required') {
        throw new RuntimeDataRecoveryError('action_not_allowed', 'No validated recovery candidate is available.')
      }
      return
    }
    if (input.action === 'initialize-new-install') {
      if (status.state !== 'new-install' || status.historicalEvidence || status.candidates.length > 0) {
        throw new RuntimeDataRecoveryError(
          'action_not_allowed',
          'Empty initialization is only allowed when no historical evidence exists.'
        )
      }
      return
    }
    if (
      status.state !== 'start-over-required' ||
      !status.historicalEvidence ||
      status.candidates.length > 0
    ) {
      throw new RuntimeDataRecoveryError(
        'action_not_allowed',
        'Starting over requires historical evidence with no recoverable candidate.'
      )
    }
  }

  private restoreCandidate(descriptor: CandidateDescriptor): void {
    revalidateCandidate(descriptor, this.platform, this.options)
    const targetPath = canonicalCurrentKunDataDir(this.options.homeDir, this.platform)
    this.assertInactive(descriptor.path)
    if (!samePath(descriptor.path, targetPath, this.platform)) this.assertInactive(targetPath)

    const operation = beginRecoveryRecord(this.options.userDataPath, this.now, {
      action: 'restore',
      sourcePath: descriptor.path,
      sourceFingerprint: descriptor.fingerprint,
      targetPath
    })
    const stagingPath = uniqueSiblingPath(targetPath, 'runtime-recovery-staging', this.now)
    const destinationBackupPath = pathState(targetPath) === 'missing'
      ? undefined
      : uniqueSiblingPath(targetPath, 'pre-runtime-recovery', this.now)
    writeRecoveryRecord(operation, 10, 'prepared', {
      stagingPath,
      destinationBackupPath
    })
    try {
      copyRuntimeTree(descriptor.path, stagingPath)
    } catch (error) {
      writeRecoveryRecordBestEffort(operation, 90, 'failed', { code: 'copy_failed' })
      throw new RuntimeDataRecoveryError('copy_failed', 'The preserved Runtime data could not be copied safely.', {
        cause: error
      })
    }
    const staged = inspectCandidate(stagingPath, 'staging', this.platform)
    const sourceAfterCopy = inspectCandidate(descriptor.path, descriptor.summary.kind, this.platform)
    if (
      staged.fingerprint !== descriptor.fingerprint ||
      sourceAfterCopy.fingerprint !== descriptor.fingerprint ||
      !inventoriesEqual(staged.summary.inventory, descriptor.summary.inventory)
    ) {
      writeRecoveryRecordBestEffort(operation, 90, 'failed', { code: 'verification_failed' })
      throw new RuntimeDataRecoveryError(
        'verification_failed',
        'The recovery copy did not match the selected preserved data.'
      )
    }
    writeRecoveryRecord(operation, 20, 'verified', {
      stagingFingerprint: staged.fingerprint,
      stagingInventory: staged.summary.inventory
    })
    const targetIdentity = writeRecoveryTargetIdentityMarker(operation, stagingPath)
    const activation = inspectCandidate(stagingPath, 'staging', this.platform)
    this.cutOver(
      operation,
      targetPath,
      stagingPath,
      destinationBackupPath,
      activation.fingerprint,
      activation.summary.inventory,
      targetIdentity
    )
  }

  private activateEmptyStore(action: 'initialize-new-install' | 'start-over'): void {
    const targetPath = canonicalCurrentKunDataDir(this.options.homeDir, this.platform)
    this.assertInactive(targetPath)
    const operation = beginRecoveryRecord(this.options.userDataPath, this.now, {
      action,
      targetPath,
      historicalEvidencePreserved: action === 'start-over'
    })
    const stagingPath = uniqueSiblingPath(targetPath, 'runtime-recovery-staging', this.now)
    const destinationBackupPath = pathState(targetPath) === 'missing'
      ? undefined
      : uniqueSiblingPath(targetPath, 'pre-runtime-recovery', this.now)
    mkdirSync(dirname(stagingPath), { recursive: true, mode: 0o700 })
    mkdirSync(stagingPath, { mode: 0o700 })
    fsyncDirectoryBestEffort(stagingPath)
    writeRecoveryRecord(operation, 10, 'prepared', { stagingPath, destinationBackupPath })
    const targetIdentity = writeRecoveryTargetIdentityMarker(operation, stagingPath)
    const staged = inspectCandidate(stagingPath, 'staging', this.platform)
    this.cutOver(
      operation,
      targetPath,
      stagingPath,
      destinationBackupPath,
      staged.fingerprint,
      staged.summary.inventory,
      targetIdentity
    )
  }

  private cutOver(
    operation: RecoveryRecord,
    targetPath: string,
    stagingPath: string,
    destinationBackupPath: string | undefined,
    expectedFingerprint: string,
    expectedInventory: RuntimeDataRecoveryInventory,
    targetIdentity: RecoveryTargetIdentity
  ): void {
    let targetBackedUp = false
    let targetActivated = false
    try {
      if (destinationBackupPath) {
        renameSync(targetPath, destinationBackupPath)
        fsyncDirectoryBestEffort(dirname(targetPath))
        targetBackedUp = true
        writeRecoveryRecord(operation, 30, 'destination-backed-up', { destinationBackupPath })
      }
      renameSync(stagingPath, targetPath)
      targetActivated = true
      fsyncDirectoryBestEffort(dirname(targetPath))
      this.options.afterTargetActivated?.(targetPath)
      const target = inspectCandidate(targetPath, 'current', this.platform)
      if (
        target.fingerprint !== expectedFingerprint ||
        !inventoriesEqual(target.summary.inventory, expectedInventory)
      ) {
        throw new RuntimeDataRecoveryError(
          'verification_failed',
          'The activated Runtime data no longer matches the verified recovery copy.'
        )
      }
      writeRecoveryRecord(operation, 40, 'completed', {
        targetFingerprint: target.fingerprint,
        targetInventory: coreInventory(target.summary.inventory),
        targetIdentityMarkerName: targetIdentity.name,
        targetIdentityMarkerDigest: targetIdentity.digest,
        destinationBackupPath
      })
    } catch (error) {
      if (
        targetActivated &&
        pathState(targetPath) !== 'missing' &&
        pathState(stagingPath) === 'missing'
      ) {
        try {
          renameSync(targetPath, stagingPath)
          fsyncDirectoryBestEffort(dirname(targetPath))
          targetActivated = false
        } catch (rollbackError) {
          this.log('Runtime data recovery could not preserve the uncommitted target.', rollbackError)
        }
      }
      if (targetBackedUp && destinationBackupPath && pathState(targetPath) === 'missing') {
        try {
          renameSync(destinationBackupPath, targetPath)
          fsyncDirectoryBestEffort(dirname(targetPath))
          writeRecoveryRecordBestEffort(operation, 80, 'rolled-back', {})
        } catch (rollbackError) {
          this.log('Runtime data recovery rollback failed.', rollbackError)
        }
      }
      writeRecoveryRecordBestEffort(operation, 90, 'failed', { code: 'cutover_failed' })
      throw new RuntimeDataRecoveryError(
        'cutover_failed',
        'Kun could not atomically activate the recovered Runtime data.',
        { cause: error }
      )
    }
  }

  private assertInactive(path: string): void {
    try {
      this.assertRuntimeInactive(path)
    } catch (error) {
      throw new RuntimeDataRecoveryError(
        'active_writer',
        'A Kun Runtime is still using preserved data. Stop it before recovery.',
        { cause: error }
      )
    }
  }
}
