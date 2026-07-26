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
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
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

const JOURNAL_FILE_NAME = 'kun-runtime-data-migration-v2.json'
const REPORT_FILE_NAME = 'kun-runtime-data-migration-v2-report.json'
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
const MIGRATION_SCHEMA_VERSION = 2 as const

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
  beforeCompatibilityLink?: () => void
}

type RuntimeStoreInventory = {
  files: number
  directories: number
  symlinks: number
  bytes: number
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

function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  retryRuntimeMigrationMutation(
    () => renameSync(temporary, path),
    { platform: process.platform, sleep: defaultSleep }
  )
  try {
    const directoryHandle = openSync(dirname(path), 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  } catch {
    // Windows does not consistently allow opening directories for fsync.
  }
}

function readJournal(path: string): RuntimeMigrationJournal | null {
  if (pathState(path) !== 'other') return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeMigrationJournal>
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    const inventory = parsed.sourceInventory
    const cutoverConflictBackupPaths = parsed.cutoverConflictBackupPaths ?? []
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
  if (journal.phase === 'completed' && !journal.completedAt) {
    return 'the Runtime migration journal completed phase has no completion timestamp'
  }
  if (
    (journal.phase === 'salvaged' ||
      journal.phase === 'settings-rewritten' ||
      journal.phase === 'completed') &&
    journal.settingsBackedUp !== true
  ) {
    return 'the Runtime migration journal phase is inconsistent with settings backup state'
  }
  if (
    journal.phase === 'rollback-conflict-planned' &&
    journal.cutoverConflictBackupPaths.length === 0
  ) {
    return 'the Runtime migration rollback journal has no cutover-conflict backup path'
  }
  return null
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
  const state = pathState(settingsWritePath)
  if (state !== 'other') {
    throw new Error(`active settings file is unavailable: ${settingsWritePath}`)
  }
  const backupPath = uniqueSiblingBackup(
    settingsWritePath,
    'pre-runtime-data-migration',
    now
  )
  copyFileSync(settingsWritePath, backupPath, constants.COPYFILE_EXCL)
  try {
    chmodSync(backupPath, 0o600)
  } catch {
    // Windows ACLs are not represented by POSIX mode bits.
  }
  return [backupPath]
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
        conflicts: journal.conflicts.length
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
    if (pathState(journal.sourcePath) === 'dir') {
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const quarantinePath = uniqueSiblingBackup(
        journal.sourcePath,
        'post-migration',
        options.now
      )
      retryRuntimeMigrationMutation(
        () => renameSync(journal.sourcePath, quarantinePath),
        { platform: options.platform, sleep: options.sleep }
      )
      options.log('legacy-migration: quarantined reappearing legacy Runtime directory', {
        legacyPath: journal.sourcePath,
        quarantinePath
      })
    }
    createAndVerifyCompatibilityLink(
      journal.sourcePath,
      journal.targetPath,
      options.platform,
      options.sleep
    )
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

export function runCanonicalKunRuntimeDataMigration(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult {
  try {
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
      return { status: 'completed', authority, sourcePath, targetPath, journalPath }
    }
    if (sourceState !== 'dir') {
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

export function markCanonicalKunRuntimeMigrationRuntimeVerified(
  userDataPath: string,
  now: () => Date = () => new Date()
): boolean {
  const journalPath = join(userDataPath, JOURNAL_FILE_NAME)
  const journal = readJournal(journalPath)
  if (!journal || journal.phase !== 'completed' || journal.runtimeVerifiedAt) return false
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
  return true
}
