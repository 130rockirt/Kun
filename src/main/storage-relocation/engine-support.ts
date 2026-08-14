import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  createReadStream
} from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  STORAGE_RELOCATION_SCHEMA_VERSION,
  STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH,
  StorageRelocationOperationJournalSchema,
  StorageRelocationPreflightPlanSchema,
  StorageRelocationProgressSchema,
  StorageRelocationStatusSchema,
  isStorageRelocationPhaseTransitionAllowed,
  storageRelocationRequiredBytes,
  type StorageRelocationActiveWork,
  type StorageRelocationError,
  type StorageRelocationOperationJournal,
  type StorageRelocationPhase,
  type StorageRelocationPreflightPlan,
  type StorageRelocationProgress,
  type StorageRelocationReport,
  type StorageRelocationRoot,
  type StorageRelocationRootName,
  type StorageRelocationStatus
} from '../../shared/storage-relocation'
import {
  STORAGE_RELOCATION_OWNERSHIP_MARKER,
  STORAGE_RELOCATION_ROOT_NAMES,
  backupRootPath,
  copyWindowsAcls,
  hardenStorageDestinationAcl,
  inspectStorageRoot,
  inspectWindowsVolume,
  stagingRootPath,
  storageLogicalRoot,
  targetRootPath,
  uniqueSourceBytes,
  validateDestinationPath,
  type StorageRelocationVolumeInfo,
  type StorageTreeInventory
} from './paths'
import {
  StorageRelocationStore,
  type StorageRelocationLocationRecord
} from './store'

export const TRANSIENT_RELATIVE_PATHS = new Set([
  'control/manager.json',
  'control/.manager-start.lock',
  'control/manager-state.json',
  'control/manager.log',
  'control/runtime.development.json',
  'control/.runtime-discovery.lock',
  'data/runtime.json',
  'data/runtime.development.json',
  'data/.runtime-discovery.lock',
  'data/.kun-runtime-owner.json'
])
type FingerprintResult = StorageTreeInventory & { fingerprint: string }
export async function assertEmptyOrMissing(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw relocationError('unsafe_reparse_point', 'The selected destination is a reparse point.')
    }
    if (!metadata.isDirectory()) {
      throw relocationError('invalid_destination', 'The selected destination is not a folder.')
    }
    const entries = await readdir(path)
    if (entries.length === 1 && entries[0] === STORAGE_RELOCATION_OWNERSHIP_MARKER) {
      const marker = JSON.parse(await readFile(join(path, STORAGE_RELOCATION_OWNERSHIP_MARKER), 'utf8')) as {
        kind?: unknown
      }
      if (marker.kind === 'kun-storage-relocation-root') return
    }
    if (entries.length > 0) {
      throw relocationError('destination_not_empty', 'Choose an empty folder reserved for Kun data.')
    }
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return
    throw error
  }
}

export async function isOwnedRelocationRoot(
  physicalPath: string,
  name: StorageRelocationRootName
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(dirname(physicalPath), STORAGE_RELOCATION_OWNERSHIP_MARKER), 'utf8')
    ) as { kind?: unknown; roots?: Record<string, unknown> }
    return marker.kind === 'kun-storage-relocation-root' &&
      typeof marker.roots?.[name] === 'string' &&
      await samePhysicalPath(marker.roots[name], physicalPath)
  } catch {
    return false
  }
}

export async function samePhysicalPath(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    realpath(left).catch(() => resolve(left)),
    realpath(right).catch(() => resolve(right))
  ])
  return resolve(leftPath) === resolve(rightPath)
}

export async function ensureDestinationForOperation(journal: StorageRelocationOperationJournal): Promise<void> {
  await mkdir(journal.destinationRoot, { recursive: true, mode: 0o700 })
  await hardenStorageDestinationAcl(journal.destinationRoot)
  if (journal.kind !== 'move') return
  const allowed = new Set([
    STORAGE_RELOCATION_OWNERSHIP_MARKER,
    ...journal.roots.flatMap((root) => [basename(root.stagingPath), basename(root.targetPath)])
  ])
  const unexpected = (await readdir(journal.destinationRoot)).filter((name) => !allowed.has(name))
  if (unexpected.length > 0) {
    throw relocationError(
      'destination_not_empty',
      `The relocation destination now contains unexpected data: ${unexpected.slice(0, 3).join(', ')}`
    )
  }
}

