import type { ToolCallLike } from '../ports/tool-host.js'
import {
  BrowserUseActionInput,
  isBrowserUseStateAdvancingAction
} from '../contracts/browser-use.js'

export type ToolStormBreakerOptions = {
  windowSize?: number
  threshold?: number
  interactiveThreshold?: number
}

type RecentToolCall = {
  name: string
  args: string
  readOnly: boolean
}

const DEFAULT_WINDOW_SIZE = 8
const DEFAULT_THRESHOLD = 3
const DEFAULT_INTERACTIVE_THRESHOLD = 3
const MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'edit_diff', 'apply_patch', 'delete', 'move'])
const GRAPH_MUTATING_TOOL_NAMES = new Set([
  'graph_patch_run',
  'graph_review_node'
])
const INTERACTIVE_TOOL_NAMES = new Set(['request_user_input', 'user_input'])

/**
 * Prevents repeated identical tool calls from inflating dynamic history
 * and cache misses. It is deliberately turn-scoped; a new user turn is
 * a new intent, so the AgentLoop resets the breaker between turns.
 */
export class ToolStormBreaker {
  private readonly windowSize: number
  private readonly threshold: number
  private readonly interactiveThreshold: number
  private readonly recent: RecentToolCall[] = []
  private interactiveCount = 0

  constructor(options: ToolStormBreakerOptions = {}) {
    this.windowSize = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE))
    this.threshold = Math.max(2, Math.floor(options.threshold ?? DEFAULT_THRESHOLD))
    this.interactiveThreshold = Math.max(
      1,
      Math.floor(options.interactiveThreshold ?? DEFAULT_INTERACTIVE_THRESHOLD)
    )
  }

  inspect(call: ToolCallLike): { suppress: boolean; reason?: string } {
    if (call.toolName === 'graph_define_plan') {
      // The planning draft owns candidate hashing and the single-repair
      // policy. Let it return unchanged_invalid_plan on the second identical
      // submission instead of converting it into a generic third-call storm.
      return { suppress: false }
    }
    if (INTERACTIVE_TOOL_NAMES.has(call.toolName)) {
      this.interactiveCount += 1
      if (this.interactiveCount > this.interactiveThreshold) {
        return {
          suppress: true,
          reason:
            `${call.toolName} was called ${this.interactiveCount} times in this turn; ` +
            'interactive prompt guard suppressed the repeated ask. Act on the latest answer, finish, or ask follow-up in normal text.'
        }
      }
      return { suppress: false }
    }
    const name = call.toolName
    const args = stableStringify(call.arguments)
    const readOnly = !isMutatingToolCall(call)

    if (!readOnly) {
      this.clearReadOnlyEntries()
    }

    const count = this.recent.reduce(
      (sum, entry) => sum + (entry.name === name && entry.args === args ? 1 : 0),
      0
    )
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason:
          `${name} was called with identical arguments ${count + 1} times in this turn; ` +
          repeatSuppressionGuidance(call)
      }
    }

    this.recent.push({ name, args, readOnly })
    while (this.recent.length > this.windowSize) this.recent.shift()
    return { suppress: false }
  }

  reset(): void {
    this.recent.length = 0
    this.interactiveCount = 0
  }

  private clearReadOnlyEntries(): void {
    for (let index = this.recent.length - 1; index >= 0; index -= 1) {
      if (this.recent[index]?.readOnly) this.recent.splice(index, 1)
    }
  }
}

function isMutatingToolCall(call: ToolCallLike): boolean {
  if (call.toolName === 'browser_use') {
    return isBrowserUseStateAdvancingAction(call.arguments)
  }
  if (call.toolKind === 'file_change') return true
  if (call.toolName === 'graph_control_run') {
    return graphControlAction(call) !== 'inspect'
  }
  if (call.toolName === 'graph_supervise_node') {
    return graphAction(call) === 'guide'
  }
  if (GRAPH_MUTATING_TOOL_NAMES.has(call.toolName)) return true
  return MUTATING_TOOL_NAMES.has(call.toolName)
}

function repeatSuppressionGuidance(call: ToolCallLike): string {
  if (call.toolName !== 'browser_use') {
    return 'repeat-loop guard suppressed the duplicate. Choose a narrower query or explain why another identical call is needed.'
  }
  if (!BrowserUseActionInput.safeParse(call.arguments).success) {
    return 'repeat-loop guard suppressed the malformed Browser Use call. Follow the previous invalid_action guidance and send a supported action with its required fields.'
  }
  return 'repeat-loop guard suppressed the duplicate Browser Use action. Use a state-advancing action such as wait or a fresh snapshot, or provide a clear final answer.'
}

function graphControlAction(call: ToolCallLike): string {
  if (call.toolName !== 'graph_control_run') return ''
  return graphAction(call)
}

function graphAction(call: ToolCallLike): string {
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return ''
  }
  const action = (call.arguments as Record<string, unknown>).action
  return typeof action === 'string' ? action : ''
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value))
  } catch {
    return String(value)
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}
