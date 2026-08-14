import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGit, resolveGitCwd } from './git-service'
import {
  createCheckpointManifestV1,
  type GitCheckpointManifestV1,
  validateCheckpointRestoreContext
} from './git-checkpoint-manifest'
import type {
  GitCheckpointCreateResult,
  GitCheckpointRestoreResult
} from '../../shared/git-checkpoint'

export type GitCheckpointMetadata = {
  checkpointId: string
  threadId: string
  repositoryRoot: string
  workspaceRoot?: string
  /** `null` when the repository had no commit at checkpoint time. */
  head: string | null
  checkpointRef?: string | null
  currentBranch: string | null
  createdAt: string
  untrackedFiles: string[]
  /** Untracked files deliberately NOT snapshotted (too large / over budget). */
  skippedUntracked?: string[]
  /**
   * Whether the snapshot captured every untracked file. `partial` means some
   * untracked files were skipped (see `skippedUntracked`); restoring a partial
   * checkpoint can destroy those never-captured files, so restore refuses a
   * partial checkpoint unless the caller explicitly opts in.
   */
  completeness?: 'complete' | 'partial'
}

/**
 * Snapshot policy that bounds checkpoint disk usage (issue #651). Untracked
 * files are physically copied, so a workspace full of large untracked artifacts
 * (AI models, node_modules, build output) could balloon the checkpoint store by
 * gigabytes per message. These caps + the per-thread retention limit stop that.
 */
export type GitCheckpointStorageOptions = {
  /** Override the checkpoints root (e.g. point it at another drive). */
  checkpointsRoot?: string
  /** Skip snapshotting any single untracked file larger than this. Default 5 MiB. */
  maxUntrackedFileBytes?: number
  /** Stop snapshotting untracked files once this cumulative size is reached. Default 50 MiB. */
  maxUntrackedTotalBytes?: number
  /** Keep at most this many checkpoints per thread (newest first). Default 5. */
  maxPerThread?: number
  /** Hard cap on total checkpoint bytes across threads. Default 2 GiB (issue #1156). */
  maxTotalBytes?: number
  /** Skip creation when the checkpoint disk has less free space. Default 1 GiB (issue #1156). */
  minFreeDiskBytes?: number
}

export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 5 * 1_024 * 1_024

export const DEFAULT_MAX_UNTRACKED_TOTAL_BYTES = 50 * 1_024 * 1_024

export const DEFAULT_MAX_CHECKPOINTS_PER_THREAD = 5

export type GitCheckpointCleanupResult = {
  scanned: number
  kept: number
  deleted: number
  failed: number
  deletedIds: string[]
  failedIds: string[]
}

export type GitCheckpointCleanupDueResult =
  | { due: false, lastRunAt: string | null }
  | { due: true, lastRunAt: string, result: GitCheckpointCleanupResult }

export type GitCheckpointCleanupState = {
  lastRunAt?: string
  /** App version that last completed a cleanup pass (forces a run after upgrades). */
  lastAppVersion?: string
}

export const DAY_MS = 24 * 60 * 60 * 1_000

export const CHECKPOINT_CLEANUP_STATE_FILE = '.cleanup.json'

export const CHECKPOINT_REFERENCE_FILE_EXTENSIONS = new Set(['.json', '.jsonl'])

export const CHECKPOINT_GATE_DIRECTORY = 'git-checkpoint-gates'

export const DEFERRED_RETENTION_DELAY_MS = 30_000

export const deferredRetentionTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function checkpointFailure(error: unknown): Extract<GitCheckpointCreateResult, { ok: false }> {
  const message = error instanceof Error ? error.message : String(error)
  if (/not a git repository/i.test(message)) {
    return { ok: false, reason: 'not_git_repo', message: 'The working directory is not a Git repository.' }
  }
  if (/ENOENT/i.test(message) || /spawn git/i.test(message)) {
    return { ok: false, reason: 'git_unavailable', message: 'Git executable was not found.' }
  }
  return { ok: false, reason: 'error', message }
}

