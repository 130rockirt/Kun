import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  PlanWorktreeAttachThreadRequest,
  PlanWorktreeAttentionReason,
  PlanWorktreeListRequest,
  PlanWorktreePreflightRequest,
  PlanWorktreePreflightResult,
  PlanWorktreePrepareRequest,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import {
  PlanWorktreeAttachThreadRequestSchema,
  PlanWorktreeListRequestSchema,
  PlanWorktreePreflightRequestSchema,
  PlanWorktreePrepareRequestSchema,
  PlanWorktreeRunIdRequestSchema
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import {
  buildExecutionBranch,
  ensureManagedWorktreeParent,
  managedPlanWorktreePath,
  pathExists,
  preflightPlanWorktree
} from './plan-worktree-git'
import { PlanWorktreeLockManager, PlanWorktreeRunStore } from './plan-worktree-run-store'
import { validateManagedWorktreeIdentity } from './plan-worktree-identity'

export class PlanWorktreeCoordinatorError extends Error {
  constructor(
    readonly reason: PlanWorktreeAttentionReason,
    message: string
  ) {
    super(message)
    this.name = 'PlanWorktreeCoordinatorError'
  }
}

export type PlanWorktreeCoordinatorOptions = {
  store: PlanWorktreeRunStore
  managedRoot?: string
  now?: () => Date
  createRunId?: () => string
  locks?: PlanWorktreeLockManager
  verifyExecutionThread: (
    record: PlanWorktreeRunRecord,
    request: PlanWorktreeAttachThreadRequest
  ) => Promise<void>
  recoverExecutionLink: (
    record: PlanWorktreeRunRecord
  ) => Promise<PlanWorktreeAttachThreadRequest | null>
}

type WorktreeRow = { path: string; branch?: string; head?: string }
export type PlanWorktreeExecutionOwnership = {
  record: PlanWorktreeRunRecord
  threadAbsent: boolean
}

function parseWorktreeRows(raw: string): WorktreeRow[] {
  const rows: WorktreeRow[] = []
  let current: WorktreeRow | null = null
  const flush = (): void => {
    if (current?.path) rows.push(current)
    current = null
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
    } else if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length).trim() }
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length).trim()
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    }
  }
  flush()
  return rows
}

export class PlanWorktreeCoordinator {
  readonly store: PlanWorktreeRunStore
  private readonly managedRoot: string
  private readonly now: () => Date
  private readonly createRunId: () => string
  private readonly locks: PlanWorktreeLockManager
  private readonly verifyExecutionThread: NonNullable<
    PlanWorktreeCoordinatorOptions['verifyExecutionThread']
  >
  private readonly recoverExecutionLink: PlanWorktreeCoordinatorOptions['recoverExecutionLink']

