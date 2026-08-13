import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../../../kun/src/adapters/file/atomic-write.js'
import type {
  PlanWorktreeRecoverySnapshot,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import { pathExists } from './plan-worktree-git'

export type PlanWorktreeRecoveryCapture = {
  path: string
  snapshot: PlanWorktreeRecoverySnapshot
}

export type PlanWorktreeRecoveryCaptureHooks = {
  afterIndexSnapshot?: () => Promise<void>
  afterPatchSnapshot?: () => Promise<void>
}

export async function capturePlanWorktreeRecovery(
  record: PlanWorktreeRunRecord,
  recoveryRoot: string,
  capturedAt: string,
  hooks: PlanWorktreeRecoveryCaptureHooks = {}
): Promise<PlanWorktreeRecoveryCapture> {
  await mkdir(recoveryRoot, { recursive: true })
  const worktreePresent = await pathExists(record.worktreePath)
  let patch: string
  let state: Omit<PlanWorktreeRecoverySnapshot, 'patchSha256' | 'capturedAt'>
  if (worktreePresent) {
    const capture = await captureStableWorktree(record, hooks)
    patch = capture.patch
    state = capture.state
  } else {
    const ref = `refs/heads/${record.executionBranch}`
    const head = await readRefOr(record.sourceCheckoutRoot, ref, record.baseCommit)
    const indexTree = (await runGit(
      record.sourceCheckoutRoot,
      ['rev-parse', `${head}^{tree}`]
    )).stdout.trim()
    patch = head === record.baseCommit
      ? ''
      : (await runGit(record.sourceCheckoutRoot, [
          'diff', '--binary', record.baseCommit, head
        ], 60_000, 64 * 1024 * 1024)).stdout
    state = { head, indexTree, statusSha256: sha256('') }
  }
  const path = join(recoveryRoot, `${record.runId}.patch`)
  const snapshot = {
    ...state,
    patchSha256: sha256(patch),
    capturedAt
  }
  await atomicWriteFile(path, patch)
  return { path, snapshot }
}

async function captureStableWorktree(
  record: PlanWorktreeRunRecord,
  hooks: PlanWorktreeRecoveryCaptureHooks
): Promise<{
  patch: string
  state: Omit<PlanWorktreeRecoverySnapshot, 'patchSha256' | 'capturedAt'>
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runGit(record.worktreePath, ['add', '--all'])
    const headBefore = await revParse(record.worktreePath, 'HEAD')
    const treeBefore = await writeTree(record.worktreePath)
    await hooks.afterIndexSnapshot?.()
    const patch = (await runGit(record.worktreePath, [
      'diff', '--cached', '--binary', record.baseCommit
    ], 60_000, 64 * 1024 * 1024)).stdout
    await hooks.afterPatchSnapshot?.()
    const treeAfterPatch = await writeTree(record.worktreePath)
    const status = (await runGit(
      record.worktreePath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all']
    )).stdout
    const treeAfterStatus = await writeTree(record.worktreePath)
    const headAfter = await revParse(record.worktreePath, 'HEAD')
    const hasUntracked = (await runGit(record.worktreePath, [
      'ls-files', '--others', '--exclude-standard', '-z'
    ])).stdout.length > 0
    let hasUnstaged = false
    try {
      await runGit(record.worktreePath, ['diff', '--quiet'])
    } catch {
      hasUnstaged = true
    }
    if (headBefore === headAfter
      && treeBefore === treeAfterPatch
      && treeAfterPatch === treeAfterStatus
      && !hasUntracked
      && !hasUnstaged) {
      return {
        patch,
        state: {
          head: headAfter,
          indexTree: treeAfterStatus,
          statusSha256: sha256(status)
        }
      }
    }
  }
  throw new Error('The worktree changed while its recovery patch was being captured.')
}

export async function recoverySnapshotStillMatches(
  record: PlanWorktreeRunRecord
): Promise<boolean> {
  if (!record.recoverySnapshot || !record.recoveryPatchPath) return false
  const patch = await readFile(record.recoveryPatchPath, 'utf8').catch(() => null)
  if (patch === null || sha256(patch) !== record.recoverySnapshot.patchSha256) return false
  if (!(await pathExists(record.worktreePath))) {
    const head = await readRefOr(
      record.sourceCheckoutRoot,
      `refs/heads/${record.executionBranch}`,
      record.baseCommit
    )
    const indexTree = (await runGit(
      record.sourceCheckoutRoot,
      ['rev-parse', `${head}^{tree}`]
    )).stdout.trim()
    return sameSnapshot(record.recoverySnapshot, {
      head,
      indexTree,
      statusSha256: sha256('')
    })
  }
  return sameSnapshot(record.recoverySnapshot, await readWorktreeSnapshot(record.worktreePath))
}

async function readWorktreeSnapshot(
  cwd: string
): Promise<Omit<PlanWorktreeRecoverySnapshot, 'patchSha256' | 'capturedAt'>> {
  const [head, indexTree, status] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', 'HEAD']).then((result) => result.stdout.trim()),
    runGit(cwd, ['write-tree']).then((result) => result.stdout.trim()),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      .then((result) => result.stdout)
  ])
  return { head, indexTree, statusSha256: sha256(status) }
}

async function revParse(cwd: string, ref: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', ref])).stdout.trim()
}

async function writeTree(cwd: string): Promise<string> {
  return (await runGit(cwd, ['write-tree'])).stdout.trim()
}

async function readRefOr(cwd: string, ref: string, fallback: string): Promise<string> {
  try {
    return (await runGit(cwd, ['rev-parse', '--verify', ref])).stdout.trim()
  } catch {
    return fallback
  }
}

function sameSnapshot(
  expected: PlanWorktreeRecoverySnapshot,
  actual: Omit<PlanWorktreeRecoverySnapshot, 'patchSha256' | 'capturedAt'>
): boolean {
  return expected.head === actual.head
    && expected.indexTree === actual.indexTree
    && expected.statusSha256 === actual.statusSha256
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
