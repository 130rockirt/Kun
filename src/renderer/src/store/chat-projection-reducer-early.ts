import type { RuntimeProjectionAction } from '../agent/runtime-projection-actions'
import type { ChatState } from './chat-store-types'

/**
 * Guards that must run before any projection branch can turn a terminal event
 * into visible state or browser effects. Terminal identity is part of the
 * Kun wire contract; a stale replay, a child lifecycle event, or an
 * unidentified legacy event must not clear the current turn.
 */
export function reduceEarlyChatProjection(
  state: ChatState,
  action: RuntimeProjectionAction
): Partial<ChatState> | undefined {
  if (action.type !== 'turn_completed' && action.type !== 'turn_aborted') return undefined

  const terminal = action.payload
  if (terminal.child) return {}
  if (terminal.threadId && state.activeThreadId && terminal.threadId !== state.activeThreadId) return {}
  if (state.currentTurnId && terminal.turnId && terminal.turnId !== state.currentTurnId) return {}
  if (!terminal.turnId) return {}
  if (!state.currentTurnId) return {}
  return undefined
}
