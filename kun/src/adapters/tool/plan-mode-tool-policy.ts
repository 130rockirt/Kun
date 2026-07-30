import { extname, isAbsolute, resolve } from 'node:path'
import type { ToolCallLike, ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'
import { resolvePathThroughSymlinks, workspaceRoot } from './workspace-path.js'

export type PlanModeToolBlock = {
  code: 'plan_mode_write_blocked'
  message: string
}

const PLAN_MARKDOWN_WRITE_TOOLS = new Set(['write', 'edit'])

export function isPlanModeToolContext(
  context: Pick<ToolHostContext, 'threadMode' | 'guiPlan'>
): boolean {
  return context.threadMode === 'plan' || Boolean(context.guiPlan)
}

/**
 * Plan mode may update Markdown working documents, but it must not mutate
 * source/config/artifact files. Check both the requested path and its resolved
 * target so a `.md` symlink cannot be used to edit a non-Markdown file.
 */
export async function planModeToolBlock(
  tool: Pick<LocalTool, 'name' | 'toolKind'>,
  call: Pick<ToolCallLike, 'arguments'>,
  context: ToolHostContext
): Promise<PlanModeToolBlock | null> {
  if (!isPlanModeToolContext(context)) return null
  if (!PLAN_MARKDOWN_WRITE_TOOLS.has(tool.name)) return null

  const rawPath = typeof call.arguments.path === 'string' ? call.arguments.path.trim() : ''
  if (!rawPath) return null
  const lexicalPath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(workspaceRoot(context.workspace), rawPath)
  if (!isMarkdownPath(lexicalPath)) return markdownOnlyBlock(rawPath)

  try {
    const resolvedPath = await resolvePathThroughSymlinks(lexicalPath)
    if (!isMarkdownPath(resolvedPath)) return markdownOnlyBlock(rawPath)
  } catch {
    // The concrete file tool owns missing-root/path diagnostics. A new `.md`
    // target is valid here and will still pass through its normal sandbox gate.
  }
  return null
}

function isMarkdownPath(path: string): boolean {
  return extname(path).toLowerCase() === '.md'
}

function markdownOnlyBlock(path: string): PlanModeToolBlock {
  return {
    code: 'plan_mode_write_blocked',
    message:
      `Plan mode can only create or edit Markdown (.md) files; blocked target: ${path}. ` +
      'Use read-only investigation tools and save the implementation plan with create_plan.'
  }
}
