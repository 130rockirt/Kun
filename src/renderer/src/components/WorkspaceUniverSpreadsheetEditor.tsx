import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import type {
  WorkspaceOfficePreviewSuccess,
  WorkspaceOfficeSelection
} from '@shared/office-document'
import type { WorkspaceSpreadsheetMutation } from '@shared/workspace-spreadsheet'
import {
  applySpreadsheetMutations,
  diffUniverWorkbook,
  normalizeUniverWorkbook,
  sheetJsWorkbookToUniver,
  type NormalizedSpreadsheetWorkbook
} from '../lib/workspace-univer-model'
import '@univerjs/preset-sheets-core/lib/index.css'
import { readXlsxStyleOverrides } from '../lib/workspace-xlsx-style-reader'

type Props = {
  result: WorkspaceOfficePreviewSuccess
  mutations: WorkspaceSpreadsheetMutation[]
  sourceSha256: string
  commitRevision: number
  focused: boolean
  onMutationsChange: (mutations: WorkspaceSpreadsheetMutation[], unsupportedReason?: string) => void
  onSelectionChange?: (selection: WorkspaceOfficeSelection) => void
}

type UniverSession = {
  univer: { dispose: () => void }
  univerAPI: UniverApi
  baseline: NormalizedSpreadsheetWorkbook
}

type UniverApi = {
  Event: {
    CommandExecuted: 'CommandExecuted'
    SelectionChanged: 'SelectionChanged'
  }
  addEvent: (event: string, callback: (params: any) => void) => { dispose: () => void }
  createWorkbook: (data: IWorkbookData) => unknown
  getActiveWorkbook: () => {
    getSnapshot: () => IWorkbookData
  } | null
}

