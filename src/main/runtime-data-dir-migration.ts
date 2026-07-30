import {
  constants,
  copyFileSync,
  cpSync,
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CURRENT_KUN_DATA_DIR_TILDE,
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir,
  classifyCanonicalKunDataDir,
  type CanonicalKunDataDirKind
} from './kun-data-dir-paths'
import type { MigrationLogger } from './legacy-data-migration'
import { settingsReadCandidates } from './settings-file-paths'
import { ExtensionPaths } from '../../kun/src/extensions/paths.js'
import { validateRegistryDocument } from '../../kun/src/extensions/registry.js'

const JOURNAL_FILE_NAME = 'kun-runtime-data-migration-v2.json'
const REPORT_FILE_NAME = 'kun-runtime-data-migration-v2-report.json'
const PRESERVATION_JOURNAL_FILE_NAME = 'kun-runtime-data-migration-v3.json'
const PRESERVATION_REPORT_FILE_NAME = 'kun-runtime-data-migration-v3-report.json'
const SALVAGE_ROOTS = [
  'threads',
  'attachments',
  'artifacts',
  'child-runs',
  'delegated-sessions',
  'extensions',
  'extension-data',
  'memory',
  'task-graphs',
  'model-routing',
  'observability'
] as const
const PROTECTED_IDENTITY_ENTRIES = [
  'credentials',
  'mcp-oauth',
  'extensions/providers.json',
  'extensions/accounts.json',
  'extensions/provider-bindings.json',
  'extensions/legacy-credential-migrations.json',
  'secret.key'
] as const
const PROTECTED_EXTENSION_ENTRY_NAMES = new Set(
  PROTECTED_IDENTITY_ENTRIES
    .filter((entry) => entry.startsWith('extensions/'))
    .map((entry) => entry.slice('extensions/'.length))
)
const RETRYABLE_WINDOWS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const BEST_EFFORT_WINDOWS_FSYNC_CODES = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP'
])
const MIGRATION_SCHEMA_VERSION = 2 as const
const PRESERVATION_SCHEMA_VERSION = 3 as const
const COPY_CAPACITY_MIN_RESERVE_BYTES = 5 * 1024 * 1024 * 1024
const COPY_CAPACITY_SOURCE_RESERVE_RATIO = 0.1

type PathState = 'missing' | 'symlink' | 'dir' | 'other' | 'inaccessible'
type MigrationPhase =
  | 'prepared'
  | 'settings-backed-up'
  | 'destination-backed-up'
  | 'source-promoted'
  | 'rollback-conflict-planned'
  | 'rollback-conflict-backed-up'
  | 'rollback-source-restored'
  | 'link-created'
  | 'salvaged'
  | 'extension-registry-backed-up'
  | 'extension-registry-rebased'
  | 'settings-rewritten'
  | 'completed'
const MIGRATION_PHASES = new Set<MigrationPhase>([
  'prepared',
  'settings-backed-up',
  'destination-backed-up',
  'source-promoted',
  'rollback-conflict-planned',
  'rollback-conflict-backed-up',
  'rollback-source-restored',
  'link-created',
  'salvaged',
  'extension-registry-backed-up',
  'extension-registry-rebased',
  'settings-rewritten',
  'completed'
])
const ROLLBACK_PHASES = new Set<MigrationPhase>([
  'rollback-conflict-planned',
  'rollback-conflict-backed-up',
  'rollback-source-restored'
])

type RuntimeMigrationJournal = {
  schemaVersion: typeof MIGRATION_SCHEMA_VERSION
  phase: MigrationPhase
  sourcePath: string
  targetPath: string
  destinationBackupPath?: string
  cutoverConflictBackupPaths: string[]
  settingsSourcePath?: string
  settingsWritePath?: string
  settingsBackupPaths: string[]
  settingsBackedUp?: boolean
  extensionRegistryBackupPaths?: string[]
  extensionRegistryRebasedRecords?: number
  extensionRegistryRebasedAt?: string
  sourceWasMissing?: boolean
  sourceThreadIds: string[]
  sourceInventory?: RuntimeStoreInventory
  destinationInventory?: RuntimeStoreInventory
  targetInventory?: RuntimeStoreInventory
  sqliteQuickCheck?: 'missing' | 'ok' | 'invalid'
  salvaged: number
  conflicts: string[]
  startedAt: string
  updatedAt: string
  completedAt?: string
  runtimeVerifiedAt?: string
  error?: string
}

export type RuntimeDataDirMigrationResult = {
  status: 'not-needed' | 'completed' | 'blocked'
  authority: CanonicalKunDataDirKind | 'unknown'
  sourcePath: string
  targetPath: string
  destinationBackupPath?: string
  journalPath: string
  reportPath?: string
  message?: string
}

type RuntimeDataDirMigrationOptions = {
  userDataPath: string
  homeDir: string
  platform?: NodeJS.Platform
  log?: MigrationLogger
  now?: () => Date
  sleep?: (milliseconds: number) => void
  statDevice?: (path: string) => string | number | bigint
  assertLegacyRuntimeInactive?: (sourcePath: string) => void
  afterPhase?: (phase: MigrationPhase) => void
  afterPreservationPhase?: (phase: PreservationPhase) => void
  beforeCompatibilityLink?: () => void
  availableCopyBytes?: (path: string) => number
  /**
   * Keeps version-2 recovery coverage available without exposing rename-based
   * migration to production startup. New callers must never set this flag.
   */
  skipHistoryPreservationForTests?: boolean
}

type RuntimeStoreInventory = {
  files: number
  directories: number
  symlinks: number
  bytes: number
}

function isRuntimeStoreInventory(value: unknown): value is RuntimeStoreInventory {
  if (!isObjectRecord(value)) return false
  return Number.isSafeInteger(value.files) &&
    (value.files as number) >= 0 &&
    Number.isSafeInteger(value.directories) &&
    (value.directories as number) >= 0 &&
    Number.isSafeInteger(value.symlinks) &&
    (value.symlinks as number) >= 0 &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0
}

type PreservationPhase =
  | 'prepared'
  | 'settings-backed-up'
  | 'candidate-copied'
  | 'candidate-verified'
  | 'candidate-rebased'
  | 'destination-backed-up'
  | 'destination-salvaged'
  | 'target-activated'
  | 'settings-rewritten'
  | 'legacy-link-backed-up'
  | 'completed'

const PRESERVATION_PHASES = new Set<PreservationPhase>([
  'prepared',
  'settings-backed-up',
  'candidate-copied',
  'candidate-verified',
  'candidate-rebased',
  'destination-backed-up',
  'destination-salvaged',
  'target-activated',
  'settings-rewritten',
  'legacy-link-backed-up',
  'completed'
])

type PreservationProvenance =
  | 'original-legacy-source'
  | 'reconstructed-from-current'
  | 'no-legacy-source'

type PreservationJournal = {
  schemaVersion: typeof PRESERVATION_SCHEMA_VERSION
  phase: PreservationPhase
  provenance: PreservationProvenance
  sourcePath: string
  targetPath: string
  stagingPath: string
  destinationBackupPath?: string
  compatibilityLinkBackupPath?: string
  settingsSourcePath?: string
  settingsWritePath?: string
  settingsBackupPaths: string[]
  mergeIntoCurrent?: boolean
  sourceThreadIds: string[]
  sourceInventory: RuntimeStoreInventory
  sourceFingerprint?: string
  candidateFingerprint?: string
  extensionRegistryRebasedRecords?: number
  salvaged: number
  conflicts: string[]
  targetInventory?: RuntimeStoreInventory
  sqliteQuickCheck?: 'missing' | 'ok' | 'invalid'
  startedAt: string
  updatedAt: string
  completedAt?: string
  runtimeVerifiedAt?: string
  error?: string
}

type SettingsSelection = {
  authority: CanonicalKunDataDirKind | 'unknown'
  sourcePath?: string
  writePath?: string
}

function pathState(path: string): PathState {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'dir'
    return 'other'
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? 'missing' : 'inaccessible'
  }
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

export function retryRuntimeMigrationMutation(
  operation: () => void,
  options: { platform: NodeJS.Platform; sleep: (milliseconds: number) => void }
): void {
  const delays = options.platform === 'win32' ? [0, 50, 150, 350] : [0]
  let lastError: unknown
  for (const delay of delays) {
    options.sleep(delay)
    try {
      operation()
      return
    } catch (error) {
      lastError = error
      if (
        options.platform !== 'win32' ||
        !RETRYABLE_WINDOWS_CODES.has(errnoCode(error) ?? '')
      ) {
        throw error
      }
    }
  }
  throw lastError
}

export function canIgnoreRuntimeMigrationFsyncError(
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && BEST_EFFORT_WINDOWS_FSYNC_CODES.has(errnoCode(error) ?? '')
}

function fsyncFileBestEffort(handle: number): void {
  try {
    fsyncSync(handle)
  } catch (error) {
    if (canIgnoreRuntimeMigrationFsyncError(error)) return
    throw error
  }
}

function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncFileBestEffort(handle)
  } finally {
    closeSync(handle)
  }
  retryRuntimeMigrationMutation(
    () => renameSync(temporary, path),
    { platform: process.platform, sleep: defaultSleep }
  )
  fsyncDirectoryBestEffort(dirname(path))
}

function fsyncDirectoryBestEffort(path: string): void {
  try {
    const directoryHandle = openSync(path, 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  } catch {
    // Windows does not consistently allow opening directories for fsync.
  }
}

function fsyncRenameParents(sourcePath: string, targetPath: string): void {
  const sourceParent = dirname(sourcePath)
  const targetParent = dirname(targetPath)
  fsyncDirectoryBestEffort(sourceParent)
  if (targetParent !== sourceParent) fsyncDirectoryBestEffort(targetParent)
}

function readJournal(path: string): RuntimeMigrationJournal | null {
  if (pathState(path) !== 'other') return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeMigrationJournal>
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    const inventory = parsed.sourceInventory
    const cutoverConflictBackupPaths = parsed.cutoverConflictBackupPaths ?? []
    const extensionRegistryBackupPaths = parsed.extensionRegistryBackupPaths ?? []
    if (
      parsed.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
      typeof parsed.phase !== 'string' ||
      !MIGRATION_PHASES.has(parsed.phase as MigrationPhase) ||
      typeof parsed.sourcePath !== 'string' ||
      typeof parsed.targetPath !== 'string' ||
      (parsed.destinationBackupPath !== undefined && typeof parsed.destinationBackupPath !== 'string') ||
      !stringArray(cutoverConflictBackupPaths) ||
      (parsed.settingsSourcePath !== undefined && typeof parsed.settingsSourcePath !== 'string') ||
      (parsed.settingsWritePath !== undefined && typeof parsed.settingsWritePath !== 'string') ||
      !stringArray(parsed.settingsBackupPaths) ||
      (parsed.settingsBackedUp !== undefined && typeof parsed.settingsBackedUp !== 'boolean') ||
      !stringArray(extensionRegistryBackupPaths) ||
      (
        parsed.extensionRegistryRebasedRecords !== undefined &&
        (
          !Number.isSafeInteger(parsed.extensionRegistryRebasedRecords) ||
          parsed.extensionRegistryRebasedRecords < 0
        )
      ) ||
      (
        parsed.extensionRegistryRebasedAt !== undefined &&
        (
          typeof parsed.extensionRegistryRebasedAt !== 'string' ||
          Number.isNaN(Date.parse(parsed.extensionRegistryRebasedAt))
        )
      ) ||
      (parsed.sourceWasMissing !== undefined && typeof parsed.sourceWasMissing !== 'boolean') ||
      !stringArray(parsed.sourceThreadIds) ||
      (
        inventory !== undefined &&
        (
          typeof inventory !== 'object' ||
          inventory === null ||
          !Number.isSafeInteger(inventory.files) ||
          inventory.files < 0 ||
          !Number.isSafeInteger(inventory.directories) ||
          inventory.directories < 0 ||
          !Number.isSafeInteger(inventory.symlinks) ||
          inventory.symlinks < 0 ||
          !Number.isSafeInteger(inventory.bytes) ||
          inventory.bytes < 0
        )
      ) ||
      (
        parsed.destinationInventory !== undefined &&
        (
          typeof parsed.destinationInventory !== 'object' ||
          parsed.destinationInventory === null ||
          !Number.isSafeInteger(parsed.destinationInventory.files) ||
          parsed.destinationInventory.files < 0 ||
          !Number.isSafeInteger(parsed.destinationInventory.directories) ||
          parsed.destinationInventory.directories < 0 ||
          !Number.isSafeInteger(parsed.destinationInventory.symlinks) ||
          parsed.destinationInventory.symlinks < 0 ||
          !Number.isSafeInteger(parsed.destinationInventory.bytes) ||
          parsed.destinationInventory.bytes < 0
        )
      ) ||
      (
        parsed.targetInventory !== undefined &&
        (
          typeof parsed.targetInventory !== 'object' ||
          parsed.targetInventory === null ||
          !Number.isSafeInteger(parsed.targetInventory.files) ||
          parsed.targetInventory.files < 0 ||
          !Number.isSafeInteger(parsed.targetInventory.directories) ||
          parsed.targetInventory.directories < 0 ||
          !Number.isSafeInteger(parsed.targetInventory.symlinks) ||
          parsed.targetInventory.symlinks < 0 ||
          !Number.isSafeInteger(parsed.targetInventory.bytes) ||
          parsed.targetInventory.bytes < 0
        )
      ) ||
      (
        parsed.sqliteQuickCheck !== undefined &&
        parsed.sqliteQuickCheck !== 'missing' &&
        parsed.sqliteQuickCheck !== 'ok' &&
        parsed.sqliteQuickCheck !== 'invalid'
      ) ||
      !Number.isSafeInteger(parsed.salvaged) ||
      (parsed.salvaged ?? -1) < 0 ||
      !stringArray(parsed.conflicts) ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.updatedAt !== 'string' ||
      (parsed.completedAt !== undefined && typeof parsed.completedAt !== 'string') ||
      (parsed.runtimeVerifiedAt !== undefined && typeof parsed.runtimeVerifiedAt !== 'string') ||
      (parsed.error !== undefined && typeof parsed.error !== 'string')
    ) {
      return null
    }
    parsed.cutoverConflictBackupPaths = cutoverConflictBackupPaths
    parsed.extensionRegistryBackupPaths = extensionRegistryBackupPaths
    return parsed as RuntimeMigrationJournal
  } catch {
    return null
  }
}

