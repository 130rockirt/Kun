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
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode'>
): Promise<ApprovedExternalWriteTarget[]> {
  if (
    tool.toolKind !== 'file_change' ||
    effectiveSandboxMode(context) !== 'workspace-write' ||
    !tool.externalWritePathArguments?.length
  ) {
    return []
  }

  const { lexicalRoot, physicalRoot } = await resolveExistingWorkspaceRoot(context.workspace)
  const externalTargets: ApprovedExternalWriteTarget[] = []
  for (const argumentName of tool.externalWritePathArguments) {
    const value = call.arguments[argumentName]
    if (typeof value !== 'string' || !value.trim()) continue
    const lexicalTarget = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value)
    const physicalTarget = await resolvePathThroughSymlinks(lexicalTarget)
    if (
      !isPathInsideOrEqual(physicalRoot, physicalTarget) &&
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
  context?: Pick<ToolHostContext, 'sandboxMode'>
): boolean {
  if (!context) return true
  return sandboxBlockForTool(tool, context) === null
}

export function sandboxBlockForTool(
  tool: Pick<LocalTool, 'toolKind' | 'name'>,
  context: Pick<ToolHostContext, 'sandboxMode'>
): SandboxBlock | null {
  const mode = effectiveSandboxMode(context)
  if (mode === 'danger-full-access') return null
  if (isInteractiveGuiGateTool(tool.name)) return null

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
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'approvedExternalWriteTargets'>
): { ok: true } | { ok: false; block: SandboxBlock } {
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

  const root = workspaceRoot(context.workspace)
  const resolvedPath = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(root, absolutePath)
  if (isPathInsideOrEqual(root, resolvedPath)) return { ok: true }
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
  context: Pick<ToolHostContext, 'workspace' | 'sandboxMode' | 'approvedExternalWriteTargets'>
): void {
  const decision = canWritePath(absolutePath, context)
  if (!decision.ok) throw new Error(decision.block.message)
}

function isInteractiveGuiGateTool(toolName: string): boolean {
  return toolName === 'user_input' || toolName === 'request_user_input'
}
