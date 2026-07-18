import { lstat, readlink, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  resolve,
  win32
} from 'node:path'

export function workspaceRoot(workspace: string): string {
  if (!workspace.trim()) return process.cwd()
  return isAbsolute(workspace) ? resolve(workspace) : resolve(process.cwd(), workspace)
}

export async function resolveExistingWorkspaceRoot(workspace: string): Promise<{
  lexicalRoot: string
  physicalRoot: string
}> {
  const lexicalRoot = workspaceRoot(workspace)
  const physicalRoot = await safeRealpath(lexicalRoot)
  if (physicalRoot === null) {
    throw new Error(`workspace root does not exist: ${lexicalRoot}`)
  }
  return { lexicalRoot, physicalRoot }
}

/**
 * Resolve a path through every existing symlink/junction while preserving a
 * nonexistent suffix. A dangling symlink is followed explicitly so callers
 * cannot treat its lexical location as the eventual write target.
 */
export async function resolvePathThroughSymlinks(inputPath: string): Promise<string> {
  return resolveSymlinkSafe(resolve(inputPath))
}

export function sameFilesystemPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix
  const normalize = (value: string): string => {
    const normalized = pathApi.normalize(pathApi.resolve(value))
    const root = pathApi.parse(normalized).root
    const withoutTrailingSeparators = normalized.length > root.length
      ? stripTrailingSeparators(normalized, root.length, platform)
      : normalized
    return platform === 'win32'
      ? withoutTrailingSeparators.toLowerCase()
      : withoutTrailingSeparators
  }
  return normalize(left) === normalize(right)
}

function stripTrailingSeparators(
  value: string,
  minimumLength: number,
  platform: NodeJS.Platform
): string {
  let end = value.length
  while (end > minimumLength) {
    const code = value.charCodeAt(end - 1)
    const isSeparator = code === 0x2f || (platform === 'win32' && code === 0x5c)
    if (!isSeparator) break
    end -= 1
  }
  return end === value.length ? value : value.slice(0, end)
}

export function isPathInsideOrEqual(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix
  const rootPath = pathApi.resolve(root)
  const candidatePath = pathApi.resolve(candidate)
  if (sameFilesystemPath(rootPath, candidatePath, platform)) return true
  const rel = pathApi.relative(rootPath, candidatePath)
  return rel !== '..' &&
    !rel.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(rel)
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}

async function resolveSymlinkSafe(lexicalPath: string, depth = 0): Promise<string> {
  if (depth > 40) {
    throw new Error(`too many symbolic links resolving: ${lexicalPath}`)
  }
  const direct = await safeRealpath(lexicalPath)
  if (direct !== null) return direct

  const segments: string[] = []
  let current = lexicalPath
  for (let i = 0; i < 128 && current !== dirname(current); i += 1) {
    const resolved = await safeRealpath(current)
    if (resolved !== null) {
      return segments.length > 0 ? resolve(resolved, ...segments) : resolved
    }
    if (await isSymlink(current)) {
      const linkTarget = await readlink(current)
      const resolvedParent = (await safeRealpath(dirname(current))) ?? dirname(current)
      const followed = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(resolvedParent, linkTarget)
      const rejoined = segments.length > 0 ? resolve(followed, ...segments) : followed
      return resolveSymlinkSafe(rejoined, depth + 1)
    }
    segments.unshift(basename(current))
    current = dirname(current)
  }
  throw new Error(`path escapes the workspace root: ${lexicalPath}`)
}