function comparableFilesystemPath(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

function sameFilesystemPath(
  left: string | undefined,
  right: string | undefined,
  platform: NodeJS.Platform
): boolean {
  if (left === undefined || right === undefined) return left === right
  return comparableFilesystemPath(left, platform) === comparableFilesystemPath(right, platform)
}

function isMigrationOwnedSiblingBackup(
  backupPath: string,
  originalPath: string,
  label: string,
  platform: NodeJS.Platform
): boolean {
  if (!sameFilesystemPath(dirname(backupPath), dirname(originalPath), platform)) return false
  const expectedPrefix = `${basename(originalPath)}.${label}-`
  const candidateName = basename(backupPath)
  const comparableName = platform === 'win32'
    ? candidateName.toLocaleLowerCase('en-US')
    : candidateName
  const comparablePrefix = platform === 'win32'
    ? expectedPrefix.toLocaleLowerCase('en-US')
    : expectedPrefix
  const suffix = comparableName.slice(comparablePrefix.length, -4)
  return (
    comparableName.startsWith(comparablePrefix) &&
    comparableName.endsWith('.bak') &&
    /^\d{8}t\d{9}z(?:-\d+)?$/i.test(suffix)
  )
}

function validateJournalForRecovery(
  journal: RuntimeMigrationJournal,
  input: {
    userDataPath: string
    homeDir: string
    platform: NodeJS.Platform
  }
): string | null {
  const expectedSource = canonicalLegacyKunDataDir(input.homeDir, input.platform)
  const expectedTarget = canonicalCurrentKunDataDir(input.homeDir, input.platform)
  if (
    !sameFilesystemPath(journal.sourcePath, expectedSource, input.platform) ||
    !sameFilesystemPath(journal.targetPath, expectedTarget, input.platform)
  ) {
    return 'the Runtime migration journal contains non-canonical source or target paths'
  }
  if (
    journal.destinationBackupPath &&
    !isMigrationOwnedSiblingBackup(
      journal.destinationBackupPath,
      expectedTarget,
      'pre-deepseekgui-migration',
      input.platform
    )
  ) {
    return 'the Runtime migration journal contains an unsafe destination backup path'
  }
  if (journal.cutoverConflictBackupPaths.some((backupPath) =>
    !isMigrationOwnedSiblingBackup(
      backupPath,
      expectedSource,
      'cutover-conflict',
      input.platform
    ))) {
    return 'the Runtime migration journal contains an unsafe cutover-conflict backup path'
  }

  if (journal.settingsSourcePath) {
    const candidates = settingsReadCandidates(input.userDataPath)
    if (!candidates.some((candidate) =>
      sameFilesystemPath(candidate, journal.settingsSourcePath, input.platform))) {
      return 'the Runtime migration journal contains an unknown settings source path'
    }
  }
  if (journal.settingsWritePath && !journal.settingsSourcePath) {
    return 'the Runtime migration journal has a settings write path without a source path'
  }
  if (
    journal.settingsSourcePath &&
    journal.settingsWritePath &&
    !sameFilesystemPath(journal.settingsSourcePath, journal.settingsWritePath, input.platform) &&
    journal.phase !== 'completed'
  ) {
    try {
      if (
        !lstatSync(journal.settingsSourcePath).isSymbolicLink() ||
        !sameFilesystemPath(
          realpathSync(journal.settingsSourcePath),
          journal.settingsWritePath,
          input.platform
        )
      ) {
        return 'the Runtime migration journal settings symlink target is inconsistent'
      }
    } catch {
      return 'the Runtime migration journal settings symlink target is unavailable'
    }
  }
  const recognizedSettingsPaths = settingsReadCandidates(input.userDataPath)
  if (journal.settingsBackupPaths.some((backupPath) => {
    if (journal.settingsWritePath) {
      return !isMigrationOwnedSiblingBackup(
        backupPath,
        journal.settingsWritePath,
        'pre-runtime-data-migration',
        input.platform
      )
    }
    return !recognizedSettingsPaths.some((settingsPath) =>
      isMigrationOwnedSiblingBackup(
        backupPath,
        settingsPath,
        'pre-runtime-data-migration',
        input.platform
      ))
  })) {
    return 'the Runtime migration journal contains an unsafe settings backup path'
  }
  const extensionRegistryPath = join(expectedTarget, 'extensions', 'registry.json')
  if ((journal.extensionRegistryBackupPaths ?? []).some((backupPath) =>
    !isMigrationOwnedSiblingBackup(
      backupPath,
      extensionRegistryPath,
      'pre-runtime-extension-path-migration',
      input.platform
    ))) {
    return 'the Runtime migration journal contains an unsafe extension registry backup path'
  }
  if (journal.phase === 'completed' && !journal.completedAt) {
    return 'the Runtime migration journal completed phase has no completion timestamp'
  }
  if (
    (journal.phase === 'salvaged' ||
      journal.phase === 'extension-registry-backed-up' ||
      journal.phase === 'extension-registry-rebased' ||
      journal.phase === 'settings-rewritten' ||
      journal.phase === 'completed') &&
    journal.settingsBackedUp !== true
  ) {
    return 'the Runtime migration journal phase is inconsistent with settings backup state'
  }
  if (
    journal.phase === 'extension-registry-backed-up' &&
    (journal.extensionRegistryBackupPaths ?? []).length === 0
  ) {
    return 'the Runtime migration journal has no extension registry backup'
  }
  if (
    journal.phase === 'extension-registry-rebased' &&
    !journal.extensionRegistryRebasedAt
  ) {
    return 'the Runtime migration journal has no extension registry repair timestamp'
  }
  if (
    journal.phase === 'rollback-conflict-planned' &&
    journal.cutoverConflictBackupPaths.length === 0
  ) {
    return 'the Runtime migration rollback journal has no cutover-conflict backup path'
  }
  return null
}

function readPreservationJournal(path: string): PreservationJournal | null {
  if (pathState(path) !== 'other') return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PreservationJournal>
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    const inventory = parsed.sourceInventory
    const targetInventory = parsed.targetInventory
    if (
      parsed.schemaVersion !== PRESERVATION_SCHEMA_VERSION ||
      typeof parsed.phase !== 'string' ||
      !PRESERVATION_PHASES.has(parsed.phase as PreservationPhase) ||
      (
        parsed.provenance !== 'original-legacy-source' &&
        parsed.provenance !== 'reconstructed-from-current' &&
        parsed.provenance !== 'no-legacy-source'
      ) ||
      typeof parsed.sourcePath !== 'string' ||
      typeof parsed.targetPath !== 'string' ||
      typeof parsed.stagingPath !== 'string' ||
      (parsed.destinationBackupPath !== undefined && typeof parsed.destinationBackupPath !== 'string') ||
      (
        parsed.compatibilityLinkBackupPath !== undefined &&
        typeof parsed.compatibilityLinkBackupPath !== 'string'
      ) ||
      (parsed.settingsSourcePath !== undefined && typeof parsed.settingsSourcePath !== 'string') ||
      (parsed.settingsWritePath !== undefined && typeof parsed.settingsWritePath !== 'string') ||
      !stringArray(parsed.settingsBackupPaths) ||
      (parsed.mergeIntoCurrent !== undefined && typeof parsed.mergeIntoCurrent !== 'boolean') ||
      !stringArray(parsed.sourceThreadIds) ||
      !isRuntimeStoreInventory(inventory) ||
      (targetInventory !== undefined && !isRuntimeStoreInventory(targetInventory)) ||
      (
        parsed.sqliteQuickCheck !== undefined &&
        parsed.sqliteQuickCheck !== 'missing' &&
        parsed.sqliteQuickCheck !== 'ok' &&
        parsed.sqliteQuickCheck !== 'invalid'
      ) ||
      (parsed.sourceFingerprint !== undefined && typeof parsed.sourceFingerprint !== 'string') ||
      (parsed.candidateFingerprint !== undefined && typeof parsed.candidateFingerprint !== 'string') ||
      (
        parsed.extensionRegistryRebasedRecords !== undefined &&
        (
          !Number.isSafeInteger(parsed.extensionRegistryRebasedRecords) ||
          parsed.extensionRegistryRebasedRecords < 0
        )
      ) ||
      !Number.isSafeInteger(parsed.salvaged) ||
      (parsed.salvaged ?? -1) < 0 ||
      !stringArray(parsed.conflicts) ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.updatedAt !== 'string' ||
      (parsed.completedAt !== undefined && typeof parsed.completedAt !== 'string') ||
      (parsed.runtimeVerifiedAt !== undefined && typeof parsed.runtimeVerifiedAt !== 'string') ||
      (parsed.error !== undefined && typeof parsed.error !== 'string')
    ) {
      return null
    }
    return parsed as PreservationJournal
  } catch {
    return null
  }
}

function validatePreservationJournalForRecovery(
  journal: PreservationJournal,
  input: {
    userDataPath: string
    homeDir: string
    platform: NodeJS.Platform
  }
): string | null {
  const expectedLegacy = canonicalLegacyKunDataDir(input.homeDir, input.platform)
  const expectedCurrent = canonicalCurrentKunDataDir(input.homeDir, input.platform)
  const expectedSource =
    journal.provenance === 'reconstructed-from-current' ? expectedCurrent : expectedLegacy
  const stagingOriginal =
    journal.provenance === 'reconstructed-from-current' ? expectedLegacy : expectedCurrent
  if (
    !sameFilesystemPath(journal.sourcePath, expectedSource, input.platform) ||
    !sameFilesystemPath(journal.targetPath, expectedCurrent, input.platform)
  ) {
    return 'the Runtime preservation journal contains non-canonical source or target paths'
  }
  if (
    !isMigrationOwnedSiblingBackup(
      journal.stagingPath,
      stagingOriginal,
      'history-preserving-staging',
      input.platform
    )
  ) {
    return 'the Runtime preservation journal contains an unsafe staging path'
  }
  if (
    journal.destinationBackupPath &&
    !isMigrationOwnedSiblingBackup(
      journal.destinationBackupPath,
      expectedCurrent,
      'pre-history-preserving-migration',
      input.platform
    )
  ) {
    return 'the Runtime preservation journal contains an unsafe destination backup path'
  }
  if (
    journal.compatibilityLinkBackupPath &&
    !isMigrationOwnedSiblingBackup(
      journal.compatibilityLinkBackupPath,
      expectedLegacy,
      'pre-preservation-compatibility-link',
      input.platform
    )
  ) {
    return 'the Runtime preservation journal contains an unsafe compatibility-link backup path'
  }
  if (journal.settingsSourcePath) {
    const candidates = settingsReadCandidates(input.userDataPath)
    if (!candidates.some((candidate) =>
      sameFilesystemPath(candidate, journal.settingsSourcePath, input.platform))) {
      return 'the Runtime preservation journal contains an unknown settings source path'
    }
  }
  if (journal.settingsWritePath && !journal.settingsSourcePath) {
    return 'the Runtime preservation journal has a settings write path without a source path'
  }
  if (journal.settingsBackupPaths.some((backupPath) => {
    if (!journal.settingsWritePath) return true
    return !isMigrationOwnedSiblingBackup(
      backupPath,
      journal.settingsWritePath,
      'pre-runtime-data-migration',
      input.platform
    )
  })) {
    return 'the Runtime preservation journal contains an unsafe settings backup path'
  }
  if (journal.phase === 'completed' && !journal.completedAt) {
    return 'the Runtime preservation journal completed phase has no completion timestamp'
  }
  if (
    (
      journal.phase === 'candidate-verified' ||
      journal.phase === 'candidate-rebased' ||
      journal.phase === 'destination-backed-up' ||
      journal.phase === 'destination-salvaged' ||
      journal.phase === 'target-activated' ||
      journal.phase === 'settings-rewritten' ||
      journal.phase === 'legacy-link-backed-up' ||
      journal.phase === 'completed'
    ) &&
    (!journal.sourceFingerprint || !journal.candidateFingerprint)
  ) {
    return 'the Runtime preservation journal phase has no verified source fingerprint'
  }
  return null
}

function updatePreservationJournal(
  path: string,
  journal: PreservationJournal,
  patch: Partial<PreservationJournal>,
  now: () => Date
): PreservationJournal {
  const next: PreservationJournal = {
    ...journal,
    ...patch,
    updatedAt: now().toISOString()
  }
  writeDurableJson(path, next)
  return next
}

function updateJournal(
  path: string,
  journal: RuntimeMigrationJournal,
  patch: Partial<RuntimeMigrationJournal>,
  now: () => Date
): RuntimeMigrationJournal {
  const next: RuntimeMigrationJournal = {
    ...journal,
    ...patch,
    updatedAt: now().toISOString()
  }
  writeDurableJson(path, next)
  return next
}

function uniqueSiblingBackup(path: string, label: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')
  const parent = dirname(path)
  const name = basename(path)
  for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
    const suffix = ordinal === 0 ? '' : `-${ordinal}`
    const candidate = join(parent, `${name}.${label}-${stamp}${suffix}.bak`)
    if (pathState(candidate) === 'missing') return candidate
  }
  throw new Error(`could not allocate a unique migration backup path beside ${path}`)
}

