import { basename } from 'node:path'
import type { CellObject, WorkSheet } from 'xlsx'
import {
  MAX_RUNTIME_DOCUMENT_TEXT_CHARS,
  type OfficeDocumentFormat,
  type WorkspaceOfficeSemanticResult,
  type WorkspaceOfficeSemanticTarget
} from '../../shared/office-document'
import { extractOfficeDocumentSemanticText } from './office-document-service'
import { createOfficeDocumentSnapshot } from './office-document-snapshot'
import {
  readWorkspaceOfficePreview,
  type WorkspaceOfficePreviewDependencies
} from './office-workspace-preview-service'

type OfficeCliResult = { stdout: string; stderr: string; exitCode: number }

export type WorkspaceOfficeSemanticDependencies = WorkspaceOfficePreviewDependencies & {
  binaryPath?: string
  runOfficeCli?: (args: string[]) => Promise<OfficeCliResult>
  readPreview?: typeof readWorkspaceOfficePreview
}

export async function readWorkspaceOfficeSemantic(
  target: Omit<WorkspaceOfficeSemanticTarget, 'workspaceRoot'>,
  dependencies: WorkspaceOfficeSemanticDependencies = {}
): Promise<WorkspaceOfficeSemanticResult> {
  let snapshot: Awaited<ReturnType<typeof createOfficeDocumentSnapshot>> | undefined
  try {
    const preview = await (dependencies.readPreview ?? readWorkspaceOfficePreview)(target, dependencies)
    if (!preview.ok) return preview
    let rawText: string
    if (preview.viewer === 'spreadsheet') {
      rawText = await extractSpreadsheetText(preview.data, preview.renderFormat === 'xls')
    } else {
      if (!dependencies.binaryPath && !dependencies.runOfficeCli) {
        return {
          ok: false,
          code: 'officecli_unavailable',
          message: 'Office semantic reading is unavailable because the bundled OfficeCLI binary was not found.'
        }
      }
      const format = preview.renderFormat as OfficeDocumentFormat
      snapshot = await createOfficeDocumentSnapshot(preview.data, format)
      rawText = await extractOfficeDocumentSemanticText(snapshot.path, format, {
        binaryPath: dependencies.binaryPath ?? 'officecli',
        signal: dependencies.signal,
        runOfficeCli: dependencies.runOfficeCli
      })
    }
    const truncated = rawText.length > MAX_RUNTIME_DOCUMENT_TEXT_CHARS
    return {
      ok: true,
      path: preview.path,
      name: basename(preview.path),
      sourceFormat: preview.sourceFormat,
      sourceSha256: preview.sourceSha256,
      text: truncated ? rawText.slice(0, MAX_RUNTIME_DOCUMENT_TEXT_CHARS) : rawText,
      truncated
    }
  } catch (error) {
    return {
      ok: false,
      code: 'office_semantic_failed',
      message: boundedError(error)
    }
  } finally {
    await snapshot?.cleanup().catch(() => undefined)
  }
}

async function extractSpreadsheetText(data: Uint8Array, legacy: boolean): Promise<string> {
  const xlsx = await import('xlsx')
  if (legacy) {
    const codepage = await import('xlsx/dist/cpexcel.full.mjs')
    xlsx.set_cptable(codepage.default)
  }
  const workbook = xlsx.read(data, {
    type: 'array',
    dense: false,
    cellDates: false,
    cellFormula: true,
    cellNF: false,
    cellStyles: false
  })
  const output: string[] = []
  let outputLength = 0
  for (const name of workbook.SheetNames) {
    append(`[Worksheet] ${name}`)
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const entries = sparseSheetEntries(sheet, xlsx.utils.decode_cell)
    for (const [address, cell] of entries) {
      const text = formattedCellText(cell)
      if (!text && !cell.f) continue
      append(`${address} = ${text}${cell.f ? ` [formula: =${cell.f}]` : ''}`)
      if (outputLength >= MAX_RUNTIME_DOCUMENT_TEXT_CHARS + 1) return output.join('\n')
    }
    append('')
  }
  const text = output.join('\n').trim()
  if (!text) throw new Error('The workbook contains no semantic cell content.')
  return text

  function append(line: string): void {
    if (outputLength >= MAX_RUNTIME_DOCUMENT_TEXT_CHARS + 1) return
    output.push(line)
    outputLength += line.length + 1
  }
}

function sparseSheetEntries(
  sheet: WorkSheet,
  decodeCell: (address: string) => { r: number; c: number }
): Array<[string, CellObject]> {
  return Object.keys(sheet)
    .filter((key) => !key.startsWith('!'))
    .flatMap((address): Array<[string, CellObject, number, number]> => {
      const cell = sheet[address] as CellObject | undefined
      if (!cell) return []
      try {
        const point = decodeCell(address)
        return [[address, cell, point.r, point.c]]
      } catch {
        return []
      }
    })
    .sort((left, right) => left[2] - right[2] || left[3] - right[3])
    .map(([address, cell]) => [address, cell])
}

function formattedCellText(cell: CellObject): string {
  if (typeof cell.w === 'string') return cell.w
  if (cell.v !== undefined && cell.v !== null) {
    return cell.v instanceof Date ? cell.v.toISOString() : String(cell.v)
  }
  return cell.f ? `=${cell.f}` : ''
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message
}
