import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreePrepareRequest, PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { runGit } from './git-service'
import {
  PlanWorktreeCoordinator,
  PlanWorktreeCoordinatorError
} from './plan-worktree-coordinator'
import { managedPlanWorktreePath } from './plan-worktree-git'
import { PlanWorktreeLockManager, PlanWorktreeRunStore } from './plan-worktree-run-store'

const roots: string[] = []
const allowExecutionThread = async (): Promise<void> => undefined
const noRecoveredExecutionLink = async (): Promise<null> => null

async function temp(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kun-plan-coordinator-${name}-`))
  roots.push(root)
  return root
}

async function repository(name: string): Promise<string> {
  const root = await temp(name)
  await runGit(root, ['init', '-b', 'feature/source'])
  await writeFile(join(root, 'README.md'), '# repository\n', 'utf8')
  await runGit(root, ['add', 'README.md'])
  await runGit(root, [
    '-c', 'user.name=Kun Test',
    '-c', 'user.email=kun@example.invalid',
    'commit', '-m', 'initial'
  ])
  return root
}

function request(workspace: string, operationId = 'operation-1'): PlanWorktreePrepareRequest {
  return {
    operationId,
    planId: 'plan-1',
    planRelativePath: '.kunsdd/plan/auth.md',
    planTitle: 'Auth flow',
    goalObjective: 'Implement and validate Auth flow',
    executionPrompt: 'Exact Auth plan prompt',
    executionDisplayText: 'Build Auth flow',
    sourceThreadId: 'thread-source',
    sourceWorkspaceRoot: workspace,
    orchestration: 'direct',
    branchPrefix: 'codex/'
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PlanWorktreeCoordinator preparation', () => {
  it('prepares from the captured HEAD and deduplicates operation ids', async () => {
    const source = await repository('prepare')
    const userData = await temp('user-data')
    const managedRoot = await temp('managed')
    const coordinator = new PlanWorktreeCoordinator({
      store: new PlanWorktreeRunStore(userData),
      managedRoot,
      createRunId: () => 'run-fixed',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })

    const prepared = await coordinator.prepare(request(source))
    const duplicate = await coordinator.prepare(request(source))
    expect(duplicate).toEqual(prepared)
    expect(prepared).toMatchObject({
      status: 'executing',
      targetBranch: 'feature/source',
      executionBranch: 'codex/auth-flow-runfixed',
      admissionCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    })
    expect((await runGit(prepared.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim())
      .toBe(prepared.baseCommit)
    expect((await runGit(prepared.worktreePath, ['branch', '--show-current'])).stdout.trim())
      .toBe(prepared.executionBranch)
  })

  it('fails closed on an ineligible dirty source', async () => {
    const source = await repository('dirty')
    await writeFile(join(source, 'dirty.txt'), 'dirty', 'utf8')
    const coordinator = new PlanWorktreeCoordinator({
      store: new PlanWorktreeRunStore(await temp('dirty-data')),
      managedRoot: await temp('dirty-managed'),
      createRunId: () => 'run-dirty',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    await expect(coordinator.prepare(request(source))).rejects.toMatchObject({
      reason: 'dirty_source_checkout'
    })
    expect(await coordinator.list({ includeCompleted: true })).toEqual([])
  })

  it('rejects a managed path collision without deleting it', async () => {
    const source = await repository('collision')
    const managedRoot = await temp('collision-managed')
    const collisionPath = managedPlanWorktreePath(
      'run-collision',
      await realpath(source),
      managedRoot
    )
    await mkdir(collisionPath, { recursive: true })
    const coordinator = new PlanWorktreeCoordinator({
      store: new PlanWorktreeRunStore(await temp('collision-data')),
      managedRoot,
      createRunId: () => 'run-collision',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })

    await expect(coordinator.prepare(request(source))).rejects.toBeInstanceOf(
      PlanWorktreeCoordinatorError
    )
    expect(await coordinator.list({ includeCompleted: true })).toEqual([])
    await expect(realpath(collisionPath)).resolves.toBeTruthy()
  })

  it('reconciles a persisted preparation with no Git side effects', async () => {
    const source = await repository('reconcile')
    const userData = await temp('reconcile-data')
    const managedRoot = await temp('reconcile-managed')
    const store = new PlanWorktreeRunStore(userData)
    const sourceRoot = await realpath(source)
    const baseCommit = (await runGit(source, ['rev-parse', 'HEAD'])).stdout.trim()
    const createdAt = '2026-08-12T12:00:00.000Z'
    const record: PlanWorktreeRunRecord = {
      version: 1,
      runId: 'run-reconcile',
      operationId: 'operation-reconcile',
      planId: 'plan-1',
      planRelativePath: '.kunsdd/plan/auth.md',
      planTitle: 'Auth',
      goalObjective: 'Implement and validate Auth',
      sourceThreadId: 'thread-source',
      orchestration: 'graph',
      sourceWorkspaceRoot: source,
      sourceCheckoutRoot: sourceRoot,
      primaryRepositoryRoot: sourceRoot,
      repositoryIdentity: join(sourceRoot, '.git'),
      targetBranch: 'feature/source',
      baseCommit,
      executionBranch: 'codex/auth-reconcile',
      worktreePath: managedPlanWorktreePath('run-reconcile', sourceRoot, managedRoot),
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
    await store.save(record)
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot,
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    const [reconciled] = await coordinator.reconcileStartup()
    expect(reconciled).toMatchObject({ runId: 'run-reconcile', status: 'executing' })
    expect((await runGit(record.worktreePath, ['branch', '--show-current'])).stdout.trim())
      .toBe(record.executionBranch)
  })

  it('rejects operation-id reuse for a different prepare request', async () => {
    const source = await repository('operation-mismatch')
    const coordinator = new PlanWorktreeCoordinator({
      store: new PlanWorktreeRunStore(await temp('operation-mismatch-data')),
      managedRoot: await temp('operation-mismatch-managed'),
      createRunId: () => 'run-operation-mismatch',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    await coordinator.prepare(request(source))

    await expect(coordinator.prepare({
      ...request(source),
      planId: 'plan-other'
    })).rejects.toMatchObject({ reason: 'external_state_changed' })
  })

  it('reconciles a recoverable duplicate prepare instead of returning needs-attention', async () => {
    const source = await repository('duplicate-reconcile')
    const store = new PlanWorktreeRunStore(await temp('duplicate-reconcile-data'))
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('duplicate-reconcile-managed'),
      createRunId: () => 'run-duplicate-reconcile',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    const prepared = await coordinator.prepare(request(source))
    await store.save({
      ...prepared,
      status: 'needs_attention',
      attentionReason: 'preparation_interrupted',
      attentionMessage: 'simulated interrupted persistence'
    })

    await expect(coordinator.prepare(request(source))).resolves.toMatchObject({
      runId: prepared.runId,
      status: 'executing',
      attentionReason: undefined,
      attentionMessage: undefined
    })
  })

  it('refuses stale Git metadata when the recorded worktree directory is missing', async () => {
    const source = await repository('stale-metadata')
    const store = new PlanWorktreeRunStore(await temp('stale-metadata-data'))
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('stale-metadata-managed'),
      createRunId: () => 'run-stale-metadata',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    const prepared = await coordinator.prepare(request(source))
    const physicalWorktreePath = await realpath(prepared.worktreePath)
    await rm(physicalWorktreePath, { recursive: true, force: true })
    await store.save({
      ...prepared,
      worktreePath: physicalWorktreePath,
      status: 'needs_attention',
      attentionReason: 'preparation_interrupted'
    })

    await expect(coordinator.prepare(request(source))).rejects.toMatchObject({
      reason: 'preparation_interrupted'
    })
    await expect(store.get(prepared.runId)).resolves.toMatchObject({
      status: 'needs_attention',
      attentionMessage: 'Recorded worktree path is missing.'
    })
  })

  it('reloads inside the recovery lock before reconciling startup state', async () => {
    const source = await repository('fresh-recovery')
    const store = new PlanWorktreeRunStore(await temp('fresh-recovery-data'))
    const locks = new PlanWorktreeLockManager()
    const coordinator = new PlanWorktreeCoordinator({
      store,
      locks,
      managedRoot: await temp('fresh-recovery-managed'),
      createRunId: () => 'run-fresh-recovery',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    const prepared = await coordinator.prepare(request(source))
    await store.save({ ...prepared, status: 'preparing' })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const lockEntered = new Promise<void>((resolve) => { entered = resolve })
    const holder = locks.withLock(`run:${prepared.runId}`, async () => {
      entered()
      await held
    })
    await lockEntered

    const recovery = coordinator.reconcileStartup()
    const attached = {
      ...prepared,
      executionThreadId: 'thread-execution',
      status: 'executing' as const
    }
    await store.save(attached)
    release()
    await holder

    await expect(recovery).resolves.toContainEqual(attached)
    await expect(store.get(prepared.runId)).resolves.toEqual(attached)
  })

  it('verifies and freezes execution linkage, including terminal retries', async () => {
    const source = await repository('attachment')
    const store = new PlanWorktreeRunStore(await temp('attachment-data'))
    const verifyExecutionThread = vi.fn(async () => undefined)
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('attachment-managed'),
      createRunId: () => 'run-attachment',
      verifyExecutionThread,
      recoverExecutionLink: noRecoveredExecutionLink
    })
    const prepared = await coordinator.prepare(request(source))
    const attachment = {
      runId: prepared.runId,
      executionThreadId: 'thread-execution',
      executionTurnId: 'turn-execution'
    }
    await coordinator.attachThread(attachment)
    expect(verifyExecutionThread).toHaveBeenCalledWith(prepared, attachment)
    await expect(coordinator.attachThread({
      ...attachment,
      executionTurnId: 'turn-other'
    })).rejects.toMatchObject({ reason: 'external_state_changed' })

    const terminal = await store.save({
      ...(await coordinator.requireRun(prepared.runId)),
      status: 'completed'
    })
    await expect(coordinator.attachThread(attachment)).resolves.toEqual(terminal)
    expect(verifyExecutionThread).toHaveBeenCalledTimes(1)
    await expect(coordinator.attachThread({
      ...attachment,
      graphRunId: 'graph-too-late'
    })).rejects.toMatchObject({ reason: 'external_state_changed' })
  })

  it('durably adopts a uniquely recovered thread and origin turn', async () => {
    const source = await repository('recover-link')
    const store = new PlanWorktreeRunStore(await temp('recover-link-data'))
    const recovered = vi.fn(async (record: PlanWorktreeRunRecord) => ({
      runId: record.runId,
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered'
    }))
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('recover-link-managed'),
      createRunId: () => 'run-recover-link',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: recovered
    })
    const prepared = await coordinator.prepare(request(source))
    await store.save({
      ...prepared,
      status: 'needs_attention',
      attentionReason: 'thread_attach_failed',
      attentionMessage: 'renderer crashed before attachment'
    })

    await expect(coordinator.reconcileExecutionLink(prepared.runId)).resolves.toMatchObject({
      status: 'executing',
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered',
      attentionReason: undefined
    })
    await expect(coordinator.reconcileExecutionLink(prepared.runId)).resolves.toMatchObject({
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered'
    })
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('repairs the legacy redacted-prompt false alarm after proving the exact origin', async () => {
    const source = await repository('recover-redacted-origin')
    const store = new PlanWorktreeRunStore(await temp('recover-redacted-origin-data'))
    const recovered = vi.fn(async (record: PlanWorktreeRunRecord) => ({
      runId: record.runId,
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered'
    }))
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('recover-redacted-origin-managed'),
      createRunId: () => 'run-recover-redacted-origin',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: recovered
    })
    const prepared = await coordinator.prepare(request(source))
    await store.save({
      ...prepared,
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered',
      status: 'needs_attention',
      attentionReason: 'external_state_changed',
      attentionMessage: 'A foreign turn was admitted before the durable plan-build origin.'
    })

    await expect(coordinator.reconcileExecutionLink(prepared.runId)).resolves.toMatchObject({
      status: 'executing',
      executionThreadId: 'thread-recovered',
      executionTurnId: 'turn-recovered',
      attentionReason: undefined,
      attentionMessage: undefined
    })
    expect(recovered).toHaveBeenCalledOnce()
  })

  it('does not overwrite an unrelated retained recovery reason when Kun is offline', async () => {
    const source = await repository('preserve-attention')
    const store = new PlanWorktreeRunStore(await temp('preserve-attention-data'))
    const coordinator = new PlanWorktreeCoordinator({
      store,
      managedRoot: await temp('preserve-attention-managed'),
      createRunId: () => 'run-preserve-attention',
      verifyExecutionThread: allowExecutionThread,
      recoverExecutionLink: async () => {
        throw new PlanWorktreeCoordinatorError('thread_attach_failed', 'Kun is offline')
      }
    })
    const prepared = await coordinator.prepare(request(source))
    const retained = await store.save({
      ...prepared,
      status: 'needs_attention',
      attentionReason: 'rebase_conflict',
      attentionMessage: 'Resolve the retained conflict.'
    })

    await expect(coordinator.reconcileExecutionLink(prepared.runId)).resolves.toEqual(retained)
    await expect(store.get(prepared.runId)).resolves.toEqual(retained)
  })
})
