import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import { z } from 'zod'
import { extensionError } from './errors.js'
import {
  assertCanonicalPackagePath,
  defaultManifestAdapter,
  manifestLocalResourceRoots,
  manifestReferencedFiles,
  manifestId,
  type ManifestAdapter
} from './manifest.js'
import type {
  ExtensionCompatibility,
  ExtensionIntegrityManifest,
  ExtensionManifest,
  ExtensionSignatureStatus
} from './types.js'

import {
  DEFAULT_EXTENSION_ARCHIVE_LIMITS,
  EXTENSION_INTEGRITY_FILE,
  IntegritySchema,
  REQUIRED_PACKAGE_FILES
} from './archive-core.js'
import type {
  ExtensionArchiveLimits,
  PackKunxOptions
} from './archive-core.js'

export async function makePackageTreeReadOnly(packageRoot: string): Promise<void> {
  if (process.platform === 'win32') return
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        await chmod(path, 0o555)
      } else if (entry.isFile()) {
        await chmod(path, 0o444)
      }
    }
  }
  await visit(packageRoot)
  await chmod(packageRoot, 0o555)
}

export function validateArchiveEntry(entry: yauzl.Entry, directory: boolean): string {
  if (entry.isEncrypted()) {
    throw extensionError('EXTENSION_ARCHIVE_ENCRYPTED', 'Encrypted archive entries are not supported', {
      path: entry.fileName
    })
  }
  if (!entry.canDecodeFileData() || ![0, 8].includes(entry.compressionMethod)) {
    throw extensionError('EXTENSION_ARCHIVE_COMPRESSION_UNSUPPORTED', 'Unsupported archive compression', {
      path: entry.fileName,
      compressionMethod: entry.compressionMethod
    })
  }
  const canonicalPath = assertCanonicalPackagePath(entry.fileName, directory)
  const platform = entry.versionMadeBy >>> 8
  if (platform === 3) {
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
    const fileType = unixMode & 0o170000
    if (fileType === 0o120000) {
      throw extensionError('EXTENSION_ARCHIVE_LINK_FORBIDDEN', 'Symbolic links are forbidden in extensions', {
        path: canonicalPath
      })
    }
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw extensionError('EXTENSION_ARCHIVE_LINK_FORBIDDEN', 'Non-regular archive entries are forbidden', {
        path: canonicalPath,
        fileType
      })
    }
    if (directory && fileType === 0o100000) {
      throw extensionError('EXTENSION_ARCHIVE_TYPE_MISMATCH', 'Archive directory has file attributes', {
        path: canonicalPath
      })
    }
    if (!directory && fileType === 0o040000) {
      throw extensionError('EXTENSION_ARCHIVE_TYPE_MISMATCH', 'Archive file has directory attributes', {
        path: canonicalPath
      })
    }
  }
  return canonicalPath
}

export function registerArchivePath(
  path: string,
  directory: boolean,
  archivePaths: Map<string, string>,
  pathKinds: Map<string, 'file' | 'directory'>
): void {
  const folded = portablePathKey(path)
  const prior = archivePaths.get(folded)
  if (prior !== undefined) {
    throw extensionError('EXTENSION_ARCHIVE_PATH_COLLISION', 'Archive paths collide after normalization', {
      first: prior,
      second: path
    })
  }
  archivePaths.set(folded, path)

  const parts = path.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = portablePathKey(parts.slice(0, index).join('/'))
    if (pathKinds.get(ancestor) === 'file') {
      throw extensionError('EXTENSION_ARCHIVE_PATH_COLLISION', 'Archive file is used as a directory', {
        path
      })
    }
    pathKinds.set(ancestor, 'directory')
  }
  const existingKind = pathKinds.get(folded)
  const nextKind = directory ? 'directory' : 'file'
  if (existingKind !== undefined && existingKind !== nextKind) {
    throw extensionError('EXTENSION_ARCHIVE_PATH_COLLISION', 'Archive path type is ambiguous', { path })
  }
  pathKinds.set(folded, nextKind)
}

