import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlanWorktreeRunRecord } from '../../shared/plan-worktree'
import { PlanWorktreeLockManager, PlanWorktreeRunStore } from './plan-worktree-run-store'

const roots: string[] = []
const now = '2026-08-12T12:00:00.000Z'

function record(runId = 'run-1'): PlanWorktreeRunRecord {
  return {
    version: 1,
    runId,
    operationId: `operation-${runId}`,
    planId: 'plan-1',
    planRelativePath: '.kunsdd/plan/auth.md',
    planTitle: 'Auth',
    goalObjective: 'Implement and validate Auth',
    sourceThreadId: 'thread-source',
    orchestration: 'direct',
    sourceWorkspaceRoot: '/repo',
    sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo',
    repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/auth',
    baseCommit: 'a'.repeat(40),
    executionBranch: `codex/${runId}`,
    worktreePath: `/tmp/${runId}`,
    status: 'preparing',
    cleanup: {
      threadRebound: false,
      worktreeRemoved: false,
      branchDeleted: false,
      metadataPruned: false
    },
    createdAt: now,
    updatedAt: now
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PlanWorktreeRunStore', () => {
  it('serializes operations sharing a lock key without blocking other runs', async () => {
    const locks = new PlanWorktreeLockManager()
    const order: string[] = []
    let releaseFirst!: () => void
    let enteredFirst!: () => void
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve })
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = locks.withLock('run:one', async () => {
      order.push('first-enter')
      enteredFirst()
      await blocked
      order.push('first-exit')
    })
    await entered
    const second = locks.withLock('run:one', async () => { order.push('second') })
    await locks.withLock('run:two', async () => { order.push('other') })
    expect(order).toEqual(['first-enter', 'other'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-enter', 'other', 'first-exit', 'second'])
  })

  it('writes records atomically and retrieves an idempotency operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-store-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    await store.save(record())

    expect(await store.get('run-1')).toEqual(record())
    expect((await store.findByOperationId('operation-run-1'))?.runId).toBe('run-1')
    expect((await readdir(store.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('isolates corrupt records without rewriting or deleting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-corrupt-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    await store.save(record('valid'))
    const corruptPath = join(store.directory, 'corrupt.json')
    await writeFile(corruptPath, '{not-json', 'utf8')

    const scan = await store.scan()
    expect(scan.records.map((item) => item.runId)).toEqual(['valid'])
    expect(scan.unreadable).toEqual([
      expect.objectContaining({ fileName: 'corrupt.json' })
    ])
    expect(await store.list()).toEqual([expect.objectContaining({ runId: 'valid' })])
    expect(await store.diagnostics()).toEqual([
      expect.objectContaining({ fileName: 'corrupt.json' })
    ])
    expect(await readFile(corruptPath, 'utf8')).toBe('{not-json')
  })

  it('recovers a corrupted primary from the last valid atomic backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-backup-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    const original = record('recoverable')
    await store.save(original)
    await store.save({ ...original, status: 'executing' })
    await writeFile(join(store.directory, 'recoverable.json'), '{not-json', 'utf8')

    expect(await store.get('recoverable')).toEqual(original)
    expect((await store.scan()).unreadable).toEqual([])
    expect(await store.list()).toEqual([original])
  })

  it('blocks only the operation and plan scope owned by an unreadable record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-scoped-corrupt-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    const broken = record('broken-scope')
    await store.save(broken)
    await writeFile(join(store.directory, 'broken-scope.json'), '{not-json', 'utf8')
    await writeFile(join(store.directory, 'broken-scope.backup.json'), '{not-json', 'utf8')

    await expect(store.findByOperationId(broken.operationId))
      .rejects.toMatchObject({ reason: 'record_unreadable' })
    expect(await store.findByOperationId('unrelated-operation')).toBeNull()
    await expect(store.assertNoUnreadableScope({
      planId: broken.planId,
      sourceThreadId: broken.sourceThreadId,
      sourceCheckoutRoot: broken.sourceCheckoutRoot,
      repositoryIdentity: broken.repositoryIdentity
    })).rejects.toMatchObject({ reason: 'record_unreadable' })
    await expect(store.assertNoUnreadableScope({
      planId: 'another-plan',
      sourceThreadId: broken.sourceThreadId,
      sourceCheckoutRoot: broken.sourceCheckoutRoot,
      repositoryIdentity: broken.repositoryIdentity
    })).resolves.toBeUndefined()
  })

  it('reads the first-save backup when the primary record disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-missing-primary-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    const original = record('missing-primary')
    await store.save(original)
    await rm(join(store.directory, 'missing-primary.json'))

    expect(await store.get('missing-primary')).toEqual(original)
    expect(await store.list()).toEqual([original])
  })

  it('rejects ids that could escape the store directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-plan-worktree-path-'))
    roots.push(root)
    const store = new PlanWorktreeRunStore(root)
    await expect(store.get('../outside')).rejects.toThrow()
  })
})
