import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  extractKunxArchive,
  inspectDevelopmentDirectory,
  makePackageTreeReadOnly,
  verifyExtractedExtension,
  type ArchiveValidationOptions,
  type ExtractedKunx
} from './archive.js'
import { extensionError } from './errors.js'
import {
  assertManifestCompatible,
  manifestCompatibilityReport,
  manifestId
} from './manifest.js'
import { ExtensionPaths } from './paths.js'
import { ExtensionRegistry } from './registry.js'
import type {
  DevelopmentExtensionRecord,
  ExtensionManifest,
  ExtensionSource,
  InstalledExtensionVersion,
  ResolvedExtension,
  ExtensionAdmission
} from './types.js'

import type { ExpectedIndexedPackage, ExtensionPackageLifecycle, VersionSwitchContext } from './package-manager.js'

export function toInstalledRecord(
  extracted: ExtractedKunx,
  packagePath: string,
  source: ExtensionSource,
  grantedPermissions: string[],
  installedAt: Date
): InstalledExtensionVersion {
  return {
    version: extracted.manifest.version,
    packagePath,
    archiveSha256: extracted.archiveSha256,
    integrity: extracted.integrity,
    source: structuredClone(source),
    signatureStatus: extracted.signatureStatus,
    requestedPermissions: [...extracted.manifest.permissions].sort(),
    grantedPermissions: [...grantedPermissions].sort(),
    installedAt: installedAt.toISOString(),
    manifest: structuredClone(extracted.manifest),
    mutable: false
  }
}

export function validatePermissionGrant(requested: string[], granted: string[]): void {
  const expected = [...new Set(requested)].sort()
  const actual = [...new Set(granted)].sort()
  if (expected.length !== actual.length || expected.some((permission, index) => permission !== actual[index])) {
    throw extensionError(
      'EXTENSION_PERMISSION_CONSENT_REQUIRED',
      'Permission grant must exactly match the requested permission set',
      { requested: expected, granted: actual }
    )
  }
}

export function validateExpectedPackage(
  extracted: ExtractedKunx,
  expected: ExpectedIndexedPackage | undefined
): void {
  if (expected === undefined) return
  const actualPermissions = [...extracted.manifest.permissions].sort()
  const expectedPermissions = [...expected.permissions].sort()
  const mismatches: string[] = []
  if (manifestId(extracted.manifest) !== expected.extensionId) mismatches.push('id')
  if (extracted.manifest.version !== expected.version) mismatches.push('version')
  if (extracted.archiveSha256 !== expected.archiveSha256) mismatches.push('sha256')
  if (extracted.manifest.engines.kun !== expected.enginesKun) mismatches.push('engines.kun')
  if (extracted.manifest.apiVersion !== expected.apiVersion) mismatches.push('apiVersion')
  if (canonicalJson(extracted.manifest.signature) !== canonicalJson(expected.signature)) {
    mismatches.push('signature')
  }
  if (
    actualPermissions.length !== expectedPermissions.length ||
    actualPermissions.some((permission, index) => permission !== expectedPermissions[index])
  ) {
    mismatches.push('permissions')
  }
  if (mismatches.length > 0) {
    throw extensionError('EXTENSION_INDEX_PACKAGE_MISMATCH', 'Index metadata and package disagree', {
      mismatches
    })
  }
}

export async function resolveOptional(
  registry: ExtensionRegistry,
  extensionId: string
): Promise<ResolvedExtension | undefined> {
  try {
    return await registry.resolve(extensionId)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (
      code === 'EXTENSION_NOT_INSTALLED' ||
      code === 'EXTENSION_VERSION_NOT_SELECTED' ||
      code === 'EXTENSION_DEVELOPMENT_UNAVAILABLE'
    ) {
      return undefined
    }
    throw error
  }
}

export async function quarantinePath(sourcePath: string, stagingRoot: string): Promise<string> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  await makeTreeWritable(sourcePath).catch(() => undefined)
  const target = join(stagingRoot, `remove-${randomUUID()}`)
  await rename(sourcePath, target)
  return target
}

export async function makeTreeWritable(root: string): Promise<void> {
  if (process.platform === 'win32') return
  const details = await lstat(root)
  if (details.isSymbolicLink()) return
  if (!details.isDirectory()) {
    await chmod(root, 0o600)
    return
  }
  await chmod(root, 0o700)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await makeTreeWritable(path)
    else await chmod(path, 0o600)
  }
}

export function isExtensionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

export function installedToResolved(
  extensionId: string,
  record: InstalledExtensionVersion
): ResolvedExtension {
  return {
    id: extensionId,
    version: record.version,
    packagePath: record.packagePath,
    manifest: structuredClone(record.manifest),
    requestedPermissions: [...record.requestedPermissions],
    grantedPermissions: [...record.grantedPermissions],
    source: structuredClone(record.source),
    development: false
  }
}

export function developmentToResolved(
  extensionId: string,
  record: DevelopmentExtensionRecord
): ResolvedExtension {
  return {
    id: extensionId,
    version: record.manifest.version,
    packagePath: record.path,
    manifest: structuredClone(record.manifest),
    requestedPermissions: [...record.requestedPermissions],
    grantedPermissions: [...record.grantedPermissions],
    source: structuredClone(record.source),
    development: true,
    generation: record.generation
  }
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return ''
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function rethrowAfterSwitchRollback(
  lifecycle: ExtensionPackageLifecycle,
  context: VersionSwitchContext,
  error: unknown
): Promise<never> {
  try {
    await lifecycle.versionSwitchFailed?.(context, error)
  } catch (rollbackError) {
    throw extensionError(
      'EXTENSION_VERSION_SWITCH_ROLLBACK_FAILED',
      'Extension version switch failed and state rollback was unsuccessful',
      { extensionId: context.extensionId },
      rollbackError
    )
  }
  throw error
}