export function restoreFailure(error: unknown): Extract<GitCheckpointRestoreResult, { ok: false }> {
  const failure = checkpointFailure(error)
  return { ...failure, reason: failure.reason }
}

/**
 * Resolve the checkpoints root directory. A user-configured absolute path (e.g.
 * on another drive with more free space) takes precedence; otherwise the
 * default lives under the Kun data dir. Relative configured paths are resolved
 * against the data dir so a stray relative value can't escape unexpectedly.
 */
export function resolveCheckpointsRoot(dataDir: string, configured?: string): string {
  const trimmed = configured?.trim()
  if (trimmed) {
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(dataDir, trimmed)
  }
  return join(resolve(dataDir), 'git-checkpoints')
}

export function checkpointDir(root: string, checkpointId: string): string {
  return join(root, checkpointId)
}

export function checkpointRootDir(root: string): string {
  return root
}

export function checkpointCleanupStatePath(root: string): string {
  return join(root, CHECKPOINT_CLEANUP_STATE_FILE)
}

export function checkpointHeadBundlePath(root: string, checkpointId: string): string {
  return join(checkpointDir(root, checkpointId), 'head.bundle')
}

export function metadataPath(root: string, checkpointId: string): string {
  return join(checkpointDir(root, checkpointId), 'metadata.json')
}

export function manifestPath(root: string, checkpointId: string): string {
  return join(checkpointDir(root, checkpointId), 'manifest.json')
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function splitNul(stdout: string): string[] {
  return stdout.split('\0').map((entry) => entry.trim()).filter(Boolean)
}

export async function assertNoUnmerged(repositoryRoot: string): Promise<void> {
  const { stdout } = await runGit(repositoryRoot, ['diff', '--name-only', '--diff-filter=U'])
  const conflicted = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (conflicted.length > 0) {
    throw new Error(`Cannot create or restore a checkpoint while ${conflicted.length} files have merge conflicts.`)
  }
}

export async function readMetadata(root: string, checkpointId: string): Promise<GitCheckpointMetadata | null> {
  try {
    const raw = await readFile(metadataPath(root, checkpointId), 'utf-8')
    return JSON.parse(raw) as GitCheckpointMetadata
  } catch {
    return null
  }
}

export async function readManifest(root: string, checkpointId: string): Promise<GitCheckpointManifestV1 | null> {
  try {
    const raw = await readFile(manifestPath(root, checkpointId), 'utf-8')
    return JSON.parse(raw) as GitCheckpointManifestV1
  } catch {
    return null
  }
}

export async function resolveCheckpointManifest(
  root: string,
  metadata: GitCheckpointMetadata
): Promise<{ manifest: GitCheckpointManifestV1; hasWorkspaceIdentity: boolean }> {
  const manifest = await readManifest(root, metadata.checkpointId)
  if (manifest) {
    return { manifest, hasWorkspaceIdentity: true }
  }
  return {
    manifest: await createCheckpointManifestV1({
      metadata,
      ...(metadata.workspaceRoot?.trim() ? { workspaceRoot: metadata.workspaceRoot } : {})
    }),
    hasWorkspaceIdentity: Boolean(metadata.workspaceRoot?.trim())
  }
}

export async function writePatch(repositoryRoot: string, args: string[], path: string): Promise<void> {
  const { stdout } = await runGit(repositoryRoot, args, 30_000)
  await writeFile(path, stdout, 'utf-8')
}

export async function applyPatchIfPresent(repositoryRoot: string, path: string, cached: boolean): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info || info.size === 0) return
  await runGit(repositoryRoot, ['apply', '--binary', ...(cached ? ['--index'] : []), path], 30_000)
}

export async function commitExists(repositoryRoot: string, rev: string): Promise<boolean> {
  if (!rev.trim()) return false
  try {
    await runGit(repositoryRoot, ['cat-file', '-e', `${rev}^{commit}`])
    return true
  } catch {
    return false
  }
}

