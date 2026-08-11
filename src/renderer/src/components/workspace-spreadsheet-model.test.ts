import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { utils, type WorkSheet } from 'xlsx'
import {
  SPREADSHEET_MAX_ROWS,
  SPREADSHEET_WINDOW_COLUMNS,
  SPREADSHEET_WINDOW_ROWS,
  buildSpreadsheetWindow,
  readSpreadsheetRange
} from './workspace-spreadsheet-model'

describe('workspace spreadsheet window', () => {
  it('bounds row and column rendering and reaches later windows', () => {
    const sheet = utils.aoa_to_sheet([['first']])
    sheet['!ref'] = 'A1:ZZ999999999'

    const first = buildSpreadsheetWindow(utils, sheet, 0, 0)
    const later = buildSpreadsheetWindow(utils, sheet, 200, 100)

    expect(first.rows).toHaveLength(SPREADSHEET_WINDOW_ROWS)
    expect(first.columnLabels).toHaveLength(SPREADSHEET_WINDOW_COLUMNS)
    expect(later).toMatchObject({ rowStart: 200, columnStart: 100 })
    expect(readSpreadsheetRange(utils, sheet).e.r).toBe(SPREADSHEET_MAX_ROWS - 1)
  })

  it('represents visible merges and formula fallbacks', () => {
    const sheet: WorkSheet = {
      A1: { t: 's', v: 'heading', w: 'Heading' },
      C1: { t: 'n', f: 'SUM(A2:B2)' },
      A2: { t: 's', v: 'merged value' },
      '!ref': 'A1:C3',
      '!merges': [{ s: { r: 1, c: 0 }, e: { r: 2, c: 1 } }]
    }

    const view = buildSpreadsheetWindow(utils, sheet, 0, 0)
    const formula = view.rows[0]?.cells[2]
    const mergeAnchor = view.rows[1]?.cells[0]

    expect(formula).toMatchObject({ text: '=SUM(A2:B2)', formula: '=SUM(A2:B2)' })
    expect(mergeAnchor).toMatchObject({ text: 'merged value', rowSpan: 2, colSpan: 2 })
    expect(view.rows[1]?.cells[1]?.hidden).toBe(true)
    expect(view.rows[2]?.cells[0]?.hidden).toBe(true)
  })

  it('clips a merge across a paged window while retaining its anchor value', () => {
    const sheet: WorkSheet = {
      A1: { t: 's', v: 'spans windows' },
      '!ref': 'A1:C400',
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 299, c: 1 } }]
    }

    const secondWindow = buildSpreadsheetWindow(utils, sheet, 200, 0)

    expect(secondWindow.rows[0]?.cells[0]).toMatchObject({
      text: 'spans windows',
      rowSpan: 100,
      colSpan: 2
    })
    expect(secondWindow.rows[0]?.cells[1]?.hidden).toBe(true)
    expect(secondWindow.rows[99]?.cells[0]?.hidden).toBe(true)
  })

  it('keeps markup-like cell content inert when rendered as a React child', () => {
    const attack = '<script>globalThis.compromised = true</script>'
    const sheet = utils.aoa_to_sheet([[attack]])
    const cell = buildSpreadsheetWindow(utils, sheet, 0, 0).rows[0]?.cells[0]

    expect(cell?.text).toBe(attack)
    expect(renderToStaticMarkup(createElement('td', null, cell?.text))).toBe(
      '<td>&lt;script&gt;globalThis.compromised = true&lt;/script&gt;</td>'
    )
  })
})
