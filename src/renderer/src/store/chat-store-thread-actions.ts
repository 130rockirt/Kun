import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { saveQueuedMessagesForThread } from './queued-message-persistence'
import { createThreadCreationActions } from './chat-store-thread-creation-actions'
import { createThreadSelectionActions } from './chat-store-thread-selection-actions'
import { createThreadQueueActions } from './chat-store-thread-queue-actions'
import { createThreadSendActions } from './chat-store-thread-send-actions'
import { createThreadReviewActions } from './chat-store-thread-review-actions'
import type { StoreActionContext, ThreadActionRuntime } from './chat-store-thread-actions-support'

type SseAbortRef = { current: AbortController | null }

export function createThreadActions(
  context: { set: ChatStoreSet; get: ChatStoreGet; sseAbortRef: SseAbortRef }
): Pick<ChatState, 'createThread' | 'createConversation' | 'recoverActiveTurn' | 'selectThread' | 'loadEarlierThreadHistory' | 'subscribeThreadEventsLive' | 'drainQueuedMessages' | 'removeQueuedMessage' | 'reorderQueuedMessage' | 'guideQueuedMessage' | 'sendMessage' | 'reviewActiveThread'> {
  const actionContext: StoreActionContext = context
  const runtime: ThreadActionRuntime = {
    threadSelectionGeneration: 0,
    persistActiveQueuedMessages: () => {
      const state = context.get()
      if (state.activeThreadId) {
        saveQueuedMessagesForThread(state.activeThreadId, state.queuedMessages)
      }
    }
  }
  return {
    ...createThreadCreationActions(actionContext, runtime),
    ...createThreadSelectionActions(actionContext, runtime),
    ...createThreadQueueActions(actionContext, runtime),
    ...createThreadSendActions(actionContext, runtime),
    ...createThreadReviewActions(actionContext, runtime)
  }
}
