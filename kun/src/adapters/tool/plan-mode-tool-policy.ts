import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'

export type PlanModeToolBlock = {
  code: 'plan_mode_write_blocked'
  message: string
}

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
  if (tool.name === 'create_plan' || tool.toolKind !== 'file_change') return null
  return {
    code: 'plan_mode_write_blocked',
    message:
      `Plan mode cannot execute project file mutation tool ${tool.name}. ` +
      'Use read-only investigation tools and save the reserved implementation plan with create_plan; switch to Agent mode before implementing changes.'
  }
}
