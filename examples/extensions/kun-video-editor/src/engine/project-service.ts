import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { VideoEngineError, engineError } from './errors.js'
import {
  PROJECT_SCHEMA_VERSION,
  migrateProject,
  migrateProjectWithReport,
  syncActiveSequenceProjection,
  validateProjectRoundTrip,
  type MutationReceipt,
  type Revision,
  type RevisionAuthor,
  type TimelineOperation,
  type VideoProject
} from './schema.js'
import {
  buildMutationReceipt,
  type CommandAttribution,
  type ProjectCommandRequest,
  type ProjectCommandResult,
  type ProjectSelectionPatch,
  type SelectionUpdateResult
} from './command-service.js'
import { generateTimelineMarkdown } from './script.js'
import { applyTimelineOperations, assertValidTimeline, canvasForPreset } from './timeline.js'
import { ProjectServiceStorage } from './project-service-storage.js'
import {
  assertExpectedRevision,
  assertConfinedRegularFile,
  atomicWriteJson,
  atomicWriteText,
  attributionFromMetadata,
  cleanupDerivedReferences,
  isNodeError,
  isProjectId,
  relinkMedia,
  validateAttribution,
  validateProjectId,
  writeSnapshotAt
} from './project-service-support.js'
import type {
  CommitMetadata,
  CreateProjectInput,
  ImportProjectInput,
  ProjectListResult,
  ProjectDiagnostic,
  ProjectSummary
} from './project-service-model.js'

export * from './project-service-model.js'

