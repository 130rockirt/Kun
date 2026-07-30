import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readlink, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  DATA_MIGRATION_MINIMUM_FREE_SPACE_RATIO,
  DATA_MIGRATION_REFERENCE_DESCRIPTORS_V1,
  DataMigrationImportPlanSchema,
  buildMigrationDestinationPath,
  migrationPathRelativeToWorkspace,
  parsePackageRelativePath,
  type DataMigrationComponentName,
  type DataMigrationConflict,
  type DataMigrationFileConflictResolution,
  type DataMigrationImportPlan,
  type DataMigrationPackageEntry,
  type DataMigrationSourcePlatform,
  type DataMigrationWorkspaceCatalogEntry,
  type DataMigrationWorkspaceConflictStrategy,
  type DataMigrationWorkspaceMapping,
  type PackageRelativePath
} from '../../shared/data-migration'
import {
  validateKunpackArchiveEntryPath,
  validateKunpackEntryPath
} from './archive-security'

export type DestinationFileSystemProbe = {
  root: string
  canonicalRoot: string
  writable: boolean
  caseSensitive: boolean
  unicodeNormalizationSensitive: boolean
  supportsSymbolicLinks: boolean
  maximumComponentBytes: number
  maximumPathBytes: number
  freeBytes: number
  deviceId?: string
  platform: DataMigrationSourcePlatform
}

export async function probeDestinationFileSystem(
  root: string,
  platform: DataMigrationSourcePlatform = currentPlatform()
): Promise<DestinationFileSystemProbe> {
  const canonicalRoot = await realpath(root).catch(() => resolve(root))
  const token = randomUUID().replaceAll('-', '')
  const probe = join(canonicalRoot, `.kun-migration-probe-${token}`)
  let writable = false
  let caseSensitive = true
  let unicodeNormalizationSensitive = true
  let supportsSymbolicLinks = false
  try {
    await mkdir(probe, { recursive: false, mode: 0o700 })
    writable = true
    const casePath = join(probe, 'CaseProbe')
    await writeFile(casePath, 'case', { flag: 'wx', mode: 0o600 })
    caseSensitive = !await exists(join(probe, 'caseprobe'))
    const unicodePath = join(probe, 'é')
    await writeFile(unicodePath, 'unicode', { flag: 'wx', mode: 0o600 })
    unicodeNormalizationSensitive = !await exists(join(probe, 'e\u0301'))
    try {
      await symlink('CaseProbe', join(probe, 'safe-link'))
      supportsSymbolicLinks = true
    } catch {
      supportsSymbolicLinks = false
    }
  } catch {
    writable = false
    supportsSymbolicLinks = false
  } finally {
    await rm(probe, { recursive: true, force: true }).catch(() => undefined)
  }
  const filesystem = await statfs(canonicalRoot)
  const rootDetails = await lstat(canonicalRoot)
  return {
    root,
    canonicalRoot,
    writable,
    caseSensitive,
    unicodeNormalizationSensitive,
    supportsSymbolicLinks,
    maximumComponentBytes: platform === 'windows' ? 255 : 255,
    maximumPathBytes: platform === 'windows' ? 32_767 : 4_096,
    freeBytes: Number(filesystem.bavail) * Number(filesystem.bsize),
    deviceId: String(rootDetails.dev),
    platform
  }
}

