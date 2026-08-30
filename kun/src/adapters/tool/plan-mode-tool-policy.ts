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

/** Read-only tools shared by capability discovery and the final model catalog. */
export const PLAN_MODE_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read',
  'ls',
  'glob',
  'grep',
  'find',
  'repo_map',
  'git_inspect',
  'lsp',
  'web_search',
  'web_fetch'
])

/** Interactive gates that may remain available while a plan is investigated. */
export const PLAN_MODE_INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'user_input',
  'request_user_input'
])

/** Host-constrained tools which may persist only the reserved plan artifact. */
export const PLAN_MODE_HOST_CONSTRAINED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_plan'
])

/**
 * Single source of truth for named Plan-mode exceptions. Tools may also enter
 * the catalog by declaring `sideEffect: 'read-only'`, while generated media is
 * handled by the deliberately separate generation exception above.
 */
export const PLAN_MODE_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PLAN_MODE_READ_ONLY_TOOL_NAMES,
  ...PLAN_MODE_INTERACTIVE_TOOL_NAMES,
  ...PLAN_MODE_HOST_CONSTRAINED_TOOL_NAMES
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
