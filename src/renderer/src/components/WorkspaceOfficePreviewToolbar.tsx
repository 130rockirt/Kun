import { Minus, Plus, RotateCcw } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'

export const OFFICE_PREVIEW_MIN_ZOOM = 0.6
export const OFFICE_PREVIEW_MAX_ZOOM = 1.6
export const OFFICE_PREVIEW_ZOOM_STEP = 0.1

export function nextOfficePreviewZoom(current: number, delta: number): number {
  return Math.max(
    OFFICE_PREVIEW_MIN_ZOOM,
    Math.min(OFFICE_PREVIEW_MAX_ZOOM, Math.round((current + delta) * 10) / 10)
  )
}

export function WorkspaceOfficePreviewToolbar({
  result,
  loading,
  refreshError,
  viewerError,
  zoom,
  onZoomChange,
  children
}: {
  result: WorkspaceOfficePreviewSuccess
  loading: boolean
  refreshError?: string | null
  viewerError?: string | null
  zoom: number
  onZoomChange: (zoom: number) => void
  children?: ReactNode
}): ReactElement {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted bg-ds-card px-3 py-2 text-[11px] text-ds-muted">
      <span className="rounded-md border border-ds-border-muted px-2 py-1 font-semibold uppercase">
        {result.sourceFormat}
        {result.convertedFromLegacy ? ` → ${result.renderFormat}` : ''}
      </span>
      {children}
      {loading ? (
        <span data-office-preview-state="refreshing">Agent is updating this preview…</span>
      ) : null}
      {refreshError || viewerError ? (
        <span className="text-red-700 dark:text-red-300">{viewerError || refreshError}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          aria-label="Zoom out"
          className="rounded p-1 hover:bg-ds-hover disabled:opacity-40"
          disabled={zoom <= OFFICE_PREVIEW_MIN_ZOOM}
          onClick={() => onZoomChange(nextOfficePreviewZoom(zoom, -OFFICE_PREVIEW_ZOOM_STEP))}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          className="min-w-10 rounded px-1 py-0.5 hover:bg-ds-hover"
          onClick={() => onZoomChange(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          className="rounded p-1 hover:bg-ds-hover disabled:opacity-40"
          disabled={zoom >= OFFICE_PREVIEW_MAX_ZOOM}
          onClick={() => onZoomChange(nextOfficePreviewZoom(zoom, OFFICE_PREVIEW_ZOOM_STEP))}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <RotateCcw className="ml-1 h-3.5 w-3.5 text-ds-faint" aria-label="Read-only preview" />
      </div>
    </div>
  )
}
