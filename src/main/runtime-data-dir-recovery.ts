import {
  constants,
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RUNTIME_DATA_RECOVERY_SCHEMA_VERSION,
  RuntimeDataRecoveryExecuteInputSchema,
  RuntimeDataRecoveryInventorySchema,
  RuntimeDataRecoveryStatusSchema,
  type RuntimeDataRecoveryCandidate,
  type RuntimeDataRecoveryCandidateKind,
  type RuntimeDataRecoveryCredentialState,
  type RuntimeDataRecoveryExecuteInput,
  type RuntimeDataRecoveryInventory,
  type RuntimeDataRecoveryStatus
} from '../shared/runtime-data-recovery'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import { assertNoActiveKunRuntimeUsingDataDir } from './runtime-data-dir-ownership'
import { settingsReadCandidates } from './settings-file-paths'

const V2_JOURNAL = 'kun-runtime-data-migration-v2.json'
const V2_REPORT = 'kun-runtime-data-migration-v2-report.json'
const V3_JOURNAL = 'kun-runtime-data-migration-v3.json'
const V3_REPORT = 'kun-runtime-data-migration-v3-report.json'
const RECOVERY_RECORD_DIR = 'kun-runtime-data-recovery-v1'
const RECOVERY_TARGET_IDENTITY_PREFIX = '.kun-runtime-recovery-identity-'
const PROTECTED_IDENTITY_ENTRIES = [
  'credentials',
  'mcp-oauth',
  'extensions/providers.json',
  'extensions/accounts.json',
  'extensions/provider-bindings.json',
  'extensions/legacy-credential-migrations.json',
  'secret.key'
] as const
const JSON_IDENTITY_ENTRIES = PROTECTED_IDENTITY_ENTRIES.filter((entry) => entry.endsWith('.json'))
const MIGRATION_STAMP = '\\d{8}T\\d{9}Z(?:-\\d+)?'
const CURRENT_SIBLING_PATTERN = new RegExp(
  `^data\\.(?:pre-deepseekgui-migration|history-preserving-staging|` +
  `pre-history-preserving-migration|runtime-recovery-staging|pre-runtime-recovery)-` +
  `${MIGRATION_STAMP}\\.bak$`,
  'i'
)
const LEGACY_SIBLING_PATTERN = new RegExp(
  `^kun\\.(?:cutover-conflict|history-preserving-staging|` +
  `pre-preservation-compatibility-link)-${MIGRATION_STAMP}\\.bak$`,
  'i'
)

type PathState = 'missing' | 'directory' | 'symlink' | 'file' | 'other' | 'inaccessible'

type CandidateDescriptor = {
  path: string
  realPath: string
  device: bigint | number
  inode: bigint | number
  fingerprint: string
  automaticRestoreSafe: boolean
  journalVerification?: MigrationJournalVerifiedCandidate
  summary: Omit<RuntimeDataRecoveryCandidate, 'candidateId' | 'equivalentCopies'>
}

type RecoveryVerifiedCandidate = {
  fingerprint: string
  inventory: RuntimeDataRecoveryInventory
}

type MigrationJournalVerifiedCandidate = RecoveryVerifiedCandidate & {
  journalPath: string
  journalDigest: string
  sourceThreadIds: string[]
}

type RecoveryEvidenceInspection = {
  historicalEvidence: boolean
  invalidEvidenceCount: number
  journalReferencedPaths: Set<string>
  journalVerifiedPaths: Map<string, MigrationJournalVerifiedCandidate>
  recoveryVerifiedPaths: Map<string, RecoveryVerifiedCandidate>
}

type RecoverySnapshot = {
  generation: string
  descriptors: Map<string, CandidateDescriptor>
  status: RuntimeDataRecoveryStatus
  consumed: boolean
}

type RecoveryLogger = (message: string, detail?: unknown) => void

export type RuntimeDataDirRecoveryOptions = {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
  now?: () => Date
  log?: RecoveryLogger
  assertRuntimeInactive?: (dataDir: string) => void
  /** Deterministic crash/race injection used by native and unit recovery tests. */
  afterTargetActivated?: (targetPath: string) => void
}

export type RuntimeDataRecoveryCompletionCheck =
  | { status: 'none' }
  | {
      status: 'invalid'
      reason: 'record_root_invalid' | 'marker_invalid' | 'target_changed' | 'journal_changed'
    }
  | {
      status: 'valid'
      operationId: string
      action: 'restore' | 'initialize-new-install' | 'start-over'
      completedAt: string
      targetFingerprint: string
      targetIdentityMarkerName: string
      targetIdentityMarkerDigest: string
      supersedesBlockedJournals: boolean
      preservedJournalVersions: Array<2 | 3>
    }

export type RuntimeDataRecoveryAcceptanceCheck =
  | { status: 'none' }
  | {
      status: 'invalid'
      reason:
        | 'completion_missing'
        | 'completion_invalid'
        | 'accepted_record_invalid'
        | 'journal_changed'
        | 'target_changed'
        | 'target_unavailable'
    }
  | {
      status: 'valid'
      operationId: string
      action: 'restore' | 'initialize-new-install' | 'start-over'
      acceptedAt: string
      preservedJournalVersions: Array<2 | 3>
    }

export type RuntimeDataRecoveryErrorCode =
  | 'generation_expired'
  | 'candidate_unknown'
  | 'candidate_changed'
  | 'action_not_allowed'
  | 'active_writer'
  | 'scan_failed'
  | 'copy_failed'
  | 'verification_failed'
  | 'cutover_failed'

export class RuntimeDataRecoveryError extends Error {
  constructor(
    readonly code: RuntimeDataRecoveryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RuntimeDataRecoveryError'
  }
}

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

type DiscoveredPath = {
  path: string
  kind: RuntimeDataRecoveryCandidateKind
  state: PathState
  evidence: boolean
}

function discoverFixedCandidates(homeDir: string, platform: NodeJS.Platform): DiscoveredPath[] {
  const current = canonicalCurrentKunDataDir(homeDir, platform)
  const legacy = canonicalLegacyKunDataDir(homeDir, platform)
  const result: DiscoveredPath[] = [
    discovered(current, 'current', false),
    discovered(legacy, 'legacy', false)
  ]
  for (const [parent, pattern] of [
    [dirname(current), CURRENT_SIBLING_PATTERN],
    [dirname(legacy), LEGACY_SIBLING_PATTERN]
  ] as const) {
    let names: string[] = []
    try {
      names = readdirSync(parent).sort()
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') result.push({ path: parent, kind: 'backup', state: 'inaccessible', evidence: true })
      continue
    }
    for (const name of names) {
      if (!pattern.test(name)) continue
      const kind: RuntimeDataRecoveryCandidateKind = name.includes('staging') ? 'staging' : 'backup'
      result.push(discovered(join(parent, name), kind, true))
    }
  }
  return result
}

function discovered(path: string, kind: RuntimeDataRecoveryCandidateKind, namedEvidence: boolean): DiscoveredPath {
  const state = pathState(path)
  let evidence = namedEvidence && state !== 'missing'
  if ((kind === 'current' || kind === 'legacy') && state !== 'missing' && state !== 'directory') {
    evidence = true
  }
  if ((kind === 'current' || kind === 'legacy') && state === 'directory') {
    try {
      evidence = readdirSync(path).length > 0
    } catch {
      evidence = true
    }
  }
  return { path, kind, state, evidence }
}