  constructor(options: PlanWorktreeCoordinatorOptions) {
    this.store = options.store
    this.managedRoot = resolve(options.managedRoot ?? join(homedir(), '.kun', 'worktrees'))
    this.now = options.now ?? (() => new Date())
    this.createRunId = options.createRunId ?? randomUUID
    this.locks = options.locks ?? new PlanWorktreeLockManager()
    this.verifyExecutionThread = options.verifyExecutionThread
    this.recoverExecutionLink = options.recoverExecutionLink
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.locks.withLock(key, operation)
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  async preflight(input: PlanWorktreePreflightRequest): Promise<PlanWorktreePreflightResult> {
    return preflightPlanWorktree(PlanWorktreePreflightRequestSchema.parse(input))
  }

  async prepare(input: PlanWorktreePrepareRequest): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreePrepareRequestSchema.parse(input)
    return this.withLock(`prepare:${request.operationId}`, async () => {
      const existing = await this.store.findByOperationId(request.operationId)
      if (existing) {
        this.assertMatchingPrepareRequest(existing, request)
        if (!this.isPreparationRecoveryCandidate(existing)) return existing
        const reconciled = await this.withLock(`run:${existing.runId}`, async () => {
          const current = await this.requireRun(existing.runId)
          this.assertMatchingPrepareRequest(current, request)
          return this.isPreparationRecoveryCandidate(current)
            ? this.reconcilePreparing(current)
            : current
        })
        if (this.isPreparationRecoveryCandidate(reconciled)) {
          throw new PlanWorktreeCoordinatorError(
            reconciled.attentionReason ?? 'preparation_interrupted',
            reconciled.attentionMessage ?? 'Worktree preparation remains unavailable.'
          )
        }
        return reconciled
      }
      const preflight = await this.preflight({
        workspaceRoot: request.sourceWorkspaceRoot,
        branchPrefix: request.branchPrefix
      })
      if (!preflight.eligible || !preflight.sourceCheckoutRoot || !preflight.primaryRepositoryRoot
        || !preflight.repositoryIdentity || !preflight.targetBranch || !preflight.baseCommit) {
        throw new PlanWorktreeCoordinatorError(
          preflight.attentionReason ?? 'external_state_changed',
          preflight.message ?? 'The source checkout is not eligible for isolated execution.'
        )
      }
      const {
        sourceCheckoutRoot,
        primaryRepositoryRoot,
        repositoryIdentity,
        targetBranch,
        baseCommit
      } = preflight
      return this.withLock(`repository:${repositoryIdentity}`, async () => {
      await this.store.assertNoUnreadableScope({
        planId: request.planId,
        sourceThreadId: request.sourceThreadId,
        sourceCheckoutRoot,
        repositoryIdentity
      })
      const duplicate = (await this.store.list()).find((candidate) =>
        candidate.status !== 'completed' && candidate.status !== 'cancelled'
        && candidate.planId === request.planId
        && candidate.sourceThreadId === request.sourceThreadId
        && candidate.sourceCheckoutRoot === sourceCheckoutRoot
        && candidate.repositoryIdentity === repositoryIdentity
      )
      if (duplicate) {
        throw new PlanWorktreeCoordinatorError(
          'external_state_changed',
          `This plan already has an unfinished isolated run: ${duplicate.runId}`
        )
      }
      const runId = this.createRunId()
      const executionBranch = buildExecutionBranch(request.branchPrefix, request.planTitle, runId)
      const worktreePath = managedPlanWorktreePath(
        runId,
        primaryRepositoryRoot,
        this.managedRoot
      )
      const workspaceRelativePath = relative(
        sourceCheckoutRoot,
        preflight.sourceWorkspaceRoot
      )
      if (isAbsolute(workspaceRelativePath) || workspaceRelativePath === '..'
        || workspaceRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new PlanWorktreeCoordinatorError(
          'external_state_changed',
          'The selected workspace is outside the captured source checkout.'
        )
      }
      const executionWorkspace = resolve(worktreePath, workspaceRelativePath)
      await this.assertFreeTargets(sourceCheckoutRoot, executionBranch, worktreePath)
      const createdAt = this.timestamp()
      const preparing: PlanWorktreeRunRecord = {
        version: 1,
        runId,
        operationId: request.operationId,
        planId: request.planId,
        planRelativePath: request.planRelativePath,
        planTitle: request.planTitle,
        goalObjective: request.goalObjective,
        executionPrompt: request.executionPrompt,
        executionDisplayText: request.executionDisplayText,
        executionPromptSha256: createHash('sha256').update(request.executionPrompt).digest('hex'),
        admissionClientRequestId: `plan-build:${runId}`,
        sourceThreadId: request.sourceThreadId,
        orchestration: request.orchestration,
        sourceWorkspaceRoot: request.sourceWorkspaceRoot,
        sourceCheckoutRoot,
        primaryRepositoryRoot,
        repositoryIdentity,
        targetBranch,
        baseCommit,
        executionBranch,
        worktreePath,
        executionWorkspace,
        admissionFrozen: false,
        status: 'preparing',
        cleanup: {
          threadRebound: false,
          worktreeRemoved: false,
          branchDeleted: false,
          metadataPruned: false
        },
        createdAt,
        updatedAt: createdAt
      }
      await this.store.save(preparing)
      try {
        await this.createPreparedWorktree(preparing)
        if (!(await pathExists(preparing.executionWorkspace!))) {
          throw new Error('The selected repository subdirectory is missing from the plan worktree.')
        }
        return this.store.save({
          ...preparing,
          status: 'executing',
          updatedAt: this.timestamp()
        })
      } catch (error) {
        const attention = await this.store.save({
          ...preparing,
          status: 'needs_attention',
          attentionReason: 'preparation_interrupted',
          attentionMessage: error instanceof Error ? error.message : String(error),
          updatedAt: this.timestamp()
        })
        throw new PlanWorktreeCoordinatorError(
          attention.attentionReason ?? 'preparation_interrupted',
          attention.attentionMessage ?? 'Worktree preparation was interrupted.'
        )
      }
      })
    })
  }

