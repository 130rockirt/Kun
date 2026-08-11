import type { CellObject, Range, WorkSheet } from 'xlsx'

export const SPREADSHEET_WINDOW_ROWS = 200
export const SPREADSHEET_WINDOW_COLUMNS = 100
export const SPREADSHEET_MAX_ROWS = 1_048_576
export const SPREADSHEET_MAX_COLUMNS = 16_384
const MAX_VISIBLE_MERGES = 200

type SheetJsUtils = Pick<typeof import('xlsx')['utils'], 'decode_range' | 'encode_cell' | 'encode_col'>

export type SpreadsheetWindowCell = {
  key: string
  text: string
  formula?: string
  rowSpan?: number
  colSpan?: number
  hidden?: boolean
}

export type SpreadsheetWindow = {
  range: Range
  rowStart: number
  rowEnd: number
  columnStart: number
  columnEnd: number
  columnLabels: string[]
  rows: Array<{ rowNumber: number; cells: SpreadsheetWindowCell[] }>
}

type VisibleMergeCell = {
  hidden?: true
  rowSpan?: number
  colSpan?: number
  sourceRow?: number
  sourceColumn?: number
}

export function readSpreadsheetRange(utils: SheetJsUtils, sheet: WorkSheet): Range {
  let decoded: Range
  try {
    decoded = utils.decode_range(typeof sheet['!ref'] === 'string' ? sheet['!ref'] : 'A1:A1')
  } catch {
    decoded = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
  }
  const startRow = clampInteger(decoded.s.r, 0, SPREADSHEET_MAX_ROWS - 1)
  const startColumn = clampInteger(decoded.s.c, 0, SPREADSHEET_MAX_COLUMNS - 1)
  return {
    s: { r: startRow, c: startColumn },
    e: {
      r: Math.max(startRow, clampInteger(decoded.e.r, 0, SPREADSHEET_MAX_ROWS - 1)),
      c: Math.max(startColumn, clampInteger(decoded.e.c, 0, SPREADSHEET_MAX_COLUMNS - 1))
    }
  }
}

export function buildSpreadsheetWindow(
  utils: SheetJsUtils,
  sheet: WorkSheet,
  requestedRowStart: number,
  requestedColumnStart: number
): SpreadsheetWindow {
  const range = readSpreadsheetRange(utils, sheet)
  const rowStart = windowStart(requestedRowStart, range.s.r, range.e.r, SPREADSHEET_WINDOW_ROWS)
  const columnStart = windowStart(
    requestedColumnStart,
    range.s.c,
    range.e.c,
    SPREADSHEET_WINDOW_COLUMNS
  )
  const rowEnd = Math.min(range.e.r, rowStart + SPREADSHEET_WINDOW_ROWS - 1)
  const columnEnd = Math.min(range.e.c, columnStart + SPREADSHEET_WINDOW_COLUMNS - 1)
  const mergeCells = visibleMergeCells(sheet, rowStart, rowEnd, columnStart, columnEnd)
  const rows: SpreadsheetWindow['rows'] = []

  for (let row = rowStart; row <= rowEnd; row += 1) {
    const cells: SpreadsheetWindowCell[] = []
    for (let column = columnStart; column <= columnEnd; column += 1) {
      const key = `${row}:${column}`
      const merge = mergeCells.get(key)
      if (merge?.hidden) {
        cells.push({ key, text: '', hidden: true })
        continue
      }
      const sourceRow = merge?.sourceRow ?? row
      const sourceColumn = merge?.sourceColumn ?? column
      const cell = sheet[utils.encode_cell({ r: sourceRow, c: sourceColumn })] as
        | CellObject
        | undefined
      cells.push({
        key,
        text: formattedCellText(cell),
        ...(cell?.f ? { formula: `=${cell.f}` } : {}),
        ...(merge?.rowSpan && merge.rowSpan > 1 ? { rowSpan: merge.rowSpan } : {}),
        ...(merge?.colSpan && merge.colSpan > 1 ? { colSpan: merge.colSpan } : {})
      })
    }
    rows.push({ rowNumber: row + 1, cells })
  }

  return {
    range,
    rowStart,
    rowEnd,
    columnStart,
    columnEnd,
    columnLabels: Array.from(
      { length: columnEnd - columnStart + 1 },
      (_, index) => utils.encode_col(columnStart + index)
    ),
    rows
  }
}

function formattedCellText(cell: CellObject | undefined): string {
  if (!cell) return ''
  if (typeof cell.w === 'string') return cell.w
  if (cell.v !== undefined && cell.v !== null) {
    return cell.v instanceof Date ? cell.v.toLocaleString() : String(cell.v)
  }
  return cell.f ? `=${cell.f}` : ''
}

function visibleMergeCells(
  sheet: WorkSheet,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number
): Map<string, VisibleMergeCell> {
  const result = new Map<string, VisibleMergeCell>()
  const merges = Array.isArray(sheet['!merges']) ? sheet['!merges'] : []
  let represented = 0
  for (const merge of merges) {
    if (represented >= MAX_VISIBLE_MERGES) break
    const visibleRowStart = Math.max(rowStart, merge.s.r)
    const visibleRowEnd = Math.min(rowEnd, merge.e.r)
    const visibleColumnStart = Math.max(columnStart, merge.s.c)
    const visibleColumnEnd = Math.min(columnEnd, merge.e.c)
    if (visibleRowStart > visibleRowEnd || visibleColumnStart > visibleColumnEnd) continue
    represented += 1
    result.set(`${visibleRowStart}:${visibleColumnStart}`, {
      rowSpan: visibleRowEnd - visibleRowStart + 1,
      colSpan: visibleColumnEnd - visibleColumnStart + 1,
      sourceRow: merge.s.r,
      sourceColumn: merge.s.c
    })
    for (let row = visibleRowStart; row <= visibleRowEnd; row += 1) {
      for (let column = visibleColumnStart; column <= visibleColumnEnd; column += 1) {
        if (row !== visibleRowStart || column !== visibleColumnStart) {
          result.set(`${row}:${column}`, { hidden: true })
        }
      }
    }
  }
  return result
}

function windowStart(requested: number, minimum: number, maximum: number, size: number): number {
  const latest = Math.max(minimum, maximum - size + 1)
  return clampInteger(requested, minimum, latest)
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}