function inspectKnownJournals(
  options: Pick<RuntimeDataDirRecoveryOptions, 'homeDir' | 'userDataPath'>,
  platform: NodeJS.Platform
): RecoveryEvidenceInspection {
  const journalReferencedPaths = new Set<string>()
  const journalVerifiedPaths = new Map<string, MigrationJournalVerifiedCandidate>()
  let historicalEvidence = false
  let invalidEvidenceCount = 0
  let v3ProvesNoHistory = false
  const current = canonicalCurrentKunDataDir(options.homeDir, platform)
  const legacy = canonicalLegacyKunDataDir(options.homeDir, platform)
  const v2ReportExists = pathState(join(options.userDataPath, V2_REPORT)) !== 'missing'
  const v3ReportExists = pathState(join(options.userDataPath, V3_REPORT)) !== 'missing'
  if (v2ReportExists) historicalEvidence = true
  const recoveryRecords = join(options.userDataPath, RECOVERY_RECORD_DIR)
  if (pathState(recoveryRecords) !== 'missing') {
    const completion = validateRuntimeDataRecoveryCompletion({
      homeDir: options.homeDir,
      userDataPath: options.userDataPath,
      platform
    })
    if (
      completion.status !== 'valid' ||
      completion.action !== 'initialize-new-install' ||
      completion.supersedesBlockedJournals
    ) {
      historicalEvidence = true
    }
  }
  const recoveryInspection = inspectRecoveryVerifiedCandidates(
    options.userDataPath,
    current,
    legacy,
    platform
  )
  invalidEvidenceCount += recoveryInspection.invalidEvidenceCount

  for (const [name, version] of [[V2_JOURNAL, 2], [V3_JOURNAL, 3]] as const) {
    const journalPath = join(options.userDataPath, name)
    const state = pathState(journalPath)
    if (state === 'missing') continue
    if (state !== 'file') {
      historicalEvidence = true
      invalidEvidenceCount += 1
      continue
    }
    try {
      const journalRaw = readBoundedFile(journalPath, 4 * 1024 * 1024)
      const parsed = JSON.parse(journalRaw) as unknown
      if (!isObject(parsed)) throw new Error('journal is not an object')
      const value = parsed
      if (value.schemaVersion !== version || !samePath(String(value.targetPath ?? ''), current, platform)) {
        throw new Error('invalid journal identity')
      }
      const source = String(value.sourcePath ?? '')
      if (!samePath(source, legacy, platform) && !samePath(source, current, platform)) {
        throw new Error('invalid journal source')
      }
      const claimsNoHistory = version === 3 && value.provenance === 'no-legacy-source'
      if (claimsNoHistory) {
        v3ProvesNoHistory = completedNoHistoryEvidenceIsConsistent({
          journal: value,
          reportPath: join(options.userDataPath, V3_REPORT),
          current,
          legacy,
          platform
        })
        if (!v3ProvesNoHistory) {
          historicalEvidence = true
          invalidEvidenceCount += 1
        }
      } else {
        historicalEvidence = true
      }
      const pathValues = version === 2
        ? [value.destinationBackupPath, ...(Array.isArray(value.cutoverConflictBackupPaths) ? value.cutoverConflictBackupPaths : [])]
        : [value.stagingPath, value.destinationBackupPath, value.compatibilityLinkBackupPath]
      for (const candidate of pathValues) {
        if (typeof candidate !== 'string') continue
        if (!isRecognizedFixedPath(candidate, current, legacy, platform)) {
          throw new Error('journal contains an unrecognized path')
        }
        // A path reference alone proves neither the migration phase nor the
        // bytes present at that path. Keep this informational and never use it
        // to admit a staging directory or to authorize automatic recovery.
        journalReferencedPaths.add(pathKey(candidate, platform))
      }
      // Schema v2 records a rename/link state machine and has no staging path
      // or candidate fingerprint, so it can never authorize staging by itself.
      // Its v2-history reconstruction is recoverable only after schema v3 has
      // durably recorded the copied candidate and exact fingerprint.
      if (version === 3 && migrationJournalPhaseCanProveStaging(value)) {
        const proof = inspectMigrationJournalVerifiedCandidate({
          journal: value,
          journalPath,
          journalRaw,
          userDataPath: options.userDataPath,
          current,
          legacy,
          platform
        })
        if (!proof) throw new Error('migration staging proof is incomplete or inconsistent')
        const key = pathKey(String(value.stagingPath), platform)
        const existing = journalVerifiedPaths.get(key)
        if (
          existing &&
          (
            existing.fingerprint !== proof.fingerprint ||
            !inventoriesEqual(existing.inventory, proof.inventory) ||
            existing.journalDigest !== proof.journalDigest
          )
        ) {
          journalVerifiedPaths.delete(key)
          throw new Error('conflicting migration staging proofs')
        }
        journalVerifiedPaths.set(key, proof)
      }
    } catch {
      historicalEvidence = true
      invalidEvidenceCount += 1
    }
  }
  if (v3ReportExists && !v3ProvesNoHistory) historicalEvidence = true
  return {
    historicalEvidence,
    invalidEvidenceCount,
    journalReferencedPaths,
    journalVerifiedPaths,
    recoveryVerifiedPaths: recoveryInspection.paths
  }
}

const MIGRATION_STAGING_PROOF_PHASES = new Set([
  'candidate-verified',
  'candidate-rebased',
  'destination-backed-up',
  'destination-salvaged',
  'legacy-link-backed-up'
])

function migrationJournalPhaseCanProveStaging(
  journal: Record<string, unknown>
): boolean {
  return typeof journal.phase === 'string' &&
    MIGRATION_STAGING_PROOF_PHASES.has(journal.phase)
}

function inspectMigrationJournalVerifiedCandidate(input: {
  journal: Record<string, unknown>
  journalPath: string
  journalRaw: string
  userDataPath: string
  current: string
  legacy: string
  platform: NodeJS.Platform
}): MigrationJournalVerifiedCandidate | null {
  const { journal, current, legacy, platform } = input
  const phase = journal.phase
  const provenance = journal.provenance
  if (
    journal.schemaVersion !== 3 ||
    typeof phase !== 'string' ||
    !MIGRATION_STAGING_PROOF_PHASES.has(phase) ||
    (provenance !== 'original-legacy-source' && provenance !== 'reconstructed-from-current') ||
    (journal.mergeIntoCurrent !== undefined && journal.mergeIntoCurrent !== false)
  ) {
    return null
  }

  const reconstructingV2History = provenance === 'reconstructed-from-current'
  const expectedSource = reconstructingV2History ? current : legacy
  const stagingOriginal = reconstructingV2History ? legacy : current
  const stagingPath = journal.stagingPath
  if (
    typeof journal.sourcePath !== 'string' ||
    !samePath(journal.sourcePath, expectedSource, platform) ||
    typeof journal.targetPath !== 'string' ||
    !samePath(journal.targetPath, current, platform) ||
    typeof stagingPath !== 'string' ||
    !isMigrationOwnedSiblingPath(
      stagingPath,
      stagingOriginal,
      'history-preserving-staging',
      platform
    ) ||
    (
      journal.destinationBackupPath !== undefined &&
      (
        reconstructingV2History ||
        typeof journal.destinationBackupPath !== 'string' ||
        !isMigrationOwnedSiblingPath(
          journal.destinationBackupPath,
          current,
          'pre-history-preserving-migration',
          platform
        )
      )
    ) ||
    (
      journal.compatibilityLinkBackupPath !== undefined &&
      (
        !reconstructingV2History ||
        typeof journal.compatibilityLinkBackupPath !== 'string' ||
        !isMigrationOwnedSiblingPath(
          journal.compatibilityLinkBackupPath,
          legacy,
          'pre-preservation-compatibility-link',
          platform
        )
      )
    ) ||
    !migrationSettingsPathsAreCanonical(journal, input.userDataPath, platform)
  ) {
    return null
  }

  const isReconstructionPhase = phase === 'candidate-verified' || phase === 'legacy-link-backed-up'
  if (
    (reconstructingV2History && !isReconstructionPhase) ||
    (!reconstructingV2History && phase === 'legacy-link-backed-up') ||
    (
      (phase === 'candidate-rebased' ||
        phase === 'destination-backed-up' ||
        phase === 'destination-salvaged') &&
      (!Number.isSafeInteger(journal.extensionRegistryRebasedRecords) ||
        Number(journal.extensionRegistryRebasedRecords) < 0)
    ) ||
    (
      (phase === 'candidate-verified' || phase === 'legacy-link-backed-up') &&
      journal.extensionRegistryRebasedRecords !== undefined
    )
  ) {
    return null
  }

  const sourceInventory = parseCoreInventory(journal.sourceInventory)
  const sourceThreadIds = journal.sourceThreadIds
  const sourceFingerprint = journal.sourceFingerprint
  const candidateFingerprint = journal.candidateFingerprint
  const activationFingerprint = journal.activationFingerprint
  if (
    !sourceInventory ||
    !isCanonicalStringArray(sourceThreadIds) ||
    typeof sourceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
    candidateFingerprint !== sourceFingerprint ||
    (
      activationFingerprint !== undefined &&
      (
        typeof activationFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(activationFingerprint)
      )
    ) ||
    !Number.isSafeInteger(journal.salvaged) ||
    Number(journal.salvaged) < 0 ||
    !isStringArray(journal.conflicts) ||
    !validRecordedDate(journal.startedAt) ||
    !validRecordedDate(journal.updatedAt) ||
    journal.completedAt !== undefined ||
    journal.runtimeVerifiedAt !== undefined ||
    journal.targetInventory !== undefined ||
    journal.sqliteQuickCheck !== undefined ||
    (journal.error !== undefined && typeof journal.error !== 'string')
  ) {
    return null
  }

  let descriptor: CandidateDescriptor
  try {
    descriptor = inspectCandidate(stagingPath, 'staging', platform)
  } catch {
    return null
  }
  const actualThreadIds = runtimeThreadIds(stagingPath)
  if (
    descriptor.fingerprint !== candidateFingerprint ||
    !coreInventoriesEqual(coreInventory(descriptor.summary.inventory), sourceInventory) ||
    !stringArraysEqual(actualThreadIds, sourceThreadIds)
  ) {
    return null
  }

  return {
    fingerprint: descriptor.fingerprint,
    inventory: descriptor.summary.inventory,
    journalPath: input.journalPath,
    journalDigest: createHash('sha256').update(input.journalRaw).digest('hex'),
    sourceThreadIds: [...sourceThreadIds]
  }
}