export async function writeHeadBundle(repositoryRoot: string, path: string): Promise<void> {
  await runGit(repositoryRoot, ['bundle', 'create', path, 'HEAD'], 30_000)
}

export async function resolveHead(repositoryRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const head = stdout.trim()
    return head || null
  } catch (error) {
    // `git init` creates an unborn branch: it is a valid repository, but
    // `HEAD` does not resolve to a commit until the first commit is made.
    const exitCode = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (exitCode === 1) return null
    throw error
  }
}

export async function resolveCheckpointTarget(
  repositoryRoot: string,
  root: string,
  metadata: GitCheckpointMetadata
): Promise<string> {
  const head = metadata.head?.trim() ?? ''
  if (await commitExists(repositoryRoot, head)) return head

  const bundlePath = checkpointHeadBundlePath(root, metadata.checkpointId)
  if (await fileExists(bundlePath)) {
    await runGit(repositoryRoot, ['bundle', 'unbundle', bundlePath], 30_000)
    if (await commitExists(repositoryRoot, head)) return head
  }

  const legacyRef = metadata.checkpointRef?.trim() ?? ''
  if (await commitExists(repositoryRoot, legacyRef)) return legacyRef

  throw new Error(`Git checkpoint target commit is unavailable: ${head || metadata.checkpointId}`)
}

export async function resolveRepositoryRoot(workspaceRoot: string): Promise<string | null> {
  const cwd = await resolveGitCwd(workspaceRoot)
  if (!cwd) return null
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return stdout.trim()
}

export async function restoreUnbornCheckpoint(repositoryRoot: string, currentBranch: string | null): Promise<void> {
  // First make the worktree safe to switch. A rescue checkpoint has already
  // been written by the caller, so these destructive operations are
  // recoverable just like the normal committed-HEAD restore path.
  await runGit(repositoryRoot, ['reset', '--hard'], 30_000)
  await runGit(repositoryRoot, ['clean', '-fd'], 30_000)

  if (currentBranch) {
    // An unborn branch has no ref. Remove any branch created after the
    // checkpoint, then recreate the original branch with no history.
    await runGit(repositoryRoot, ['update-ref', '-d', `refs/heads/${currentBranch}`], 30_000)
    await runGit(repositoryRoot, ['checkout', '--orphan', currentBranch], 30_000)
  } else {
    // This is an unusual detached-unborn repository. Preserve the empty index
    // even though there is no branch name to reconstruct.
    await runGit(repositoryRoot, ['update-ref', '-d', 'HEAD'], 30_000)
  }

  // `checkout --orphan` keeps the previous worktree until the index is reset.
  // Empty the index first, then clean the now-untracked files so the stored
  // staged/unstaged patches and untracked snapshot can be applied below.
  await runGit(repositoryRoot, ['read-tree', '--empty'], 30_000)
  await runGit(repositoryRoot, ['clean', '-fd'], 30_000)
}

/**
 * Validates that `relativePath` (taken from checkpoint metadata, which is
 * persisted JSON and therefore untrusted) stays inside `repositoryRoot` when
 * joined to it. Defends the restore path against a tampered metadata.json that
 * smuggles `..` segments, absolute paths, or symlink-anchored escapes.
 *
 * Returns the canonical absolute target so callers reuse the same resolved
 * path for both the existence check and the copy, avoiding a second resolution
 * that could disagree with the validated one.
 *
 * Fail closed: if `repositoryRoot` cannot be canonicalized (missing, EACCES,
 * ELOOP, …) the check throws rather than letting an unchecked path through.
 */
