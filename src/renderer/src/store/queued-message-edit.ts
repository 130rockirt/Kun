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
  | 'approvalPolicy'
  | 'sandboxMode'
  | 'approvalReviewer'
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

/** True when the whole queued payload (text + image attachments) can be faithfully returned to the composer. */
export function canRestoreQueuedMessageToComposer(message: EditableQueuedMessage): boolean {
  if (message.deliveryState !== undefined && message.deliveryState !== 'pending') return false
  if (message.deliveryTurnId || message.deliveryUserMessageItemId || message.waitForRuntimeAdmission) return false
  if (message.mode === 'plan' || message.mode === 'auto') return false
  if (message.agentSurface === 'write' || message.agentSurface === 'design') return false
  if (
    message.subagentResume || message.messageSource ||
    message.fileReferences?.length || message.composerContexts?.length ||
    message.guiPlan || message.guiDesignCanvas || message.guiDesignMode ||
    message.guiDesignArtifact || message.designProfile || message.designDocumentTarget ||
    message.designImagePlacementTarget || message.writeContext
  ) return false
  // Document content is already inlined into the text prompt and cannot be
  // faithfully rebuilt as a composer attachment.
  if (message.attachments?.some((attachment) => attachment.kind === 'document')) return false
  return Boolean(message.text.trim() || message.attachments?.length || message.attachmentIds?.length)
}

/** Composer text for a restore: image-only messages carry a synthesized prompt as `text`. */
export function queuedMessageComposerRestoreText(message: EditableQueuedMessage): string {
  if (message.displayText !== undefined && message.displayText !== message.text) return ''
  return message.text
}

export function restoreQueuedMessageFromQueue(
  messages: QueuedUserMessage[],
  id: string
): { messages: QueuedUserMessage[]; restored: QueuedUserMessage | null } {
  const current = messages.find((message) => message.id === id)
  if (!current || !canRestoreQueuedMessageToComposer(current)) {
    return { messages, restored: null }
  }
  return { messages: messages.filter((message) => message.id !== id), restored: current }
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
