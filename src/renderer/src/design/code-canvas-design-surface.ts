import { create } from 'zustand'
import {
  readBrowserStorageItem,
  removeBrowserStorageItem,
  writeBrowserStorageItem
} from '../lib/browser-storage'

/**
 * "Open a design document in the Code whiteboard panel" target.
 *
 * The Code right-panel whiteboard normally shows the active chat thread's own
 * canvas (`code-<threadId>`). When the user asks to view a 设计稿 (from the
 * prototype card or the sidebar design tree), the panel switches to that
 * document's design board instead — without leaving the chat route. The target
 * is scoped to a thread so the panel falls back to the thread canvas whenever
 * a different thread is active.
 *
 * The last target survives panel collapse and renderer reload. A locked runtime
 * Design profile remains authoritative and reasserts this cache on thread load.
 * `surfaceKind` disambiguates the three whiteboard hosts (lightweight code
 * canvas, full `.kun-design` document, central Work whiteboard) and
 * `boardArtifactId` pins the board within a multi-board document, so a mode
 * switch can never remount an unrelated blank canvas.
 */
export type CodeCanvasDesignSurface = {
  surfaceKind?: 'kun-canvas' | 'kun-design' | 'kun-whiteboards'
  threadId: string
  workspaceRoot: string
  documentId: string
  boardArtifactId?: string
  /** Browsing a non-canonical drawing never changes the task's writable target. */
  readOnly?: boolean
  canonicalDocumentId?: string
  /** Durable local clone marker consumed by the first accepted Design turn. */
  continuationOperationId?: string
} | null

type CodeCanvasDesignSurfaceState = {
  surface: CodeCanvasDesignSurface
  showDesignDocument: (
    threadId: string,
    workspaceRoot: string,
    documentId: string,
    options?: {
      surfaceKind?: 'kun-canvas' | 'kun-design' | 'kun-whiteboards'
      boardArtifactId?: string
      readOnly?: boolean
      canonicalDocumentId?: string
      continuationOperationId?: string
    }
  ) => void
  clearDesignSurface: () => void
  /**
   * Atomically restore a previously captured target after a failed Design
   * send deleted its provisional document. `null` clears the cache so the
   * Code whiteboard falls back to the thread canvas instead of permanently
   * mounting a deleted Design document.
   */
  restoreDesignSurface: (previous: CodeCanvasDesignSurface) => void
}

const CODE_CANVAS_DESIGN_SURFACE_KEY = 'kun.codeCanvas.designSurface.v2'

function readPersistedSurface(): CodeCanvasDesignSurface {
  const raw = readBrowserStorageItem(CODE_CANVAS_DESIGN_SURFACE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<NonNullable<CodeCanvasDesignSurface>>
    const threadId = parsed.threadId?.trim() ?? ''
    const workspaceRoot = parsed.workspaceRoot?.trim() ?? ''
    const documentId = parsed.documentId?.trim() ?? ''
    const boardArtifactId = parsed.boardArtifactId?.trim() ?? ''
    const canonicalDocumentId = parsed.canonicalDocumentId?.trim() ?? ''
    const continuationOperationId = parsed.continuationOperationId?.trim() ?? ''
    return threadId && workspaceRoot && documentId
      ? {
          threadId, workspaceRoot, documentId,
          surfaceKind: parsed.surfaceKind ?? 'kun-design',
          ...(boardArtifactId ? { boardArtifactId } : {}),
          ...(parsed.readOnly === true ? { readOnly: true } : {}),
          ...(canonicalDocumentId ? { canonicalDocumentId } : {}),
          ...(continuationOperationId ? { continuationOperationId } : {})
        }
      : null
  } catch {
    return null
  }
}

export const useCodeCanvasDesignSurface = create<CodeCanvasDesignSurfaceState>((set) => ({
  surface: readPersistedSurface(),
  showDesignDocument: (threadId, workspaceRoot, documentId, options) => {
    const surface = {
      threadId, workspaceRoot, documentId,
      surfaceKind: options?.surfaceKind ?? 'kun-design',
      ...(options?.boardArtifactId ? { boardArtifactId: options.boardArtifactId } : {}),
      ...(options?.readOnly ? { readOnly: true } : {}),
      ...(options?.canonicalDocumentId ? { canonicalDocumentId: options.canonicalDocumentId } : {}),
      ...(options?.continuationOperationId
        ? { continuationOperationId: options.continuationOperationId }
        : {})
    }
    writeBrowserStorageItem(CODE_CANVAS_DESIGN_SURFACE_KEY, JSON.stringify(surface))
    set({ surface })
  },
  clearDesignSurface: () => {
    removeBrowserStorageItem(CODE_CANVAS_DESIGN_SURFACE_KEY)
    set({ surface: null })
  },
  restoreDesignSurface: (previous) => {
    if (!previous) {
      removeBrowserStorageItem(CODE_CANVAS_DESIGN_SURFACE_KEY)
      set({ surface: null })
      return
    }
    writeBrowserStorageItem(CODE_CANVAS_DESIGN_SURFACE_KEY, JSON.stringify(previous))
    set({ surface: previous })
  }
}))
