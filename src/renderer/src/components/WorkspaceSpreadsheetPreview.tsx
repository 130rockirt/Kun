import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { WorkBook } from 'xlsx'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WorkspaceOfficePreviewToolbar } from './WorkspaceOfficePreviewToolbar'
import {
  SPREADSHEET_WINDOW_COLUMNS,
  SPREADSHEET_WINDOW_ROWS,
  buildSpreadsheetWindow,
  readSpreadsheetRange
} from './workspace-spreadsheet-model'

type SheetJs = typeof import('xlsx')

type ParsedWorkbook = {
  xlsx: SheetJs
  workbook: WorkBook
}

export function WorkspaceSpreadsheetPreview({
  result,
  loading,
  refreshError
}: {
  result: WorkspaceOfficePreviewSuccess
  loading: boolean
  refreshError?: string | null
}): ReactElement {
  const [parsed, setParsed] = useState<ParsedWorkbook | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [rowStart, setRowStart] = useState(0)
  const [columnStart, setColumnStart] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void import('xlsx')
      .then(async (xlsx) => {
        if (result.renderFormat === 'xls') {
          const codepage = await import('xlsx/dist/cpexcel.full.mjs')
          xlsx.set_cptable(codepage.default)
        }
        const workbook = xlsx.read(result.data, {
          type: 'array',
          dense: false,
          cellDates: false,
          cellFormula: true,
          cellNF: false,
          cellStyles: false
        })
        if (workbook.SheetNames.length === 0) throw new Error('The workbook contains no worksheets.')
        if (disposed) return
        setParsed({ xlsx, workbook })
        setSheetIndex(0)
        setRowStart(0)
        setColumnStart(0)
        setError(null)
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause))
      })
    return () => {
      disposed = true
    }
  }, [result.data, result.renderFormat, result.sourceSha256])

  const activeSheetName = parsed?.workbook.SheetNames[sheetIndex]
  const activeSheet = activeSheetName ? parsed?.workbook.Sheets[activeSheetName] : undefined
  const tableWindow = useMemo(() => {
    if (!parsed || !activeSheet) return null
    return buildSpreadsheetWindow(parsed.xlsx.utils, activeSheet, rowStart, columnStart)
  }, [activeSheet, columnStart, parsed, rowStart])

  const selectSheet = (nextSheetIndex: number): void => {
    if (!parsed) return
    const safeIndex = Math.max(0, Math.min(nextSheetIndex, parsed.workbook.SheetNames.length - 1))
    const name = parsed.workbook.SheetNames[safeIndex]
    const sheet = name ? parsed.workbook.Sheets[name] : undefined
    setSheetIndex(safeIndex)
    if (sheet) {
      const range = readSpreadsheetRange(parsed.xlsx.utils, sheet)
      setRowStart(range.s.r)
      setColumnStart(range.s.c)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ds-surface-subtle">
      <WorkspaceOfficePreviewToolbar
        result={result}
        loading={loading}
        refreshError={refreshError}
        viewerError={error}
        zoom={zoom}
        onZoomChange={setZoom}
      >
        {parsed ? (
          <select
            aria-label="Worksheet"
            className="max-w-44 rounded border border-ds-border-muted bg-ds-card px-1 py-0.5 text-[11px] text-ds-ink"
            value={sheetIndex}
            onChange={(event) => selectSheet(Number.parseInt(event.target.value, 10))}
          >
            {parsed.workbook.SheetNames.map((name, index) => (
              <option key={`${index}-${name}`} value={index}>{name}</option>
            ))}
          </select>
        ) : null}
        {tableWindow ? (
          <>
            <SpreadsheetPager
              label="Rows"
              start={tableWindow.rowStart}
              end={tableWindow.rowEnd}
              minimum={tableWindow.range.s.r}
              maximum={tableWindow.range.e.r}
              pageSize={SPREADSHEET_WINDOW_ROWS}
              onChange={setRowStart}
            />
            <SpreadsheetPager
              label="Columns"
              start={tableWindow.columnStart}
              end={tableWindow.columnEnd}
              minimum={tableWindow.range.s.c}
              maximum={tableWindow.range.e.c}
              pageSize={SPREADSHEET_WINDOW_COLUMNS}
              onChange={setColumnStart}
            />
          </>
        ) : null}
      </WorkspaceOfficePreviewToolbar>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tableWindow ? (
          <div className="origin-top-left" style={{ width: `${100 / zoom}%`, transform: `scale(${zoom})` }}>
            <table className="border-collapse bg-white text-[11px] text-slate-900 shadow-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 min-w-12 border border-slate-300 bg-slate-100 px-2 py-1" />
                  {tableWindow.columnLabels.map((label) => (
                    <th key={label} scope="col" className="sticky top-0 z-10 min-w-24 border border-slate-300 bg-slate-100 px-2 py-1 text-center font-semibold">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableWindow.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <th scope="row" className="sticky left-0 z-10 border border-slate-300 bg-slate-100 px-2 py-1 text-right font-semibold">{row.rowNumber}</th>
                    {row.cells.map((cell) => cell.hidden ? null : (
                      <td
                        key={cell.key}
                        rowSpan={cell.rowSpan}
                        colSpan={cell.colSpan}
                        title={cell.formula}
                        className="max-w-80 whitespace-pre-wrap border border-slate-300 px-2 py-1 align-top"
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !error ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ds-muted">Loading workbook…</div>
        ) : null}
      </div>
    </div>
  )
}

function SpreadsheetPager({
  label,
  start,
  end,
  minimum,
  maximum,
  pageSize,
  onChange
}: {
  label: string
  start: number
  end: number
  minimum: number
  maximum: number
  pageSize: number
  onChange: (start: number) => void
}): ReactElement {
  return (
    <div className="flex items-center gap-1 rounded border border-ds-border-muted px-1 py-0.5">
      <button type="button" aria-label={`Previous ${label.toLowerCase()}`} disabled={start <= minimum} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => onChange(Math.max(minimum, start - pageSize))}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span>{label} {start + 1}–{end + 1} / {maximum + 1}</span>
      <button type="button" aria-label={`Next ${label.toLowerCase()}`} disabled={end >= maximum} className="rounded p-0.5 hover:bg-ds-hover disabled:opacity-40" onClick={() => onChange(Math.min(maximum, start + pageSize))}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message || 'This workbook could not be rendered.'
}
