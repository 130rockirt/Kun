import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OFFICE_DOCUMENT_PREVIEW_CSP,
  type LocalOfficeDocumentReadResult
} from '@shared/office-document'
import { WorkspaceOfficePreview } from './WorkspaceOfficePreview'

const translate = (key: string, values?: Record<string, unknown>): string =>
  typeof values?.defaultValue === 'string' ? values.defaultValue : key

const htmlPreview: Extract<LocalOfficeDocumentReadResult, { ok: true }> = {
  ok: true,
  path: '/repo/reports/brief.docx',
  name: 'brief.docx',
  format: 'docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 128,
  mtimeMs: 100,
  sourceSha256: 'a'.repeat(64),
  documentText: 'Brief',
  pageCount: 3,
  truncated: false,
  sanitizedHtml: '<article><h1>Brief</h1></article>'
}

describe('WorkspaceOfficePreview', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  it('renders sanitized Office HTML in a scriptless, no-referrer iframe with zoom controls', async () => {
    await act(async () => {
      renderer = create(createElement(WorkspaceOfficePreview, {
        t: translate,
        result: htmlPreview,
        fileName: 'brief.docx',
        loading: true,
        navigation: { page: 1, sheetIndex: 0 },
        onPageChange: vi.fn(),
        onSheetChange: vi.fn()
      }))
    })

    const frame = renderer.root.findByType('iframe')
    expect(frame.props).toMatchObject({
      title: 'brief.docx',
      sandbox: '',
      referrerPolicy: 'no-referrer'
    })
    expect(frame.props.srcDoc).toContain('<article><h1>Brief</h1></article>')
    expect(frame.props.srcDoc).toContain(`Content-Security-Policy" content="${OFFICE_DOCUMENT_PREVIEW_CSP}`)
    expect(renderer.root.findByProps({ 'data-office-preview-state': 'refreshing' }).children)
      .toContain('Agent is updating this preview…')
    expect(renderer.root.findByProps({ 'aria-label': 'Reset zoom' }).children.join('')).toBe('100%')

    await act(async () => renderer.root.findByProps({ 'aria-label': 'Zoom in' }).props.onClick())
    expect(renderer.root.findByProps({ 'aria-label': 'Reset zoom' }).children.join('')).toBe('110%')

    await act(async () => renderer.root.findByProps({ 'aria-label': 'Reset zoom' }).props.onClick())
    expect(renderer.root.findByProps({ 'aria-label': 'Reset zoom' }).children.join('')).toBe('100%')
  })

  it('uses the rendered image fallback when OfficeCLI HTML is unavailable', async () => {
    const imagePreview: Extract<LocalOfficeDocumentReadResult, { ok: true }> = {
      ...htmlPreview,
      sanitizedHtml: undefined,
      visualPreview: {
        dataBase64: 'aW1hZ2U=',
        mimeType: 'image/png',
        byteSize: 8
      }
    }
    await act(async () => {
      renderer = create(createElement(WorkspaceOfficePreview, {
        t: translate,
        result: imagePreview,
        fileName: 'brief.docx',
        loading: false,
        navigation: { page: 1, sheetIndex: 0 },
        onPageChange: vi.fn(),
        onSheetChange: vi.fn()
      }))
    })

    expect(renderer.root.findAllByType('iframe')).toHaveLength(0)
    expect(renderer.root.findByType('img').props).toMatchObject({
      alt: 'brief.docx',
      src: 'data:image/png;base64,aW1hZ2U='
    })
  })

  it('navigates Word pages and selects the stable Excel worksheet tab', async () => {
    const onPageChange = vi.fn()
    const onSheetChange = vi.fn()
    await act(async () => {
      renderer = create(createElement(WorkspaceOfficePreview, {
        t: translate,
        result: htmlPreview,
        fileName: 'brief.docx',
        loading: false,
        navigation: { page: 2, sheetIndex: 0 },
        onPageChange,
        onSheetChange
      }))
    })

    expect(renderer.root.findByProps({ 'aria-label': 'Page 2 of 3' }).children.join('')).toBe('Page 2 / 3')
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Next page' }).props.onClick())
    expect(onPageChange).toHaveBeenCalledWith(3)

    const workbook = { ...htmlPreview, format: 'xlsx' as const, sheetNames: ['Summary', 'Data'] }
    await act(async () => {
      renderer.update(createElement(WorkspaceOfficePreview, {
        t: translate,
        result: workbook,
        fileName: 'budget.xlsx',
        loading: false,
        navigation: { page: 1, sheetIndex: 0 },
        onPageChange,
        onSheetChange
      }))
    })
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Worksheet' }).props.onChange({
      target: { value: '1' }
    }))
    expect(onSheetChange).toHaveBeenCalledWith(1)
  })
})
