import type { CellObject, Range, WorkSheet } from 'xlsx'
import type {
  KnowledgeOfficeArtifact,
  KnowledgeOfficeEvidenceChunk,
  KnowledgeSourceFile
} from './knowledge-types.js'
import { readOfficeBytes } from './knowledge-office-source.js'

const MAX_WORKSHEETS = 100
const MAX_POPULATED_CELLS = 100_000
const MAX_EVIDENCE_CHARS = 1_000_000
const WINDOW_ROWS = 100
const WINDOW_COLUMNS = 100

export async function extractSpreadsheetKnowledge(
  file: KnowledgeSourceFile,
  format: 'xls' | 'xlsx',
  sourceSha256: string
): Promise<KnowledgeOfficeArtifact> {
  const xlsx = await import('xlsx')
  if (format === 'xls') {
    const codepage = await import('xlsx/dist/cpexcel.full.mjs')
    xlsx.set_cptable(codepage)
  }
  const workbook = xlsx.read(await readOfficeBytes(file), {
    type: 'array', dense: false, cellDates: false, cellFormula: true,
    cellNF: false, cellStyles: false
  })
  const chunks: KnowledgeOfficeEvidenceChunk[] = []
  const diagnostics: string[] = []
  let cellsSeen = 0
  let charsSeen = 0
  let truncated = false

  for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
    if (sheetIndex >= MAX_WORKSHEETS) {
      truncated = true
      diagnostics.push(`Worksheet limit reached (${MAX_WORKSHEETS})`)
      break
    }
    const sheetName = workbook.SheetNames[sheetIndex]!
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const sparse = sparseEntries(
      sheet,
      xlsx.utils.decode_cell,
      Math.max(0, MAX_POPULATED_CELLS - cellsSeen)
    )
    const entries = sparse.entries
    if (sparse.truncated) truncated = true
    const sheetRange = normalizeRange(sheet['!ref'] || rangeForEntries(entries), xlsx.utils.decode_range, xlsx.utils.encode_range)
    const sheetKey = `sheet:${sheetIndex}`
    chunks.push({
      key: sheetKey,
      kind: 'worksheet',
      title: sheetName,
      summary: `${entries.length} populated cells in ${sheetRange}`,
      location: { kind: 'spreadsheet', sheetName, range: sheetRange },
      text: `[Worksheet] ${sheetName}\nRange: ${sheetRange}`
    })
    const groups = groupEntries(entries)
    for (const [windowKey, values] of groups) {
      if (cellsSeen >= MAX_POPULATED_CELLS || charsSeen >= MAX_EVIDENCE_CHARS) {
        truncated = true
        break
      }
      const accepted = values.slice(0, MAX_POPULATED_CELLS - cellsSeen)
      cellsSeen += accepted.length
      const bounds = mergedBounds(boundsForEntries(accepted), sheet['!merges'] ?? [])
      const range = xlsx.utils.encode_range(bounds)
      const evidence = accepted.map(({ address, cell }) => {
        const value = formattedCellText(cell)
        return `${address}\t${value}${cell.f ? `\t[formula: =${cell.f}]` : ''}`
      }).join('\n')
      const remaining = MAX_EVIDENCE_CHARS - charsSeen
      const text = evidence.slice(0, Math.max(0, remaining))
      charsSeen += text.length
      if (text.length < evidence.length || accepted.length < values.length) truncated = true
      chunks.push({
        key: `${sheetKey}:range:${windowKey}`,
        parentKey: sheetKey,
        kind: 'cell-range',
        title: range,
        summary: compact(text).slice(0, 280),
        location: { kind: 'spreadsheet', sheetName, range },
        text
      })
    }
  }
  if (chunks.every((chunk) => chunk.kind === 'worksheet')) {
    throw new Error('The workbook contains no readable populated cells')
  }
  return {
    version: 1,
    extractorVersion: 'office-v1',
    sourceSha256,
    format,
    truncated,
    chunks,
    diagnostics
  }
}

type SparseEntry = { address: string; cell: CellObject; row: number; column: number }

function sparseEntries(
  sheet: WorkSheet,
  decode: (address: string) => { r: number; c: number },
  limit: number
): { entries: SparseEntry[]; truncated: boolean } {
  const entries: SparseEntry[] = []
  let truncated = false
  for (const address in sheet) {
    if (address.startsWith('!')) continue
    if (entries.length >= limit) {
      truncated = true
      break
    }
    const cell = sheet[address] as CellObject | undefined
    if (!cell) continue
    try {
      const point = decode(address)
      entries.push({ address, cell, row: point.r, column: point.c })
    } catch {
      // Ignore malformed sparse keys emitted by a damaged workbook.
    }
  }
  entries.sort((left, right) => left.row - right.row || left.column - right.column)
  return { entries, truncated }
}

function groupEntries(entries: SparseEntry[]): Map<string, SparseEntry[]> {
  const groups = new Map<string, SparseEntry[]>()
  for (const entry of entries) {
    const key = `${Math.floor(entry.row / WINDOW_ROWS)}:${Math.floor(entry.column / WINDOW_COLUMNS)}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return groups
}

function boundsForEntries(entries: SparseEntry[]): Range {
  return entries.reduce<Range>((range, entry) => ({
    s: { r: Math.min(range.s.r, entry.row), c: Math.min(range.s.c, entry.column) },
    e: { r: Math.max(range.e.r, entry.row), c: Math.max(range.e.c, entry.column) }
  }), { s: { r: Number.MAX_SAFE_INTEGER, c: Number.MAX_SAFE_INTEGER }, e: { r: 0, c: 0 } })
}

function mergedBounds(bounds: Range, merges: Range[]): Range {
  let current = bounds
  let changed = true
  while (changed) {
    changed = false
    for (const merge of merges) {
      if (!rangesIntersect(current, merge)) continue
      const next = {
        s: { r: Math.min(current.s.r, merge.s.r), c: Math.min(current.s.c, merge.s.c) },
        e: { r: Math.max(current.e.r, merge.e.r), c: Math.max(current.e.c, merge.e.c) }
      }
      if (next.s.r !== current.s.r || next.s.c !== current.s.c || next.e.r !== current.e.r || next.e.c !== current.e.c) {
        current = next
        changed = true
      }
    }
  }
  return current
}

function rangesIntersect(left: Range, right: Range): boolean {
  return left.s.r <= right.e.r && left.e.r >= right.s.r && left.s.c <= right.e.c && left.e.c >= right.s.c
}

function formattedCellText(cell: CellObject): string {
  if (typeof cell.w === 'string') return cell.w
  if (cell.v instanceof Date) return cell.v.toISOString()
  if (cell.v !== undefined && cell.v !== null) return String(cell.v)
  return cell.f ? `=${cell.f}` : ''
}

function rangeForEntries(entries: SparseEntry[]): string {
  if (entries.length === 0) return 'A1:A1'
  const bounds = boundsForEntries(entries)
  return `${columnName(bounds.s.c)}${bounds.s.r + 1}:${columnName(bounds.e.c)}${bounds.e.r + 1}`
}

function normalizeRange(
  value: string,
  decode: (range: string) => Range,
  encode: (range: Range) => string
): string {
  try { return encode(decode(value)) } catch { return 'A1:A1' }
}

function columnName(column: number): string {
  let value = column + 1
  let output = ''
  while (value > 0) {
    value -= 1
    output = String.fromCharCode(65 + value % 26) + output
    value = Math.floor(value / 26)
  }
  return output
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
