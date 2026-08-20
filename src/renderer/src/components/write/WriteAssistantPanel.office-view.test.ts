import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { createWriteDocumentSession } from '../../write/write-editor-layout'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { WriteAssistantPanel } from './WriteAssistantPanel'
import { WritePresentationViewChip } from './WritePresentationViewChip'

type PanelProps = ComponentProps<typeof WriteAssistantPanel>

function props(): PanelProps {
  return {
    input: '', setInput: vi.fn(), mode: 'agent', setMode: vi.fn(), busy: false,
    runtimeConnection: 'ready', activeThreadId: 'thr_write', blocks: [],
    liveReasoning: '', liveAssistant: '', composerModel: '', composerPickList: [],
    composerReasoningEffort: 'auto', composerFastMode: false,
    setComposerModel: vi.fn(), setComposerReasoningEffort: vi.fn(),
    setComposerFastMode: vi.fn(), queuedMessages: [], removeQueuedMessage: vi.fn(),
    guideQueuedMessage: vi.fn(), onSend: vi.fn(), onInterrupt: vi.fn(),
    onRetryConnection: vi.fn(), onOpenSettings: vi.fn(), onNewConversation: vi.fn(),
    onPickWorkspace: vi.fn(), onCollapse: vi.fn()
  }
}

describe('WriteAssistantPanel presentation view', () => {
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
    const path = '/workspace/deck.pptx'
    const preview = {
      ok: true as const, path, name: 'deck.pptx', sourceFormat: 'pptx' as const,
      renderFormat: 'pptx' as const, viewer: 'presentation' as const, size: 128,
      mtimeMs: 1, sourceSha256: 'a'.repeat(64), data: new Uint8Array([1])
    }
    useChatStore.setState({ route: 'write', activeThreadId: 'thr_write', workspaceRoot: '/workspace' })
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(), setInterval, clearInterval, innerHeight: 900, innerWidth: 1400,
      kunGui: {
        platform: 'darwin', getSettings: vi.fn(async () => ({ ok: true, settings: {} })),
        runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{"sessions":[]}' }))
      }
    }
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/workspace', activeFilePath: path, activeFileKind: 'office',
      documentsByPath: {
        [path]: createWriteDocumentSession({ path, kind: 'office', officePreview: preview })
      },
      editorLayout: {
        version: 1, orientation: 'single', ratio: 0.5, focusedGroupId: 'primary',
        groups: [{ id: 'primary', activePath: path, tabs: [{ path, viewMode: 'preview' }] }]
      },
      presentationViewByGroup: {
        primary: {
          kind: 'presentation', path, sourceName: 'deck.pptx', sourceFormat: 'pptx',
          sourceSha256: preview.sourceSha256, slide: 3, slideCount: 9
        }
      }
    })
  })

  afterEach(() => {
    useWriteWorkspaceStore.getState().resetWorkspace()
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  it('projects the focused slide into a non-removable composer chip', async () => {
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => { renderer = create(createElement(WriteAssistantPanel, props())) })
      const chip = renderer!.root.findByType(WritePresentationViewChip)
      expect(chip.props.view).toMatchObject({ sourceName: 'deck.pptx', slide: 3, slideCount: 9 })
      expect(renderer!.root.findAllByProps({ 'data-write-presentation-view': 'true' })).toHaveLength(1)
    } finally {
      if (renderer) act(() => renderer!.unmount())
    }
  })

  it('quotes a formatted spreadsheet selection only after the explicit sidebar action', async () => {
    const path = '/workspace/book.xlsx'
    useWriteWorkspaceStore.setState({
      activeFilePath: path,
      activeFileKind: 'office',
      selection: {
        text: '日期\t¥1,299.00',
        ranges: [{
          from: 0, to: 13, startLine: 1, startColumn: 1, endLine: 1, endColumn: 14,
          text: '日期\t¥1,299.00', charCount: 13
        }],
        charCount: 13,
        sourceKind: 'spreadsheet',
        sourceFormat: 'xlsx',
        sheetName: '随机数据',
        cellRange: 'A1:F2',
        formulas: ['G2: =E2*F2']
      },
      quotedSelections: [],
      documentsByPath: {
        [path]: createWriteDocumentSession({
          path,
          kind: 'office',
          selection: {
            text: '日期\t¥1,299.00',
            ranges: [{
              from: 0, to: 13, startLine: 1, startColumn: 1, endLine: 1, endColumn: 14,
              text: '日期\t¥1,299.00', charCount: 13
            }],
            charCount: 13,
            sourceKind: 'spreadsheet',
            sourceFormat: 'xlsx',
            sheetName: '随机数据',
            cellRange: 'A1:F2',
            formulas: ['G2: =E2*F2']
          }
        })
      },
      presentationViewByGroup: {}
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => { renderer = create(createElement(WriteAssistantPanel, props())) })
      expect(useWriteWorkspaceStore.getState().quotedSelections).toHaveLength(0)
      const label = renderer!.root.findByProps({ children: 'Quote selected cells' })
      const button = label.parent?.parent
      expect(button?.type).toBe('button')
      await act(async () => button?.props.onClick())
      expect(useWriteWorkspaceStore.getState().quotedSelections).toEqual([
        expect.objectContaining({
          sourceKind: 'spreadsheet',
          sourceFormat: 'xlsx',
          sheetName: '随机数据',
          cellRange: 'A1:F2',
          text: '日期\t¥1,299.00',
          formulas: ['G2: =E2*F2']
        })
      ])
    } finally {
      if (renderer) act(() => renderer!.unmount())
    }
  })
})
