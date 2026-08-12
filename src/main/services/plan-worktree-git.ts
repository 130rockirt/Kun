import { access, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  PlanWorktreeAttentionReason,
  PlanWorktreeChangedFile,
  PlanWorktreeChangedFileManifest,
  PlanWorktreePreflightRequest,
  PlanWorktreePreflightResult
} from '../../shared/plan-worktree'
import { runGit } from './git-service'

const GIT_OPERATION_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-apply',
  'rebase-merge'
] as const

export type PlanWorktreeGitAnchors = {
  sourceWorkspaceRoot: string
  sourceCheckoutRoot: string
  primaryRepositoryRoot: string
  repositoryIdentity: string
  targetBranch: string
  baseCommit: string
  sourceIsLinkedWorktree: boolean
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function failure(
  request: PlanWorktreePreflightRequest,
  attentionReason: PlanWorktreeAttentionReason,
  message: string,
  partial: Partial<PlanWorktreeGitAnchors> = {}
): PlanWorktreePreflightResult {
  return {
    eligible: false,
    attentionReason,
    message,
    sourceWorkspaceRoot: request.workspaceRoot,
    sourceIsLinkedWorktree: partial.sourceIsLinkedWorktree ?? false,
    checkedAt: nowIso(),
    ...partial
  }
}

function classifyGitFailure(error: unknown): PlanWorktreeAttentionReason {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT|spawn git/i.test(message)) return 'git_unavailable'
  if (/not a git repository/i.test(message)) return 'not_git_repository'
  return 'external_state_changed'
}

async function canonical(path: string): Promise<string> {
  return normalize(await realpath(path).catch(() => resolve(path)))
}

async function gitPath(cwd: string, marker: string): Promise<string> {
  const raw = (await runGit(cwd, ['rev-parse', '--git-path', marker])).stdout.trim()
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

export async function hasGitOperationInProgress(cwd: string): Promise<boolean> {
  for (const marker of GIT_OPERATION_MARKERS) {
    if (await pathExists(await gitPath(cwd, marker))) return true
  }
  return false
}

async function primaryWorktreeRoot(cwd: string, fallback: string): Promise<string> {
  const stdout = (await runGit(cwd, ['worktree', 'list', '--porcelain'])).stdout
  const first = stdout.split(/\r?\n/).find((line) => line.startsWith('worktree '))
  return canonical(first?.slice('worktree '.length).trim() || fallback)
}

async function validateBranchPrefix(cwd: string, prefix: string | undefined): Promise<boolean> {
  const normalizedPrefix = normalizeExecutionBranchPrefix(prefix)
  try {
    await runGit(cwd, ['check-ref-format', '--branch', `${normalizedPrefix}plan-probe`])
    return true
  } catch {
    return false
  }
}

export function normalizeExecutionBranchPrefix(prefix: string | undefined): string {
  const trimmed = prefix?.trim() || 'codex/'
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export function sanitizePlanSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'plan'
}

export function buildExecutionBranch(
  prefix: string | undefined,
  planTitle: string,
  runId: string
): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase()
    || randomBytes(5).toString('hex')
  return `${normalizeExecutionBranchPrefix(prefix)}${sanitizePlanSlug(planTitle)}-${suffix}`
}

export function managedPlanWorktreePath(
  runId: string,
  repositoryRoot: string,
  managedRoot = join(homedir(), '.kun', 'worktrees')
): string {
  return join(managedRoot, runId, basename(repositoryRoot) || 'repository')
}

export async function preflightPlanWorktree(
  request: PlanWorktreePreflightRequest
): Promise<PlanWorktreePreflightResult> {
  const requestedWorkspaceRoot = normalize(request.workspaceRoot)
  try {
    const sourceWorkspaceRoot = await canonical(requestedWorkspaceRoot)
    const sourceCheckoutRoot = await canonical(
      (await runGit(sourceWorkspaceRoot, ['rev-parse', '--show-toplevel'])).stdout.trim()
    )
    const primaryRepositoryRoot = await primaryWorktreeRoot(sourceCheckoutRoot, sourceCheckoutRoot)
    const commonDirRaw = (await runGit(sourceCheckoutRoot, ['rev-parse', '--git-common-dir'])).stdout.trim()
    const repositoryIdentity = await canonical(
      isAbsolute(commonDirRaw) ? commonDirRaw : resolve(sourceCheckoutRoot, commonDirRaw)
    )
    const partial = {
      sourceWorkspaceRoot,
      sourceCheckoutRoot,
      primaryRepositoryRoot,
      repositoryIdentity,
      sourceIsLinkedWorktree: sourceCheckoutRoot !== primaryRepositoryRoot
    }
    let baseCommit = ''
    try {
      baseCommit = (await runGit(sourceCheckoutRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    } catch {
      return failure(request, 'unborn_head', 'The source checkout has no commit yet.', partial)
    }
    let targetBranch = ''
    try {
      targetBranch = (await runGit(
        sourceCheckoutRoot,
        ['symbolic-ref', '--quiet', '--short', 'HEAD']
      )).stdout.trim()
    } catch {
      return failure(request, 'detached_head', 'The source checkout is in detached HEAD state.', {
        ...partial,
        baseCommit
      })
    }
    const anchors = { ...partial, targetBranch, baseCommit }
    if (await hasGitOperationInProgress(sourceCheckoutRoot)) {
      return failure(
        request,
        'source_git_operation_in_progress',
        'Finish the current Git merge, rebase, cherry-pick, or revert before starting.',
        anchors
      )
    }
    if (!(await validateBranchPrefix(sourceCheckoutRoot, request.branchPrefix))) {
      return failure(request, 'invalid_branch_prefix', 'The configured Git branch prefix is invalid.', anchors)
    }
    return {
      eligible: true,
      ...anchors,
      checkedAt: nowIso()
    }
  } catch (error) {
    return failure(
      request,
      classifyGitFailure(error),
      error instanceof Error ? error.message : String(error),
      { sourceWorkspaceRoot: requestedWorkspaceRoot }
    )
  }
}

function statusKind(code: string): PlanWorktreeChangedFile['status'] {
  if (code === '??' || code.includes('A')) return code === '??' ? 'untracked' : 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  return 'modified'
}

export async function readChangedFileManifest(
  worktreePath: string
): Promise<PlanWorktreeChangedFileManifest> {
  const raw = (await runGit(worktreePath, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all'
  ], 30_000, 32 * 1024 * 1024)).stdout
  const entries = raw.split('\0')
  const files: PlanWorktreeChangedFile[] = []
  let totalFiles = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    totalFiles += 1
    if (code.includes('R') || code.includes('C')) {
      const oldPath = entries[index + 1]
      if (oldPath) index += 1
      if (files.length < 20_000) {
        files.push({ path, status: 'renamed', ...(oldPath ? { oldPath } : {}) })
      }
    } else {
      if (files.length < 20_000) files.push({ path, status: statusKind(code) })
    }
  }
  return {
    capturedAt: nowIso(),
    files,
    hasUncommittedChanges: raw.length > 0,
    ...(totalFiles > files.length ? { truncated: true } : {})
  }
}

export async function ensureManagedWorktreeParent(worktreePath: string): Promise<void> {
  await mkdir(resolve(worktreePath, '..'), { recursive: true })
}
