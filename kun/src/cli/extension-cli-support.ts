import {
  CURRENT_MANIFEST_VERSION,
  SUPPORTED_EXTENSION_API_VERSIONS
} from '@kun/extension-api'
import { open, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import {
  ExtensionError,
  ExtensionIndexClient,
  ExtensionManager,
  ExtensionPackageManager,
  ExtensionPaths,
  ExtensionRegistry,
  ExtensionStateMigrationCoordinator,
  ExtensionStateStore,
  inspectDevelopmentDirectory,
  inspectKunxArchive,
  packKunx,
  verifyExtractedExtension,
  type ExtensionCompatibility,
  type ExtensionRegistryEntry
} from '../extensions/index.js'
import { ServeExitCode } from './serve.js'
import { KUN_VERSION } from '../version.js'

import {
  BOOLEAN_OPTIONS,
  KUN_EXTENSION_CLI_SCHEMA_VERSION,
  REPEATABLE_VALUE_OPTIONS,
  VALUE_OPTIONS
} from './extension-cli-commands.js'
import type {
  ExtensionCliIo,
  ParsedArguments,
  WritableLike
} from './extension-cli-commands.js'

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const first = argv[0]
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return {
      command: 'help',
      positionals: [],
      values: new Map(),
      repeatedValues: new Map(),
      flags: new Set(),
      json: false
    }
  }
  const values = new Map<string, string>()
  const repeatedValues = new Map<string, string[]>()
  const flags = new Set<string>()
  const positionals: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (argument === '-h') {
      flags.add('help')
      continue
    }
    if (argument === '-o') {
      const value = argv[++index]
      if (value === undefined) throw usageError('-o requires a value')
      values.set('output', value)
      continue
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const separator = argument.indexOf('=')
    const name = separator < 0 ? argument.slice(2) : argument.slice(2, separator)
    if (BOOLEAN_OPTIONS.has(name)) {
      if (separator >= 0 && argument.slice(separator + 1) !== 'true') {
        throw usageError(`--${name} is a boolean flag`)
      }
      flags.add(name)
      continue
    }
    if (!VALUE_OPTIONS.has(name)) throw usageError(`unknown option: --${name}`)
    const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index]
    if (value === undefined || value.length === 0) throw usageError(`--${name} requires a value`)
    values.set(name, value)
    if (REPEATABLE_VALUE_OPTIONS.has(name)) {
      const existing = repeatedValues.get(name) ?? []
      existing.push(value)
      repeatedValues.set(name, existing)
    }
  }
  return {
    command: first,
    positionals,
    values,
    repeatedValues,
    flags,
    json: flags.has('json')
  }
}

export function requiredExtensionId(parsed: ParsedArguments): string {
  const [id] = parsed.positionals
  if (id === undefined) throw usageError(`${parsed.command} requires <extension-id>`)
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new ExtensionError('EXTENSION_ID_INVALID', 'Extension ID must be publisher.name', { extensionId: id })
  }
  return id
}

export function requirePermissionAcceptance(
  parsed: ParsedArguments,
  io: ExtensionCliIo,
  id: string,
  permissions: string[]
): void {
  if (parsed.flags.has('accept-permissions')) return
  const disclosure = permissions.length === 0 ? '(none)' : permissions.join(', ')
  io.stderr.write(`Requested permissions for ${id}: ${disclosure}\n`)
  throw new ExtensionError(
    'EXTENSION_PERMISSION_CONSENT_REQUIRED',
    'Headless installation requires explicit --accept-permissions; Node extensions run with the current user\'s OS privileges',
    { extensionId: id, requestedPermissions: permissions }
  )
}

export async function requireEntry(registry: ExtensionRegistry, id: string): Promise<ExtensionRegistryEntry> {
  const entry = await registry.get(id)
  if (entry === undefined) throw new ExtensionError('EXTENSION_NOT_INSTALLED', 'Extension is not installed', { extensionId: id })
  return entry
}

export function projectEntry(entry: ExtensionRegistryEntry) {
  return {
    id: entry.id,
    selectedVersion: entry.selectedVersion,
    previousSelectedVersion: entry.previousSelectedVersion,
    installedVersions: Object.keys(entry.versions).sort(),
    globallyEnabled: entry.globallyEnabled,
    workspaceEnablement: structuredClone(entry.workspaceEnablement),
    useDevelopment: entry.useDevelopment,
    development: entry.development === undefined ? undefined : {
      version: entry.development.manifest.version,
      path: entry.development.path,
      generation: entry.development.generation,
      digest: entry.development.digest
    },
    selectedSource: entry.useDevelopment
      ? entry.development?.source
      : entry.selectedVersion === undefined
        ? undefined
        : entry.versions[entry.selectedVersion]?.source,
    selectedSignatureStatus: entry.useDevelopment || entry.selectedVersion === undefined
      ? undefined
      : entry.versions[entry.selectedVersion]?.signatureStatus,
    grantedPermissions: entry.useDevelopment
      ? entry.development?.grantedPermissions ?? []
      : entry.selectedVersion === undefined
        ? []
        : entry.versions[entry.selectedVersion]?.grantedPermissions ?? []
  }
}

