import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { VideoEngineError, engineError } from './errors.js'
import {
  MAX_PROJECT_HISTORY,
  PROJECT_SCHEMA_VERSION,
  migrateProject,
  syncActiveSequenceProjection,
  validateProjectRoundTrip,
  type MutationReceipt,
  type Revision,
  type VideoProject
} from './schema.js'
import { generateTimelineMarkdown } from './script.js'
import { assertValidTimeline } from './timeline.js'
import type { CommitMetadata, PendingProjectCommit, ProjectServiceOptions } from './project-service-model.js'
import {
  assertConfinedRegularFile,
  assertInside,
  atomicWriteJson,
  atomicWriteText,
  boundedCause,
  isNodeError,
  parsePendingProjectCommit,
  rejectSymbolicPath,
  validateProjectId,
  writeSnapshotAt
} from './project-service-support.js'

export class ProjectServiceStorage {
  readonly workspaceRoot: string
  readonly dataRoot: string
  protected readonly historyLimit: number
  protected readonly now: () => Date
  protected readonly commitPhaseHook?: ProjectServiceOptions['commitPhaseHook']
  protected readonly sourceProbe?: ProjectServiceOptions['sourceProbe']
  protected readonly operations = new Map<string, Promise<unknown>>()
  protected readonly lastReceipts = new Map<string, MutationReceipt>()

  constructor(workspaceRoot: string, options: ProjectServiceOptions = {}) {
    if (!isAbsolute(workspaceRoot)) {
      throw engineError('path_escape', 'ProjectService requires an absolute workspace root')
    }
    this.workspaceRoot = resolve(workspaceRoot)
    this.dataRoot = join(this.workspaceRoot, '.kun-video')
    this.historyLimit = Math.max(2, Math.min(MAX_PROJECT_HISTORY, options.historyLimit ?? MAX_PROJECT_HISTORY))
    this.now = options.now ?? (() => new Date())
    this.commitPhaseHook = options.commitPhaseHook
    this.sourceProbe = options.sourceProbe
  }

  getLastReceipt(projectId: string): MutationReceipt | undefined {
    const receipt = this.lastReceipts.get(projectId)
    return receipt ? structuredClone(receipt) : undefined
  }