export async function buildDataMigrationImportPlan(input: {
  operationId: string
  packageId: string
  inspectedAt: string
  sourcePlatform: DataMigrationSourcePlatform
  encrypted: boolean
  workspaces: readonly DataMigrationWorkspaceCatalogEntry[]
  entries: readonly DataMigrationPackageEntry[]
  destinationBaseRoot: string
  destinationPlatform?: DataMigrationSourcePlatform
  destinationRoots?: Readonly<Record<string, string | undefined>>
  strategies?: Readonly<Record<string, DataMigrationWorkspaceConflictStrategy | undefined>>
  skippedWorkspaceIds?: ReadonlySet<string>
}): Promise<DataMigrationImportPlan> {
  const destinationPlatform = input.destinationPlatform ?? currentPlatform()
  const mappings: DataMigrationWorkspaceMapping[] = []
  const conflicts: DataMigrationConflict[] = []
  const reservedDestinations = new Set<string>()
  const plannedDestinations: string[] = []
  const mappingVolumeKeys: Array<string | undefined> = []
  const peakBytesByVolume = new Map<string, number>()
  const freeBytesByVolume = new Map<string, number>()
  let estimatedPeakBytes = 0

  for (const workspace of input.workspaces) {
    const strategy = input.strategies?.[workspace.workspaceId] ?? 'keep-both'
    const requiredBytes = input.entries
      .filter((entry) => workspaceEntryRelativePath(entry.path, workspace.workspaceId) !== null)
      .reduce((total, entry) => total + entry.logicalBytes, 0)
    if (strategy === 'skip' || input.skippedWorkspaceIds?.has(workspace.workspaceId)) {
      mappings.push({
        workspaceId: workspace.workspaceId,
        sourcePathDisplay: workspace.sourcePathDisplay,
        strategy: 'skip',
        compatible: true,
        requiredBytes,
        unresolvedIssueCount: 0
      })
      mappingVolumeKeys.push(undefined)
      continue
    }
    const requested = input.destinationRoots?.[workspace.workspaceId]
    const destinationRoot = requested
      ? resolve(requested)
      : await recommendCollisionFreeDestination(input.destinationBaseRoot, workspace.displayName, reservedDestinations)
    assertSafeIndependentDestination(destinationRoot, plannedDestinations)
    reservedDestinations.add(destinationIdentity(destinationRoot))
    plannedDestinations.push(destinationRoot)
    const destinationDetails = await lstat(destinationRoot).catch(() => null)
    if (strategy === 'keep-both' && destinationDetails) {
      throw new Error(`Keep both destination already exists: ${destinationRoot}`)
    }
    if ((strategy === 'merge' || strategy === 'replace') && destinationDetails && !destinationDetails.isDirectory()) {
      throw new Error(`migration merge or replace destination is not a directory: ${destinationRoot}`)
    }
    const probeRoot = await nearestExistingDirectory(destinationRoot)
    const probe = await probeDestinationFileSystem(probeRoot, destinationPlatform)
    const workspaceConflicts = await detectWorkspaceConflicts({
      workspace,
      destinationRoot,
      entries: input.entries,
      probe,
      strategy
    })
    conflicts.push(...workspaceConflicts)
    const safetyMargin = Math.max(Math.ceil(requiredBytes * DATA_MIGRATION_MINIMUM_FREE_SPACE_RATIO), 256 * 1024 * 1024)
    const backupBytes = workspaceConflicts.reduce((total, conflict) => total + (conflict.targetBytes ?? 0), 0)
    const peakBytes = requiredBytes + safetyMargin + backupBytes
    estimatedPeakBytes += peakBytes
    const preflightCompatible = probe.writable && peakBytes <= probe.freeBytes
    const compatible = preflightCompatible && !workspaceConflicts.some((conflict) => conflict.fatal)
    mappings.push({
      workspaceId: workspace.workspaceId,
      sourcePathDisplay: workspace.sourcePathDisplay,
      destinationRoot,
      strategy,
      compatible,
      preflightCompatible,
      estimatedPeakBytes: peakBytes,
      freeBytes: probe.freeBytes,
      requiredBytes,
      unresolvedIssueCount: workspaceConflicts.filter((conflict) => !conflict.resolution).length
    })
    const volumeKey = probe.deviceId ?? probe.canonicalRoot
    mappingVolumeKeys.push(volumeKey)
    peakBytesByVolume.set(volumeKey, (peakBytesByVolume.get(volumeKey) ?? 0) + peakBytes)
    freeBytesByVolume.set(volumeKey, Math.min(freeBytesByVolume.get(volumeKey) ?? probe.freeBytes, probe.freeBytes))
  }

  for (const [volumeKey, peakBytes] of peakBytesByVolume) {
    if (peakBytes <= (freeBytesByVolume.get(volumeKey) ?? 0)) continue
    for (let index = 0; index < mappings.length; index += 1) {
      if (mappingVolumeKeys[index] !== volumeKey) continue
      mappings[index] = {
        ...mappings[index]!,
        compatible: false,
        preflightCompatible: false
      }
    }
  }

  return DataMigrationImportPlanSchema.parse({
    operationId: input.operationId,
    packageId: input.packageId,
    inspectedAt: input.inspectedAt,
    sourcePlatform: input.sourcePlatform,
    encrypted: input.encrypted,
    mappings,
    conflicts: conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
    threadIdMap: {},
    unresolvedReferences: [],
    disabledItems: [],
    estimatedPeakBytes,
    fatalIssueCount: conflicts.filter((conflict) => conflict.fatal).length
  })
}

