import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'

const libraryMocks = vi.hoisted(() => ({
  renderDocx: vi.fn(),
  initPptx: vi.fn(),
  readWorkbook: vi.fn(),
  setCodepage: vi.fn()
}))

vi.mock('docx-preview', () => ({ renderAsync: libraryMocks.renderDocx }))
vi.mock('pptx-preview', () => ({ init: libraryMocks.initPptx }))
vi.mock('xlsx/dist/cpexcel.full.mjs', () => ({ default: { codepages: true } }))
vi.mock('xlsx', () => ({
  read: libraryMocks.readWorkbook,
  set_cptable: libraryMocks.setCodepage,
  utils: {
    decode_range: (ref: string) => decodeRange(ref),
    encode_cell: ({ r, c }: { r: number; c: number }) => `${encodeColumn(c)}${r + 1}`,
    encode_col: encodeColumn
  }
}))

import { WorkspaceDocxPreview } from './WorkspaceDocxPreview'
import { WorkspacePptxPreview } from './WorkspacePptxPreview'
import { WorkspaceSpreadsheetPreview } from './WorkspaceSpreadsheetPreview'
import {
  openWorkspaceOfficeExternalLink,
  secureWorkspaceOfficeLinks
} from './workspace-office-external-link'

type MockPptxPreviewer = {
  slideCount: number
  preview: ReturnType<typeof vi.fn>
  renderSingleSlide: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function preview(
  viewer: WorkspaceOfficePreviewSuccess['viewer'],
  sha = 'a'.repeat(64),
  sourceFormat?: WorkspaceOfficePreviewSuccess['sourceFormat']
): WorkspaceOfficePreviewSuccess {
  const renderFormat = viewer === 'word' ? 'docx' : viewer === 'presentation' ? 'pptx' : sourceFormat === 'xls' ? 'xls' : 'xlsx'
  return {
    ok: true,
    path: `/repo/fixture.${sourceFormat ?? renderFormat}`,
    name: `fixture.${sourceFormat ?? renderFormat}`,
    sourceFormat: sourceFormat ?? renderFormat,
    renderFormat,
    viewer,
    size: 3,
    mtimeMs: 1,
    sourceSha256: sha,
    data: new Uint8Array([1, 2, 3])
  }
}

describe('browser Office renderers', () => {
  let dom: JSDOM
  let renderer: ReactTestRenderer | undefined
  let pptxInstances: MockPptxPreviewer[]

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    dom = new JSDOM('<!doctype html><html><body></body></html>')
    vi.stubGlobal('window', Object.assign(dom.window, {
      kunGui: { openExternal: vi.fn(async () => undefined) }
    }))
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Element', dom.window.Element)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    libraryMocks.renderDocx.mockReset()
    libraryMocks.renderDocx.mockImplementation(async (_data, body: HTMLElement) => {
      const first = document.createElement('section')
      const second = document.createElement('section')
      first.className = 'docx'
      second.className = 'docx'
      body.append(first, second)
    })
    pptxInstances = []
    libraryMocks.initPptx.mockReset()
    libraryMocks.initPptx.mockImplementation(() => {
      const instance = {
        slideCount: 3,
        preview: vi.fn(async () => undefined),
        renderSingleSlide: vi.fn(),
        destroy: vi.fn()
      }
      pptxInstances.push(instance)
      return instance
    })
    libraryMocks.readWorkbook.mockReset()
    libraryMocks.readWorkbook.mockReturnValue({
      SheetNames: ['Summary', 'Data'],
      Sheets: {
        Summary: { A1: { t: 's', v: 'Summary' }, '!ref': 'A1:B2' },
        Data: { A1: { t: 's', v: 'Data' }, '!ref': 'A1:A1' }
      }
    })
    libraryMocks.setCodepage.mockReset()
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
    dom.window.close()
    vi.unstubAllGlobals()
  })

  it('renders DOCX safely, navigates pages, zooms, and retains old DOM after refresh failure', async () => {
    await act(async () => {
      renderer = create(createElement(WorkspaceDocxPreview, {
        result: preview('word'),
        loading: false
      }), { createNodeMock })
      await flushPromises()
    })

    expect(libraryMocks.renderDocx).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(dom.window.HTMLElement),
      expect.any(dom.window.HTMLElement),
      expect.objectContaining({ renderAltChunks: false, breakPages: true, useBase64URL: true })
    )
    expect(renderer!.root.findByProps({ 'aria-label': 'Page 1 of 2' })).toBeTruthy()
    await act(async () => renderer?.root.findByProps({ 'aria-label': 'Next page' }).props.onClick())
    expect(renderer!.root.findByProps({ 'aria-label': 'Page 2 of 2' })).toBeTruthy()
    await act(async () => renderer?.root.findByProps({ 'aria-label': 'Zoom in' }).props.onClick())
    expect(renderer!.root.findByProps({ 'aria-label': 'Reset zoom' }).children.join('')).toBe('110%')

    const anchor = document.createElement('a')
    const linkContainer = document.createElement('div')
    const anchorText = document.createElement('span')
    anchor.href = 'https://example.test/document'
    anchor.target = '_blank'
    anchor.setAttribute('ping', 'https://example.test/ping')
    anchor.append(anchorText)
    linkContainer.append(anchor)
    secureWorkspaceOfficeLinks(linkContainer)
    expect(anchor.getAttribute('href')).toBe('#')
    expect(anchor.hasAttribute('target')).toBe(false)
    expect(anchor.hasAttribute('ping')).toBe(false)
    const preventDefault = vi.fn()
    openWorkspaceOfficeExternalLink({ target: anchorText, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(window.kunGui.openExternal).toHaveBeenCalledWith('https://example.test/document')

    libraryMocks.renderDocx.mockRejectedValueOnce(new Error('broken refresh'))
    await act(async () => {
      renderer?.update(createElement(WorkspaceDocxPreview, {
        result: preview('word', 'b'.repeat(64)),
        loading: true
      }))
      await flushPromises()
    })
    expect(renderer!.root.findByProps({ 'aria-label': 'Page 2 of 2' })).toBeTruthy()
    expect(JSON.stringify(renderer!.toJSON())).toContain('broken refresh')
  })

  it('owns PPTX slide navigation and destroys superseded, failed, and unmounted instances', async () => {
    await act(async () => {
      renderer = create(createElement(WorkspacePptxPreview, {
        result: preview('presentation'),
        loading: false
      }), { createNodeMock })
      await flushPromises()
    })
    const first = pptxInstances[0]!
    await act(async () => renderer?.root.findByProps({ 'aria-label': 'Next slide' }).props.onClick())
    expect(first.renderSingleSlide).toHaveBeenCalledWith(1)

    await act(async () => {
      renderer?.update(createElement(WorkspacePptxPreview, {
        result: preview('presentation', 'b'.repeat(64)),
        loading: false
      }))
      await flushPromises()
    })
    expect(first.destroy).toHaveBeenCalledTimes(1)

    const second = pptxInstances[1]!
    const previewFailure = new Error('presentation parse failed')
    libraryMocks.initPptx.mockImplementationOnce(() => {
      const instance = {
        slideCount: 1,
        preview: vi.fn(async () => { throw previewFailure }),
        renderSingleSlide: vi.fn(),
        destroy: vi.fn()
      }
      pptxInstances.push(instance)
      return instance
    })
    await act(async () => {
      renderer?.update(createElement(WorkspacePptxPreview, {
        result: preview('presentation', 'c'.repeat(64)),
        loading: false
      }))
      await flushPromises()
    })
    const failed = pptxInstances[2]!
    expect(failed.destroy).toHaveBeenCalled()
    expect(second.destroy).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer!.toJSON())).toContain('presentation parse failed')

    await act(async () => renderer?.unmount())
    renderer = undefined
    expect(second.destroy).toHaveBeenCalledTimes(1)
  })

  it('loads SheetJS with XLS codepages and keeps worksheet and zoom controls local', async () => {
    await act(async () => {
      renderer = create(createElement(WorkspaceSpreadsheetPreview, {
        result: preview('spreadsheet', 'a'.repeat(64), 'xls'),
        loading: false
      }))
      await flushPromises()
    })

    expect(libraryMocks.setCodepage).toHaveBeenCalledWith({ codepages: true })
    expect(libraryMocks.readWorkbook).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ type: 'array', dense: false, cellFormula: true })
    )
    await act(async () => renderer?.root.findByProps({ 'aria-label': 'Worksheet' }).props.onChange({
      target: { value: '1' }
    }))
    expect(JSON.stringify(renderer!.toJSON())).toContain('Data')
    await act(async () => renderer?.root.findByProps({ 'aria-label': 'Zoom in' }).props.onClick())
    expect(renderer!.root.findByProps({ 'aria-label': 'Reset zoom' }).children.join('')).toBe('110%')
  })
})

function createNodeMock(element: { type: unknown }): HTMLElement | null {
  return typeof element.type === 'string' ? document.createElement(element.type) : null
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function encodeColumn(column: number): string {
  let value = column + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

function decodeRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const [start = 'A1', end = start] = ref.split(':')
  return { s: decodeCell(start), e: decodeCell(end) }
}

function decodeCell(cell: string): { r: number; c: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(cell) ?? ['', 'A', '1']
  let column = 0
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64
  return { r: Number.parseInt(match[2]!, 10) - 1, c: column - 1 }
}
