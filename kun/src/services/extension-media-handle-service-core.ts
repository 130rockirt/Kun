import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { installServiceOperations } from './service-operation-install.js'
import { extensionMediaHandleServiceRegistrationOperations } from './extension-media-handle-service-registration-operations.js'
import { extensionMediaHandleServiceCompletionOperations } from './extension-media-handle-service-completion-operations.js'
import { extensionMediaHandleServiceTransactionOperations } from './extension-media-handle-service-transaction-operations.js'
import { extensionMediaHandleServiceRevocationOperations } from './extension-media-handle-service-revocation-operations.js'

export const MediaHandleModeSchema = z.enum(['read', 'write'])
export const MediaHandleSourceSchema = z.enum(['workspace', 'picker', 'generated'])
export const MediaHandleLifecycleSchema = z.enum(['persistent', 'cache'])
export const FileIdentitySchema = z.strictObject({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  // Windows can report NTFS identifiers above Number.MAX_SAFE_INTEGER. They
  // are useful hardening signals, but must not make a valid media handle
  // impossible to persist in JSON.
  device: z.number().int().nonnegative().optional(),
  inode: z.number().int().nonnegative().optional()
})
export const StoredMediaHandleSchema = z.strictObject({
  id: z.string().min(1),
  ownerExtensionId: z.string().min(1),
  ownerExtensionVersion: z.string().min(1),
  workspaceRoot: z.string().min(1),
  absolutePath: z.string().min(1),
  displayName: z.string().min(1).max(256),
  mode: MediaHandleModeSchema,
  source: MediaHandleSourceSchema,
  lifecycle: MediaHandleLifecycleSchema.default('persistent'),
  mimeType: z.string().min(1).max(128),
  identity: FileIdentitySchema.optional(),
  previousIdentity: FileIdentitySchema.optional(),
  createdAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime().optional(),
  reservationId: z.string().min(1).max(256).optional(),
  completedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional()
})
export const MediaHandleDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  handles: z.record(z.string(), StoredMediaHandleSchema)
})

export type StoredMediaHandle = z.infer<typeof StoredMediaHandleSchema>
export type MediaHandleMode = z.infer<typeof MediaHandleModeSchema>
export type MediaHandleSource = z.infer<typeof MediaHandleSourceSchema>
export type MediaHandleLifecycle = z.infer<typeof MediaHandleLifecycleSchema>
export type FileIdentity = z.infer<typeof FileIdentitySchema>

export type MediaHandleProjection = {
  id: string
  displayName: string
  mode: MediaHandleMode
  source: MediaHandleSource
  /** Core-only lifecycle. Public metadata deliberately omits this field. */
  lifecycle?: MediaHandleLifecycle
  mimeType: string
  byteSize?: number
  modifiedAt?: string
  completionIdentity?: string
  workspaceRelativePath?: string
  available: boolean
  createdAt: string
  lastAccessedAt: string
}

export type ResolvedMediaHandle = MediaHandleProjection & {
  absolutePath: string
  workspaceRoot: string
  ownerExtensionId: string
  ownerExtensionVersion: string
  identity?: FileIdentity
}

/**
 * Core-only reversible completion used while a durable media job is still
 * waiting for semantic output validation and its terminal fence. Public
 * extensions never receive this object or the captured handle records.
 */
export type MediaOutputCompletionTransaction = {
  generatedMedia: MediaHandleProjection[]
  commit(): Promise<void>
  rollback(): Promise<void>
}

export type PendingMediaOutputTransaction = {
  handleId: string
  absolutePath: string
  completed: boolean
  hadTarget: boolean
  originalIdentity?: FileIdentity
  completedIdentity?: FileIdentity
}

export type CompletedMediaOutputRecovery = {
  handleId: string
  absolutePath: string
  completedIdentity: FileIdentity
}

export class ExtensionMediaHandleError extends Error {
  constructor(
    readonly code:
      | 'permission_denied'
      | 'workspace_untrusted'
      | 'workspace_denied'
      | 'not_found'
      | 'not_regular_file'
      | 'path_escape'
      | 'file_changed'
      | 'mode_denied'
      | 'handle_reserved'
      | 'handle_consumed'
      | 'handle_limit',
    message: string
  ) {
    super(message)
  }
}

export type RegisterMediaHandleInput = {
  workspaceRoot: string
  path: string
  mode: MediaHandleMode
  source: MediaHandleSource
  lifecycle?: MediaHandleLifecycle
  displayName?: string
  mimeType?: string
}

export type RegisterCacheMediaTargetInput = Pick<
  RegisterMediaHandleInput,
  'workspaceRoot' | 'path' | 'displayName' | 'mimeType'