export async function recommendCollisionFreeDestination(
  baseRoot: string,
  displayName: string,
  reserved: ReadonlySet<string> = new Set()
): Promise<string> {
  const safeName = sanitizeDestinationName(displayName) || 'Imported Workspace'
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? ' (Imported)' : ` (Imported ${index + 1})`
    const candidate = join(baseRoot, `${safeName}${suffix}`)
    if (!reserved.has(destinationIdentity(candidate)) && !await exists(candidate)) return candidate
  }
  throw new Error(`unable to allocate a collision-free destination for ${displayName}`)
}

export async function detectWorkspaceConflicts(input: {
  workspace: DataMigrationWorkspaceCatalogEntry
  destinationRoot: string
  entries: readonly DataMigrationPackageEntry[]
  probe: DestinationFileSystemProbe
  strategy: DataMigrationWorkspaceConflictStrategy
}): Promise<DataMigrationConflict[]> {
  const conflicts: DataMigrationConflict[] = []
  const identities = new Map<string, PackageRelativePath>()
  const reservedRenameIdentities = new Set<string>()
  for (const entry of input.entries) {
    const relativePath = workspaceEntryRelativePath(entry.path, input.workspace.workspaceId)
    if (!relativePath) continue
    const pathIssue = destinationPathIssue(relativePath, input.destinationRoot, input.probe)
    if (pathIssue) {
      conflicts.push(conflict(
        input.workspace.workspaceId,
        relativePath,
        pathIssue.kind,
        true,
        entry.sha256,
        entry.logicalBytes,
        stableCompatibleRenamedPath(relativePath, entry.sha256, input.destinationRoot, input.probe, reservedRenameIdentities)
      ))
      continue
    }
    const identity = fileSystemIdentity(relativePath, input.probe)
    const collision = identities.get(identity)
    if (collision) {
      conflicts.push(conflict(
        input.workspace.workspaceId,
        relativePath,
        input.probe.caseSensitive ? 'unicode-collision' : 'case-collision',
        true,
        entry.sha256,
        entry.logicalBytes,
        stableCompatibleRenamedPath(relativePath, entry.sha256, input.destinationRoot, input.probe, reservedRenameIdentities)
      ))
      continue
    }
    identities.set(identity, relativePath)
    reservedRenameIdentities.add(identity)
    if (input.strategy !== 'merge' && input.strategy !== 'replace') continue
    const targetPath = buildMigrationDestinationPath({
      destinationRoot: input.destinationRoot,
      relativePath,
      destinationPlatform: input.probe.platform
    })
    const target = await lstat(targetPath).catch(() => null)
    if (!target) continue
    if (!target.isFile()) {
      conflicts.push({
        ...conflict(input.workspace.workspaceId, relativePath, 'file-directory', true, entry.sha256, entry.logicalBytes),
        targetBytes: await pathLogicalBytes(targetPath)
      })
      continue
    }
    const targetSha256 = await sha256File(targetPath)
    if (targetSha256 === entry.sha256) continue
    conflicts.push({
      ...conflict(input.workspace.workspaceId, relativePath, 'different-content', false, entry.sha256, entry.logicalBytes),
      targetSha256,
      targetBytes: target.size
    })
  }
  return conflicts
}

