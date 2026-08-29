/** One IPC message carries every SSE event parsed from a network chunk. */
export type SseEventPayload = { streamId: string; events: unknown[]; batchId?: string }

export type SseEndPayload = { streamId: string }

export type SseErrorPayload = {
  streamId: string
  status?: number
  message?: string
  code?: 'replay_reset_required'
  threadId?: string
  floorSeq?: number
}
