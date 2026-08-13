import type { QueuedUserMessage } from './chat-store-types'
import { rememberTurnModel } from './chat-store-helpers'
import { saveQueuedMessagesForThread } from './queued-message-persistence'
import { invalidateThreadSnapshot } from './thread-snapshot-cache'

/**
 * An accepted turn can finish admission after its thread was parked in the
 * snapshot cache. Never let that late result mutate the newly selected
 * thread. Drop the pre-admission snapshot so returning to the original thread
 * hydrates the runtime's durable user item and turn id instead.
 */
export function settleAcceptedTurnAfterNavigation(input: {
  threadId: string
  turnId: string
  userMessageItemId?: string
  modelLabel?: string
  queued?: QueuedUserMessage
  previousQueuedMessages: readonly QueuedUserMessage[]
}): void {
  if (input.userMessageItemId && input.modelLabel) {
    rememberTurnModel(input.threadId, input.userMessageItemId, input.modelLabel)
  }
  const queuedMessages = input.queued
    ? input.previousQueuedMessages.map((message) => message.id === input.queued?.id
        ? {
            ...message,
            deliveryState: 'in_flight' as const,
            deliveryTurnId: input.turnId,
            deliveryUserMessageItemId: input.userMessageItemId ?? message.id
          }
        : message)
    : input.previousQueuedMessages

  saveQueuedMessagesForThread(input.threadId, queuedMessages)
  invalidateThreadSnapshot(input.threadId)
}
