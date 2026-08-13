import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import { runGit } from './git-service'
import { hasGitOperationInProgress, pathExists } from './plan-worktree-git'

export async function validateManagedWorktreeIdentity(
  record: PlanWorktreeRunRecord,
  managedRoot: string
): Promise<string | null> {
  const candidate = resolve(record.worktreePath)
  const root = resolve(managedRoot)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    return 'The recorded worktree path is outside the managed plan-worktree root.'
  }
  const sourceIdentity = await repositoryIdentity(record.sourceCheckoutRoot).catch(() => '')
  const recordedIdentity = await realpath(record.repositoryIdentity).catch(() => '')
  if (!sourceIdentity || !recordedIdentity || sourceIdentity !== recordedIdentity) {
    return 'The captured source checkout no longer belongs to the recorded repository.'
  }
  if (!(await pathExists(candidate))) return null
  const [physicalRoot, physicalCandidate] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(candidate).catch(() => '')
  ])
  if (!physicalCandidate || physicalCandidate === physicalRoot
    || !physicalCandidate.startsWith(`${physicalRoot}${sep}`)) {
    return 'The managed worktree path resolves outside its authorized root.'
  }
  const checkoutRoot = await realpath((await runGit(
    physicalCandidate,
    ['rev-parse', '--show-toplevel']
  )).stdout.trim()).catch(() => '')
  if (checkoutRoot !== physicalCandidate) {
    return 'The managed path is no longer the recorded Git worktree root.'
  }
  if (await repositoryIdentity(physicalCandidate).catch(() => '') !== recordedIdentity) {
    return 'The managed worktree was replaced by a different Git repository.'
  }
  const branch = (await runGit(
    physicalCandidate,
    ['symbolic-ref', '--quiet', '--short', 'HEAD']
  ).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim()
  if (branch !== record.executionBranch) {
    return 'The managed worktree no longer has its recorded execution branch checked out.'
  }
  const head = (await runGit(physicalCandidate, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  try {
    await runGit(physicalCandidate, ['merge-base', '--is-ancestor', record.baseCommit, head])
  } catch {
    return 'The execution branch no longer descends from the captured base commit.'
  }
  const worktreeRows = parseWorktreeRows((await runGit(
    record.sourceCheckoutRoot,
    ['worktree', 'list', '--porcelain']
  )).stdout)
  const rowsWithPhysicalPaths = await Promise.all(worktreeRows.map(async (entry) => ({
    ...entry,
    physicalPath: await realpath(entry.path).catch(() => resolve(entry.path))
  })))
  const row = rowsWithPhysicalPaths.find((entry) => entry.physicalPath === physicalCandidate)
  if (!row || row.branch !== record.executionBranch || row.head !== head) {
    return 'Git worktree metadata no longer matches the durable run identity.'
  }
  return null
}

export async function validateSourceRepositoryIdentity(
  record: PlanWorktreeRunRecord
): Promise<string | null> {
  const sourceRoot = await realpath(record.sourceCheckoutRoot).catch(() => '')
  if (!sourceRoot) return 'The captured source checkout physical path changed.'
  const topLevel = await realpath((await runGit(
    sourceRoot,
    ['rev-parse', '--show-toplevel']
  )).stdout.trim()).catch(() => '')
  if (topLevel !== sourceRoot) return 'The captured source path is no longer its Git checkout root.'
  const recordedIdentity = await realpath(record.repositoryIdentity).catch(() => '')
  if (!recordedIdentity || await repositoryIdentity(sourceRoot).catch(() => '') !== recordedIdentity) {
    return 'The captured source checkout repository identity changed.'
  }
  return null
}

export async function validateExecutionBranchDeletion(
  record: PlanWorktreeRunRecord
): Promise<string | null> {
  const ref = `refs/heads/${record.executionBranch}`
  let actual: string
  try {
    actual = (await runGit(record.sourceCheckoutRoot, ['rev-parse', '--verify', ref])).stdout.trim()
  } catch {
    return null
  }
  const expected = record.recoverySnapshot?.head ?? record.executionHead ?? record.baseCommit
  if (actual !== expected) {
    return 'The execution branch was replaced or advanced after its cleanup snapshot.'
  }
  const worktrees = (await runGit(
    record.sourceCheckoutRoot,
    ['worktree', 'list', '--porcelain']
  )).stdout
  if (worktrees.split(/\r?\n/).some((line) => line === `branch ${ref}`)) {
    return 'The execution branch is still owned by a Git worktree.'
  }
  return null
}

export async function deleteExecutionBranchAtomically(
  record: PlanWorktreeRunRecord
): Promise<string | null> {
  const ref = `refs/heads/${record.executionBranch}`
  const expected = record.recoverySnapshot?.head ?? record.executionHead ?? record.baseCommit
  try {
    await runGit(record.sourceCheckoutRoot, ['update-ref', '-d', ref, expected])
  } catch {
    return 'The execution branch changed before its atomic cleanup delete.'
  }
  try {
    await runGit(record.sourceCheckoutRoot, ['show-ref', '--verify', '--quiet', ref])
    return 'The execution branch still exists after its atomic cleanup delete.'
  } catch {
    return null
  }
}

export async function validateSourceCheckoutForIntegration(
  record: PlanWorktreeRunRecord,
  expectedTargetHead: string
): Promise<{ reason: PlanWorktreeAttentionReason; message: string } | null> {
  if (!(await pathExists(record.sourceCheckoutRoot))) {
    return { reason: 'source_checkout_missing', message: 'The captured source checkout no longer exists.' }
  }
  const identityFailure = await validateSourceRepositoryIdentity(record).catch(messageOf)
  if (identityFailure) return { reason: 'external_state_changed', message: identityFailure }
  const branch = (await runGit(
    record.sourceCheckoutRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD']
  ).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim()
  if (branch !== record.targetBranch) {
    return {
      reason: 'source_branch_changed',
      message: `Restore the captured source branch ${record.targetBranch} before retrying.`
    }
  }
  if (await hasGitOperationInProgress(record.sourceCheckoutRoot)) {
    return { reason: 'source_checkout_dirty', message: 'The source checkout has a Git operation in progress.' }
  }
  const status = (await runGit(
    record.sourceCheckoutRoot,
    ['status', '--porcelain=v1', '--untracked-files=all']
  )).stdout
  if (status.trim()) {
    return { reason: 'source_checkout_dirty', message: 'The source checkout is no longer clean.' }
  }
  const sourceHead = (await runGit(
    record.sourceCheckoutRoot,
    ['rev-parse', '--verify', 'HEAD']
  )).stdout.trim()
  return sourceHead === expectedTargetHead ? null : {
    reason: 'target_moved_during_integration',
    message: 'The target branch moved while integration was being prepared.'
  }
}

async function repositoryIdentity(cwd: string): Promise<string> {
  const raw = (await runGit(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()
  return realpath(isAbsolute(raw) ? raw : resolve(cwd, raw))
}

function parseWorktreeRows(raw: string): Array<{ path: string; branch?: string; head?: string }> {
  const rows: Array<{ path: string; branch?: string; head?: string }> = []
  let current: { path: string; branch?: string; head?: string } | null = null
  const flush = (): void => {
    if (current) rows.push(current)
    current = null
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) flush()
    else if (line.startsWith('worktree ')) {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
