import type { ToolCallLike } from '../ports/tool-host.js'

export type ToolStormBreakerOptions = {
  interactiveThreshold?: number
}

const DEFAULT_INTERACTIVE_THRESHOLD = 3
const INTERACTIVE_TOOL_NAMES = new Set(['request_user_input', 'user_input'])

/**
 * Prevents repeated interactive user-input gates (user_input /
 * request_user_input) from spamming the user within one turn. Ordinary tool
 * calls are never suppressed: identical calls may be retried freely after a
 * failure. It is deliberately turn-scoped; a new user turn is a new intent,
 * so the AgentLoop resets the breaker between turns.
 */
export class ToolStormBreaker {
  private readonly interactiveThreshold: number
  private interactiveCount = 0

  constructor(options: ToolStormBreakerOptions = {}) {
    this.interactiveThreshold = Math.max(
      1,
      Math.floor(options.interactiveThreshold ?? DEFAULT_INTERACTIVE_THRESHOLD)
    )
  }

  inspect(call: ToolCallLike): { suppress: boolean; reason?: string } {
    if (!INTERACTIVE_TOOL_NAMES.has(call.toolName)) return { suppress: false }
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

  reset(): void {
    this.interactiveCount = 0
  }
}
