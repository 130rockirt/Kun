import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import {
  createHash
} from 'node:crypto'
import {
  dirname,
  join,
  resolve
} from 'node:path'
import {
  type RuntimeDataRecoveryCandidateKind,
  type RuntimeDataRecoveryCredentialState,
  type RuntimeDataRecoveryInventory
} from '../shared/runtime-data-recovery'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  type CandidateDescriptor,
  JSON_IDENTITY_ENTRIES,
  type MigrationJournalVerifiedCandidate,
  PROTECTED_IDENTITY_ENTRIES,
  type RuntimeDataDirRecoveryOptions,
  RuntimeDataRecoveryError,
  V3_JOURNAL
} from './runtime-data-dir-recovery-types'
import {
  inspectMigrationJournalVerifiedCandidate,
  migrationJournalPhaseCanProveStaging
} from './runtime-data-dir-recovery-discovery'
import { applyPosixModeSync } from '../../kun/src/security/posix-permissions.js'
import {
  stringArraysEqual
} from './runtime-data-dir-recovery-evidence'
import {
  candidateLabel,
  canonicalRelativePath,
  fsyncDirectoryBestEffort,
  fsyncFileBestEffort,
  inventoriesEqual,
  isContained,
  isObject,
  pathState,
  readBoundedFile,
  samePath
} from './runtime-data-dir-recovery-utils'



export function inspectCandidate(
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

export function revalidateCandidate(
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

export function readMigrationJournalVerifiedCandidate(
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

export function fingerprintTree(rootPath: string): {
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

export function hashFile(path: string): string {
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

export function inspectIdentity(rootPath: string): {
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

export function validateOptionalJson(path: string, failOnInvalid = true): void {
  const state = pathState(path)
  if (state === 'missing') return
  if (state !== 'file') {
    if (failOnInvalid) throw new Error('expected a regular JSON file')
    throw new Error('identity JSON is not a regular file')
  }
  JSON.parse(readBoundedFile(path, 16 * 1024 * 1024))
}

export function sqliteHeaderIsValid(rootPath: string): boolean {
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

export function providerCount(rootPath: string): number {
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

export function countChildren(path: string): number {
  try {
    if (pathState(path) !== 'directory') return 0
    return readdirSync(path).length
  } catch {
    return 0
  }
}

export function assertContainedSymlinks(rootPath: string, platform: NodeJS.Platform): void {
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

export function copyRuntimeTree(sourcePath: string, targetPath: string): void {
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
      applyPosixModeSync(targetEntry, metadata.mode & 0o7777)
      utimesSync(targetEntry, metadata.atime, metadata.mtime)
      fsyncFileBestEffort(targetEntry)
    } else {
      throw new Error('copy source contains an unsupported entry')
    }
  }
  applyPosixModeSync(targetPath, source.mode & 0o7777)
  utimesSync(targetPath, source.atime, source.mtime)
  fsyncDirectoryBestEffort(targetPath)
}