function readSettingsSelection(
  userDataPath: string,
  homeDir: string,
  platform: NodeJS.Platform,
  legacyState: PathState
): SettingsSelection {
  for (const sourcePath of settingsReadCandidates(userDataPath)) {
    let raw: string
    try {
      raw = readFileSync(sourcePath, 'utf8')
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue
      return { authority: 'unknown' }
    }

    let metadata
    try {
      metadata = lstatSync(sourcePath)
    } catch {
      return { authority: 'unknown' }
    }

    let writePath = sourcePath
    try {
      if (metadata.isSymbolicLink()) {
        writePath = realpathSync(sourcePath)
        if (!statSync(writePath).isFile()) return { authority: 'unknown' }
      } else if (!metadata.isFile()) {
        return { authority: 'unknown' }
      }
    } catch {
      return { authority: 'unknown' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // JsonSettingsStore will back up and replace invalid settings after this
      // startup migration. Prefer the only existing canonical Runtime store so
      // that repair does not strand historical data behind the new default.
      return { authority: legacyState === 'dir' ? 'legacy' : 'current' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { authority: legacyState === 'dir' ? 'legacy' : 'current' }
    }
    const agents = (parsed as Record<string, unknown>).agents
    const kun = typeof agents === 'object' && agents !== null && !Array.isArray(agents)
      ? (agents as Record<string, unknown>).kun
      : undefined
    const dataDir = typeof kun === 'object' && kun !== null && !Array.isArray(kun)
      ? (kun as Record<string, unknown>).dataDir
      : undefined
    if (typeof dataDir === 'string' && dataDir.trim()) {
      return {
        authority: classifyCanonicalKunDataDir(dataDir, { homeDir, platform }),
        sourcePath,
        writePath
      }
    }
    // Older settings without agents.kun came from a profile whose Runtime data
    // lived in the canonical legacy directory.
    return {
      authority: legacyState === 'dir' ? 'legacy' : 'current',
      sourcePath,
      writePath
    }
  }
  return { authority: legacyState === 'dir' ? 'legacy' : 'current' }
}

function listChildNames(path: string): string[] {
  if (pathState(path) !== 'dir') return []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

function threadIds(dataDir: string): string[] {
  return listChildNames(join(dataDir, 'threads'))
}

function runtimeStoreInventory(dataDir: string): RuntimeStoreInventory {
  const inventory: RuntimeStoreInventory = {
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0
  }
  if (pathState(dataDir) === 'missing') return inventory
  if (pathState(dataDir) !== 'dir') {
    throw new Error(`Runtime store inventory root is not a directory: ${dataDir}`)
  }
  const pending = [dataDir]
  while (pending.length > 0) {
    const current = pending.pop()!
    inventory.directories += 1
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) {
        inventory.symlinks += 1
        inventory.bytes += metadata.size
      } else if (metadata.isDirectory()) {
        pending.push(path)
      } else {
        inventory.files += 1
        inventory.bytes += metadata.size
      }
    }
  }
  return inventory
}

function inventoriesEqual(
  left: RuntimeStoreInventory,
  right: RuntimeStoreInventory
): boolean {
  return left.files === right.files &&
    left.directories === right.directories &&
    left.symlinks === right.symlinks &&
    left.bytes === right.bytes
}

type RuntimeTreeFingerprint = {
  fingerprint: string
  inventory: RuntimeStoreInventory
  threadIds: string[]
}

function hashRegularFile(path: string): string {
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

function canonicalRelativePath(rootPath: string, entryPath: string): string {
  const value = relative(rootPath, entryPath)
  return value === '' ? '.' : value.split(sep).join('/')
}

function runtimeTreeFingerprint(rootPath: string): RuntimeTreeFingerprint {
  if (pathState(rootPath) !== 'dir') {
    throw new Error(`Runtime fingerprint root is not a directory: ${rootPath}`)
  }
  const hash = createHash('sha256')
  const inventory: RuntimeStoreInventory = {
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0
  }
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
      hash.update(
        `dir\0${relativePath}\0${metadata.mode & 0o7777}\0`
      )
      for (const name of readdirSync(entryPath).sort()) {
        visit(join(entryPath, name))
      }
      return
    }
    if (metadata.isFile()) {
      inventory.files += 1
      inventory.bytes += metadata.size
      hash.update(
        `file\0${relativePath}\0${metadata.mode & 0o7777}\0${metadata.size}\0` +
        `${hashRegularFile(entryPath)}\0`
      )
      return
    }
    throw new Error(`Runtime tree contains an unsupported entry: ${entryPath}`)
  }
  visit(rootPath)
  return {
    fingerprint: hash.digest('hex'),
    inventory,
    threadIds: threadIds(rootPath)
  }
}

function assertRuntimeTreeTimestampsPreserved(
  sourcePath: string,
  candidatePath: string
): void {
  const source = lstatSync(sourcePath)
  const candidate = lstatSync(candidatePath)
  if (
    (source.isDirectory() || source.isFile()) &&
    Math.abs(source.mtimeMs - candidate.mtimeMs) > 2000
  ) {
    throw new Error(
      `history-preserving Runtime candidate timestamp differs: ${candidatePath}`
    )
  }
  if (!source.isDirectory()) return
  for (const name of readdirSync(sourcePath).sort()) {
    assertRuntimeTreeTimestampsPreserved(
      join(sourcePath, name),
      join(candidatePath, name)
    )
  }
}

function availableFilesystemBytes(path: string): number {
  const stats = statfsSync(path, { bigint: true })
  const bytes = stats.bavail * stats.bsize
  return bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bytes)
}

function assertCandidateCopyCapacity(
  sourceInventory: RuntimeStoreInventory,
  stagingPath: string,
  availableBytes: (path: string) => number = availableFilesystemBytes,
  additionalCopyBytes = 0
): void {
  mkdirSync(dirname(stagingPath), { recursive: true, mode: 0o700 })
  const copyBytes = sourceInventory.bytes + additionalCopyBytes
  const reserve = Math.max(
    COPY_CAPACITY_MIN_RESERVE_BYTES,
    Math.ceil(copyBytes * COPY_CAPACITY_SOURCE_RESERVE_RATIO)
  )
  const required = copyBytes + reserve
  const available = availableBytes(dirname(stagingPath))
  if (available < required) {
    throw new Error(
      `insufficient capacity for history-preserving Runtime copy: ` +
      `requires up to ${copyBytes} bytes for authoritative and displaced history plus ` +
      `${reserve} bytes of safety reserve, ${available} bytes available`
    )
  }
}

function sameRegularFileContent(left: string, right: string): boolean {
  const leftMetadata = lstatSync(left)
  const rightMetadata = lstatSync(right)
  return leftMetadata.isFile() &&
    rightMetadata.isFile() &&
    leftMetadata.size === rightMetadata.size &&
    hashRegularFile(left) === hashRegularFile(right)
}

