import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import {
  officeDocumentPreviewSrcDoc,
  type WorkspaceOfficePreviewResult
} from '@shared/office-document'

type Translate = (key: string, values?: Record<string, unknown>) => string

type WorkspaceOfficePreviewProps = {
  t: Translate
  result: Extract<WorkspaceOfficePreviewResult, { ok: true }>
  fileName: string
  loading: boolean
  refreshError?: string | null
  navigation: { page: number; sheetIndex: number }
  onPageChange: (page: number) => void
  onSheetChange: (sheetIndex: number) => void
}

const MIN_ZOOM = 0.6
const MAX_ZOOM = 1.6
const ZOOM_STEP = 0.1

function nextZoom(current: number, delta: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round((current + delta) * 10) / 10))
}

function isDocumentPageFormat(format: string): boolean {
  return format === 'doc' || format === 'docx' || format === 'ppt' || format === 'pptx'
}

function isWorksheetFormat(format: string): boolean {
  return format === 'xls' || format === 'xlsx'
}

export function WorkspaceOfficePreview({
  t,
  result,
  fileName,
  loading,
  refreshError,
  navigation,
  onPageChange,
  onSheetChange
}: WorkspaceOfficePreviewProps): ReactElement {
  const [zoom, setZoom] = useState(1)
  const hasHtml = Boolean(result.sanitizedHtml)
  const zoomPercent = Math.round(zoom * 100)
  const pageCount = result.pageCount ?? 1
  const selectedPage = Math.min(pageCount, Math.max(1, navigation.page))
  const worksheetNames = result.sheetNames?.length
    ? result.sheetNames
    : isWorksheetFormat(result.format)
      ? Array.from({ length: pageCount }, (_, index) => `Sheet ${index + 1}`)
      : []
  const selectedSheetIndex = Math.min(
    Math.max(0, navigation.sheetIndex),
    Math.max(0, worksheetNames.length - 1)
  )
  const pageLabel = result.format === 'ppt' || result.format === 'pptx' ? 'Slide' : 'Page'

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ds-surface-subtle">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted bg-ds-card px-3 py-2 text-[11px] text-ds-muted">
        <span className="rounded-md border border-ds-border-muted px-2 py-1 font-semibold uppercase">{result.format}</span>
        {result.pageCount ? <span>{t('filePreviewOfficePages', { count: result.pageCount, defaultValue: '{{count}} pages' })}</span> : null}
        {isDocumentPageFormat(result.format) && pageCount > 1 ? (
          <div className="flex items-center gap-1 rounded border border-ds-border-muted px-1 py-0.5">
            <button
              type="button"
              aria-label={`Previous ${pageLabel.toLowerCase()}`}
              className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40"
              disabled={selectedPage <= 1}
              onClick={() => onPageChange(selectedPage - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span aria-label={`${pageLabel} ${selectedPage} of ${pageCount}`}>{pageLabel} {selectedPage} / {pageCount}</span>
            <button
              type="button"
              aria-label={`Next ${pageLabel.toLowerCase()}`}
              className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40"
              disabled={selectedPage >= pageCount}
              onClick={() => onPageChange(selectedPage + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {isWorksheetFormat(result.format) && worksheetNames.length > 1 ? (
          <label className="flex items-center gap-1">
            <span className="sr-only">Worksheet</span>
            <select
              aria-label="Worksheet"
              className="max-w-36 rounded border border-ds-border-muted bg-ds-card px-1 py-0.5 text-[11px] text-ds-ink"
              value={selectedSheetIndex}
              onChange={(event) => onSheetChange(Number.parseInt(event.target.value, 10))}
            >
              {worksheetNames.map((name, index) => <option key={`${index}-${name}`} value={index}>{name}</option>)}
            </select>
          </label>
        ) : null}
        {result.truncated ? <span>{t('filePreviewTruncated')}</span> : null}
        {loading ? <span data-office-preview-state="refreshing">Agent is updating this preview…</span> : null}
        {refreshError ? <span className="text-red-700 dark:text-red-300">{refreshError}</span> : null}
        {hasHtml ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label="Zoom out"
              className="rounded p-1 hover:bg-ds-hover disabled:opacity-40"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom((current) => nextZoom(current, -ZOOM_STEP))}
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              className="min-w-10 rounded px-1 py-0.5 hover:bg-ds-hover"
              onClick={() => setZoom(1)}
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              className="rounded p-1 hover:bg-ds-hover disabled:opacity-40"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((current) => nextZoom(current, ZOOM_STEP))}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <RotateCcw className="ml-1 h-3.5 w-3.5 text-ds-faint" aria-label="Read-only preview" />
          </div>
        ) : null}
      </div>
      {hasHtml ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div
            className="origin-top-left bg-white shadow-sm"
            style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})` }}
          >
            <iframe
              title={fileName}
              srcDoc={officeDocumentPreviewSrcDoc(result.sanitizedHtml ?? '')}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-full min-h-[720px] w-full border-0 bg-white"
            />
          </div>
        </div>
      ) : result.visualPreview ? (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <img
            src={`data:${result.visualPreview.mimeType};base64,${result.visualPreview.dataBase64}`}
            alt={fileName}
            className="mx-auto block max-h-full max-w-full rounded-lg border border-ds-border-muted bg-white object-contain shadow-sm"
          />
        </div>
      ) : (
        <pre className="m-5 overflow-auto whitespace-pre-wrap rounded-lg border border-ds-border-muted bg-ds-card p-4 text-[12px] leading-6 text-ds-ink">
          {result.documentText || result.previewUnavailableReason || t('filePreviewFailed')}
        </pre>
      )}
    </div>
  )
}