export async function fingerprintTree(rootPath: string): Promise<FingerprintResult> {
  const hash = createHash('sha256')
  const inventory: StorageTreeInventory = { files: 0, directories: 0, links: 0, bytes: 0 }
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    const rel = canonicalRelative(rootPath, path)
    if (rel !== '.' && isTransient(rel)) return
    if (metadata.isSymbolicLink()) {
      inventory.links += 1
      inventory.bytes += metadata.size
      hash.update(`link\0${rel}\0${await readlink(path)}\0`)
      return
    }
    if (metadata.isDirectory()) {
      inventory.directories += 1
      hash.update(`dir\0${rel}\0${metadata.mode & 0o7777}\0`)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!metadata.isFile()) throw new Error(`unsupported storage entry: ${path}`)
    inventory.files += 1
    inventory.bytes += metadata.size
    hash.update(`file\0${rel}\0${metadata.mode & 0o7777}\0${metadata.size}\0`)
    await new Promise<void>((resolveStream, reject) => {
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.once('error', reject)
      stream.once('end', resolveStream)
    })
    hash.update('\0')
  }
  await visit(rootPath)
  return { ...inventory, fingerprint: hash.digest('hex') }
}

export async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  options: {
    signal: AbortSignal
    onFile: (sourcePath: string, bytes: number) => void
  }
): Promise<void> {
  const visit = async (sourcePath: string, targetPath: string): Promise<void> => {
    if (options.signal.aborted) throw options.signal.reason
    const metadata = await lstat(sourcePath)
    const rel = canonicalRelative(sourceRoot, sourcePath)
    if (rel !== '.' && isTransient(rel)) return
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath)
      try {
        const targetMetadata = await lstat(targetPath)
        if (!targetMetadata.isSymbolicLink() || await readlink(targetPath) !== linkTarget) {
          throw new Error(`staging contains a different link: ${targetPath}`)
        }
      } catch (error) {
        if (String((error as NodeJS.ErrnoException).code) !== 'ENOENT') throw error
        const targetIsDirectory = await stat(sourcePath).then((value) => value.isDirectory()).catch(() => false)
        await symlink(linkTarget, targetPath, targetIsDirectory && process.platform === 'win32' ? 'junction' : targetIsDirectory ? 'dir' : 'file')
      }
      options.onFile(sourcePath, metadata.size)
      return
    }
    if (metadata.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: (metadata.mode & 0o7777) | 0o700 })
      for (const name of (await readdir(sourcePath)).sort()) {
        await visit(join(sourcePath, name), join(targetPath, name))
      }
      await chmod(targetPath, metadata.mode & 0o7777).catch(ignoreWindowsMetadataError)
      await utimes(targetPath, metadata.atime, metadata.mtime).catch(ignoreWindowsMetadataError)
      return
    }
    if (!metadata.isFile()) throw new Error(`unsupported storage entry: ${sourcePath}`)
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
    const partialPath = join(dirname(targetPath), `.${basename(targetPath)}.kun-relocation-partial`)
    await rm(partialPath, { force: true })
    await copyFile(sourcePath, partialPath, constants.COPYFILE_FICLONE)
    await chmod(partialPath, metadata.mode & 0o7777).catch(ignoreWindowsMetadataError)
    await utimes(partialPath, metadata.atime, metadata.mtime).catch(ignoreWindowsMetadataError)
    await rename(partialPath, targetPath).catch(async (error) => {
      if (String((error as NodeJS.ErrnoException).code) !== 'EEXIST') throw error
      await rm(targetPath, { force: true })
      await rename(partialPath, targetPath)
    })
    options.onFile(sourcePath, metadata.size)
  }
  await visit(sourceRoot, targetRoot)
}

export async function activateMovedRoot(
  root: StorageRelocationOperationJournal['roots'][number],
  platform: NodeJS.Platform
): Promise<void> {
  await rename(root.stagingPath, root.targetPath)
  const current = await lstat(root.logicalPath)
  if (root.sourceWasJunction) {
    if (!current.isSymbolicLink() || resolve(await realpath(root.logicalPath)) !== resolve(root.sourcePhysicalPath)) {
      throw relocationError('cutover_failed', `The source junction changed: ${root.logicalPath}`)
    }
    await unlink(root.logicalPath)
  } else {
    if (!current.isDirectory() || !root.sourceBackupPath) {
      throw relocationError('cutover_failed', `The source root changed: ${root.logicalPath}`)
    }
    await rename(root.logicalPath, root.sourceBackupPath)
  }
  try {
    await createDirectoryLink(root.targetPath, root.logicalPath, platform)
  } catch (error) {
    if (root.sourceWasJunction) {
      await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, platform).catch(() => undefined)
    } else if (root.sourceBackupPath) {
      await rename(root.sourceBackupPath, root.logicalPath).catch(() => undefined)
    }
    throw error
  }
}

