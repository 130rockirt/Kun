import type { QueuedUserMessage } from './chat-store-types'

export type QueuedMessageGuidanceInput = {
  text: string
  displayText?: string
  attachmentIds?: readonly unknown[]
  attachments?: readonly unknown[]
  fileReferences?: readonly unknown[]
  composerContexts?: readonly unknown[]
  guiPlan?: unknown
  guiDesignCanvas?: boolean
  guiDesignMode?: boolean
  guiDesignArtifact?: unknown
  writeContext?: unknown
}

export type QueuedMessageGuidancePayload = {
  text: string
  displayText?: string
}

/**
 * Resolve the text that can safely replace a queued send as live steering.
 * Design canvas turns queue an expanded internal prompt plus renderer-only
 * routing flags. The running Design turn already owns that canvas context, so
 * its visible user text is the correct steering payload.
 */
export function queuedMessageGuidancePayload(
  message: QueuedMessageGuidanceInput
): QueuedMessageGuidancePayload | null {
  if (
    !message.text.trim() ||
    message.attachmentIds?.length ||
    message.attachments?.length ||
    message.fileReferences?.length ||
    message.composerContexts?.length ||
    message.guiPlan ||
    message.guiDesignArtifact ||
    message.writeContext
  ) {
    return null
  }

  const hasDesignRouting = message.guiDesignCanvas === true || message.guiDesignMode === true
  if (hasDesignRouting) {
    const displayText = message.displayText?.trim()
    if (
      message.guiDesignCanvas !== true ||
      message.guiDesignMode !== true ||
      !displayText
    ) {
      return null
    }
    return { text: displayText, displayText }
  }

  const text = message.text.trim()
  const displayText = message.displayText?.trim()
  return {
    text,
    ...(displayText ? { displayText } : {})
  }
}

/** True when the text-only steer contract can preserve the queued user intent. */
export function canGuideQueuedMessage(message: QueuedUserMessage): boolean {
  return queuedMessageGuidancePayload(message) !== null
}
