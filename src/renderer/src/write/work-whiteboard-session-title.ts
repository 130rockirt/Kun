import type { NormalizedThread } from '../agent/types'
import type { WorkWhiteboard } from './write-workspace-store-types'

type SessionTitleThread = Pick<NormalizedThread, 'id' | 'title'>

export type WorkWhiteboardSessionTitleUpdate = {
  boardId: string
  title: string
}

export function workWhiteboardSessionTitleUpdates(
  whiteboards: Record<string, WorkWhiteboard>,
  threads: readonly SessionTitleThread[],
  workspaceRoot: string
): WorkWhiteboardSessionTitleUpdate[] {
  const titlesByThreadId = new Map(threads.map((thread) => [thread.id, thread.title.trim()]))
  return Object.values(whiteboards).flatMap((board) => {
    if (board.workspaceRoot !== workspaceRoot || !board.threadId) return []
    const title = titlesByThreadId.get(board.threadId) ?? ''
    return title && title !== board.title ? [{ boardId: board.id, title }] : []
  })
}

export async function renameWorkWhiteboardSession(input: {
  board: WorkWhiteboard
  title: string
  renameSession: (threadId: string, title: string) => Promise<void>
  readSessionTitle: (threadId: string) => string | null
  renameWhiteboard: (boardId: string, title: string) => Promise<boolean>
}): Promise<boolean> {
  const title = input.title.trim()
  if (!title) return false
  if (input.board.threadId) {
    await input.renameSession(input.board.threadId, title)
    if (input.readSessionTitle(input.board.threadId)?.trim() !== title) return false
  }
  return input.renameWhiteboard(input.board.id, title)
}
