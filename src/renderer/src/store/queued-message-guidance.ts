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
  attachmentIds?: string[]
}

/**
 * Resolve the payload that can safely replace a queued send as live steering.
 * Design canvas turns queue an expanded internal prompt plus renderer-only
 * routing flags. The running Design turn already owns that canvas context, so
 * its visible user text is the correct steering payload.
 */
export function queuedMessageGuidancePayload(
  message: QueuedMessageGuidanceInput
): QueuedMessageGuidancePayload | null {
  const attachmentIds = normalizedAttachmentIds(message.attachmentIds)
  const hasAttachmentReferences = Boolean(message.attachments?.length)
  if (
    !message.text.trim() ||
    attachmentIds === null ||
    (hasAttachmentReferences && attachmentIds.length === 0) ||
    message.attachments?.some((attachment) => !isImageAttachmentReference(attachment)) ||
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
    return {
      text: displayText,
      displayText,
      ...(attachmentIds.length ? { attachmentIds } : {})
    }
  }

  const text = message.text.trim()
  const displayText = message.displayText?.trim()
  return {
    text,
    ...(displayText ? { displayText } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {})
  }
}

/** True when the steer contract can preserve the queued text and optional images. */
export function canGuideQueuedMessage(message: QueuedUserMessage): boolean {
  return queuedMessageGuidancePayload(message) !== null
}

function normalizedAttachmentIds(values: readonly unknown[] | undefined): string[] | null {
  if (!values?.length) return []
  const ids = values.map((value) => typeof value === 'string' ? value.trim() : '')
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null
  return ids
}

function isImageAttachmentReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === undefined || kind === 'image'
}
