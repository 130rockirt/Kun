import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { engineError } from './errors.js'
import {
  migrateProject,
  syncActiveSequenceProjection,
  type VideoProject
} from './schema.js'
import type { CommandAttribution, ProjectCommandRequest } from './command-service.js'
import { assertValidTimeline } from './timeline.js'
import type { CommitMetadata, PendingProjectCommit } from './project-service-model.js'

export function parsePendingProjectCommit(value: unknown, projectId: string): PendingProjectCommit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw engineError('invalid_project', 'Pending project commit is invalid')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (
    JSON.stringify(keys) !==
      JSON.stringify(['previousRevision', 'project', 'projectId', 'schemaVersion']) ||
    candidate.schemaVersion !== 1 ||
    candidate.projectId !== projectId ||
    !Number.isSafeInteger(candidate.previousRevision) ||
    Number(candidate.previousRevision) < 0
  ) {
    throw engineError('invalid_project', 'Pending project commit metadata is invalid')
  }
  const project = migrateProject(candidate.project)
  assertValidTimeline(project)
  if (
    project.id !== projectId ||
    project.currentRevision !== Number(candidate.previousRevision) + 1
  ) {
    throw engineError('invalid_project', 'Pending project commit revision is invalid')
  }
  return {
    schemaVersion: 1,
    projectId,
    previousRevision: Number(candidate.previousRevision),
    project
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeSnapshotAt(projectDirectory: string, project: VideoProject): Promise<void> {
  const path = join(
    projectDirectory,
    'revisions',
    `revision-${String(project.currentRevision).padStart(8, '0')}.json`
  )
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function atomicWriteText(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function rejectSymbolicPath(root: string, target: string): Promise<void> {
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw engineError('path_escape', 'Project path escapes the workspace')
  }
  let cursor = root
  for (const part of fromRoot.split(sep)) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw engineError('path_escape', 'Symbolic links are not accepted in project storage')
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
  }
}

export async function assertConfinedRegularFile(root: string, path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw engineError('path_escape', 'Project state must be a real confined regular file')
  }
  assertInside(await realpath(root), await realpath(path))
}

export function assertInside(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw engineError('path_escape', 'Project path escapes the workspace')
  }
}

export function assertExpectedRevision(project: VideoProject, expectedRevision: number): void {
  if (project.currentRevision !== expectedRevision) {
    throw engineError('revision_conflict', 'Project revision has changed', {
      expectedRevision,
      currentRevision: project.currentRevision
    })
  }
}

export function attributionFromMetadata(metadata: CommitMetadata): CommandAttribution {
  return {
    author: metadata.author,
    ...(metadata.actorId
      ? { actorId: metadata.actorId }
      : metadata.author === 'agent'
        ? { actorId: 'kun-agent' }
        : {}),
    sourceOperation: metadata.sourceOperation,
    summary: metadata.summary
  }
}

export function validateAttribution(attribution: CommandAttribution): void {
  if (!['manual', 'agent', 'system'].includes(attribution.author)) {
    throw engineError('invalid_operation', 'Command attribution contains an unsupported author')
  }
  if (
    attribution.author === 'agent' &&
    (typeof attribution.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(attribution.actorId))
  ) {
    throw engineError('invalid_operation', 'Agent commands require a bounded actor identity')
  }
  if (
    typeof attribution.sourceOperation !== 'string' ||
    attribution.sourceOperation.length === 0 ||
    attribution.sourceOperation.length > 128 ||
    typeof attribution.summary !== 'string' ||
    attribution.summary.length === 0 ||
    attribution.summary.length > 1_024
  ) {
    throw engineError('invalid_operation', 'Command attribution is not bounded')
  }
}

export function relinkMedia(
  source: VideoProject,
  command: Extract<ProjectCommandRequest['command'], { kind: 'relink-media' }>,
  timestamp: string
): VideoProject {
  const project = structuredClone(source)
  const asset = project.assets.find(({ id }) => id === command.assetId)
  if (!asset) throw engineError('media_relink_required', `Media asset does not exist: ${command.assetId}`)
  if (!command.replacement && !command.mediaHandleId && !command.workspaceRelativePath) {
    throw engineError('media_relink_required', 'Relink requires an opaque media handle or workspace-relative path')
  }
  const previousMediaHandleId = asset.mediaHandleId
  if (command.replacement) {
    if (command.replacement.id !== asset.id || command.replacement.kind !== asset.kind) {
      throw engineError('media_relink_required', 'Replacement media must preserve the asset identity and kind')
    }
    Object.assign(asset, structuredClone(command.replacement))
  }
  if (command.mediaHandleId) asset.mediaHandleId = command.mediaHandleId
  else if (!command.replacement) delete asset.mediaHandleId
  if (command.workspaceRelativePath) asset.workspaceRelativePath = command.workspaceRelativePath
  else if (!command.replacement) delete asset.workspaceRelativePath
  asset.availability = 'online'
  if (command.sourceIdentity) asset.sourceIdentity = structuredClone(command.sourceIdentity)
  asset.recovery = {
    lastVerifiedAt: timestamp,
    ...(previousMediaHandleId ? { previousMediaHandleId } : {})
  }
  for (const reference of project.derivedReferences) {
    if (reference.sourceAssetId !== asset.id) continue
    reference.status = 'invalid'
    reference.errorCode = 'source_relinked'
    reference.updatedAt = timestamp
  }
  return syncActiveSequenceProjection(project)
}

export function cleanupDerivedReferences(
  source: VideoProject,
  requestedIds: readonly string[] | undefined
): VideoProject {
  const project = structuredClone(source)
  const requested = requestedIds ? new Set(requestedIds) : undefined
  if (requested) {
    for (const id of requested) {
      if (!project.derivedReferences.some((reference) => reference.id === id)) {
        throw engineError('invalid_operation', `Derived reference does not exist: ${id}`)
      }
    }
  }
  const byId = new Map(project.derivedReferences.map((reference) => [reference.id, reference]))
  const protectedIds = new Set(project.derivedReferences.filter(({ pinned }) => pinned).map(({ id }) => id))
  const visitDependencies = (id: string): void => {
    for (const dependencyId of byId.get(id)?.dependencyIds ?? []) {
      if (protectedIds.has(dependencyId)) continue
      protectedIds.add(dependencyId)
      visitDependencies(dependencyId)
    }
  }
  for (const id of [...protectedIds]) visitDependencies(id)
  project.derivedReferences = project.derivedReferences.filter((reference) =>
    protectedIds.has(reference.id) || (requested ? !requested.has(reference.id) : false)
  )
  return project
}

export function boundedCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 512)
}

export function validateProjectId(value: string): void {
  if (!isProjectId(value)) {
    throw engineError('path_escape', 'Project ID is not a confined stable identifier')
  }
}

export function isProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value) && value !== '.' && value !== '..'
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
