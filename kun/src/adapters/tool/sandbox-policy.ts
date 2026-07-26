import { dirname, isAbsolute, resolve } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  DEFAULT_SANDBOX_MODE,
  SandboxModeSchema,
  type SandboxMode
} from '../../contracts/policy.js'
import type {
  ApprovedExternalWriteTarget,
  ToolCallLike,
  ToolHostContext
} from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'
import {
  isPathInsideOrEqual,
  resolveExistingWorkspaceRoot,
  resolvePathThroughSymlinks,
  sameFilesystemPath,
  workspaceRoot
} from './workspace-path.js'

export type SandboxBlock = {
  code: 'sandbox_read_only' | 'sandbox_command_blocked' | 'sandbox_write_blocked'
  message: string
}

/**
 * Resolve exact external targets that an opted-in file tool wants to mutate.
 * The physical targets captured here are compared again immediately before the
 * tool writes, closing approval-prompt symlink/junction redirection.
 */
export async function externalWriteTargetsForApproval(
  tool: Pick<LocalTool, 'toolKind' | 'externalWritePathArguments'>,
  call: Pick<ToolCallLike, 'arguments'>,
  context: Pick<ToolHostContext, 'workspace' | 'additionalWorkspaces' | 'sandboxMode'>
): Promise<ApprovedExternalWriteTarget[]> {
  if (
    tool.toolKind !== 'file_change' ||
    effectiveSandboxMode(context) !== 'workspace-write' ||
    !tool.externalWritePathArguments?.length
  ) {
    return []
  }

  const roots = await resolvedWorkspaceRoots(context)
  const lexicalRoot = roots[0]!.lexicalRoot
  const externalTargets: ApprovedExternalWriteTarget[] = []
  for (const argumentName of tool.externalWritePathArguments) {
    const value = call.arguments[argumentName]
    if (typeof value !== 'string' || !value.trim()) continue
    const lexicalTarget = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value)
    const physicalTarget = await resolvePathThroughSymlinks(lexicalTarget)
    if (
      !roots.some((root) => isPathInsideOrEqual(root.physicalRoot, physicalTarget)) &&
      !externalTargets.some((target) => sameFilesystemPath(target.path, physicalTarget))
    ) {
      let targetStats: BigIntStats
      try {
        targetStats = await stat(physicalTarget, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `external write approval requires an existing regular file: ${physicalTarget}`
          )
        }
        throw error
      }
      if (!targetStats.isFile() || targetStats.ino === 0n) {
        throw new Error(
          `external write approval requires a regular file with a stable identity: ${physicalTarget}`
        )
      }
      if (targetStats.nlink !== 1n) {
        throw new Error(
          `external write approval requires a file with exactly one hard link: ${physicalTarget}`
        )
      }
      const parentStats = await stat(dirname(physicalTarget), { bigint: true })
      if (!parentStats.isDirectory() || parentStats.ino === 0n) {
        throw new Error(
          `external write approval requires a parent directory with a stable identity: ${physicalTarget}`
        )
      }
      const confirmedTarget = await resolvePathThroughSymlinks(lexicalTarget)
      if (!sameFilesystemPath(confirmedTarget, physicalTarget)) {
        throw new Error(`external write target changed while preparing approval: ${physicalTarget}`)
      }
      externalTargets.push({
        path: physicalTarget,
        device: targetStats.dev,
        inode: targetStats.ino,
        parentDevice: parentStats.dev,
        parentInode: parentStats.ino
      })
    }
  }
  return externalTargets
}

export function effectiveSandboxMode(
  context?: Pick<ToolHostContext, 'sandboxMode'>
): SandboxMode {
  const parsed = SandboxModeSchema.safeParse(context?.sandboxMode)
  return parsed.success ? parsed.data : DEFAULT_SANDBOX_MODE
}

export function isToolAdvertisedInSandbox(
  tool: Pick<LocalTool, 'toolKind' | 'name'>,
  context?: Pick<ToolHostContext, 'sandboxMode' | 'allowedReadPaths' | 'allowedWritePaths'>
): boolean {
  if (!context) return true
  return sandboxBlockForTool(tool, context) === null
}