  async loadRevision(projectId: string, revision: number): Promise<VideoProject> {
    validateProjectId(projectId)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw engineError('history_unavailable', 'Revision must be a non-negative integer')
    }
    await this.ensureDataRoot()
    await this.assertProjectDirectory(projectId)
    return await this.loadSnapshot(projectId, revision)
  }

  protected async commit(
    current: VideoProject,
    candidate: VideoProject,
    metadata: CommitMetadata,
    stacks: { undoStack: number[]; redoStack: number[]; agentUndoStack: VideoProject['agentUndoStack'] }
  ): Promise<VideoProject> {
    const synchronizedCandidate = syncActiveSequenceProjection(candidate)
    if (synchronizedCandidate.id !== current.id || synchronizedCandidate.createdAt !== current.createdAt) {
      throw engineError('invalid_project', 'A project commit cannot change stable identity fields')
    }
    const revisionNumber = current.currentRevision + 1
    const timestamp = this.now().toISOString()
    const revision: Revision = {
      revision: revisionNumber,
      parentRevision: current.currentRevision,
      author: metadata.author,
      ...(metadata.actorId ? { actorId: metadata.actorId } : {}),
      ...(metadata.transactionId ? { transactionId: metadata.transactionId } : {}),
      sourceOperation: metadata.sourceOperation,
      timestamp,
      summary: metadata.summary,
      operations: structuredClone(metadata.operations ?? []),
      inverseOperations: structuredClone(metadata.inverseOperations ?? []),
      ...(metadata.restoredFromRevision === undefined
        ? {}
        : { restoredFromRevision: metadata.restoredFromRevision })
    }
    const retainedRevisions = [...current.revisions, revision].slice(-this.historyLimit)
    const retainedNumbers = new Set(retainedRevisions.map(({ revision: number }) => number))
    const nextAgentUndoStack = metadata.author === 'agent' &&
      metadata.actorId !== undefined &&
      !metadata.sourceOperation.startsWith('history.')
      ? [...stacks.agentUndoStack, {
          revision: revisionNumber,
          actorId: metadata.actorId,
          transactionId: metadata.transactionId ?? randomUUID()
        }]
      : stacks.agentUndoStack
    const next: VideoProject = {
      ...structuredClone(synchronizedCandidate),
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      currentRevision: revisionNumber,
      eventGeneration: current.eventGeneration + 1,
      selection: {
        ...structuredClone(synchronizedCandidate.selection),
        revision: revisionNumber,
        sequenceId: synchronizedCandidate.activeSequenceId
      },
      revisions: retainedRevisions,
      undoStack: stacks.undoStack.filter((number) => retainedNumbers.has(number)).slice(-this.historyLimit),
      redoStack: stacks.redoStack.filter((number) => retainedNumbers.has(number)).slice(-this.historyLimit),
      agentUndoStack: nextAgentUndoStack
        .filter(({ revision: number }) => retainedNumbers.has(number))
        .slice(-this.historyLimit)
    }
    const validated = syncActiveSequenceProjection(next)
    assertValidTimeline(validated)
    const pending: PendingProjectCommit = {
      schemaVersion: 1,
      projectId: validated.id,
      previousRevision: current.currentRevision,
      project: structuredClone(validated)
    }
    await atomicWriteJson(this.pendingCommitPath(validated.id), pending)
    await this.commitPhaseHook?.('pending')
    let snapshotWritten = false
    let projectCommitted = false
    try {
      await this.writeSnapshot(validated)
      snapshotWritten = true
      await this.commitPhaseHook?.('snapshot')
      await atomicWriteJson(this.projectPath(validated.id), validated)
      projectCommitted = true
      await this.commitPhaseHook?.('project')
      await atomicWriteText(this.timelinePath(validated.id), generateTimelineMarkdown(validated))
      await this.commitPhaseHook?.('timeline')
      await rm(this.pendingCommitPath(validated.id), { force: true })
    } catch (error) {
      if (!projectCommitted) {
        if (snapshotWritten) await rm(this.snapshotPath(validated.id, revisionNumber), { force: true })
        await rm(this.pendingCommitPath(validated.id), { force: true })
        throw error
      }
      // project.json is the transaction commit point. Once it has moved into
      // place, finish the journal rather than reporting a false rollback to a
      // caller that could retry the same revision.
      await this.recoverPendingCommit(validated.id)
    }
    await this.pruneSnapshots(validated.id, retainedNumbers)
    return structuredClone(validated)
  }

  protected async recoverPendingCommit(projectId: string): Promise<void> {
    const pendingPath = this.pendingCommitPath(projectId)
    let raw: unknown
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), pendingPath)
      raw = JSON.parse(await readFile(pendingPath, 'utf8'))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    const pending = parsePendingProjectCommit(raw, projectId)
    let current: VideoProject
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), this.projectPath(projectId))
      current = migrateProject(JSON.parse(await readFile(this.projectPath(projectId), 'utf8')))
      assertValidTimeline(current)
    } catch (error) {
      throw engineError('invalid_project', 'Pending project commit cannot read its commit point', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    if (current.currentRevision === pending.previousRevision) {
      await rm(this.snapshotPath(projectId, pending.project.currentRevision), { force: true })
      await rm(pendingPath, { force: true })
      return
    }
    if (current.currentRevision > pending.project.currentRevision) {
      await rm(pendingPath, { force: true })
      return
    }
    if (
      current.currentRevision !== pending.project.currentRevision ||
      JSON.stringify(current) !== JSON.stringify(pending.project)
    ) {
      throw engineError('invalid_project', 'Pending project commit disagrees with project.json')
    }

    await atomicWriteJson(this.snapshotPath(projectId, current.currentRevision), current)
    await atomicWriteText(this.timelinePath(projectId), generateTimelineMarkdown(current))
    await rm(pendingPath, { force: true })
  }

  protected async loadSnapshot(projectId: string, revision: number): Promise<VideoProject> {
    try {
      await assertConfinedRegularFile(
        this.projectDirectory(projectId),
        this.snapshotPath(projectId, revision)
      )
      const raw: unknown = JSON.parse(await readFile(this.snapshotPath(projectId, revision), 'utf8'))
      const project = migrateProject(raw)
      assertValidTimeline(project)
      return project
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('history_unavailable', `Revision ${revision} is no longer retained`)
      }
      throw error
    }
  }

  protected async persistMigration(
    projectId: string,
    sourceVersion: number,
    rawText: string,
    project: VideoProject
  ): Promise<void> {
    const backupDirectory = this.backupDirectory(projectId)
    await rejectSymbolicPath(this.projectDirectory(projectId), backupDirectory)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const backupPath = join(backupDirectory, `project.schema-v${sourceVersion}.json`)
    try {
      const handle = await open(backupPath, 'wx', 0o600)
      try {
        await handle.writeFile(rawText, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      // A migration backup is immutable. Retrying a migration must never
      // replace the first recoverable source document.
      if (!isNodeError(error, 'EEXIST')) throw error
    }
    const validated = validateProjectRoundTrip(project)
    await atomicWriteJson(this.projectPath(projectId), validated)
    await atomicWriteText(this.timelinePath(projectId), generateTimelineMarkdown(validated))
  }

  protected async loadRecoverableSnapshot(projectId: string, cause: unknown): Promise<VideoProject> {
    const entries = await readdir(this.revisionDirectory(projectId)).catch(() => [])
    const revisions = entries.flatMap((entry) => {
      const match = /^revision-(\d+)\.json$/u.exec(entry)
      return match ? [Number(match[1])] : []
    }).sort((left, right) => right - left)
    for (const revision of revisions) {
      try {
        const recovered = await this.loadSnapshot(projectId, revision)
        const project = syncActiveSequenceProjection({
          ...recovered,
          recovery: {
            mode: 'write-blocked',
            recoveredFromRevision: revision,
            unreadableManifestKinds: ['project'],
            interruptedJobIds: structuredClone(recovered.recovery.interruptedJobIds),
            notes: [
              `project.json was preserved after a read failure: ${boundedCause(cause)}`
            ]
          }
        })
        assertValidTimeline(project)
        return project
      } catch (error) {
        if (error instanceof VideoEngineError && error.code === 'unsupported_schema_version') throw error
      }
    }
    throw engineError('invalid_project', 'Project manifest is unreadable and no valid snapshot is retained', {
      cause: boundedCause(cause)
    })
  }

  protected async reconcileRestartState(project: VideoProject): Promise<VideoProject> {
    const next = structuredClone(project)
    const interrupted = new Set(next.recovery.interruptedJobIds)
    let changed = false
    for (const reference of next.derivedReferences) {
      if (reference.status !== 'processing') continue
      reference.status = 'interrupted'
      reference.errorCode = 'process_interrupted_by_restart'
      reference.updatedAt = this.now().toISOString()
      interrupted.add(reference.id)
      changed = true
    }
    if (!changed) return next
    next.recovery.interruptedJobIds = [...interrupted].slice(-128)
    next.recovery.notes = [
      ...next.recovery.notes,
      'In-flight derived work was reconciled as interrupted after restart.'
    ].slice(-128)
    return next
  }

  protected async probeSources(project: VideoProject): Promise<VideoProject> {
    if (!this.sourceProbe) return structuredClone(project)
    const next = structuredClone(project)
    for (const asset of next.assets) {
      let result: Awaited<ReturnType<NonNullable<ProjectServiceOptions['sourceProbe']>>>
      try {
        result = await this.sourceProbe(asset)
      } catch {
        result = { availability: 'offline' }
      }
      const identityChanged = asset.sourceIdentity !== undefined &&
        result.sourceIdentity !== undefined &&
        JSON.stringify(asset.sourceIdentity) !== JSON.stringify(result.sourceIdentity)
      const availability = identityChanged ? 'changed' : result.availability
      asset.availability = availability
      asset.recovery = availability === 'online'
        ? { lastVerifiedAt: this.now().toISOString() }
        : {
            reason: availability === 'offline' ? 'missing' : availability,
            lastVerifiedAt: this.now().toISOString(),
            ...(asset.mediaHandleId ? { previousMediaHandleId: asset.mediaHandleId } : {})
          }
      if (availability !== 'online') {
        for (const reference of next.derivedReferences) {
          if (reference.sourceAssetId === asset.id) {
            reference.status = 'invalid'
            reference.errorCode = `source_${availability}`
            reference.updatedAt = this.now().toISOString()
          }
        }
      }
    }
    return next
  }

  protected async reconcileAuxiliaryManifests(
    projectId: string,
    project: VideoProject
  ): Promise<VideoProject> {
    const next = structuredClone(project)
    for (const kind of ['media', 'derived'] as const) {
      const path = join(this.projectDirectory(projectId), `${kind}-manifest.json`)
      try {
        await assertConfinedRegularFile(this.projectDirectory(projectId), path)
        JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) continue
        if (error instanceof VideoEngineError && error.code === 'path_escape') throw error
        next.recovery.mode = 'write-blocked'
        next.recovery.unreadableManifestKinds = [
          ...new Set([...next.recovery.unreadableManifestKinds, kind])
        ]
        next.recovery.notes = [
          ...next.recovery.notes,
          `${kind}-manifest.json was preserved after a read failure: ${boundedCause(error)}`
        ].slice(-128)
        if (kind === 'media') {
          for (const asset of next.assets) {
            asset.availability = 'offline'
            asset.recovery = {
              reason: 'manifest-unreadable',
              ...(asset.mediaHandleId ? { previousMediaHandleId: asset.mediaHandleId } : {})
            }
          }
        } else {
          for (const reference of next.derivedReferences) {
            reference.status = 'invalid'
            reference.errorCode = 'manifest_unreadable'
          }
        }
      }
    }
    return next
  }

  protected async preserveRecoveryEvidence(project: VideoProject): Promise<void> {
    if (project.recovery.mode !== 'write-blocked') return
    const backupDirectory = this.backupDirectory(project.id)
    await rejectSymbolicPath(this.projectDirectory(project.id), backupDirectory)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    for (const kind of project.recovery.unreadableManifestKinds) {
      const sourcePath = kind === 'project'
        ? this.projectPath(project.id)
        : join(this.projectDirectory(project.id), `${kind}-manifest.json`)
      const destination = join(backupDirectory, `unreadable-${kind}-manifest.json`)
      try {
        await assertConfinedRegularFile(this.projectDirectory(project.id), sourcePath)
        const content = await readFile(sourcePath)
        try {
          const handle = await open(destination, 'wx', 0o600)
          try {
            await handle.writeFile(content)
            await handle.sync()
          } finally {
            await handle.close()
          }
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) throw error
        }
        if (kind !== 'project') await rm(sourcePath, { force: true })
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }

  protected async writeSnapshot(project: VideoProject): Promise<void> {
    await writeSnapshotAt(this.projectDirectory(project.id), project)
  }

  protected async pruneSnapshots(projectId: string, retained: ReadonlySet<number>): Promise<void> {
    const directory = this.revisionDirectory(projectId)
    const entries = await readdir(directory)
    await Promise.all(entries.flatMap((entry) => {
      const match = /^revision-(\d+)\.json$/u.exec(entry)
      if (!match || retained.has(Number(match[1]))) return []
      return [rm(join(directory, entry), { force: true })]
    }))
  }

  protected async ensureDataRoot(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 })
    const workspaceCanonical = await realpath(this.workspaceRoot)
    await rejectSymbolicPath(this.workspaceRoot, this.dataRoot)
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
    const dataCanonical = await realpath(this.dataRoot)
    assertInside(workspaceCanonical, dataCanonical)
    await rejectSymbolicPath(this.dataRoot, this.projectsRoot())
    await mkdir(this.projectsRoot(), { recursive: true, mode: 0o700 })
    const projectsCanonical = await realpath(this.projectsRoot())
    assertInside(dataCanonical, projectsCanonical)
  }

  protected async assertProjectDirectory(projectId: string): Promise<void> {
    const projectDirectory = this.projectDirectory(projectId)
    try {
      const stats = await lstat(projectDirectory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw engineError('path_escape', 'Project directory must be a real confined directory')
      }
      const canonicalProjects = await realpath(this.projectsRoot())
      const canonicalProject = await realpath(projectDirectory)
      assertInside(canonicalProjects, canonicalProject)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('project_not_found', `Project does not exist: ${projectId}`)
      }
      throw error
    }
  }

  protected projectsRoot(): string {
    return join(this.dataRoot, 'projects')
  }

  protected projectDirectory(projectId: string): string {
    validateProjectId(projectId)
    return join(this.projectsRoot(), projectId)
  }

  protected projectPath(projectId: string): string {
    return join(this.projectDirectory(projectId), 'project.json')
  }

  protected timelinePath(projectId: string): string {
    return join(this.projectDirectory(projectId), 'timeline.md')
  }

  protected revisionDirectory(projectId: string): string {
    return join(this.projectDirectory(projectId), 'revisions')
  }

  protected backupDirectory(projectId: string): string {
    return join(this.projectDirectory(projectId), 'backups')
  }

  protected snapshotPath(projectId: string, revision: number): string {
    return join(this.revisionDirectory(projectId), `revision-${String(revision).padStart(8, '0')}.json`)
  }

  protected pendingCommitPath(projectId: string): string {
    return join(this.projectDirectory(projectId), '.pending-commit.json')
  }

  protected async serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(projectId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.operations.set(projectId, current)
    try {
      return await current
    } finally {
      if (this.operations.get(projectId) === current) this.operations.delete(projectId)
    }
  }
}