>

export const emptyDocument = () => ({
  schemaVersion: 1 as const,
  revision: 0,
  handles: {}
})

/**
 * Runtime-owned durable media authority. Public callers receive projections;
 * only trusted core services can resolve a handle back to an absolute path.
 */
export class ExtensionMediaHandleService {
  declare private registerAuthorized: (typeof extensionMediaHandleServiceRegistrationOperations)['registerAuthorized']
  declare private requireOwned: (typeof extensionMediaHandleServiceRevocationOperations)['requireOwned']

  private readonly store: AtomicJsonFile<z.infer<typeof MediaHandleDocumentSchema>>
  private readonly now: () => Date
  private readonly maxHandlesPerExtension: number

  constructor(options: {
    dataDir: string
    now?: () => Date
    maxHandlesPerExtension?: number
  }) {
    this.store = new AtomicJsonFile(
      join(options.dataDir, 'extensions', 'media-handles.json'),
      (value) => MediaHandleDocumentSchema.parse(value)
    )
    this.now = options.now ?? (() => new Date())
    this.maxHandlesPerExtension = Math.max(1, Math.floor(options.maxHandlesPerExtension ?? 512))
  }
}

export interface ExtensionMediaHandleService {
  register(
    principal: ExtensionPrincipal,
    input: RegisterMediaHandleInput
  ): Promise<MediaHandleProjection>;
  registerCacheTarget(
    principal: ExtensionPrincipal,
    input: RegisterCacheMediaTargetInput
  ): Promise<MediaHandleProjection>;
  stat(principal: ExtensionPrincipal, handleId: string): Promise<MediaHandleProjection>;
  touch(principal: ExtensionPrincipal, handleId: string): Promise<MediaHandleProjection>;
  resolve(
    principal: ExtensionPrincipal,
    handleId: string,
    requiredMode: MediaHandleMode
  ): Promise<ResolvedMediaHandle>;
  release(principal: ExtensionPrincipal, handleId: string): Promise<boolean>;
  reserveOutput(
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<ResolvedMediaHandle>;
  releaseOutputReservation(
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<boolean>;
  completeOutput(
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<MediaHandleProjection>;
  completeOutputs(
    principal: ExtensionPrincipal,
    outputs: Array<{ handleId: string; reservationId: string }>,
    options?: { signal?: AbortSignal }
  ): Promise<MediaHandleProjection[]>;
  completeOutputsReversibly(
    principal: ExtensionPrincipal,
    outputs: Array<{ handleId: string; reservationId: string }>,
    options?: { signal?: AbortSignal }
  ): Promise<MediaOutputCompletionTransaction>;
  inspectOutputTransaction(
    principal: ExtensionPrincipal,
    handleId: string,
    reservationId: string
  ): Promise<PendingMediaOutputTransaction>;
  inspectCompletedOutput(
    principal: ExtensionPrincipal,
    handleId: string
  ): Promise<CompletedMediaOutputRecovery>;
  commitOutputTransaction(
    principal: ExtensionPrincipal,
    handleIds: readonly string[],
    reservationId: string
  ): Promise<void>;
  rollbackOutputTransaction(
    principal: ExtensionPrincipal,
    handleIds: readonly string[],
    reservationId: string
  ): Promise<void>;
  revokeExtension(extensionId: string): Promise<number>;
  revokeExtensionWorkspace(
    extensionId: string,
    workspaceId: string,
    workspaceRoot?: string
  ): Promise<number>;
  revokeWorkspace(workspaceRoot: string): Promise<number>;
  list(principal: ExtensionPrincipal, workspaceRoot?: string): Promise<MediaHandleProjection[]>;
}

installServiceOperations(
  ExtensionMediaHandleService.prototype,
  extensionMediaHandleServiceRegistrationOperations,
  extensionMediaHandleServiceCompletionOperations,
  extensionMediaHandleServiceTransactionOperations,
  extensionMediaHandleServiceRevocationOperations
)


export async function resolveCandidate(
  input: RegisterMediaHandleInput & { workspaceRoot: string }
): Promise<{ absolutePath: string; identity?: FileIdentity }> {
  if (!isAbsolute(input.path)) {
    const candidate = resolve(input.workspaceRoot, input.path)
    await assertWithinWorkspace(input.workspaceRoot, candidate, input.mode === 'write')
    return input.mode === 'read'
      ? { absolutePath: await realpath(candidate), identity: await readIdentity(candidate) }
      : await outputCandidate(candidate)
  }
  if (input.source !== 'picker') {
    throw new ExtensionMediaHandleError('path_escape', 'Absolute media paths require a protected picker grant')
  }
  if (input.mode === 'read') {
    const absolutePath = await realpath(input.path)
    return { absolutePath, identity: await readIdentity(absolutePath) }
  }
  return await outputCandidate(input.path)
}

export async function outputCandidate(path: string): Promise<{ absolutePath: string; identity?: FileIdentity }> {
  const absolutePath = await canonicalOutput(path)
  try {
    return { absolutePath, identity: await readIdentity(absolutePath) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absolutePath }
    throw error
  }
}

export async function authorizeWorkspace(
  principal: ExtensionPrincipal,
  workspaceRoot: string
): Promise<string> {
  if (!principal.workspaceTrusted) {
    throw new ExtensionMediaHandleError('workspace_untrusted', 'Workspace is not trusted')
  }
  const canonical = await canonicalExistingDirectory(workspaceRoot)
  const authorized = await Promise.all(principal.workspaceRoots.map(async (root) => {
    try {
      return await canonicalExistingDirectory(root)
    } catch {
      return ''
    }
  }))
  if (!authorized.includes(canonical)) {
    throw new ExtensionMediaHandleError('workspace_denied', 'Workspace is not authorized')
  }
  return canonical
}

export function assertExtensionCacheTarget(
  principal: ExtensionPrincipal,
  workspaceRoot: string,
  path: string
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(principal.extensionId) ||
    isAbsolute(path)
  ) {
    throw new ExtensionMediaHandleError('path_escape', 'Invalid Host-owned extension cache target')
  }
  const cacheRoot = resolve(workspaceRoot, '.kun', 'extension-cache', principal.extensionId)
  const candidate = resolve(workspaceRoot, path)
  const rel = relative(cacheRoot, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ExtensionMediaHandleError(
      'path_escape',
      'Cache target must remain inside the owning extension cache'
    )
  }
  return candidate
}

export async function ensureCacheParent(workspaceRoot: string, target: string): Promise<void> {
  const parentRelative = relative(workspaceRoot, dirname(target))
  if (
    parentRelative === '' || parentRelative === '..' ||
    parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative)
  ) {
    throw new ExtensionMediaHandleError('path_escape', 'Cache parent escapes the workspace')
  }
  let current = workspaceRoot
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ExtensionMediaHandleError(
          'path_escape',
          'Host-owned cache directories cannot contain links or non-directories'
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ExtensionMediaHandleError(
          'path_escape',
          'Host-owned cache directories cannot contain links or non-directories'
        )
      }
    }
  }
}