export class ProjectService extends ProjectServiceStorage {
  async createProject(input: CreateProjectInput): Promise<VideoProject> {
    validateProjectId(input.id)
    return await this.serialize(input.id, async () => {
      await this.ensureDataRoot()
      const projectDirectory = this.projectDirectory(input.id)
      const stagingDirectory = join(this.projectsRoot(), `.${input.id}.${randomUUID()}.tmp`)
      try {
        await lstat(projectDirectory)
        throw engineError('project_exists', `Project already exists: ${input.id}`)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      await mkdir(join(stagingDirectory, 'revisions'), { recursive: true, mode: 0o700 })
      const timestamp = this.now().toISOString()
      const initialRevision: Revision = {
        revision: 0,
        parentRevision: null,
        author: 'system',
        sourceOperation: 'project.create',
        timestamp,
        summary: 'Created project',
        operations: [],
        inverseOperations: []
      }
      const sequenceId = 'sequence-main'
      const tracks: VideoProject['tracks'] = [
        { id: 'video-1', name: 'Video 1', kind: 'video', order: 0, overlap: 'reject' },
        { id: 'audio-1', name: 'Audio 1', kind: 'audio', order: 1, overlap: 'mix' },
        { id: 'captions-1', name: 'Captions', kind: 'caption', order: 2, overlap: 'reject' }
      ]
      const project: VideoProject = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: input.id,
        name: input.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        fps: input.fps ?? { numerator: 30, denominator: 1 },
        canvas: canvasForPreset(input.canvasPreset ?? '16:9'),
        assets: [],
        mediaFolders: [],
        tracks,
        items: [],
        captions: [],
        sequences: [{
          id: sequenceId,
          name: input.name,
          tracks: structuredClone(tracks),
          items: [],
          captions: [],
          viewState: { zoom: 1, scrollFrame: 0, open: true }
        }],
        activeSequenceId: sequenceId,
        linkGroups: [],
        selection: {
          generation: 0,
          revision: 0,
          sequenceId,
          playheadFrame: 0,
          selectedAssetIds: [],
          selectedItemIds: [],
          selectedCaptionIds: [],
          selectedWordIds: []
        },
        transcripts: [],
        derivedReferences: [],
        multicamGroups: [],
        currentRevision: 0,
        eventGeneration: 0,
        revisions: [initialRevision],
        undoStack: [],
        redoStack: [],
        agentUndoStack: [],
        recovery: {
          mode: 'healthy',
          unreadableManifestKinds: [],
          interruptedJobIds: [],
          notes: []
        }
      }
      assertValidTimeline(project)
      try {
        await writeSnapshotAt(stagingDirectory, project)
        await atomicWriteJson(join(stagingDirectory, 'project.json'), project)
        await atomicWriteText(join(stagingDirectory, 'timeline.md'), generateTimelineMarkdown(project))
        await rename(stagingDirectory, projectDirectory)
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true })
        if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
          throw engineError('project_exists', `Project already exists: ${input.id}`)
        }
        throw error
      }
      return structuredClone(project)
    })
  }

  /**
   * Materializes an already validated interchange snapshot as a new project.
   * The destination identity is explicit and creation is atomic: an existing
   * project is never replaced, merged, or truncated by import.
   */
  async importProject(input: ImportProjectInput): Promise<VideoProject> {
    validateProjectId(input.targetProjectId)
    validateProjectId(input.expectedSourceProjectId)
    if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0) {
      throw engineError('revision_conflict', 'Imported source revision fence is invalid')
    }
    if (!/^[a-f0-9]{64}$/u.test(input.sourceDocumentDigest)) {
      throw engineError('invalid_project', 'Imported source document digest is invalid')
    }
    const source = validateProjectRoundTrip(input.project)
    if (
      source.id !== input.expectedSourceProjectId ||
      source.currentRevision !== input.expectedSourceRevision
    ) {
      throw engineError('revision_conflict', 'Imported project identity or revision changed after preview', {
        expectedProjectId: input.expectedSourceProjectId,
        actualProjectId: source.id,
        expectedRevision: input.expectedSourceRevision,
        currentRevision: source.currentRevision
      })
    }
    if (source.currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw engineError('invalid_project', 'Imported project revision cannot be advanced safely')
    }
    return await this.serialize(input.targetProjectId, async () => {
      await this.ensureDataRoot()
      const projectDirectory = this.projectDirectory(input.targetProjectId)
      try {
        await lstat(projectDirectory)
        throw engineError('project_exists', `Project already exists: ${input.targetProjectId}`)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      const stagingDirectory = join(
        this.projectsRoot(),
        `.${input.targetProjectId}.${randomUUID()}.tmp`
      )
      const timestamp = this.now().toISOString()
      const importedRevision = source.currentRevision + 1
      const project = syncActiveSequenceProjection({
        ...structuredClone(source),
        id: input.targetProjectId,
        updatedAt: timestamp,
        currentRevision: importedRevision,
        eventGeneration: source.eventGeneration + 1,
        selection: {
          ...structuredClone(source.selection),
          revision: importedRevision,
          generation: source.selection.generation + 1
        },
        revisions: [...source.revisions, {
          revision: importedRevision,
          parentRevision: source.currentRevision,
          author: 'manual' as const,
          sourceOperation: 'interchange.otio.import',
          timestamp,
          summary: `Imported OTIO document ${input.sourceDocumentDigest.slice(0, 12)}`,
          operations: [],
          inverseOperations: []
        }].slice(-this.historyLimit),
        undoStack: [],
        redoStack: [],
        agentUndoStack: [],
        recovery: {
          ...structuredClone(source.recovery),
          notes: [
            ...source.recovery.notes,
            `Imported from OTIO project ${input.expectedSourceProjectId} at revision ${input.expectedSourceRevision}.`,
            'Media references remain offline until explicitly relinked through Host grants.'
          ].slice(-64)
        }
      })
      assertValidTimeline(project)
      const validated = validateProjectRoundTrip(project)
      try {
        await mkdir(join(stagingDirectory, 'revisions'), { recursive: true, mode: 0o700 })
        await writeSnapshotAt(stagingDirectory, validated)
        await atomicWriteJson(join(stagingDirectory, 'project.json'), validated)
        await atomicWriteText(
          join(stagingDirectory, 'timeline.md'),
          generateTimelineMarkdown(validated)
        )
        await rename(stagingDirectory, projectDirectory)
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true })
        if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
          throw engineError('project_exists', `Project already exists: ${input.targetProjectId}`)
        }
        throw error
      }
      return structuredClone(validated)
    })
  }

  async loadProject(projectId: string): Promise<VideoProject> {
    validateProjectId(projectId)
    await this.ensureDataRoot()
    await this.assertProjectDirectory(projectId)
    await this.recoverPendingCommit(projectId)
    try {
      await assertConfinedRegularFile(this.projectDirectory(projectId), this.projectPath(projectId))
      const rawText = await readFile(this.projectPath(projectId), 'utf8')
      const raw: unknown = JSON.parse(rawText)
      const migration = migrateProjectWithReport(raw)
      let project = validateProjectRoundTrip(migration.project)
      if (project.id !== projectId) {
        throw engineError('invalid_project', 'Project identity does not match its directory')
      }
      const beforeReconciliation = JSON.stringify(project)
      project = await this.reconcileRestartState(project)
      assertValidTimeline(project)
      if (migration.migrated) {
        await this.persistMigration(projectId, migration.sourceVersion, rawText, project)
      } else if (JSON.stringify(project) !== beforeReconciliation) {
        await atomicWriteJson(this.projectPath(projectId), project)
      }
      if (this.sourceProbe) {
        const beforeProbe = JSON.stringify(project)
        project = await this.probeSources(project)
        if (JSON.stringify(project) !== beforeProbe) {
          assertValidTimeline(project)
          await atomicWriteJson(this.projectPath(projectId), project)
        }
      }
      project = await this.reconcileAuxiliaryManifests(projectId, project)
      assertValidTimeline(project)
      return project
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw engineError('project_not_found', `Project does not exist: ${projectId}`)
      }
      if (
        error instanceof VideoEngineError &&
        ['unsupported_schema_version', 'path_escape', 'project_not_found'].includes(error.code)
      ) throw error
      return await this.loadRecoverableSnapshot(projectId, error)
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.listProjectsWithDiagnostics()).projects
  }

  async listProjectsWithDiagnostics(): Promise<ProjectListResult> {
    await this.ensureDataRoot()
    const projectsRoot = this.projectsRoot()
    const entries = await readdir(projectsRoot, { withFileTypes: true })
    const summaries: ProjectSummary[] = []
    const diagnostics: ProjectDiagnostic[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isProjectId(entry.name)) continue
      let project: VideoProject
      try {
        project = await this.loadProject(entry.name)
      } catch (error) {
        diagnostics.push({
          id: entry.name,
          code: error instanceof VideoEngineError ? error.code : 'invalid_project'
        })
        continue
      }
      summaries.push({
        id: project.id,
        name: project.name,
        currentRevision: project.currentRevision,
        updatedAt: project.updatedAt,
        durationFrames: project.items.reduce(
          (maximum, item) => Math.max(maximum, item.timelineStartFrame + item.durationFrames),
          0
        )
      })
    }
    return {
      projects: summaries.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
      ),
      diagnostics
    }
  }

  async saveProject(
    candidate: VideoProject,
    expectedRevision: number,
    metadata: CommitMetadata
  ): Promise<VideoProject> {
    return (await this.saveProjectWithReceipt(candidate, expectedRevision, metadata)).project
  }

  async saveProjectWithReceipt(
    candidate: VideoProject,
    expectedRevision: number,
    metadata: CommitMetadata
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId: candidate.id,
      expectedRevision,
      attribution: attributionFromMetadata(metadata),
      command: { kind: 'replace-project', project: candidate }
    })
  }

  async applyOperations(
    projectId: string,
    expectedRevision: number,
    operations: readonly TimelineOperation[],
    metadata: Omit<CommitMetadata, 'operations' | 'inverseOperations'>
  ): Promise<VideoProject> {
    return (await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: attributionFromMetadata(metadata),
      command: { kind: 'timeline', operations: [...operations] }
    })).project
  }

  async applyOperationsWithReceipt(
    projectId: string,
    expectedRevision: number,
    operations: readonly TimelineOperation[],
    metadata: Omit<CommitMetadata, 'operations' | 'inverseOperations'>
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: attributionFromMetadata(metadata),
      command: { kind: 'timeline', operations: [...operations] }
    })
  }

  async undo(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<VideoProject> {
    return (await this.undoWithReceipt(projectId, expectedRevision, author)).project
  }

  async undoWithReceipt(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: {
        author,
        ...(author === 'agent' ? { actorId: 'kun-agent' } : {}),
        sourceOperation: 'history.undo',
        summary: 'Restored the previous project revision'
      },
      command: { kind: 'history-undo' }
    })
  }

  async redo(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<VideoProject> {
    return (await this.redoWithReceipt(projectId, expectedRevision, author)).project
  }

  async redoWithReceipt(
    projectId: string,
    expectedRevision: number,
    author: RevisionAuthor = 'manual'
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: {
        author,
        ...(author === 'agent' ? { actorId: 'kun-agent' } : {}),
        sourceOperation: 'history.redo',
        summary: 'Restored the next project revision'
      },
      command: { kind: 'history-redo' }
    })
  }

  async undoAgent(
    projectId: string,
    expectedRevision: number,
    actorId: string
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: {
        author: 'agent',
        actorId,
        sourceOperation: 'history.agent-undo',
        summary: 'Undid the Agent\'s most recent eligible edit'
      },
      command: { kind: 'agent-undo', actorId }
    })
  }

  async relinkMedia(
    projectId: string,
    expectedRevision: number,
    input: Omit<Extract<ProjectCommandRequest['command'], { kind: 'relink-media' }>, 'kind'>,
    attribution: CommandAttribution = {
      author: 'manual',
      sourceOperation: 'media.relink',
      summary: 'Relinked offline media'
    }
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution,
      command: { kind: 'relink-media', ...input }
    })
  }

  async cleanupDerivedCache(
    projectId: string,
    expectedRevision: number,
    derivedIds?: string[]
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: {
        author: 'manual',
        sourceOperation: 'derived.cleanup',
        summary: 'Removed disposable derived cache references'
      },
      command: { kind: 'cleanup-derived-cache', ...(derivedIds ? { derivedIds } : {}) }
    })
  }

  async confirmRecovery(
    projectId: string,
    expectedRevision: number
  ): Promise<ProjectCommandResult> {
    return await this.executeCommand({
      projectId,
      expectedRevision,
      attribution: {
        author: 'manual',
        sourceOperation: 'project.confirm-recovery',
        summary: 'Confirmed recovery from a retained project snapshot'
      },
      command: { kind: 'confirm-recovery' }
    })
  }

  async updateSelection(
    projectId: string,
    expectedRevision: number,
    expectedGeneration: number,
    patch: ProjectSelectionPatch
  ): Promise<SelectionUpdateResult> {
    validateProjectId(projectId)
    return await this.serialize(projectId, async () => {
      const current = await this.loadProject(projectId)
      assertExpectedRevision(current, expectedRevision)
      if (current.selection.generation !== expectedGeneration) {
        throw engineError('revision_conflict', 'Video selection generation has changed', {
          expectedRevision,
          currentRevision: current.currentRevision,
          expectedGeneration,
          currentGeneration: current.selection.generation
        })
      }
      if (current.recovery.mode === 'write-blocked') {
        throw engineError('recovery_required', 'Selection cannot be persisted until recovery is confirmed')
      }
      const project = syncActiveSequenceProjection({
        ...structuredClone(current),
        eventGeneration: current.eventGeneration + 1,
        selection: {
          ...structuredClone(current.selection),
          ...structuredClone(patch),
          generation: current.selection.generation + 1,
          revision: current.currentRevision
        }
      })
      assertValidTimeline(project)
      await atomicWriteJson(this.projectPath(projectId), project)
      return {
        projectId,
        revision: project.currentRevision,
        generation: project.selection.generation,
        eventGeneration: project.eventGeneration,
        selection: structuredClone(project.selection)
      }
    })
  }

  async executeCommand(request: ProjectCommandRequest): Promise<ProjectCommandResult> {
    validateProjectId(request.projectId)
    validateAttribution(request.attribution)
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw engineError('revision_conflict', 'Expected revision must be a non-negative integer')
    }
    return await this.serialize(request.projectId, async () => {
      const current = await this.loadProject(request.projectId)
      assertExpectedRevision(current, request.expectedRevision)
      if (current.recovery.mode === 'write-blocked' && request.command.kind !== 'confirm-recovery') {
        throw engineError(
          'recovery_required',
          'The recovered project is write-blocked until recovery is explicitly confirmed',
          {
            projectId: current.id,
            recoveredFromRevision: current.recovery.recoveredFromRevision,
            unreadableManifestKinds: current.recovery.unreadableManifestKinds
          }
        )
      }

      const transactionId = randomUUID()
      let candidate: VideoProject
      let operationNotes: MutationReceipt['notes'] = []
      let metadata: CommitMetadata = {
        ...request.attribution,
        transactionId
      }
      let stacks = {
        undoStack: [...current.undoStack, current.currentRevision],
        redoStack: [] as number[],
        agentUndoStack: structuredClone(current.agentUndoStack)
      }

      switch (request.command.kind) {
        case 'timeline': {
          const result = applyTimelineOperations(current, request.command.operations)
          candidate = result.project
          operationNotes = result.notes
          metadata = {
            ...metadata,
            operations: structuredClone(request.command.operations),
            inverseOperations: result.inverseOperations
          }
          break
        }
        case 'replace-project':
          candidate = syncActiveSequenceProjection(request.command.project)
          break
        case 'history-undo': {
          const targetRevision = current.undoStack.at(-1)
          if (targetRevision === undefined) {
            throw engineError('history_unavailable', 'No retained project revision is available to undo')
          }
          candidate = await this.loadSnapshot(request.projectId, targetRevision)
          metadata = {
            ...metadata,
            summary: `Restored revision ${targetRevision}`,
            operations: [],
            inverseOperations: [],
            restoredFromRevision: targetRevision
          }
          stacks = {
            undoStack: current.undoStack.slice(0, -1),
            redoStack: [...current.redoStack, current.currentRevision],
            agentUndoStack: structuredClone(current.agentUndoStack)
          }
          break
        }
        case 'history-redo': {
          const targetRevision = current.redoStack.at(-1)
          if (targetRevision === undefined) {
            throw engineError('history_unavailable', 'No retained project revision is available to redo')
          }
          candidate = await this.loadSnapshot(request.projectId, targetRevision)
          metadata = {
            ...metadata,
            summary: `Restored revision ${targetRevision}`,
            operations: [],
            inverseOperations: [],
            restoredFromRevision: targetRevision
          }
          stacks = {
            undoStack: [...current.undoStack, current.currentRevision],
            redoStack: current.redoStack.slice(0, -1),
            agentUndoStack: structuredClone(current.agentUndoStack)
          }
          break
        }
        case 'agent-undo': {
          const eligible = current.agentUndoStack.at(-1)
          if (
            !eligible ||
            eligible.revision !== current.currentRevision ||
            eligible.actorId !== request.command.actorId
          ) {
            throw engineError(
              'agent_undo_fenced',
              'Agent undo refused because newer manual or foreign work intervened',
              {
                currentRevision: current.currentRevision,
                eligibleRevision: eligible?.revision,
                eligibleActorId: eligible?.actorId
              }
            )
          }
          const parentRevision = current.revisions.at(-1)?.parentRevision
          if (parentRevision === null || parentRevision === undefined) {
            throw engineError('history_unavailable', 'The Agent transaction has no retained parent revision')
          }
          candidate = await this.loadSnapshot(request.projectId, parentRevision)
          metadata = {
            ...metadata,
            summary: `Undid Agent transaction ${eligible.transactionId}`,
            operations: [],
            inverseOperations: [],
            restoredFromRevision: parentRevision
          }
          stacks = {
            undoStack: [...current.undoStack, current.currentRevision],
            redoStack: [],
            agentUndoStack: current.agentUndoStack.slice(0, -1)
          }
          break
        }
        case 'relink-media':
          candidate = relinkMedia(current, request.command, this.now().toISOString())
          break
        case 'cleanup-derived-cache':
          candidate = cleanupDerivedReferences(current, request.command.derivedIds)
          break
        case 'confirm-recovery':
          await this.preserveRecoveryEvidence(current)
          candidate = {
            ...structuredClone(current),
            recovery: {
              mode: 'healthy',
              unreadableManifestKinds: [],
              interruptedJobIds: structuredClone(current.recovery.interruptedJobIds),
              notes: ['Recovery explicitly confirmed; the preserved unreadable manifest was not deleted.']
            }
          }
          break
      }

      const next = await this.commit(current, candidate, metadata, stacks)
      const receipt = buildMutationReceipt(current, next, transactionId, request.attribution, operationNotes)
      this.lastReceipts.set(next.id, receipt)
      return { project: next, receipt }
    })
  }

}