export async function validateExtractedPackage(
  destination: string,
  manifest: ExtensionManifest,
  integrity: ExtensionIntegrityManifest,
  extractedPaths: Set<string>,
  actualDigests: Map<string, string>
): Promise<void> {
  for (const required of [...REQUIRED_PACKAGE_FILES, EXTENSION_INTEGRITY_FILE]) {
    if (!extractedPaths.has(required)) {
      throw extensionError('EXTENSION_PACKAGE_FILE_MISSING', 'Required package file is missing', {
        path: required
      })
    }
  }
  if (integrity.files[EXTENSION_INTEGRITY_FILE] !== undefined) {
    throw extensionError(
      'EXTENSION_INTEGRITY_INVALID',
      'Integrity manifest must not contain a digest for itself'
    )
  }
  const actualPackageFiles = new Set(extractedPaths)
  actualPackageFiles.delete(EXTENSION_INTEGRITY_FILE)
  const declaredFiles = new Set(Object.keys(integrity.files))
  if (!setEquals(actualPackageFiles, declaredFiles)) {
    throw extensionError('EXTENSION_PACKAGE_FILE_SET_MISMATCH', 'Package and integrity file sets differ', {
      undeclared: [...actualPackageFiles].filter((path) => !declaredFiles.has(path)),
      missing: [...declaredFiles].filter((path) => !actualPackageFiles.has(path))
    })
  }
  for (const [path, expected] of Object.entries(integrity.files)) {
    assertCanonicalPackagePath(path, false)
    const actual = actualDigests.get(path)
    if (actual !== expected) {
      throw extensionError('EXTENSION_PACKAGE_INTEGRITY_MISMATCH', 'Package file digest mismatch', {
        path,
        expected,
        actual
      })
    }
  }
  assertManifestReferencedFiles(manifest, actualPackageFiles)
  await assertResourceRoots(destination, manifest)
}

export function assertManifestReferencedFiles(manifest: ExtensionManifest, files: Set<string>): void {
  for (const path of manifestReferencedFiles(manifest)) {
    if (!files.has(path)) {
      throw extensionError('EXTENSION_ENTRYPOINT_MISSING', 'Manifest referenced file is missing', {
        path
      })
    }
  }
}

export async function assertResourceRoots(packageRoot: string, manifest: ExtensionManifest): Promise<void> {
  for (const root of manifestLocalResourceRoots(manifest)) {
    const resourcePath = safeDestination(packageRoot, root)
    const details = await lstat(resourcePath).catch((error: unknown) => {
      throw extensionError('EXTENSION_RESOURCE_ROOT_INVALID', 'Local resource root is missing', {
        root
      }, error)
    })
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw extensionError('EXTENSION_RESOURCE_ROOT_INVALID', 'Local resource root must be a directory', {
        root
      })
    }
  }
}

export function parseIntegrity(value: unknown): ExtensionIntegrityManifest {
  const parsed = IntegritySchema.safeParse(value)
  if (!parsed.success) {
    throw extensionError('EXTENSION_INTEGRITY_INVALID', 'Package integrity manifest is invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    })
  }
  return parsed.data
}

export async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  const details = await stat(path)
  enforceLimit('manifestBytes', details.size, maxBytes, path)
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw extensionError('EXTENSION_PACKAGE_JSON_INVALID', 'Package JSON file is invalid', { path }, error)
  }
}

export async function ensureEmptyDirectory(destination: string): Promise<void> {
  try {
    const details = await lstat(destination)
    if (!details.isDirectory()) {
      throw extensionError('EXTENSION_STAGING_INVALID', 'Staging destination must be a directory', {
        destination
      })
    }
    if ((await readdir(destination)).length !== 0) {
      throw extensionError('EXTENSION_STAGING_NOT_EMPTY', 'Staging destination must be empty', {
        destination
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    await mkdir(destination, { recursive: true, mode: 0o700 })
  }
}

export function safeDestination(root: string, canonicalPath: string): string {
  const target = resolve(root, ...canonicalPath.split('/'))
  const resolvedRoot = resolve(root)
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw extensionError('EXTENSION_ARCHIVE_PATH_INVALID', 'Archive path escapes staging root', {
      path: canonicalPath
    })
  }
  return target
}

export async function assertNoLinkParents(root: string, parent: string): Promise<void> {
  const resolvedRoot = resolve(root)
  const relativeParent = relative(resolvedRoot, resolve(parent))
  let current = resolvedRoot
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, part)
    const details = await lstat(current)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw extensionError('EXTENSION_ARCHIVE_LINK_FORBIDDEN', 'Staging path contains a link', {
        path: current
      })
    }
  }
}