export async function revalidateDataMigrationImportPlan(input: {
  plan: DataMigrationImportPlan
  packageId: string
  sourcePlatform: DataMigrationSourcePlatform
  encrypted: boolean
  workspaces: readonly DataMigrationWorkspaceCatalogEntry[]
  entries: readonly DataMigrationPackageEntry[]
}): Promise<DataMigrationImportPlan> {
  if (
    input.plan.packageId !== input.packageId ||
    input.plan.sourcePlatform !== input.sourcePlatform ||
    input.plan.encrypted !== input.encrypted
  ) {
    throw new Error('migration plan package identity changed after inspection')
  }
  const submittedById = new Map(input.plan.mappings.map((mapping) => [mapping.workspaceId, mapping]))
  if (
    submittedById.size !== input.plan.mappings.length ||
    submittedById.size !== input.workspaces.length ||
    input.workspaces.some((workspace) => !submittedById.has(workspace.workspaceId))
  ) {
    throw new Error('migration plan workspace mappings do not match the inspected package')
  }
  for (const mapping of input.plan.mappings) {
    if (mapping.strategy !== 'skip' && !mapping.destinationRoot) {
      throw new Error(`migration destination is required: ${mapping.workspaceId}`)
    }
    if (mapping.destinationRoot && !isAbsolute(mapping.destinationRoot)) {
      throw new Error(`migration destination must be absolute: ${mapping.workspaceId}`)
    }
  }
  const destinationRoots = Object.fromEntries(input.plan.mappings.flatMap((mapping) =>
    mapping.destinationRoot ? [[mapping.workspaceId, mapping.destinationRoot]] : []
  ))
  const strategies = Object.fromEntries(input.plan.mappings.map((mapping) => [
    mapping.workspaceId,
    mapping.strategy
  ]))
  const skippedWorkspaceIds = new Set(input.plan.mappings.flatMap((mapping) =>
    mapping.strategy === 'skip' ? [mapping.workspaceId] : []
  ))
  const firstDestination = input.plan.mappings.find((mapping) => mapping.destinationRoot)?.destinationRoot
  const fresh = await buildDataMigrationImportPlan({
    operationId: input.plan.operationId,
    packageId: input.packageId,
    inspectedAt: input.plan.inspectedAt,
    sourcePlatform: input.sourcePlatform,
    encrypted: input.encrypted,
    workspaces: input.workspaces,
    entries: input.entries,
    destinationBaseRoot: firstDestination ? dirname(firstDestination) : process.cwd(),
    destinationRoots,
    strategies,
    skippedWorkspaceIds
  })
  const submittedConflicts = new Map(input.plan.conflicts.map((item) => [item.conflictId, item]))
  const conflicts = fresh.conflicts.map((item) => {
    const submitted = submittedConflicts.get(item.conflictId)
    if (
      !submitted ||
      submitted.workspaceId !== item.workspaceId ||
      submitted.path !== item.path ||
      submitted.kind !== item.kind ||
      !submitted.resolution
    ) {
      return item
    }
    assertConflictResolutionAllowed(item, submitted.resolution)
    return {
      ...item,
      resolution: submitted.resolution,
      ...(submitted.resolution === 'rename-source' && item.renamedPath
        ? { renamedPath: item.renamedPath }
        : {})
    }
  })
  const unresolvedFatalByWorkspace = new Set(
    conflicts.filter((item) => item.fatal && !item.resolution).map((item) => item.workspaceId)
  )
  return DataMigrationImportPlanSchema.parse({
    ...fresh,
    conflicts,
    mappings: fresh.mappings.map((mapping) => ({
      ...mapping,
      compatible: mapping.strategy === 'skip' ||
        (mapping.preflightCompatible === true && !unresolvedFatalByWorkspace.has(mapping.workspaceId)),
      unresolvedIssueCount: conflicts.filter((item) =>
        item.workspaceId === mapping.workspaceId && !item.resolution
      ).length
    })),
    fatalIssueCount: conflicts.filter((item) => item.fatal && !item.resolution).length
  })
}

export function stableImportedSiblingPath(path: PackageRelativePath, sha256: string): PackageRelativePath {
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  return parsePackageRelativePath(`${directory}${stem}.imported-${sha256.slice(0, 8)}${extension}`)
}

export function stableCompatibleRenamedPath(
  path: PackageRelativePath,
  sha256: string,
  destinationRoot: string,
  probe: DestinationFileSystemProbe,
  reservedIdentities: Set<string> = new Set()
): PackageRelativePath | undefined {
  const segments = path.split('/').map((segment) => sanitizeDestinationSegment(segment, probe.platform))
  const originalName = segments.pop() || 'imported'
  const dot = originalName.lastIndexOf('.')
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName
  const extension = dot > 0 ? originalName.slice(dot) : ''
  const suffix = `-imported-${sha256.slice(0, 8)}`
  segments.push(`${truncateUtf8(stem || 'file', Math.max(1, probe.maximumComponentBytes - Buffer.byteLength(suffix + extension)))}${suffix}${truncateUtf8(extension, 32)}`)
  let candidate = parsePackageRelativePath(segments.join('/'))
  if (destinationPathIssue(candidate, destinationRoot, probe)) {
    const compactName = `${sha256.slice(0, 16)}${truncateUtf8(extension, 16)}`
    candidate = parsePackageRelativePath(`Imported/${compactName}`)
  }
  if (destinationPathIssue(candidate, destinationRoot, probe)) return undefined
  const identity = fileSystemIdentity(candidate, probe)
  if (reservedIdentities.has(identity)) return undefined
  reservedIdentities.add(identity)
  return candidate
}