function migrationSettingsPathsAreCanonical(
  journal: Record<string, unknown>,
  userDataPath: string,
  platform: NodeJS.Platform
): boolean {
  const sourcePath = journal.settingsSourcePath
  const writePath = journal.settingsWritePath
  const backupPaths = journal.settingsBackupPaths
  if (
    (sourcePath !== undefined && typeof sourcePath !== 'string') ||
    (writePath !== undefined && typeof writePath !== 'string') ||
    !isStringArray(backupPaths) ||
    ((sourcePath === undefined) !== (writePath === undefined))
  ) {
    return false
  }
  if (typeof sourcePath === 'string') {
    const recognizedSources = settingsReadCandidates(userDataPath)
    if (!recognizedSources.some((candidate) => samePath(candidate, sourcePath, platform))) return false
    if (typeof writePath === 'string' && !samePath(sourcePath, writePath, platform)) {
      try {
        if (
          pathState(sourcePath) !== 'symlink' ||
          !samePath(realpathSync(sourcePath), writePath, platform)
        ) {
          return false
        }
      } catch {
        return false
      }
    }
  }
  if (backupPaths.length > 0 && typeof writePath !== 'string') return false
  return backupPaths.every((backupPath) =>
    typeof backupPath === 'string' &&
    typeof writePath === 'string' &&
    isMigrationOwnedSiblingPath(
      backupPath,
      writePath,
      'pre-runtime-data-migration',
      platform
    ))
}

