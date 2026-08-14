import type { ChatState } from './chat-store-types'
import { sendThreadMessage } from './chat-store-thread-send'
import type { StoreActionContext, ThreadActionRuntime } from './chat-store-thread-actions-support'

export function createThreadSendActions(
  context: StoreActionContext,
  runtime: ThreadActionRuntime
): Pick<ChatState, 'sendMessage'> {
  return {
    sendMessage: (text, mode, overrides) => sendThreadMessage(context, runtime, text, mode, overrides)
  }
}
