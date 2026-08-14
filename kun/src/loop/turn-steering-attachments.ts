import type { AttachmentStore } from '../attachments/attachment-store.js'
import {
  MAX_TURN_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENT_IDS
} from '../contracts/attachments.js'
import type { SteeringEntry, Turn } from '../contracts/turns.js'

type TurnAttachmentState = Pick<Turn, 'attachmentIds' | 'items'>

export function collectTurnAttachmentIds(
  turn: TurnAttachmentState,
  steeringEntries: readonly Pick<SteeringEntry, 'attachmentIds'>[] = []
): string[] {
  return [...new Set([
    ...(turn.attachmentIds ?? []),
    ...turn.items.flatMap((item) =>
      item.kind === 'user_message' ? (item.attachmentIds ?? []) : []
    ),
    ...steeringEntries.flatMap((entry) => entry.attachmentIds ?? [])
  ].map((id) => id.trim()).filter(Boolean))]
}

export async function validateAndBindImageSteeringAttachments(input: {
  attachmentIds: readonly string[]
  turn: TurnAttachmentState
  steeringEntries: readonly Pick<SteeringEntry, 'attachmentIds'>[]
  attachmentStore: AttachmentStore | undefined
  threadId: string
  workspace?: string
}): Promise<string[]> {
  const attachmentIds = input.attachmentIds.map((id) => id.trim())
  if (attachmentIds.length === 0) return []
  if (attachmentIds.some((id) => !id)) throw new Error('attachment ids must not be blank')
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('attachment ids must not contain duplicates')
  }
  if (!input.attachmentStore) throw new Error('attachment store is unavailable')

  const cumulativeIds = collectTurnAttachmentIds(input.turn, input.steeringEntries)
  if (cumulativeIds.length > MAX_TURN_ATTACHMENT_IDS) {
    throw new Error(`turn exceeds ${MAX_TURN_ATTACHMENT_IDS} attachment limit`)
  }
  const scope = {
    threadId: input.threadId,
    ...(input.workspace ? { workspace: input.workspace } : {})
  }
  const contents = await Promise.all(
    cumulativeIds.map((id) => input.attachmentStore!.resolveContent(id, scope))
  )
  const incomingIds = new Set(attachmentIds)
  for (const attachment of contents) {
    if (incomingIds.has(attachment.id) && attachment.kind !== 'image') {
      throw new Error(`steering attachment must be an image: ${attachment.id}`)
    }
  }
  const totalBytes = contents.reduce((bytes, attachment) => bytes + attachment.data.byteLength, 0)
  if (totalBytes > MAX_TURN_ATTACHMENT_BYTES) {
    throw new Error(`turn attachments exceed ${MAX_TURN_ATTACHMENT_BYTES} byte limit`)
  }
  await input.attachmentStore.bindScopes(attachmentIds, scope)
  return attachmentIds
}