export function requirePermission(principal: ExtensionPrincipal, permission: string): void {
  if (!principal.permissions.includes(permission)) {
    throw new ExtensionMediaHandleError('permission_denied', `Missing permission: ${permission}`)
  }
}

export function requireRecordAccess(
  principal: ExtensionPrincipal,
  record: StoredMediaHandle,
  mode: MediaHandleMode
): void {
  if (mode === 'write' && record.lifecycle === 'cache') {
    requirePermission(principal, 'media.process')
    requirePermission(principal, 'workspace.write')
    return
  }
  requirePermission(principal, mode === 'read' ? 'media.read' : 'media.export')
  requirePermission(principal, mode === 'read' ? 'workspace.read' : 'workspace.write')
}

export async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path))
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new ExtensionMediaHandleError('not_regular_file', 'Workspace is not a directory')
  return canonical
}

export async function assertWithinWorkspace(root: string, candidate: string, output: boolean): Promise<void> {
  const canonicalRoot = await canonicalExistingDirectory(root)
  const canonicalCandidate = output ? await canonicalOutput(candidate) : await realpath(candidate)
  const rel = relative(canonicalRoot, canonicalCandidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ExtensionMediaHandleError('path_escape', 'Media path escapes the workspace')
  }
}

export async function canonicalOutput(path: string): Promise<string> {
  const candidate = resolve(path)
  const parent = await realpath(dirname(candidate))
  const target = resolve(parent, basename(candidate))
  try {
    const linkInfo = await lstat(target)
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new ExtensionMediaHandleError('not_regular_file', 'Media output is not a regular file')
    }
    return await realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target
    throw error
  }
}

export function fileIdentityFromStat(info: {
  size: number | bigint
  mtimeMs: number | bigint
  dev: number | bigint
  ino: number | bigint
}): FileIdentity {
  const device = serializableFileSystemIdentifier(info.dev)
  const inode = serializableFileSystemIdentifier(info.ino)
  return {
    size: statNumber(info.size),
    mtimeMs: statNumber(info.mtimeMs),
    ...(device === undefined ? {} : { device }),
    ...(inode === undefined ? {} : { inode })
  }
}

