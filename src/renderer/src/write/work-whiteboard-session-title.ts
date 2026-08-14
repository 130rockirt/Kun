import type { WorkWhiteboard } from './write-workspace-store-types'

/**
 * Explicit rename path shared by the sidebar dialog and the
 * `work_rename_whiteboard` renderer hook. A rename is user/agent intent, so it
 * updates the bound session and the whiteboard together. This is intentionally
 * the ONLY thread -> board title write: automatic session titles never flow
 * back into the whiteboard registry.
 */
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
