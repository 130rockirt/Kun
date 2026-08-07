import type { ToolHostContext, ToolProviderKind } from '../ports/tool-host.js'

/** Keep as literals to avoid a cycle with explore-agent-tool-provider → capability-registry. */
const EXPLORE_AGENT_TOOL_NAME = 'explore_agent'
const EXPLORE_AGENT_PROVIDER_ID = 'explore-agent'

export const GRAPH_LEAD_TOOL_NAMES = [
  'graph_define_plan',
  'graph_create_run',
  'graph_control_run',
  'graph_patch_run',
  'graph_review_node',
  'graph_supervise_node'
] as const

export const GRAPH_WORKER_TOOL_NAMES = [
  'graph_worker_progress',
  'graph_worker_message',
  'graph_worker_receive_messages',
  'graph_worker_publish_artifact',
  'graph_worker_submit_result'
] as const

export const GRAPH_WORKER_REPORT_TOOL_NAME = 'report_to_parent' as const

/**
 * Ordinary orchestration surfaces conflict with host-owned Graph scheduling.
 * Provider-kind filtering covers current and future delegation tools; exact
 * names cover legacy DAG state and built-in wrappers that can spawn a child.
 * Lab `explore_agent` is exempt from Lead listing (read-only investigation)
 * but is still stripped from Worker assignment snapshots below.
 */
export const GRAPH_INCOMPATIBLE_TOOL_NAMES = [
  'delegate_task',
  'list_subagent_profiles',
  'generate_subagent',
  'task_graph',
  'design_component'
] as const

const INCOMPATIBLE_TOOL_NAMES = new Set<string>(GRAPH_INCOMPATIBLE_TOOL_NAMES)
const LEAD_TOOL_NAMES = new Set<string>(GRAPH_LEAD_TOOL_NAMES)
const WORKER_TOOL_NAMES = new Set<string>(GRAPH_WORKER_TOOL_NAMES)
const WORKER_REPORT_TOOL_NAMES = new Set<string>([GRAPH_WORKER_REPORT_TOOL_NAME])

export function isGraphLeadContext(
  context: Pick<ToolHostContext, 'orchestration' | 'messageSource'> | undefined
): boolean {
  return context?.orchestration === 'graph' ||
    context?.messageSource === 'graph_runtime'
}

function isExploreAgentTool(input: {
  toolName: string
  providerId: string
}): boolean {
  return input.toolName === EXPLORE_AGENT_TOOL_NAME ||
    input.providerId === EXPLORE_AGENT_PROVIDER_ID
}

export function isToolAllowedInOrchestration(
  input: {
    toolName: string
    providerId: string
    providerKind: ToolProviderKind
  },
  context: Pick<ToolHostContext, 'orchestration' | 'messageSource'> | undefined
): boolean {
  if (!isGraphLeadContext(context)) return true
  // Read-only Lab explore stays available on Graph Lead turns so planning can
  // gather repository facts without ordinary delegate_task / child fan-out.
  if (isExploreAgentTool(input)) return true
  if (input.providerKind === 'delegation' || input.providerId === 'delegation') {
    return false
  }
  return !INCOMPATIBLE_TOOL_NAMES.has(input.toolName)
}

/**
 * Capture only ordinary capabilities that a Graph executor can receive.
 * Graph lifecycle and worker-protocol tools are host/Lead-owned and are never
 * copied into an assignment snapshot.
 */
export function graphParentAuthorityToolNames(toolNames: readonly string[]): string[] {
  return [...new Set(toolNames.filter((name) =>
    name !== EXPLORE_AGENT_TOOL_NAME &&
    !INCOMPATIBLE_TOOL_NAMES.has(name) &&
    !LEAD_TOOL_NAMES.has(name) &&
    !WORKER_TOOL_NAMES.has(name) &&
    !WORKER_REPORT_TOOL_NAMES.has(name)
  ))].sort()
}

export function graphWorkerToolNamesWithin(
  allowedToolNames: readonly string[]
): string[] {
  return allowedToolNames.includes(GRAPH_WORKER_REPORT_TOOL_NAME)
    ? [GRAPH_WORKER_REPORT_TOOL_NAME]
    : []
}