function copyRegularFilePreservingMetadata(sourcePath: string, targetPath: string): void {
  const sourceMetadata = lstatSync(sourcePath)
  const targetState = pathState(targetPath)
  if (targetState !== 'missing') {
    if (targetState === 'other' && sameRegularFileContent(sourcePath, targetPath)) {
      chmodSync(targetPath, sourceMetadata.mode & 0o7777)
      utimesSync(targetPath, sourceMetadata.atime, sourceMetadata.mtime)
      return
    }
    if (targetState === 'other' && lstatSync(targetPath).isFile()) {
      // The staging directory is migration-owned. A mismatched partial file
      // cannot be user authority and must not prevent deterministic resume.
      unlinkSync(targetPath)
    } else {
      throw new Error(`candidate copy target has an unexpected entry: ${targetPath}`)
    }
  }

  const partialPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.kun-copy-partial-${randomUUID()}`
  )
  try {
    copyFileSync(
      sourcePath,
      partialPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
    )
    chmodSync(partialPath, sourceMetadata.mode & 0o7777)
    utimesSync(partialPath, sourceMetadata.atime, sourceMetadata.mtime)
    // Source files may intentionally be read-only. A read descriptor is
    // sufficient for fsync and avoids requiring write permission after the
    // exact source mode has been restored on the staged file.
    const handle = openSync(partialPath, 'r')
    try {
      fsyncFileBestEffort(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(partialPath, targetPath)
    fsyncDirectoryBestEffort(dirname(targetPath))
  } catch (error) {
    if (pathState(partialPath) === 'other') unlinkSync(partialPath)
    throw error
  }
}

function copyRuntimeTreePreservingSource(sourcePath: string, targetPath: string): void {
  const sourceMetadata = lstatSync(sourcePath)
  if (!sourceMetadata.isDirectory()) {
    throw new Error(`Runtime copy source is not a directory: ${sourcePath}`)
  }
  const targetState = pathState(targetPath)
  if (targetState === 'missing') {
    mkdirSync(targetPath, {
      recursive: false,
      // Some Runtime trees intentionally contain immutable extension package
      // directories. Staging must remain writable until every child is copied;
      // the exact source mode is restored after the directory is complete.
      mode: (sourceMetadata.mode & 0o7777) | 0o700
    })
  } else if (targetState !== 'dir') {
    throw new Error(`Runtime copy target is not a directory: ${targetPath}`)
  } else {
    chmodSync(targetPath, (sourceMetadata.mode & 0o7777) | 0o700)
  }

  for (const targetName of readdirSync(targetPath)) {
    if (!/^\..+\.kun-copy-partial-[0-9a-f-]+$/i.test(targetName)) continue
    const partialPath = join(targetPath, targetName)
    if (pathState(partialPath) === 'other' && lstatSync(partialPath).isFile()) {
      unlinkSync(partialPath)
    }
  }

  for (const name of readdirSync(sourcePath).sort()) {
    const sourceEntry = join(sourcePath, name)
    const targetEntry = join(targetPath, name)
    const metadata = lstatSync(sourceEntry)
    if (metadata.isDirectory()) {
      copyRuntimeTreePreservingSource(sourceEntry, targetEntry)
      continue
    }
    if (metadata.isSymbolicLink()) {
      const linkTarget = readlinkSync(sourceEntry)
      const state = pathState(targetEntry)
      if (state === 'missing') {
        symlinkSync(linkTarget, targetEntry)
      } else if (state !== 'symlink' || readlinkSync(targetEntry) !== linkTarget) {
        throw new Error(`candidate copy contains a different symbolic link: ${targetEntry}`)
      }
      continue
    }
    if (metadata.isFile()) {
      copyRegularFilePreservingMetadata(sourceEntry, targetEntry)
      continue
    }
    throw new Error(`Runtime source contains an unsupported entry: ${sourceEntry}`)
  }
  chmodSync(targetPath, sourceMetadata.mode & 0o7777)
  utimesSync(targetPath, sourceMetadata.atime, sourceMetadata.mtime)
  fsyncDirectoryBestEffort(targetPath)
}

function inventoryContains(
  actual: RuntimeStoreInventory,
  expected: RuntimeStoreInventory
): boolean {
  return (
    actual.files >= expected.files &&
    actual.directories >= expected.directories &&
    actual.symlinks >= expected.symlinks &&
    actual.bytes >= expected.bytes
  )
}

function assertStoreInventoryContains(
  path: string,
  expected: RuntimeStoreInventory | undefined,
  description: string
): void {
  if (!expected) return
  if (!inventoryContains(runtimeStoreInventory(path), expected)) {
    throw new Error(`${description} inventory is smaller than the migration journal inventory`)
  }
}

function validateSqliteIndex(dataDir: string): 'missing' | 'ok' | 'invalid' {
  const sqlitePath = join(dataDir, 'index.sqlite3')
  const state = pathState(sqlitePath)
  if (state === 'missing') return 'missing'
  if (state !== 'other' && state !== 'symlink') {
    throw new Error(`Runtime SQLite index is not a regular file: ${sqlitePath}`)
  }

  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(sqlitePath, {
      open: true,
      readOnly: true
    })
    const result = database.prepare('PRAGMA quick_check').get() as
      | { quick_check?: unknown }
      | undefined
    return result?.quick_check === 'ok' ? 'ok' : 'invalid'
  } catch {
    // The SQLite index is explicitly rebuildable from thread JSONL. Record the
    // failed validation without deleting or replacing the user's index bytes;
    // Runtime startup falls back to filesystem enumeration.
    return 'invalid'
  } finally {
    try {
      database?.close()
    } catch {
      // Validation is advisory for the rebuildable index.
    }
  }
}

function assertSameVolume(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  statDevice: (path: string) => string | number | bigint
): void {
  const targetAncestor = nearestExistingDirectory(dirname(targetPath))
  if (statDevice(sourcePath) !== statDevice(targetAncestor)) {
    const error = new Error(
      `Kun Runtime data migration requires a same-volume atomic directory move: ${sourcePath} -> ${targetPath}`
    ) as NodeJS.ErrnoException
    error.code = 'EXDEV'
    throw error
  }
  if (platform === 'win32') {
    const sourceRoot = sourcePath.replace(/\//g, '\\').match(/^[a-zA-Z]:\\/)?.[0]?.toLowerCase()
    const targetRoot = targetPath.replace(/\//g, '\\').match(/^[a-zA-Z]:\\/)?.[0]?.toLowerCase()
    if (sourceRoot && targetRoot && sourceRoot !== targetRoot) {
      const error = new Error('Windows directory migration cannot cross volumes') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    }
  }
}

function nearestExistingDirectory(path: string): string {
  let candidate = path
  while (true) {
    if (pathState(candidate) === 'dir') return candidate
    const parent = dirname(candidate)
    if (parent === candidate) {
      throw new Error(`could not resolve an existing directory above ${path}`)
    }
    candidate = parent
  }
}

function linkResolvesToTarget(linkPath: string, targetPath: string, platform: NodeJS.Platform): boolean {
  if (pathState(linkPath) !== 'symlink' || pathState(targetPath) !== 'dir') return false
  try {
    const actual = realpathSync(linkPath)
    const expected = realpathSync(targetPath)
    return platform === 'win32'
      ? actual.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
      : actual === expected
  } catch {
    return false
  }
}

function createAndVerifyCompatibilityLink(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  sleep: (milliseconds: number) => void
): void {
  if (pathState(sourcePath) === 'symlink') {
    if (linkResolvesToTarget(sourcePath, targetPath, platform)) return
    throw new Error(`legacy Runtime path is an unexpected link: ${sourcePath}`)
  }
  if (pathState(sourcePath) !== 'missing') {
    throw new Error(`legacy Runtime path is not clear for compatibility link: ${sourcePath}`)
  }
  mkdirSync(dirname(sourcePath), { recursive: true, mode: 0o700 })
  retryRuntimeMigrationMutation(
    () => symlinkSync(targetPath, sourcePath, platform === 'win32' ? 'junction' : 'dir'),
    { platform, sleep }
  )
  if (!linkResolvesToTarget(sourcePath, targetPath, platform)) {
    if (pathState(sourcePath) === 'symlink') unlinkSync(sourcePath)
    throw new Error(`failed to verify compatibility link ${sourcePath} -> ${targetPath}`)
  }
}

function backUpSettingsFile(
  settingsWritePath: string | undefined,
  now: () => Date
): string[] {
  if (!settingsWritePath) return []
  return [backUpRegularFile(
    settingsWritePath,
    'pre-runtime-data-migration',
    now,
    'active settings file'
  )]
}

function backUpRegularFile(
  path: string,
  label: string,
  now: () => Date,
  description: string
): string {
  if (pathState(path) !== 'other' || !lstatSync(path).isFile()) {
    throw new Error(`${description} is unavailable: ${path}`)
  }
  const backupPath = uniqueSiblingBackup(path, label, now)
  copyFileSync(path, backupPath, constants.COPYFILE_EXCL)
  try {
    chmodSync(backupPath, 0o600)
  } catch {
    // Windows ACLs are not represented by POSIX mode bits.
  }
  const backupHandle = openSync(backupPath, 'r+')
  try {
    fsyncFileBestEffort(backupHandle)
  } finally {
    closeSync(backupHandle)
  }
  try {
    const directoryHandle = openSync(dirname(backupPath), 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  } catch {
    // Windows does not consistently allow opening directories for fsync.
  }
  return backupPath
}

function rewriteSettingsToCurrent(settingsWritePath: string | undefined): void {
  if (!settingsWritePath) return
  const state = pathState(settingsWritePath)
  if (state !== 'other') {
    throw new Error(`active settings file is unavailable: ${settingsWritePath}`)
  }
  const raw = readFileSync(settingsWritePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`settings file is not an object: ${settingsWritePath}`)
  }
  const root = parsed as Record<string, unknown>
  const agents = typeof root.agents === 'object' && root.agents !== null && !Array.isArray(root.agents)
    ? root.agents as Record<string, unknown>
    : {}
  const kun = typeof agents.kun === 'object' && agents.kun !== null && !Array.isArray(agents.kun)
    ? agents.kun as Record<string, unknown>
    : {}
  const next = {
    ...root,
    agents: {
      ...agents,
      kun: {
        ...kun,
        dataDir: CURRENT_KUN_DATA_DIR_TILDE
      }
    }
  }
  writeDurableJson(settingsWritePath, next)
}

type ExtensionRegistryRebaseInspection =
  | { kind: 'missing' }
  | {
      kind: 'registry'
      path: string
      document: Record<string, unknown>
      rebasedRecords: number
    }

function inspectExtensionRegistryForRebase(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  registryDataPath = targetPath
): ExtensionRegistryRebaseInspection {
  const registryPath = join(registryDataPath, 'extensions', 'registry.json')
  const state = pathState(registryPath)
  if (state === 'missing') return { kind: 'missing' }
  if (state !== 'other' || !lstatSync(registryPath).isFile()) {
    throw new Error(`extension registry is not a regular file: ${registryPath}`)
  }

  let document: unknown
  try {
    document = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `extension registry is not valid JSON at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!isObjectRecord(document) || !isObjectRecord(document.extensions)) {
    throw new Error(`extension registry has an invalid root shape: ${registryPath}`)
  }

  const legacyPaths = new ExtensionPaths({ packageRoot: join(sourcePath, 'extensions') })
  const currentPaths = new ExtensionPaths({ packageRoot: join(targetPath, 'extensions') })
  let rebasedRecords = 0

  for (const [extensionId, rawEntry] of Object.entries(document.extensions)) {
    if (!isObjectRecord(rawEntry) || rawEntry.id !== extensionId || !isObjectRecord(rawEntry.versions)) {
      throw new Error(`extension registry entry has an invalid shape: ${extensionId}`)
    }
    for (const [version, rawVersion] of Object.entries(rawEntry.versions)) {
      if (!isObjectRecord(rawVersion) || rawVersion.version !== version) {
        throw new Error(`extension registry version has an invalid shape: ${extensionId}@${version}`)
      }
      let legacyPackagePath: string
      let currentPackagePath: string
      try {
        legacyPackagePath = legacyPaths.packageVersion(extensionId, version)
        currentPackagePath = currentPaths.packageVersion(extensionId, version)
      } catch (error) {
        throw new Error(
          `extension registry identity is unsafe: ${extensionId}@${version}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      if (typeof rawVersion.packagePath !== 'string') {
        throw new Error(`extension registry packagePath is missing: ${extensionId}@${version}`)
      }
      if (
        !sameFilesystemPath(rawVersion.packagePath, legacyPackagePath, platform) &&
        !sameFilesystemPath(rawVersion.packagePath, currentPackagePath, platform)
      ) {
        throw new Error(
          `extension registry packagePath is outside the canonical migration roots: ` +
          `${extensionId}@${version} (${rawVersion.packagePath})`
        )
      }
      if (rawVersion.packagePath !== currentPackagePath) {
        rawVersion.packagePath = currentPackagePath
        rebasedRecords += 1
      }
    }
  }

  try {
    // The Runtime validator normalizes a narrow legacy manifest shape while
    // validating. Validate a clone so this migration changes packagePath only.
    validateRegistryDocument(structuredClone(document), currentPaths)
  } catch (error) {
    throw new Error(
      `extension registry remains invalid after canonical path rebasing at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  return {
    kind: 'registry',
    path: registryPath,
    document,
    rebasedRecords
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function prepareExtensionRegistryRebase(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  }
): RuntimeMigrationJournal {
  let journal = initialJournal
  const inspection = inspectExtensionRegistryForRebase(
    journal.sourcePath,
    journal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing' || inspection.rebasedRecords === 0) {
    journal = updateJournal(
      journalPath,
      journal,
      {
        phase: 'extension-registry-rebased',
        extensionRegistryRebasedRecords: 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
    options.afterPhase('extension-registry-rebased')
    return journal
  }

  const existingBackups = journal.extensionRegistryBackupPaths ?? []
  const backupPath = existingBackups.length > 0
    ? undefined
    : backUpRegularFile(
        inspection.path,
        'pre-runtime-extension-path-migration',
        options.now,
        'extension registry'
      )
  journal = updateJournal(
    journalPath,
    journal,
    {
      phase: 'extension-registry-backed-up',
      extensionRegistryBackupPaths: backupPath
        ? [...existingBackups, backupPath]
        : existingBackups,
      // Persist the intended count before rewriting. If the process exits
      // after the atomic rename but before the next journal update, recovery
      // sees a canonical registry and can still report the completed work.
      extensionRegistryRebasedRecords: inspection.rebasedRecords,
      error: undefined
    },
    options.now
  )
  options.afterPhase('extension-registry-backed-up')
  return journal
}

function commitExtensionRegistryRebase(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  }
): RuntimeMigrationJournal {
  const inspection = inspectExtensionRegistryForRebase(
    initialJournal.sourcePath,
    initialJournal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing') {
    throw new Error('extension registry disappeared after its migration backup was recorded')
  }
  if (inspection.rebasedRecords > 0) {
    writeDurableJson(inspection.path, inspection.document)
  }
  const rebasedRecords =
    inspection.rebasedRecords > 0
      ? inspection.rebasedRecords
      : initialJournal.extensionRegistryRebasedRecords ?? 0
  const journal = updateJournal(
    journalPath,
    initialJournal,
    {
      phase: 'extension-registry-rebased',
      extensionRegistryRebasedRecords: rebasedRecords,
      extensionRegistryRebasedAt: options.now().toISOString(),
      error: undefined
    },
    options.now
  )
  options.afterPhase('extension-registry-rebased')
  return journal
}

function repairCompletedExtensionRegistry(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    now: () => Date
  }
): RuntimeMigrationJournal {
  let journal = initialJournal
  const inspection = inspectExtensionRegistryForRebase(
    journal.sourcePath,
    journal.targetPath,
    options.platform
  )
  if (inspection.kind === 'missing') {
    if (journal.extensionRegistryRebasedAt) return journal
    return updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryRebasedRecords: 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
  }
  if (inspection.rebasedRecords === 0) {
    if (journal.extensionRegistryRebasedAt) return journal
    return updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords ?? 0,
        extensionRegistryRebasedAt: options.now().toISOString(),
        error: undefined
      },
      options.now
    )
  }

  const existingBackups = journal.extensionRegistryBackupPaths ?? []
  if (existingBackups.length === 0) {
    const backupPath = backUpRegularFile(
      inspection.path,
      'pre-runtime-extension-path-migration',
      options.now,
      'extension registry'
    )
    journal = updateJournal(
      journalPath,
      journal,
      {
        extensionRegistryBackupPaths: [backupPath],
        extensionRegistryRebasedRecords: inspection.rebasedRecords,
        error: undefined
      },
      options.now
    )
  }
  writeDurableJson(inspection.path, inspection.document)
  return updateJournal(
    journalPath,
    journal,
    {
      extensionRegistryRebasedRecords:
        inspection.rebasedRecords > 0
          ? inspection.rebasedRecords
          : journal.extensionRegistryRebasedRecords ?? 0,
      extensionRegistryRebasedAt: options.now().toISOString(),
      error: undefined
    },
    options.now
  )
}

function salvageDestinationBackup(
  backupPath: string | undefined,
  targetPath: string,
  options: {
    platform: NodeJS.Platform
    sleep: (milliseconds: number) => void
  }
): { salvaged: number; conflicts: string[] } {
  if (!backupPath || pathState(backupPath) !== 'dir') {
    return { salvaged: 0, conflicts: [] }
  }
  let salvaged = 0
  const conflicts: string[] = []
  const protectedSources = PROTECTED_IDENTITY_ENTRIES
    .map((relativePath) => ({
      relativePath,
      source: join(backupPath, ...relativePath.split('/')),
      target: join(targetPath, ...relativePath.split('/'))
    }))
    .filter(({ source }) => pathState(source) !== 'missing')
  if (protectedSources.length > 0) {
    const protectedSourcePaths = new Set(
      protectedSources.map(({ relativePath }) => relativePath)
    )
    const targetHasUnpairedProtectedIdentity = PROTECTED_IDENTITY_ENTRIES.some(
      (relativePath) =>
        !protectedSourcePaths.has(relativePath) &&
        pathState(join(targetPath, ...relativePath.split('/'))) !== 'missing'
    )
    const targetHasDifferentProtectedIdentity = protectedSources.some(
      ({ source, target }) =>
        pathState(target) !== 'missing' &&
        !salvageTreesEqual(source, target)
    )
    const protectedSourcesAreSafe = protectedSources.every(
      ({ source }) => isSafeSalvageTree(source)
    )
    if (
      targetHasUnpairedProtectedIdentity ||
      targetHasDifferentProtectedIdentity ||
      !protectedSourcesAreSafe
    ) {
      conflicts.push(...protectedSources.map(({ relativePath }) => relativePath))
    } else {
      for (const { relativePath, source, target } of protectedSources) {
        if (pathState(target) !== 'missing') continue
        const stagingRoot = join(
          targetPath,
          '.kun-runtime-migration-staging',
          'protected-identity'
        )
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
        const temporary = join(stagingRoot, `${basename(relativePath)}-${randomUUID()}.tmp`)
        const metadata = lstatSync(source)
        cpSync(source, temporary, {
          recursive: metadata.isDirectory(),
          preserveTimestamps: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true
        })
        retryRuntimeMigrationMutation(
          () => renameSync(temporary, target),
          options
        )
        fsyncRenameParents(temporary, target)
        salvaged += 1
      }
    }
  }
  for (const rootName of SALVAGE_ROOTS) {
    const sourceRoot = join(backupPath, rootName)
    if (pathState(sourceRoot) !== 'dir') continue
    const targetRoot = join(targetPath, rootName)
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (rootName === 'threads' && !entry.isDirectory()) continue
      if (rootName === 'extensions' && PROTECTED_EXTENSION_ENTRY_NAMES.has(entry.name)) {
        continue
      }
      const source = join(sourceRoot, entry.name)
      const target = join(targetRoot, entry.name)
      if (pathState(target) !== 'missing') {
        conflicts.push(`${rootName}/${entry.name}`)
        continue
      }
      if (
        (!entry.isFile() && !entry.isDirectory()) ||
        !isSafeSalvageTree(source)
      ) {
        conflicts.push(`${rootName}/${entry.name}`)
        continue
      }
      const stagingRoot = join(targetPath, '.kun-runtime-migration-staging', rootName)
      mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
      const temporary = join(
        stagingRoot,
        `${entry.name}-${randomUUID()}.tmp`
      )
      cpSync(source, temporary, {
        recursive: entry.isDirectory(),
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true
      })
      retryRuntimeMigrationMutation(
        () => renameSync(temporary, target),
        options
      )
      fsyncRenameParents(temporary, target)
      salvaged += 1
    }
  }
  return { salvaged, conflicts: conflicts.sort() }
}

function isSafeSalvageTree(path: string): boolean {
  const metadata = lstatSync(path)
  if (metadata.isFile()) return true
  if (!metadata.isDirectory()) return false
  return readdirSync(path).every((name) => isSafeSalvageTree(join(path, name)))
}

function salvageTreesEqual(left: string, right: string): boolean {
  try {
    const leftMetadata = lstatSync(left)
    const rightMetadata = lstatSync(right)
    if (leftMetadata.isFile() && rightMetadata.isFile()) {
      return leftMetadata.size === rightMetadata.size &&
        readFileSync(left).equals(readFileSync(right))
    }
    if (!leftMetadata.isDirectory() || !rightMetadata.isDirectory()) return false
    const leftNames = readdirSync(left).sort()
    const rightNames = readdirSync(right).sort()
    return leftNames.length === rightNames.length &&
      leftNames.every((name, index) =>
        name === rightNames[index] &&
        salvageTreesEqual(join(left, name), join(right, name))
      )
  } catch {
    return false
  }
}

function validatePromotedStore(
  journal: RuntimeMigrationJournal,
  platform: NodeJS.Platform
): {
  targetInventory: RuntimeStoreInventory
  sqliteQuickCheck: 'missing' | 'ok' | 'invalid'
} {
  if (pathState(journal.targetPath) !== 'dir') {
    throw new Error(`promoted Runtime target is unavailable: ${journal.targetPath}`)
  }
  if (!linkResolvesToTarget(journal.sourcePath, journal.targetPath, platform)) {
    throw new Error('legacy compatibility path does not resolve to the promoted Runtime store')
  }
  const migratedThreadIds = new Set(threadIds(journal.targetPath))
  const missing = journal.sourceThreadIds.filter((threadId) => !migratedThreadIds.has(threadId))
  if (missing.length > 0) {
    throw new Error(`promoted Runtime store is missing ${missing.length} legacy thread directories`)
  }
  const configPath = join(journal.targetPath, 'config.json')
  const configState = pathState(configPath)
  if (configState === 'other' || configState === 'symlink') {
    JSON.parse(readFileSync(configPath, 'utf8'))
  } else if (configState !== 'missing') {
    throw new Error(`promoted Runtime config is not a readable file: ${configPath}`)
  }
  const targetInventory = runtimeStoreInventory(journal.targetPath)
  if (
    journal.sourceInventory &&
    !inventoryContains(targetInventory, journal.sourceInventory)
  ) {
    throw new Error('promoted Runtime inventory is smaller than the authoritative source inventory')
  }
  if (journal.destinationBackupPath && journal.destinationInventory) {
    if (pathState(journal.destinationBackupPath) !== 'dir') {
      throw new Error('displaced Runtime destination backup is unavailable')
    }
    assertStoreInventoryContains(
      journal.destinationBackupPath,
      journal.destinationInventory,
      'displaced Runtime destination backup'
    )
  }
  return {
    targetInventory,
    sqliteQuickCheck: validateSqliteIndex(journal.targetPath)
  }
}

function writeReport(
  userDataPath: string,
  journal: RuntimeMigrationJournal
): string {
  const reportPath = join(userDataPath, REPORT_FILE_NAME)
  writeDurableJson(reportPath, {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    status: journal.phase,
    sourcePath: journal.sourcePath,
    targetPath: journal.targetPath,
    destinationBackupPath: journal.destinationBackupPath,
    cutoverConflictBackupPaths: journal.cutoverConflictBackupPaths,
    settingsSourcePath: journal.settingsSourcePath,
    settingsBackupPaths: journal.settingsBackupPaths,
    settingsBackedUp: journal.settingsBackedUp === true,
    extensionRegistryBackupPaths: journal.extensionRegistryBackupPaths ?? [],
    extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords,
    extensionRegistryRebasedAt: journal.extensionRegistryRebasedAt,
    sourceThreadCount: journal.sourceThreadIds.length,
    sourceInventory: journal.sourceInventory,
    destinationInventory: journal.destinationInventory,
    targetInventory: journal.targetInventory,
    sqliteQuickCheck: journal.sqliteQuickCheck,
    salvaged: journal.salvaged,
    conflicts: journal.conflicts,
    completedAt: journal.completedAt,
    runtimeVerifiedAt: journal.runtimeVerifiedAt
  })
  return reportPath
}

function assertSettingsSelectionStable(
  journal: RuntimeMigrationJournal,
  options: {
    userDataPath: string
    homeDir: string
    platform: NodeJS.Platform
  }
): void {
  const current = readSettingsSelection(
    options.userDataPath,
    options.homeDir,
    options.platform,
    pathState(journal.sourcePath)
  )
  if (
    !sameFilesystemPath(current.sourcePath, journal.settingsSourcePath, options.platform) ||
    !sameFilesystemPath(current.writePath, journal.settingsWritePath, options.platform)
  ) {
    throw new Error('the active settings source changed while Runtime migration was in progress')
  }
}

function restoreDestinationBackup(
  journal: RuntimeMigrationJournal,
  platform: NodeJS.Platform,
  sleep: (milliseconds: number) => void
): void {
  if (
    journal.destinationBackupPath &&
    pathState(journal.destinationBackupPath) === 'dir' &&
    pathState(journal.targetPath) === 'missing'
  ) {
    retryRuntimeMigrationMutation(
      () => renameSync(journal.destinationBackupPath!, journal.targetPath),
      { platform, sleep }
    )
  }
}

function finishPromotedDirectoryRollback(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    sleep: (milliseconds: number) => void
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  }
): RuntimeMigrationJournal {
  let journal = initialJournal

  if (journal.phase === 'rollback-conflict-planned') {
    const conflictBackupPath = journal.cutoverConflictBackupPaths.at(-1)
    if (!conflictBackupPath) {
      throw new Error('rollback journal has no planned cutover-conflict backup path')
    }
    const sourceState = pathState(journal.sourcePath)
    const conflictState = pathState(conflictBackupPath)
    if (sourceState !== 'missing' && conflictState === 'missing') {
      retryRuntimeMigrationMutation(
        () => renameSync(journal.sourcePath, conflictBackupPath),
        { platform: options.platform, sleep: options.sleep }
      )
    } else if (!(sourceState === 'missing' && conflictState !== 'missing')) {
      throw new Error('cutover-conflict backup state is inconsistent with the rollback journal')
    }
    journal = updateJournal(
      journalPath,
      journal,
      { phase: 'rollback-conflict-backed-up' },
      options.now
    )
    options.afterPhase('rollback-conflict-backed-up')
  }

  if (journal.phase === 'rollback-conflict-backed-up') {
    const sourceState = pathState(journal.sourcePath)
    const targetState = pathState(journal.targetPath)
    if (sourceState === 'missing' && targetState === 'dir') {
      retryRuntimeMigrationMutation(
        () => renameSync(journal.targetPath, journal.sourcePath),
        { platform: options.platform, sleep: options.sleep }
      )
    } else if (!(sourceState === 'dir' && targetState === 'missing')) {
      throw new Error('promoted source restoration state is inconsistent with the rollback journal')
    }
    assertStoreInventoryContains(
      journal.sourcePath,
      journal.sourceInventory,
      'restored authoritative Runtime source'
    )
    journal = updateJournal(
      journalPath,
      journal,
      { phase: 'rollback-source-restored' },
      options.now
    )
    options.afterPhase('rollback-source-restored')
  }

  if (journal.phase === 'rollback-source-restored') {
    if (journal.destinationBackupPath) {
      const targetState = pathState(journal.targetPath)
      const backupState = pathState(journal.destinationBackupPath)
      if (targetState === 'missing' && backupState === 'dir') {
        retryRuntimeMigrationMutation(
          () => renameSync(journal.destinationBackupPath!, journal.targetPath),
          { platform: options.platform, sleep: options.sleep }
        )
      } else if (!(targetState === 'dir' && backupState === 'missing')) {
        throw new Error('destination restoration state is inconsistent with the rollback journal')
      }
      assertStoreInventoryContains(
        journal.targetPath,
        journal.destinationInventory,
        'restored displaced Runtime destination'
      )
    } else if (pathState(journal.targetPath) !== 'missing') {
      throw new Error('unexpected Runtime destination appeared while rollback was restoring names')
    }
    journal = updateJournal(
      journalPath,
      journal,
      { phase: 'settings-backed-up' },
      options.now
    )
    options.afterPhase('settings-backed-up')
  }

  return journal
}