export async function activateRestoreRoot(
  root: StorageRelocationOperationJournal['roots'][number],
  platform: NodeJS.Platform
): Promise<void> {
  const current = await lstat(root.logicalPath)
  if (!root.sourceWasJunction || !current.isSymbolicLink()) {
    throw relocationError('cutover_failed', `Restore requires an app-owned junction: ${root.logicalPath}`)
  }
  if (resolve(await realpath(root.logicalPath)) !== resolve(root.sourcePhysicalPath)) {
    throw relocationError('cutover_failed', `The source junction changed: ${root.logicalPath}`)
  }
  await unlink(root.logicalPath)
  try {
    await rename(root.stagingPath, root.logicalPath)
  } catch (error) {
    await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, platform).catch(() => undefined)
    throw error
  }
}

export async function createDirectoryLink(
  target: string,
  path: string,
  platform: NodeJS.Platform
): Promise<void> {
  await symlink(target, path, platform === 'win32' ? 'junction' : 'dir')
}

export function validateRuntimeSqlite(dataDir: string): void {
  const path = join(dataDir, 'index.sqlite3')
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const result = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
      if (result?.quick_check !== 'ok') throw new Error('SQLite quick_check failed')
    } finally {
      db.close()
    }
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return
    if (/unable to open database file/iu.test(errorMessage(error))) return
    throw error
  }
}

export function progressFromJournal(
  journal: StorageRelocationOperationJournal,
  now: Date
): StorageRelocationProgress {
  return StorageRelocationProgressSchema.parse({
    operationId: journal.operationId,
    phase: journal.phase,
    completedBytes: journal.phase === 'prepared' || journal.phase === 'draining' ? 0 : journal.uniqueBytes,
    totalBytes: journal.uniqueBytes,
    completedItems: journal.roots.filter((root) => root.activated || root.targetFingerprint).length,
    totalItems: journal.roots.length,
    cancellable: journal.phase === 'prepared' || journal.phase === 'copying' || journal.phase === 'verifying',
    ...(journal.error ? { message: progressMessage(journal.error.message) } : {}),
    updatedAt: now.toISOString()
  })
}

export function progressMessage(message: string): string {
  if (message.length <= STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH) return message
  return `${message.slice(0, STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH - 3)}...`
}

export function locationFromJournal(
  journal: StorageRelocationOperationJournal,
  now: Date
): StorageRelocationLocationRecord {
  return {
    schemaVersion: 1,
    destinationRoot: journal.destinationRoot,
    roots: Object.fromEntries(journal.roots.map((root) => [root.name, root.targetPath])),
    operationId: journal.operationId,
    activatedAt: now.toISOString()
  }
}

export function canonicalRelative(root: string, path: string): string {
  const value = relative(root, path)
  return value === '' ? '.' : value.split(sep).join('/')
}

export function isTransient(relativePath: string): boolean {
  return TRANSIENT_RELATIVE_PATHS.has(relativePath)
}

export function relocationError(code: StorageRelocationError['code'], message: string): Error {
  return new Error(`${code}: ${message}`)
}

export function relocationErrorValue(
  code: StorageRelocationError['code'],
  message: string
): StorageRelocationError {
  return { code, message, nextActions: [] }
}

export function normalizeEngineError(error: unknown): StorageRelocationError {
  const message = errorMessage(error)
  const match = /^([a-z_]+):\s*(.*)$/u.exec(message)
  const code = match?.[1]
  const allowed = [
    'unsupported_platform', 'feature_disabled', 'custom_data_dir', 'invalid_destination',
    'destination_not_empty', 'destination_not_fixed_ntfs', 'destination_unavailable',
    'insufficient_space', 'unsafe_reparse_point', 'active_work_confirmation_required',
    'active_writer', 'copy_failed', 'verification_failed', 'cutover_failed',
    'health_check_failed', 'rollback_failed', 'cleanup_failed', 'journal_invalid',
    'operation_conflict', 'cancelled'
  ] as const
  return relocationErrorValue(
    allowed.includes(code as typeof allowed[number])
      ? code as typeof allowed[number]
      : 'copy_failed',
    match?.[2] || message
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ignoreWindowsMetadataError(error: unknown): void {
  if (process.platform === 'win32') return
  throw error
}
