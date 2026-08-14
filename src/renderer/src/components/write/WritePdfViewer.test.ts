import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WritePdfViewer } from './WritePdfViewer'
import type { WriteEditorSelectionState } from './WriteMarkdownEditor'

const getDocument = vi.fn()
const createdTasks: Array<{
  promise: Promise<{ numPages: number; destroy: ReturnType<typeof vi.fn> }>
  destroy: ReturnType<typeof vi.fn>
}> = []

vi.mock('pdfjs-dist/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocument(...args)
}))
vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'pdf-worker-url' }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('./WritePdfPage', () => ({
  WritePdfPage: (props: { pageNumber: number }) =>
    createElement('div', { 'data-pdf-page-mock': props.pageNumber }),
  bytesFromBase64: () => new Uint8Array([1]),
  emptyPdfSelection: (): WriteEditorSelectionState =>
    ({ text: '', ranges: [], charCount: 0, sourceKind: 'pdf' }),
  formatSize: () => '1 B',
  selectionFromPdf: (): WriteEditorSelectionState =>
    ({ text: '', ranges: [], charCount: 0, sourceKind: 'pdf' })
}))

function viewerProps(onSelectionChange: (selection: WriteEditorSelectionState) => void) {
  return {
    filePath: '/tmp/write/study.pdf',
    dataBase64: 'JVBERi0xLjQKJSVFT0Y=',
    size: 14,
    mtimeMs: 1234,
    workspaceRoot: '/tmp/write',
    onSelectionChange
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function renderViewer(
  onSelectionChange: (selection: WriteEditorSelectionState) => void
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(WritePdfViewer, viewerProps(onSelectionChange)))
  })
  await act(async () => { await flushMicrotasks() })
  return renderer
}

function findToolbarButton(renderer: ReactTestRenderer, label: string): { props: { onClick: () => void } } {
  const button = renderer.root.findAllByProps({ 'aria-label': label })[0]
  if (!button) throw new Error(`toolbar button ${label} not found`)
  return button as unknown as { props: { onClick: () => void } }
}

describe('WritePdfViewer document loading', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    getDocument.mockReset()
    createdTasks.length = 0
    getDocument.mockImplementation(() => {
      const task = {
        promise: Promise.resolve({ numPages: 2, destroy: vi.fn() }),
        destroy: vi.fn()
      }
      createdTasks.push(task)
      return task
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      atob: globalThis.atob.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn()
    })
  })

  afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    vi.unstubAllGlobals()
  })

  it('loads the PDF document exactly once on mount', async () => {
    const onSelectionChange = vi.fn()
    renderer = await renderViewer(onSelectionChange)

    expect(getDocument).toHaveBeenCalledTimes(1)
    expect(createdTasks[0].destroy).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ 'data-pdf-page-mock': 1 })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ 'data-pdf-page-mock': 2 })).toHaveLength(1)
  })

  it('does not reload the document when only the selection callback identity changes', async () => {
    const firstSelectionChange = vi.fn()
    renderer = await renderViewer(firstSelectionChange)

    await act(async () => {
      renderer.update(createElement(WritePdfViewer, viewerProps(vi.fn())))
    })
    await act(async () => { await flushMicrotasks() })

    expect(getDocument).toHaveBeenCalledTimes(1)
    expect(createdTasks[0].destroy).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ 'data-pdf-page-mock': 1 })).toHaveLength(1)
  })

  it('notifies the latest selection callback after the parent replaces it', async () => {
    const firstSelectionChange = vi.fn()
    const secondSelectionChange = vi.fn()
    renderer = await renderViewer(firstSelectionChange)
    firstSelectionChange.mockClear()

    await act(async () => {
      renderer.update(createElement(WritePdfViewer, viewerProps(secondSelectionChange)))
    })
    // Zooming clears the selection through the same publisher used by the
    // loading effect, without requiring a live DOM Selection.
    await act(async () => { findToolbarButton(renderer, 'writePdfZoomIn').props.onClick() })

    expect(getDocument).toHaveBeenCalledTimes(1)
    expect(firstSelectionChange).not.toHaveBeenCalled()
    expect(secondSelectionChange).toHaveBeenCalledTimes(1)
    expect(secondSelectionChange.mock.calls[0][0]).toMatchObject({ charCount: 0, sourceKind: 'pdf' })
  })

  it('destroys the previous loading task and reloads when the document changes', async () => {
    const onSelectionChange = vi.fn()
    renderer = await renderViewer(onSelectionChange)

    await act(async () => {
      renderer.update(createElement(WritePdfViewer, {
        ...viewerProps(onSelectionChange),
        mtimeMs: 5678
      }))
    })
    await act(async () => { await flushMicrotasks() })

    expect(createdTasks[0].destroy).toHaveBeenCalledTimes(1)
    expect(getDocument).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ 'data-pdf-page-mock': 1 })).toHaveLength(1)
  })
})