  private async assertFreeTargets(
    sourceCheckoutRoot: string,
    executionBranch: string,
    worktreePath: string
  ): Promise<void> {
    if (await pathExists(worktreePath)) {
      throw new PlanWorktreeCoordinatorError(
        'worktree_path_collision',
        'The managed worktree path already exists.'
      )
    }
    try {
      await runGit(sourceCheckoutRoot, [
        'show-ref', '--verify', '--quiet', `refs/heads/${executionBranch}`
      ])
      throw new PlanWorktreeCoordinatorError(
        'execution_branch_collision',
        'The generated execution branch already exists.'
      )
    } catch (error) {
      if (error instanceof PlanWorktreeCoordinatorError) throw error
    }
    await runGit(sourceCheckoutRoot, ['check-ref-format', '--branch', executionBranch])
  }

  private async createPreparedWorktree(record: PlanWorktreeRunRecord): Promise<void> {
    await ensureManagedWorktreeParent(record.worktreePath)
    await runGit(record.sourceCheckoutRoot, [
      'worktree', 'add', '-b', record.executionBranch, record.worktreePath, record.baseCommit
    ], 60_000)
    const head = (await runGit(record.worktreePath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const branch = (await runGit(
      record.worktreePath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD']
    )).stdout.trim()
    if (head !== record.baseCommit || branch !== record.executionBranch) {
      throw new Error('The created worktree does not match its captured branch and base commit.')
    }
  }

  async attachThread(input: PlanWorktreeAttachThreadRequest): Promise<PlanWorktreeRunRecord> {
    const request = PlanWorktreeAttachThreadRequestSchema.parse(input)
    return this.withLock(`run:${request.runId}`, async () => {
      const record = await this.requireRun(request.runId)
      return this.attachThreadLocked(record, request)
    })
  }

  async reconcileExecutionLink(runId: string): Promise<PlanWorktreeRunRecord> {
    return (await this.reconcileExecutionOwnership(runId)).record
  }

  async reconcileExecutionOwnership(runId: string): Promise<PlanWorktreeExecutionOwnership> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.withLock(`run:${request.runId}`, async () =>
      this.reconcileExecutionOwnershipLocked(await this.requireRun(request.runId)))
  }

  async get(runId: string): Promise<PlanWorktreeRunRecord | null> {
    const request = PlanWorktreeRunIdRequestSchema.parse({ runId })
    return this.store.get(request.runId)
  }

  async list(input: PlanWorktreeListRequest = {}): Promise<PlanWorktreeRunRecord[]> {
    const request = PlanWorktreeListRequestSchema.parse(input)
    return (await this.store.list()).filter((record) =>
      (request.includeCompleted || (record.status !== 'completed' && record.status !== 'cancelled'))
      && (!request.repositoryIdentity || record.repositoryIdentity === request.repositoryIdentity)
    )
  }

  async reconcileStartup(): Promise<PlanWorktreeRunRecord[]> {
    const records = await this.store.list()
    const reconciled: PlanWorktreeRunRecord[] = []
    for (const record of records) {
      reconciled.push(await this.withLock(`run:${record.runId}`, async () => {
        let current = await this.requireRun(record.runId)
        current = await (this.isPreparationRecoveryCandidate(current)
          ? this.reconcilePreparing(current)
          : current
        )
        return this.reconcileExecutionLinkLocked(current)
      }))
    }
    return reconciled
  }

  private async reconcileExecutionLinkLocked(
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeRunRecord> {
    return (await this.reconcileExecutionOwnershipLocked(record)).record
  }

  private async reconcileExecutionOwnershipLocked(
    record: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeExecutionOwnership> {
    if (record.status === 'completed' || record.status === 'cancelled') {
      return { record, threadAbsent: !record.executionThreadId }
    }
    if (record.executionThreadId && record.executionTurnId) {
      return { record, threadAbsent: false }
    }
    try {
      const recovered = await this.recoverExecutionLink(record)
      if (recovered) {
        return {
          record: await this.attachThreadLocked(record, recovered),
          threadAbsent: false
        }
      }
      const clearsUnavailableAttention = record.attentionReason === 'thread_attach_failed'
      const current = clearsUnavailableAttention
        ? await this.store.save({
            ...record,
            status: 'executing',
            attentionReason: undefined,
            attentionMessage: undefined,
            updatedAt: this.timestamp()
          })
        : record
      return { record: current, threadAbsent: true }
    } catch (error) {
      if (record.status === 'needs_attention' && record.attentionReason
        && record.attentionReason !== 'thread_attach_failed'
        && record.attentionReason !== 'turn_admission_failed') {
        return { record, threadAbsent: false }
      }
      return { record: await this.store.save({
        ...record,
        status: 'needs_attention',
        attentionReason: error instanceof PlanWorktreeCoordinatorError
          ? error.reason
          : 'thread_attach_failed',
        attentionMessage: error instanceof Error ? error.message : String(error),
        updatedAt: this.timestamp()
      }), threadAbsent: false }
    }
  }

  private async attachThreadLocked(
    record: PlanWorktreeRunRecord,
    request: PlanWorktreeAttachThreadRequest
  ): Promise<PlanWorktreeRunRecord> {
    this.assertImmutableAttachment(record, request)
    if (record.status === 'completed' || record.status === 'cancelled') return record
    await this.verifyExecutionThread(record, request)
    const recoversAttachFailure = record.attentionReason === 'thread_attach_failed'
    const addsMetadata = record.executionThreadId !== request.executionThreadId
      || (request.executionTurnId !== undefined
        && record.executionTurnId !== request.executionTurnId)
      || (request.graphRunId !== undefined && record.graphRunId !== request.graphRunId)
    if (!addsMetadata && record.status !== 'preparing' && !recoversAttachFailure) return record
    return this.store.save({
      ...record,
      executionThreadId: request.executionThreadId,
      ...(request.executionTurnId ? { executionTurnId: request.executionTurnId } : {}),
      ...(request.graphRunId ? { graphRunId: request.graphRunId } : {}),
      status: record.status === 'preparing' || recoversAttachFailure
        ? 'executing'
        : record.status,
      attentionReason: recoversAttachFailure ? undefined : record.attentionReason,
      attentionMessage: recoversAttachFailure ? undefined : record.attentionMessage,
      updatedAt: this.timestamp()
    })
  }

  private async reconcilePreparing(record: PlanWorktreeRunRecord): Promise<PlanWorktreeRunRecord> {
    try {
      const rows = parseWorktreeRows((await runGit(
        record.sourceCheckoutRoot,
        ['worktree', 'list', '--porcelain']
      )).stdout)
      const expectedPath = await realpath(record.worktreePath).catch(() => resolve(record.worktreePath))
      const rowsWithPhysicalPaths = await Promise.all(rows.map(async (item) => ({
        ...item,
        physicalPath: await realpath(item.path).catch(() => resolve(item.path))
      })))
      const row = rowsWithPhysicalPaths.find((item) => item.physicalPath === expectedPath)
      if (row?.branch === record.executionBranch) {
        if (row.head !== record.baseCommit) {
          return this.markPreparationAttention(record, 'Recorded worktree HEAD changed.')
        }
        if (!(await pathExists(record.worktreePath))) {
          return this.markPreparationAttention(record, 'Recorded worktree path is missing.')
        }
        if (record.executionWorkspace && !(await pathExists(record.executionWorkspace))) {
          return this.markPreparationAttention(record, 'Recorded execution workspace is missing.')
        }
        const identityError = await validateManagedWorktreeIdentity(record, this.managedRoot)
        if (identityError) return this.markPreparationAttention(record, identityError)
        return this.store.save({
          ...record,
          status: 'executing',
          attentionReason: undefined,
          attentionMessage: undefined,
          updatedAt: this.timestamp()
        })
      }
      if (row) return this.markPreparationAttention(record, 'Recorded worktree identity changed.')
      const branchExists = await this.branchExists(record.sourceCheckoutRoot, record.executionBranch)
      if (branchExists || await pathExists(record.worktreePath)) {
        return this.markPreparationAttention(record, 'Preparation left ambiguous branch or path state.')
      }
      await this.createPreparedWorktree(record)
      if (record.executionWorkspace && !(await pathExists(record.executionWorkspace))) {
        return this.markPreparationAttention(record, 'Recorded execution workspace is missing.')
      }
      return this.store.save({
        ...record,
        status: 'executing',
        attentionReason: undefined,
        attentionMessage: undefined,
        updatedAt: this.timestamp()
      })
    } catch (error) {
      return this.markPreparationAttention(
        record,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async branchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  private markPreparationAttention(
    record: PlanWorktreeRunRecord,
    message: string
  ): Promise<PlanWorktreeRunRecord> {
    return this.store.save({
      ...record,
      status: 'needs_attention',
      attentionReason: 'preparation_interrupted',
      attentionMessage: message,
      updatedAt: this.timestamp()
    })
  }

  private isPreparationRecoveryCandidate(record: PlanWorktreeRunRecord): boolean {
    return record.status === 'preparing'
      || (record.status === 'needs_attention' && record.attentionReason === 'preparation_interrupted')
  }

  private assertMatchingPrepareRequest(
    record: PlanWorktreeRunRecord,
    request: PlanWorktreePrepareRequest
  ): void {
    const expectedBranch = buildExecutionBranch(request.branchPrefix, request.planTitle, record.runId)
    const matches = record.planId === request.planId
      && record.planRelativePath === request.planRelativePath
      && record.planTitle === request.planTitle
      && record.goalObjective === request.goalObjective
      && record.executionPrompt === request.executionPrompt
      && record.executionDisplayText === request.executionDisplayText
      && record.executionPromptSha256
        === createHash('sha256').update(request.executionPrompt).digest('hex')
      && record.sourceThreadId === request.sourceThreadId
      && record.sourceWorkspaceRoot === request.sourceWorkspaceRoot
      && record.orchestration === request.orchestration
      && record.executionBranch === expectedBranch
    if (!matches) {
      throw new PlanWorktreeCoordinatorError(
        'external_state_changed',
        'This operation id is already bound to a different plan-build request.'
      )
    }
  }

  private assertImmutableAttachment(
    record: PlanWorktreeRunRecord,
    request: PlanWorktreeAttachThreadRequest
  ): void {
    const requestedLinks = [
      [record.executionThreadId, request.executionThreadId],
      [record.executionTurnId, request.executionTurnId],
      [record.graphRunId, request.graphRunId]
    ] as const
    const conflicts = requestedLinks.some(([persisted, requested]) =>
      persisted !== undefined && requested !== undefined && persisted !== requested
    )
    const terminalAddsMetadata = (record.status === 'completed' || record.status === 'cancelled')
      && requestedLinks.some(([persisted, requested]) =>
        requested !== undefined && persisted !== requested
      )
    if (conflicts || terminalAddsMetadata) {
      throw new PlanWorktreeCoordinatorError(
        'external_state_changed',
        'Plan-build execution linkage is immutable once recorded.'
      )
    }
  }

  async requireRun(runId: string): Promise<PlanWorktreeRunRecord> {
    const record = await this.store.get(runId)
    if (!record) throw new Error(`Unknown plan worktree run: ${runId}`)
    return record
  }
}
