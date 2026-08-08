import { create } from 'zustand'

/**
 * Transient "open a design document in the Code whiteboard panel" target.
 *
 * The Code right-panel whiteboard normally shows the active chat thread's own
 * canvas (`code-<threadId>`). When the user asks to view a 设计稿 (from the
 * prototype card or the sidebar design tree), the panel switches to that
 * document's design board instead — without leaving the chat route. The target
 * is scoped to a thread so the panel falls back to the thread canvas whenever
 * a different thread is active.
 *
 * The surface is intentionally transient: `CodeCanvasPanel` clears it when the
 * panel unmounts (tab close / collapse), so the next manual whiteboard open
 * returns to the thread's own canvas.
 */
export type CodeCanvasDesignSurface = {
  threadId: string
  workspaceRoot: string
  documentId: string
} | null

type CodeCanvasDesignSurfaceState = {
  surface: CodeCanvasDesignSurface
  showDesignDocument: (threadId: string, workspaceRoot: string, documentId: string) => void
  clearDesignSurface: () => void
}

export const useCodeCanvasDesignSurface = create<CodeCanvasDesignSurfaceState>((set) => ({
  surface: null,
  showDesignDocument: (threadId, workspaceRoot, documentId) =>
    set({ surface: { threadId, workspaceRoot, documentId } }),
  clearDesignSurface: () => set({ surface: null })
}))
