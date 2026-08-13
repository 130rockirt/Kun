import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from './git-service'
import {
  buildExecutionBranch,
  preflightPlanWorktree,
  readChangedFileManifest,
  sanitizePlanSlug
} from './plan-worktree-git'

const roots: string[] = []

async function sandbox(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kun-plan-worktree-${name}-`))
  roots.push(root)
  return root
}

async function initRepository(name: string): Promise<string> {
  const root = await sandbox(name)
  await runGit(root, ['init', '-b', 'feature/source'])
  await writeFile(join(root, 'README.md'), '# test\n', 'utf8')
  await runGit(root, ['add', 'README.md'])
  await runGit(root, [
    '-c', 'user.name=Kun Test',
    '-c', 'user.email=kun@example.invalid',
    'commit', '-m', 'initial'
  ])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plan worktree Git preflight', () => {
  it('captures the exact clean branch and commit', async () => {
    const root = await initRepository('clean')
    const result = await preflightPlanWorktree({ workspaceRoot: join(root, 'nested') })

    // Git does not walk from a missing cwd, so create a real nested workspace.
    expect(result.eligible).toBe(false)
    await mkdir(join(root, 'nested'))
    const nested = await preflightPlanWorktree({ workspaceRoot: join(root, 'nested') })
    const canonicalRoot = await realpath(root)
    expect(nested).toMatchObject({
      eligible: true,
      sourceCheckoutRoot: canonicalRoot,
      primaryRepositoryRoot: canonicalRoot,
      targetBranch: 'feature/source',
      sourceIsLinkedWorktree: false
    })
    expect(nested.baseCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('supports a linked source worktree without substituting the primary checkout', async () => {
    const root = await initRepository('linked')
    const linked = await sandbox('linked-checkout')
    await rm(linked, { recursive: true, force: true })
    await runGit(root, ['worktree', 'add', '-b', 'feature/linked', linked, 'HEAD'])

    const result = await preflightPlanWorktree({ workspaceRoot: linked })
    expect(result).toMatchObject({
      eligible: true,
      sourceCheckoutRoot: await realpath(linked),
      primaryRepositoryRoot: await realpath(root),
      targetBranch: 'feature/linked',
      sourceIsLinkedWorktree: true
    })
  })

  it('rejects dirty, detached, unborn, invalid-prefix, and in-progress sources', async () => {
    const dirty = await initRepository('dirty')
    await writeFile(join(dirty, 'new.txt'), 'dirty', 'utf8')
    expect((await preflightPlanWorktree({ workspaceRoot: dirty })).attentionReason)
      .toBe('dirty_source_checkout')

    const detached = await initRepository('detached')
    await runGit(detached, ['checkout', '--detach'])
    expect((await preflightPlanWorktree({ workspaceRoot: detached })).attentionReason)
      .toBe('detached_head')

    const unborn = await sandbox('unborn')
    await runGit(unborn, ['init', '-b', 'feature/empty'])
    expect((await preflightPlanWorktree({ workspaceRoot: unborn })).attentionReason)
      .toBe('unborn_head')

    const invalidPrefix = await initRepository('prefix')
    expect((await preflightPlanWorktree({
      workspaceRoot: invalidPrefix,
      branchPrefix: 'bad..prefix/'
    })).attentionReason).toBe('invalid_branch_prefix')

    const operation = await initRepository('operation')
    const markerRaw = (await runGit(operation, ['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim()
    const marker = isAbsolute(markerRaw) ? markerRaw : resolve(operation, markerRaw)
    await mkdir(dirname(marker), { recursive: true })
    await writeFile(marker, 'a'.repeat(40), 'utf8')
    expect((await preflightPlanWorktree({ workspaceRoot: operation })).attentionReason)
      .toBe('source_git_operation_in_progress')
  })

  it('builds bounded branches and reads a non-ignored change manifest', async () => {
    expect(sanitizePlanSlug('  支付 Flow / v2 ')).toBe('flow-v2')
    expect(buildExecutionBranch('codex/', 'Auth & Billing', 'run-1234567890'))
      .toBe('codex/auth-billing-1234567890')

    const root = await initRepository('manifest')
    await writeFile(join(root, 'README.md'), '# changed\n', 'utf8')
    await writeFile(join(root, 'new.txt'), 'new\n', 'utf8')
    const manifest = await readChangedFileManifest(root)
    expect(manifest.hasUncommittedChanges).toBe(true)
    expect(manifest.files).toEqual(expect.arrayContaining([
      { path: 'README.md', status: 'modified' },
      { path: 'new.txt', status: 'untracked' }
    ]))
  })
})