export async function resolvePathWithinRepository(
  repositoryRoot: string,
  relativePath: string
): Promise<string> {
  // Reject empty / current / parent / absolute, plus null bytes and Windows
  // drive-relative forms ("C:file") that bypass isAbsolute().
  if (!relativePath || relativePath === '.' || relativePath === '..' || isAbsolute(relativePath)) {
    throw new Error(`invalid untracked path: ${relativePath}`)
  }
  if (relativePath.includes('\0') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`invalid untracked path: ${relativePath}`)
  }

  const repoReal = await realpath(repositoryRoot)
  const targetNormalized = normalize(join(repoReal, relativePath))
  // startsWith with a trailing separator prevents prefix attacks where
  // repoReal is a textual prefix of an unrelated dir (e.g. "/repo" vs
  // "/repo-evil"). Exact equality covers the (already-rejected) root case.
  if (targetNormalized !== repoReal && !targetNormalized.startsWith(repoReal + sep)) {
    throw new Error(`untracked path escapes the repository root: ${relativePath}`)
  }

  // The lexical check above is necessary but NOT sufficient: an in-repo
  // symlink (e.g. repo/link -> /outside) makes `link/payload.txt` lexically
  // contained while cp() follows the link and writes outside the repo. Resolve
  // the target via realpath to defeat any symlink on the path. The target may
  // not exist yet (cp creates it), so when the direct realpath fails with
  // ENOENT we canonicalize the nearest existing ancestor (the parent dir) and
  // re-join the remaining suffix, then re-assert containment on the resolved
  // pair. Any other realpath failure (EACCES/ELOOP/ENOTDIR/…) fails closed.
  const targetReal = await resolveSymlinkSafe(targetNormalized)
  if (targetReal !== repoReal && !targetReal.startsWith(repoReal + sep)) {
    throw new Error(`untracked path escapes the repository root: ${relativePath}`)
  }

  // Return the lexical target so downstream mkdir/cp operate on the path the
  // caller asked for; the escape check above already proved it cannot leave
  // the repository root through any symlink on the path.
  return targetNormalized
}

/**
 * Exported for tests. Validates an untracked-file relative path (from
 * persisted metadata) stays inside `repositoryRoot`, defeating `..`,
 * absolute, drive-relative, null-byte, AND in-repo-symlink escapes.
 */
export async function testResolvePathWithinRepository(
  repositoryRoot: string,
  relativePath: string
): Promise<string> {
  return resolvePathWithinRepository(repositoryRoot, relativePath)
}

/**
 * Canonicalizes `lexicalPath`, tolerating a not-yet-existing leaf (the
 * write/create case) by realpath-ing the nearest existing ancestor and
 * re-joining the non-existent suffix. Fail-closed on realpath errors other
 * than ENOENT. Mirrors the approach used by the workspace tool escape check.
 */
export async function resolveSymlinkSafe(lexicalPath: string): Promise<string> {
  const direct = await safeRealpath(lexicalPath)
  if (direct !== null) return direct
  const segments: string[] = []
  let current = lexicalPath
  let ancestor: string | null = null
  for (let i = 0; i < 128 && current !== dirname(current); i += 1) {
    const resolved = await safeRealpath(current)
    if (resolved !== null) {
      ancestor = resolved
      break
    }
    segments.unshift(basename(current))
    current = dirname(current)
  }
  if (ancestor === null) {
    throw new Error(`cannot canonicalize path (no existing ancestor): ${lexicalPath}`)
  }
  return segments.length > 0 ? normalize(join(ancestor, ...segments)) : ancestor
}

export async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ELOOP' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

/**
 * Lexical containment check used against an already-realpath'd base (the
 * checkpoint untracked dir, whose realpath may be a fallback when the dir is
 * absent). Shares the same rejection rules as {@link resolvePathWithinRepository}
 * so a traversal path cannot slip through on the source side.
 */
export function isValidWithinBase(relativePath: string, baseReal: string): boolean {
  if (!relativePath || relativePath === '.' || relativePath === '..' || isAbsolute(relativePath)) {
    return false
  }
  if (relativePath.includes('\0') || /^[a-zA-Z]:/.test(relativePath)) {
    return false
  }
  const targetNormalized = normalize(join(baseReal, relativePath))
  return targetNormalized === baseReal || targetNormalized.startsWith(baseReal + sep)
}