export type PackageFile = { path: string; absolutePath: string; size: number }

export const FORBIDDEN_PACKAGE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.direnv',
  '.git',
  '.gnupg',
  '.hg',
  '.ssh',
  '.svn',
  'node_modules'
])

export const FORBIDDEN_PACKAGE_FILE_NAMES = new Set([
  '.envrc',
  '.netrc',
  '.npmrc',
  '.yarnrc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'private-key',
  'private_key',
  'secret',
  'secrets'
])

export const FORBIDDEN_PACKAGE_FILE_EXTENSIONS = new Set([
  '.jks',
  '.key',
  '.keystore',
  '.kubeconfig',
  '.p12',
  '.pem',
  '.pfx'
])

export async function collectPackFiles(
  sourceRoot: string,
  excludedOutput: string,
  manifest: ExtensionManifest,
  limits: ExtensionArchiveLimits,
  options: Pick<PackKunxOptions, 'include' | 'ignore'>
): Promise<PackageFile[]> {
  const files = new Map<string, PackageFile>()
  const ignored = (options.ignore ?? []).map((rule) => canonicalPackRule(rule, 'ignore'))
  let totalBytes = 0

  const isIgnored = (packagePath: string): boolean =>
    ignored.some((rule) => packagePath === rule || packagePath.startsWith(`${rule}/`))

  const addFile = async (packagePath: string, absolutePath: string): Promise<void> => {
    if (resolve(absolutePath) === excludedOutput || isIgnored(packagePath)) return
    const forbiddenReason = forbiddenPackagePathReason(packagePath)
    if (forbiddenReason !== undefined) {
      throw extensionError(
        'EXTENSION_PACKAGE_FORBIDDEN_PATH',
        'Selected release files contain a path that must not be packaged',
        { path: packagePath, reason: forbiddenReason }
      )
    }
    await assertNoSourceLinkParents(sourceRoot, absolutePath)
    const details = await lstat(absolutePath).catch((error: unknown) => {
      throw extensionError(
        'EXTENSION_PACKAGE_FILE_MISSING',
        'Selected package file is missing',
        { path: packagePath },
        error
      )
    })
    if (details.isSymbolicLink()) {
      throw extensionError('EXTENSION_PACKAGE_LINK_FORBIDDEN', 'Package source cannot contain links', {
        path: packagePath
      })
    }
    if (!details.isFile()) {
      throw extensionError(
        'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
        'Selected package path must be a regular file',
        { path: packagePath }
      )
    }
    if (files.has(packagePath)) return
    enforceLimit('fileBytes', details.size, limits.maxFileBytes, packagePath)
    totalBytes += details.size
    enforceLimit('expandedBytes', totalBytes, limits.maxExpandedBytes)
    files.set(packagePath, { path: packagePath, absolutePath, size: details.size })
    enforceLimit('files', files.size, limits.maxFiles)
  }

  const visitDirectory = async (packageRoot: string): Promise<void> => {
    if (isIgnored(packageRoot)) return
    const forbiddenReason = forbiddenPackagePathReason(packageRoot)
    if (forbiddenReason !== undefined) {
      throw extensionError(
        'EXTENSION_PACKAGE_FORBIDDEN_PATH',
        'Selected release directory must not be packaged',
        { path: packageRoot, reason: forbiddenReason }
      )
    }
    const absoluteRoot = safeDestination(sourceRoot, packageRoot)
    await assertNoSourceLinkParents(sourceRoot, absoluteRoot)
    const rootDetails = await lstat(absoluteRoot).catch((error: unknown) => {
      throw extensionError(
        'EXTENSION_PACKAGE_INCLUDE_MISSING',
        'Selected package directory is missing',
        { path: packageRoot },
        error
      )
    })
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw extensionError(
        rootDetails.isSymbolicLink()
          ? 'EXTENSION_PACKAGE_LINK_FORBIDDEN'
          : 'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
        'Selected package directory must be a real directory',
        { path: packageRoot }
      )
    }

    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const entry of entries) {
        const absolutePath = join(directory, entry.name)
        const packagePath = relative(sourceRoot, absolutePath).split(sep).join('/')
        assertCanonicalPackagePath(packagePath, entry.isDirectory())
        if (resolve(absolutePath) === excludedOutput || isIgnored(packagePath)) continue
        const entryForbiddenReason = forbiddenPackagePathReason(packagePath)
        if (entryForbiddenReason !== undefined) {
          throw extensionError(
            'EXTENSION_PACKAGE_FORBIDDEN_PATH',
            'Selected release files contain a path that must not be packaged',
            { path: packagePath, reason: entryForbiddenReason }
          )
        }
        const details = await lstat(absolutePath)
        if (details.isSymbolicLink()) {
          throw extensionError(
            'EXTENSION_PACKAGE_LINK_FORBIDDEN',
            'Package source cannot contain links',
            { path: packagePath }
          )
        }
        if (details.isDirectory()) await visit(absolutePath)
        else if (details.isFile()) await addFile(packagePath, absolutePath)
        else {
          throw extensionError(
            'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
            'Package source contains a special file',
            { path: packagePath }
          )
        }
      }
    }
    await visit(absoluteRoot)
  }

  const exactFiles = new Set<string>([
    ...REQUIRED_PACKAGE_FILES,
    ...manifestReferencedFiles(manifest)
  ])
  const recursiveRoots = new Set(manifestLocalResourceRoots(manifest))

  for (const rawRule of options.include ?? []) {
    const packagePath = canonicalPackRule(rawRule, 'include')
    const forbiddenReason = forbiddenPackagePathReason(packagePath)
    if (forbiddenReason !== undefined) {
      throw extensionError(
        'EXTENSION_PACKAGE_FORBIDDEN_PATH',
        'An include rule targets a path that must not be packaged',
        { path: packagePath, reason: forbiddenReason }
      )
    }
    const absolutePath = safeDestination(sourceRoot, packagePath)
    await assertNoSourceLinkParents(sourceRoot, absolutePath)
    const details = await lstat(absolutePath).catch((error: unknown) => {
      throw extensionError(
        'EXTENSION_PACKAGE_INCLUDE_MISSING',
        'Package include path is missing',
        { path: packagePath },
        error
      )
    })
    if (details.isSymbolicLink()) {
      throw extensionError('EXTENSION_PACKAGE_LINK_FORBIDDEN', 'Package include cannot be a link', {
        path: packagePath
      })
    }
    if (details.isDirectory()) recursiveRoots.add(packagePath)
    else if (details.isFile()) exactFiles.add(packagePath)
    else {
      throw extensionError(
        'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
        'Package include must be a regular file or directory',
        { path: packagePath }
      )
    }
  }

  for (const packagePath of [...exactFiles].sort()) {
    await addFile(packagePath, safeDestination(sourceRoot, packagePath))
  }
  for (const packageRoot of [...recursiveRoots].sort()) await visitDirectory(packageRoot)

  const portablePaths = new Map<string, string>()
  for (const file of files.values()) {
    const key = portablePathKey(file.path)
    const existing = portablePaths.get(key)
    if (existing !== undefined && existing !== file.path) {
      throw extensionError('EXTENSION_PACKAGE_PATH_COLLISION', 'Package source paths collide portably', {
        first: existing,
        second: file.path
      })
    }
    portablePaths.set(key, file.path)
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export function canonicalPackRule(value: string, kind: 'include' | 'ignore'): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed !== value) {
    throw extensionError(
      'EXTENSION_PACKAGE_RULE_INVALID',
      `Package ${kind} rule must not be empty or padded with whitespace`,
      { kind, rule: value }
    )
  }
  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  try {
    return assertCanonicalPackagePath(withoutTrailingSlash, true)
  } catch (error) {
    throw extensionError(
      'EXTENSION_PACKAGE_RULE_INVALID',
      `Package ${kind} rule must be a canonical package-relative path`,
      { kind, rule: value },
      error
    )
  }
}