export function WorkspaceUniverSpreadsheetEditor({
  result,
  mutations,
  sourceSha256,
  commitRevision,
  focused,
  onMutationsChange,
  onSelectionChange
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<UniverSession | null>(null)
  const callbackRef = useRef(onMutationsChange)
  const selectionRef = useRef(onSelectionChange)
  const sourceShaRef = useRef(sourceSha256)
  const mutationsRef = useRef(mutations)
  const lastCommitRef = useRef(commitRevision)
  const seenMutationsRef = useRef(JSON.stringify(mutations))
  const mutationTimerRef = useRef<number | null>(null)
  const [externalEpoch, setExternalEpoch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  callbackRef.current = onMutationsChange
  selectionRef.current = onSelectionChange
  sourceShaRef.current = sourceSha256
  mutationsRef.current = mutations

  useEffect(() => {
    const next = JSON.stringify(mutations)
    if (next === seenMutationsRef.current) return
    seenMutationsRef.current = next
    if (sessionRef.current) setExternalEpoch((value) => value + 1)
  }, [mutations])

  useEffect(() => {
    if (lastCommitRef.current === commitRevision) return
    lastCommitRef.current = commitRevision
    const workbook = sessionRef.current?.univerAPI.getActiveWorkbook()
    if (!workbook || !sessionRef.current) return
    sessionRef.current.baseline = normalizeUniverWorkbook(workbook.getSnapshot(), sourceShaRef.current)
    seenMutationsRef.current = '[]'
  }, [commitRevision])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const disposables: Array<{ dispose: () => void }> = []
    setLoading(true)
    setError(null)
    host.replaceChildren()

    void Promise.all([
      import('@univerjs/presets'),
      import('@univerjs/preset-sheets-core'),
      import('@univerjs/preset-sheets-core/locales/zh-CN'),
      import('xlsx')
    ]).then(async ([presets, sheetPreset, localeModule, xlsx]) => {
      if (disposed) return
      if (result.sourceFormat !== 'xlsx' || result.renderFormat !== 'xlsx') {
        throw new Error('Univer editing requires an XLSX source.')
      }
      const parsed = xlsx.read(result.data, {
        type: 'array',
        dense: false,
        cellDates: false,
        cellFormula: true,
        cellNF: true,
        cellStyles: true
      })
      const styleOverrides = await readXlsxStyleOverrides(result.data, parsed)
      if (disposed) return
      const converted = sheetJsWorkbookToUniver(
        parsed,
        result.sourceSha256,
        result.name,
        styleOverrides
      )
      const initialMutations = mutationsRef.current
      const initialData = applySpreadsheetMutations(converted.workbookData, initialMutations)
      const { univer, univerAPI } = presets.createUniver({
        locale: presets.LocaleType.ZH_CN,
        locales: {
          [presets.LocaleType.ZH_CN]: presets.mergeLocales(localeModule.default)
        },
        presets: [sheetPreset.UniverSheetsCorePreset({
          container: host,
          disableAutoFocus: true,
          header: true,
          toolbar: true,
          formulaBar: true,
          footer: {
            sheetBar: true,
            statisticBar: true,
            menus: true,
            zoomSlider: true,
            addSheetButtonConfig: { show: false }
          }
        })]
      })
      const api = univerAPI as unknown as UniverApi
      api.createWorkbook(initialData)
      sessionRef.current = { univer, univerAPI: api, baseline: converted.baseline }
      seenMutationsRef.current = JSON.stringify(initialMutations)

      const scheduleDiff = (): void => {
        if (disposed || !focused) return
        if (mutationTimerRef.current !== null) window.clearTimeout(mutationTimerRef.current)
        mutationTimerRef.current = window.setTimeout(() => {
          mutationTimerRef.current = null
          const session = sessionRef.current
          const workbook = session?.univerAPI.getActiveWorkbook()
          if (!session || !workbook) return
          const diff = diffUniverWorkbook(session.baseline, workbook.getSnapshot())
          const serialized = JSON.stringify(diff.mutations)
          seenMutationsRef.current = serialized
          callbackRef.current(diff.mutations, diff.unsupportedReason)
        }, 120)
      }
      disposables.push(api.addEvent(api.Event.CommandExecuted, scheduleDiff))
      disposables.push(api.addEvent(api.Event.SelectionChanged, (params: {
        worksheet?: {
          getName: () => string
          getRange: (range: unknown) => {
            getA1Notation: () => string
            getValues: () => Array<Array<unknown>>
            getFormulas: () => string[][]
          }
        }
        selections?: Array<{
          startRow: number
          startColumn: number
          endRow: number
          endColumn: number
        }>
      }) => {
        const worksheet = params.worksheet
        const rangeData = params.selections?.at(-1)
        if (!worksheet || !rangeData || !selectionRef.current) return
        const range = worksheet.getRange(rangeData)
        const values = range.getValues()
        const formulas = range.getFormulas()
        const lines = values.map((row) => row.map(formatCellValue).join('\t'))
        const text = lines.join('\n').trim()
        const annotations = formulas.flatMap((row, rowIndex) => row.flatMap((formula, columnIndex) => (
          formula
            ? [`${cellAddress(rangeData.startRow + rowIndex, rangeData.startColumn + columnIndex)}: ${formula}`]
            : []
        )))
        const selectionText = text || annotations.join('\n')
        selectionRef.current({
          sourceKind: 'spreadsheet',
          sourceFormat: 'xlsx',
          text: selectionText,
          charCount: Array.from(selectionText).length,
          sheetName: worksheet.getName(),
          cellRange: range.getA1Notation(),
          formulas: annotations
        })
      }))
      setLoading(false)
    }).catch((cause) => {
      if (!disposed) {
        setLoading(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })

    return () => {
      disposed = true
      if (mutationTimerRef.current !== null) window.clearTimeout(mutationTimerRef.current)
      mutationTimerRef.current = null
      for (const disposable of disposables) disposable.dispose()
      sessionRef.current?.univer.dispose()
      sessionRef.current = null
      host.replaceChildren()
    }
  }, [externalEpoch, focused, result.data, result.name, result.renderFormat, result.sourceFormat, result.sourceSha256])

  return (
    <div className="relative flex min-h-0 flex-1 bg-white dark:bg-[#111318]">
      <div ref={hostRef} className="min-h-0 min-w-0 flex-1 [&_.univer-app]:!h-full" />
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-ds-card/85 text-[13px] text-ds-muted backdrop-blur-sm">
          正在加载可编辑工作表…
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-ds-card px-8 text-center text-[13px] leading-6 text-red-600 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function cellAddress(row: number, column: number): string {
  let value = column + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + value % 26) + label
    value = Math.floor(value / 26)
  }
  return `${label}${row + 1}`
}