export function rebindDataMigrationReferences(input: {
  value: unknown
  component: DataMigrationComponentName
  schemaVersion: number
  workspacePathMap: Readonly<Record<string, string>>
  threadIdMap: Readonly<Record<string, string>>
  sourcePlatform: DataMigrationSourcePlatform
}): { value: unknown; unresolved: Array<{ pointer: string; originalValue: string }> } {
  const value = structuredClone(input.value)
  const unresolved: Array<{ pointer: string; originalValue: string }> = []
  const descriptors = DATA_MIGRATION_REFERENCE_DESCRIPTORS_V1.filter(
    (descriptor) => descriptor.component === input.component && descriptor.schemaVersion === input.schemaVersion
  )
  for (const descriptor of descriptors) {
    for (const pattern of descriptor.jsonPointerPatterns) {
      visitPointerPattern(value, pattern, (parent, key, pointer) => {
        const container = parent as unknown as Record<string | number, unknown>
        const original = container[key]
        if (typeof original !== 'string') return
        const replacement = rebindReferenceValue(original, descriptor.kind, input)
        if (replacement === null) unresolved.push({ pointer, originalValue: original })
        else container[key] = replacement
      })
    }
  }
  return { value, unresolved }
}

function rebindReferenceValue(
  value: string,
  kind: (typeof DATA_MIGRATION_REFERENCE_DESCRIPTORS_V1)[number]['kind'],
  input: {
    workspacePathMap: Readonly<Record<string, string>>
    threadIdMap: Readonly<Record<string, string>>
    sourcePlatform: DataMigrationSourcePlatform
  }
): string | null {
  if (kind === 'thread-id' || kind === 'parent-thread-id') return input.threadIdMap[value] ?? null
  if (kind === 'provider-id' || kind === 'artifact-id') return value
  for (const [sourceRoot, destinationRoot] of Object.entries(input.workspacePathMap)) {
    if (kind === 'workspace-root' && comparablePath(value, input.sourcePlatform) === comparablePath(sourceRoot, input.sourcePlatform)) {
      return destinationRoot
    }
    if (kind === 'workspace-file') {
      const relativePath = migrationPathRelativeToWorkspace({
        path: value,
        workspaceRoot: sourceRoot,
        sourcePlatform: input.sourcePlatform
      })
      if (relativePath) {
        return buildMigrationDestinationPath({
          destinationRoot,
          relativePath,
          destinationPlatform: currentPlatform()
        })
      }
    }
  }
  return null
}

function visitPointerPattern(
  root: unknown,
  pattern: string,
  visitor: (parent: Record<string, unknown> | unknown[], key: string | number, pointer: string) => void
): void {
  const segments = pattern.split('/').slice(1).map(unescapePointer)
  const walk = (value: unknown, index: number, pointer: string) => {
    if (index >= segments.length) return
    if (!value || typeof value !== 'object') return
    const segment = segments[index]!
    const keys: Array<string | number> = segment === '*'
      ? (Array.isArray(value) ? value.map((_, key) => key) : Object.keys(value))
      : [Array.isArray(value) && /^\d+$/.test(segment) ? Number(segment) : segment]
    for (const key of keys) {
      const parent = value as Record<string, unknown> | unknown[]
      const container = parent as unknown as Record<string | number, unknown>
      if (!(key in container)) continue
      const nextPointer = `${pointer}/${escapePointer(String(key))}`
      if (index === segments.length - 1) visitor(parent, key, nextPointer)
      else walk(container[key], index + 1, nextPointer)
    }
  }
  walk(root, 0, '')
}

function destinationPathIssue(
  path: PackageRelativePath,
  root: string,
  probe: DestinationFileSystemProbe
): { kind: 'invalid-name' | 'path-too-long' } | null {
  try {
    if (probe.platform === 'windows') validateKunpackEntryPath(path)
    else validateKunpackArchiveEntryPath(path)
  } catch {
    return { kind: 'invalid-name' }
  }
  if (path.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > probe.maximumComponentBytes)) {
    return { kind: 'path-too-long' }
  }
  const destination = buildMigrationDestinationPath({ destinationRoot: root, relativePath: path, destinationPlatform: probe.platform })
  return Buffer.byteLength(destination, 'utf8') > probe.maximumPathBytes ? { kind: 'path-too-long' } : null
}

function workspaceEntryRelativePath(path: PackageRelativePath, workspaceId: string): PackageRelativePath | null {
  const prefix = `payload/workspaces/${workspaceId}/files/`
  return path.startsWith(prefix) ? parsePackageRelativePath(path.slice(prefix.length)) : null
}

