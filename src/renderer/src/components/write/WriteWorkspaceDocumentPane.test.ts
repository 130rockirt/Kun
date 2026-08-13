import { createElement, createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WriteWorkspaceDocumentPane } from './WriteWorkspaceDocumentPane'

vi.mock('react-i18next', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})
vi.mock('../../write/tiptap/WriteRichEditor', () => ({ WriteRichEditor: () => null }))
vi.mock('./WriteMarkdownEditor', () => ({ WriteMarkdownEditor: () => null }))
vi.mock('./WriteMarkdownPreview', () => ({ WriteMarkdownPreview: () => null }))
vi.mock('./WriteWorkspaceStart', () => ({ WriteWorkspaceStart: () => null }))
vi.mock('./WriteImagePreview', () => ({ WriteImagePreview: () => null }))
vi.mock('./WritePdfViewer', () => ({ WritePdfViewer: () => null }))
vi.mock('../WorkspaceOfficePreview', () => ({
  WorkspaceOfficePreview: (props: object) => createElement('div', {
    ...props,
    'data-office-preview-mock': 'true'
  })
}))

const noop = (): void => undefined

function paneProps(focusMode: boolean, onFocusModeChange: (active: boolean) => void) {
  return {
    activeFilePath: '/repo/draft.md',
    documentEpoch: 1,
    activeFileIsImage: false,
    activeFileIsPdf: false,
    activeFileIsText: true,
    fileLoading: false,
    fileContent: 'Draft',
    imageDataUrl: '',
    imageMimeType: '',
    pdfDataBase64: '',
    pdfMimeType: '',
    pdfMtimeMs: 0,
    fileSize: 5,
    workspaceRoot: '/repo',
    workspaceName: 'repo',
    workspacePathLabel: '/repo',
    renderSafety: {
      livePreviewEnabled: true,
      markdownPreviewEnabled: true,
      readOnly: false,
      notice: 'none' as const
    },
    fileGuardMessage: '',
    fileGuardDetail: '',
    editorVisible: true,
    previewVisible: false,
    editorWidth: 'w-full',
    previewWidth: 'w-0',
    editorAppearance: 'source' as const,
    richModeActive: false,
    richHandleRef: { current: null },
    debouncedPreviewContent: 'Draft',
    isMarkdown: true,
    inlineCompletion: {
      enabled: false,
      retrievalEnabled: false,
      longCompletionEnabled: false,
      inheritProvider: true,
      providerId: '',
      apiKey: '',
      baseUrl: '',
      inheritModel: true,
      model: '',
      debounceMs: 100,
      longDebounceMs: 200,
      minAcceptScore: 0,
      longMinAcceptScore: 0,
      maxTokens: 32,
      longMaxTokens: 64
    },
    inlineCompletionApiReady: false,
    recentEdits: [],
    editorPaneRef: createRef<HTMLDivElement>(),
    previewPaneRef: createRef<HTMLDivElement>(),
    onAskAssistant: noop,
    onCreateDraft: noop,
    onPickWorkspace: noop,
    onRefreshWorkspace: noop,
    onContentChange: noop,
    onDocumentEdit: noop,
    onSelectionChange: noop,
    onSaveShortcut: noop,
    onImagePasteSaved: noop,
    onImagePasteError: noop,
    onPresentationViewChange: noop,
    focused: true,
    focusMode,
    onFocusModeChange
  }
}

describe('WriteWorkspaceDocumentPane focus mode', () => {
  let renderer: ReactTestRenderer
  let keydown: ((event: KeyboardEvent) => void) | undefined
  const onFocusModeChange = vi.fn()

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    keydown = undefined
    onFocusModeChange.mockClear()
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
        if (type === 'keydown') keydown = listener
      }),
      removeEventListener: vi.fn()
    })
    await act(async () => {
      renderer = create(createElement(
        WriteWorkspaceDocumentPane,
        paneProps(false, onFocusModeChange)
      ))
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
  })

  it('toggles from the accessible button and the non-repeating keyboard shortcut', async () => {
    const button = renderer.root.findByProps({ 'aria-label': 'writeFocusModeEnter' })
    expect(button.props['aria-keyshortcuts']).toBe('Meta+Shift+F Control+Shift+F')
    await act(async () => button.props.onClick())
    expect(onFocusModeChange).toHaveBeenCalledWith(true)

    const preventDefault = vi.fn()
    await act(async () => keydown?.({
      code: 'KeyF',
      key: 'F',
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: { tagName: 'DIV' },
      preventDefault
    } as unknown as KeyboardEvent))
    expect(preventDefault).toHaveBeenCalled()
    expect(onFocusModeChange).toHaveBeenLastCalledWith(true)
  })

  it('does not steal the shortcut from a form control and exits with Escape', async () => {
    await act(async () => keydown?.({
      code: 'KeyF',
      key: 'F',
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: { tagName: 'INPUT' },
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent))
    expect(onFocusModeChange).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(createElement(
        WriteWorkspaceDocumentPane,
        paneProps(true, onFocusModeChange)
      ))
    })
    const exitButton = renderer.root.findByProps({ 'aria-label': 'writeFocusModeExit' })
    expect(exitButton.props.className).toContain('top-2')
    expect(exitButton.props.className).not.toContain('bottom-2')
    await act(async () => keydown?.({
      key: 'Escape',
      defaultPrevented: false
    } as KeyboardEvent))
    expect(onFocusModeChange).toHaveBeenCalledWith(false)
  })

  it('passes presentation view reporting and keyboard focus to the Office preview', async () => {
    const onPresentationViewChange = vi.fn()
    const officePreview: WorkspaceOfficePreviewSuccess = {
      ok: true,
      path: '/repo/deck.pptx',
      name: 'deck.pptx',
      sourceFormat: 'pptx',
      renderFormat: 'pptx',
      viewer: 'presentation',
      size: 3,
      mtimeMs: 1,
      sourceSha256: 'a'.repeat(64),
      data: new Uint8Array([1, 2, 3])
    }
    await act(async () => {
      renderer.update(createElement(WriteWorkspaceDocumentPane, {
        ...paneProps(false, onFocusModeChange),
        activeFilePath: officePreview.path,
        activeFileIsOffice: true,
        activeFileIsText: false,
        officePreview,
        focused: false,
        onPresentationViewChange
      }))
    })

    expect(renderer.root.findByProps({ 'data-office-preview-mock': 'true' }).props).toMatchObject({
      onPresentationViewChange,
      presentationKeyboardActive: false
    })
  })
})
