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
  archiveLimits,
  assertManifestReferencedFiles,
  assertNoLinkParents,
  assertNoSourceLinkParents,
  assertResourceRoots,
  collectPackFiles,
  collectPackageFiles,
  enforceLimit,
  ensureEmptyDirectory,
  parseIntegrity,
  portablePathKey,
  readBoundedJson,
  registerArchivePath,
  safeDestination,
  setEquals,
  sha256File,
  validateArchiveEntry,
  validateExtractedPackage
} from './archive-support.js'

export const EXTENSION_MANIFEST_FILE = 'kun-extension.json'
export const EXTENSION_INTEGRITY_FILE = 'kun-extension.integrity.json'
export const EXTENSION_README_FILE = 'README.md'
export const EXTENSION_LICENSE_FILE = 'LICENSE'

export const REQUIRED_PACKAGE_FILES = [
  EXTENSION_MANIFEST_FILE,
  EXTENSION_README_FILE,
  EXTENSION_LICENSE_FILE
] as const

export type ExtensionArchiveLimits = {
  maxArchiveBytes: number
  maxExpandedBytes: number
  maxFileBytes: number
  maxFiles: number
  maxManifestBytes: number
}

export const DEFAULT_EXTENSION_ARCHIVE_LIMITS: Readonly<ExtensionArchiveLimits> = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 5_000,
  maxManifestBytes: 1024 * 1024
})

export type ExtractedKunx = {
  archivePath: string
  destination: string
  archiveSha256: string
  manifest: ExtensionManifest
  integrity: ExtensionIntegrityManifest
  signatureStatus: ExtensionSignatureStatus
  fileCount: number
  expandedBytes: number
}

export type ArchiveValidationOptions = {
  limits?: Partial<ExtensionArchiveLimits>
  compatibility?: ExtensionCompatibility
  manifestAdapter?: ManifestAdapter
}

export const IntegritySchema = z.object({
  algorithm: z.literal('sha256'),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
}).strict()

export async function extractKunxArchive(
  archivePath: string,
  destination: string,
  options: ArchiveValidationOptions = {}
): Promise<ExtractedKunx> {
  const limits = archiveLimits(options.limits)
  const adapter = options.manifestAdapter ?? defaultManifestAdapter
  const archiveStats = await stat(archivePath)
  if (!archiveStats.isFile()) {
    throw extensionError('EXTENSION_ARCHIVE_NOT_FILE', 'Extension archive must be a regular file', {
      archivePath
    })
  }
  enforceLimit('archiveBytes', archiveStats.size, limits.maxArchiveBytes)
  await ensureEmptyDirectory(destination)

  const archiveSha256 = await sha256File(archivePath)
  const actualDigests = new Map<string, string>()
  const extractedPaths = new Set<string>()
  const archivePaths = new Map<string, string>()
  const pathKinds = new Map<string, 'file' | 'directory'>()
  let expandedBytes = 0
  let fileCount = 0
  let zipfile: yauzl.ZipFile | undefined

  try {
    zipfile = await yauzl.openPromise(archivePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false
    })
    enforceLimit('files', zipfile.entryCount, limits.maxFiles)

    for await (const entry of zipfile.eachEntry()) {
      const directory = entry.fileName.endsWith('/')
      const canonicalPath = validateArchiveEntry(entry, directory)
      registerArchivePath(canonicalPath, directory, archivePaths, pathKinds)
      if (directory) {
        await mkdir(join(destination, ...canonicalPath.split('/')), {
          recursive: true,
          mode: 0o700
        })
        continue
      }

      fileCount += 1
      enforceLimit('files', fileCount, limits.maxFiles)
      enforceLimit('fileBytes', entry.uncompressedSize, limits.maxFileBytes, canonicalPath)
      expandedBytes += entry.uncompressedSize
      enforceLimit('expandedBytes', expandedBytes, limits.maxExpandedBytes)

      const target = safeDestination(destination, canonicalPath)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await assertNoLinkParents(destination, dirname(target))
      const input = await zipfile.openReadStreamPromise(entry)
      const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
      const digest = createHash('sha256')
      let streamedBytes = 0
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamedBytes += chunk.length
          if (streamedBytes > limits.maxFileBytes) {
            callback(
              extensionError('EXTENSION_ARCHIVE_LIMIT_EXCEEDED', 'Expanded file exceeds limit', {
                limit: 'fileBytes',
                path: canonicalPath,
                maximum: limits.maxFileBytes
              })
            )
            return
          }
          digest.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(input, limiter, output)
      if (streamedBytes !== entry.uncompressedSize) {
        throw extensionError('EXTENSION_ARCHIVE_SIZE_MISMATCH', 'Archive entry size changed while extracting', {
          path: canonicalPath,
          declared: entry.uncompressedSize,
          actual: streamedBytes
        })
      }
      extractedPaths.add(canonicalPath)
      actualDigests.set(canonicalPath, digest.digest('hex'))
    }

    for (const required of [...REQUIRED_PACKAGE_FILES, EXTENSION_INTEGRITY_FILE]) {
      if (!extractedPaths.has(required)) {
        throw extensionError('EXTENSION_PACKAGE_FILE_MISSING', 'Required package file is missing', {
          path: required
        })
      }
    }

    const manifest = adapter.parse(
      await readBoundedJson(join(destination, EXTENSION_MANIFEST_FILE), limits.maxManifestBytes)
    )
    if (options.compatibility !== undefined) {
      adapter.assertCompatible(manifest, options.compatibility)
    }
    const integrity = parseIntegrity(
      await readBoundedJson(join(destination, EXTENSION_INTEGRITY_FILE), limits.maxManifestBytes)
    )
    await validateExtractedPackage(destination, manifest, integrity, extractedPaths, actualDigests)

    return {
      archivePath: resolve(archivePath),
      destination: resolve(destination),
      archiveSha256,
      manifest,
      integrity,
      signatureStatus: manifest.signature === undefined ? 'unsigned' : 'present-unverified',
      fileCount,
      expandedBytes
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof Error && error.name === 'ExtensionError') throw error
    throw extensionError('EXTENSION_ARCHIVE_INVALID', 'Extension archive validation failed', {
      archivePath
    }, error)
  } finally {
    zipfile?.close()
  }
}