function conflict(
  workspaceId: string,
  path: PackageRelativePath,
  kind: DataMigrationConflict['kind'],
  fatal: boolean,
  sourceSha256?: string,
  sourceBytes?: number,
  renamedPath?: PackageRelativePath
): DataMigrationConflict {
  return {
    conflictId: `conflict_${createHash('sha256').update(`${workspaceId}\0${path}\0${kind}`).digest('hex').slice(0, 24)}`,
    workspaceId,
    path,
    kind,
    fatal,
    ...(sourceSha256 ? { sourceSha256 } : {}),
    ...(sourceBytes !== undefined ? { sourceBytes } : {}),
    ...(renamedPath ? { renamedPath } : {})
  }
}

function assertConflictResolutionAllowed(
  conflict: DataMigrationConflict,
  resolution: DataMigrationFileConflictResolution
): void {
  if (!conflict.fatal) {
    if (!['keep-target', 'import-sibling', 'replace-with-backup', 'skip'].includes(resolution)) {
      throw new Error(`invalid resolution for ${conflict.kind}: ${resolution}`)
    }
    return
  }
  if (conflict.fatal) {
    if (resolution !== 'skip' && resolution !== 'rename-source') {
      throw new Error(`invalid resolution for ${conflict.kind}: ${resolution}`)
    }
    if (resolution === 'rename-source' && !conflict.renamedPath) {
      throw new Error(`no compatible rename is available for ${conflict.path}`)
    }
  }
}

function sanitizeDestinationSegment(value: string, platform: DataMigrationSourcePlatform): string {
  let output = [...value].map((character) => {
    if (character.charCodeAt(0) <= 0x1f) return '-'
    if (platform === 'windows' && /[<>:"/\\|?*]/.test(character)) return '-'
    return character
  }).join('')
  if (platform === 'windows') {
    output = output.replace(/[. ]+$/g, '')
    const stem = output.split('.')[0]!.toLocaleLowerCase('en-US')
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) output = `${output}-file`
  }
  return truncateUtf8(output || 'file', 180)
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = ''
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maximumBytes) break
    output += character
  }
  return output
}

async function pathLogicalBytes(path: string): Promise<number> {
  const details = await lstat(path)
  if (details.isSymbolicLink()) return Buffer.byteLength(await readlink(path), 'utf8')
  if (details.isFile()) return details.size
  if (!details.isDirectory()) return 0
  let total = 0
  for (const entry of await readdir(path)) total += await pathLogicalBytes(join(path, entry))
  return total
}

function fileSystemIdentity(path: PackageRelativePath, probe: DestinationFileSystemProbe): string {
  let value = probe.unicodeNormalizationSensitive ? path : path.normalize('NFC')
  if (!probe.caseSensitive) value = value.toLocaleLowerCase('en-US')
  return value
}

function comparablePath(value: string, platform: DataMigrationSourcePlatform): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return platform === 'windows' ? normalized.toLocaleLowerCase('en-US') : normalized
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let cursor = resolve(path)
  while (!await exists(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`no existing parent directory for destination: ${path}`)
    cursor = parent
  }
  const details = await lstat(cursor)
  return details.isDirectory() ? cursor : dirname(cursor)
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch(() => false)
}

function sanitizeDestinationName(value: string): string {
  return [...basename(value)]
    .map((character) => character.charCodeAt(0) <= 0x1f || /[<>:"/\\|?*]/.test(character) ? '-' : character)
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
}

function destinationIdentity(value: string): string {
  return resolve(value).normalize('NFC').toLocaleLowerCase('en-US')
}

function assertSafeIndependentDestination(
  value: string,
  plannedDestinations: readonly string[]
): void {
  const destination = resolve(value)
  const segments = destination.split(/[\\/]/).map((segment) => segment.toLocaleLowerCase('en-US'))
  if (segments.some((segment) =>
    segment.startsWith('.kun-migration-staging') || segment === '.kun-migration-backup'
  )) {
    throw new Error(`migration destination cannot use a staging or backup directory: ${value}`)
  }
  for (const planned of plannedDestinations) {
    const existing = resolve(planned)
    if (
      destinationIdentity(destination) === destinationIdentity(existing) ||
      pathIsBelow(existing, destination) ||
      pathIsBelow(destination, existing)
    ) {
      throw new Error(`migration workspace destinations overlap: ${existing} / ${destination}`)
    }
  }
}

function pathIsBelow(parent: string, candidate: string): boolean {
  const path = relative(destinationIdentity(parent), destinationIdentity(candidate))
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path)
}

function currentPlatform(): DataMigrationSourcePlatform {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
}

function unescapePointer(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~')
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
