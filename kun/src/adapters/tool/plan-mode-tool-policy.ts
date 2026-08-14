import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'

export type PlanModeToolBlock = {
  code: 'plan_mode_write_blocked'
  message: string
}

/**
 * Generated media is a deliberate Plan-mode exception: users should be able
 * to create or iterate an image without switching the conversation back to
 * Agent mode. Keep this list narrow because these tools persist workspace
 * artifacts even though they do not modify project source files.
 */
export const PLAN_MODE_ALLOWED_GENERATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'generate_image'
])

export function isPlanModeToolContext(
  context: Pick<ToolHostContext, 'threadMode' | 'guiPlan'>
): boolean {
  return context.threadMode === 'plan' || Boolean(context.guiPlan)
}

/**
 * Plan mode may only persist the host-owned reserved plan through create_plan.
 * The catalog already hides other mutation tools; this execution-time check is
 * defense in depth for forged calls and future file-change capabilities.
 */
export async function planModeToolBlock(
  tool: Pick<LocalTool, 'name' | 'toolKind'>,
  _call: unknown,
  context: ToolHostContext
): Promise<PlanModeToolBlock | null> {
  if (!isPlanModeToolContext(context)) return null
  if (
    tool.name === 'create_plan' ||
    PLAN_MODE_ALLOWED_GENERATION_TOOL_NAMES.has(tool.name) ||
    tool.toolKind !== 'file_change'
  ) return null
  return {
    code: 'plan_mode_write_blocked',
    message:
      `Plan mode cannot execute project file mutation tool ${tool.name}. ` +
      'Use read-only investigation tools and save the reserved implementation plan with create_plan; switch to Agent mode before implementing changes.'
  }
}