function rollBackPromotedDirectories(
  journalPath: string,
  initialJournal: RuntimeMigrationJournal,
  options: {
    platform: NodeJS.Platform
    sleep: (milliseconds: number) => void
    now: () => Date
    afterPhase: (phase: MigrationPhase) => void
  },
  error: unknown
): RuntimeMigrationJournal {
  let journal = initialJournal
  const sourceState = pathState(journal.sourcePath)
  if (sourceState !== 'missing') {
    const conflictBackupPath = uniqueSiblingBackup(
      journal.sourcePath,
      'cutover-conflict',
      options.now
    )
    journal = updateJournal(
      journalPath,
      journal,
      {
        phase: 'rollback-conflict-planned',
        cutoverConflictBackupPaths: [
          ...journal.cutoverConflictBackupPaths,
          conflictBackupPath
        ],
        error: error instanceof Error ? error.message : String(error)
      },
      options.now
    )
    options.afterPhase('rollback-conflict-planned')
  } else {
    journal = updateJournal(
      journalPath,
      journal,
      {
        phase: 'rollback-conflict-backed-up',
        error: error instanceof Error ? error.message : String(error)
      },
      options.now
    )
    options.afterPhase('rollback-conflict-backed-up')
  }

  return finishPromotedDirectoryRollback(journalPath, journal, options)
}

function continueMigration(
  initialJournal: RuntimeMigrationJournal,
  options: Required<Pick<RuntimeDataDirMigrationOptions, 'userDataPath' | 'homeDir'>> & {
    platform: NodeJS.Platform
    log: MigrationLogger
    now: () => Date
    sleep: (milliseconds: number) => void
    assertLegacyRuntimeInactive: (sourcePath: string) => void
    afterPhase: (phase: MigrationPhase) => void
    beforeCompatibilityLink: () => void
  }
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (ROLLBACK_PHASES.has(journal.phase)) {
      const rollbackError = journal.error ?? 'Runtime directory cutover was rolled back'
      journal = finishPromotedDirectoryRollback(journalPath, journal, options)
      throw new Error(`${rollbackError}; rollback completed and migration can retry safely`)
    }

    if (journal.phase === 'prepared') {
      assertSettingsSelectionStable(journal, options)
      const settingsBackupPaths = backUpSettingsFile(
        journal.settingsWritePath,
        options.now
      )
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths,
          settingsBackedUp: true,
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      if (journal.sourceWasMissing !== true) {
        options.assertLegacyRuntimeInactive(journal.sourcePath)
      }
      if (journal.destinationBackupPath && pathState(journal.targetPath) === 'dir') {
        options.assertLegacyRuntimeInactive(journal.targetPath)
      }
      mkdirSync(dirname(journal.targetPath), { recursive: true, mode: 0o700 })
      if (journal.destinationBackupPath) {
        const targetState = pathState(journal.targetPath)
        const backupState = pathState(journal.destinationBackupPath)
        if (targetState === 'dir' && backupState === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.targetPath, journal.destinationBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
        } else if (!(targetState === 'missing' && backupState === 'dir')) {
          throw new Error('destination backup state is inconsistent with the migration journal')
        }
      } else if (pathState(journal.targetPath) !== 'missing') {
        throw new Error('unexpected Runtime destination appeared after migration planning')
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'destination-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('destination-backed-up')
    }

    if (journal.phase === 'destination-backed-up') {
      try {
        if (journal.sourceWasMissing !== true) {
          options.assertLegacyRuntimeInactive(journal.sourcePath)
        }
        if (pathState(journal.sourcePath) === 'dir' && pathState(journal.targetPath) === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.sourcePath, journal.targetPath),
            { platform: options.platform, sleep: options.sleep }
          )
        } else if (
          journal.sourceWasMissing === true &&
          pathState(journal.sourcePath) === 'missing' &&
          pathState(journal.targetPath) === 'missing'
        ) {
          mkdirSync(journal.targetPath, { recursive: true, mode: 0o700 })
        } else if (
          pathState(journal.targetPath) !== 'dir' ||
          !['missing', 'symlink'].includes(pathState(journal.sourcePath))
        ) {
          throw new Error('source promotion state is inconsistent with the migration journal')
        }
      } catch (error) {
        if (
          pathState(journal.sourcePath) === 'dir' &&
          pathState(journal.targetPath) === 'missing'
        ) {
          restoreDestinationBackup(journal, options.platform, options.sleep)
          journal = updateJournal(
            journalPath,
            journal,
            {
              phase: 'settings-backed-up',
              error: error instanceof Error ? error.message : String(error)
            },
            options.now
          )
        }
        throw error
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'source-promoted', error: undefined },
        options.now
      )
      options.afterPhase('source-promoted')
    }

    if (journal.phase === 'source-promoted') {
      try {
        if (journal.sourceWasMissing !== true) {
          options.assertLegacyRuntimeInactive(journal.sourcePath)
        }
        options.beforeCompatibilityLink()
        createAndVerifyCompatibilityLink(
          journal.sourcePath,
          journal.targetPath,
          options.platform,
          options.sleep
        )
      } catch (error) {
        if (pathState(journal.targetPath) === 'dir') {
          journal = rollBackPromotedDirectories(
            journalPath,
            journal,
            options,
            error
          )
        }
        throw error
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'link-created', error: undefined },
        options.now
      )
      options.afterPhase('link-created')
    }

    if (journal.phase === 'link-created') {
      if (journal.settingsBackedUp !== true) {
        assertSettingsSelectionStable(journal, options)
        journal = updateJournal(
          journalPath,
          journal,
          {
            settingsBackupPaths: backUpSettingsFile(
              journal.settingsWritePath,
              options.now
            ),
            settingsBackedUp: true,
            error: undefined
          },
          options.now
        )
      }
      const salvage = salvageDestinationBackup(
        journal.destinationBackupPath,
        journal.targetPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'salvaged',
          salvaged: salvage.salvaged,
          conflicts: salvage.conflicts,
          error: undefined
        },
        options.now
      )
      options.afterPhase('salvaged')
    }

    if (journal.phase === 'salvaged') {
      journal = prepareExtensionRegistryRebase(journalPath, journal, options)
    }

    if (journal.phase === 'extension-registry-backed-up') {
      journal = commitExtensionRegistryRebase(journalPath, journal, options)
    }

    if (journal.phase === 'extension-registry-rebased') {
      assertSettingsSelectionStable(journal, options)
      rewriteSettingsToCurrent(journal.settingsWritePath)
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'settings-rewritten', error: undefined },
        options.now
      )
      options.afterPhase('settings-rewritten')
    }

    if (journal.phase === 'settings-rewritten') {
      const validation = validatePromotedStore(journal, options.platform)
      const completedAt = options.now().toISOString()
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: validation.targetInventory,
          sqliteQuickCheck: validation.sqliteQuickCheck,
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
      options.log('legacy-migration: committed canonical Kun Runtime data migration', {
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        destinationBackupPath: journal.destinationBackupPath,
        sourceThreadCount: journal.sourceThreadIds.length,
        salvaged: journal.salvaged,
        conflicts: journal.conflicts.length,
        extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords ?? 0
      })
    }

    const reportPath = writeReport(options.userDataPath, journal)
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persistedJournal = readJournal(journalPath)
      if (
        persistedJournal &&
        sameFilesystemPath(persistedJournal.sourcePath, journal.sourcePath, options.platform) &&
        sameFilesystemPath(persistedJournal.targetPath, journal.targetPath, options.platform)
      ) {
        journal = persistedJournal
      }
      journal = updateJournal(journalPath, journal, { error: message }, options.now)
    } catch {
      // The original error remains authoritative.
    }
    options.log('legacy-migration: canonical Runtime data migration is blocked', {
      phase: journal.phase,
      message,
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      destinationBackupPath: journal.destinationBackupPath
    })
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message
    }
  }
}

function maintainCompletedMigration(
  initialJournal: RuntimeMigrationJournal,
  options: {
    userDataPath: string
    homeDir: string
    platform: NodeJS.Platform
    log: MigrationLogger
    now: () => Date
    sleep: (milliseconds: number) => void
    assertLegacyRuntimeInactive: (sourcePath: string) => void
  }
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    const selection = readSettingsSelection(
      options.userDataPath,
      options.homeDir,
      options.platform,
      pathState(journal.sourcePath)
    )
    if (selection.authority === 'custom') {
      return {
        status: 'not-needed',
        authority: 'custom',
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        ...(journal.destinationBackupPath
          ? { destinationBackupPath: journal.destinationBackupPath }
          : {}),
        journalPath
      }
    }
    if (selection.authority === 'unknown') {
      throw new Error('could not determine Runtime data authority from the active settings source')
    }
    if (pathState(journal.targetPath) !== 'dir') {
      throw new Error('committed Kun Runtime target is missing')
    }
    const sourceState = pathState(journal.sourcePath)
    if (sourceState === 'dir') {
      options.log('legacy-migration: retained real legacy Runtime history without mutation', {
        legacyPath: journal.sourcePath
      })
    } else if (
      sourceState === 'symlink' &&
      !linkResolvesToTarget(journal.sourcePath, journal.targetPath, options.platform)
    ) {
      throw new Error('legacy Runtime compatibility link no longer resolves to the current store')
    } else if (
      sourceState !== 'symlink' &&
      sourceState !== 'missing'
    ) {
      throw new Error('legacy Runtime history path has an unexpected filesystem type')
    }
    const currentThreadIds = new Set(threadIds(journal.targetPath))
    const missingSourceThreads = journal.sourceThreadIds.filter(
      (threadId) => !currentThreadIds.has(threadId)
    )
    if (missingSourceThreads.length > 0) {
      throw new Error(
        `current Runtime store is missing ${missingSourceThreads.length} ` +
        `threads recorded before the rename migration`
      )
    }
    journal = repairCompletedExtensionRegistry(journalPath, journal, options)
    if (selection.authority === 'legacy') {
      const settingsBackupPaths = backUpSettingsFile(selection.writePath, options.now)
      journal = updateJournal(
        journalPath,
        journal,
        {
          settingsSourcePath: selection.sourcePath,
          settingsWritePath: selection.writePath,
          settingsBackupPaths: [
            ...journal.settingsBackupPaths,
            ...settingsBackupPaths
          ],
          settingsBackedUp: true
        },
        options.now
      )
      rewriteSettingsToCurrent(selection.writePath)
    }
    const reportPath = writeReport(options.userDataPath, journal)
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath,
      ...(sourceState === 'symlink'
        ? {
            message:
              'history is present but the completed version-2 migration did not preserve ' +
              'an independent legacy source'
          }
        : {})
    }
  } catch (error) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

type PreservationMigrationOptions = Required<
  Pick<RuntimeDataDirMigrationOptions, 'userDataPath' | 'homeDir'>