export async function inspectKunxArchive(
  archivePath: string,
  options: ArchiveValidationOptions = {}
): Promise<Omit<ExtractedKunx, 'destination'>> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kun-extension-inspect-'))
  const destination = join(temporaryRoot, 'package')
  try {
    const { destination: _destination, ...inspection } = await extractKunxArchive(
      archivePath,
      destination,
      options
    )
    return inspection
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export type PackKunxOptions = ArchiveValidationOptions & {
  overwrite?: boolean
  /** Additional package-relative files or directories to include. Directories are recursive. */
  include?: readonly string[]
  /** Package-relative files or directory trees to exclude from the selected release files. */
  ignore?: readonly string[]
}

export async function packKunx(
  sourceDirectory: string,
  outputPath: string,
  options: PackKunxOptions = {}
): Promise<Omit<ExtractedKunx, 'destination'>> {
  const limits = archiveLimits(options.limits)
  const sourceRoot = resolve(sourceDirectory)
  const output = resolve(outputPath)
  const sourceStats = await lstat(sourceRoot)
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw extensionError('EXTENSION_PACKAGE_SOURCE_INVALID', 'Package source must be a real directory', {
      sourceDirectory
    })
  }
  if (!options.overwrite) {
    try {
      await lstat(output)
      throw extensionError('EXTENSION_PACKAGE_OUTPUT_EXISTS', 'Package output already exists', {
        outputPath: output
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }

  const adapter = options.manifestAdapter ?? defaultManifestAdapter
  const manifestPath = join(sourceRoot, EXTENSION_MANIFEST_FILE)
  await assertNoSourceLinkParents(sourceRoot, manifestPath)
  const manifestStats = await lstat(manifestPath).catch((error: unknown) => {
    throw extensionError(
      'EXTENSION_PACKAGE_FILE_MISSING',
      'Required package file is missing',
      { path: EXTENSION_MANIFEST_FILE },
      error
    )
  })
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    throw extensionError(
      manifestStats.isSymbolicLink()
        ? 'EXTENSION_PACKAGE_LINK_FORBIDDEN'
        : 'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
      'Extension manifest must be a regular file inside the package source',
      { path: EXTENSION_MANIFEST_FILE }
    )
  }
  const manifest = adapter.parse(
    await readBoundedJson(manifestPath, limits.maxManifestBytes)
  )
  if (options.compatibility !== undefined) adapter.assertCompatible(manifest, options.compatibility)

  const files = await collectPackFiles(sourceRoot, output, manifest, limits, options)
  const filePaths = new Set(files.map((file) => file.path))
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!filePaths.has(required)) {
      throw extensionError('EXTENSION_PACKAGE_FILE_MISSING', 'Required package file is missing', {
        path: required
      })
    }
  }
  assertManifestReferencedFiles(manifest, filePaths)
  await assertResourceRoots(sourceRoot, manifest)

  const integrityFiles: Record<string, string> = {}
  for (const file of files) integrityFiles[file.path] = await sha256File(file.absolutePath)
  const integrity: ExtensionIntegrityManifest = { algorithm: 'sha256', files: integrityFiles }
  const integrityContents = Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`, 'utf8')
  enforceLimit('fileBytes', integrityContents.length, limits.maxFileBytes, EXTENSION_INTEGRITY_FILE)

  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const temporaryOutput = `${output}.${process.pid}.${randomUUID()}.tmp`
  const zipfile = new yazl.ZipFile()
  const fixedTime = new Date('1980-01-01T00:00:00.000Z')
  for (const file of files) {
    zipfile.addFile(file.absolutePath, file.path, {
      mtime: fixedTime,
      mode: 0o100644,
      compress: true
    })
  }
  zipfile.addBuffer(integrityContents, EXTENSION_INTEGRITY_FILE, {
    mtime: fixedTime,
    mode: 0o100644,
    compress: true
  })

  try {
    const outputStream = createWriteStream(temporaryOutput, { flags: 'wx', mode: 0o600 })
    zipfile.end()
    await pipeline(zipfile.outputStream, outputStream)
    enforceLimit('archiveBytes', (await stat(temporaryOutput)).size, limits.maxArchiveBytes)
    const inspection = await inspectKunxArchive(temporaryOutput, options)
    await rename(temporaryOutput, output)
    return { ...inspection, archivePath: output }
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function verifyExtractedExtension(
  packageRoot: string,
  manifest: ExtensionManifest,
  integrity: ExtensionIntegrityManifest,
  limits: Partial<ExtensionArchiveLimits> = {}
): Promise<void> {
  const resolvedLimits = archiveLimits(limits)
  const actualFiles = await collectPackageFiles(resolve(packageRoot), '', resolvedLimits)
  const actualPaths = new Set(actualFiles.map((file) => file.path))
  actualPaths.add(EXTENSION_INTEGRITY_FILE)
  const expectedPaths = new Set(Object.keys(integrity.files))
  expectedPaths.add(EXTENSION_INTEGRITY_FILE)
  if (!setEquals(actualPaths, expectedPaths)) {
    throw extensionError('EXTENSION_PACKAGE_INTEGRITY_MISMATCH', 'Installed package file set changed', {
      extensionId: manifestId(manifest)
    })
  }
  for (const file of actualFiles) {
    const expected = integrity.files[file.path]
    const actual = await sha256File(file.absolutePath)
    if (expected !== actual) {
      throw extensionError('EXTENSION_PACKAGE_INTEGRITY_MISMATCH', 'Installed package file digest changed', {
        extensionId: manifestId(manifest),
        path: file.path
      })
    }
  }
  assertManifestReferencedFiles(manifest, new Set(actualFiles.map((file) => file.path)))
  await assertResourceRoots(resolve(packageRoot), manifest)
}

export type InspectedDevelopmentExtension = {
  path: string
  manifest: ExtensionManifest
  digest: string
}

export async function inspectDevelopmentDirectory(
  sourceDirectory: string,
  options: ArchiveValidationOptions = {}
): Promise<InspectedDevelopmentExtension> {
  const limits = archiveLimits(options.limits)
  const sourceRoot = resolve(sourceDirectory)
  const rootDetails = await lstat(sourceRoot)
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw extensionError(
      'EXTENSION_DEVELOPMENT_SOURCE_INVALID',
      'Development source must be a real directory',
      { sourceDirectory }
    )
  }
  const manifestPath = join(sourceRoot, EXTENSION_MANIFEST_FILE)
  await assertNoSourceLinkParents(sourceRoot, manifestPath)
  const manifestDetails = await lstat(manifestPath).catch((error: unknown) => {
    throw extensionError(
      'EXTENSION_PACKAGE_FILE_MISSING',
      'Development manifest is missing',
      { path: EXTENSION_MANIFEST_FILE },
      error
    )
  })
  if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink()) {
    throw extensionError(
      manifestDetails.isSymbolicLink()
        ? 'EXTENSION_PACKAGE_LINK_FORBIDDEN'
        : 'EXTENSION_DEVELOPMENT_FILE_INVALID',
      'Development manifest must be a regular file inside the source directory',
      { path: EXTENSION_MANIFEST_FILE }
    )
  }
  const manifest = (options.manifestAdapter ?? defaultManifestAdapter).parse(
    await readBoundedJson(manifestPath, limits.maxManifestBytes)
  )
  if (options.compatibility !== undefined) {
    ;(options.manifestAdapter ?? defaultManifestAdapter).assertCompatible(
      manifest,
      options.compatibility
    )
  }

  const digest = createHash('sha256')
  const hashedFiles = new Set<string>()
  const portablePaths = new Map<string, string>()
  let hashedBytes = 0
  let hashedFileCount = 0
  const hashFile = async (absolutePath: string): Promise<void> => {
    await assertNoSourceLinkParents(sourceRoot, absolutePath)
    const packagePath = relative(sourceRoot, absolutePath).split(sep).join('/')
    if (hashedFiles.has(packagePath)) return
    assertCanonicalPackagePath(packagePath, false)
    const portableKey = portablePathKey(packagePath)
    const prior = portablePaths.get(portableKey)
    if (prior !== undefined && prior !== packagePath) {
      throw extensionError(
        'EXTENSION_PACKAGE_PATH_COLLISION',
        'Development source paths collide portably',
        { first: prior, second: packagePath }
      )
    }
    portablePaths.set(portableKey, packagePath)
    const details = await lstat(absolutePath)
    if (!details.isFile() || details.isSymbolicLink()) {
      throw extensionError(
        'EXTENSION_DEVELOPMENT_FILE_INVALID',
        'Development resource must be a regular file',
        { path: packagePath }
      )
    }
    enforceLimit('fileBytes', details.size, limits.maxFileBytes, packagePath)
    hashedBytes += details.size
    hashedFileCount += 1
    enforceLimit('expandedBytes', hashedBytes, limits.maxExpandedBytes)
    enforceLimit('files', hashedFileCount, limits.maxFiles)
    hashedFiles.add(packagePath)
    digest.update(packagePath)
    digest.update(await readFile(absolutePath))
  }
  await hashFile(manifestPath)
  for (const entrypoint of manifestReferencedFiles(manifest)) {
    const entrypointPath = safeDestination(sourceRoot, entrypoint)
    await assertNoSourceLinkParents(sourceRoot, entrypointPath)
    const details = await lstat(entrypointPath).catch((error: unknown) => {
      throw extensionError('EXTENSION_ENTRYPOINT_MISSING', 'Development entrypoint is missing', {
        path: entrypoint
      }, error)
    })
    if (!details.isFile() || details.isSymbolicLink()) {
      throw extensionError(
        'EXTENSION_ENTRYPOINT_INVALID',
        'Development referenced file must be a regular file',
        { path: entrypoint }
      )
    }
    await hashFile(entrypointPath)
  }
  for (const resourceRoot of manifestLocalResourceRoots(manifest)) {
    const resourcePath = safeDestination(sourceRoot, resourceRoot)
    await assertNoSourceLinkParents(sourceRoot, resourcePath)
    const details = await lstat(resourcePath).catch((error: unknown) => {
      throw extensionError(
        'EXTENSION_RESOURCE_ROOT_INVALID',
        'Development resource root is missing',
        { root: resourceRoot },
        error
      )
    })
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw extensionError(
        'EXTENSION_RESOURCE_ROOT_INVALID',
        'Development resource root must be a real directory',
        { root: resourceRoot }
      )
    }
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const entry of entries) {
        const path = join(directory, entry.name)
        const entryDetails = await lstat(path)
        if (entryDetails.isSymbolicLink()) {
          throw extensionError(
            'EXTENSION_PACKAGE_LINK_FORBIDDEN',
            'Development resource roots cannot contain links',
            { path: relative(sourceRoot, path) }
          )
        }
        if (entryDetails.isDirectory()) await visit(path)
        else if (entryDetails.isFile()) await hashFile(path)
        else {
          throw extensionError(
            'EXTENSION_PACKAGE_FILE_TYPE_INVALID',
            'Development resource root contains a special file',
            { path: relative(sourceRoot, path) }
          )
        }
      }
    }
    await visit(resourcePath)
  }
  return { path: sourceRoot, manifest, digest: digest.digest('hex') }
}
