import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceUniverSpreadsheetEditor } from './WorkspaceUniverSpreadsheetEditor'

const mocks = vi.hoisted(() => ({
  disposeUniver: vi.fn(),
  disposeCommand: vi.fn(),
  disposeSelection: vi.fn(),
  createWorkbook: vi.fn(),
  getSnapshot: vi.fn(() => ({ id: 'book', sheetOrder: ['sheet_1'], sheets: {} })),
  commandCallback: undefined as undefined | (() => void),
  selectionCallback: undefined as undefined | ((params: unknown) => void),
  baseline: { sourceSha256: 'a'.repeat(64), sheetOrder: ['sheet_1'], sheets: {} },
  workbookData: { id: 'book', sheetOrder: ['sheet_1'], sheets: {} }
}))

vi.mock('@univerjs/presets', () => ({
  LocaleType: { ZH_CN: 'zhCN' },
  mergeLocales: vi.fn((value) => value),
  createUniver: vi.fn(() => ({
    univer: { dispose: mocks.disposeUniver },
    univerAPI: {
      Event: { CommandExecuted: 'CommandExecuted', SelectionChanged: 'SelectionChanged' },
      createWorkbook: mocks.createWorkbook,
      getActiveWorkbook: () => ({ getSnapshot: mocks.getSnapshot }),
      addEvent: (event: string, callback: (params: unknown) => void) => {
        if (event === 'CommandExecuted') {
          mocks.commandCallback = callback as () => void
          return { dispose: mocks.disposeCommand }
        }
        mocks.selectionCallback = callback
        return { dispose: mocks.disposeSelection }
      }
    }
  }))
}))

vi.mock('@univerjs/preset-sheets-core', () => ({
  UniverSheetsCorePreset: vi.fn((config) => ({ config }))
}))

vi.mock('@univerjs/preset-sheets-core/locales/zh-CN', () => ({ default: { locale: 'zhCN' } }))
vi.mock('xlsx', () => ({ read: vi.fn(() => ({ SheetNames: ['Data'], Sheets: { Data: {} } })) }))
vi.mock('../lib/workspace-univer-model', () => ({
  sheetJsWorkbookToUniver: vi.fn(() => ({
    workbookData: mocks.workbookData,
    baseline: mocks.baseline
  })),
  applySpreadsheetMutations: vi.fn((data) => data),
  normalizeUniverWorkbook: vi.fn(() => mocks.baseline),
  diffUniverWorkbook: vi.fn(() => ({
    mutations: [{ kind: 'cell', sheetName: 'Data', address: 'A1', value: 42 }]
  }))
}))
vi.mock('../lib/workspace-xlsx-style-reader', () => ({
  readXlsxStyleOverrides: vi.fn(async () => ({}))
}))

const result = {
  ok: true as const,
  path: '/work/book.xlsx',
  name: 'book.xlsx',
  sourceFormat: 'xlsx' as const,
  renderFormat: 'xlsx' as const,
  viewer: 'spreadsheet' as const,
  size: 10,
  mtimeMs: 1,
  sourceSha256: 'a'.repeat(64),
  data: new Uint8Array([1])
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  const target = new EventTarget()
  vi.stubGlobal('window', Object.assign(target, {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  }))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.disposeUniver.mockClear()
  mocks.disposeCommand.mockClear()
  mocks.disposeSelection.mockClear()
  mocks.createWorkbook.mockClear()
  mocks.commandCallback = undefined
  mocks.selectionCallback = undefined
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WorkspaceUniverSpreadsheetEditor', () => {
  it('creates a workbook, publishes mutations and selections, and disposes the session', async () => {
    const onMutationsChange = vi.fn()
    const onSelectionChange = vi.fn()
    const host = { replaceChildren: vi.fn() }
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(WorkspaceUniverSpreadsheetEditor, {
        result,
        mutations: [],
        sourceSha256: result.sourceSha256,
        commitRevision: 0,
        focused: true,
        onMutationsChange,
        onSelectionChange
      }), { createNodeMock: () => host })
      await flush()
    })
    expect(mocks.createWorkbook).toHaveBeenCalledWith(mocks.workbookData)

    await act(async () => {
      mocks.commandCallback?.()
      await vi.advanceTimersByTimeAsync(120)
    })
    expect(onMutationsChange).toHaveBeenCalledWith([
      { kind: 'cell', sheetName: 'Data', address: 'A1', value: 42 }
    ], undefined)

    act(() => mocks.selectionCallback?.({
      worksheet: {
        getName: () => 'Data',
        getRange: () => ({
          getA1Notation: () => 'A1:B1',
          getValues: () => [['A', 2]],
          getFormulas: () => [['', '=SUM(A1:A2)']]
        })
      },
      selections: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }]
    }))
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'spreadsheet',
      sourceFormat: 'xlsx',
      sheetName: 'Data',
      cellRange: 'A1:B1',
      text: 'A\t2',
      formulas: ['B1: =SUM(A1:A2)']
    }))

    await act(async () => renderer.unmount())
    expect(mocks.disposeCommand).toHaveBeenCalledOnce()
    expect(mocks.disposeSelection).toHaveBeenCalledOnce()
    expect(mocks.disposeUniver).toHaveBeenCalledOnce()
    expect(host.replaceChildren).toHaveBeenCalled()
  })
})