export function forbiddenPackagePathReason(packagePath: string): string | undefined {
  const segments = packagePath.split('/').map((segment) => segment.toLocaleLowerCase('en-US'))
  const forbiddenDirectory = segments.find((segment) =>
    FORBIDDEN_PACKAGE_DIRECTORY_NAMES.has(segment)
  )
  if (forbiddenDirectory !== undefined) return `forbidden-directory:${forbiddenDirectory}`

  const fileName = segments.at(-1) ?? ''
  if (fileName === EXTENSION_INTEGRITY_FILE.toLocaleLowerCase('en-US')) {
    return 'generated-integrity-file'
  }
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'dotenv-file'
  if (fileName.endsWith('.kunx')) return 'nested-package'
  if (FORBIDDEN_PACKAGE_FILE_NAMES.has(fileName)) return `sensitive-file:${fileName}`
  const extensionIndex = fileName.lastIndexOf('.')
  const extension = extensionIndex < 0 ? '' : fileName.slice(extensionIndex)
  if (FORBIDDEN_PACKAGE_FILE_EXTENSIONS.has(extension)) return `credential-file:${extension}`
  if (/^(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini)$/.test(fileName)) {
    return 'credential-config'
  }
  if (/^private[-_.]?key(?:\.[a-z0-9_-]+)?$/.test(fileName)) return 'private-key-file'
  return undefined
}

