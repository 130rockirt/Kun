import { useEffect } from 'react'
import type { ToolBlock } from '../../agent/types'
import { sendCanvasTurnReceipt } from '../../design/canvas/canvas-receipt-sender'
import { useChatStore } from '../../store/chat-store'
import { renameWorkWhiteboardSession } from '../../write/work-whiteboard-session-title'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'

const WORK_RENAME_WHITEBOARD_TOOL_NAME = 'work_rename_whiteboard'

export type WorkWhiteboardRenameRequest = {
  title: string
  receiptKey: string
  turnId: string
}

export function workWhiteboardRenameRequestFromBlock(
  block: ToolBlock,
  currentTurnId?: string | null
): WorkWhiteboardRenameRequest | null {
  const sourceItemKind = block.meta?.sourceItemKind
  if (
    block.status !== 'success' ||
    block.meta?.toolName !== WORK_RENAME_WHITEBOARD_TOOL_NAME ||
    (sourceItemKind !== undefined && sourceItemKind !== 'tool_result')
  ) return null
  const detail = block.detail?.trim()
  if (!detail) return null
  try {
    const value = JSON.parse(detail) as Record<string, unknown>
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, 160) : ''
    const receiptKey = typeof value.receiptKey === 'string' ? value.receiptKey.trim() : ''
    const turnId = block.turnId?.trim() || currentTurnId?.trim() || ''
    if (
      value.tool !== WORK_RENAME_WHITEBOARD_TOOL_NAME ||
      value.action !== 'rename_whiteboard' ||
      value.status !== 'accepted' ||
      !title ||
      !receiptKey ||
      !turnId
    ) return null
    return { title, receiptKey, turnId }
  } catch {
    return null
  }
}

/** Applies renderer-owned Work metadata mutations while their originating turn is live. */
export function useWorkWhiteboardRenameLive(input: {
  boardId: string
  threadId: string | null
}): void {
  useEffect(() => {
    const threadId = input.threadId?.trim()
    if (!threadId) return
    const appliedBlockIds = new Set<string>()
    const inFlightBlockIds = new Set<string>()

    const process = (state: ReturnType<typeof useChatStore.getState>): void => {
      if (state.activeThreadId !== threadId) return
      for (const block of state.blocks) {
        if (
          block.kind !== 'tool' ||
          appliedBlockIds.has(block.id) ||
          inFlightBlockIds.has(block.id)
        ) continue
        const request = workWhiteboardRenameRequestFromBlock(block, state.currentTurnId)
        if (!request) continue
        inFlightBlockIds.add(block.id)
        void (async () => {
          const errors: Array<{ code: string; message: string; suggestion?: string }> = []
          let renamed = false
          try {
            const writeState = useWriteWorkspaceStore.getState()
            const board = writeState.whiteboards[input.boardId]
            if (!board || board.threadId !== threadId) {
              errors.push({
                code: 'WORK_WHITEBOARD_NOT_FOUND',
                message: 'The active Work whiteboard no longer matches this conversation.',
                suggestion: 'Open the intended Work whiteboard and retry the rename.'
              })
            } else {
              renamed = await renameWorkWhiteboardSession({
                board,
                title: request.title,
                renameSession: useChatStore.getState().renameThread,
                readSessionTitle: (id) => useChatStore.getState().threads
                  .find((thread) => thread.id === id)?.title ?? null,
                renameWhiteboard: useWriteWorkspaceStore.getState().renameWhiteboard
              })
              if (!renamed) {
                errors.push({
                  code: 'WORK_WHITEBOARD_RENAME_FAILED',
                  message: 'The Work whiteboard title could not be persisted.',
                  suggestion: 'Check workspace write access and retry the rename.'
                })
              }
            }
          } catch (error) {
            errors.push({
              code: 'WORK_WHITEBOARD_RENAME_FAILED',
              message: error instanceof Error ? error.message : String(error)
            })
          } finally {
            inFlightBlockIds.delete(block.id)
            appliedBlockIds.add(block.id)
            sendCanvasTurnReceipt({
              threadId,
              turnId: request.turnId,
              receiptKey: request.receiptKey,
              affectedIds: renamed ? [`whiteboard:${input.boardId}`] : [],
              errors
            })
          }
        })()
      }
    }

    process(useChatStore.getState())
    return useChatStore.subscribe(process)
  }, [input.boardId, input.threadId])
}