export function sandboxBlockForTool(
  tool: Pick<LocalTool, 'toolKind' | 'name'>,
  context: Pick<ToolHostContext, 'sandboxMode' | 'allowedReadPaths' | 'allowedWritePaths'>
): SandboxBlock | null {
  const mode = effectiveSandboxMode(context)
  if (isInteractiveGuiGateTool(tool.name)) return null

  if (
    tool.toolKind === 'command_execution' &&
    hasNarrowPathBoundary(context)
  ) {
    return {
      code: 'sandbox_command_blocked',
      message:
        `tool ${tool.name} is blocked because shell commands cannot be safely confined ` +
        'to the delegated child path scopes'
    }
  }
  if (mode === 'danger-full-access') return null

  if (tool.toolKind === 'file_change') {
    if (mode === 'workspace-write') return null
    return {
      code: mode === 'read-only' ? 'sandbox_read_only' : 'sandbox_write_blocked',
      message:
        mode === 'read-only'
          ? `tool ${tool.name} is blocked by the read-only sandbox`
          : `tool ${tool.name} is blocked because ${mode} does not allow in-process file mutation`
    }
  }

  if (tool.toolKind === 'command_execution') {
    return {
      code: 'sandbox_command_blocked',
      message:
        mode === 'read-only'
          ? `tool ${tool.name} is blocked by the read-only sandbox. To run terminal commands, set the sandbox mode to "danger-full-access" (Full access) in Settings → Agents.`
          : `tool ${tool.name} is blocked because the "${mode}" sandbox mode does not run host shell commands. To enable terminal commands, set the sandbox mode to "danger-full-access" (Full access) in Settings → Agents.`
    }
  }

  return null
}

export function canWritePath(
  absolutePath: string,
  context: Pick<
    ToolHostContext,
    | 'workspace'
    | 'additionalWorkspaces'
    | 'sandboxMode'
    | 'approvedExternalWriteTargets'
    | 'allowedWritePaths'
  >
): { ok: true } | { ok: false; block: SandboxBlock } {
  if (
    context.allowedWritePaths &&
    !pathAllowedByScopes(absolutePath, context.workspace, context.allowedWritePaths)
  ) {
    return {
      ok: false,
      block: {
        code: 'sandbox_write_blocked',
        message: `writing is outside the delegated child write scopes: ${absolutePath}`
      }
    }
  }
  const mode = effectiveSandboxMode(context)
  if (mode === 'danger-full-access') return { ok: true }
  if (mode === 'read-only') {
    return {
      ok: false,
      block: {
        code: 'sandbox_read_only',
        message: `writing is blocked by the read-only sandbox: ${absolutePath}`
      }
    }
  }
  if (mode === 'external-sandbox') {
    return {
      ok: false,
      block: {
        code: 'sandbox_write_blocked',
        message: `writing is blocked because external-sandbox is not enforced by in-process file tools: ${absolutePath}`
      }
    }
  }

  const roots = lexicalWorkspaceRoots(context)
  const resolvedPath = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(roots[0]!, absolutePath)
  if (roots.some((root) => isPathInsideOrEqual(root, resolvedPath))) return { ok: true }
  if (context.approvedExternalWriteTargets?.some((target) =>
    sameFilesystemPath(target.path, resolvedPath)
  )) {
    return { ok: true }
  }
  return {
    ok: false,
    block: {
      code: 'sandbox_write_blocked',
      message: `writing is limited to the workspace sandbox: ${absolutePath}`
    }
  }
}

export function assertCanWritePath(
  absolutePath: string,
  context: Pick<
    ToolHostContext,
    | 'workspace'
    | 'additionalWorkspaces'
    | 'sandboxMode'
    | 'approvedExternalWriteTargets'
    | 'allowedWritePaths'
  >
): void {
  const decision = canWritePath(absolutePath, context)
  if (!decision.ok) throw new Error(decision.block.message)
}

export function pathAllowedByScopes(
  absolutePath: string,
  workspace: string,
  scopes: readonly string[]
): boolean {
  const root = workspaceRoot(workspace)
  const target = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(root, absolutePath)
  if (!isPathInsideOrEqual(root, target)) return false
  const relativePath = target === root
    ? '.'
    : target.slice(root.length + 1).replaceAll('\\', '/')
  return scopes.some((scope) => {
    const normalized = scope.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.'
    return normalized === '.' ||
      relativePath === normalized ||
      relativePath.startsWith(`${normalized}/`)
  })
}

function hasNarrowPathBoundary(
  context: Pick<ToolHostContext, 'allowedReadPaths' | 'allowedWritePaths'>
): boolean {
  const read = context.allowedReadPaths
  const write = context.allowedWritePaths
  if (!read && !write) return false
  return !read?.includes('.') || !write?.includes('.')
}

function lexicalWorkspaceRoots(
  context: Pick<ToolHostContext, 'workspace' | 'additionalWorkspaces'>
): string[] {
  return [...new Set([context.workspace, ...(context.additionalWorkspaces ?? [])].map(workspaceRoot))]
}

async function resolvedWorkspaceRoots(
  context: Pick<ToolHostContext, 'workspace' | 'additionalWorkspaces'>
): Promise<Array<{ lexicalRoot: string; physicalRoot: string }>> {
  const roots = lexicalWorkspaceRoots(context)
  const primary = await resolveExistingWorkspaceRoot(roots[0]!)
  const additional = await Promise.all(roots.slice(1).map((root) =>
    resolveExistingWorkspaceRoot(root).catch(() => null)
  ))
  return [primary, ...additional.filter((entry) => entry !== null)]
}

function isInteractiveGuiGateTool(toolName: string): boolean {
  return toolName === 'user_input' || toolName === 'request_user_input'
}