> & {
  platform: NodeJS.Platform
  log: MigrationLogger
  now: () => Date
  sleep: (milliseconds: number) => void
  assertLegacyRuntimeInactive: (sourcePath: string) => void
  afterPhase: (phase: PreservationPhase) => void
  availableCopyBytes: (path: string) => number
}

function assertPreservationSettingsSelectionStable(
  journal: PreservationJournal,
  options: Pick<PreservationMigrationOptions, 'userDataPath' | 'homeDir' | 'platform'>
): void {
  const current = readSettingsSelection(
    options.userDataPath,
    options.homeDir,
    options.platform,
    pathState(journal.sourcePath)
  )
  if (
    current.authority === 'custom' ||
    current.authority === 'unknown' ||
    (journal.mergeIntoCurrent === true && current.authority !== 'current') ||
    !sameFilesystemPath(current.sourcePath, journal.settingsSourcePath, options.platform) ||
    !sameFilesystemPath(current.writePath, journal.settingsWritePath, options.platform)
  ) {
    throw new Error(
      'the active settings source changed while history-preserving Runtime migration was in progress'
    )
  }
}

function writePreservationReport(
  userDataPath: string,
  journal: PreservationJournal,
  extra: Record<string, unknown> = {}
): string {
  const reportPath = join(userDataPath, PRESERVATION_REPORT_FILE_NAME)
  writeDurableJson(reportPath, {
    schemaVersion: PRESERVATION_SCHEMA_VERSION,
    status: journal.phase,
    provenance: journal.provenance,
    sourcePath: journal.sourcePath,
    targetPath: journal.targetPath,
    stagingPath: journal.stagingPath,
    destinationBackupPath: journal.destinationBackupPath,
    compatibilityLinkBackupPath: journal.compatibilityLinkBackupPath,
    settingsSourcePath: journal.settingsSourcePath,
    settingsBackupPaths: journal.settingsBackupPaths,
    mergeIntoCurrent: journal.mergeIntoCurrent,
    sourceThreadCount: journal.sourceThreadIds.length,
    sourceInventory: journal.sourceInventory,
    sourceFingerprint: journal.sourceFingerprint,
    candidateFingerprint: journal.candidateFingerprint,
    extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords,
    salvaged: journal.salvaged,
    conflicts: journal.conflicts,
    targetInventory: journal.targetInventory,
    sqliteQuickCheck: journal.sqliteQuickCheck,
    completedAt: journal.completedAt,
    runtimeVerifiedAt: journal.runtimeVerifiedAt,
    ...extra
  })
  return reportPath
}

function validateHistoryPreservingTarget(
  journal: PreservationJournal
): {
  targetInventory: RuntimeStoreInventory
  sqliteQuickCheck: 'missing' | 'ok' | 'invalid'
} {
  if (pathState(journal.targetPath) !== 'dir') {
    throw new Error(`history-preserving Runtime target is unavailable: ${journal.targetPath}`)
  }
  const migratedThreadIds = new Set(threadIds(journal.targetPath))
  const missing = journal.sourceThreadIds.filter((threadId) => !migratedThreadIds.has(threadId))
  if (missing.length > 0) {
    throw new Error(
      `history-preserving Runtime target is missing ${missing.length} source thread directories`
    )
  }
  const configPath = join(journal.targetPath, 'config.json')
  const configState = pathState(configPath)
  if (configState === 'other' || configState === 'symlink') {
    JSON.parse(readFileSync(configPath, 'utf8'))
  } else if (configState !== 'missing') {
    throw new Error(`history-preserving Runtime config is not a readable file: ${configPath}`)
  }
  const targetInventory = runtimeStoreInventory(journal.targetPath)
  if (
    targetInventory.files < journal.sourceInventory.files ||
    targetInventory.directories < journal.sourceInventory.directories ||
    targetInventory.symlinks < journal.sourceInventory.symlinks
  ) {
    throw new Error('history-preserving Runtime target inventory is missing source entries')
  }
  return {
    targetInventory,
    sqliteQuickCheck: validateSqliteIndex(journal.targetPath)
  }
}

function validateHistoryPreservingCandidate(
  journal: PreservationJournal,
  platform: NodeJS.Platform
): void {
  if (pathState(journal.stagingPath) !== 'dir') {
    throw new Error(`history-preserving Runtime candidate is unavailable: ${journal.stagingPath}`)
  }
  const candidateThreadIds = new Set(threadIds(journal.stagingPath))
  const missing = journal.sourceThreadIds.filter(
    (threadId) => !candidateThreadIds.has(threadId)
  )
  if (missing.length > 0) {
    throw new Error(
      `history-preserving Runtime candidate is missing ${missing.length} source thread directories`
    )
  }
  const configPath = join(journal.stagingPath, 'config.json')
  const configState = pathState(configPath)
  if (configState === 'other' || configState === 'symlink') {
    try {
      JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      throw new Error(
        `history-preserving Runtime candidate config is not valid JSON: ${configPath}`
      )
    }
  } else if (configState !== 'missing') {
    throw new Error(`history-preserving Runtime candidate config is unreadable: ${configPath}`)
  }
  const candidateInventory = runtimeStoreInventory(journal.stagingPath)
  if (
    candidateInventory.files < journal.sourceInventory.files ||
    candidateInventory.directories < journal.sourceInventory.directories ||
    candidateInventory.symlinks < journal.sourceInventory.symlinks
  ) {
    throw new Error('history-preserving Runtime candidate inventory is missing source entries')
  }
  const inspection = inspectExtensionRegistryForRebase(
    journal.sourcePath,
    journal.targetPath,
    platform,
    journal.stagingPath
  )
  if (inspection.kind === 'registry' && inspection.rebasedRecords > 0) {
    throw new Error('history-preserving Runtime candidate registry was not fully rebased')
  }
}

function logPreservedHistoryDrift(
  journal: PreservationJournal,
  preservedPath: string,
  recordedFingerprint: string | undefined,
  options: PreservationMigrationOptions
): void {
  const requireFullVerification =
    !journal.runtimeVerifiedAt ||
    process.env.KUN_VERIFY_PRESERVED_HISTORY === '1'
  if (requireFullVerification) {
    const current = runtimeTreeFingerprint(preservedPath)
    if (recordedFingerprint && current.fingerprint !== recordedFingerprint) {
      options.log('legacy-migration: preserved Runtime history fingerprint changed', {
        preservedPath,
        recordedFingerprint,
        currentFingerprint: current.fingerprint,
        verification: 'full-fingerprint'
      })
    }
    return
  }
  const currentInventory = runtimeStoreInventory(preservedPath)
  if (!inventoriesEqual(currentInventory, journal.sourceInventory)) {
    options.log('legacy-migration: preserved Runtime history inventory changed', {
      preservedPath,
      recordedInventory: journal.sourceInventory,
      currentInventory,
      verification: 'inventory'
    })
  }
}

function maintainCompletedPreservationMigration(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions,
  skipPreservedHistoryDriftCheck = false
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (pathState(journal.targetPath) !== 'dir') {
      throw new Error('committed history-preserving Runtime target is missing')
    }
    const selection = readSettingsSelection(
      options.userDataPath,
      options.homeDir,
      options.platform,
      pathState(journal.sourcePath)
    )
    if (selection.authority === 'custom') {
      return {
        status: 'not-needed',
        authority: 'custom',
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        ...(journal.destinationBackupPath
          ? { destinationBackupPath: journal.destinationBackupPath }
          : {}),
        journalPath
      }
    }
    if (selection.authority === 'unknown') {
      throw new Error('could not determine Runtime data authority from the active settings source')
    }
    if (journal.provenance === 'original-legacy-source') {
      if (pathState(journal.sourcePath) !== 'dir') {
        throw new Error('preserved legacy Runtime source is no longer a real directory')
      }
      if (!skipPreservedHistoryDriftCheck) {
        logPreservedHistoryDrift(
          journal,
          journal.sourcePath,
          journal.sourceFingerprint,
          options
        )
      }
    } else if (journal.provenance === 'reconstructed-from-current') {
      const reconstructedPath = canonicalLegacyKunDataDir(
        options.homeDir,
        options.platform
      )
      if (pathState(reconstructedPath) !== 'dir') {
        throw new Error('reconstructed legacy Runtime history is no longer a real directory')
      }
      if (!skipPreservedHistoryDriftCheck) {
        logPreservedHistoryDrift(
          journal,
          reconstructedPath,
          journal.candidateFingerprint,
          options
        )
      }
      const v2JournalPath = join(options.userDataPath, JOURNAL_FILE_NAME)
      const v2Journal = readJournal(v2JournalPath)
      if (v2Journal?.phase === 'completed') {
        const repairedV2 = repairCompletedExtensionRegistry(
          v2JournalPath,
          v2Journal,
          options
        )
        writeReport(options.userDataPath, repairedV2)
      }
    }
    if (selection.authority === 'legacy') {
      const settingsBackupPaths = backUpSettingsFile(selection.writePath, options.now)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          settingsSourcePath: selection.sourcePath,
          settingsWritePath: selection.writePath,
          settingsBackupPaths: [
            ...journal.settingsBackupPaths,
            ...settingsBackupPaths
          ],
          error: undefined
        },
        options.now
      )
      rewriteSettingsToCurrent(selection.writePath)
    }
    const reportPath = writePreservationReport(
      options.userDataPath,
      journal,
      journal.provenance === 'reconstructed-from-current'
        ? {
            exactPreMigrationSnapshot: false,
            reconstructedPath: canonicalLegacyKunDataDir(
              options.homeDir,
              options.platform
            ),
            warning:
              'The version-2 migration did not retain an independent original; ' +
              'this directory was reconstructed from the current store.'
          }
        : journal.provenance === 'original-legacy-source'
          ? { exactPreMigrationSnapshot: true }
          : { exactPreMigrationSnapshot: true, sourceExisted: false }
    )
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath
    }
  } catch (error) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function continuePreservationMigration(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (journal.phase === 'prepared') {
      assertPreservationSettingsSelectionStable(journal, options)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths: backUpSettingsFile(
            journal.settingsWritePath,
            options.now
          ),
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      if (pathState(journal.stagingPath) === 'missing') {
        const displacedHistoryBytes =
          journal.destinationBackupPath && pathState(journal.targetPath) === 'dir'
            ? runtimeStoreInventory(journal.targetPath).bytes
            : 0
        assertCandidateCopyCapacity(
          journal.sourceInventory,
          journal.stagingPath,
          options.availableCopyBytes,
          displacedHistoryBytes
        )
      }
      copyRuntimeTreePreservingSource(journal.sourcePath, journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'candidate-copied', error: undefined },
        options.now
      )
      options.afterPhase('candidate-copied')
    }

    if (journal.phase === 'candidate-copied') {
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      const candidate = runtimeTreeFingerprint(journal.stagingPath)
      if (
        source.fingerprint !== journal.sourceFingerprint ||
        candidate.fingerprint !== source.fingerprint
      ) {
        throw new Error(
          'history-preserving Runtime candidate or source fingerprint changed during copy'
        )
      }
      assertRuntimeTreeTimestampsPreserved(journal.sourcePath, journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'candidate-verified',
          candidateFingerprint: candidate.fingerprint,
          error: undefined
        },
        options.now
      )
      options.afterPhase('candidate-verified')
    }

    if (journal.phase === 'candidate-verified') {
      const inspection = inspectExtensionRegistryForRebase(
        journal.sourcePath,
        journal.targetPath,
        options.platform,
        journal.stagingPath
      )
      if (inspection.kind === 'registry' && inspection.rebasedRecords > 0) {
        writeDurableJson(inspection.path, inspection.document)
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'candidate-rebased',
          extensionRegistryRebasedRecords:
            inspection.kind === 'registry' ? inspection.rebasedRecords : 0,
          error: undefined
        },
        options.now
      )
      options.afterPhase('candidate-rebased')
    }

    if (journal.phase === 'candidate-rebased') {
      assertPreservationSettingsSelectionStable(journal, options)
      const targetState = pathState(journal.targetPath)
      if (journal.destinationBackupPath) {
        const backupState = pathState(journal.destinationBackupPath)
        if (targetState === 'dir' && backupState === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.targetPath, journal.destinationBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
          fsyncRenameParents(journal.targetPath, journal.destinationBackupPath)
        } else if (!(targetState === 'missing' && backupState === 'dir')) {
          throw new Error(
            'destination preservation state is inconsistent with the copy migration journal'
          )
        }
      } else if (targetState !== 'missing') {
        throw new Error('unexpected Runtime destination appeared before candidate activation')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'destination-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('destination-backed-up')
    }

    if (journal.phase === 'destination-backed-up') {
      const salvage = salvageDestinationBackup(
        journal.destinationBackupPath,
        journal.stagingPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'destination-salvaged',
          salvaged: salvage.salvaged,
          conflicts: salvage.conflicts,
          error: undefined
        },
        options.now
      )
      options.afterPhase('destination-salvaged')
    }

    if (journal.phase === 'destination-salvaged') {
      assertPreservationSettingsSelectionStable(journal, options)
      validateHistoryPreservingCandidate(journal, options.platform)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        throw new Error('legacy Runtime source changed before candidate activation')
      }
      const stagingState = pathState(journal.stagingPath)
      const targetState = pathState(journal.targetPath)
      if (stagingState === 'dir' && targetState === 'missing') {
        retryRuntimeMigrationMutation(
          () => renameSync(journal.stagingPath, journal.targetPath),
          { platform: options.platform, sleep: options.sleep }
        )
        fsyncRenameParents(journal.stagingPath, journal.targetPath)
      } else if (!(stagingState === 'missing' && targetState === 'dir')) {
        throw new Error('verified Runtime candidate activation state is inconsistent')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'target-activated', error: undefined },
        options.now
      )
      options.afterPhase('target-activated')
    }

    if (journal.phase === 'target-activated') {
      assertPreservationSettingsSelectionStable(journal, options)
      rewriteSettingsToCurrent(journal.settingsWritePath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'settings-rewritten', error: undefined },
        options.now
      )
      options.afterPhase('settings-rewritten')
    }

    if (journal.phase === 'settings-rewritten') {
      const validation = validateHistoryPreservingTarget(journal)
      const completedAt = options.now().toISOString()
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: validation.targetInventory,
          sqliteQuickCheck: validation.sqliteQuickCheck,
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
      options.log('legacy-migration: committed history-preserving Runtime data migration', {
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        sourceThreadCount: journal.sourceThreadIds.length,
        sourceFingerprint: journal.sourceFingerprint,
        destinationBackupPath: journal.destinationBackupPath,
        salvaged: journal.salvaged,
        conflicts: journal.conflicts.length
      })
    }

    const reportPath = writePreservationReport(options.userDataPath, journal)
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persisted = readPreservationJournal(journalPath)
      if (persisted) journal = persisted
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { error: message },
        options.now
      )
    } catch {
      // The original error remains authoritative.
    }
    options.log('legacy-migration: history-preserving Runtime migration is blocked', {
      phase: journal.phase,
      message,
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      stagingPath: journal.stagingPath
    })
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message
    }
  }
}

