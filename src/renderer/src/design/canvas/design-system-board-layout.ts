import { create } from 'zustand'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'
import { getCanvasDocumentContentBounds } from './canvas-placement'
import { useProjectDesignSystemStore } from './project-design-system-store'
import type { CanvasDocument, Rect, ViewBox } from './canvas-types'

export const DESIGN_SYSTEM_BOARD_WIDTH = 1240
export const DESIGN_SYSTEM_BOARD_HEIGHT = 700
export const DESIGN_SYSTEM_BOARD_REGION_ID = 'project-design-system-board'

type DesignSystemBoardLayoutState = {
  rects: Record<string, Rect>
}

const STORAGE_PREFIX = 'kun:design-system-board-layout:v1:'

export const useDesignSystemBoardLayoutStore = create<DesignSystemBoardLayoutState>(() => ({
  rects: {}
}))

function storageKey(documentKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(documentKey)}`
}

function validRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Partial<Rect>
  return [rect.x, rect.y, rect.width, rect.height].every(
    (part) => typeof part === 'number' && Number.isFinite(part)
  ) && Number(rect.width) > 0 && Number(rect.height) > 0
}

function persistedRect(documentKey: string): Rect | null {
  const raw = readBrowserStorageItem(storageKey(documentKey))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return validRect(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function defaultDesignSystemBoardRect(document: CanvasDocument, viewBox: ViewBox): Rect {
  const bounds = getCanvasDocumentContentBounds(document)
  return bounds
    ? {
        x: bounds.x - DESIGN_SYSTEM_BOARD_WIDTH - 120,
        y: bounds.y,
        width: DESIGN_SYSTEM_BOARD_WIDTH,
        height: DESIGN_SYSTEM_BOARD_HEIGHT
      }
    : {
        x: viewBox.x + 80,
        y: viewBox.y + 80,
        width: DESIGN_SYSTEM_BOARD_WIDTH,
        height: DESIGN_SYSTEM_BOARD_HEIGHT
      }
}

export function storedDesignSystemBoardRect(documentKey: string | null | undefined): Rect | null {
  if (!documentKey) return null
  return useDesignSystemBoardLayoutStore.getState().rects[documentKey] ?? persistedRect(documentKey)
}

export function setDesignSystemBoardRect(
  documentKey: string,
  rect: Rect,
  options?: { persist?: boolean }
): void {
  useDesignSystemBoardLayoutStore.setState((state) => ({
    rects: { ...state.rects, [documentKey]: rect }
  }))
  if (options?.persist !== false) {
    writeBrowserStorageItem(storageKey(documentKey), JSON.stringify(rect))
  }
}

export function commitDesignSystemBoardRect(documentKey: string): void {
  const rect = useDesignSystemBoardLayoutStore.getState().rects[documentKey]
  if (rect) writeBrowserStorageItem(storageKey(documentKey), JSON.stringify(rect))
}

export function visibleDesignSystemBoardRect(
  documentKey: string | null | undefined,
  document: CanvasDocument,
  viewBox: ViewBox
): Rect | null {
  if (!documentKey) return null
  if (!documentKey.includes('\0.kun-design/')) return null
  const system = useProjectDesignSystemStore.getState()
  if (system.workspaceRoot && !documentKey.startsWith(`${system.workspaceRoot}\0`)) return null
  if (!system.document || system.status === 'loading' || system.status === 'missing') return null
  return storedDesignSystemBoardRect(documentKey) ?? defaultDesignSystemBoardRect(document, viewBox)
}

export function translateDesignSystemBoardRect(
  origin: Rect,
  delta: { x: number; y: number },
  scale: { x: number; y: number }
): Rect {
  return {
    ...origin,
    x: Math.round(origin.x + delta.x * scale.x),
    y: Math.round(origin.y + delta.y * scale.y)
  }
}

export function resetDesignSystemBoardLayoutForTests(): void {
  useDesignSystemBoardLayoutStore.setState({ rects: {} })
}
