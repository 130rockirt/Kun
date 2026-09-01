import type { QueuedUserMessage } from './chat-store-types'

type EditableQueuedMessage = Pick<QueuedUserMessage,
  | 'text'
  | 'displayText'
  | 'deliveryState'
  | 'deliveryTurnId'
  | 'deliveryUserMessageItemId'
  | 'waitForRuntimeAdmission'
  | 'mode'
  | 'agentSurface'
  | 'subagentResume'
  | 'messageSource'
  | 'attachmentIds'
  | 'attachments'
  | 'fileReferences'
  | 'composerContexts'
  | 'guiPlan'
  | 'guiDesignCanvas'
  | 'guiDesignMode'
  | 'guiDesignArtifact'
  | 'designProfile'
  | 'designDocumentTarget'
  | 'designImagePlacementTarget'
  | 'writeContext'
>

/** True only when changing visible text cannot desynchronize a structured queued prompt. */
export function canInlineEditQueuedMessage(message: EditableQueuedMessage): boolean {
  if (!message.text.trim()) return false
  if (message.displayText !== undefined && message.displayText !== message.text) return false
  if (message.deliveryState !== undefined && message.deliveryState !== 'pending') return false
  if (message.deliveryTurnId || message.deliveryUserMessageItemId || message.waitForRuntimeAdmission) return false
  if (message.mode === 'plan' || message.mode === 'auto') return false
  if (message.agentSurface === 'write' || message.agentSurface === 'design') return false
  return !(
    message.subagentResume || message.messageSource ||
    message.attachmentIds?.length || message.attachments?.length ||
    message.fileReferences?.length || message.composerContexts?.length ||
    message.guiPlan || message.guiDesignCanvas || message.guiDesignMode ||
    message.guiDesignArtifact || message.designProfile || message.designDocumentTarget ||
    message.designImagePlacementTarget || message.writeContext
  )
}

export function editQueuedMessageInQueue(
  messages: QueuedUserMessage[],
  id: string,
  text: string,
  nextClientRequestId: string
): { messages: QueuedUserMessage[]; edited: boolean } {
  const normalized = text.trim()
  const requestId = nextClientRequestId.trim()
  const index = messages.findIndex((message) => message.id === id)
  const current = messages[index]
  if (!normalized || !requestId || !current || !canInlineEditQueuedMessage(current)) {
    return { messages, edited: false }
  }
  const next: QueuedUserMessage = {
    ...current,
    text: normalized,
    clientRequestId: requestId,
    ...(current.displayText !== undefined ? { displayText: normalized } : {})
  }
  delete next.backgroundRuntimeText
  delete next.backgroundCheckpointRequestId
  const updated = [...messages]
  updated[index] = next
  return { messages: updated, edited: true }
}