export function projectInstalled(installed: Awaited<ReturnType<ExtensionPackageManager['installArchive']>>) {
  return {
    id: extensionId(installed.manifest),
    version: installed.version,
    path: installed.packagePath,
    sha256: installed.archiveSha256,
    source: installed.source,
    signatureStatus: installed.signatureStatus,
    requestedPermissions: installed.requestedPermissions,
    grantedPermissions: installed.grantedPermissions,
    installedAt: installed.installedAt
  }
}

export function projectInspection(inspection: Awaited<ReturnType<typeof inspectKunxArchive>>) {
  return {
    id: extensionId(inspection.manifest),
    version: inspection.manifest.version,
    archivePath: inspection.archivePath,
    sha256: inspection.archiveSha256,
    signatureStatus: inspection.signatureStatus,
    requestedPermissions: inspection.manifest.permissions,
    apiVersion: inspection.manifest.apiVersion,
    manifestVersion: inspection.manifest.manifestVersion,
    enginesKun: inspection.manifest.engines.kun,
    fileCount: inspection.fileCount,
    expandedBytes: inspection.expandedBytes
  }
}

export function extensionId(manifest: { publisher: string; name: string }): string {
  return `${manifest.publisher}.${manifest.name}`
}

export function resolveFromCwd(path: string, io: ExtensionCliIo): string {
  return resolve(io.cwd?.() ?? process.cwd(), path)
}

export function resolvePackOutput(output: string, defaultName: string): string {
  return extname(output).toLowerCase() === '.kunx' ? output : join(output, defaultName)
}

export async function loadScaffolder(): Promise<NonNullable<ExtensionCliIo['scaffold']>> {
  const packageName = 'create-kun-extension'
  try {
    const module = await import(packageName) as {
      scaffoldExtension?: NonNullable<ExtensionCliIo['scaffold']>
    }
    if (typeof module.scaffoldExtension !== 'function') throw new Error('scaffoldExtension export is missing')
    return module.scaffoldExtension
  } catch (error) {
    throw new ExtensionError(
      'EXTENSION_SCAFFOLDER_UNAVAILABLE',
      'create-kun-extension is not installed with this Kun distribution',
      {},
      { cause: error }
    )
  }
}

export async function readRotatedLogTail(logPath: string, maximum: number): Promise<string> {
  const files = [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`]
  const chunks: Buffer[] = []
  let remaining = maximum
  for (const path of files) {
    if (remaining <= 0) break
    const details = await stat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (details === undefined || !details.isFile()) continue
    const length = Math.min(remaining, details.size)
    const buffer = Buffer.alloc(length)
    const handle = await open(path, 'r')
    try {
      await handle.read(buffer, 0, length, details.size - length)
    } finally {
      await handle.close()
    }
    chunks.unshift(buffer)
    remaining -= length
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw usageError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function writeResult(parsed: ParsedArguments, io: ExtensionCliIo, message: string, result: unknown): void {
  if (parsed.json) {
    writeJson(io.stdout, { schemaVersion: KUN_EXTENSION_CLI_SCHEMA_VERSION, result: redactSecrets(result) })
  } else {
    io.stdout.write(`${message}\n`)
    if (result && typeof result === 'object') io.stdout.write(`${JSON.stringify(redactSecrets(result), null, 2)}\n`)
  }
}

export function writeJson(output: WritableLike, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`)
}

export function writeCommandError(parsed: ParsedArguments, io: ExtensionCliIo, error: unknown): void {
  const normalized = normalizeCliError(error)
  if (parsed.json) {
    io.stderr.write(`${JSON.stringify({ schemaVersion: KUN_EXTENSION_CLI_SCHEMA_VERSION, error: normalized })}\n`)
  } else {
    io.stderr.write(`kun extension ${parsed.command}: ${normalized.code}: ${normalized.message}\n`)
    if (normalized.details !== undefined) {
      io.stderr.write(`${JSON.stringify(normalized.details, null, 2)}\n`)
    }
  }
}

export function normalizeCliError(error: unknown): { code: string; message: string; details?: unknown } {
  if ((error as { usage?: boolean })?.usage === true) {
    return { code: 'EXTENSION_CLI_USAGE', message: redactSecretText(errorMessage(error)).slice(0, 4_096) }
  }
  if (error instanceof ExtensionError) {
    return {
      code: error.code,
      message: redactSecretText(error.message).slice(0, 4_096),
      details: redactSecrets(error.details)
    }
  }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return {
      code: 'EXTENSION_PATH_NOT_FOUND',
      message: redactSecretText(errorMessage(error)).slice(0, 4_096)
    }
  }
  const message = redactSecretText(errorMessage(error)).slice(0, 4_096)
  const match = message.match(/^([A-Z][A-Z0-9_]+):\s*(.*)$/)
  return match === null
    ? { code: 'EXTENSION_INTERNAL_ERROR', message }
    : { code: match[1]!, message: match[2]! }
}

export function errorExitCode(error: unknown): number {
  if ((error as { usage?: boolean })?.usage === true) return ServeExitCode.usage
  const code = error instanceof ExtensionError ? error.code : ''
  if (/(?:INVALID|MISSING|INCOMPATIBLE|UNSUPPORTED|VALIDATION|LIMIT|FORBIDDEN)/.test(code)) {
    return ServeExitCode.config
  }
  return ServeExitCode.runtime
}

export function usageError(message: string): Error & { usage: true } {
  return Object.assign(new Error(message), { usage: true as const })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