function isMigrationOwnedSiblingPath(
  candidate: string,
  original: string,
  label: string,
  platform: NodeJS.Platform
): boolean {
  if (!isAbsolute(candidate) || !isAbsolute(original)) return false
  const resolved = resolve(candidate)
  if (!samePath(dirname(resolved), dirname(resolve(original)), platform)) return false
  const escapedOriginalName = basename(resolve(original)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^${escapedOriginalName}\\.${label}-${MIGRATION_STAMP}\\.bak$`,
    'i'
  ).test(basename(resolved))
}

function isCanonicalStringArray(value: unknown): value is string[] {
  if (!isStringArray(value) || new Set(value).size !== value.length) return false
  return stringArraysEqual(value, [...value].sort())
}

function runtimeThreadIds(rootPath: string): string[] {
  const threadsPath = join(rootPath, 'threads')
  if (pathState(threadsPath) !== 'directory') return []
  return readdirSync(threadsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

function inspectRecoveryVerifiedCandidates(
  userDataPath: string,
  current: string,
  legacy: string,
  platform: NodeJS.Platform
): { paths: Map<string, RecoveryVerifiedCandidate>; invalidEvidenceCount: number } {
  const paths = new Map<string, RecoveryVerifiedCandidate>()
  const recordRoot = join(userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { paths, invalidEvidenceCount: 0 }
  if (rootState !== 'directory') return { paths, invalidEvidenceCount: 1 }

  let invalidEvidenceCount = 0
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!isUuid(operationId)) {
      invalidEvidenceCount += 1
      continue
    }
    const operationDir = join(recordRoot, operationId)
    if (pathState(operationDir) !== 'directory') {
      invalidEvidenceCount += 1
      continue
    }
    const verifiedPath = join(operationDir, '020-verified.json')
    const state = pathState(verifiedPath)
    if (state === 'missing') continue
    if (state !== 'file') {
      invalidEvidenceCount += 1
      continue
    }
    const record = readJsonObject(verifiedPath)
    const inventory = RuntimeDataRecoveryInventorySchema.safeParse(record?.stagingInventory)
    const sourceFingerprint = record?.sourceFingerprint
    const stagingFingerprint = record?.stagingFingerprint
    const stagingPath = record?.stagingPath
    const sourcePath = record?.sourcePath
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.operationId !== operationId ||
      record.phase !== 'verified' ||
      record.action !== 'restore' ||
      typeof sourcePath !== 'string' ||
      !isRecognizedFixedPath(sourcePath, current, legacy, platform) ||
      typeof record.targetPath !== 'string' ||
      !samePath(record.targetPath, current, platform) ||
      typeof stagingPath !== 'string' ||
      !isRuntimeRecoveryStagingPath(stagingPath, current, platform) ||
      typeof sourceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
      stagingFingerprint !== sourceFingerprint ||
      !inventory.success ||
      !parseMigrationJournalEvidence(record.blockedJournalEvidence)
    ) {
      invalidEvidenceCount += 1
      continue
    }
    const key = pathKey(stagingPath, platform)
    const proof = { fingerprint: stagingFingerprint, inventory: inventory.data }
    const existing = paths.get(key)
    if (
      existing &&
      (existing.fingerprint !== proof.fingerprint || !inventoriesEqual(existing.inventory, proof.inventory))
    ) {
      paths.delete(key)
      invalidEvidenceCount += 1
      continue
    }
    paths.set(key, proof)
  }
  return { paths, invalidEvidenceCount }
}

function isRuntimeRecoveryStagingPath(
  candidate: string,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const resolved = resolve(candidate)
  return samePath(dirname(resolved), dirname(current), platform) &&
    /^data\.runtime-recovery-staging-\d{8}T\d{9}Z(?:-\d+)?\.bak$/i.test(basename(resolved))
}

function completedNoHistoryEvidenceIsConsistent(input: {
  journal: Record<string, unknown>
  reportPath: string
  current: string
  legacy: string
  platform: NodeJS.Platform
}): boolean {
  const { journal, current, legacy, platform } = input
  const report = readJsonObject(input.reportPath)
  const sourceInventory = parseCoreInventory(journal.sourceInventory)
  const targetInventory = parseCoreInventory(journal.targetInventory)
  const sourceFingerprint = createHash('sha256').update('no-legacy-source').digest('hex')
  const candidateFingerprint = journal.candidateFingerprint
  const settingsBackupPaths = journal.settingsBackupPaths
  const sourceThreadIds = journal.sourceThreadIds
  const conflicts = journal.conflicts
  const completedAt = journal.completedAt
  if (
    journal.schemaVersion !== 3 ||
    journal.phase !== 'completed' ||
    journal.provenance !== 'no-legacy-source' ||
    typeof journal.sourcePath !== 'string' ||
    !samePath(journal.sourcePath, legacy, platform) ||
    typeof journal.targetPath !== 'string' ||
    !samePath(journal.targetPath, current, platform) ||
    typeof journal.stagingPath !== 'string' ||
    !isHistoryPreservingStagingPath(journal.stagingPath, current, platform) ||
    journal.destinationBackupPath !== undefined ||
    journal.compatibilityLinkBackupPath !== undefined ||
    (journal.settingsSourcePath !== undefined && typeof journal.settingsSourcePath !== 'string') ||
    (journal.settingsWritePath !== undefined && typeof journal.settingsWritePath !== 'string') ||
    !isStringArray(settingsBackupPaths) ||
    !Array.isArray(sourceThreadIds) || sourceThreadIds.length !== 0 ||
    !sourceInventory || !isEmptyCoreInventory(sourceInventory) ||
    journal.sourceFingerprint !== sourceFingerprint ||
    typeof candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidateFingerprint) ||
    journal.salvaged !== 0 ||
    !Array.isArray(conflicts) || conflicts.length !== 0 ||
    !targetInventory ||
    !validSqliteCheck(journal.sqliteQuickCheck) ||
    !validRecordedDate(journal.startedAt) ||
    !validRecordedDate(journal.updatedAt) ||
    typeof completedAt !== 'string' || !validRecordedDate(completedAt) ||
    pathState(legacy) !== 'missing' ||
    !report
  ) {
    return false
  }

  let target: ReturnType<typeof fingerprintTree>
  try {
    target = fingerprintTree(current)
  } catch {
    return false
  }
  if (
    target.fingerprint !== candidateFingerprint ||
    !coreInventoriesEqual(target.inventory, targetInventory)
  ) {
    return false
  }

  const reportSourceInventory = parseCoreInventory(report.sourceInventory)
  const reportTargetInventory = parseCoreInventory(report.targetInventory)
  return report.schemaVersion === 3 &&
    report.status === 'completed' &&
    report.provenance === 'no-legacy-source' &&
    typeof report.sourcePath === 'string' && samePath(report.sourcePath, legacy, platform) &&
    typeof report.targetPath === 'string' && samePath(report.targetPath, current, platform) &&
    report.stagingPath === journal.stagingPath &&
    report.destinationBackupPath === undefined &&
    report.compatibilityLinkBackupPath === undefined &&
    report.settingsSourcePath === journal.settingsSourcePath &&
    isStringArray(report.settingsBackupPaths) &&
    stringArraysEqual(report.settingsBackupPaths, settingsBackupPaths) &&
    report.sourceThreadCount === 0 &&
    Boolean(reportSourceInventory && coreInventoriesEqual(reportSourceInventory, sourceInventory)) &&
    report.sourceFingerprint === sourceFingerprint &&
    report.candidateFingerprint === candidateFingerprint &&
    report.salvaged === 0 &&
    Array.isArray(report.conflicts) && report.conflicts.length === 0 &&
    Boolean(reportTargetInventory && coreInventoriesEqual(reportTargetInventory, targetInventory)) &&
    report.sqliteQuickCheck === journal.sqliteQuickCheck &&
    report.completedAt === completedAt &&
    report.exactPreMigrationSnapshot === true &&
    report.sourceExisted === false
}

function isHistoryPreservingStagingPath(
  candidate: string,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const resolved = resolve(candidate)
  return samePath(dirname(resolved), dirname(current), platform) &&
    /^data\.history-preserving-staging-\d{8}T\d{9}Z(?:-\d+)?\.bak$/i.test(basename(resolved))
}

function validRecordedDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validSqliteCheck(value: unknown): boolean {
  return value === 'missing' || value === 'ok' || value === 'invalid'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function isEmptyCoreInventory(
  inventory: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>
): boolean {
  return inventory.files === 0 && inventory.symlinks === 0 && inventory.bytes === 0 &&
    (inventory.directories === 0 || inventory.directories === 1)
}

function isRecognizedFixedPath(
  path: string,
  current: string,
  legacy: string,
  platform: NodeJS.Platform
): boolean {
  if (samePath(path, current, platform) || samePath(path, legacy, platform)) return true
  const resolvedPath = resolve(path)
  const name = basename(resolvedPath)
  if (samePath(dirname(resolvedPath), dirname(current), platform)) return CURRENT_SIBLING_PATTERN.test(name)
  if (samePath(dirname(resolvedPath), dirname(legacy), platform)) return LEGACY_SIBLING_PATTERN.test(name)
  return false
}

function inspectCandidate(
  path: string,
  kind: RuntimeDataRecoveryCandidateKind,
  platform: NodeJS.Platform
): CandidateDescriptor {
  const metadata = lstatSync(path, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('candidate root is not a real directory')
  const realPath = realpathSync(path)
  const realParent = realpathSync(dirname(path))
  if (!isContained(realParent, realPath, platform) || samePath(realParent, realPath, platform)) {
    throw new Error('candidate escaped its fixed parent')
  }
  assertContainedSymlinks(realPath, platform)
  validateOptionalJson(join(realPath, 'config.json'))
  const fingerprint = fingerprintTree(realPath)
  const identity = inspectIdentity(realPath)
  const warnings = [...identity.warnings]
  if (!sqliteHeaderIsValid(realPath)) warnings.push('The rebuildable SQLite index did not pass its header check.')
  return {
    path,
    realPath,
    device: metadata.dev,
    inode: metadata.ino,
    fingerprint: fingerprint.fingerprint,
    // Backup names represent atomic displacement of a complete store. Staging
    // names represent an in-flight copy and require an exact verified record.
    automaticRestoreSafe: kind !== 'staging',
    summary: {
      kind,
      label: candidateLabel(kind),
      modifiedAt: new Date(Number(metadata.mtimeMs)).toISOString(),
      inventory: {
        ...fingerprint.inventory,
        threads: countChildren(join(realPath, 'threads')),
        providers: providerCount(realPath),
        graphs: countChildren(join(realPath, 'task-graphs'))
      },
      credentialState: identity.state,
      journalReferenced: false,
      recoveryVerified: false,
      journalVerified: false,
      warnings
    }
  }
}

function revalidateCandidate(
  descriptor: CandidateDescriptor,
  platform: NodeJS.Platform,
  options: Pick<RuntimeDataDirRecoveryOptions, 'homeDir' | 'userDataPath'>
): void {
  let current: CandidateDescriptor
  try {
    current = inspectCandidate(descriptor.path, descriptor.summary.kind, platform)
  } catch (error) {
    throw new RuntimeDataRecoveryError(
      'candidate_changed',
      'The selected recovery candidate changed after it was inspected.',
      { cause: error }
    )
  }
  const identityChanged = current.realPath !== descriptor.realPath ||
    (Number(descriptor.inode) !== 0 && current.inode !== descriptor.inode) ||
    (Number(descriptor.device) !== 0 && current.device !== descriptor.device)
  if (
    identityChanged ||
    current.fingerprint !== descriptor.fingerprint ||
    !inventoriesEqual(current.summary.inventory, descriptor.summary.inventory)
  ) {
    throw new RuntimeDataRecoveryError(
      'candidate_changed',
      'The selected recovery candidate changed after it was inspected.'
    )
  }
  if (descriptor.journalVerification) {
    const proof = readMigrationJournalVerifiedCandidate(
      descriptor.journalVerification.journalPath,
      options,
      platform
    )
    if (
      !proof ||
      proof.journalDigest !== descriptor.journalVerification.journalDigest ||
      proof.fingerprint !== descriptor.fingerprint ||
      !inventoriesEqual(proof.inventory, descriptor.summary.inventory) ||
      !stringArraysEqual(
        proof.sourceThreadIds,
        descriptor.journalVerification.sourceThreadIds
      )
    ) {
      throw new RuntimeDataRecoveryError(
        'candidate_changed',
        'The migration proof for the selected recovery candidate changed after it was inspected.'
      )
    }
  }
}

function readMigrationJournalVerifiedCandidate(
  journalPath: string,
  options: Pick<RuntimeDataDirRecoveryOptions, 'homeDir' | 'userDataPath'>,
  platform: NodeJS.Platform
): MigrationJournalVerifiedCandidate | null {
  if (!samePath(journalPath, join(options.userDataPath, V3_JOURNAL), platform)) return null
  try {
    const journalRaw = readBoundedFile(journalPath, 4 * 1024 * 1024)
    const journal = JSON.parse(journalRaw) as unknown
    if (!isObject(journal) || !migrationJournalPhaseCanProveStaging(journal)) return null
    return inspectMigrationJournalVerifiedCandidate({
      journal,
      journalPath,
      journalRaw,
      userDataPath: options.userDataPath,
      current: canonicalCurrentKunDataDir(options.homeDir, platform),
      legacy: canonicalLegacyKunDataDir(options.homeDir, platform),
      platform
    })
  } catch {
    return null
  }
}

function fingerprintTree(rootPath: string): {
  fingerprint: string
  inventory: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>
} {
  const hash = createHash('sha256')
  const inventory = { files: 0, directories: 0, symlinks: 0, bytes: 0 }
  const visit = (entryPath: string): void => {
    const metadata = lstatSync(entryPath)
    const relativePath = canonicalRelativePath(rootPath, entryPath)
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(entryPath)
      inventory.symlinks += 1
      inventory.bytes += metadata.size
      hash.update(`link\0${relativePath}\0${target}\0`)
      return
    }
    if (metadata.isDirectory()) {
      inventory.directories += 1
      hash.update(`dir\0${relativePath}\0${metadata.mode & 0o7777}\0`)
      for (const name of readdirSync(entryPath).sort()) visit(join(entryPath, name))
      return
    }
    if (!metadata.isFile()) throw new Error('candidate contains an unsupported filesystem entry')
    inventory.files += 1
    inventory.bytes += metadata.size
    hash.update(`file\0${relativePath}\0${metadata.mode & 0o7777}\0${metadata.size}\0`)
    hash.update(hashFile(entryPath))
    hash.update('\0')
  }
  visit(rootPath)
  return { fingerprint: hash.digest('hex'), inventory }
}

function hashFile(path: string): string {
  const hash = createHash('sha256')
  const handle = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(handle)
  }
  return hash.digest('hex')
}

function inspectIdentity(rootPath: string): {
  state: RuntimeDataRecoveryCredentialState
  warnings: string[]
} {
  const present = PROTECTED_IDENTITY_ENTRIES.filter((entry) => pathState(join(rootPath, entry)) !== 'missing')
  if (present.length === 0) return { state: 'none', warnings: [] }
  let incomplete = false
  for (const entry of JSON_IDENTITY_ENTRIES) {
    const path = join(rootPath, entry)
    if (pathState(path) === 'missing') continue
    try {
      validateOptionalJson(path, false)
    } catch {
      incomplete = true
    }
  }
  const encryptedStorePresent = ['credentials', 'mcp-oauth'].some((entry) => pathState(join(rootPath, entry)) !== 'missing')
  const secretState = pathState(join(rootPath, 'secret.key'))
  if (encryptedStorePresent && secretState !== 'file') incomplete = true
  if (secretState !== 'missing' && secretState !== 'file') incomplete = true
  return incomplete
    ? { state: 'incomplete', warnings: ['Credential key material is incomplete; affected providers may need a new API key.'] }
    : { state: 'complete', warnings: [] }
}

function validateOptionalJson(path: string, failOnInvalid = true): void {
  const state = pathState(path)
  if (state === 'missing') return
  if (state !== 'file') {
    if (failOnInvalid) throw new Error('expected a regular JSON file')
    throw new Error('identity JSON is not a regular file')
  }
  JSON.parse(readBoundedFile(path, 16 * 1024 * 1024))
}

function sqliteHeaderIsValid(rootPath: string): boolean {
  const sqlitePath = join(rootPath, 'index.sqlite3')
  const state = pathState(sqlitePath)
  if (state === 'missing') return true
  if (state !== 'file') return false
  try {
    const handle = openSync(sqlitePath, 'r')
    const header = Buffer.alloc(16)
    try {
      if (readSync(handle, header, 0, header.length, 0) !== header.length) return false
    } finally {
      closeSync(handle)
    }
    return header.equals(Buffer.from('SQLite format 3\0'))
  } catch {
    return false
  }
}

function providerCount(rootPath: string): number {
  const path = join(rootPath, 'extensions', 'providers.json')
  if (pathState(path) !== 'file') return 0
  try {
    const parsed = JSON.parse(readBoundedFile(path, 16 * 1024 * 1024)) as unknown
    if (!isObject(parsed)) return 0
    const providers = parsed.providers
    if (Array.isArray(providers)) return providers.length
    return isObject(providers) ? Object.keys(providers).length : 0
  } catch {
    return 0
  }
}

function countChildren(path: string): number {
  try {
    if (pathState(path) !== 'directory') return 0
    return readdirSync(path).length
  } catch {
    return 0
  }
}

function assertContainedSymlinks(rootPath: string, platform: NodeJS.Platform): void {
  const pending = [rootPath]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of readdirSync(current).sort()) {
      const entryPath = join(current, name)
      const metadata = lstatSync(entryPath)
      if (metadata.isDirectory()) {
        pending.push(entryPath)
        continue
      }
      if (!metadata.isSymbolicLink()) continue
      const target = readlinkSync(entryPath)
      const lexicalTarget = resolve(dirname(entryPath), target)
      let resolvedTarget: string
      try {
        resolvedTarget = realpathSync(entryPath)
      } catch {
        throw new Error('candidate contains a dangling symbolic link')
      }
      if (
        !isContained(rootPath, lexicalTarget, platform) ||
        !isContained(rootPath, resolvedTarget, platform)
      ) {
        throw new Error('candidate contains a symbolic link outside its root')
      }
    }
  }
}

function copyRuntimeTree(sourcePath: string, targetPath: string): void {
  const source = lstatSync(sourcePath)
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error('copy source is not a directory')
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  mkdirSync(targetPath, { mode: (source.mode & 0o7777) | 0o700 })
  for (const name of readdirSync(sourcePath).sort()) {
    const sourceEntry = join(sourcePath, name)
    const targetEntry = join(targetPath, name)
    const metadata = lstatSync(sourceEntry)
    if (metadata.isDirectory()) {
      copyRuntimeTree(sourceEntry, targetEntry)
    } else if (metadata.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourceEntry), targetEntry)
    } else if (metadata.isFile()) {
      copyFileSync(sourceEntry, targetEntry, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      chmodSync(targetEntry, metadata.mode & 0o7777)
      utimesSync(targetEntry, metadata.atime, metadata.mtime)
      fsyncFileBestEffort(targetEntry)
    } else {
      throw new Error('copy source contains an unsupported entry')
    }
  }
  chmodSync(targetPath, source.mode & 0o7777)
  utimesSync(targetPath, source.atime, source.mtime)
  fsyncDirectoryBestEffort(targetPath)
}

type RecoveryRecord = {
  operationDir: string
  base: Record<string, unknown>
  now: () => Date
}

type RecoveryTargetIdentity = {
  name: string
  digest: string
}

type MigrationJournalEvidence = {
  version: 2 | 3
  state: Exclude<PathState, 'missing'>
  digest: string
}

function beginRecoveryRecord(
  userDataPath: string,
  now: () => Date,
  base: Record<string, unknown>
): RecoveryRecord {
  const operationId = randomUUID()
  const operationDir = join(userDataPath, RECOVERY_RECORD_DIR, operationId)
  mkdirSync(operationDir, { recursive: true, mode: 0o700 })
  const record = {
    operationDir,
    now,
    base: {
      schemaVersion: 1,
      operationId,
      startedAt: now().toISOString(),
      blockedJournalEvidence: migrationJournalEvidence(userDataPath),
      ...base
    }
  }
  writeRecoveryRecord(record, 0, 'started', {})
  return record
}

function writeRecoveryTargetIdentityMarker(
  record: RecoveryRecord,
  stagingPath: string
): RecoveryTargetIdentity {
  const operationId = String(record.base.operationId)
  if (!isUuid(operationId)) throw new Error('recovery operation identity is invalid')
  const name = `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json`
  const path = join(stagingPath, name)
  writeDurableJson(path, {
    schemaVersion: 1,
    operationId,
    token: randomBytes(32).toString('hex')
  })
  return { name, digest: hashFile(path) }
}

function writeRecoveryRecord(
  record: RecoveryRecord,
  ordinal: number,
  phase: string,
  detail: Record<string, unknown>
): void {
  writeDurableJson(join(record.operationDir, `${String(ordinal).padStart(3, '0')}-${phase}.json`), {
    ...record.base,
    phase,
    recordedAt: record.now().toISOString(),
    ...detail
  })
}

function writeRecoveryRecordBestEffort(
  record: RecoveryRecord,
  ordinal: number,
  phase: string,
  detail: Record<string, unknown>
): void {
  try {
    writeRecoveryRecord(record, ordinal, phase, detail)
  } catch {
    // The source, staging, and any destination backup remain untouched even if
    // the diagnostic record cannot be extended.
  }
}

function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const handle = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  fsyncDirectoryBestEffort(dirname(path))
}

function uniqueSiblingPath(path: string, label: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[-:.]/g, '')
  for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
    const suffix = ordinal === 0 ? '' : `-${ordinal}`
    const candidate = join(dirname(path), `${basename(path)}.${label}-${stamp}${suffix}.bak`)
    if (pathState(candidate) === 'missing') return candidate
  }
  throw new Error('could not allocate a recovery sibling')
}

/**
 * Validates an immutable recovery completion record against both the current
 * canonical tree and the exact v2/v3 journal bytes that were preserved when
 * recovery began. Migration startup may supersede an otherwise-blocking old
 * journal only when this returns `valid` with `supersedesBlockedJournals`.
 */
export function validateRuntimeDataRecoveryCompletion(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
}): RuntimeDataRecoveryCompletionCheck {
  const platform = input.platform ?? process.platform
  const recordRoot = join(input.userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { status: 'none' }
  if (rootState !== 'directory') return { status: 'invalid', reason: 'record_root_invalid' }

  const completionPaths: string[] = []
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      continue
    }
    const path = join(recordRoot, operationId, '040-completed.json')
    if (pathState(path) !== 'missing') completionPaths.push(path)
  }
  if (completionPaths.length === 0) return { status: 'none' }

  const currentTarget = canonicalCurrentKunDataDir(input.homeDir, platform)
  const currentJournals = migrationJournalEvidence(input.userDataPath)
  let sawTargetChange = false
  let sawJournalChange = false
  for (const markerPath of completionPaths.reverse()) {
    let marker: Record<string, unknown>
    try {
      if (pathState(markerPath) !== 'file') throw new Error('completion marker is not a file')
      const parsed = JSON.parse(readBoundedFile(markerPath, 16 * 1024 * 1024)) as unknown
      if (!isObject(parsed)) throw new Error('completion marker is not an object')
      marker = parsed
    } catch {
      continue
    }
    const operationId = basename(dirname(markerPath))
    const action = marker.action
    const completedAt = marker.recordedAt
    const targetFingerprint = marker.targetFingerprint
    const targetIdentityMarkerName = marker.targetIdentityMarkerName
    const targetIdentityMarkerDigest = marker.targetIdentityMarkerDigest
    if (
      marker.schemaVersion !== 1 ||
      marker.phase !== 'completed' ||
      marker.operationId !== operationId ||
      (action !== 'restore' && action !== 'initialize-new-install' && action !== 'start-over') ||
      typeof completedAt !== 'string' ||
      !Number.isFinite(Date.parse(completedAt)) ||
      typeof targetFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(targetFingerprint) ||
      typeof targetIdentityMarkerName !== 'string' ||
      targetIdentityMarkerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
      typeof targetIdentityMarkerDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(targetIdentityMarkerDigest) ||
      typeof marker.targetPath !== 'string' ||
      !samePath(marker.targetPath, currentTarget, platform) ||
      !validRecordedRecoveryPaths(marker, currentTarget, platform)
    ) {
      continue
    }
    const recordedInventory = parseCoreInventory(marker.targetInventory)
    const recordedJournals = parseMigrationJournalEvidence(marker.blockedJournalEvidence)
    if (!recordedInventory || !recordedJournals) continue

    let currentTargetState: ReturnType<typeof fingerprintTree>
    try {
      currentTargetState = fingerprintTree(currentTarget)
    } catch {
      sawTargetChange = true
      continue
    }
    if (
      currentTargetState.fingerprint !== targetFingerprint ||
      !coreInventoriesEqual(currentTargetState.inventory, recordedInventory)
    ) {
      sawTargetChange = true
      continue
    }
    if (!journalEvidenceEqual(recordedJournals, currentJournals)) {
      sawJournalChange = true
      continue
    }
    if (!recoveryTargetIdentityMarkerMatches(
      currentTarget,
      operationId,
      targetIdentityMarkerName,
      targetIdentityMarkerDigest
    )) {
      sawTargetChange = true
      continue
    }
    return {
      status: 'valid',
      operationId,
      action,
      completedAt,
      targetFingerprint,
      targetIdentityMarkerName,
      targetIdentityMarkerDigest,
      supersedesBlockedJournals: recordedJournals.length > 0,
      preservedJournalVersions: recordedJournals.map((entry) => entry.version)
    }
  }
  return {
    status: 'invalid',
    reason: sawTargetChange
      ? 'target_changed'
      : sawJournalChange ? 'journal_changed' : 'marker_invalid'
  }
}

/**
 * Performs the one-time full target verification before managed Runtime
 * writers start, then seals that decision in immutable two-phase records.
 * The caller must hold the shared migration/startup lock for this call.
 */
export function acceptRuntimeDataRecoveryCompletion(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
  now?: () => Date
}): RuntimeDataRecoveryAcceptanceCheck {
  const existing = validateAcceptedRuntimeDataRecovery(input)
  if (existing.status === 'valid') return existing

  const completion = validateRuntimeDataRecoveryCompletion(input)
  if (completion.status === 'none') return { status: 'invalid', reason: 'completion_missing' }
  if (completion.status !== 'valid') {
    return { status: 'invalid', reason: 'completion_invalid' }
  }

  const platform = input.platform ?? process.platform
  const now = input.now ?? (() => new Date())
  const operationDir = join(input.userDataPath, RECOVERY_RECORD_DIR, completion.operationId)
  const completionPath = join(operationDir, '040-completed.json')
  const acceptanceId = randomUUID()
  const acceptanceDir = join(operationDir, `acceptance-${acceptanceId}`)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const journals = migrationJournalEvidence(input.userDataPath)
  const base = {
    schemaVersion: 1,
    operationId: completion.operationId,
    acceptanceId,
    action: completion.action,
    targetPath,
    targetIdentityMarkerName: completion.targetIdentityMarkerName,
    targetIdentityMarkerDigest: completion.targetIdentityMarkerDigest,
    completionDigest: hashFile(completionPath),
    journalEvidence: journals
  }
  mkdirSync(acceptanceDir, { recursive: true, mode: 0o700 })
  const preparedPath = join(acceptanceDir, '000-prepared.json')
  writeDurableJson(preparedPath, {
    ...base,
    phase: 'prepared',
    preparedAt: now().toISOString()
  })

  // Re-run the expensive verification after the prepared record is durable.
  // A shared migration/startup lock closes the remaining writer race before
  // the accepted seal is written.
  const revalidated = validateRuntimeDataRecoveryCompletion(input)
  if (
    revalidated.status !== 'valid' ||
    revalidated.operationId !== completion.operationId ||
    revalidated.targetFingerprint !== completion.targetFingerprint
  ) {
    return { status: 'invalid', reason: 'completion_invalid' }
  }
  writeDurableJson(join(acceptanceDir, '010-accepted.json'), {
    ...base,
    phase: 'accepted',
    preparedDigest: hashFile(preparedPath),
    acceptedAt: now().toISOString()
  })
  return validateAcceptedRuntimeDataRecovery(input)
}

/**
 * Fast post-acceptance validation. It intentionally does not fingerprint the
 * Runtime tree because normal Runtime writes are expected after acceptance.
 */
export function validateAcceptedRuntimeDataRecovery(input: {
  homeDir: string
  userDataPath: string
  platform?: NodeJS.Platform
}): RuntimeDataRecoveryAcceptanceCheck {
  const platform = input.platform ?? process.platform
  const recordRoot = join(input.userDataPath, RECOVERY_RECORD_DIR)
  const rootState = pathState(recordRoot)
  if (rootState === 'missing') return { status: 'none' }
  if (rootState !== 'directory') return { status: 'invalid', reason: 'accepted_record_invalid' }

  const acceptedPaths: string[] = []
  for (const operationId of readdirSync(recordRoot).sort()) {
    if (!isUuid(operationId)) continue
    const operationDir = join(recordRoot, operationId)
    if (pathState(operationDir) !== 'directory') continue
    for (const name of readdirSync(operationDir).sort()) {
      if (!/^acceptance-[0-9a-f-]{36}$/i.test(name)) continue
      const acceptanceId = name.slice('acceptance-'.length)
      if (!isUuid(acceptanceId)) continue
      const acceptedPath = join(operationDir, name, '010-accepted.json')
      if (pathState(acceptedPath) !== 'missing') acceptedPaths.push(acceptedPath)
    }
  }
  if (acceptedPaths.length === 0) return { status: 'none' }

  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const currentJournals = migrationJournalEvidence(input.userDataPath)
  let sawJournalChange = false
  let sawTargetChange = false
  let sawTargetUnavailable = false
  for (const acceptedPath of acceptedPaths.reverse()) {
    const accepted = readJsonObject(acceptedPath)
    if (!accepted) continue
    const acceptanceDir = dirname(acceptedPath)
    const operationDir = dirname(acceptanceDir)
    const operationId = basename(operationDir)
    const acceptanceId = basename(acceptanceDir).slice('acceptance-'.length)
    const action = accepted.action
    const acceptedAt = accepted.acceptedAt
    if (
      accepted.schemaVersion !== 1 ||
      accepted.phase !== 'accepted' ||
      accepted.operationId !== operationId ||
      accepted.acceptanceId !== acceptanceId ||
      (action !== 'restore' && action !== 'initialize-new-install' && action !== 'start-over') ||
      typeof acceptedAt !== 'string' ||
      !Number.isFinite(Date.parse(acceptedAt)) ||
      typeof accepted.targetPath !== 'string' ||
      !samePath(accepted.targetPath, targetPath, platform) ||
      typeof accepted.targetIdentityMarkerName !== 'string' ||
      accepted.targetIdentityMarkerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
      typeof accepted.targetIdentityMarkerDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.targetIdentityMarkerDigest) ||
      typeof accepted.completionDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.completionDigest) ||
      typeof accepted.preparedDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accepted.preparedDigest)
    ) {
      continue
    }
    const journals = parseMigrationJournalEvidence(accepted.journalEvidence)
    if (!journals) continue
    const preparedPath = join(acceptanceDir, '000-prepared.json')
    const completionPath = join(operationDir, '040-completed.json')
    const completionRecord = readJsonObject(completionPath)
    if (
      !regularFileDigestMatches(preparedPath, accepted.preparedDigest) ||
      !regularFileDigestMatches(completionPath, accepted.completionDigest) ||
      !preparedRecordMatches(readJsonObject(preparedPath), accepted) ||
      !completedRecordMatches(completionRecord, accepted, operationId, targetPath, platform)
    ) {
      continue
    }
    if (!journalEvidenceEqual(journals, currentJournals)) {
      sawJournalChange = true
      continue
    }
    if (pathState(targetPath) !== 'directory') {
      sawTargetUnavailable = true
      continue
    }
    if (!recoveryTargetIdentityMarkerMatches(
      targetPath,
      operationId,
      accepted.targetIdentityMarkerName,
      accepted.targetIdentityMarkerDigest
    )) {
      sawTargetChange = true
      continue
    }
    return {
      status: 'valid',
      operationId,
      action,
      acceptedAt,
      preservedJournalVersions: journals.map((entry) => entry.version)
    }
  }
  return {
    status: 'invalid',
    reason: sawJournalChange
      ? 'journal_changed'
      : sawTargetUnavailable
        ? 'target_unavailable'
        : sawTargetChange ? 'target_changed' : 'accepted_record_invalid'
  }
}

function completedRecordMatches(
  completion: Record<string, unknown> | null,
  accepted: Record<string, unknown>,
  operationId: string,
  targetPath: string,
  platform: NodeJS.Platform
): boolean {
  if (
    !completion ||
    completion.schemaVersion !== 1 ||
    completion.phase !== 'completed' ||
    completion.operationId !== operationId ||
    completion.action !== accepted.action ||
    typeof completion.targetPath !== 'string' ||
    !samePath(completion.targetPath, targetPath, platform) ||
    typeof completion.targetFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(completion.targetFingerprint) ||
    completion.targetIdentityMarkerName !== accepted.targetIdentityMarkerName ||
    completion.targetIdentityMarkerDigest !== accepted.targetIdentityMarkerDigest ||
    !parseCoreInventory(completion.targetInventory)
  ) {
    return false
  }
  const completionJournals = parseMigrationJournalEvidence(completion.blockedJournalEvidence)
  const acceptedJournals = parseMigrationJournalEvidence(accepted.journalEvidence)
  return Boolean(
    completionJournals &&
    acceptedJournals &&
    journalEvidenceEqual(completionJournals, acceptedJournals)
  )
}

function preparedRecordMatches(
  prepared: Record<string, unknown> | null,
  accepted: Record<string, unknown>
): boolean {
  if (!prepared || prepared.phase !== 'prepared') return false
  for (const key of [
    'schemaVersion',
    'operationId',
    'acceptanceId',
    'action',
    'targetPath',
    'targetIdentityMarkerName',
    'targetIdentityMarkerDigest',
    'completionDigest'
  ] as const) {
    if (prepared[key] !== accepted[key]) return false
  }
  const preparedJournals = parseMigrationJournalEvidence(prepared.journalEvidence)
  const acceptedJournals = parseMigrationJournalEvidence(accepted.journalEvidence)
  return Boolean(
    preparedJournals &&
    acceptedJournals &&
    journalEvidenceEqual(preparedJournals, acceptedJournals)
  )
}

function regularFileDigestMatches(path: string, expected: unknown): boolean {
  try {
    return typeof expected === 'string' && pathState(path) === 'file' && hashFile(path) === expected
  } catch {
    return false
  }
}

function recoveryTargetIdentityMarkerMatches(
  targetPath: string,
  operationId: string,
  markerName: unknown,
  expectedDigest: unknown
): boolean {
  if (
    markerName !== `${RECOVERY_TARGET_IDENTITY_PREFIX}${operationId}.json` ||
    typeof expectedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedDigest)
  ) return false
  const markerPath = join(targetPath, markerName)
  const marker = readJsonObject(markerPath)
  return Boolean(
    marker &&
    marker.schemaVersion === 1 &&
    marker.operationId === operationId &&
    typeof marker.token === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.token) &&
    regularFileDigestMatches(markerPath, expectedDigest)
  )
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (pathState(path) !== 'file') return null
    const value = JSON.parse(readBoundedFile(path, 16 * 1024 * 1024)) as unknown
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validRecordedRecoveryPaths(
  marker: Record<string, unknown>,
  current: string,
  platform: NodeJS.Platform
): boolean {
  const legacy = canonicalLegacyKunDataDir(dirname(dirname(current)), platform)
  for (const key of ['sourcePath', 'stagingPath', 'destinationBackupPath'] as const) {
    const value = marker[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !isRecognizedFixedPath(value, current, legacy, platform)) return false
  }
  if (
    typeof marker.destinationBackupPath === 'string' &&
    pathState(marker.destinationBackupPath) === 'missing'
  ) {
    return false
  }
  return true
}

function migrationJournalEvidence(userDataPath: string): MigrationJournalEvidence[] {
  const result: MigrationJournalEvidence[] = []
  for (const [name, version] of [[V2_JOURNAL, 2], [V3_JOURNAL, 3]] as const) {
    const path = join(userDataPath, name)
    const state = pathState(path)
    if (state === 'missing') continue
    result.push({ version, state, digest: filesystemEvidenceDigest(path, state) })
  }
  return result
}

function filesystemEvidenceDigest(path: string, state: Exclude<PathState, 'missing'>): string {
  const hash = createHash('sha256')
  hash.update(`${state}\0`)
  try {
    if (state === 'file') {
      hash.update(hashFile(path))
    } else if (state === 'directory') {
      hash.update(fingerprintTree(path).fingerprint)
    } else if (state === 'symlink') {
      hash.update(readlinkSync(path))
    } else if (state === 'other') {
      const metadata = lstatSync(path)
      hash.update(`${metadata.mode}\0${metadata.size}`)
    } else {
      hash.update('unreadable')
    }
  } catch {
    hash.update('unreadable')
  }
  return hash.digest('hex')
}

function parseMigrationJournalEvidence(value: unknown): MigrationJournalEvidence[] | null {
  if (!Array.isArray(value) || value.length > 2) return null
  const seen = new Set<number>()
  const result: MigrationJournalEvidence[] = []
  for (const entry of value) {
    if (
      !isObject(entry) ||
      (entry.version !== 2 && entry.version !== 3) ||
      seen.has(entry.version) ||
      (
        entry.state !== 'directory' &&
        entry.state !== 'symlink' &&
        entry.state !== 'file' &&
        entry.state !== 'other' &&
        entry.state !== 'inaccessible'
      ) ||
      typeof entry.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.digest)
    ) {
      return null
    }
    seen.add(entry.version)
    result.push({ version: entry.version, state: entry.state, digest: entry.digest })
  }
  return result.sort((left, right) => left.version - right.version)
}

function journalEvidenceEqual(
  left: readonly MigrationJournalEvidence[],
  right: readonly MigrationJournalEvidence[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.version === right[index]?.version &&
    entry.state === right[index]?.state &&
    entry.digest === right[index]?.digest)
}

function parseCoreInventory(
  value: unknown
): Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'> | null {
  if (!isObject(value)) return null
  const keys = ['files', 'directories', 'symlinks', 'bytes'] as const
  if (!keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) return null
  return {
    files: Number(value.files),
    directories: Number(value.directories),
    symlinks: Number(value.symlinks),
    bytes: Number(value.bytes)
  }
}

function coreInventory(
  value: RuntimeDataRecoveryInventory
): Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'> {
  return {
    files: value.files,
    directories: value.directories,
    symlinks: value.symlinks,
    bytes: value.bytes
  }
}

function coreInventoriesEqual(
  left: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>,
  right: Omit<RuntimeDataRecoveryInventory, 'threads' | 'providers' | 'graphs'>
): boolean {
  return left.files === right.files &&
    left.directories === right.directories &&
    left.symlinks === right.symlinks &&
    left.bytes === right.bytes
}

function candidateOpaqueId(secret: Buffer, generation: string, descriptor: CandidateDescriptor): string {
  const identity = [
    generation,
    descriptor.summary.kind,
    descriptor.realPath,
    String(descriptor.device),
    String(descriptor.inode),
    descriptor.fingerprint,
    JSON.stringify(descriptor.summary.inventory)
  ].join('\0')
  return createHmac('sha256', secret).update(identity).digest('base64url')
}

function candidateLabel(kind: RuntimeDataRecoveryCandidateKind): string {
  if (kind === 'current') return 'Current Kun data / 当前 Kun 数据'
  if (kind === 'legacy') return 'Legacy Kun data / 旧版 Kun 数据'
  if (kind === 'staging') return 'Verified recovery staging copy / 已验证恢复暂存副本'
  return 'Preserved migration backup / 已保留的迁移备份'
}

function compareCandidatePreference(left: CandidateDescriptor, right: CandidateDescriptor): number {
  const rank: Record<RuntimeDataRecoveryCandidateKind, number> = {
    current: 0,
    legacy: 1,
    staging: 2,
    backup: 3
  }
  return rank[left.summary.kind] - rank[right.summary.kind] ||
    right.summary.modifiedAt.localeCompare(left.summary.modifiedAt)
}

function inventoriesEqual(left: RuntimeDataRecoveryInventory, right: RuntimeDataRecoveryInventory): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof RuntimeDataRecoveryInventory] === right[key as keyof RuntimeDataRecoveryInventory])
}

function isEmptyInventory(inventory: RuntimeDataRecoveryInventory): boolean {
  return inventory.files === 0 && inventory.symlinks === 0 && inventory.directories <= 1
}

function canonicalRelativePath(rootPath: string, entryPath: string): string {
  const value = relative(rootPath, entryPath)
  return value === '' ? '.' : value.split(sep).join('/')
}

function isContained(rootPath: string, candidatePath: string, platform: NodeJS.Platform): boolean {
  const root = pathKey(resolve(rootPath), platform)
  const candidate = pathKey(resolve(candidatePath), platform)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (!left || !right || !isAbsolute(left) || !isAbsolute(right)) return false
  return pathKey(left, platform) === pathKey(right, platform)
}

function pathKey(path: string, platform: NodeJS.Platform): string {
  const resolved = resolve(path).replace(/[\\/]+$/, '')
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function pathState(path: string): PathState {
  try {
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) return 'symlink'
    if (metadata.isDirectory()) return 'directory'
    if (metadata.isFile()) return 'file'
    return 'other'
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? 'missing' : 'inaccessible'
  }
}

function errnoCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined
}

function readBoundedFile(path: string, maximumBytes: number): string {
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error('file is not safely readable')
  return readFileSync(path, 'utf8')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fsyncFileBestEffort(path: string): void {
  const handle = openSync(path, 'r')
  try {
    try {
      fsyncSync(handle)
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  } finally {
    closeSync(handle)
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  try {
    const handle = openSync(path, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

function toRecoveryError(error: unknown): RuntimeDataRecoveryError {
  if (error instanceof RuntimeDataRecoveryError) return error
  return new RuntimeDataRecoveryError(
    'cutover_failed',
    'Runtime data recovery failed without changing preserved evidence.',
    { cause: error }
  )
}

export const runtimeDataRecoveryInternals = {
  CURRENT_SIBLING_PATTERN,
  LEGACY_SIBLING_PATTERN,
  discoverFixedCandidates,
  fingerprintTree,
  inspectCandidate,
  pathState
}
