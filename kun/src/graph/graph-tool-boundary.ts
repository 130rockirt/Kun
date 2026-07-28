import type { ToolHostContext, ToolProviderKind } from '../ports/tool-host.js'

export const GRAPH_LEAD_TOOL_NAMES = [
  'graph_create_run',
  'graph_control_run',
  'graph_patch_run',
  'graph_review_node'
] as const

export const GRAPH_WORKER_TOOL_NAMES = [
  'graph_worker_progress',
  'graph_worker_message',
  'graph_worker_receive_messages',
  'graph_worker_publish_artifact',
  'graph_worker_submit_result'
] as const

/**
 * Ordinary orchestration surfaces conflict with host-owned Graph scheduling.
 * Provider-kind filtering covers current and future delegation tools; exact
 * names cover legacy DAG state and built-in wrappers that can spawn a child.
 */
export const GRAPH_INCOMPATIBLE_TOOL_NAMES = [
  'delegate_task',
  'list_subagent_profiles',
  'generate_subagent',
  'task_graph',
  'design_component'
] as const

const INCOMPATIBLE_TOOL_NAMES = new Set<string>(GRAPH_INCOMPATIBLE_TOOL_NAMES)
const WORKER_TOOL_NAMES = new Set<string>(GRAPH_WORKER_TOOL_NAMES)

export function isGraphLeadContext(
  context: Pick<ToolHostContext, 'orchestration' | 'messageSource'> | undefined
): boolean {
  return context?.orchestration === 'graph' ||
    context?.messageSource === 'graph_runtime'
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
  if (input.providerKind === 'delegation' || input.providerId === 'delegation') {
    return false
  }
  return !INCOMPATIBLE_TOOL_NAMES.has(input.toolName)
}

/**
 * Capture only capabilities that a Graph worker can actually receive. Graph
 * worker coordination is host-owned and mandatory; ordinary orchestration is
 * never copied into an assignment snapshot.
 */
export function graphParentAuthorityToolNames(toolNames: readonly string[]): string[] {
  return [...new Set([
    ...toolNames.filter((name) => !INCOMPATIBLE_TOOL_NAMES.has(name)),
    ...GRAPH_WORKER_TOOL_NAMES
  ])].sort()
}

export function graphWorkerToolNamesWithin(
  allowedToolNames: readonly string[]
): string[] {
  return [...new Set(allowedToolNames.filter((name) => WORKER_TOOL_NAMES.has(name)))].sort()
}