export function serializableFileSystemIdentifier(value: number | bigint): number | undefined {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function statNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

export async function readIdentity(path: string): Promise<FileIdentity> {
  const info = await stat(path)
  if (!info.isFile()) throw new ExtensionMediaHandleError('not_regular_file', 'Media input is not a regular file')
  return fileIdentityFromStat(info)
}

export async function refreshIdentity(record: StoredMediaHandle): Promise<StoredMediaHandle> {
  if (record.mode === 'write' && !record.identity) {
    try {
      await lstat(record.absolutePath)
      throw new ExtensionMediaHandleError('file_changed', 'Export target changed after selection')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return record
      throw error
    }
  }
  const current = await readIdentity(record.absolutePath)
  if (record.identity && !matchesFileIdentity(record.identity, current)) {
    throw new ExtensionMediaHandleError('file_changed', 'Media file identity changed')
  }
  return { ...record, identity: current }
}

export function assertOwnedRecord(
  record: StoredMediaHandle | undefined,
  principal: ExtensionPrincipal
): asserts record is StoredMediaHandle {
  if (!record || record.revokedAt || record.ownerExtensionId !== principal.extensionId ||
    record.ownerExtensionVersion !== principal.extensionVersion) {
    throw new ExtensionMediaHandleError('not_found', 'Media handle is not available')
  }
}

export function assertOwnedTransactionRecord(
  record: StoredMediaHandle | undefined,
  principal: ExtensionPrincipal
): asserts record is StoredMediaHandle {
  if (!record || record.ownerExtensionId !== principal.extensionId ||
    record.ownerExtensionVersion !== principal.extensionVersion ||
    (record.revokedAt !== undefined &&
      !(record.mode === 'write' && record.completedAt !== undefined && record.reservationId))) {
    throw new ExtensionMediaHandleError('not_found', 'Media handle is not available')
  }
}

export function assertOwnedRecordIncludingRevoked(
  record: StoredMediaHandle | undefined,
  principal: ExtensionPrincipal
): asserts record is StoredMediaHandle {
  if (!record || record.ownerExtensionId !== principal.extensionId ||
    record.ownerExtensionVersion !== principal.extensionVersion) {
    throw new ExtensionMediaHandleError('not_found', 'Media handle is not available')
  }
}

export function matchesFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs &&
    (left.device === undefined || right.device === undefined || left.device === right.device) &&
    (left.inode === undefined || right.inode === undefined || left.inode === right.inode)
}

export function identifiesSameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device !== undefined && right.device !== undefined &&
    left.inode !== undefined && right.inode !== undefined &&
    left.device === right.device && left.inode === right.inode
}

export function project(record: StoredMediaHandle): MediaHandleProjection {
  const rel = relative(record.workspaceRoot, record.absolutePath)
  const workspaceRelativePath = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : undefined
  return {
    id: record.id,
    displayName: record.displayName,
    mode: record.mode,
    source: record.source,
    lifecycle: record.lifecycle,
    mimeType: record.mimeType,
    ...(record.identity ? {
      byteSize: record.identity.size,
      modifiedAt: new Date(record.identity.mtimeMs).toISOString(),
      completionIdentity: completionIdentity(record)
    } : {}),
    ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
    available: !record.revokedAt,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt ?? record.createdAt
  }
}

export async function deleteCachePaths(paths: ReadonlySet<string>): Promise<void> {
  await Promise.all([...paths].map(async (path) => {
    try {
      await rm(path, { force: true })
    } catch {
      // Revocation is authoritative even if best-effort filesystem cleanup is
      // temporarily blocked; no cache handle remains usable after this point.
    }
  }))
}

export function completionIdentity(record: StoredMediaHandle): string {
  const identity = record.identity
  if (!identity) return ''
  return createHash('sha256')
    .update(`${record.id}\0${identity.device ?? ''}\0${identity.inode ?? ''}\0${identity.size}\0${identity.mtimeMs}`)
    .digest('base64url')
}

export function boundedDisplayName(value: string): string {
  const normalized = stripAsciiControl(value.trim())
  return (normalized || 'media').slice(0, 256)
}

export function stripAsciiControl(value: string): string {
  return [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return code > 31 && code !== 127
  }).join('')
}

export function inferMediaMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.wav': return 'audio/wav'
    case '.aac': return 'audio/aac'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.srt': return 'application/x-subrip'
    case '.vtt': return 'text/vtt'
    case '.otio': return 'application/x-otio+json'
    default: return 'application/octet-stream'
  }
}