function continueCurrentAuthorityMerge(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (journal.phase === 'prepared') {
      assertPreservationSettingsSelectionStable(journal, options)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths: backUpSettingsFile(
            journal.settingsWritePath,
            options.now
          ),
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      options.assertLegacyRuntimeInactive(journal.targetPath)
      const sourceBefore = runtimeTreeFingerprint(journal.sourcePath)
      if (sourceBefore.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed before incremental merge')
      }
      assertCandidateCopyCapacity(
        journal.sourceInventory,
        journal.stagingPath,
        options.availableCopyBytes
      )
      const salvage = salvageDestinationBackup(
        journal.sourcePath,
        journal.targetPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      const sourceAfter = runtimeTreeFingerprint(journal.sourcePath)
      if (sourceAfter.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed during incremental merge')
      }
      const target = runtimeTreeFingerprint(journal.targetPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'destination-salvaged',
          salvaged: salvage.salvaged,
          conflicts: salvage.conflicts,
          candidateFingerprint: target.fingerprint,
          error: undefined
        },
        options.now
      )
      options.afterPhase('destination-salvaged')
    }

    if (journal.phase === 'destination-salvaged') {
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed after incremental merge')
      }
      const visibleThreadDirectories = new Set(threadIds(journal.targetPath))
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !visibleThreadDirectories.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error(
          `incremental Runtime merge is missing ${missing.length} preserved thread directories`
        )
      }
      const completedAt = options.now().toISOString()
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: runtimeStoreInventory(journal.targetPath),
          sqliteQuickCheck: validateSqliteIndex(journal.targetPath),
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
    }

    return maintainCompletedPreservationMigration(journal, options, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persisted = readPreservationJournal(journalPath)
      if (persisted) journal = persisted
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { error: message },
        options.now
      )
    } catch {
      // The original failure remains authoritative.
    }
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      journalPath,
      message
    }
  }
}

function continueV2ReconstructionMigration(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const reconstructedPath = canonicalLegacyKunDataDir(
    options.homeDir,
    options.platform
  )
  let journal = initialJournal
  let sourceVerifiedThisRun = false
  try {
    if (journal.phase === 'prepared') {
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths: backUpSettingsFile(
            journal.settingsWritePath,
            options.now
          ),
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      if (pathState(journal.stagingPath) === 'missing') {
        assertCandidateCopyCapacity(
          journal.sourceInventory,
          journal.stagingPath,
          options.availableCopyBytes
        )
      }
      copyRuntimeTreePreservingSource(journal.sourcePath, journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'candidate-copied', error: undefined },
        options.now
      )
      options.afterPhase('candidate-copied')
    }

    if (journal.phase === 'candidate-copied') {
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      const candidate = runtimeTreeFingerprint(journal.stagingPath)
      if (
        source.fingerprint !== journal.sourceFingerprint ||
        candidate.fingerprint !== source.fingerprint
      ) {
        throw new Error(
          'version-2 history reconstruction source or candidate fingerprint changed'
        )
      }
      assertRuntimeTreeTimestampsPreserved(journal.sourcePath, journal.stagingPath)
      const currentThreadIds = new Set(source.threadIds)
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !currentThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error(
          `current Runtime store is missing ${missing.length} ` +
          `threads recorded before the rename migration`
        )
      }
      sourceVerifiedThisRun = true
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'candidate-verified',
          candidateFingerprint: candidate.fingerprint,
          error: undefined
        },
        options.now
      )
      options.afterPhase('candidate-verified')
    }

    if (journal.phase === 'candidate-verified') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      if (!sourceVerifiedThisRun) {
        const source = runtimeTreeFingerprint(journal.sourcePath)
        if (source.fingerprint !== journal.sourceFingerprint) {
          throw new Error('current Runtime store changed before history reconstruction activation')
        }
      }
      const legacyState = pathState(reconstructedPath)
      const backupState = journal.compatibilityLinkBackupPath
        ? pathState(journal.compatibilityLinkBackupPath)
        : 'missing'
      if (journal.compatibilityLinkBackupPath) {
        if (legacyState === 'symlink' && backupState === 'missing') {
          if (!linkResolvesToTarget(reconstructedPath, journal.targetPath, options.platform)) {
            throw new Error('version-2 compatibility link no longer resolves to the current store')
          }
          retryRuntimeMigrationMutation(
            () => renameSync(reconstructedPath, journal.compatibilityLinkBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
          fsyncRenameParents(reconstructedPath, journal.compatibilityLinkBackupPath)
        } else if (!(legacyState === 'missing' && backupState === 'symlink')) {
          throw new Error('version-2 compatibility-link preservation state is inconsistent')
        }
      } else if (legacyState !== 'missing') {
        throw new Error('version-2 legacy reconstruction destination is no longer empty')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'legacy-link-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('legacy-link-backed-up')
    }

    if (journal.phase === 'legacy-link-backed-up') {
      const stagingState = pathState(journal.stagingPath)
      const legacyState = pathState(reconstructedPath)
      if (stagingState === 'dir' && legacyState === 'missing') {
        retryRuntimeMigrationMutation(
          () => renameSync(journal.stagingPath, reconstructedPath),
          { platform: options.platform, sleep: options.sleep }
        )
        fsyncRenameParents(journal.stagingPath, reconstructedPath)
      } else if (!(stagingState === 'missing' && legacyState === 'dir')) {
        throw new Error('reconstructed legacy Runtime activation state is inconsistent')
      }
      const reconstructedThreadIds = new Set(threadIds(reconstructedPath))
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !reconstructedThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error('activated reconstructed legacy Runtime history is incomplete')
      }
      if (!inventoryContains(
        runtimeStoreInventory(reconstructedPath),
        journal.sourceInventory
      )) {
        throw new Error('activated reconstructed legacy Runtime inventory is incomplete')
      }
      const completedAt = options.now().toISOString()
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: runtimeStoreInventory(journal.targetPath),
          sqliteQuickCheck: validateSqliteIndex(journal.targetPath),
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
    }

    return maintainCompletedPreservationMigration(journal, options, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persisted = readPreservationJournal(journalPath)
      if (persisted) journal = persisted
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { error: message },
        options.now
      )
    } catch {
      // The original failure remains authoritative.
    }
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: reconstructedPath,
      targetPath: journal.targetPath,
      journalPath,
      message
    }
  }
}

