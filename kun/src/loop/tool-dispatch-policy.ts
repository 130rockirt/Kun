import type { ApprovalPolicy } from '../contracts/policy.js'
import type { ToolCallLike, ToolProviderKind } from '../ports/tool-host.js'

const PARALLEL_READ_ONLY_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'find', 'ls'])
const DELEGATE_TASK_TOOL_NAME = 'delegate_task'
export const DEFAULT_MAX_PARALLEL_READ_ONLY_TOOL_CALLS = 3

export type ToolDispatchLane = 'serial' | 'read_only' | 'delegation'

export type ToolDispatchPolicy = {
  approvalPolicy: ApprovalPolicy
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
  maxParallelReadOnly?: number
}

export type ParallelToolDispatchCandidates = {
  lane: Exclude<ToolDispatchLane, 'serial'>
  calls: readonly ToolCallLike[]
}

/**
 * Classify a call without executing or inspecting mutable storm-guard state.
 * The dispatcher uses this only to form homogeneous batches; it remains
 * responsible for approvals, result persistence, and ordering.
 */
export function classifyToolDispatchLane(
  call: ToolCallLike,
  policy: ToolDispatchPolicy
): ToolDispatchLane {
  // These policies can prompt or reject a call at runtime, so never fan out
  // work before the current call's outcome is known.
  if (
    policy.approvalPolicy === 'always' ||
    policy.approvalPolicy === 'untrusted' ||
    policy.approvalPolicy === 'never'
  ) {
    return 'serial'
  }
  if (isParallelDelegationCall(call, policy)) return 'delegation'
  if (!PARALLEL_READ_ONLY_TOOL_NAMES.has(call.toolName)) return 'serial'
  if (call.toolKind && call.toolKind !== 'tool_call') return 'serial'
  return policy.toolProviderKinds.get(call.toolName) === 'built-in'
    ? 'read_only'
    : 'serial'
}

export function isParallelSafeToolCall(
  call: ToolCallLike,
  policy: ToolDispatchPolicy
): boolean {
  return classifyToolDispatchLane(call, policy) !== 'serial'
}

export function isParallelDelegationCall(
  call: ToolCallLike,
  policy: Pick<ToolDispatchPolicy, 'toolProviderKinds'>
): boolean {
  return call.toolName === DELEGATE_TASK_TOOL_NAME &&
    policy.toolProviderKinds.get(call.toolName) === 'delegation'
}

/**
 * Return the contiguous, same-lane calls eligible for one parallel batch.
 * This deliberately does not inspect suppression state: doing that remains in
 * the dispatcher so a suppressed call is observed at the same point as before.
 */
export function collectParallelToolDispatchCandidates(input: {
  calls: readonly ToolCallLike[]
  startIndex: number
  policy: ToolDispatchPolicy
}): ParallelToolDispatchCandidates | null {
  const first = input.calls[input.startIndex]
  if (!first) return null
  const lane = classifyToolDispatchLane(first, input.policy)
  if (lane === 'serial') return null
  const maxCalls = lane === 'delegation'
    ? input.calls.length - input.startIndex
    : Math.max(
        1,
        Math.floor(input.policy.maxParallelReadOnly ?? DEFAULT_MAX_PARALLEL_READ_ONLY_TOOL_CALLS)
      )
  const calls: ToolCallLike[] = [first]
  for (let index = input.startIndex + 1; index < input.calls.length && calls.length < maxCalls; index += 1) {
    const next = input.calls[index]
    if (!next || classifyToolDispatchLane(next, input.policy) !== lane) break
    calls.push(next)
  }
  return { lane, calls }
}