export async function assertNoSourceLinkParents(sourceRoot: string, target: string): Promise<void> {
  const resolvedRoot = resolve(sourceRoot)
  const relativeTarget = relative(resolvedRoot, resolve(target))
  if (
    relativeTarget.length === 0 ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw extensionError('EXTENSION_ARCHIVE_PATH_INVALID', 'Package source path escapes source root', {
      path: relativeTarget
    })
  }
  let current = resolvedRoot
  for (const part of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, part)
    const details = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (details === undefined) return
    if (details.isSymbolicLink()) {
      throw extensionError('EXTENSION_PACKAGE_LINK_FORBIDDEN', 'Package source path contains a link', {
        path: relative(sourceRoot, current).split(sep).join('/')
      })
    }
  }
}

export async function collectPackageFiles(
  sourceRoot: string,
  excludedOutput: string,
  limits: ExtensionArchiveLimits,
  includeIntegrity = false
): Promise<PackageFile[]> {
  const files: PackageFile[] = []
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (resolve(absolutePath) === excludedOutput) continue
      const details = await lstat(absolutePath)
      if (details.isSymbolicLink()) {
        throw extensionError('EXTENSION_PACKAGE_LINK_FORBIDDEN', 'Package source cannot contain links', {
          path: relative(sourceRoot, absolutePath)
        })
      }
      if (details.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!details.isFile()) {
        throw extensionError('EXTENSION_PACKAGE_FILE_TYPE_INVALID', 'Package source contains a special file', {
          path: relative(sourceRoot, absolutePath)
        })
      }
      const packagePath = relative(sourceRoot, absolutePath).split(sep).join('/')
      assertCanonicalPackagePath(packagePath, false)
      if (!includeIntegrity && packagePath === EXTENSION_INTEGRITY_FILE) continue
      enforceLimit('fileBytes', details.size, limits.maxFileBytes, packagePath)
      totalBytes += details.size
      enforceLimit('expandedBytes', totalBytes, limits.maxExpandedBytes)
      files.push({ path: packagePath, absolutePath, size: details.size })
      enforceLimit('files', files.length, limits.maxFiles)
    }
  }
  await visit(sourceRoot)
  const portablePaths = new Map<string, string>()
  for (const file of files) {
    const key = portablePathKey(file.path)
    const existing = portablePaths.get(key)
    if (existing !== undefined) {
      throw extensionError('EXTENSION_PACKAGE_PATH_COLLISION', 'Package source paths collide portably', {
        first: existing,
        second: file.path
      })
    }
    portablePaths.set(key, file.path)
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return files
}

export function archiveLimits(overrides: Partial<ExtensionArchiveLimits> | undefined): ExtensionArchiveLimits {
  const limits = { ...DEFAULT_EXTENSION_ARCHIVE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw extensionError('EXTENSION_ARCHIVE_LIMIT_INVALID', 'Archive limit must be a positive integer', {
        name,
        value
      })
    }
  }
  return limits
}

export function enforceLimit(name: string, value: number, maximum: number, path?: string): void {
  if (value <= maximum) return
  throw extensionError('EXTENSION_ARCHIVE_LIMIT_EXCEEDED', 'Extension package exceeds a safety limit', {
    limit: name,
    value,
    maximum,
    ...(path === undefined ? {} : { path })
  })
}

export function portablePathKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US')
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  const input = createReadStream(path)
  for await (const chunk of input) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

export function setEquals<T>(left: Set<T>, right: Set<T>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}