function runPreservationMigrationIfNeeded(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult | null {
  const platform = input.platform ?? process.platform
  const log = input.log ?? (() => undefined)
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const assertLegacyRuntimeInactive = input.assertLegacyRuntimeInactive ?? (() => undefined)
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const sourceState = pathState(sourcePath)
  const targetState = pathState(targetPath)
  const journalPath = join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const journalState = pathState(journalPath)
  const existingJournal = readPreservationJournal(journalPath)
  const options: PreservationMigrationOptions = {
    userDataPath: input.userDataPath,
    homeDir: input.homeDir,
    platform,
    log,
    now,
    sleep,
    assertLegacyRuntimeInactive,
    afterPhase: input.afterPreservationPhase ?? (() => undefined),
    availableCopyBytes: input.availableCopyBytes ?? availableFilesystemBytes
  }

  if (journalState === 'inaccessible' || (journalState === 'other' && !existingJournal)) {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the Runtime preservation journal is inaccessible or invalid'
    }
  }
  if (existingJournal) {
    const journalError = validatePreservationJournalForRecovery(existingJournal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform
    })
    if (journalError) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath,
        message: journalError
      }
    }
    return existingJournal.phase === 'completed'
      ? maintainCompletedPreservationMigration(existingJournal, options)
      : existingJournal.provenance === 'reconstructed-from-current'
        ? continueV2ReconstructionMigration(existingJournal, options)
        : existingJournal.mergeIntoCurrent
          ? continueCurrentAuthorityMerge(existingJournal, options)
          : continuePreservationMigration(existingJournal, options)
  }

  // A version-2 journal represents a migration that started under the old
  // rename/link state machine. Never resume that state machine in production:
  // copy a real source through v3, or reconstruct an independent source from
  // the already-promoted current store.
  const v2JournalPath = join(input.userDataPath, JOURNAL_FILE_NAME)
  if (pathState(v2JournalPath) !== 'missing') {
    const v2Journal = readJournal(v2JournalPath)
    if (!v2Journal) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message: 'the version-2 Runtime migration journal is invalid'
      }
    }
    const compatibilityLinkIsValid =
      sourceState === 'symlink' &&
      targetState === 'dir' &&
      linkResolvesToTarget(sourcePath, targetPath, platform)
    if (sourceState === 'symlink' && !compatibilityLinkIsValid) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message: 'the version-2 Runtime compatibility link is not canonical'
      }
    }
    if (
      targetState === 'dir' &&
      (sourceState === 'missing' || compatibilityLinkIsValid)
    ) {
      const selection = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        sourceState
      )
      if (selection.authority === 'custom') {
        return {
          status: 'not-needed',
          authority: 'custom',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath
        }
      }
      if (selection.authority === 'unknown') {
        return {
          status: 'blocked',
          authority: 'unknown',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath,
          message: 'could not determine Runtime data authority before history reconstruction'
        }
      }
      const currentThreadIds = new Set(threadIds(targetPath))
      const missing = v2Journal.sourceThreadIds.filter(
        (threadId) => !currentThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        return {
          status: 'blocked',
          authority: 'current',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath,
          message:
            `current Runtime store is missing ${missing.length} ` +
            `threads recorded before the rename migration`
        }
      }
      try {
        assertLegacyRuntimeInactive(targetPath)
        const source = runtimeTreeFingerprint(targetPath)
        const startedAt = now().toISOString()
        const reconstruction: PreservationJournal = {
          schemaVersion: PRESERVATION_SCHEMA_VERSION,
          phase: 'prepared',
          provenance: 'reconstructed-from-current',
          sourcePath: targetPath,
          targetPath,
          stagingPath: uniqueSiblingBackup(
            sourcePath,
            'history-preserving-staging',
            now
          ),
          ...(compatibilityLinkIsValid
            ? {
                compatibilityLinkBackupPath: uniqueSiblingBackup(
                  sourcePath,
                  'pre-preservation-compatibility-link',
                  now
                )
              }
            : {}),
          settingsSourcePath: selection.sourcePath,
          settingsWritePath: selection.writePath,
          settingsBackupPaths: [],
          sourceThreadIds: v2Journal.sourceThreadIds,
          sourceInventory: source.inventory,
          sourceFingerprint: source.fingerprint,
          salvaged: 0,
          conflicts: [],
          startedAt,
          updatedAt: startedAt
        }
        writeDurableJson(journalPath, reconstruction)
        options.afterPhase('prepared')
        return continueV2ReconstructionMigration(reconstruction, options)
      } catch (error) {
        return {
          status: 'blocked',
          authority: 'current',
          sourcePath,
          targetPath,
          journalPath,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
    if (sourceState !== 'dir') {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message:
          'the version-2 Runtime migration state has no independently readable history source'
      }
    }
  }

  const selection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  if (selection.authority === 'custom' || selection.authority === 'unknown') return null
  if (
    selection.authority === 'current' &&
    targetState !== 'dir' &&
    targetState !== 'missing'
  ) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select the canonical Runtime directory but that path is not a directory'
    }
  }
  if (
    selection.authority === 'current' &&
    targetState === 'missing' &&
    sourceState !== 'dir' &&
    sourceState !== 'missing'
  ) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select a missing Runtime directory and the preserved history path is not recoverable'
    }
  }
  if (sourceState === 'symlink') {
    if (
      targetState !== 'dir' ||
      !linkResolvesToTarget(sourcePath, targetPath, platform)
    ) {
      return {
        status: 'blocked',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'the legacy Runtime path is an unexpected symbolic link'
      }
    }
    try {
      assertLegacyRuntimeInactive(targetPath)
      const source = runtimeTreeFingerprint(targetPath)
      const startedAt = now().toISOString()
      const reconstruction: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'prepared',
        provenance: 'reconstructed-from-current',
        sourcePath: targetPath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          sourcePath,
          'history-preserving-staging',
          now
        ),
        compatibilityLinkBackupPath: uniqueSiblingBackup(
          sourcePath,
          'pre-preservation-compatibility-link',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths: [],
        sourceThreadIds: source.threadIds,
        sourceInventory: source.inventory,
        sourceFingerprint: source.fingerprint,
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, reconstruction)
      options.afterPhase('prepared')
      return continueV2ReconstructionMigration(reconstruction, options)
    } catch (error) {
      return {
        status: 'blocked',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (sourceState === 'other' || sourceState === 'inaccessible') {
    return {
      status: 'blocked',
      authority: selection.authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'the legacy Runtime history path is not a readable directory'
    }
  }
  if (
    selection.authority === 'legacy' &&
    sourceState === 'missing' &&
    targetState !== 'missing' &&
    targetState !== 'dir'
  ) {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the canonical Runtime destination is not a readable directory'
    }
  }

  if (
    selection.authority === 'legacy' &&
    sourceState === 'missing' &&
    (targetState === 'missing' || targetState === 'dir')
  ) {
    try {
      if (targetState === 'missing') {
        mkdirSync(targetPath, { recursive: true, mode: 0o700 })
      }
      const target = runtimeTreeFingerprint(targetPath)
      const settingsBackupPaths = backUpSettingsFile(selection.writePath, now)
      rewriteSettingsToCurrent(selection.writePath)
      const completedAt = now().toISOString()
      const noSourceFingerprint = createHash('sha256')
        .update('no-legacy-source')
        .digest('hex')
      const journal: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'completed',
        provenance: 'no-legacy-source',
        sourcePath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          targetPath,
          'history-preserving-staging',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths,
        sourceThreadIds: [],
        sourceInventory: {
          files: 0,
          directories: 0,
          symlinks: 0,
          bytes: 0
        },
        sourceFingerprint: noSourceFingerprint,
        candidateFingerprint: target.fingerprint,
        salvaged: 0,
        conflicts: [],
        targetInventory: target.inventory,
        sqliteQuickCheck: validateSqliteIndex(targetPath),
        startedAt: completedAt,
        updatedAt: completedAt,
        completedAt
      }
      writeDurableJson(journalPath, journal)
      return maintainCompletedPreservationMigration(journal, options)
    } catch (error) {
      return {
        status: 'blocked',
        authority: 'legacy',
        sourcePath,
        targetPath,
        journalPath,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (
    selection.authority === 'current' &&
    sourceState === 'dir' &&
    targetState === 'dir'
  ) {
    const source = runtimeTreeFingerprint(sourcePath)
    const target = runtimeTreeFingerprint(targetPath)
    const targetThreadIds = new Set(threadIds(targetPath))
    const missing = source.threadIds.filter((threadId) => !targetThreadIds.has(threadId))
    if (missing.length > 0) {
      log('legacy-migration: current Runtime store does not include all preserved history', {
        sourcePath,
        targetPath,
        missingThreadCount: missing.length
      })
      const startedAt = now().toISOString()
      const journal: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'prepared',
        provenance: 'original-legacy-source',
        sourcePath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          targetPath,
          'history-preserving-staging',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths: [],
        mergeIntoCurrent: true,
        sourceThreadIds: source.threadIds,
        sourceInventory: source.inventory,
        sourceFingerprint: source.fingerprint,
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      options.afterPhase('prepared')
      return continueCurrentAuthorityMerge(journal, options)
    }
    const completedAt = now().toISOString()
    const journal: PreservationJournal = {
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      phase: 'completed',
      provenance: 'original-legacy-source',
      sourcePath,
      targetPath,
      stagingPath: uniqueSiblingBackup(
        targetPath,
        'history-preserving-staging',
        now
      ),
      settingsSourcePath: selection.sourcePath,
      settingsWritePath: selection.writePath,
      settingsBackupPaths: [],
      sourceThreadIds: source.threadIds,
      sourceInventory: source.inventory,
      sourceFingerprint: source.fingerprint,
      candidateFingerprint: target.fingerprint,
      salvaged: 0,
      conflicts: [],
      targetInventory: target.inventory,
      sqliteQuickCheck: validateSqliteIndex(targetPath),
      startedAt: completedAt,
      updatedAt: completedAt,
      completedAt
    }
    writeDurableJson(journalPath, journal)
    return maintainCompletedPreservationMigration(journal, options)
  }

  const recoverMissingCurrentFromLegacy =
    selection.authority === 'current' &&
    targetState === 'missing' &&
    sourceState === 'dir'
  if (
    (selection.authority !== 'legacy' && !recoverMissingCurrentFromLegacy) ||
    sourceState !== 'dir'
  ) return null
  if (targetState !== 'missing' && targetState !== 'dir') {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: 'canonical Runtime destination is not a regular directory or missing path'
    }
  }

  try {
    assertLegacyRuntimeInactive(sourcePath)
    if (targetState === 'dir') assertLegacyRuntimeInactive(targetPath)
    const source = runtimeTreeFingerprint(sourcePath)
    const startedAt = now().toISOString()
    const journal: PreservationJournal = {
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      phase: 'prepared',
      provenance: 'original-legacy-source',
      sourcePath,
      targetPath,
      stagingPath: uniqueSiblingBackup(
        targetPath,
        'history-preserving-staging',
        now
      ),
      ...(targetState === 'dir'
        ? {
            destinationBackupPath: uniqueSiblingBackup(
              targetPath,
              'pre-history-preserving-migration',
              now
            )
          }
        : {}),
      settingsSourcePath: selection.sourcePath,
      settingsWritePath: selection.writePath,
      settingsBackupPaths: [],
      sourceThreadIds: source.threadIds,
      sourceInventory: source.inventory,
      sourceFingerprint: source.fingerprint,
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    options.afterPhase('prepared')
    return continuePreservationMigration(journal, options)
  } catch (error) {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function runCanonicalKunRuntimeDataMigration(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult {
  try {
    if (!input.skipHistoryPreservationForTests) {
      const preservation = runPreservationMigrationIfNeeded(input)
      if (preservation) return preservation
      const platform = input.platform ?? process.platform
      const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
      const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
      const selection = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        pathState(sourcePath)
      )
      return {
        status: selection.authority === 'unknown' ? 'blocked' : 'not-needed',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath: join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME),
        ...(selection.authority === 'unknown'
          ? { message: 'could not determine Runtime data authority safely' }
          : {})
      }
    }
    return runCanonicalKunRuntimeDataMigrationUnsafe(input)
  } catch (error) {
    const platform = input.platform ?? process.platform
    const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
    const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath: join(input.userDataPath, JOURNAL_FILE_NAME),
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function runCanonicalKunRuntimeDataMigrationUnsafe(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult {
  const platform = input.platform ?? process.platform
  const log = input.log ?? (() => undefined)
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const assertLegacyRuntimeInactive = input.assertLegacyRuntimeInactive ?? (() => undefined)
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const journalPath = join(input.userDataPath, JOURNAL_FILE_NAME)
  const journalState = pathState(journalPath)
  let existingJournal = readJournal(journalPath)
  const sourceState = pathState(sourcePath)
  const targetState = pathState(targetPath)
  const settingsSelection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  if (settingsSelection.authority === 'custom') {
    return {
      status: 'not-needed',
      authority: 'custom',
      sourcePath,
      targetPath,
      journalPath
    }
  }
  if (journalState === 'inaccessible' || (journalState === 'other' && !existingJournal)) {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the Runtime migration journal is inaccessible or invalid'
    }
  }
  if (existingJournal) {
    const journalError = validateJournalForRecovery(existingJournal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform
    })
    if (journalError) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath,
        message: journalError
      }
    }
    if (existingJournal.phase !== 'completed') {
      const recoveredSettings = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        pathState(existingJournal.sourcePath)
      )
      const needsSettingsSource =
        !existingJournal.settingsSourcePath &&
        !existingJournal.settingsWritePath &&
        recoveredSettings.sourcePath !== undefined
      const needsSourceState =
        existingJournal.sourceWasMissing === undefined &&
        pathState(existingJournal.sourcePath) === 'symlink' &&
        linkResolvesToTarget(existingJournal.sourcePath, existingJournal.targetPath, platform)
      if (needsSettingsSource || needsSourceState) {
        existingJournal = updateJournal(
          journalPath,
          existingJournal,
          {
            ...(needsSettingsSource
              ? {
                  settingsSourcePath: recoveredSettings.sourcePath,
                  settingsWritePath: recoveredSettings.writePath
                }
              : {}),
            ...(needsSourceState ? { sourceWasMissing: true } : {})
          },
          now
        )
      }
    }
    if (existingJournal.phase === 'completed') {
      return maintainCompletedMigration(existingJournal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive
      })
    }
    return continueMigration(existingJournal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  }

  if (sourceState === 'inaccessible' || targetState === 'inaccessible') {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'a canonical Runtime path is inaccessible'
    }
  }
  let authority = settingsSelection.authority

  if (authority === 'unknown') {
    return {
      status: sourceState === 'missing' ? 'not-needed' : 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      ...(sourceState === 'missing' ? {} : { message: 'could not determine Runtime data authority from settings' })
    }
  }

  if (authority === 'current' && targetState === 'missing' && sourceState === 'dir') {
    // A previous settings repair can select the new default before legacy
    // Runtime data has been promoted. The existing legacy store is the only
    // available canonical authority, so recover it instead of blocking every
    // subsequent startup.
    authority = 'legacy'
  }

  if (authority === 'current') {
    if (targetState !== 'dir') {
      const genuinelyFresh = sourceState === 'missing' && targetState === 'missing'
      return {
        status: genuinelyFresh ? 'not-needed' : 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        ...(genuinelyFresh ? {} : { message: 'settings select the new Runtime directory but it is unavailable' })
      }
    }
    if (sourceState === 'missing') {
      return { status: 'not-needed', authority, sourcePath, targetPath, journalPath }
    }
    if (sourceState === 'symlink') {
      if (!linkResolvesToTarget(sourcePath, targetPath, platform)) {
        return {
          status: 'blocked',
          authority,
          sourcePath,
          targetPath,
          journalPath,
          message: 'legacy Runtime path is an unexpected symbolic link'
        }
      }
    }
    if (sourceState !== 'dir' && sourceState !== 'symlink') {
      return {
        status: 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'legacy Runtime path is neither a directory nor a compatible link'
      }
    }
    const completedAt = now().toISOString()
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'completed',
      sourcePath,
      targetPath,
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: true,
      extensionRegistryBackupPaths: [],
      sourceThreadIds: [],
      salvaged: 0,
      conflicts: [],
      startedAt: completedAt,
      updatedAt: completedAt,
      completedAt
    }
    writeDurableJson(journalPath, journal)
    return maintainCompletedMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive
    })
  }

  if (sourceState === 'symlink') {
    if (!linkResolvesToTarget(sourcePath, targetPath, platform)) {
      return {
        status: 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'legacy Runtime path is an unexpected symbolic link'
      }
    }
    const startedAt = now().toISOString()
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'link-created',
      sourcePath,
      targetPath,
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: false,
      extensionRegistryBackupPaths: [],
      sourceWasMissing: true,
      sourceThreadIds: threadIds(targetPath),
      sourceInventory: runtimeStoreInventory(targetPath),
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    return continueMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  }

  if (sourceState !== 'dir') {
    if (sourceState === 'missing' && targetState === 'dir') {
      const startedAt = now().toISOString()
      const journal: RuntimeMigrationJournal = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        phase: 'source-promoted',
        sourcePath,
        targetPath,
        cutoverConflictBackupPaths: [],
        settingsSourcePath: settingsSelection.sourcePath,
        settingsWritePath: settingsSelection.writePath,
        settingsBackupPaths: [],
        settingsBackedUp: false,
        extensionRegistryBackupPaths: [],
        sourceWasMissing: true,
        sourceThreadIds: threadIds(targetPath),
        sourceInventory: runtimeStoreInventory(targetPath),
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      return continueMigration(journal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive,
        afterPhase: input.afterPhase ?? (() => undefined),
        beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
      })
    }
    if (sourceState === 'missing' && targetState === 'missing') {
      const startedAt = now().toISOString()
      const journal: RuntimeMigrationJournal = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        phase: 'prepared',
        sourcePath,
        targetPath,
        cutoverConflictBackupPaths: [],
        settingsSourcePath: settingsSelection.sourcePath,
        settingsWritePath: settingsSelection.writePath,
        settingsBackupPaths: [],
        settingsBackedUp: false,
        extensionRegistryBackupPaths: [],
        sourceWasMissing: true,
        sourceThreadIds: [],
        sourceInventory: {
          files: 0,
          directories: 0,
          symlinks: 0,
          bytes: 0
        },
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      return continueMigration(journal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive,
        afterPhase: input.afterPhase ?? (() => undefined),
        beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
      })
    }
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select the legacy Runtime directory but no migratable directory exists'
    }
  }
  if (targetState === 'symlink' || targetState === 'other') {
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'canonical Runtime destination is not a regular directory or missing path'
    }
  }

  try {
    assertLegacyRuntimeInactive(sourcePath)
    if (targetState === 'dir') assertLegacyRuntimeInactive(targetPath)
    assertSameVolume(
      sourcePath,
      targetPath,
      platform,
      input.statDevice ?? ((path) => statSync(path).dev)
    )
    const startedAt = now().toISOString()
    const destinationBackupPath = targetState === 'dir'
      ? uniqueSiblingBackup(targetPath, 'pre-deepseekgui-migration', now)
      : undefined
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'prepared',
      sourcePath,
      targetPath,
      ...(destinationBackupPath ? { destinationBackupPath } : {}),
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: false,
      extensionRegistryBackupPaths: [],
      sourceThreadIds: threadIds(sourcePath),
      sourceInventory: runtimeStoreInventory(sourcePath),
      ...(targetState === 'dir'
        ? { destinationInventory: runtimeStoreInventory(targetPath) }
        : {}),
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    return continueMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('legacy-migration: failed before canonical Runtime migration mutation', {
      sourcePath,
      targetPath,
      message
    })
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message
    }
  }
}

export type RuntimeMigrationRuntimeVerification =
  | {
      status: 'not-needed'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: []
    }
  | {
      status: 'incomplete'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: string[]
    }
  | {
      status: 'verified'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: []
    }

export function markCanonicalKunRuntimeMigrationRuntimeVerified(
  userDataPath: string,
  visibleRuntimeThreadIds: Iterable<string>,
  now: () => Date = () => new Date()
): RuntimeMigrationRuntimeVerification {
  const visibleIds = new Set(visibleRuntimeThreadIds)
  const verifyJournal = (sourceThreadIds: string[], targetPath: string) => {
    const expectedThreadIds = [...new Set([
      ...sourceThreadIds,
      ...threadIds(targetPath)
    ])]
    const missingThreadIds = expectedThreadIds.filter((threadId) => !visibleIds.has(threadId))
    if (missingThreadIds.length > 0) {
      return {
        status: 'incomplete' as const,
        expectedThreadCount: expectedThreadIds.length,
        visibleThreadCount: visibleIds.size,
        missingThreadIds
      }
    }
    return {
      status: 'complete' as const,
      expectedThreadCount: expectedThreadIds.length,
      visibleThreadCount: visibleIds.size
    }
  }

  const preservationJournalPath = join(userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const preservationJournal = readPreservationJournal(preservationJournalPath)
  if (preservationJournal?.phase === 'completed') {
    const verification = verifyJournal(
      preservationJournal.sourceThreadIds,
      preservationJournal.targetPath
    )
    if (verification.status === 'incomplete') {
      if (preservationJournal.runtimeVerifiedAt) {
        const unverified = updatePreservationJournal(
          preservationJournalPath,
          preservationJournal,
          { runtimeVerifiedAt: undefined },
          now
        )
        writePreservationReport(userDataPath, unverified)
      }
      return verification
    }
    if (preservationJournal.runtimeVerifiedAt) {
      return {
        ...verification,
        status: 'not-needed',
        missingThreadIds: []
      }
    }
    const verified = updatePreservationJournal(
      preservationJournalPath,
      preservationJournal,
      {
        runtimeVerifiedAt: now().toISOString(),
        error: undefined
      },
      now
    )
    writePreservationReport(userDataPath, verified)
    return {
      ...verification,
      status: 'verified',
      missingThreadIds: []
    }
  }
  const journalPath = join(userDataPath, JOURNAL_FILE_NAME)
  const journal = readJournal(journalPath)
  if (!journal || journal.phase !== 'completed') {
    return {
      status: 'not-needed',
      expectedThreadCount: 0,
      visibleThreadCount: visibleIds.size,
      missingThreadIds: []
    }
  }
  const verification = verifyJournal(journal.sourceThreadIds, journal.targetPath)
  if (verification.status === 'incomplete') {
    if (journal.runtimeVerifiedAt) {
      const unverified = updateJournal(
        journalPath,
        journal,
        { runtimeVerifiedAt: undefined },
        now
      )
      writeReport(userDataPath, unverified)
    }
    return verification
  }
  if (journal.runtimeVerifiedAt) {
    return {
      ...verification,
      status: 'not-needed',
      missingThreadIds: []
    }
  }
  const verified = updateJournal(
    journalPath,
    journal,
    {
      runtimeVerifiedAt: now().toISOString(),
      error: undefined
    },
    now
  )
  writeReport(userDataPath, verified)
  return {
    ...verification,
    status: 'verified',
    missingThreadIds: []
  }
}
